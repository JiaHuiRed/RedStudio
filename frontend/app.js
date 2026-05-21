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
  // 260521 Red 直接调用桥接槽，ttsDone 信号会在朗读结束时恢复按钮
  bridge.ttsSpeak(text);
}

// 260521 Red ttsDone 信号处理：朗读结束后自动恢复按钮状态
function onTtsDone() {
  if (_ttsBtn) {
    _ttsBtn.classList.remove("speaking");
    _ttsBtn = null;
  }
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
  // 260514 Red pendingAvatar: 设置面板中待保存的头像 data URL
  pendingAvatar: undefined,
  // 260515 Red 故事模式
  mode: "chat",             // "chat" | "story"
  currentSystemPrompt: "",  // 当前对话的系统提示词
  storyCharacters: {},      // { 角色名: { color, avatar } }
  // 260515 Red Token 统计：当前对话累计消耗
  sessionTokens: { prompt: 0, completion: 0 },
  // 260515 Red 提示词库：[{ title, content }]
  prompts: []
};

// ─── DOM 引用 ───────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const messagesEl      = $("messages");
const userInputEl     = $("user-input");
const sendBtn         = $("send-btn");
const stopBtn         = $("stop-btn");
const thinkBtn        = $("think-btn");
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

  // 260515 Red 恢复上次的模式（对话/故事）
  switchMode(cfg.last_mode || "chat", false);

  // 从桥接加载历史对话
  await loadChatHistory();
  renderHistory();

  renderStatsInline();
  setupEventListeners();
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

  // 添加用户消息
  state.messages.push({ role: "user", content: text });
  appendMessage("user", text, state.messages.length - 1);

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

  // 260521 Red 构造请求并调用桥接槽
  const sysPrompt  = state.currentSystemPrompt.trim();
  const apiMessages = sysPrompt
    ? [{ role: "system", content: sysPrompt }, ...state.messages]
    : state.messages;

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

  const { bubble, content, avatarEl, ctx } = sc;

  // 260521 Red 取消节流定时器（任务1：停止后仍确保 Markdown 最终渲染）
  if (sc.renderTimer) {
    clearTimeout(sc.renderTimer);
    sc.renderTimer = null;
  }

  // 260521 Red 隐藏鲸鱼生成动画
  $("stream-badge")?.classList.remove("active");

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

  // 260515 Red 故事模式：解析角色名、渲染角色头像、添加选项按钮
  if (state.mode === "story" && ctx.fullContent) {
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

// 260515 Red 模式切换：对话 ↔ 故事
function switchMode(mode, save = true) {
  state.mode = mode;
  document.getElementById("content").dataset.mode = mode;

  document.querySelectorAll(".mode-tab").forEach(tab => {
    tab.classList.toggle("active", tab.dataset.mode === mode);
  });

  const bar   = $("sys-prompt-bar");
  const input = $("sys-prompt-input");
  if (bar)   bar.classList.toggle("story-mode", mode === "story");
  if (input) input.placeholder = mode === "story"
    ? "设置故事世界观、角色规则、叙事风格…"
    : "输入系统提示词（可选）…";

  if (save) postConfig({ last_mode: mode });
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

    if (state.mode === "story") {
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

function showError(msg) {
  const el = document.createElement("div");
  el.className = "msg-error";
  el.textContent = "⚠ " + msg;
  messagesEl.appendChild(el);
  scrollToBottom();
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
    existing.systemPrompt    = state.currentSystemPrompt;
    existing.storyCharacters = JSON.parse(JSON.stringify(state.storyCharacters));
    existing.mode            = state.mode;
    existing.sessionTokens   = { ...state.sessionTokens };
  } else {
    const newId = state.nextChatId++;
    state.currentChatId = newId;
    state.chatHistory.unshift({
      id:              newId,
      title,
      provider:        state.provider,
      model:           state.model,
      messages:        state.messages,
      mode:            state.mode,
      systemPrompt:    state.currentSystemPrompt,
      storyCharacters: JSON.parse(JSON.stringify(state.storyCharacters)),
      sessionTokens:   { ...state.sessionTokens }
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
  updateTokenTotal();
  switchMode(chat.mode || "chat", false);
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

  $("s-tts-rate").value = cfg.tts_rate ?? 0;
  loadTtsVoices(cfg.tts_voice || "");
  $("s-chat-font-size").value = String(cfg.chat_font_size || 14);

  settingsOverlay.classList.add("visible");
}

async function loadTtsVoices(selectedId = "") {
  const sel = $("s-tts-voice");
  if (!sel) return;
  try {
    const str      = await bridgeCall("ttsVoices");
    const { voices } = JSON.parse(str);
    sel.innerHTML = '<option value="">系统默认</option>';
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
    tts_voice: $("s-tts-voice").value,
    tts_rate:  parseInt($("s-tts-rate").value) || 0,
    chat_font_size: parseInt($("s-chat-font-size").value) || 14,
    providers:      state.config.providers || {},
    provider_order: state.config.provider_order?.length
      ? state.config.provider_order
      : Object.keys(state.config.providers || {})
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

const RESIZE_MARGIN = 12;
function getResizeEdge(x, y) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  let edge = 0;
  if (x < RESIZE_MARGIN)        edge |= 1;
  if (x > w - RESIZE_MARGIN)    edge |= 2;
  if (y < RESIZE_MARGIN)        edge |= 4;
  if (y > h - RESIZE_MARGIN)    edge |= 8;
  return edge;
}

function setupWindowResize() {
  function edgeCursor(edge) {
    if (edge === 5 || edge === 10) return "nwse-resize";
    if (edge === 6 || edge === 9)  return "nesw-resize";
    if (edge & 3)  return "ew-resize";
    if (edge & 12) return "ns-resize";
    return "";
  }
  let lastCursor = "";
  document.addEventListener("mousemove", (e) => {
    const c = edgeCursor(getResizeEdge(e.clientX, e.clientY));
    if (c !== lastCursor) {
      lastCursor = c;
      document.documentElement.style.cursor = c || "";
    }
  });
  document.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const edge = getResizeEdge(e.clientX, e.clientY);
    if (!edge) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    // 260521 Red 直接调用桥接槽，不再需要 fetch
    bridge.startResize(edge);
  }, true);
}

function setupTitlebarDrag() {
  const titlebar = $("titlebar");
  if (!titlebar) return;

  titlebar.addEventListener("mousedown", (e) => {
    if (e.target.closest("#traffic-lights")) return;
    if (e.button !== 0) return;
    if (getResizeEdge(e.clientX, e.clientY)) return;
    bridge.startMove();
  });

  titlebar.addEventListener("dblclick", (e) => {
    if (e.target.closest("#traffic-lights")) return;
    bridge.toggleMaximize();
  });
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

// ─── 事件绑定 ────────────────────────────────────────────────────────────────
function setupEventListeners() {
  // 交通灯按钮
  $("btn-close")   .addEventListener("click", () => bridge.closeWindow());
  $("btn-minimize").addEventListener("click", () => bridge.minimize());
  $("btn-maximize").addEventListener("click", () => bridge.toggleMaximize());

  setupTitlebarDrag();
  setupWindowResize();

  $("provider-select").addEventListener("change", () => switchProvider($("provider-select").value));

  modelSelect.addEventListener("change", () => {
    state.model = modelSelect.value;
    postConfig({ last_model: state.model });
  });

  $("refresh-models-btn").addEventListener("click", () => loadModels(state.provider));

  $("new-chat-btn").addEventListener("click", newChat);
  sendBtn.addEventListener("click", sendMessage);
  stopBtn.addEventListener("click", stopGeneration);

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

  $("prompts-btn").addEventListener("click", openPromptLib);
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

  init();
});
