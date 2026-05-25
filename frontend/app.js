// author Red
// 260521 Red QWebChannel 重构：移除 Flask HTTP 层，改用 Qt 直接桥接

// ─── QWebChannel 桥接 ────────────────────────────────────────────────────────
let bridge = null;

// 260521 Red 将有返回值的 Slot 包装为 Promise（QWebChannel 约定：最后一个参数是回调）
function bridgeCall(method, ...args) {
  return new Promise(r => bridge[method](...args, r));
}

// ─── Markdown / 代码高亮 初始化 ─────────────────────────────────────────────
// 260514 Red marked v4 setOptions 配置：gfm + 换行 + highlight.js 代码高亮
// 260514 Red 仅在库加载成功时配置，CDN 离线时降级为纯文本
if (typeof marked !== "undefined" && typeof hljs !== "undefined") {
  marked.setOptions({
    gfm: true,
    breaks: true,
    highlight(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return hljs.highlightAuto(code).value;
    }
  });
}

// 260514 Red 将 Markdown 文本渲染为 HTML 并写入 bubble，同时高亮代码块、添加复制按钮
function renderMarkdownBubble(bubble, text) {
  if (!text) return;
  if (typeof marked === "undefined") {
    // 260514 Red 降级：marked 未加载时直接显示纯文本
    bubble.textContent = text;
    return;
  }
  bubble.innerHTML = marked.parse(text);
  // 260514 Red 对每个 <pre><code> 块单独应用语法高亮
  if (typeof hljs !== "undefined") {
    bubble.querySelectorAll("pre code").forEach(el => hljs.highlightElement(el));
  }
  attachCopyButtons(bubble);
}

// ─── 懒加载 ──────────────────────────────────────────────────────────────────
// 260521 Red 每次最多渲染最后 LAZY_LOAD_COUNT 条消息，超出部分通过按钮按需加载
const LAZY_LOAD_COUNT = 20;

// 260521 Red 清空消息区并渲染 messages（超出懒加载阈值时插入"加载更早"按钮）
function renderMessageList(messages) {
  messagesEl.innerHTML = "";
  if (messages.length === 0) {
    messagesEl.appendChild(makeWelcome());
    return;
  }
  const start = Math.max(0, messages.length - LAZY_LOAD_COUNT);
  if (start > 0) {
    const btn = document.createElement("button");
    btn.className = "load-earlier-btn";
    btn.textContent = `↑ 加载更早的 ${start} 条消息`;
    btn.onclick = () => {
      // 记录当前滚动高度，加载后保持视口位置
      const prevHeight = messagesEl.scrollHeight;
      btn.remove();
      // 将早期消息插入到现有消息之前
      const frag = document.createDocumentFragment();
      for (let i = 0; i < start; i++) {
        const m = messages[i];
        // 借用 appendMessage 但插入到最前——临时附加到 frag
        const placeholder = document.createElement("div");
        frag.appendChild(placeholder);
      }
      // 重新全量渲染（最简单可靠）
      messagesEl.innerHTML = "";
      messages.forEach((m, i) => appendMessage(m.role, m.content, i));
      messagesEl.scrollTop = messagesEl.scrollHeight - prevHeight;
    };
    messagesEl.appendChild(btn);
    messages.slice(start).forEach((m, i) => appendMessage(m.role, m.content, start + i));
  } else {
    messages.forEach((m, i) => appendMessage(m.role, m.content, i));
  }
}

// 260521 Red 流式 Markdown 节流渲染：600ms 后执行一次 Markdown 渲染，减少割裂感
function _scheduleMarkdownRender(sc) {
  if (sc.renderTimer) return;
  sc.renderTimer = setTimeout(() => {
    sc.renderTimer = null;
    if (state.streamCtx === sc && sc.ctx.fullContent) {
      renderMarkdownBubble(sc.bubble, sc.ctx.fullContent);
    }
  }, 600);
}

