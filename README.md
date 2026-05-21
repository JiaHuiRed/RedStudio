# 🎨 Red Studio — AI 对话桌面应用

版本：`3.2.0` · 作者：Red · Windows 10/11 · Python 3.10+

> 轻量本地 AI 对话客户端，支持 Ollama 本地模型与任意 OpenAI 兼容云端 API ✨

---

## 💬 对话核心

- 🔌 **多 Provider 支持**：动态管理供应商（增/删/改），侧边栏下拉切换
- ⚡ **流式输出**：回复逐字实时渲染，QWebChannel 信号直推，无网络层开销
- 📝 **Markdown 渲染**：标题、列表、表格、代码块完整支持
- 🎨 **代码高亮 + 一键复制**：语法高亮，右上角复制按钮
- 🧠 **思考模式**：支持 DeepSeek-R1 推理过程展示，可折叠思考块
- 📌 **系统提示词**：每条对话独立内联设置（可折叠），绑定提示词库快速填入
- ⏹ **停止生成**：流式输出过程中可随时中断
- 📋 **消息复制 / 朗读**：每条 AI 回复提供复制全文和 TTS 朗读按钮

## 📖 故事模式

- 侧边栏一键切换对话 / 故事模式
- AI 回复自动解析 `[角色名]` 前缀，每个角色独立彩色头像
- 支持上传自定义角色头像（缩放至 64×64 存储）
- 末尾选项自动渲染为可点击按钮

## 📊 Token 统计

- 每条消息显示 prompt / completion token 消耗
- 当前对话累计 token 显示在输入框底部
- 侧边栏内嵌今日 Token 仪表盘（甜甜圈图 + 图例），按供应商分色统计

## 🔊 TTS 朗读

- 使用 Windows 内置 SAPI，免费、无需 API Key、离线可用
- 支持切换男声 / 女声（列出系统已安装的所有声线）
- 可调语速（-10 最慢 ~ 10 最快）

## 🪟 界面与窗口

- **macOS 风格**：无边框窗口、红黄绿交通灯按钮、可拖拽标题栏
- **5 套主题**：亮色 / 护眼米 / 护眼绿 / 深蓝 / 纯黑（OLED），循环切换
- **窗口自由缩放**：鼠标拖拽任意边/角缩放
- **历史搜索**：侧边栏实时过滤历史对话

---

## 📁 项目结构

```
RedStudio/
├── main.py              # 入口：Qt 窗口 + Bridge(QObject) + QWebChannel
├── config.py            # 配置读写（存储于用户目录）
├── build.bat            # 一键打包脚本
├── requirements.txt     # Python 依赖
├── RedStudio.spec       # PyInstaller 打包配置
├── providers/
│   ├── ollama.py        # Ollama 本地模型接口
│   └── openai_compat.py # OpenAI 兼容接口（DeepSeek / GLM / 豆包 / Qwen 等）
└── frontend/
    ├── index.html       # 页面结构
    ├── style.css        # 样式（CSS 变量主题系统）
    ├── app.js           # 前端逻辑（QWebChannel 桥接）
    ├── marked.min.js    # Markdown 渲染（离线）
    ├── highlight.min.js # 代码高亮（离线）
    └── highlight-github-dark.min.css
```

---

## 🚀 运行（源码方式）

```bash
pip install -r requirements.txt
python main.py
```

> 首次安装 PySide6 体积约 150 MB，请耐心等待。

## 📦 打包为 exe

```bat
build.bat
```

打包完成后，`dist\RedStudio\` 文件夹可整体复制到任意 Windows 10/11 电脑，双击 `RedStudio.exe` 即可运行，无需安装 Python。

---

## ⚙️ 配置说明

| 文件 | 路径 |
|------|------|
| 配置 | `~/.aistory/config.json` |
| 历史 | `~/.aistory/history.json` |

### 添加自定义 Provider

设置面板 → 供应商 → **+ 添加供应商**：

| 字段 | 示例 |
|------|------|
| 名称 | 豆包 |
| 类型 | OpenAI 兼容 |
| Base URL | `https://ark.volcengine.com/api/v3` |
| API Key | 你的 Key |

所有 OpenAI 兼容服务（GLM、豆包、Qwen、Moonshot 等）均可通过此方式接入。

### 使用 Ollama 本地模型

```bash
ollama pull qwen2.5:7b
```

Ollama 运行后，在应用中选择 Ollama Provider，点击刷新图标自动加载可用模型。

---

## 🛠 技术栈

| 层 | 技术 |
|----|------|
| 桌面窗口 | PySide6 + QWebEngineView（Chromium 内核） |
| JS ↔ Python 桥接 | QWebChannel（零 HTTP，信号直推） |
| 窗口控制 | Win32 API（ctypes） |
| 前端 | 原生 HTML / CSS / JavaScript |
| Markdown | marked.js v4（本地离线） |
| 代码高亮 | highlight.js v11（本地离线） |
| TTS | Windows SAPI（win32com，系统内置） |
| 配置 / 历史 | JSON 文件（`~/.aistory/`） |

---

## 📋 版本历史

| 版本 | 日期 | 内容 |
|------|------|------|
| 3.2.0 | 2026-05-21 | 原生 WM_NCHITTEST 四边/顶角缩放、拖移无侧边栏闪烁、macOS UI 细节打磨、默认窗口 1000×800 |
| 3.1.0 | 2026-05-21 | 窗口几何记忆（默认 1440×1080）、懒加载历史消息、流式 Markdown 节流渲染、停止后补渲染、鲸鱼生成动画 |
| 3.0.0 | 2026-05-21 | QWebChannel 重构（移除 Flask）、离线前端依赖、流式渲染优化、历史搜索、build.bat |
| 2.1.0 | 2026-05-15 | 动态 Provider 管理、今日 Token 仪表盘、5 套主题、TTS 朗读、窗口边缘缩放 |
| 2.0.0 | 2026-05-15 | 故事模式、提示词库、Session Token 计数、消息重新编辑 |
| 1.2.0 | 2026-05-15 | 修复设置保存时 API Key 被清空 |
| 1.1.0 | 2026-05-15 | Markdown 渲染、代码高亮复制、历史持久化、消息复制、导出、AI 头像 |
| 1.0.0 | 2026-05-14 | 初始版本：多 Provider、流式输出、思考模式、macOS 风格 UI |

## 📐 版本规则

- 小改动：`x.x.patch`（bug 修复、细节调整）
- 中改动：`x.minor.0`（新功能、较大改动）
- 大改动：`major.0.0`（架构重构、重大更新）
