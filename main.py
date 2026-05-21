# author Red
# @project  Red Studio  2.0.0
# @since    2026-05-14
# @updated  2026-05-21
# 260521 Red QWebChannel 重构：移除 Flask HTTP 层，改用 Qt 直接桥接

import copy
import ctypes
import ctypes.wintypes
import json
import os
import pathlib
import queue
import sys
import threading

from PySide6.QtCore import QObject, Qt, QSize, QUrl, Signal, Slot
from PySide6.QtGui import QGuiApplication, QIcon
from PySide6.QtWebChannel import QWebChannel
from PySide6.QtWebEngineCore import QWebEngineScript
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import QApplication

import config as cfg
from providers import ollama, openai_compat

# 告知 Windows 这是独立应用，不归组到 python.exe，任务栏才会显示自定义图标
ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("Red.Studio.App")

# 260514 Red 确保工作目录指向脚本所在位置（PyInstaller 打包后路径会变）
if getattr(sys, "frozen", False):
    BASE_DIR = sys._MEIPASS
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))

FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")

# 260514 Red 历史对话持久化路径：~/.aistory/history.json
_HISTORY_PATH = pathlib.Path.home() / ".aistory" / "history.json"

# Win32 WM_NCLBUTTONDOWN：直接告知 Windows 哪条边被按下，比 Qt 的 startSystemResize 更可靠
_WM_NCLBUTTONDOWN = 0x00A1
_EDGE_TO_HT = {
    1: 10,   # HTLEFT
    2: 11,   # HTRIGHT
    4: 12,   # HTTOP
    8: 15,   # HTBOTTOM
    5: 13,   # HTTOPLEFT
    6: 14,   # HTTOPRIGHT
    9: 16,   # HTBOTTOMLEFT
    10: 17,  # HTBOTTOMRIGHT
}


# ─── Bridge（JS ↔ Python 桥接） ────────────────────────────────────────────────