// 260521 Red 导出当前对话为 Markdown 文件（纯前端 Blob 下载，无需服务器）
function exportChat() {
  if (state.messages.length === 0) return;
  const title = state.messages.find(m => m.role === "user")?.content?.slice(0, 30) || "对话";
  const sections = state.messages.map(m => {
    const role = m.role === "user" ? "## 用户" : "## AI";
    return `${role}\n\n${m.content}`;
  });
  const md = `# ${title}\n\n${sections.join("\n\n---\n\n")}`;
  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = title.replace(/[/\\?%*:|"<>]/g, "_") + ".md";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── TTS（文字转语音） ────────────────────────────────────────────────────────
// 当前正在朗读的按钮引用，用于切换状态
let _ttsBtn = null;

// 去除 Markdown 标记，只保留纯文本供朗读
function stripMarkdown(text) {
  return text
    .replace(/```[\s\S]*?```/g, "")           // 代码块
    .replace(/`[^`\n]+`/g, "")                // 行内代码
    .replace(/#{1,6}\s+/g, "")                // 标题 #
    .replace(/\*{1,2}([^*\n]+)\*{1,2}/g, "$1") // 粗体 / 斜体
    .replace(/_([^_\n]+)_/g, "$1")            // 下划线斜体
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")  // 链接 → 文字
    .replace(/!\[.*?\]\([^)]+\)/g, "")        // 图片
    .replace(/^\s*[-*+]\s+/gm, "")            // 无序列表
    .replace(/^\s*\d+\.\s+/gm, "")            // 有序列表
    .replace(/^>\s*/gm, "")                   // 引用块
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function speakMessage(btn, getText) {
  // 当前正在朗读同一条 → 停止
  if (_ttsBtn === btn) {
    _ttsBtn = null;
    btn.classList.remove("speaking");
    bridge.ttsStop();
    _hideTtsStopBtn();
    return;
  }
  // 停止上一条
  if (_ttsBtn) {
    _ttsBtn.classList.remove("speaking");
    _ttsBtn = null;
    bridge.ttsStop();
  }
  const text = stripMarkdown(getText());
  if (!text) return;
  _ttsBtn = btn;
  btn.classList.add("speaking");
  _showTtsStopBtn();
  // 260521 Red 直接调用桥接槽，ttsDone 信号会在朗读结束时恢复按钮
  bridge.ttsSpeak(text);
}

function _showTtsStopBtn() {
  const b = $("tts-stop-btn");
  if (b) b.classList.add("visible");
}
function _hideTtsStopBtn() {
  const b = $("tts-stop-btn");
  if (b) b.classList.remove("visible");
}

// 260521 Red ttsDone 信号处理：朗读结束后自动恢复按钮状态
function onTtsDone() {
  if (_ttsBtn) {
    _ttsBtn.classList.remove("speaking");
    _ttsBtn = null;
  }
  _hideTtsStopBtn();
}

// 260523 Red ttsError 信号处理：Edge TTS 出错时提示并清除状态
function onTtsError(msg) {
  if (_ttsBtn) {
    _ttsBtn.classList.remove("speaking");
    _ttsBtn = null;
  }
  _hideTtsStopBtn();
  showError(msg);
}

// 为 AI 消息内容列添加"复制全文"和"朗读"按钮
// getContent 是惰性求值函数，避免在流式阶段过早捕获内容
function addMessageActions(container, getContent) {
  const actions = document.createElement("div");
  actions.className = "msg-actions";

  // 复制按钮
  const copyBtn = document.createElement("button");
  copyBtn.className = "copy-msg-btn";
  copyBtn.title = "复制全文";
  copyBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
    <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
  </svg>`;
  copyBtn.onclick = () => {
    navigator.clipboard.writeText(getContent()).then(() => {
      copyBtn.title = "已复制";
      copyBtn.classList.add("copied");
      setTimeout(() => { copyBtn.title = "复制全文"; copyBtn.classList.remove("copied"); }, 2000);
    }).catch(() => {});
  };

  // 朗读按钮（使用 Windows SAPI，始终显示）
  const ttsBtn = document.createElement("button");
  ttsBtn.className = "copy-msg-btn tts-btn";
  ttsBtn.title = "朗读";
  ttsBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
    <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
    <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
  </svg>`;
  ttsBtn.onclick = () => speakMessage(ttsBtn, getContent);
  actions.appendChild(ttsBtn);

  actions.appendChild(copyBtn);
  container.appendChild(actions);
}

// 260515 Red 删除指定 id 的历史条目并持久化
function deleteHistory(id) {
  state.chatHistory = state.chatHistory.filter(h => h.id !== id);
  if (state.currentChatId === id) state.currentChatId = null;
  renderHistory();
  bridge.saveHistory(JSON.stringify(state.chatHistory.slice(0, 30)));
}

// 260514 Red 为 bubble 内所有 <pre> 块追加复制按钮（innerHTML 重置后需重新挂载）
function attachCopyButtons(el) {
  el.querySelectorAll("pre").forEach(pre => {
    const btn = document.createElement("button");
    btn.className = "copy-code-btn";
    btn.textContent = "复制";
    btn.onclick = () => {
      const code = pre.querySelector("code");
      navigator.clipboard.writeText(code?.textContent ?? "").then(() => {
        btn.textContent = "已复制";
        setTimeout(() => { btn.textContent = "复制"; }, 2000);
      }).catch(() => {});
    };
    pre.appendChild(btn);
  });
}

// ─── 故事模式常量 ───────────────────────────────────────────────────────────
// 260515 Red 角色调色板：8 种高饱和色，按角色名哈希稳定分配
const CHAR_COLORS = ["#5b8cff","#ff6b9d","#ffd166","#06d6a0","#ef476f","#7b61ff","#f4a261","#2ec4b6"];

function charColor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  return CHAR_COLORS[h % CHAR_COLORS.length];
}

// 260515 Red 解析 AI 故事回复：提取 [角色名] 前缀 + 末尾选项按钮
function parseStoryContent(text) {
  const nameMatch = text.match(/^\[([^\]]{1,24})\]\s*/);
  const charName  = nameMatch ? nameMatch[1] : null;
  const body      = nameMatch ? text.slice(nameMatch[0].length) : text;

  // 从末尾向上扫描连续的选项行（A. / B. / 1. / 2. 等格式）
  const lines    = body.split("\n");
  const choiceRe = /^([A-Ea-e1-5])[.．、）)]\s+(.{1,100})/;
  const choices  = [];
  let splitIdx   = lines.length;

  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) { if (choices.length > 0) break; continue; }
    const m = trimmed.match(choiceRe);
    if (m) { choices.unshift({ key: m[1].toUpperCase(), label: trimmed }); splitIdx = i; }
    else   { if (choices.length > 0) break; }
  }

  const mainText = choices.length >= 2
    ? lines.slice(0, splitIdx).join("\n").trimEnd()
    : body;

  return { charName, mainText, choices: choices.length >= 2 ? choices : [] };
}

// ─── 状态 ──────────────────────────────────────────────────────────────────
const state = {
  provider: "ollama",       // 当前选中的 provider
  model: "",                // 当前选中的模型
  messages: [],             // 当前对话的消息列表 [{role, content}]
  chatHistory: [],          // 历史对话列表 [{id, title, provider, model, messages}]
  isStreaming: false,       // 是否正在生成
  streamCtx: null,          // 260521 Red 流式上下文（替代 AbortController 方案）
  config: {},               // 从服务器加载的配置
  theme: "light",           // 当前主题
  nextChatId: 1,            // 历史对话 ID 计数器
  // 260514 Red currentChatId: 当前会话在历史中的 id，null 表示尚未存入历史
  currentChatId: null,
  thinkingEnabled: false,
  webSearchEnabled: false,
  // 260514 Red pendingAvatar: 设置面板中待保存的头像 data URL
  pendingAvatar: undefined,
  // 260515 Red 故事模式（角色扮演）
  mode: "rpg",              // "rpg"=RPG冒险 | "novel"=小说
  currentSystemPrompt: "",  // 当前对话的系统提示词
  storyCharacters: {},      // { 角色名: { color, avatar } }
  storyCharCardName: "",    //#260522 Red 当前选中的故事模式角色卡名称
  //260523 Red RPG 模式角色与状态
  rpgChar: {
    name: "", class: "", background: "",
    str: 10, agi: 10, int: 10, vit: 10,
    knowledge: 1, charm: 1, guts: 1, kindness: 1, craft: 1
  },
  rpgStatus: {
    hp: 100, hpMax: 100, mp: 50, mpMax: 50,
    lv: 1, exp: 0, expNext: 100, gold: 50
  },
  rpgWorldDir: "",          // 世界/故事方向
  novelHeroine: "",         //#260522 Red 当前选中的小说模式女主角名称
  //260523 Red 作者注记
  authorNote:      "",  // 注入 context 靠后位置的临时指令
  authorNoteDepth: 3,   // 插入深度：距末尾消息条数
  //260523 Red 小说模式好感度系统
  novelFav:       0,        // 当前好感度 0-100
  novelStage:     "陌生人", // 当前阶段
  //260523 Red 完全自定义阶段：[{name, cap}]，cap 为该阶段好感上限，最后一段固定 100
  novelStages: [
    { name: "陌生人", cap: 20, rule: "保持礼貌距离，禁止任何肢体接触、暧昧动作和亲密话语" },
    { name: "相识",   cap: 45, rule: "可有日常接触（握手、碰肩），限于普通朋友范畴，禁止暧昧" },
    { name: "朋友",   cap: 70, rule: "友好亲近，可自然接触，禁止任何暧昧行为和亲密描写" },
    { name: "暧昧",   cap: 90, rule: "可有明显暧昧互动（牵手、对视），禁止成人向描写" },
    { name: "恋人",   cap: 100, rule: "可有亲密表达，视剧情自然推进，禁止无铺垫的成人向内容" }
  ],
  novelWordCount: 200,      // 每轮正文字数
  novelPov:       "second", // 叙事视角 first/second/third
  novelHeroName:  "林然",   // 主角名称
  novelStoryDir:  "",       // 故事方向 / 主角背景
  // 260515 Red Token 统计：当前对话累计消耗
  sessionTokens: { prompt: 0, completion: 0 },
  // 260515 Red 提示词库：[{ title, content }]
  prompts: [],
  //260525 Red 快速预设：当前激活的预设 id
  activePreset: null,
  //260525 Red 记忆压缩：是否正在执行压缩摘要调用
  summarizing: false,
  summaryKeepFrom: 0
};

//260525 Red 快速预设定义（2×2 网格，novel/rpg 各两个）
const PRESETS = [
  { id: "romance", name: "言情小说", mode: "novel", sysPrompt: "" },
  { id: "fantasy", name: "奇幻RPG",  mode: "rpg",   sysPrompt: "" },
  { id: "campus",  name: "校园日常", mode: "novel", sysPrompt: "现代校园背景，注重日常细节与情感描写。" },
  { id: "wuxia",   name: "武侠RPG",  mode: "rpg",   sysPrompt: "中国武侠江湖世界，主角习武闯荡。" },
];

// ─── DOM 引用 ───────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

//260523 Red textarea 内容自动撑高（最大高度由 CSS max-height 控制）
function autoResizeTextarea(el) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
}
const messagesEl      = $("messages");
const userInputEl     = $("user-input");
const sendBtn         = $("send-btn");
const stopBtn         = $("stop-btn");
const thinkBtn        = $("think-btn");
const webBtn          = $("web-btn");
const thinkStatus     = $("think-status");
const modelSelect     = $("model-select");
const titlebarTitle   = $("titlebar-title");
const chatHistory     = $("chat-history");
const statusDot       = $("provider-status");
const settingsOverlay = $("settings-overlay");

// ─── 初始化 ─────────────────────────────────────────────────────────────────
// 260521 Red 不再需要 waitForServer / sleep，QWebChannel 就绪后直接初始化
async function init() {
  const cfg = await fetchConfig();
  state.config  = cfg;
  state.theme   = cfg.theme || "light";
  state.prompts = cfg.prompts || [];
  applyTheme(state.theme);
  applyChatFontSize(cfg.chat_font_size || 14);

  // 恢复上次使用的 provider（先填充下拉列表，再切换）
  populateProviderSelect();
  const providerOrder = cfg.provider_order || Object.keys(cfg.providers || {});
  const lastProvider = cfg.last_provider || providerOrder[0] || "ollama";
  switchProvider(lastProvider, false);

  //#260522 Red 恢复上次的模式，兼容旧值 "story"→"novel"
  const _lastMode = cfg.last_mode === "story" ? "novel" : (cfg.last_mode || "rpg");
  switchMode(_lastMode, false);
  populateHeroineSelect();
  populateStoryCharSelect();

  // 从桥接加载历史对话
  await loadChatHistory();
  renderHistory();

  renderStatsInline();

  // 260522 Red 恢复侧边栏折叠状态
  state.sidebarCollapsed = !!cfg.sidebar_collapsed;
  if (state.sidebarCollapsed) {
    document.body.classList.add("sidebar-collapsed");
  }

  setupEventListeners();
  updateNovelFavBar();
  updateRpgStatusBar();
  updateNovelHeroineTag();
  renderPresets();
}

// ─── 配置 ───────────────────────────────────────────────────────────────────
async function fetchConfig(force = false) {
  // 优先返回内存中已有的 config，避免重复调用
  if (!force && state.config && Object.keys(state.config).length > 0) {
    return state.config;
  }
  try {
    const str    = await bridgeCall("getConfig");
    state.config = JSON.parse(str);
    return state.config;
  } catch {
    return state.config || {};
  }
}

// ─── Provider 切换 ───────────────────────────────────────────────────────────
function switchProvider(provider, saveConfig = true) {
  state.provider = provider;
  const sel = $("provider-select");
  if (sel && sel.value !== provider) sel.value = provider;
  loadModels(provider);
  if (saveConfig) postConfig({ last_provider: provider });
}

// 根据 config.providers + provider_order 填充供应商下拉列表
function populateProviderSelect() {
  const sel = $("provider-select");
  if (!sel) return;
  const providers = state.config.providers || {};
  const order = state.config.provider_order || Object.keys(providers);
  sel.innerHTML = order
    .filter(id => providers[id])
    .map(id => {
      const name = providers[id].name || id;
      return `<option value="${id}">${name}</option>`;
    }).join("");
  sel.value = state.provider;
}

// ─── 模型列表 ────────────────────────────────────────────────────────────────
// 260521 Red 调用 bridge.listModels，结果通过 modelsReady 信号异步返回
function loadModels(provider) {
  modelSelect.innerHTML = '<option value="">加载中…</option>';
  statusDot.className = "status-dot";
  bridge.listModels(provider);
}

// 260521 Red modelsReady 信号处理
function onModelsReady(jsonStr) {
  const data     = JSON.parse(jsonStr);
  const provider = data.provider;
  // 丢弃过期响应（用户在等待期间切换了 provider）
  if (provider !== state.provider) return;

  if (data.error) {
    modelSelect.innerHTML = '<option value="">连接失败</option>';
    statusDot.className = "status-dot error";
    console.warn("加载模型失败:", data.error);
    return;
  }

  const models = data.models || [];
  modelSelect.innerHTML = models.length
    ? models.map(m => `<option value="${m}">${m}</option>`).join("")
    : '<option value="">（无可用模型）</option>';

  // 260514 Red 状态指示点变绿，表示连接成功
  statusDot.className = "status-dot ok";

  // 恢复上次选择的模型
  const lastModel = state.config.last_model || "";
  if (lastModel && models.includes(lastModel)) {
    modelSelect.value = lastModel;
  }
  state.model = modelSelect.value;
}

// ─── 发送消息 ────────────────────────────────────────────────────────────────
async function sendMessage() {
  const text = userInputEl.value.trim();
  if (!text || state.isStreaming) return;

  const model = modelSelect.value;
  if (!model) {
    showError("请先选择模型");
    return;
  }

  // 260514 Red 移除欢迎页（若存在），首条消息发出后不再显示
  $("welcome")?.remove();

  // 260523 Red 联网搜索：开启时先搜索，把结果注入到消息前面
  let finalText = text;
  if (state.webSearchEnabled) {
    sendBtn.disabled = true;
    webBtn.classList.add("searching");
    try {
      const raw = await bridgeCall("webSearch", text);
      const data = JSON.parse(raw);
      if (data.error) {
        showError("联网搜索失败：" + data.error);
      } else if (data.results && data.results.length > 0) {
        const snippets = data.results.slice(0, 5).map((r, i) =>
          `[${i+1}] ${r.title}\n${r.url}\n${r.content || r.snippet || ""}`
        ).join("\n\n");
        finalText = `[联网搜索结果]\n${snippets}\n\n[用户问题]\n${text}`;
      }
    } catch (e) {
      showError("联网搜索异常：" + e);
    } finally {
      sendBtn.disabled = false;
      webBtn.classList.remove("searching");
    }
  }

  // 添加用户消息
  state.messages.push({ role: "user", content: finalText });
  appendMessage("user", text, state.messages.length - 1);  // 气泡显示原始文本

  userInputEl.value = "";
  autoResizeTextarea();

  // 更新标题（取第一条用户消息前 20 字）
  if (state.messages.filter(m => m.role === "user").length === 1) {
    titlebarTitle.textContent = text.slice(0, 24) + (text.length > 24 ? "…" : "");
  }

  // 开始流式生成
  streamReply(model);
}

// 260521 Red streamReply 改为同步函数：调用 bridge.sendChat 启动后台流，
// 通过 onChatChunk / onChatDone 信号接收结果
function streamReply(model) {
  state.isStreaming = true;
  sendBtn.disabled = true;
  stopBtn.classList.add("visible");
  // 260521 Red 显示鲸鱼生成动画
  $("stream-badge")?.classList.add("active");

  // 260514 Red 创建 AI 消息行：[头像] + [内容列（思考块/气泡/token标注）]
  const row = document.createElement("div");
  row.className = "msg-row assistant";
  messagesEl.appendChild(row);

  // 260514 Red 头像（故事模式下保留引用，流结束后更新角色颜色/图片）
  const avatarEl = makeAvatar();
  row.appendChild(avatarEl);

  // 260514 Red 内容列，后续思考块、气泡、token 标注都挂在此处
  const content = document.createElement("div");
  content.className = "msg-content";
  row.appendChild(content);

  // 260514 Red ctx 对象替代散装 getter/setter，集中管理流式状态
  const ctx = { thinkContent: "", inThinkTag: false, thinkBuffer: "", fullContent: "" };

  // 260514 Red 正文气泡，streaming 类通过 CSS ::after 显示动态光标
  const bubble = document.createElement("div");
  bubble.className = "msg-bubble streaming";
  content.appendChild(bubble);

  scrollToBottom();

  // 260521 Red 保存流式上下文，供信号处理函数访问
  state.streamCtx = { bubble, content, avatarEl, ctx, usageData: null, renderTimer: null };

  //#260522 Red 构造请求：小说模式自动构建，故事模式注入角色卡，其余使用手动输入
  const sysPrompt = state.mode === "novel"
    ? buildNovelSystemPrompt()
    : state.mode === "rpg"
      ? (buildRpgSystemPrompt() + (state.currentSystemPrompt.trim() ? "\n\n" + state.currentSystemPrompt.trim() : ""))
      : state.currentSystemPrompt.trim();
  const baseMessages = sysPrompt
    ? [{ role: "system", content: sysPrompt }, ...state.messages]
    : [...state.messages];
  //260523 Red 注入作者注记：插在距末尾 depth 条位置，AI 对靠近当前输入的内容注意力更高
  let apiMessages = injectAuthorNote(baseMessages);
  //260525 Red 小说模式：每轮注入状态提醒（好感度+阶段+行为边界），紧邻当前输入之前
  if (state.mode === "novel") apiMessages = injectNovelTurnReminder(apiMessages);

  bridge.sendChat(JSON.stringify({
    provider:          state.provider,
    model:             model,
    messages:          apiMessages,
    temperature:       state.config.temperature       ?? 0.7,
    max_tokens:        state.config.max_tokens        ?? 4096,
    top_p:             state.config.top_p             ?? 1.0,
    frequency_penalty: state.config.frequency_penalty ?? 0.0,
    presence_penalty:  state.config.presence_penalty  ?? 0.0,
    thinking:          state.thinkingEnabled
  }));
}

// 260521 Red chatChunk 信号处理：处理每个流式 chunk
function onChatChunk(jsonStr) {
  const sc = state.streamCtx;
  if (!sc) return;

  let chunk;
  try { chunk = JSON.parse(jsonStr); } catch { return; }

  if (chunk.error) { showError(chunk.error); return; }

  const { type, text } = chunk;

  if (type === "usage") {
    sc.usageData = chunk;
  } else if (type === "reason") {
    // 260514 Red OpenAI-compat 的 reasoning_content 字段
    if (state.thinkingEnabled) {
      sc.ctx.thinkContent += text;
      ensureThinkingBlock(sc.content, sc.bubble);
      const tb = sc.content.querySelector(".thinking-body");
      if (tb) tb.textContent = sc.ctx.thinkContent;
    }
  } else if (type === "content") {
    processContentDelta(text, sc.ctx, sc.content, sc.bubble);
  }
  scrollToBottom();
}

// 260521 Red chatDone 信号处理：流结束，执行原 finally 块的清理逻辑
function onChatDone() {
  const sc = state.streamCtx;
  if (!sc) return;
  state.streamCtx = null;

  if (sc.renderTimer) { clearTimeout(sc.renderTimer); sc.renderTimer = null; }
  $("stream-badge")?.classList.remove("active");

  //260525 Red 记忆压缩模式：摘要生成完成，直接应用摘要，不渲染气泡
  if (state.summarizing) {
    state.summarizing = false;
    state.isStreaming  = false;
    sendBtn.disabled   = false;
    stopBtn.classList.remove("visible");
    if (sc.ctx.fullContent) applySummary(sc.ctx.fullContent);
    return;
  }

  const { bubble, content, avatarEl, ctx } = sc;

  bubble.classList.remove("streaming");

  // 260514 Red 如果流结束时还在 <think> 标签内，把剩余缓冲归入思考块
  if (ctx.inThinkTag && ctx.thinkBuffer) {
    ctx.thinkContent += ctx.thinkBuffer;
    const tb = content.querySelector(".thinking-body");
    if (tb) tb.textContent = ctx.thinkContent;
  }

  finalizeThinkingBlock(content, ctx.thinkContent);

  // 260514 Red 流结束后做最终 Markdown 渲染
  if (ctx.fullContent) {
    renderMarkdownBubble(bubble, ctx.fullContent);
  } else if (!ctx.thinkContent) {
    bubble.textContent = "（已停止）";
  }

  //#260522 Red 故事模式（角色扮演）：解析角色名、渲染角色头像、添加选项按钮
  if (state.mode === "rpg" && ctx.fullContent) {
    const { charName, mainText, choices } = parseStoryContent(ctx.fullContent);

    if (charName) {
      if (!state.storyCharacters[charName]) {
        state.storyCharacters[charName] = { color: charColor(charName), avatar: "" };
      }
      refreshCharAvatar(avatarEl, charName);
      avatarEl.onclick = () => openCharAvatarUpload(charName);

      const nameLabel = document.createElement("div");
      nameLabel.className = "story-char-name";
      nameLabel.textContent = charName;
      content.insertBefore(nameLabel, content.firstChild);
    }

    if (mainText !== ctx.fullContent) {
      renderMarkdownBubble(bubble, mainText);
    }

    if (choices.length > 0) {
      const choicesDiv = document.createElement("div");
      choicesDiv.className = "story-choices";
      choices.forEach(c => {
        const btn = document.createElement("button");
        btn.className = "story-choice-btn";
        btn.textContent = c.label;
        btn.onclick = () => {
          userInputEl.value = c.label;
          autoResizeTextarea();
          userInputEl.focus();
        };
        choicesDiv.appendChild(btn);
      });
      content.appendChild(choicesDiv);
    }
  }

  //#260522 Red 小说模式：解析章回内容，渲染章回分隔线 + 选项按钮
  if (state.mode === "novel" && ctx.fullContent) {
    renderNovelChapter(content, bubble, ctx.fullContent);
    //260525 Red 格式校验：[CHOICES] 缺失时显示内联警告
    if (!/\[CHOICES\]/i.test(ctx.fullContent)) {
      const warn = document.createElement("div");
      warn.className = "novel-format-warn";
      warn.textContent = "本轮未生成选项，可自由输入继续剧情，或点击重新生成";
      const retryBtn = document.createElement("button");
      retryBtn.className = "novel-format-retry";
      retryBtn.textContent = "重新生成";
      retryBtn.onclick = () => {
        // 移除最后一条 AI 消息，重新发送上一条用户输入
        if (state.messages.length >= 2) {
          const lastUser = state.messages[state.messages.length - 2];
          state.messages.splice(state.messages.length - 1, 1);
          userInputEl.value = lastUser.content;
          autoResizeTextarea(userInputEl);
          sendMessage();
        }
      };
      warn.appendChild(retryBtn);
      content.appendChild(warn);
    }
  }

  //260523 Red RPG 模式：解析 [STATUS] 和 [CHOICES]，更新状态栏
  if (state.mode === "rpg" && ctx.fullContent) {
    renderRpgChapter(content, bubble, ctx.fullContent);
  }

  // 260514 Red 始终渲染 token 标注行
  showTokenUsage(content, sc.usageData);

  // 260515 Red 流结束后挂载复制全文按钮
  const finalContent = ctx.fullContent;
  if (finalContent) addMessageActions(content, () => finalContent);

  // 260514 Red 将完整回复写入消息历史，作为下一轮对话的上下文
  state.messages.push({ role: "assistant", content: ctx.fullContent });
  saveChatHistory();

  state.isStreaming = false;
  sendBtn.disabled  = false;
  stopBtn.classList.remove("visible");
}

// 260521 Red 处理普通内容 delta，内联检测 <think>...</think> 标签
// 流式阶段只追加纯文本（textContent），避免每 chunk 重跑 marked.parse；
// 流结束后 onChatDone 再统一做 Markdown 渲染。
function processContentDelta(text, ctx, container, bubble) {
  let i = 0;
  while (i < text.length) {
    if (!ctx.inThinkTag) {
      const startIdx = text.indexOf("<think>", i);
      if (startIdx === -1) {
        const seg = text.slice(i);
        ctx.fullContent += seg;
        bubble.textContent = ctx.fullContent;   // 260521 Red 纯文本，快速
        if (state.streamCtx) _scheduleMarkdownRender(state.streamCtx);  // 260521 Red 节流 MD 渲染
        i = text.length;
      } else {
        if (startIdx > i) {
          const before = text.slice(i, startIdx);
          ctx.fullContent += before;
          bubble.textContent = ctx.fullContent;
          if (state.streamCtx) _scheduleMarkdownRender(state.streamCtx);  // 260521 Red 节流 MD 渲染
        }
        ctx.inThinkTag = true;
        ctx.thinkBuffer = "";
        if (state.thinkingEnabled) ensureThinkingBlock(container, bubble);
        i = startIdx + 7; // skip "<think>"
      }
    } else {
      const endIdx = text.indexOf("</think>", i);
      if (endIdx === -1) {
        const seg = text.slice(i);
        if (state.thinkingEnabled) {
          ctx.thinkBuffer += seg;
          ctx.thinkContent += seg;
          const tb = container.querySelector(".thinking-body");
          if (tb) tb.textContent = ctx.thinkContent;
        }
        i = text.length;
      } else {
        if (state.thinkingEnabled) {
          const seg = text.slice(i, endIdx);
          ctx.thinkContent += seg;
          const tb = container.querySelector(".thinking-body");
          if (tb) tb.textContent = ctx.thinkContent;
        }
        ctx.inThinkTag = false;
        ctx.thinkBuffer = "";
        i = endIdx + 8; // skip "</think>"
      }
    }
  }
}

// 260514 Red 创建思考内容块（若不存在），插入在气泡之前
function ensureThinkingBlock(container, bubble) {
  if (container.querySelector(".thinking-block")) return;
  const block = document.createElement("div");
  block.className = "thinking-block open";
  block.innerHTML = `
    <div class="thinking-header" onclick="this.parentElement.classList.toggle('open')">
      <span class="thinking-label">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/>
        </svg>
        思考中
        <span class="thinking-dots"><span></span><span></span><span></span></span>
      </span>
      <svg class="thinking-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
    </div>
    <div class="thinking-body"></div>`;
  container.insertBefore(block, bubble);
}

// 260514 Red 思考结束后更新标题，移除动画，折叠显示
function finalizeThinkingBlock(container, thinkContent) {
  const block = container.querySelector(".thinking-block");
  if (!block) return;
  if (!thinkContent) { block.remove(); return; }
  const label = block.querySelector(".thinking-label");
  if (label) {
    label.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <path d="M9.663 17h4.673M12 3a6 6 0 0 1 6 6 6 6 0 0 1-3 5.197V16a1 1 0 0 1-1 1H10a1 1 0 0 1-1-1v-1.803A6 6 0 0 1 6 9a6 6 0 0 1 6-6z"/>
      </svg>
      思考过程`;
  }
  block.classList.remove("open");
}

function stopGeneration() {
  // 260521 Red 通知 Python 后台停止流式生成
  bridge.stopChat();
}

// ─── 头像 ────────────────────────────────────────────────────────────────────
function makeAvatar() {
  const el = document.createElement("div");
  el.className = "msg-avatar";
  const avatar = state.config.ai_avatar || "";
  const name   = state.config.ai_name   || "AI";
  if (avatar) {
    const img = document.createElement("img");
    img.src = avatar;
    el.appendChild(img);
  } else {
    el.textContent = name.charAt(0).toUpperCase() || "A";
  }
  return el;
}

function refreshCharAvatar(el, name) {
  const char  = state.storyCharacters[name] || {};
  const color = char.color || charColor(name);
  el.innerHTML = "";
  el.style.background = "";
  if (char.avatar) {
    const img = document.createElement("img");
    img.src = char.avatar;
    el.appendChild(img);
  } else {
    el.textContent    = name.charAt(0);
    el.style.background = color;
  }
  el.dataset.char = name;
  el.title        = `${name} · 点击上传头像`;
}

function openCharAvatarUpload(name) {
  const input = $("char-avatar-input");
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const dataUrl = await resizeImage(file, 64);
    if (!state.storyCharacters[name]) {
      state.storyCharacters[name] = { color: charColor(name), avatar: "" };
    }
    state.storyCharacters[name].avatar = dataUrl;
    document.querySelectorAll(`.msg-avatar[data-char="${name}"]`).forEach(el => {
      refreshCharAvatar(el, name);
    });
    e.target.value = "";
  };
  input.click();
}

// 260515 Red 模式切换：故事 ↔ 小说
function switchMode(mode, save = true) {
  state.mode = mode;
  //#260522 Red 设置 body 和 #content 上的 data-mode，CSS 用 body[data-mode] 控制侧边栏区块显示
  document.body.dataset.mode = mode;
  document.getElementById("content").dataset.mode = mode;

  document.querySelectorAll(".mode-tab").forEach(tab => {
    tab.classList.toggle("active", tab.dataset.mode === mode);
  });

  const bar   = $("sys-prompt-bar");
  const input = $("sys-prompt-input");
  if (bar)   bar.classList.toggle("novel-mode", mode === "novel");
  const novelStatusBar = $("novel-status-bar");
  if (novelStatusBar) novelStatusBar.classList.toggle("hidden", mode !== "novel");
  const rpgStatusBar = $("rpg-status-bar");
  if (rpgStatusBar) rpgStatusBar.classList.toggle("hidden", mode !== "rpg");
  if (input) input.placeholder = mode === "novel"
    ? "小说模式（系统提示词自动构建，通常无需手动填写）…"
    : mode === "rpg"
    ? "RPG 模式（可在此补充额外规则，留空使用默认 DM 框架）…"
    : "输入系统提示词（可选）…";

  renderModeSection();
  if (save) postConfig({ last_mode: mode });
}

//260526 Red 渲染合并模式专属区（RPG / 小说共用 #mode-section）
function renderModeSection() {
  const body = $("mode-section-body");
  if (!body) return;
  const mode = state.mode;
  body.innerHTML = "";
  if (mode === "rpg") {
    const label = document.createElement("div");
    label.className = "mode-label";
    label.textContent = "角色 / 世界";
    body.appendChild(label);
    const btn = document.createElement("button");
    btn.className = "mode-action-btn rpg-start";
    btn.textContent = "⚔ 创建角色 / 开始冒险";
    btn.addEventListener("click", () => $("rpg-setup-btn")?.click());
    body.appendChild(btn);
  } else if (mode === "novel") {
    const btn = document.createElement("button");
    btn.className = "mode-action-btn novel-start";
    btn.textContent = "▶ 开始新故事";
    btn.addEventListener("click", () => $("novel-new-story-btn")?.click());
    body.appendChild(btn);
  }
}

function resizeImage(file, size = 64) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext("2d");
        const s  = Math.min(img.width, img.height);
        const ox = (img.width  - s) / 2;
        const oy = (img.height - s) / 2;
        ctx.drawImage(img, ox, oy, s, s, 0, 0, size, size);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// ─── DOM 操作 ────────────────────────────────────────────────────────────────
function appendMessage(role, content, msgIndex = -1) {
  const row = document.createElement("div");
  row.className = `msg-row ${role}`;

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";

  if (role === "user") {
    const editBtn = document.createElement("button");
    editBtn.className = "msg-edit-btn";
    editBtn.title = "重新编辑";
    editBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
    </svg>`;
    editBtn.addEventListener("click", () => editUserMessage(msgIndex, content));
    bubble.textContent = content;
    row.appendChild(editBtn);
    row.appendChild(bubble);
    messagesEl.appendChild(row);
    scrollToBottom();
    return { row, bubble };
  }

  if (role === "assistant") {
    const contentDiv = document.createElement("div");
    contentDiv.className = "msg-content";

    //#260522 Red 历史消息重放：故事模式解析角色卡，小说模式解析选项
    if (state.mode === "rpg") {
      const { charName, mainText, choices } = parseStoryContent(content);

      const av = makeAvatar();
      if (charName) {
        if (!state.storyCharacters[charName]) {
          state.storyCharacters[charName] = { color: charColor(charName), avatar: "" };
        }
        refreshCharAvatar(av, charName);
        av.onclick = () => openCharAvatarUpload(charName);
        const nameLabel = document.createElement("div");
        nameLabel.className = "story-char-name";
        nameLabel.textContent = charName;
        contentDiv.appendChild(nameLabel);
      }
      renderMarkdownBubble(bubble, mainText);
      contentDiv.appendChild(bubble);
      if (choices.length > 0) {
        const choicesDiv = document.createElement("div");
        choicesDiv.className = "story-choices";
        choices.forEach(c => {
          const btn = document.createElement("button");
          btn.className = "story-choice-btn";
          btn.textContent = c.label;
          btn.onclick = () => { userInputEl.value = c.label; autoResizeTextarea(); userInputEl.focus(); };
          choicesDiv.appendChild(btn);
        });
        contentDiv.appendChild(choicesDiv);
      }
      if (content) addMessageActions(contentDiv, () => content);
      row.appendChild(av);
    } else if (state.mode === "novel") {
      contentDiv.appendChild(bubble);        // bubble 先入 DOM，choices 追加在后
      renderNovelChapter(contentDiv, bubble, content);
      if (content) addMessageActions(contentDiv, () => content);
      row.appendChild(makeAvatar());
    } else {
      renderMarkdownBubble(bubble, content);
      row.appendChild(makeAvatar());
      contentDiv.appendChild(bubble);
      if (content) addMessageActions(contentDiv, () => content);
    }
    row.appendChild(contentDiv);
  }

  messagesEl.appendChild(row);
  scrollToBottom();
  return { row, bubble };
}

//260525 Red 通用 toast 提示（短暂显示后自动消失）
function showToast(msg) {
  const el = document.createElement("div");
  el.className = "novel-stage-toast";
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => { el.style.opacity = "1"; el.style.transform = "translateY(0)"; });
  setTimeout(() => {
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 400);
  }, 2200);
}

function showError(msg) {
  const el = document.createElement("div");
  el.className = "msg-error";
  el.textContent = "⚠ " + msg;
  messagesEl.appendChild(el);
  scrollToBottom();
}

//260525 Red 记忆压缩：将旧消息发给 AI 生成摘要，替换 state.messages 前段
function summarizeHistory() {
  if (state.isStreaming) { showToast("请等待当前生成完成"); return; }
  const total = state.messages.length;
  if (total < 8) { showToast("对话太短，无需压缩（至少需要 8 条）"); return; }

  const keepCount = 4;
  const toCompress = state.messages.slice(0, total - keepCount);
  const historyText = toCompress.map(m =>
    (m.role === "user" ? "用户" : "AI") + "：" + m.content
  ).join("\n\n");

  state.summarizing    = true;
  state.summaryKeepFrom = total - keepCount;
  state.isStreaming    = true;
  sendBtn.disabled     = true;
  stopBtn.classList.add("visible");
  $("stream-badge")?.classList.add("active");
  showToast("正在压缩记忆…");

  // 构造一个哑 streamCtx，让 onChatChunk/onChatDone 正常工作
  const dummyBubble  = document.createElement("div");
  const dummyContent = document.createElement("div");
  state.streamCtx = {
    bubble: dummyBubble, content: dummyContent, avatarEl: null,
    ctx: { thinkContent: "", inThinkTag: false, thinkBuffer: "", fullContent: "" },
    usageData: null, renderTimer: null
  };

  const model = state.model || $("model-select").value;
  bridge.sendChat(JSON.stringify({
    provider: state.provider,
    model,
    messages: [
      { role: "system", content: "你是摘要助手。请将以下对话历史压缩为400字以内的摘要，保留关键情节、人物关系和重要信息。直接输出摘要，不加任何前缀。" },
      { role: "user",   content: historyText }
    ],
    temperature: 0.3,
    max_tokens:  600,
    top_p:       1.0,
    frequency_penalty: 0.0,
    presence_penalty:  0.0,
    thinking: false
  }));
}

//260525 Red 摘要生成完成后，替换旧消息并在 UI 中插入分割标记
function applySummary(summary) {
  const kept = state.messages.slice(state.summaryKeepFrom);
  state.messages = [
    { role: "user",      content: "[对话历史摘要]\n" + summary },
    { role: "assistant", content: "好的，我已了解之前的故事背景。" },
    ...kept
  ];
  saveChatHistory();

  // 在 UI 聊天区插入可见分割线，位置为保留消息之前
  const allRows = messagesEl.querySelectorAll(".msg-row");
  const marker = document.createElement("div");
  marker.className = "memory-compressed-marker";
  marker.innerHTML = `<span>记忆已压缩（保留近 ${Math.floor(kept.length / 2)} 轮）</span>`;
  if (allRows.length >= kept.length && allRows.length > 0) {
    allRows[allRows.length - kept.length].before(marker);
  } else {
    messagesEl.prepend(marker);
  }
  showToast("记忆压缩完成，已保留最近 " + Math.floor(kept.length / 2) + " 轮对话");
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function makeWelcome() {
  const div = document.createElement("div");
  div.id = "welcome";
  div.innerHTML = `
    <div class="welcome-icon">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.8" stroke-linecap="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
    </div>
    <h2>开始对话</h2>
    <p>选择左侧的 Provider 和模型，然后在下方输入框发起对话。</p>`;
  return div;
}

function editUserMessage(msgIndex, content) {
  if (state.isStreaming || msgIndex < 0) return;
  state.messages = state.messages.slice(0, msgIndex);
  if (state.messages.length === 0) {
    messagesEl.innerHTML = "";
    messagesEl.appendChild(makeWelcome());
    titlebarTitle.textContent = "Red Studio";
  } else {
    // 260521 Red 懒加载：重渲染时同样只显示最近消息
    renderMessageList(state.messages);
  }
  userInputEl.value = content;
  autoResizeTextarea();
  userInputEl.focus();
}

// ─── 新建对话 ────────────────────────────────────────────────────────────────
//260523 Red 开场白注入：将预设文本作为首条 AI 消息渲染并存入历史
function injectOpeningMessage(text) {
  // 从 welcome 屏切换到对话视图
  messagesEl.innerHTML = "";

  const bubble  = addBubble("ai");
  const content = bubble.querySelector(".bubble-content");
  const textEl  = bubble.querySelector(".bubble-text");

  // 小说模式走 renderNovelChapter，否则直接渲染 markdown
  if (state.mode === "novel") {
    renderNovelChapter(text, bubble, textEl);
  } else {
    textEl.innerHTML = typeof marked !== "undefined" ? marked.parse(text) : text;
  }

  // 写入对话历史，后续 AI 可以看到这条开场白
  state.messages.push({ role: "assistant", content: text });
  saveChatHistory();
}

function newChat() {
  if (state.messages.length > 0) saveChatHistory();

  state.messages            = [];
  state.currentChatId       = null;
  state.currentSystemPrompt = "";
  state.storyCharacters     = {};
  state.sessionTokens       = { prompt: 0, completion: 0 };
  updateTokenTotal();
  $("sys-prompt-input").value = "";
  $("sys-prompt-bar").classList.remove("open");
  state.authorNote = "";
  $("author-note-input").value = "";
  $("author-note-bar").classList.remove("open", "active");

  messagesEl.innerHTML = "";
  messagesEl.appendChild(makeWelcome());
  titlebarTitle.textContent = "新建对话";
}

// ─── 历史对话 ────────────────────────────────────────────────────────────────
function saveChatHistory() {
  if (state.messages.length === 0) return;

  const firstUser = state.messages.find(m => m.role === "user");
  const title = firstUser ? firstUser.content.slice(0, 30) : "对话";

  const existing = state.currentChatId !== null
    ? state.chatHistory.find(h => h.id === state.currentChatId)
    : null;

  if (existing) {
    existing.systemPrompt      = state.currentSystemPrompt;
    existing.storyCharacters   = JSON.parse(JSON.stringify(state.storyCharacters));
    existing.mode              = state.mode;
    existing.sessionTokens     = { ...state.sessionTokens };
    existing.novelHeroine      = state.novelHeroine;
    existing.storyCharCardName = state.storyCharCardName;
    existing.novelFav          = state.novelFav;
    existing.novelStage        = state.novelStage;
    existing.novelStages       = state.novelStages.map(s => ({ ...s }));
    existing.novelWordCount    = state.novelWordCount;
    existing.novelPov          = state.novelPov;
    existing.novelHeroName     = state.novelHeroName;
    existing.novelStoryDir     = state.novelStoryDir;
    existing.authorNote        = state.authorNote;
    existing.authorNoteDepth   = state.authorNoteDepth;
    existing.rpgChar           = { ...state.rpgChar };
    existing.rpgStatus         = { ...state.rpgStatus };
    existing.rpgWorldDir       = state.rpgWorldDir;
  } else {
    const newId = state.nextChatId++;
    state.currentChatId = newId;
    state.chatHistory.unshift({
      id:              newId,
      title,
      provider:        state.provider,
      model:           state.model,
      messages:          state.messages,
      mode:              state.mode,
      systemPrompt:      state.currentSystemPrompt,
      storyCharacters:   JSON.parse(JSON.stringify(state.storyCharacters)),
      sessionTokens:     { ...state.sessionTokens },
      novelHeroine:      state.novelHeroine,
      storyCharCardName: state.storyCharCardName,
      novelFav:          state.novelFav,
      novelStage:        state.novelStage,
      novelStages:       state.novelStages.map(s => ({ ...s })),
      novelWordCount:    state.novelWordCount,
      novelPov:          state.novelPov,
      novelStoryDir:     state.novelStoryDir,
      authorNote:        state.authorNote,
      authorNoteDepth:   state.authorNoteDepth,
      rpgChar:           { ...state.rpgChar },
      rpgStatus:         { ...state.rpgStatus },
      rpgWorldDir:       state.rpgWorldDir
    });
  }

  renderHistory();
  // 260521 Red 持久化到桥接（fire-and-forget）
  bridge.saveHistory(JSON.stringify(state.chatHistory.slice(0, 30)));
}

async function loadChatHistory() {
  try {
    const str    = await bridgeCall("getHistory");
    const parsed = JSON.parse(str);
    if (Array.isArray(parsed) && parsed.length > 0) {
      state.chatHistory = parsed;
      state.nextChatId  = (parsed[0]?.id ?? 0) + 1;
      return;
    }
  } catch { /* 静默 */ }
  // 260514 Red 回退：迁移旧 localStorage 数据
  try {
    const raw = localStorage.getItem("redStudioHistory");
    if (raw) {
      const parsed = JSON.parse(raw);
      state.chatHistory = parsed;
      state.nextChatId  = (parsed[0]?.id ?? 0) + 1;
      saveChatHistory();
      localStorage.removeItem("redStudioHistory");
    }
  } catch { }
}

function renderHistory() {
  const items = chatHistory.querySelectorAll(".history-item");
  items.forEach(el => el.remove());

  state.chatHistory.slice(0, 30).forEach(chat => {
    const item = document.createElement("div");
    item.className = "history-item";
    item.dataset.id = chat.id;
    item.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="flex-shrink:0">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
      <span class="history-title">${escapeHtml(chat.title)}</span>`;
    const delBtn = document.createElement("button");
    delBtn.className = "history-delete-btn";
    delBtn.title = "删除";
    delBtn.textContent = "×";
    delBtn.addEventListener("click", e => { e.stopPropagation(); deleteHistory(chat.id); });
    item.appendChild(delBtn);
    item.addEventListener("click", () => loadChat(chat));
    chatHistory.appendChild(item);
  });
}

