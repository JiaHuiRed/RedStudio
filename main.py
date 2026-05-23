# author Red
# @project  Red Studio  3.3.2
# @since    2026-05-14
# @updated  2026-05-22
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
from PySide6.QtGui import QGuiApplication, QIcon, QCursor
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

# Win32 WM_NCLBUTTONDOWN：标题栏拖拽使用，缩放由 WM_NCHITTEST 自动处理
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

#260523 Red 小米 MiMo TTS 声线列表（v2.5，限时免费）
_MIMO_TTS_VOICES = [
    {"id": "冰糖", "name": "冰糖（普通话·女）甜美"},
    {"id": "茉莉", "name": "茉莉（普通话·女）温柔"},
    {"id": "苏打", "name": "苏打（普通话·男）"},
    {"id": "白桦", "name": "白桦（普通话·男）沉稳"},
]

# //#260521 Red Edge TTS 精选声线列表（无需联网查询，直接内置）
_EDGE_TTS_VOICES = [
    {"id": "zh-CN-XiaoxiaoNeural",         "name": "晓晓（普通话·女）温柔"},
    {"id": "zh-CN-XiaoyiNeural",           "name": "晓伊（普通话·女）活泼"},
    {"id": "zh-CN-XiaohanNeural",          "name": "晓涵（普通话·女）"},
    {"id": "zh-CN-XiaomengNeural",         "name": "晓梦（普通话·女）"},
    {"id": "zh-CN-XiaomoNeural",           "name": "晓墨（普通话·女）"},
    {"id": "zh-CN-XiaoqiuNeural",          "name": "晓秋（普通话·女）"},
    {"id": "zh-CN-XiaoruiNeural",          "name": "晓睿（普通话·女）"},
    {"id": "zh-CN-XiaoshuangNeural",       "name": "晓双（普通话·女）"},
    {"id": "zh-CN-XiaoxuanNeural",         "name": "晓萱（普通话·女）"},
    {"id": "zh-CN-XiaoyanNeural",          "name": "晓颜（普通话·女）"},
    {"id": "zh-CN-XiaoyouNeural",          "name": "晓悠（普通话·女）"},
    {"id": "zh-CN-XiaochenNeural",         "name": "晓辰（普通话·女）"},
    {"id": "zh-CN-YunxiNeural",            "name": "云希（普通话·男）年轻"},
    {"id": "zh-CN-YunjianNeural",          "name": "云健（普通话·男）磁性"},
    {"id": "zh-CN-YunyangNeural",          "name": "云扬（普通话·男）新闻"},
    {"id": "zh-CN-YunfengNeural",          "name": "云枫（普通话·男）"},
    {"id": "zh-CN-YunhaoNeural",           "name": "云皓（普通话·男）"},
    {"id": "zh-CN-YunxiaNeural",           "name": "云夏（普通话·男）"},
    {"id": "zh-CN-YunyeNeural",            "name": "云野（普通话·男）"},
    {"id": "zh-CN-YunzeNeural",            "name": "云泽（普通话·男）"},
    {"id": "zh-CN-liaoning-XiaobeiNeural", "name": "晓北（东北话·女）"},
    {"id": "zh-CN-shaanxi-XiaoniNeural",   "name": "晓妮（陕西话·女）"},
    {"id": "zh-TW-HsiaoChenNeural",        "name": "曉臻（台湾·女）"},
    {"id": "zh-TW-HsiaoYuNeural",          "name": "曉雨（台湾·女）"},
    {"id": "zh-TW-YunJheNeural",           "name": "雲哲（台湾·男）"},
    {"id": "zh-HK-HiuMaanNeural",          "name": "曉曼（粤语·女）"},
    {"id": "zh-HK-HiuGaaiNeural",          "name": "曉佳（粤语·女）"},
    {"id": "zh-HK-WanLungNeural",          "name": "雲龍（粤语·男）"},
]


# ─── Bridge（JS ↔ Python 桥接） ────────────────────────────────────────────────