class Bridge(QObject):
    # ── Python → JS 信号 ──────────────────────────────────────────────────────
    chatChunk   = Signal(str)   # 流式 chunk JSON
    chatDone    = Signal()      # 流结束
    modelsReady = Signal(str)   # JSON: {"provider":..., "models":[...]} 或 {"error":...}
    ttsDone     = Signal()      # TTS 朗读完毕

    def __init__(self, window, parent=None):
        super().__init__(parent)
        self._window = window

        # 260521 Red 配置缓存，替代 server.py 的全局 _config
        self._config: dict = {}
        self._config_lock = threading.Lock()

        # 260521 Red 聊天停止事件，替代 AbortController
        self._stop_event = threading.Event()

        # 260521 Red TTS 队列和版本号（版本号递增可立即撤销旧请求）
        self._tts_queue: queue.SimpleQueue = queue.SimpleQueue()
        self._tts_generation = [0]

        self._init_config()

        self._tts_thread = threading.Thread(target=self._tts_worker, daemon=True)
        self._tts_thread.start()

    # ── 配置 ──────────────────────────────────────────────────────────────────

    def _init_config(self):
        with self._config_lock:
            self._config = cfg.load_config()

    @Slot(result=str)
    def getConfig(self) -> str:
        # 260521 Red 深拷贝后屏蔽 API Key，前端只用于展示
        with self._config_lock:
            c = copy.deepcopy(self._config)
        for provider in c.get("providers", {}).values():
            if provider.get("api_key"):
                provider["api_key"] = "••••••••"
        return json.dumps(c, ensure_ascii=False)

    @Slot(str)
    def saveConfig(self, json_str: str):
        data = json.loads(json_str)
        with self._config_lock:
            # 260521 Red 若 api_key 是掩码，保留原始值不覆盖
            for name, provider in data.get("providers", {}).items():
                if provider.get("api_key") == "••••••••":
                    provider["api_key"] = (
                        self._config.get("providers", {})
                        .get(name, {})
                        .get("api_key", "")
                    )
            self._config.update(data)
            cfg.save_config(self._config)

    # ── 历史对话 ──────────────────────────────────────────────────────────────

    @Slot(result=str)
    def getHistory(self) -> str:
        try:
            if _HISTORY_PATH.exists():
                return _HISTORY_PATH.read_text(encoding="utf-8")
        except Exception:
            pass
        return "[]"

    @Slot(str)
    def saveHistory(self, json_str: str):
        try:
            _HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
            _HISTORY_PATH.write_text(json_str, encoding="utf-8")
        except Exception:
            pass

    # ── 模型列表（异步，结果通过 modelsReady 信号返回） ───────────────────────

    @Slot(str)
    def listModels(self, provider_name: str):
        def _run():
            with self._config_lock:
                c = self._config.copy()
            p = c.get("providers", {}).get(provider_name)
            if not p:
                payload = json.dumps({
                    "provider": provider_name,
                    "error": f"未知 provider: {provider_name}"
                })
                self.modelsReady.emit(payload)
                return
            try:
                if p.get("type") == "ollama":
                    models = ollama.list_models(p["base_url"])
                else:
                    models = openai_compat.list_models(
                        p["base_url"], p.get("api_key", "")
                    )
                payload = json.dumps({"provider": provider_name, "models": models})
            except Exception as e:
                payload = json.dumps({"provider": provider_name, "error": str(e)})
            self.modelsReady.emit(payload)

        threading.Thread(target=_run, daemon=True).start()

    # ── 聊天流式生成 ──────────────────────────────────────────────────────────

    @Slot(str)
    def sendChat(self, json_str: str):
        # 260521 Red 重置停止事件，在独立线程中运行，通过 chatChunk / chatDone 信号推送
        self._stop_event.clear()
        threading.Thread(target=self._chat_thread, args=(json_str,), daemon=True).start()

    def _chat_thread(self, json_str: str):
        data          = json.loads(json_str)
        provider_name = data.get("provider", "ollama")
        model         = data.get("model", "")
        messages      = data.get("messages", [])

        with self._config_lock:
            c = self._config.copy()

        p = c.get("providers", {}).get(provider_name)
        if not p:
            self.chatChunk.emit(json.dumps({"error": f"未知 provider: {provider_name}"}))
            self.chatDone.emit()
            return

        temperature       = float(data.get("temperature",       c.get("temperature",       0.7)))
        max_tokens        = int(  data.get("max_tokens",        c.get("max_tokens",        4096)))
        top_p             = float(data.get("top_p",             c.get("top_p",             1.0)))
        frequency_penalty = float(data.get("frequency_penalty", c.get("frequency_penalty", 0.0)))
        presence_penalty  = float(data.get("presence_penalty",  c.get("presence_penalty",  0.0)))
        thinking          = data.get("thinking", False)

        try:
            if p.get("type") == "ollama":
                stream = ollama.chat_stream(
                    p["base_url"], model, messages,
                    temperature, max_tokens, top_p
                )
            else:
                stream = openai_compat.chat_stream(
                    p["base_url"], p.get("api_key", ""), model, messages,
                    temperature, max_tokens, top_p,
                    frequency_penalty, presence_penalty, thinking=thinking
                )

            for chunk in stream:
                if self._stop_event.is_set():
                    break
                if isinstance(chunk, tuple):
                    kind, val = chunk
                    if kind == "usage":
                        payload = {
                            "type": "usage",
                            "prompt_tokens":     val["prompt_tokens"],
                            "completion_tokens": val["completion_tokens"],
                        }
                    else:
                        payload = {"type": kind, "text": val}
                else:
                    payload = {"type": "content", "text": chunk}
                self.chatChunk.emit(json.dumps(payload, ensure_ascii=False))

        except Exception as e:
            self.chatChunk.emit(json.dumps({"error": str(e)}))
        finally:
            self.chatDone.emit()

    @Slot()
    def stopChat(self):
        # 260521 Red 设置停止事件，生成线程在下一个 chunk 前检测到后退出
        self._stop_event.set()

    # ── TTS ───────────────────────────────────────────────────────────────────

    @Slot(str)
    def ttsSpeak(self, text: str):
        with self._config_lock:
            c = self._config.copy()
        voice_id = c.get("tts_voice", "")
        rate     = int(c.get("tts_rate", 0))
        self._tts_generation[0] += 1
        self._tts_queue.put((text[:2000], self._tts_generation[0], voice_id, rate))

    @Slot()
    def ttsStop(self):
        # 260521 Red 递增版本号，TTS 线程检测到不匹配后立即停止
        self._tts_generation[0] += 1

    @Slot(result=str)
    def ttsVoices(self) -> str:
        try:
            import win32com.client
            v     = win32com.client.Dispatch("SAPI.SpVoice")
            vlist = v.GetVoices()
            voices = [
                {"id": vlist.Item(i).Id, "name": vlist.Item(i).GetDescription()}
                for i in range(vlist.Count)
            ]
            return json.dumps({"voices": voices})
        except Exception as e:
            return json.dumps({"voices": [], "error": str(e)})

    def _tts_worker(self):
        """在独立线程中串行处理朗读请求；COM 对象必须在使用它的线程中创建"""
        try:
            import pythoncom
            pythoncom.CoInitialize()
        except ImportError:
            pass
        try:
            import win32com.client
            import time as _time
            voice = win32com.client.Dispatch("SAPI.SpVoice")
            voice.Rate   = 0
            voice.Volume = 100
        except Exception:
            return  # SAPI 不可用则静默退出

        cur_voice_id = ""
        while True:
            text, gen, voice_id, rate = self._tts_queue.get()
            if gen != self._tts_generation[0]:
                continue  # 过期请求，跳过
            try:
                if voice_id != cur_voice_id:
                    vlist = voice.GetVoices()
                    for i in range(vlist.Count):
                        v = vlist.Item(i)
                        if v.Id == voice_id:
                            voice.Voice = v
                            break
                    cur_voice_id = voice_id
                voice.Rate = max(-10, min(10, int(rate)))
                voice.Speak(text, 1)   # SVSFlagsAsync = 1
                while voice.Status.RunningState == 2:  # 2 = 正在朗读
                    if gen != self._tts_generation[0]:
                        voice.Speak("", 3)  # 立即停止
                        break
                    _time.sleep(0.05)
            except Exception:
                pass
            finally:
                # 260521 Red 朗读结束（正常或停止）后发信号，前端据此恢复按钮状态
                if gen == self._tts_generation[0]:
                    self.ttsDone.emit()

    # ── 窗口控制 ──────────────────────────────────────────────────────────────
    # 260521 Red Slot 直接在主线程执行，无需 Signal 中转（QWebChannel 槽调用已在主线程）

    @Slot()
    def minimize(self):
        self._window.showMinimized()

    @Slot()
    def toggleMaximize(self):
        self._window._toggle_maximize()

    @Slot()
    def closeWindow(self):
        self._window.close()

    @Slot()
    def startMove(self):
        self._window._start_system_move()

    @Slot(int)
    def startResize(self, edge: int):
        self._window._start_system_resize(edge)