function loadChat(chat) {
  if (state.isStreaming) return;

  state.messages            = chat.messages;
  state.provider            = chat.provider;
  state.model               = chat.model;
  state.currentChatId       = chat.id;
  state.currentSystemPrompt = chat.systemPrompt    || "";
  state.storyCharacters     = chat.storyCharacters || {};
  state.sessionTokens       = chat.sessionTokens   || { prompt: 0, completion: 0 };
  //#260522 Red 恢复小说模式女明星选择 + 故事模式角色卡选择
  state.novelHeroine        = chat.novelHeroine      || "";
  state.storyCharCardName   = chat.storyCharCardName || "";
  //260523 Red 恢复好感度系统状态
  state.novelFav            = chat.novelFav          ?? 10;
  state.novelStages = Array.isArray(chat.novelStages) && chat.novelStages[0]?.cap
    ? chat.novelStages.map(s => ({ ...s }))
    : [ { name:"陌生人",cap:20, rule:"保持礼貌距离，禁止任何肢体接触、暧昧动作和亲密话语" },
        { name:"相识",  cap:45, rule:"可有日常接触（握手、碰肩），限于普通朋友范畴，禁止暧昧" },
        { name:"朋友",  cap:70, rule:"友好亲近，可自然接触，禁止任何暧昧行为和亲密描写" },
        { name:"暧昧",  cap:90, rule:"可有明显暧昧互动（牵手、对视），禁止成人向描写" },
        { name:"恋人",  cap:100, rule:"可有亲密表达，视剧情自然推进，禁止无铺垫的成人向内容" } ];
  state.novelStage          = chat.novelStage        || novelFavStage(state.novelFav);
  state.novelWordCount      = chat.novelWordCount    || 200;
  state.novelPov            = chat.novelPov          || "second";
  state.novelHeroName       = chat.novelHeroName     || "林然";
  state.novelStoryDir       = chat.novelStoryDir     || "";
  state.authorNote          = chat.authorNote        || "";
  state.authorNoteDepth     = chat.authorNoteDepth   ?? 3;
  if (chat.rpgChar)   state.rpgChar   = { ...state.rpgChar,   ...chat.rpgChar };
  if (chat.rpgStatus) state.rpgStatus = { ...state.rpgStatus, ...chat.rpgStatus };
  state.rpgWorldDir         = chat.rpgWorldDir       || "";
  updateRpgStatusBar();
  updateNovelFavBar();
  updateNovelHeroineTag();
  $("author-note-input").value = state.authorNote;
  $("author-note-depth").value = state.authorNoteDepth;
  $("author-note-bar").classList.toggle("active", state.authorNote.trim().length > 0);
  updateTokenTotal();
  switchMode(chat.mode || "rpg", false);
  populateHeroineSelect();
  populateStoryCharSelect();
  $("sys-prompt-input").value = state.currentSystemPrompt;
  $("sys-prompt-bar").classList.remove("open");

  // 260521 Red 懒加载：只渲染最后 LAZY_LOAD_COUNT 条，其余按需加载
  renderMessageList(chat.messages);
  titlebarTitle.textContent = chat.title.slice(0, 24);

  const sel = $("provider-select");
  if (sel) sel.value = chat.provider;

  if (modelSelect.querySelector(`option[value="${chat.model}"]`)) {
    modelSelect.value = chat.model;
  }

  scrollToBottom();
}

