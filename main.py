# author Red
# @project  Red Studio  3.6.2
# @since    2026-05-14
# @updated  2026-05-25
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
from PySide6.QtGui import QGuiApplication, QIcon, QCursor, QRegion
from PySide6.QtWebChannel import QWebChannel
from PySide6.QtWebEngineCore import QWebEngineScript
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import QApplication, QWidget

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

# Win32 WM_NCLBUTTONDOWN：标题栏拖拽使用
_WM_NCLBUTTONDOWN = 0x00A1

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
        #260530 Red 长文本分段并行下载、顺序播放，避免单次请求超时
        import base64, os, re, tempfile, time
        import requests as _req
        from concurrent.futures import ThreadPoolExecutor, as_completed
        voice = voice_id or "冰糖"
        mci = ctypes.windll.winmm.mciSendStringW

        # 按句末标点分段，每段不超过 300 字符
        def _split(text, max_len=300):
            sents = re.split(r'(?<=[。！？.!?\n])\s*', text)
            chunks, cur = [], ""
            for s in sents:
                if len(cur) + len(s) > max_len and cur:
                    chunks.append(cur)
                    cur = s
                else:
                    cur += s
            if cur.strip():
                chunks.append(cur)
            return chunks if chunks else [text]

        # 下载单段音频，返回 (index, tmp_path) 或 (index, None)
        def _download(idx, chunk):
            if gen != self._tts_generation[0]:
                return idx, None
            tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
            tmp_path = tmp.name
            tmp.close()
            try:
                resp = _req.post(
                    "https://api.xiaomimimo.com/v1/chat/completions",
                    headers={"api-key": api_key, "Content-Type": "application/json"},
                    json={
                        "model": "mimo-v2.5-tts",
                        "messages": [{"role": "assistant", "content": chunk}],
                        "audio": {"format": "wav", "voice": voice},
                    },
                    timeout=60,
                )
                if resp.status_code != 200:
                    os.unlink(tmp_path)
                    return idx, None
                data = resp.json()
                audio_b64 = data["choices"][0]["message"]["audio"]["data"]
                with open(tmp_path, "wb") as f:
                    f.write(base64.b64decode(audio_b64))
                return idx, tmp_path
            except Exception:
                try: os.unlink(tmp_path)
                except Exception: pass
                return idx, None

        # 播放单段，返回是否被取消
        def _play(tmp_path):
            alias = "rds_tts"
            mci(f'open "{tmp_path}" alias {alias}', None, 0, None)
            mci(f'play {alias}', None, 0, None)
            buf = ctypes.create_unicode_buffer(256)
            cancelled = False
            while True:
                if gen != self._tts_generation[0]:
                    mci(f'stop {alias}', None, 0, None)
                    cancelled = True
                    break
                mci(f'status {alias} mode', buf, 256, None)
                if buf.value != 'playing':
                    break
                time.sleep(0.05)
            mci(f'close {alias}', None, 0, None)
            return cancelled

        chunks = _split(text)
        tmp_paths = [None] * len(chunks)
        try:
            # 并行下载所有分段
            with ThreadPoolExecutor(max_workers=min(len(chunks), 5)) as pool:
                futures = {pool.submit(_download, i, c): i for i, c in enumerate(chunks)}
                for future in as_completed(futures):
                    if gen != self._tts_generation[0]:
                        break
                    idx, path = future.result()
                    tmp_paths[idx] = path

            # 按顺序播放
            for path in tmp_paths:
                if gen != self._tts_generation[0] or not path:
                    break
                if _play(path):
                    break
        except _req.exceptions.Timeout:
            self.ttsError.emit("MiMo TTS 连接超时（60s），请检查网络或 API Key")
        except Exception as e:
            self.ttsError.emit(f"MiMo TTS 出错：{e}")
        finally:
            for p in tmp_paths:
                if p:
                    try: os.unlink(p)
                    except Exception: pass

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

    # ── 联网搜索 ──────────────────────────────────────────────────────────────

    @Slot(str, result=str)
    def webSearch(self, query: str) -> str:
        #260523 Red Ollama 云端搜索 API，结果注入上下文；支持任意 AI 模型
        import requests as _req
        with self._config_lock:
            api_key = self._config.get("ollama_api_key", "")
        if not api_key:
            return json.dumps({"error": "请在设置中填写 Ollama API Key（免费注册 ollama.com 获取）"})
        try:
            resp = _req.post(
                "https://ollama.com/api/web_search",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={"query": query, "max_results": 5},
                timeout=10,
            )
            if resp.status_code != 200:
                return json.dumps({"error": f"搜索失败 {resp.status_code}：{resp.text[:100]}"})
            return resp.text
        except _req.exceptions.Timeout:
            return json.dumps({"error": "搜索超时（10s），请检查网络"})
        except Exception as e:
            return json.dumps({"error": str(e)})

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

    # ── 角色库 导出 / 导入 ───────────────────────────────────────────────────────

    @Slot(result=str)
    def exportCharLib(self) -> str:
        from PySide6.QtWidgets import QFileDialog
        path, _ = QFileDialog.getSaveFileName(
            self._window, "导出角色库", "characters.json", "JSON (*.json)"
        )
        if not path:
            return json.dumps({"error": "cancelled"})
        with self._config_lock:
            data = {
                "novel_heroines":  self._config.get("novel_heroines", {}),
                "story_char_cards": self._config.get("story_char_cards", {}),
            }
        pathlib.Path(path).write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return json.dumps({"ok": path})

    @Slot(result=str)
    def importCharLib(self) -> str:
        from PySide6.QtWidgets import QFileDialog
        path, _ = QFileDialog.getOpenFileName(
            self._window, "导入角色库", "", "JSON (*.json)"
        )
        if not path:
            return json.dumps({"error": "cancelled"})
        data = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
        with self._config_lock:
            self._config.setdefault("novel_heroines", {}).update(
                data.get("novel_heroines", {})
            )
            self._config.setdefault("story_char_cards", {}).update(
                data.get("story_char_cards", {})
            )
            cfg.save_config(self._config)
        imported = list(data.get("novel_heroines", {}).keys()) + \
                   list(data.get("story_char_cards", {}).keys())
        return json.dumps({"ok": True, "imported": imported})

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