class Bridge(QObject):
    # ── Python → JS 信号 ──────────────────────────────────────────────────────
    chatChunk   = Signal(str)   # 流式 chunk JSON
    chatDone    = Signal()      # 流结束
    modelsReady = Signal(str)   # JSON: {"provider":..., "models":[...]} 或 {"error":...}
    ttsDone     = Signal()      # TTS 朗读完毕
    ttsError    = Signal(str)   # TTS 出错（错误描述）

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
        engine   = c.get("tts_engine", "edge")
        voice_id = c.get("tts_voice", "")
        rate     = int(c.get("tts_rate", 0))
        api_key  = c.get("mimo_api_key", "")
        self._tts_generation[0] += 1
        self._tts_queue.put((text[:2000], self._tts_generation[0], engine, voice_id, rate, api_key))

    @Slot()
    def ttsStop(self):
        # 260521 Red 递增版本号，TTS 线程检测到不匹配后立即停止
        self._tts_generation[0] += 1

    @Slot(str, result=str)
    def ttsVoices(self, engine: str) -> str:
        # //#260521 Red 按引擎返回声线列表：Edge TTS 返回内置列表，SAPI 查询系统声线
        if engine == "mimo":
            return json.dumps({"voices": _MIMO_TTS_VOICES})
        if engine == "edge":
            return json.dumps({"voices": _EDGE_TTS_VOICES})
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

    def _edge_speak(self, text: str, gen: int, voice_id: str, rate: int):
        """//#260521 Red 用 edge-tts 生成 MP3，通过 Windows MCI 播放，支持中途停止"""
        import asyncio, os, tempfile, time
        try:
            import edge_tts
        except ImportError:
            self.ttsError.emit("edge-tts 未安装，请运行 pip install edge-tts")
            return
        voice    = voice_id or "zh-CN-XiaoxiaoNeural"
        rate_str = f"{rate * 5:+d}%"
        tmp = tempfile.NamedTemporaryFile(suffix=".mp3", delete=False)
        tmp_path = tmp.name
        tmp.close()
        try:
            #260523 Red 加 15s 超时，防止网络不可用时卡死；超时抛 asyncio.TimeoutError
            async def _fetch():
                await asyncio.wait_for(
                    edge_tts.Communicate(text, voice, rate=rate_str).save(tmp_path),
                    timeout=15.0
                )
            try:
                asyncio.run(_fetch())
            except asyncio.TimeoutError:
                self.ttsError.emit("Edge TTS 连接超时（15s），请检查网络或改用本地 SAPI")
                return
            except Exception as e:
                self.ttsError.emit(f"Edge TTS 出错：{e}")
                return
            mci   = ctypes.windll.winmm.mciSendStringW
            alias = "rds_tts"
            mci(f'open "{tmp_path}" alias {alias}', None, 0, None)
            mci(f'play {alias}', None, 0, None)
            buf = ctypes.create_unicode_buffer(256)
            while True:
                if gen != self._tts_generation[0]:
                    mci(f'stop {alias}', None, 0, None)
                    break
                mci(f'status {alias} mode', buf, 256, None)
                if buf.value != 'playing':
                    break
                time.sleep(0.05)
            mci(f'close {alias}', None, 0, None)
        finally:
            try:
                os.unlink(tmp_path)
            except Exception:
                pass

    def _mimo_speak(self, text: str, gen: int, voice_id: str, api_key: str):
        #260523 Red 小米 MiMo TTS：OpenAI 兼容接口，返回 base64 WAV，用 MCI 播放
        import base64, os, tempfile, time
        import requests as _req
        voice = voice_id or "冰糖"
        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        tmp_path = tmp.name
        tmp.close()
        try:
            resp = _req.post(
                "https://api.xiaomimimo.com/v1/chat/completions",
                headers={"api-key": api_key, "Content-Type": "application/json"},
                json={
                    "model": "mimo-v2.5-tts",
                    "messages": [
                        {"role": "assistant", "content": text}
                    ],
                    "audio": {"format": "wav", "voice": voice},
                },
                timeout=20,
            )
            if resp.status_code != 200:
                self.ttsError.emit(f"MiMo TTS 错误 {resp.status_code}：{resp.text[:120]}")
                return
            data = resp.json()
            audio_b64 = data["choices"][0]["message"]["audio"]["data"]
            with open(tmp_path, "wb") as f:
                f.write(base64.b64decode(audio_b64))
            if gen != self._tts_generation[0]:
                return
            mci   = ctypes.windll.winmm.mciSendStringW
            alias = "rds_tts"
            mci(f'open "{tmp_path}" alias {alias}', None, 0, None)
            mci(f'play {alias}', None, 0, None)
            buf = ctypes.create_unicode_buffer(256)
            while True:
                if gen != self._tts_generation[0]:
                    mci(f'stop {alias}', None, 0, None)
                    break
                mci(f'status {alias} mode', buf, 256, None)
                if buf.value != 'playing':
                    break
                time.sleep(0.05)
            mci(f'close {alias}', None, 0, None)
        except _req.exceptions.Timeout:
            self.ttsError.emit("MiMo TTS 连接超时（20s），请检查网络或 API Key")
        except Exception as e:
            self.ttsError.emit(f"MiMo TTS 出错：{e}")
        finally:
            try:
                os.unlink(tmp_path)
            except Exception:
                pass

    def _tts_worker(self):
        """在独立线程中串行处理朗读请求；COM 对象必须在使用它的线程中创建"""
        try:
            import pythoncom
            pythoncom.CoInitialize()
        except ImportError:
            pass

        import time as _time

        # 初始化 SAPI（备用引擎）
        _sapi = None
        try:
            import win32com.client
            _sapi = win32com.client.Dispatch("SAPI.SpVoice")
            _sapi.Rate   = 0
            _sapi.Volume = 100
        except Exception:
            pass

        cur_sapi_voice = ""
        while True:
            text, gen, engine, voice_id, rate, api_key = self._tts_queue.get()
            if gen != self._tts_generation[0]:
                continue
            try:
                if engine == "mimo":
                    if not api_key:
                        self.ttsError.emit("请在设置中填写小米 MiMo API Key")
                    else:
                        self._mimo_speak(text, gen, voice_id, api_key)
                elif engine == "edge":
                    self._edge_speak(text, gen, voice_id, rate)
                else:
                    if _sapi is None:
                        continue
                    if voice_id != cur_sapi_voice:
                        vlist = _sapi.GetVoices()
                        for i in range(vlist.Count):
                            v = vlist.Item(i)
                            if v.Id == voice_id:
                                _sapi.Voice = v
                                break
                        cur_sapi_voice = voice_id
                    _sapi.Rate = max(-10, min(10, int(rate)))
                    _sapi.Speak(text, 1)   # SVSFlagsAsync = 1
                    while _sapi.Status.RunningState == 2:
                        if gen != self._tts_generation[0]:
                            _sapi.Speak("", 3)
                            break
                        _time.sleep(0.05)
            except Exception:
                pass
            finally:
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

    # ── 窗口几何记忆 ───────────────────────────────────────────────────────────

    @Slot()
    def saveWindowGeometry(self):
        # 260521 Red 退出前将窗口位置和尺寸写入配置，下次启动时恢复
        if self._window.isMaximized():
            return  # 最大化时不保存，保留上次正常尺寸
        geo = self._window.geometry()
        with self._config_lock:
            self._config.update({
                "window_x": geo.x(),
                "window_y": geo.y(),
                "window_w": geo.width(),
                "window_h": geo.height(),
            })
            cfg.save_config(self._config)


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

    def nativeEvent(self, eventType, message):
        #260522 Red WM_NCHITTEST：原生处理四边/顶角缩放 + 标题栏拖拽，b=12
        if eventType == b"windows_generic_MSG":
            msg = ctypes.wintypes.MSG.from_address(int(message))
            if msg.message == 0x0084:  # WM_NCHITTEST
                pt = QCursor.pos()  # 逻辑像素，与 frameGeometry 一致
                geo = self.frameGeometry()
                x = pt.x() - geo.x()
                y = pt.y() - geo.y()
                w = geo.width()
                h = geo.height()
                b = 12  # 缩放边框像素，与 JS RESIZE_MARGIN 统一
                left   = x < b
                right  = x > w - b
                top    = y < b
                bottom = y > h - b
                if top    and left:  return True, 13  # HTTOPLEFT
                if top    and right: return True, 14  # HTTOPRIGHT
                if bottom and left:  return True, 16  # HTBOTTOMLEFT
                if bottom and right: return True, 17  # HTBOTTOMRIGHT
                if top:    return True, 12  # HTTOP
                if bottom: return True, 15  # HTBOTTOM
                if left:   return True, 10  # HTLEFT
                if right:  return True, 11  # HTRIGHT
                # 标题栏拖移（x<108 为交通灯+折叠键区域，交给 JS 处理点击）
                if y < 48 and x >= 108:
                    return True, 2  # HTCAPTION
        return super().nativeEvent(eventType, message)

    def closeEvent(self, event):
        super().closeEvent(event)

    def _start_system_move(self):
        #260521 Red 使用 Win32 PostMessage 触发移动，避免 QWebEngineView 侧边栏闪烁
        hwnd  = int(self.winId())
        pt    = ctypes.wintypes.POINT()
        ctypes.windll.user32.GetCursorPos(ctypes.byref(pt))
        lparam = ctypes.c_int32((pt.y << 16) | (pt.x & 0xFFFF)).value
        ctypes.windll.user32.ReleaseCapture()
        ctypes.windll.user32.PostMessageW(hwnd, _WM_NCLBUTTONDOWN, 2, lparam)  # HTCAPTION=2

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

    # 260521 Red 从配置恢复窗口几何，默认 1440×1080
    screen = QGuiApplication.primaryScreen().availableGeometry()
    with bridge._config_lock:
        c = bridge._config
        saved_x = c.get("window_x")
        saved_y = c.get("window_y")
        saved_w = c.get("window_w", 1000)
        saved_h = c.get("window_h", 800)

    window.resize(int(saved_w), int(saved_h))

    if saved_x is not None and saved_y is not None:
        # 确保窗口在当前屏幕范围内
        x = max(0, min(int(saved_x), screen.width()  - 120))
        y = max(0, min(int(saved_y), screen.height() - 80))
        window.move(x, y)
    else:
        window.move(
            (screen.width()  - window.width())  // 2,
            (screen.height() - window.height()) // 2,
        )

    # 260521 Red 退出时保存窗口几何
    app.aboutToQuit.connect(bridge.saveWindowGeometry)

    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()