// ─── 设置面板 ────────────────────────────────────────────────────────────────
async function openSettings() {
  const cfg = await fetchConfig(true);
  state.config = cfg;

  renderProviderList();
  closeProviderEdit();
  $("s-temperature").value         = cfg.temperature        ?? 0.7;
  $("s-max-tokens").value          = cfg.max_tokens         ?? 4096;
  $("s-top-p").value               = cfg.top_p              ?? 1.0;
  $("s-frequency-penalty").value   = cfg.frequency_penalty  ?? 0.0;
  $("s-presence-penalty").value    = cfg.presence_penalty   ?? 0.0;

  $("s-ai-name").value = cfg.ai_name || "";
  renderAvatarPreview(cfg.ai_avatar || "", cfg.ai_name || "AI");
  state.pendingAvatar = undefined;

  $("s-tts-engine").value = cfg.tts_engine || "edge";
  $("s-tts-rate").value = cfg.tts_rate ?? 0;
  $("s-mimo-api-key").value = cfg.mimo_api_key || "";
  $("s-ollama-api-key").value = cfg.ollama_api_key || "";
  loadTtsVoices(cfg.tts_engine || "edge", cfg.tts_voice || "");
  $("s-chat-font-size").value = String(cfg.chat_font_size || 14);


  settingsOverlay.classList.add("visible");
}

async function loadTtsVoices(engine = "edge", selectedId = "") {
  //260523 Red 切换引擎时控制 MiMo API Key 行显隐
  const keyRow = $("s-mimo-key-row");
  if (keyRow) keyRow.style.display = engine === "mimo" ? "" : "none";

  const sel = $("s-tts-voice");
  if (!sel) return;
  try {
    const str        = await bridgeCall("ttsVoices", engine);
    const { voices } = JSON.parse(str);
    sel.innerHTML = '<option value="">默认</option>';
    (voices || []).forEach(v => {
      const opt = document.createElement("option");
      opt.value = v.id;
      opt.textContent = v.name;
      if (v.id === selectedId) opt.selected = true;
      sel.appendChild(opt);
    });
  } catch { /* 加载失败时保持默认 */ }
}

function saveSettings() {
  const newConfig = {
    ...state.config,
    temperature:       parseFloat($("s-temperature").value)       || 0.7,
    max_tokens:        parseInt($("s-max-tokens").value)          || 4096,
    top_p:             parseFloat($("s-top-p").value)             ?? 1.0,
    frequency_penalty: parseFloat($("s-frequency-penalty").value) ?? 0.0,
    presence_penalty:  parseFloat($("s-presence-penalty").value)  ?? 0.0,
    ai_name:   $("s-ai-name").value.trim() || "AI",
    ai_avatar: state.pendingAvatar !== undefined
      ? state.pendingAvatar
      : (state.config.ai_avatar || ""),
    tts_engine:    $("s-tts-engine").value,
    tts_voice:     $("s-tts-voice").value,
    tts_rate:      parseInt($("s-tts-rate").value) || 0,
    mimo_api_key:    $("s-mimo-api-key").value.trim(),
    ollama_api_key:  $("s-ollama-api-key").value.trim(),
    chat_font_size: parseInt($("s-chat-font-size").value) || 14,
    providers:      state.config.providers || {},
    provider_order: state.config.provider_order?.length
      ? state.config.provider_order
      : Object.keys(state.config.providers || {}),
    novel_heroines:        state.config.novel_heroines || {},
    story_char_cards:      state.config.story_char_cards || {}
  };

  // 260521 Red 直接调用桥接槽保存，无需等待响应
  bridge.saveConfig(JSON.stringify(newConfig));
  state.config = newConfig;
  applyChatFontSize(newConfig.chat_font_size);
  settingsOverlay.classList.remove("visible");
  loadModels(state.provider);
}

// ─── 供应商管理 ──────────────────────────────────────────────────────────────
let _editingProviderId = null;

function renderProviderList() {
  const listEl = $("s-provider-list");
  if (!listEl) return;
  const providers = state.config.providers || {};
  const order = state.config.provider_order || Object.keys(providers);
  listEl.innerHTML = "";
  order.filter(id => providers[id]).forEach(id => {
    const p = providers[id];
    const item = document.createElement("div");
    item.className = "s-provider-item";
    item.innerHTML = `
      <div class="s-provider-item-info">
        <span class="s-provider-item-name">${p.name || id}</span>
        <span class="s-provider-item-url">${p.base_url || ""}</span>
      </div>
      <div class="s-provider-item-actions">
        <button class="btn-secondary s-prov-edit" data-id="${id}">编辑</button>
        ${id !== "ollama" ? `<button class="btn-secondary s-prov-del" data-id="${id}">删除</button>` : ""}
      </div>`;
    listEl.appendChild(item);
  });
  listEl.querySelectorAll(".s-prov-edit").forEach(b =>
    b.addEventListener("click", () => openProviderEdit(b.dataset.id)));
  listEl.querySelectorAll(".s-prov-del").forEach(b =>
    b.addEventListener("click", () => deleteProviderFromSettings(b.dataset.id)));
}