# ── 边缘缩放覆盖层（纯 Qt，不依赖 Windows API） ──────────────

class _EdgeOverlay(QWidget):
    _MARGIN = 8
    _MIN_W  = 800
    _MIN_H  = 560
    _CURSORS = {
        'tl': Qt.SizeFDiagCursor, 'tr': Qt.SizeBDiagCursor,
        'bl': Qt.SizeBDiagCursor, 'br': Qt.SizeFDiagCursor,
        'l':  Qt.SizeHorCursor,   'r':  Qt.SizeHorCursor,
        't':  Qt.SizeVerCursor,   'b':  Qt.SizeVerCursor,
    }

    def __init__(self, parent, window):
        super().__init__(parent)
        self._window    = window
        self._resizing  = False
        self._edge      = None
        self._start_pos = None
        self._start_geo = None
        self.setMouseTracking(True)
        self.setAttribute(Qt.WA_TransparentForMouseEvents, False)

    def _update_mask(self):
        w, h = self.width(), self.height()
        m     = self._MARGIN
        full  = QRegion(0, 0, w, h)
        inner = QRegion(m, m, w - 2 * m, h - 2 * m)
        self.setMask(full.subtracted(inner))

    def resizeEvent(self, e):
        super().resizeEvent(e)
        self._update_mask()

    def _edge_at(self, pos):
        w, h = self.width(), self.height()
        m = self._MARGIN
        x, y = int(pos.x()), int(pos.y())
        on_l = x <= m; on_r = x >= w - m - 1
        on_t = y <= m; on_b = y >= h - m - 1
        if on_t and on_l: return 'tl'
        if on_t and on_r: return 'tr'
        if on_b and on_l: return 'bl'
        if on_b and on_r: return 'br'
        if on_l: return 'l'
        if on_r: return 'r'
        if on_t: return 't'
        if on_b: return 'b'
        return None

    def mouseMoveEvent(self, e):
        if self._resizing and self._edge:
            dx = e.globalPosition().x() - self._start_pos.x()
            dy = e.globalPosition().y() - self._start_pos.y()
            rx, ry, rw, rh = self._start_geo
            edge = self._edge
            if 'l' in edge: rx += dx; rw -= dx
            if 'r' in edge: rw += dx
            if 't' in edge: ry += dy; rh -= dy
            if 'b' in edge: rh += dy
            if rw < self._MIN_W:
                if 'l' in edge: rx -= (self._MIN_W - rw)
                rw = self._MIN_W
            if rh < self._MIN_H:
                if 't' in edge: ry -= (self._MIN_H - rh)
                rh = self._MIN_H
            self._window.setGeometry(int(rx), int(ry), int(rw), int(rh))
            return
        edge = self._edge_at(e.position())
        self.setCursor(self._CURSORS.get(edge, Qt.ArrowCursor))

    def mousePressEvent(self, e):
        if e.button() == Qt.LeftButton:
            edge = self._edge_at(e.position())
            if edge:
                self._resizing  = True
                self._edge      = edge
                self._start_pos = e.globalPosition().toPoint()
                self._start_geo = (self._window.x(), self._window.y(),
                                   self._window.width(), self._window.height())
                return
        super().mousePressEvent(e)

    def mouseReleaseEvent(self, e):
        if self._resizing:
            self._resizing  = False
            self._edge      = None
            self._start_pos = None
            self._start_geo = None
            return
        super().mouseReleaseEvent(e)


# ─── 主窗口类 ──────────────────────────────────────────────────────────────────

class MainWindow(QWebEngineView):
    def __init__(self):
        super().__init__()
        # 260514 Red FramelessWindowHint 移除系统标题栏，由前端 HTML 接管
        #260523 Red WindowMinimizeButtonHint：让 Windows 任务栏识别最小化，修复点击图标无法缩小的问题
        self.setWindowFlags(
            Qt.WindowType.Window
            | Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowMinimizeButtonHint
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
        if hasattr(self, '_edge_overlay'):
            self._edge_overlay.setGeometry(self.rect())
            self._edge_overlay.raise_()

    def resizeEvent(self, e):
        super().resizeEvent(e)
        if hasattr(self, '_edge_overlay'):
            self._edge_overlay.setGeometry(self.rect())
            self._edge_overlay.raise_()




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
        pass


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

    #260525 Red 边缘缩放覆盖层（纯 Qt）
    window._edge_overlay = _EdgeOverlay(window, window)
    window._edge_overlay.setGeometry(window.rect())
    window._edge_overlay.show()
    window._edge_overlay.raise_()

    app.aboutToQuit.connect(bridge.saveWindowGeometry)

    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()