# ─── 主窗口类 ──────────────────────────────────────────────────────────────────

class MainWindow(QWebEngineView):
    def __init__(self):
        super().__init__()

        # 260514 Red FramelessWindowHint 移除系统标题栏，由前端 HTML 接管
        self.setWindowFlags(
            Qt.WindowType.Window | Qt.WindowType.FramelessWindowHint
        )

        # 260521 Red 注入 qwebchannel.js，使页面中 qt.webChannelTransport 可用
        script = QWebEngineScript()
        script.setName("qwebchannel")
        script.setSourceUrl(QUrl("qrc:///qtwebchannel/qwebchannel.js"))
        script.setInjectionPoint(QWebEngineScript.InjectionPoint.DocumentCreation)
        script.setWorldId(QWebEngineScript.ScriptWorldId.MainWorld)
        self.page().scripts().insert(script)

    def _toggle_maximize(self):
        if self.isMaximized():
            self.showNormal()
        else:
            self.showMaximized()

    def _start_system_move(self):
        handle = self.windowHandle()
        if handle:
            handle.startSystemMove()

    def _start_system_resize(self, edge: int):
        # 使用 Win32 WM_NCLBUTTONDOWN 直接触发边缘缩放
        ht = _EDGE_TO_HT.get(edge)
        if not ht:
            return
        hwnd  = int(self.winId())
        pt    = ctypes.wintypes.POINT()
        ctypes.windll.user32.GetCursorPos(ctypes.byref(pt))
        lparam = ctypes.c_int32((pt.y << 16) | (pt.x & 0xFFFF)).value
        ctypes.windll.user32.ReleaseCapture()
        ctypes.windll.user32.PostMessageW(hwnd, _WM_NCLBUTTONDOWN, ht, lparam)


# ─── 入口 ──────────────────────────────────────────────────────────────────────

def main():
    # 260521 Red 直接启动 Qt，无需等待 Flask 端口就绪
    app = QApplication(sys.argv)
    app.setApplicationName("Red Studio")

    icon_path = os.path.join(BASE_DIR, "icon.ico")
    if os.path.exists(icon_path):
        app.setWindowIcon(QIcon(icon_path))

    window = MainWindow()
    window.setWindowTitle("Red Studio")
    window.resize(1100, 720)
    window.setMinimumSize(QSize(800, 560))
    window.setContextMenuPolicy(Qt.ContextMenuPolicy.NoContextMenu)

    # 260521 Red 创建 Bridge 并注册到 QWebChannel
    bridge  = Bridge(window)
    channel = QWebChannel()
    channel.registerObject("bridge", bridge)
    window.page().setWebChannel(channel)

    # 260521 Red 直接加载本地 HTML 文件，无需 Flask 静态服务
    window.load(QUrl.fromLocalFile(os.path.join(FRONTEND_DIR, "index.html")))

    # 260514 Red 启动时居中显示
    screen = QGuiApplication.primaryScreen().availableGeometry()
    window.move(
        (screen.width()  - window.width())  // 2,
        (screen.height() - window.height()) // 2,
    )

    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