function openProviderEdit(id) {
  _editingProviderId = id || null;
  const p = id ? (state.config.providers?.[id] || {}) : {};
  $("s-provider-form-title").textContent = id ? "编辑供应商" : "添加供应商";
  $("spe-name").value = p.name || "";
  $("spe-type").value = p.type || "openai-compat";
  $("spe-url").value  = p.base_url || "";
  $("spe-key").value  = "";
  $("s-provider-form").style.display = "block";
  updateSpeKeyRow();
}

function closeProviderEdit() {
  _editingProviderId = null;
  const f = $("s-provider-form");
  if (f) f.style.display = "none";
}

function updateSpeKeyRow() {
  const row = $("spe-key-row");
  if (row) row.style.display = $("spe-type").value === "ollama" ? "none" : "";
}

function saveProviderEdit() {
  const name = $("spe-name").value.trim();
  const type  = $("spe-type").value;
  const url   = $("spe-url").value.trim();
  const key   = $("spe-key").value.trim();
  if (!name || !url) { alert("名称和 Base URL 不能为空"); return; }

  const id = _editingProviderId || name.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "") || "provider_" + Date.now();
  const existing = state.config.providers?.[id] || {};

  const updated = { ...existing, name, type, base_url: url };
  if (type !== "ollama") updated.api_key = key || existing.api_key || "";

  const newProviders = { ...state.config.providers, [id]: updated };
  const newOrder = state.config.provider_order || Object.keys(newProviders);
  if (!newOrder.includes(id)) newOrder.push(id);

  state.config.providers     = newProviders;
  state.config.provider_order = newOrder;

  // 260521 Red 直接调用桥接槽保存
  bridge.saveConfig(JSON.stringify({ ...state.config, providers: newProviders, provider_order: newOrder }));

  closeProviderEdit();
  renderProviderList();
  populateProviderSelect();
}

function deleteProviderFromSettings(id) {
  const name = state.config.providers?.[id]?.name || id;
  if (!confirm(`删除供应商"${name}"？`)) return;

  const newProviders = { ...state.config.providers };
  delete newProviders[id];
  const newOrder = (state.config.provider_order || []).filter(x => x !== id);

  state.config.providers      = newProviders;
  state.config.provider_order = newOrder;

  bridge.saveConfig(JSON.stringify({ ...state.config, providers: newProviders, provider_order: newOrder }));

  renderProviderList();
  populateProviderSelect();

  if (state.provider === id) {
    const first = newOrder[0] || Object.keys(newProviders)[0] || "ollama";
    switchProvider(first);
  }
}

function renderAvatarPreview(avatarUrl, name) {
  const preview = $("s-avatar-preview");
  preview.innerHTML = "";
  if (avatarUrl) {
    const img = document.createElement("img");
    img.src = avatarUrl;
    preview.appendChild(img);
  } else {
    preview.textContent = (name || "AI").charAt(0).toUpperCase();
  }
}

// 260521 Red postConfig 合并后 debounce 800ms 写磁盘，合并高频调用（token 统计、主题等）
let _postConfigTimer = null;
function postConfig(partial) {
  const merged = { ...state.config, ...partial };
  state.config = merged;
  clearTimeout(_postConfigTimer);
  _postConfigTimer = setTimeout(() => bridge.saveConfig(JSON.stringify(merged)), 800);
}

// ─── 主题切换 ────────────────────────────────────────────────────────────────
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  state.theme = theme;
}

function applyChatFontSize(size) {
  document.documentElement.style.setProperty('--chat-font-size', (parseInt(size) || 14) + 'px');
}

function toggleTheme() {
  const cycle = { light: "eye-care", "eye-care": "green", green: "dark", dark: "black", black: "light" };
  const next = cycle[state.theme] || "light";
  applyTheme(next);
  postConfig({ theme: next });
}

// ─── Token 统计 ──────────────────────────────────────────────────────────────
function renderStatsInline() {
  const body = $("stats-inline-body");
  if (!body) return;

  const today = new Date().toISOString().slice(0, 10);
  const d = new Date();
  const dateEl = $("stats-inline-date");
  if (dateEl) dateEl.textContent = `${d.getMonth()+1}/${d.getDate()}`;

  const ds = state.config.daily_stats?.[today] || {};
  const providers = state.config.providers || {};
  const entries = Object.entries(ds);
  const colors = ["#5b8cff", "#ff9f43", "#1dd1a1", "#ff6b81", "#a29bfe", "#f8b739"];

  if (entries.length === 0) {
    body.innerHTML = '<div style="padding:6px 0;color:var(--text-tertiary);font-size:11px">今日暂无数据</div>';
    return;
  }

  const total = entries.reduce((s, [, v]) => s + v.prompt + v.completion, 0);
  const R = 30, CX = 38, CY = 38, STROKE = 14;
  const CIRC = 2 * Math.PI * R;

  let offset = 0;
  const segments = entries.map(([id, v], i) => {
    const t = v.prompt + v.completion;
    const frac = total ? t / total : 0;
    const dash = frac * CIRC;
    const gap  = CIRC - dash;
    const seg = `<circle cx="${CX}" cy="${CY}" r="${R}" fill="none"
      stroke="${colors[i % colors.length]}" stroke-width="${STROKE}"
      stroke-dasharray="${dash.toFixed(2)} ${gap.toFixed(2)}"
      stroke-dashoffset="${(-offset * CIRC + CIRC / 4).toFixed(2)}"
      stroke-linecap="butt"/>`;
    offset += frac;
    return seg;
  });

  const legendItems = entries.map(([id, v], i) => {
    const t = v.prompt + v.completion;
    const name = providers[id]?.name || id;
    return `<div class="stats-inline-legend-item">
      <div class="stats-inline-legend-dot" style="background:${colors[i % colors.length]}"></div>
      <span class="stats-inline-legend-name">${escapeHtml(name)}</span>
      <span class="stats-inline-legend-val">${t >= 1000 ? (t/1000).toFixed(1)+"K" : t}</span>
    </div>`;
  }).join("");

  body.innerHTML = `
    <div id="stats-inline-donut-wrap">
      <svg width="76" height="76" viewBox="0 0 76 76" style="flex-shrink:0">
        <circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="var(--hover-bg)" stroke-width="${STROKE}"/>
        ${segments.join("")}
        <text x="${CX}" y="${CY + 4}" text-anchor="middle" font-size="9" fill="var(--text-tertiary)" font-family="var(--font)">${total >= 1000 ? (total/1000).toFixed(1)+"K" : total}</text>
      </svg>
      <div class="stats-inline-legend">${legendItems}</div>
    </div>`;
}

// ─── 输入框自动高度 ──────────────────────────────────────────────────────────
function autoResizeTextarea() {
  userInputEl.style.height = "22px";
  userInputEl.style.height = Math.min(userInputEl.scrollHeight, 120) + "px";
}

// ─── 工具函数 ────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function showTokenUsage(container, usage) {
  const meta = document.createElement("div");
  meta.className = "msg-meta";
  if (usage && (usage.prompt_tokens != null || usage.completion_tokens != null)) {
    const fmt = n => (n ?? 0).toLocaleString();
    meta.textContent = `↑ ${fmt(usage.prompt_tokens)} · ↓ ${fmt(usage.completion_tokens)} tokens`;
    state.sessionTokens.prompt     += usage.prompt_tokens     ?? 0;
    state.sessionTokens.completion += usage.completion_tokens ?? 0;
    updateTokenTotal();
    const today = new Date().toISOString().slice(0, 10);
    const ds = state.config.daily_stats || {};
    if (!ds[today]) ds[today] = {};
    if (!ds[today][state.provider]) ds[today][state.provider] = { prompt: 0, completion: 0 };
    ds[today][state.provider].prompt     += usage.prompt_tokens     ?? 0;
    ds[today][state.provider].completion += usage.completion_tokens ?? 0;
    state.config.daily_stats = ds;
    postConfig({ daily_stats: ds });
    renderStatsInline();
  } else {
    meta.textContent = "token 用量：–";
  }
  container.appendChild(meta);
}

function updateTokenTotal() {
  const el = $("token-total");
  if (!el) return;
  const { prompt, completion } = state.sessionTokens;
  if (prompt === 0 && completion === 0) { el.textContent = ""; return; }
  el.textContent = `共 ${(prompt + completion).toLocaleString()} tokens`;
}

// ─── 窗口控制 ────────────────────────────────────────────────────────────────
// 260521 Red 直接调用桥接槽，无需 fetch
function windowCmd(action) {
  switch (action) {
    case "close":     bridge.closeWindow();    break;
    case "minimize":  bridge.minimize();       break;
    case "maximize":  bridge.toggleMaximize(); break;
    case "startmove": bridge.startMove();      break;
  }
}

// 260522 Red 窗口缩放由 WM_NCHITTEST 原生处理，JS 无需干预

function setupTitlebarDrag() {
  const titlebar = $("titlebar");
  if (!titlebar) return;
  const RESIZE_MARGIN = 12;

  // 260522 Red 折叠键和交通灯不触发拖拽
  const noDrag = "#traffic-lights, #sidebar-toggle";

  titlebar.addEventListener("mousedown", (e) => {
    if (e.target.closest(noDrag)) return;
    if (e.button !== 0) return;
    // 260522 Red 鼠标在窗口边缘时不触发拖拽
    const w = document.documentElement.clientWidth || 0;
    const h = document.documentElement.clientHeight || 0;
    if (e.clientX < RESIZE_MARGIN || e.clientX > w - RESIZE_MARGIN ||
        e.clientY < RESIZE_MARGIN || e.clientY > h - RESIZE_MARGIN) return;
    bridge.startMove();
  });

  titlebar.addEventListener("dblclick", (e) => {
    if (e.target.closest(noDrag)) return;
    bridge.toggleMaximize();
  });
}

// 260522 Red 侧边栏折叠切换
function toggleSidebar() {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  document.body.classList.toggle("sidebar-collapsed", state.sidebarCollapsed);
  // 持久化到配置
  bridge.saveConfig(JSON.stringify({ sidebar_collapsed: state.sidebarCollapsed }));
}

// ─── 提示词库 ────────────────────────────────────────────────────────────────
function openPromptLib() {
  renderPrompts();
  $("prompts-form").classList.remove("visible");
  $("prompt-title-input").value   = "";
  $("prompt-content-input").value = "";
  $("prompts-overlay").classList.add("visible");
}

function closePromptLib() {
  $("prompts-overlay").classList.remove("visible");
}

function renderPrompts() {
  const list = $("prompts-list");
  list.innerHTML = "";
  if (state.prompts.length === 0) {
    list.innerHTML = '<div class="prompt-empty">暂无提示词，点击"+ 新建"添加</div>';
    return;
  }
  state.prompts.forEach((p, idx) => {
    const item = document.createElement("div");
    item.className = "prompt-item";
    item.innerHTML = `
      <div class="prompt-item-top">
        <span class="prompt-item-title">${escapeHtml(p.title || p.content.slice(0, 24))}</span>
        <div class="prompt-item-actions">
          <button class="prompt-use-btn">使用</button>
          <button class="prompt-del-btn" title="删除">×</button>
        </div>
      </div>
      <div class="prompt-item-preview">${escapeHtml(p.content.slice(0, 60))}${p.content.length > 60 ? "…" : ""}</div>`;
    item.querySelector(".prompt-use-btn").addEventListener("click", () => usePrompt(p.content));
    item.querySelector(".prompt-del-btn").addEventListener("click", () => deletePrompt(idx));
    list.appendChild(item);
  });
}

function usePrompt(content) {
  $("sys-prompt-input").value = content;
  state.currentSystemPrompt   = content;
  $("sys-prompt-bar").classList.add("open");
  closePromptLib();
}

function deletePrompt(idx) {
  state.prompts.splice(idx, 1);
  postConfig({ prompts: state.prompts });
  renderPrompts();
}

function saveNewPrompt() {
  const content = $("prompt-content-input").value.trim();
  if (!content) return;
  const title = $("prompt-title-input").value.trim();
  state.prompts.push({ title, content });
  postConfig({ prompts: state.prompts });
  $("prompts-form").classList.remove("visible");
  $("prompt-title-input").value   = "";
  $("prompt-content-input").value = "";
  renderPrompts();
}

// ─── 小说模式 ─────────────────────────────────────────────────────────────────
//#260522 Red 从 config 构建小说系统提示词（模板 + 男主角设定 + 女明星设定）
//260523 Red 作者注记注入：在 context 靠后位置插入一条 system 消息
function injectAuthorNote(messages) {
  const note = state.authorNote.trim();
  if (!note) return messages;
  const depth = Math.max(1, state.authorNoteDepth || 3);
  const msgs = [...messages];
  // 系统提示词在索引 0，跳过它；其余消息从 1 开始计算插入位置
  const sysOffset = msgs[0]?.role === "system" ? 1 : 0;
  const insertPos = Math.max(sysOffset, msgs.length - depth);
  msgs.splice(insertPos, 0, { role: "system", content: note });
  return msgs;
}

//260525 Red 小说模式每轮状态提醒：好感度+阶段+行为边界+格式要求，插在最后一条消息之前
//紧邻当前输入，AI 注意力最高，防止规则遗忘
function buildNovelTurnReminder() {
  const fav    = state.novelFav;
  const stage  = state.novelStage;
  const stages = state.novelStages;
  const idx    = stages.findIndex(s => s.name === stage);
  const cur    = stages[Math.min(Math.max(idx, 0), stages.length - 1)];
  const behavior = cur?.rule || "遵守当前阶段的行为边界";
  const wc = state.novelWordCount || 200;
  return `【本轮规则核验 — 必须遵守】
好感度：${fav}/100 · 当前阶段：${stage}
当前阶段行为规则：${behavior}
输出要求：①首行【标题】②地点/时间行③正文约${wc}字④末尾完整 [CHOICES]…[/CHOICES] 四选项
禁止：超越当前阶段的亲密行为、成人向描写、省略选项块。`;
}

function injectNovelTurnReminder(messages) {
  const reminder = buildNovelTurnReminder();
  const msgs = [...messages];
  // 插在最后一条消息（当前用户输入）之前，紧邻上下文末尾
  const insertPos = Math.max(0, msgs.length - 1);
  msgs.splice(insertPos, 0, { role: "system", content: reminder });
  return msgs;
}

//260523 Red 好感度阶段映射（按 cap 阈值查找，支持完全自定义）
function novelFavStage(fav) {
  for (const s of state.novelStages) {
    if (fav <= s.cap) return s.name;
  }
  return state.novelStages[state.novelStages.length - 1]?.name || "恋人";
}

