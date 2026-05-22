# 🎨 Red Studio

> **轻量本地 AI 对话桌面客户端，支持 Ollama 本地模型与任意 OpenAI 兼容云端 API。**
> 作者：Red · 基于 PySide6 + QWebChannel 构建，无 Flask 无 HTTP 层。

[![版本](https://img.shields.io/badge/版本-v3.3.0-blue)](CHANGELOG.md)
[![平台](https://img.shields.io/badge/平台-Windows%2010%2F11-lightblue)](https://github.com/JiaHuiRed/RedStudio)
[![Python](https://img.shields.io/badge/Python-3.10%2B-yellow)](https://python.org)
[![许可证](https://img.shields.io/badge/许可证-MIT-lightgrey)](LICENSE)

---

## ✨ 这是什么？

面向 DeepSeek / Qwen / Ollama 等大模型 API 的 Windows 桌面对话客户端。支持故事模式角色扮演、小说互动写作、流式输出、Markdown 渲染、TTS 朗读等功能。

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

## 🎭 故事模式（角色扮演）

- 侧边栏切换 **故事 / 小说** 双模式
- **角色卡系统**：姓名、身份/称谓、外貌、性格、语言风格、爱好、与主角关系、背景故事，自动拼入系统提示词
- 多角色卡管理（增/删/改），对话级别记忆当前选中角色卡
- AI 回复自动解析 `[角色名]` 前缀，每个角色独立彩色头像
- 支持上传自定义角色头像，末尾选项渲染为可点击按钮

## 📖 小说模式（互动写作）

- **女明星角色卡**：姓名、出生日期、身高、国籍/公司、性格关键词、语言风格、爱好、代表作品、当前日程，CRUD 管理
- **男主角设定**：在设置面板中填写姓名、籍贯、外貌等字段
- **小说提示词模板**：粘贴完整 system prompt，三者自动拼接后发送
- AI 回复自动解析编号选项（1–4），渲染为可点击的章回选项按钮

## 📊 Token 统计

- 每条消息显示 prompt / completion token 消耗
- 当前对话累计 token 显示在输入框底部
- 侧边栏内嵌今日 Token 仪表盘（甜甜圈图 + 图例），按供应商分色统计

## 🔊 TTS 朗读

- **Edge TTS**（默认）：微软神经网络声线，28 个中文声线，在线可用
- **Windows SAPI**：系统内置，免费、离线
- 可切换声线、调节语速（-10 最慢 ~ 10 最快）

## 🪟 界面与窗口

- **macOS 风格**：无边框窗口、红黄绿交通灯按钮、可拖拽标题栏
- **5 套主题**：亮色 / 护眼米 / 护眼绿 / 深蓝 / 纯黑（OLED），循环切换
- **窗口自由缩放**：鼠标拖拽任意边/角缩放，无 backdrop-filter 闪烁
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
| TTS | Edge TTS（神经网络）/ Windows SAPI（离线） |
| 配置 / 历史 | JSON 文件（`~/.aistory/`） |

---

## 📋 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

---

## 💙 致谢

- 构建工具：[PyInstaller](https://pyinstaller.org)、[PySide6](https://doc.qt.io/qtforpython)
- 许可证：MIT