//260523 Red 应用好感度变化，更新状态栏
function applyNovelFavDelta(delta) {
  if (delta === 0) return;
  const prevStage = state.novelStage;
  state.novelFav = Math.max(0, Math.min(100, state.novelFav + delta));
  state.novelStage = novelFavStage(state.novelFav);
  updateNovelFavBar();
  showNovelFavFloat(delta);
  if (state.novelStage !== prevStage) {
    showNovelStageToast(state.novelStage);
  }
}

//260526 Red 好感度变化浮动动画
function showNovelFavFloat(delta) {
  const bar = $("novel-status-bar");
  if (!bar) return;
  const el = document.createElement("span");
  el.className = "novel-fav-float" + (delta > 0 ? " pos" : " neg");
  el.textContent = delta > 0 ? `+${delta}` : `${delta}`;
  bar.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 400); }, 1200);
}

//260523 Red 同步状态栏显示
function updateNovelFavBar() {
  const fill    = $("novel-fav-fill");
  const valEl   = $("novel-fav-value");
  const stageEl = $("novel-stage-text");
  if (fill)    fill.style.width = `${state.novelFav}%`;
  if (valEl)   valEl.textContent = state.novelFav;
  if (stageEl) stageEl.textContent = state.novelStage;
}

//260523 Red 阶段升降提示（淡入淡出 toast）
function showNovelStageToast(stage) {
  const toast = document.createElement("div");
  toast.className = "novel-stage-toast";
  toast.textContent = `好感度阶段：${stage}`;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 400);
  }, 2000);
}

function buildNovelSystemPrompt() {
  const cfg      = state.config;
  const heroName = (state.novelHeroName || "林然").trim();

  //260523 Red 女主角角色卡
  const heroines = cfg.novel_heroines || {};
  const heroine  = heroines[state.novelHeroine];
  let heroineCard = "";
  if (heroine) {
    const hFields = [
      ["姓名",      heroine.name],
      ["出生日期",  heroine.birth],
      ["身高",      heroine.height],
      ["身材体型",  heroine.figure],
      ["外貌描述",  heroine.appearance],
      ["性格关键词",heroine.personality],
      ["语言风格",  heroine.speech],
      ["爱好",      heroine.hobbies],
      ["出身/身份", heroine.origin],
      ["当前状态",  heroine.schedule],
      ["补充信息",  heroine.extra]
    ];
    const hLines = hFields.filter(([, v]) => v && v.trim()).map(([k, v]) => `${k}：${v.trim()}`);
    heroineCard = `【女主角设定 — ${heroine.name || state.novelHeroine}】\n${hLines.join("\n")}`;
  }

  //260523 Red 故事方向 / 主角背景
  const storyDir = (state.novelStoryDir || "").trim();
  const storySection = storyDir ? `【故事方向 / 主角背景】\n${storyDir}` : "";

  //260523 Red 好感度状态 + 输出格式指令
  const fav       = state.novelFav;
  const stage     = novelFavStage(fav);
  const wordCount = state.novelWordCount || 200;
  const pov       = state.novelPov === "first" ? "第一人称（我/林然）"
                  : state.novelPov === "third" ? "第三人称（他/林然）"
                  : "第二人称（你/林然）";

  //260525 Red 阶段行为边界：使用自定义阶段规则
  const stages     = state.novelStages;
  const stageIdx   = stages.findIndex(s => s.name === stage);
  const cur        = stages[Math.min(Math.max(stageIdx, 0), stages.length - 1)];
  const behaviorRule = cur?.rule || "遵守当前阶段的行为边界";
  const stageTableLines = stages.map((s, i) => {
    const lo = i === 0 ? 0 : stages[i - 1].cap + 1;
    const hi = s.cap;
    const behavior = s.rule || "遵守当前阶段的行为边界";
    const mark = s.name === stage ? " ◀ 当前" : "";
    return `${lo}-${hi} 【${s.name}】：${behavior}${mark}`;
  }).join("\n");

  const formatBlock = `【输出格式（每次严格遵守，不得省略）】
第一行：【本段标题】
第二行：📍地点 · 🕐时间 · 天气
空一行，正文约${wordCount}字，${pov}叙事，自然推进剧情。
空一行，输出选项块：

[CHOICES]
A|+N|选项文本
B|+N|选项文本
C|+N|选项文本
D|+N|选项文本
[/CHOICES]

若玩家自由输入而非选项，回复末尾追加：[FAV:+N]（N为-2到+5的整数）

【好感度与行为边界（严格遵守，不得超越当前阶段）】
当前：${fav}/100 · 阶段：${stage}
${stageTableLines}
每个选项的好感变化限定在 -2 到 +5 之间。
当前阶段规则：${behaviorRule}。禁止出现超越此阶段的亲密行为、成人向描写或人物情感跨越。`;

  //260523 Red 用户在系统提示词栏手动输入的内容（骨架/额外设定）一并附加
  const manualExtra = state.currentSystemPrompt.trim();

  const autoBase = `你是一部互动小说的写手，负责推进故事，扮演除${heroName}以外的所有角色。`;
  return [autoBase, storySection, heroineCard, formatBlock, manualExtra].filter(Boolean).join("\n\n");
}

//260523 Red 解析小说 AI 回复：提取正文、[CHOICES] 块（含好感变化）、[FAV:N] 标签
function parseNovelContent(text) {
  let mainText = text;
  const choices = [];
  let favDelta = 0;

  // 主格式：[CHOICES]...[/CHOICES]
  const choicesMatch = mainText.match(/\[CHOICES\]([\s\S]*?)\[\/CHOICES\]/);
  if (choicesMatch) {
    mainText = mainText.slice(0, choicesMatch.index).trimEnd();
    for (const line of choicesMatch[1].trim().split("\n")) {
      const parts = line.trim().split("|");
      if (parts.length >= 3) {
        const label = parts[0].trim();
        const delta = Math.max(-2, Math.min(5, parseInt(parts[1]) || 0));
        const choiceText = parts.slice(2).join("|").trim();
        if (label && choiceText) choices.push({ label, delta, text: choiceText });
      }
    }
  }

  // 自由输入响应的好感标签
  const favMatch = mainText.match(/\[FAV:([+-]?\d+)\]/);
  if (favMatch) {
    favDelta = Math.max(-2, Math.min(5, parseInt(favMatch[1]) || 0));
    mainText = mainText.replace(favMatch[0], "").trim();
  }

  // 兼容旧格式：1. 2. 3. 4. 编号选项
  if (choices.length === 0) {
    const lines = mainText.split("\n");
    const idx = new Set();
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^([1-4])[.、．]\s*(.+)$/);
      if (m) { choices.push({ label: m[1], delta: 0, text: m[2].trim() }); idx.add(i); }
    }
    if (choices.length >= 2) {
      mainText = lines.filter((_, i) => !idx.has(i)).join("\n").trimEnd();
    } else {
      choices.length = 0;
    }
  }

  return { mainText, choices, favDelta };
}

//260523 Red 小说章回渲染：正文走 Markdown，选项变按钮（含好感变化徽章）
function renderNovelChapter(content, bubble, text) {
  const { mainText, choices, favDelta } = parseNovelContent(text);

  renderMarkdownBubble(bubble, mainText);

  // 自由输入时应用 AI 给出的好感变化
  if (favDelta !== 0) applyNovelFavDelta(favDelta);

  if (choices.length > 0) {
    const choicesDiv = document.createElement("div");
    choicesDiv.className = "novel-choices";
    choices.forEach(c => {
      const btn = document.createElement("button");
      btn.className = "novel-choice-btn";

      // 好感变化徽章
      const badge = document.createElement("span");
      badge.className = `novel-choice-delta ${c.delta > 0 ? "pos" : c.delta < 0 ? "neg" : "zero"}`;
      badge.textContent = c.delta > 0 ? `+${c.delta}` : `${c.delta}`;
      btn.appendChild(badge);
      btn.appendChild(document.createTextNode(c.text));

      btn.onclick = () => {
        applyNovelFavDelta(c.delta);
        choicesDiv.querySelectorAll(".novel-choice-btn").forEach(b => b.disabled = true);
        btn.classList.add("selected");
        userInputEl.value = c.text;
        autoResizeTextarea();
        setTimeout(() => sendMessage(), 300);
      };
      choicesDiv.appendChild(btn);
    });
    content.appendChild(choicesDiv);
  }
}

//#260522 Red 女主角角色卡 CRUD
let _editingHeroineName = null;

function populateHeroineSelect() {
  const sel = $("heroine-select");
  if (!sel) return;
  const heroines = state.config.novel_heroines || {};
  sel.innerHTML = '<option value="">-- 选择角色 --</option>';
  Object.keys(heroines).forEach(name => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    if (name === state.novelHeroine) opt.selected = true;
    sel.appendChild(opt);
  });
}

function openHeroineCard(name) {
  _editingHeroineName = name || null;
  const heroines = state.config.novel_heroines || {};
  const h = name ? (heroines[name] || {}) : {};
  $("heroine-card-title").textContent = name ? `编辑 — ${name}` : "新建角色卡";
  //260523 Red 新建时填入示例默认值，方便直接修改而不用从空白开始
  const isNew = !name;
  $("hc-name").value        = h.name        || (isNew ? "林晓柔" : "");
  $("hc-birth").value       = h.birth       || (isNew ? "2000年3月15日" : "");
  $("hc-height").value      = h.height      || (isNew ? "165cm" : "");
  $("hc-figure").value      = h.figure      || (isNew ? "苗条、纤细、长腿" : "");
  $("hc-appearance").value  = h.appearance  || (isNew ? "长发、杏眼、气质出众" : "");
  $("hc-personality").value = h.personality || (isNew ? "开朗、温柔、有主见" : "");
  $("hc-speech").value      = h.speech      || (isNew ? "说话温和、偶尔毒舌" : "");
  $("hc-hobbies").value     = h.hobbies     || (isNew ? "读书、跑步、做饭" : "");
  $("hc-origin").value      = h.origin      || (isNew ? "大学生、职场新人" : "");
  $("hc-schedule").value    = h.schedule    || "";
  $("hc-extra").value       = h.extra       || "";
  $("hc-opening").value     = h.opening     || "";
  $("hc-delete").style.display = name ? "" : "none";
  $("heroine-card-overlay").classList.add("open");
}

function saveHeroineCard() {
  const name = $("hc-name").value.trim();
  if (!name) { $("hc-name").focus(); return; }

  const heroines = { ...(state.config.novel_heroines || {}) };
  if (_editingHeroineName && _editingHeroineName !== name) {
    delete heroines[_editingHeroineName];
    if (state.novelHeroine === _editingHeroineName) state.novelHeroine = name;
  }

  heroines[name] = {
    name,
    birth:       $("hc-birth").value.trim(),
    height:      $("hc-height").value.trim(),
    figure:      $("hc-figure").value.trim(),
    appearance:  $("hc-appearance").value.trim(),
    personality: $("hc-personality").value.trim(),
    speech:      $("hc-speech").value.trim(),
    hobbies:     $("hc-hobbies").value.trim(),
    origin:      $("hc-origin").value.trim(),
    schedule:    $("hc-schedule").value.trim(),
    extra:       $("hc-extra").value.trim(),
    opening:     $("hc-opening").value.trim()
  };

  state.config.novel_heroines = heroines;
  postConfig({ novel_heroines: heroines });

  if (!state.novelHeroine) state.novelHeroine = name;
  populateHeroineSelect();
  updateNovelHeroineTag();
  $("heroine-card-overlay").classList.remove("open");
}

function deleteHeroineCard() {
  if (!_editingHeroineName) return;
  const heroines = { ...(state.config.novel_heroines || {}) };
  delete heroines[_editingHeroineName];
  if (state.novelHeroine === _editingHeroineName) state.novelHeroine = "";
  state.config.novel_heroines = heroines;
  postConfig({ novel_heroines: heroines });
  populateHeroineSelect();
  updateNovelHeroineTag();
  $("heroine-card-overlay").classList.remove("open");
}

// ─── SillyTavern PNG 角色卡导入 ───────────────────────────────────────────────
//260523 Red 解析 PNG tEXt 块，提取 keyword='chara' 的 base64 JSON
async function parseTavernPng(file) {
  const buf = await file.arrayBuffer();
  const view = new DataView(buf);
  // 校验 PNG 签名
  if (view.getUint32(0) !== 0x89504e47) return null;
  let offset = 8;
  while (offset + 12 <= view.byteLength) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      view.getUint8(offset+4), view.getUint8(offset+5),
      view.getUint8(offset+6), view.getUint8(offset+7)
    );
    if (type === "tEXt" && length > 0) {
      const data = new Uint8Array(buf, offset + 8, length);
      const nullIdx = data.indexOf(0);
      if (nullIdx > 0) {
        const keyword = new TextDecoder().decode(data.slice(0, nullIdx));
        if (keyword === "chara") {
          try {
            const b64 = new TextDecoder("latin1").decode(data.slice(nullIdx + 1));
            return JSON.parse(atob(b64));
          } catch { return null; }
        }
      }
    }
    if (type === "IEND") break;
    offset += 12 + length;
  }
  return null;
}

//260523 Red 将 SillyTavern 字段映射到女主角卡或故事角色卡
function fillHeroineFromTavern(card) {
  $("hc-name").value        = card.name        || "";
  $("hc-appearance").value  = (card.description || "").slice(0, 100);
  $("hc-personality").value = (card.personality || "").slice(0, 100);
  $("hc-speech").value      = "";
  $("hc-hobbies").value     = "";
  $("hc-origin").value      = (card.scenario || "").slice(0, 150);
  $("hc-schedule").value    = "";
  $("hc-extra").value       = (card.creator_notes || card.system_prompt || "").slice(0, 300);
  //260523 Red SillyTavern first_mes → 开场白
  $("hc-opening").value     = (card.first_mes || "").slice(0, 2000);
}

function fillStoryCharFromTavern(card) {
  $("sc-name").value         = card.name        || "";
  $("sc-appearance").value   = (card.description || "").slice(0, 100);
  $("sc-personality").value  = (card.personality || "").slice(0, 100);
  $("sc-speech").value       = "";
  $("sc-hobbies").value      = "";
  $("sc-relationship").value = "";
  $("sc-background").value   = (card.scenario   || "").slice(0, 300);
  $("sc-extra").value        = (card.creator_notes || card.system_prompt || "").slice(0, 300);
}

// ─── 故事模式角色卡 ───────────────────────────────────────────────────────────
//#260522 Red 将故事模式角色卡内容注入系统提示词（卡片放在手动 prompt 之前）
//260523 Red 解析 [STATUS]...[/STATUS] 块并更新 rpgStatus
function parseRpgStatus(text) {
  const m = text.match(/\[STATUS\]([\s\S]*?)\[\/STATUS\]/);
  if (!m) return text;
  const block = m[1];
  const g = (re) => { const r = block.match(re); return r ? parseInt(r[1]) : null; };
  const s = state.rpgStatus;
  const hp    = block.match(/HP:(\d+)\/(\d+)/);
  const mp    = block.match(/MP:(\d+)\/(\d+)/);
  const lv    = g(/Lv\.(\d+)/);
  const exp   = block.match(/EXP:(\d+)\/(\d+)/);
  const gold  = g(/GOLD:(\d+)/);
  if (hp)   { s.hp = parseInt(hp[1]); s.hpMax = parseInt(hp[2]); }
  if (mp)   { s.mp = parseInt(mp[1]); s.mpMax = parseInt(mp[2]); }
  if (lv !== null)  s.lv = lv;
  if (exp)  { s.exp = parseInt(exp[1]); s.expNext = parseInt(exp[2]); }
  if (gold !== null) s.gold = gold;
  updateRpgStatusBar();
  return text.slice(0, m.index).trimEnd() + text.slice(m.index + m[0].length).trimStart();
}

//260523 Red 同步 RPG 状态栏显示
function updateRpgStatusBar() {
  const s = state.rpgStatus;
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set("rpg-hp-val", s.hp);   set("rpg-hp-max", s.hpMax);
  set("rpg-mp-val", s.mp);   set("rpg-mp-max", s.mpMax);
  set("rpg-lv", s.lv);
  set("rpg-exp-val", s.exp); set("rpg-exp-next", s.expNext);
  set("rpg-gold", s.gold);
  const nameTag = $("rpg-char-name-tag");
  if (nameTag) nameTag.textContent = state.rpgChar.name ? `⚔ ${state.rpgChar.name}` : "";
}

//260523 Red RPG 章节渲染：解析 STATUS + CHOICES，正文走 Markdown
function renderRpgChapter(content, bubble, text) {
  const cleanText = parseRpgStatus(text);
  const { mainText, choices } = parseNovelContent(cleanText);
  renderMarkdownBubble(bubble, mainText);
  if (choices.length > 0) {
    const choicesDiv = document.createElement("div");
    choicesDiv.className = "novel-choices";
    choices.forEach(c => {
      const btn = document.createElement("button");
      btn.className = "novel-choice-btn";
      btn.appendChild(document.createTextNode(c.text));
      btn.onclick = () => {
        choicesDiv.querySelectorAll(".novel-choice-btn").forEach(b => b.disabled = true);
        btn.classList.add("selected");
        userInputEl.value = c.text;
        autoResizeTextarea();
        userInputEl.focus();
      };
      choicesDiv.appendChild(btn);
    });
    content.appendChild(choicesDiv);
  }
}

//260523 Red RPG 系统提示词构建（P5 框架：DM 视角，双轨玩法）
function buildRpgSystemPrompt() {
  const c = state.rpgChar;
  const s = state.rpgStatus;
  const world = (state.rpgWorldDir || "").trim();

  const charLines = [
    c.name        && `姓名：${c.name}`,
    c.class       && `职业：${c.class}`,
    c.background  && `背景：${c.background}`,
    `战斗属性——力量${c.str} 敏捷${c.agi} 智力${c.int} 体质${c.vit}`,
    `社交属性——知识${c.knowledge} 魅力${c.charm} 胆识${c.guts} 亲切${c.kindness} 手艺${c.craft}`,
  ].filter(Boolean).join("\n");

  const statusLine = `HP:${s.hp}/${s.hpMax}  MP:${s.mp}/${s.mpMax}  Lv.${s.lv}  EXP:${s.exp}/${s.expNext}  GOLD:${s.gold}`;

  return `你是一部文字 RPG 游戏的 DM（地下城主），负责生成整个游戏世界和所有 NPC、怪物、事件。玩家扮演以下角色：

【玩家角色】
${charLines}

${world ? `【世界设定】\n${world}\n` : ""}【输出格式（每次严格遵守）】
第一行：【场景标题】
第二行：📍地点 · 🕐时间 · 天气
空一行，正文约200字，第二人称叙事，描述世界和当前事件。

[STATUS]
HP:{当前}/{最大}  MP:{当前}/{最大}  Lv.{等级}  EXP:{当前}/{下一级}  GOLD:{金币}
[/STATUS]

[CHOICES]
A|{类型}|选项文本
B|{类型}|选项文本
C|{类型}|选项文本
D|{类型}|选项文本
[/CHOICES]

选项类型参考：战斗/技能/探索/对话/逃跑/休息
选项解锁条件受社交属性约束（如魅力<3则不显示魅力型选项）

【当前状态】
${statusLine}

【游戏规则】
- HP归零时进入濒死状态，给出最后一次救场机会
- 战斗胜利/探索发现给 EXP，EXP满升级，HP和MP上限提升
- 每次更新后在 [STATUS] 中同步最新数值
- 怪物、NPC、物品、地点全部随机生成，风格契合世界设定
- 双轨叙事：白天/城镇可触发 NPC 社交（好感系统），夜晚/野外触发战斗探索`;
}

function buildChatSystemPrompt() {
  const cards = state.config.story_char_cards || {};
  const card  = cards[state.storyCharCardName];
  let cardBlock = "";
  if (card) {
    const fields = [
      ["姓名",       card.name],
      ["身份/称谓",  card.identity],
      ["外貌",       card.appearance],
      ["性格",       card.personality],
      ["语言风格",   card.speech],
      ["爱好",       card.hobbies],
      ["与主角关系", card.relationship],
      ["背景故事",   card.background],
      ["补充信息",   card.extra],
    ];
    const lines = fields.filter(([, v]) => v && v.trim()).map(([k, v]) => `${k}：${v.trim()}`);
    if (lines.length > 0) {
      cardBlock = `【角色设定 — ${card.name || state.storyCharCardName}】\n${lines.join("\n")}`;
    }
  }
  const manual = state.currentSystemPrompt.trim();
  return [cardBlock, manual].filter(Boolean).join("\n\n");
}

let _editingStoryChar = null;

function populateStoryCharSelect() {
  const sel = $("story-char-select");
  if (!sel) return;
  const cards = state.config.story_char_cards || {};
  sel.innerHTML = '<option value="">-- 选择角色 --</option>';
  Object.keys(cards).forEach(name => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    if (name === state.storyCharCardName) opt.selected = true;
    sel.appendChild(opt);
  });
}

function openStoryCharCard(name) {
  _editingStoryChar = name || null;
  const cards = state.config.story_char_cards || {};
  const c = name ? (cards[name] || {}) : {};
  $("story-char-card-title").textContent = name ? `编辑 — ${name}` : "新建角色卡";
  //260523 Red 新建时填入示例默认值
  const isNew = !name;
  $("sc-name").value         = c.name         || (isNew ? "洛依" : "");
  $("sc-identity").value     = c.identity     || (isNew ? "猫耳女仆" : "");
  $("sc-appearance").value   = c.appearance   || (isNew ? "银发、紫眸、猫耳" : "");
  $("sc-personality").value  = c.personality  || (isNew ? "傲娇、温柔" : "");
  $("sc-speech").value       = c.speech       || (isNew ? "自称「本小姐」、句末加「喵」" : "");
  $("sc-hobbies").value      = c.hobbies      || (isNew ? "读书、弹琴" : "");
  $("sc-relationship").value = c.relationship || (isNew ? "青梅竹马" : "");
  $("sc-background").value   = c.background   || "";
  $("sc-extra").value        = c.extra        || "";
  $("sc-delete").style.display = name ? "" : "none";
  $("story-char-card-overlay").classList.add("open");
}

function saveStoryCharCard() {
  const name = $("sc-name").value.trim();
  if (!name) { $("sc-name").focus(); return; }

  const cards = { ...(state.config.story_char_cards || {}) };
  if (_editingStoryChar && _editingStoryChar !== name) {
    delete cards[_editingStoryChar];
    if (state.storyCharCardName === _editingStoryChar) state.storyCharCardName = name;
  }

  cards[name] = {
    name,
    identity:     $("sc-identity").value.trim(),
    appearance:   $("sc-appearance").value.trim(),
    personality:  $("sc-personality").value.trim(),
    speech:       $("sc-speech").value.trim(),
    hobbies:      $("sc-hobbies").value.trim(),
    relationship: $("sc-relationship").value.trim(),
    background:   $("sc-background").value.trim(),
    extra:        $("sc-extra").value.trim(),
  };

  state.config.story_char_cards = cards;
  postConfig({ story_char_cards: cards });

  if (!state.storyCharCardName) state.storyCharCardName = name;
  populateStoryCharSelect();
  const scSel = $("story-char-select");
  if (scSel) scSel.value = state.storyCharCardName;
  $("story-char-card-overlay").classList.remove("open");
}

function deleteStoryCharCard() {
  if (!_editingStoryChar) return;
  const cards = { ...(state.config.story_char_cards || {}) };
  delete cards[_editingStoryChar];
  if (state.storyCharCardName === _editingStoryChar) state.storyCharCardName = "";
  state.config.story_char_cards = cards;
  postConfig({ story_char_cards: cards });
  populateStoryCharSelect();
  $("story-char-card-overlay").classList.remove("open");
}

// ─── 角色库 ──────────────────────────────────────────────────────────────────
let _charlibTab = "novel"; // "novel" | "story"

//260526 Red 渲染快速预设到 overlay #presets-grid
function renderPresets() {
  const grid = $("presets-grid");
  if (!grid) return;
  grid.innerHTML = "";
  PRESETS.forEach(preset => {
    const btn = document.createElement("button");
    btn.className = "preset-btn" + (state.activePreset === preset.id ? " active" : "");
    btn.textContent = preset.name;
    btn.title = preset.mode === "novel" ? "小说模式" : "RPG 模式";
    btn.addEventListener("click", () => {
      applyPreset(preset);
      $("presets-overlay").classList.remove("open");
    });
    grid.appendChild(btn);
  });
}

//260526 Red 应用预设：切换模式、注入场景提示词
function applyPreset(preset) {
  switchMode(preset.mode);
  if (preset.sysPrompt) {
    const inp = $("sys-prompt-input");
    if (inp) { inp.value = preset.sysPrompt; autoResizeTextarea(inp); }
    state.currentSystemPrompt = preset.sysPrompt;
  }
  state.activePreset = preset.id;
  renderPresets();
}

function openCharLib() {
  renderCharLib();
  $("charlib-overlay").classList.add("open");
}

function renderCharLib() {
  const list = $("charlib-list");
  list.innerHTML = "";
  if (_charlibTab === "novel") {
    const heroines = state.config.novel_heroines || {};
    const names = Object.keys(heroines);
    if (!names.length) {
      list.innerHTML = '<div class="charlib-empty">还没有小说角色，点击「新建」创建</div>';
      return;
    }
    names.forEach(name => {
      const h = heroines[name];
      const item = document.createElement("div");
      item.className = "charlib-item" + (name === state.novelHeroine ? " selected" : "");
      item.innerHTML = `
        <span class="charlib-item-name">${name}</span>
        <span class="charlib-item-sub">${h.personality || ""}</span>
        <button class="charlib-item-edit">编辑</button>`;
      // 点击行 = 选用该角色
      item.addEventListener("click", () => {
        state.novelHeroine = name;
        updateNovelHeroineTag();
        $("charlib-overlay").classList.remove("open");
      });
      item.querySelector(".charlib-item-edit").addEventListener("click", e => {
        e.stopPropagation();
        $("charlib-overlay").classList.remove("open");
        openHeroineCard(name);
      });
      list.appendChild(item);
    });
  } else {
    const cards = state.config.story_char_cards || {};
    const names = Object.keys(cards);
    if (!names.length) {
      list.innerHTML = '<div class="charlib-empty">还没有聊天角色，点击「新建」创建</div>';
      return;
    }
    names.forEach(name => {
      const c = cards[name];
      const item = document.createElement("div");
      item.className = "charlib-item" + (name === state.storyCharCardName ? " selected" : "");
      item.innerHTML = `
        <span class="charlib-item-name">${name}</span>
        <span class="charlib-item-sub">${c.identity || ""}</span>
        <button class="charlib-item-edit">编辑</button>`;
      // 点击行 = 选用该角色
      item.addEventListener("click", () => {
        state.storyCharCardName = name;
        $("charlib-overlay").classList.remove("open");
      });
      item.querySelector(".charlib-item-edit").addEventListener("click", e => {
        e.stopPropagation();
        $("charlib-overlay").classList.remove("open");
        openStoryCharCard(name);
      });
      list.appendChild(item);
    });
  }
}

function updateNovelHeroineTag() {
  renderModeSection();
}

// ─── 事件绑定 ────────────────────────────────────────────────────────────────
function setupEventListeners() {
  // 交通灯按钮
  $("btn-close")   .addEventListener("click", () => bridge.closeWindow());
  $("btn-minimize").addEventListener("click", () => bridge.minimize());
  $("btn-maximize").addEventListener("click", () => bridge.toggleMaximize());
  $("sidebar-toggle").addEventListener("click", toggleSidebar);

  //260526 Red 预设 overlay
  $("presets-trigger").addEventListener("click", () => {
    renderPresets();
    $("presets-overlay").classList.add("open");
  });
  $("presets-close").addEventListener("click", () => $("presets-overlay").classList.remove("open"));
  $("presets-overlay").addEventListener("click", e => {
    if (e.target === $("presets-overlay")) $("presets-overlay").classList.remove("open");
  });

  $("compress-memory-btn").addEventListener("click", summarizeHistory);
  $("knowledge-btn").addEventListener("click", () => $("knowledge-overlay").classList.add("open"));
  $("knowledge-prompts").addEventListener("click", () => {
    $("knowledge-overlay").classList.remove("open");
    openPromptLib();
  });
  $("knowledge-charlib").addEventListener("click", () => {
    $("knowledge-overlay").classList.remove("open");
    openCharLib();
  });
  $("knowledge-overlay").addEventListener("click", e => {
    if (e.target === $("knowledge-overlay")) $("knowledge-overlay").classList.remove("open");
  });
  $("charlib-close").addEventListener("click", () => $("charlib-overlay").classList.remove("open"));
  $("charlib-overlay").addEventListener("click", e => {
    if (e.target === $("charlib-overlay")) $("charlib-overlay").classList.remove("open");
  });
  document.querySelectorAll(".charlib-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      _charlibTab = tab.dataset.lib;
      document.querySelectorAll(".charlib-tab").forEach(t => t.classList.toggle("active", t === tab));
      renderCharLib();
    });
  });
  $("charlib-new-btn").addEventListener("click", () => {
    $("charlib-overlay").classList.remove("open");
    if (_charlibTab === "novel") openHeroineCard(null);
    else openStoryCharCard(null);
  });
  $("charlib-export-btn").addEventListener("click", async () => {
    const res = JSON.parse(await bridgeCall("exportCharLib"));
    if (res.ok) showNovelStageToast(`已导出：${res.ok.split(/[\\/]/).pop()}`);
  });
  $("charlib-import-btn").addEventListener("click", async () => {
    const res = JSON.parse(await bridgeCall("importCharLib"));
    if (res.ok) {
      const cfgStr = await bridgeCall("getConfig");
      const cfg = JSON.parse(cfgStr);
      state.config.novel_heroines   = cfg.novel_heroines  || {};
      state.config.story_char_cards = cfg.story_char_cards || {};
      renderCharLib();
      showNovelStageToast(`已导入 ${res.imported.length} 个角色`);
    }
  });

  setupTitlebarDrag();

  $("provider-select").addEventListener("change", () => switchProvider($("provider-select").value));

  modelSelect.addEventListener("change", () => {
    state.model = modelSelect.value;
    postConfig({ last_model: state.model });
  });

  $("refresh-models-btn").addEventListener("click", () => loadModels(state.provider));

  $("new-chat-btn").addEventListener("click", newChat);
  sendBtn.addEventListener("click", sendMessage);
  stopBtn.addEventListener("click", stopGeneration);
  $("tts-stop-btn").addEventListener("click", () => {
    if (_ttsBtn) {
      _ttsBtn.classList.remove("speaking");
      _ttsBtn = null;
    }
    bridge.ttsStop();
    _hideTtsStopBtn();
  });

  userInputEl.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  userInputEl.addEventListener("input", autoResizeTextarea);

  $("theme-btn").addEventListener("click", toggleTheme);
  $("export-btn").addEventListener("click", exportChat);

  thinkBtn.addEventListener("click", () => {
    state.thinkingEnabled = !state.thinkingEnabled;
    thinkBtn.classList.toggle("active", state.thinkingEnabled);
    thinkStatus.classList.toggle("visible", state.thinkingEnabled);
  });

  //260523 Red 联网搜索切换
  webBtn.addEventListener("click", () => {
    state.webSearchEnabled = !state.webSearchEnabled;
    webBtn.classList.toggle("active", state.webSearchEnabled);
  });

  $("settings-btn").addEventListener("click", openSettings);
  $("settings-cancel").addEventListener("click", () => settingsOverlay.classList.remove("visible"));
  $("settings-save").addEventListener("click", saveSettings);

  settingsOverlay.addEventListener("click", e => {
    if (e.target === settingsOverlay) settingsOverlay.classList.remove("visible");
  });

  $("s-add-provider-btn").addEventListener("click", () => openProviderEdit(null));
  $("spe-cancel").addEventListener("click", closeProviderEdit);
  $("spe-save").addEventListener("click", saveProviderEdit);
  $("spe-type").addEventListener("change", updateSpeKeyRow);

  document.querySelectorAll(".mode-tab").forEach(tab => {
    tab.addEventListener("click", () => switchMode(tab.dataset.mode));
  });

  $("sys-prompt-toggle").addEventListener("click", () => {
    $("sys-prompt-bar").classList.toggle("open");
  });
  $("sys-prompt-input").addEventListener("input", () => {
    state.currentSystemPrompt = $("sys-prompt-input").value;
    autoResizeTextarea($("sys-prompt-input"));
  });
  //260523 Red 作者注记
  $("author-note-toggle").addEventListener("click", () => {
    $("author-note-bar").classList.toggle("open");
  });
  $("author-note-input").addEventListener("input", () => {
    state.authorNote = $("author-note-input").value;
    $("author-note-bar").classList.toggle("active", state.authorNote.trim().length > 0);
  });
  $("author-note-depth").addEventListener("input", () => {
    state.authorNoteDepth = parseInt($("author-note-depth").value) || 3;
  });

  $("char-avatar-input").addEventListener("change", async (e) => {
    e.target.value = "";
  });

  $("s-avatar-btn").addEventListener("click", () => $("s-avatar-input").click());
  $("s-avatar-preview").addEventListener("click", () => $("s-avatar-input").click());
  $("s-avatar-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const dataUrl = await resizeImage(file, 64);
    state.pendingAvatar = dataUrl;
    renderAvatarPreview(dataUrl, $("s-ai-name").value || "AI");
    e.target.value = "";
  });
  $("s-avatar-clear").addEventListener("click", () => {
    state.pendingAvatar = "";
    renderAvatarPreview("", $("s-ai-name").value || "AI");
  });
  $("s-ai-name").addEventListener("input", () => {
    const hasPendingImg = state.pendingAvatar && state.pendingAvatar.startsWith("data:");
    const hasStoredImg  = state.pendingAvatar === undefined && (state.config.ai_avatar || "");
    if (!hasPendingImg && !hasStoredImg) {
      renderAvatarPreview("", $("s-ai-name").value || "AI");
    }
  });

  // 260521 Red 历史搜索：实时过滤历史列表条目
  $("history-search").addEventListener("input", () => {
    const q = $("history-search").value.trim().toLowerCase();
    chatHistory.querySelectorAll(".history-item").forEach(el => {
      const title = el.querySelector(".history-title")?.textContent.toLowerCase() ?? "";
      el.style.display = (!q || title.includes(q)) ? "" : "none";
    });
  });

  //#260522 Red 故事模式：角色卡选择 + 面板事件
  //260523 Red RPG 角色创建面板
  $("rpg-setup-btn").addEventListener("click", () => {
    const c = state.rpgChar;
    $("rpg-world-dir").value   = state.rpgWorldDir;
    $("rpg-char-name").value   = c.name;
    $("rpg-char-class").value  = c.class || "";
    $("rpg-char-bg").value     = c.background;
    $("rpg-str").value = c.str; $("rpg-agi").value = c.agi;
    $("rpg-int").value = c.int; $("rpg-vit").value = c.vit;
    $("rpg-knowledge").value = c.knowledge; $("rpg-charm").value = c.charm;
    $("rpg-guts").value = c.guts; $("rpg-kindness").value = c.kindness;
    $("rpg-craft").value = c.craft;
    $("rpg-setup-overlay").classList.add("open");
  });
  $("rpg-setup-cancel").addEventListener("click", () => $("rpg-setup-overlay").classList.remove("open"));
  $("rpg-setup-confirm").addEventListener("click", () => {
    state.rpgWorldDir = $("rpg-world-dir").value.trim();
    const gi = id => parseInt($(id).value) || 10;
    state.rpgChar = {
      name:       $("rpg-char-name").value.trim(),
      class:      $("rpg-char-class").value,
      background: $("rpg-char-bg").value.trim(),
      str: gi("rpg-str"), agi: gi("rpg-agi"),
      int: gi("rpg-int"), vit: gi("rpg-vit"),
      knowledge: parseInt($("rpg-knowledge").value)||1,
      charm:     parseInt($("rpg-charm").value)||1,
      guts:      parseInt($("rpg-guts").value)||1,
      kindness:  parseInt($("rpg-kindness").value)||1,
      craft:     parseInt($("rpg-craft").value)||1,
    };
    // 根据体质计算初始 HP/MP
    state.rpgStatus = {
      hp: 80 + state.rpgChar.vit * 2,
      hpMax: 80 + state.rpgChar.vit * 2,
      mp: 30 + state.rpgChar.int * 2,
      mpMax: 30 + state.rpgChar.int * 2,
      lv: 1, exp: 0, expNext: 100, gold: 50
    };
    updateRpgStatusBar();
    $("rpg-setup-overlay").classList.remove("open");
  });
  $("sc-cancel").addEventListener("click", () => $("story-char-card-overlay").classList.remove("open"));
  $("sc-save").addEventListener("click", saveStoryCharCard);
  $("sc-delete").addEventListener("click", deleteStoryCharCard);
  //260523 Red 故事模式 PNG 导入
  $("sc-import-png").addEventListener("click", () => $("sc-import-file").click());
  $("sc-import-file").addEventListener("change", async e => {
    const f = e.target.files[0];
    if (!f) return;
    const card = await parseTavernPng(f);
    if (!card) { showError("未找到酒馆角色卡数据，请确认是 SillyTavern 导出的 PNG"); return; }
    fillStoryCharFromTavern(card);
    e.target.value = "";
  });
  $("story-char-card-overlay").addEventListener("click", e => {
    if (e.target === $("story-char-card-overlay")) $("story-char-card-overlay").classList.remove("open");
  });

  //260523 Red 小说模式：角色现在从右上角角色库选择，此处无需绑定 select/add
  //260523 Red 新故事按钮：打开故事设定面板
  $("novel-new-story-btn").addEventListener("click", () => {
    $("ns-hero-name").value    = state.novelHeroName;
    $("ns-story-dir").value    = state.novelStoryDir;
    autoResizeTextarea($("ns-story-dir"));
    $("ns-pov").value          = state.novelPov;
    $("ns-word-count").value   = state.novelWordCount;
    $("ns-start-fav").value = state.novelFav;
    // 回填阶段名称和上限
    const nameInputs = [...document.querySelectorAll(".ns-stage-name")];
    const capInputs  = [...document.querySelectorAll(".ns-stage-cap")];
    const ruleInputs = [...document.querySelectorAll(".ns-stage-rule")];
    state.novelStages.forEach((s, i) => {
      if (nameInputs[i]) nameInputs[i].value = s.name;
      if (capInputs[i])  capInputs[i].value  = i < 4 ? s.cap : "";
      if (ruleInputs[i]) ruleInputs[i].value = s.rule || "";
    });
    $("novel-setup-overlay").classList.add("open");
    // 260523 Red 打开面板时对 textarea 触发一次自动高度
    setTimeout(() => autoResizeTextarea($("ns-story-dir")), 0);
  });
  $("ns-story-dir").addEventListener("input", () => autoResizeTextarea($("ns-story-dir")));
  $("novel-setup-cancel").addEventListener("click", () => {
    $("novel-setup-overlay").classList.remove("open");
  });
  $("novel-setup-confirm").addEventListener("click", () => {
    state.novelHeroName  = $("ns-hero-name").value.trim() || "林然";
    state.novelStoryDir  = $("ns-story-dir").value.trim();
    state.novelPov       = $("ns-pov").value;
    state.novelWordCount = parseInt($("ns-word-count").value) || 200;
    state.novelFav       = parseInt($("ns-start-fav").value) || 0;
    // 读取自定义阶段（名称 + 上限 + 行为规则）
    const names = [...document.querySelectorAll(".ns-stage-name")].map(el => el.value.trim());
    const caps  = [...document.querySelectorAll(".ns-stage-cap")].map(el => parseInt(el.value) || 0);
    const rules = [...document.querySelectorAll(".ns-stage-rule")].map(el => el.value.trim());
    const defaultStages = [
      { name: "陌生人", cap: 20, rule: "保持礼貌距离，禁止任何肢体接触、暧昧动作和亲密话语" },
      { name: "相识",   cap: 45, rule: "可有日常接触（握手、碰肩），限于普通朋友范畴，禁止暧昧" },
      { name: "朋友",   cap: 70, rule: "友好亲近，可自然接触，禁止任何暧昧行为和亲密描写" },
      { name: "暧昧",   cap: 90, rule: "可有明显暧昧互动（牵手、对视），禁止成人向描写" },
      { name: "恋人",   cap: 100, rule: "可有亲密表达，视剧情自然推进，禁止无铺垫的成人向内容" }
    ];
    state.novelStages = defaultStages.map((d, i) => ({
      name: names[i] || d.name,
      cap:  i < 4 ? (caps[i] || d.cap) : 100,
      rule: rules[i] || d.rule
    }));
    // 确保 cap 单调递增
    for (let i = 1; i < 4; i++) {
      if (state.novelStages[i].cap <= state.novelStages[i-1].cap)
        state.novelStages[i].cap = state.novelStages[i-1].cap + 1;
    }
    state.novelStage = novelFavStage(state.novelFav);
    updateNovelFavBar();
    $("novel-setup-overlay").classList.remove("open");

    //260523 Red 开场白：有则开新对话并插入首条 AI 消息
    const heroine = (state.config.novel_heroines || {})[state.novelHeroine];
    const opening = heroine?.opening?.trim();
    if (opening) {
      newChat();
      // 稍等 newChat 清空后再渲染，避免时序问题
      setTimeout(() => injectOpeningMessage(opening), 50);
    }
  });
  $("hc-cancel").addEventListener("click", () => $("heroine-card-overlay").classList.remove("open"));
  $("hc-save").addEventListener("click", saveHeroineCard);
  $("hc-delete").addEventListener("click", deleteHeroineCard);
  //260523 Red 小说模式 PNG 导入
  $("hc-import-png").addEventListener("click", () => $("hc-import-file").click());
  $("hc-import-file").addEventListener("change", async e => {
    const f = e.target.files[0];
    if (!f) return;
    const card = await parseTavernPng(f);
    if (!card) { showError("未找到酒馆角色卡数据，请确认是 SillyTavern 导出的 PNG"); return; }
    fillHeroineFromTavern(card);
    e.target.value = "";
  });
  $("heroine-card-overlay").addEventListener("click", e => {
    if (e.target === $("heroine-card-overlay")) $("heroine-card-overlay").classList.remove("open");
  });

  $("prompts-overlay").addEventListener("click", e => {
    if (e.target === $("prompts-overlay")) closePromptLib();
  });
  $("prompts-add-btn").addEventListener("click", () => {
    $("prompts-form").classList.toggle("visible");
  });
  $("prompt-form-cancel").addEventListener("click", () => {
    $("prompts-form").classList.remove("visible");
    $("prompt-title-input").value   = "";
    $("prompt-content-input").value = "";
  });
  $("prompt-form-save").addEventListener("click", saveNewPrompt);
}

// ─── 启动 ────────────────────────────────────────────────────────────────────
// 260521 Red 等待 QWebChannel 就绪后再初始化，确保 bridge 对象可用
new QWebChannel(qt.webChannelTransport, (channel) => {
  bridge = channel.objects.bridge;

  // 连接信号到处理函数
  bridge.chatChunk.connect(onChatChunk);
  bridge.chatDone.connect(onChatDone);
  bridge.modelsReady.connect(onModelsReady);
  bridge.ttsDone.connect(onTtsDone);
  bridge.ttsError.connect(onTtsError);

  init();
});