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

// ─── 状态 ──────────────────────────────────────────────────────────────────
const state = {
  provider: "ollama",       // 当前选中的 provider
  model: "",                // 当前选中的模型
  messages: [],             // 当前对话的消息列表 [{role, content}]
  chatHistory: [],          // 历史对话列表 [{id, title, provider, model, messages}]
  historyFilter: "all",     //260601 Red 历史过滤：all/rpg/novel
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
  //260601 Red JRPG 模式角色与状态（P5R 五维 + 元素）
  rpgChar: {
    name: "", element: "fire",
    str: 1, mag: 1, spd: 1, def: 1, sta: 1
  },
  rpgStatus: {
    hp: 50, hpMax: 50, mp: 20, mpMax: 20,
    lv: 1, exp: 0, expNext: 100, gold: 50
  },
  //260601 Red 技能系统：装备技能 + 遗忘技能
  rpgSkills: { equipped: [], forgotten: [] },
  //260601 Red rpgWorldDir 已移除，模板固定为 P5R 风格
  // JRPG 模式状态
  jrpgNpcs: [],             // 当前游戏的NPC列表 [{name, role, personality, appearance, body, likes, fav, stage, avatar, element}]
  jrpgSocial: { 德行: 1, 智识: 1, 体魄: 1, 魅力: 1 },  // 社交属性
  jrpgTemplate: "校园异世界",  // 当前使用的JRPG模板名
  novelHeroine: "",         //#260522 Red 当前选中的小说模式女主角名称
  //260523 Red 作者注记
  authorNote:      "",  // 注入 context 靠后位置的临时指令
  authorNoteDepth: 3,   // 插入深度：距末尾消息条数
  //260530 Red novelStages 保留，供新故事设定面板 UI 读写
  novelStages: [
    { name: "陌生人", cap: 20, rule: "保持礼貌距离，禁止任何肢体接触、暧昧动作和亲密话语" },
    { name: "相识",   cap: 45, rule: "可有日常接触（握手、碰肩），限于普通朋友范畴，禁止暧昧" },
    { name: "朋友",   cap: 70, rule: "友好亲近，可自然接触，禁止任何暧昧行为和亲密描写" },
    { name: "暧昧",   cap: 90, rule: "可有明显暧昧互动（牵手、对视），禁止成人向描写" },
    { name: "恋人",   cap: 100, rule: "可有亲密表达，视剧情自然推进，禁止无铺垫的成人向内容" }
  ],
  novelWordCount: 200,      // 每轮正文字数
  novelPov: "third",       // 叙事视角 first/third
  novelHeroName:  "林然",   // 主角名称
  // 260515 Red Token 统计：当前对话累计消耗
  sessionTokens: { prompt: 0, completion: 0 },
  // 260515 Red 提示词库：[{ title, content }]
  prompts: [],
  // 记忆压缩：是否正在执行压缩摘要调用
  summarizing: false,
  summaryKeepFrom: 0,
  // 当前选中的模板名
  activeTemplate: null
};

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
  renderTemplateSelect();  // 填充新故事模板列表

  // 260522 Red 恢复侧边栏折叠状态
  state.sidebarCollapsed = !!cfg.sidebar_collapsed;
  if (state.sidebarCollapsed) {
    document.body.classList.add("sidebar-collapsed");
  }

  setupEventListeners();
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

  //#260522 Red 构造请求：小说模式自动构建，JRPG模式使用模板化提示词，其余使用手动输入
  //260601 Red buildJrpgSystemPrompt 内部已拼接 currentSystemPrompt，不再外层重复
  const sysPrompt = state.mode === "novel"
    ? buildNovelSystemPrompt()
    : state.mode === "rpg"
      ? buildJrpgSystemPrompt()
      : state.currentSystemPrompt.trim();
  const baseMessages = sysPrompt
    ? [{ role: "system", content: sysPrompt }, ...state.messages]
    : [...state.messages];
  //260523 Red 注入作者注记：插在距末尾 depth 条位置，AI 对靠近当前输入的内容注意力更高
  let apiMessages = injectAuthorNote(baseMessages);
  //260601 Red 战斗/技能回合自动注入完整技能库
  if (state.mode === "rpg") {
    const lastMsg = state.messages[state.messages.length - 1];
    const userInput = (userInputEl?.value || "").trim();
    const needSkills = (lastMsg?.role === "assistant" && /combat|战斗|技能库|学习新技能/i.test(lastMsg.content || ""))
                    || /装备|学习|替换|遗忘|切换|更换|查看技能/i.test(userInput);
    if (needSkills) {
      apiMessages = injectCombatSkillTable(apiMessages);
    }
  }

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

  //#260522 Red RPG 模式：提取 [角色名] 前缀，渲染名字标签 + 头像
  if (state.mode === "rpg" && ctx.fullContent) {
    const charName = extractCharName(ctx.fullContent);

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
  }

  //#260522 Red 小说模式：解析章回内容，渲染章回分隔线 + 选项按钮
  if (state.mode === "novel" && ctx.fullContent) {
    renderNovelChapter(content, bubble, ctx.fullContent);
    //260530 Red 格式校验：无选项时显示内联警告（支持 [CHOICES]、A-D、1-4 格式）
    const hasChoices = /\[CHOICES\]/i.test(ctx.fullContent)
      || /^[A-Da-d][.、．]\s/m.test(ctx.fullContent)
      || /^[1-4][.、．]\s/m.test(ctx.fullContent);
    if (!hasChoices) {
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
    try { renderRpgChapter(content, bubble, ctx.fullContent); }
    catch(e) { console.error("renderRpgChapter error:", e); }
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

function renderModeSection() {
  const body = $("mode-section-body");
  if (!body) return;
  const mode = state.mode;
  body.innerHTML = "";
  if (mode === "rpg") {
    const label = document.createElement("div");
    label.className = "mode-label";
    label.textContent = "JRPG 角色";
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
      const charName = extractCharName(content);
      const cleanText = parseRpgStatus(content);
      const { mainText, choices } = parseContentBlocks(cleanText);

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
        choicesDiv.className = "novel-choices";
        choices.forEach(c => {
          const btn = document.createElement("button");
          btn.className = "novel-choice-btn";
          btn.textContent = c.text;
          btn.onclick = () => {
            choicesDiv.querySelectorAll(".novel-choice-btn").forEach(b => b.disabled = true);
            btn.classList.add("selected");
            userInputEl.value = c.text;
            autoResizeTextarea();
            setTimeout(() => sendMessage(), 300);
          };
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
  // 重置JRPG状态
  state.jrpgNpcs   = [];
  state.jrpgSocial = { 德行: 1, 智识: 1, 体魄: 1, 魅力: 1 };

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
    existing.novelWordCount    = state.novelWordCount;
    existing.novelPov          = state.novelPov;
    existing.authorNote        = state.authorNote;
    existing.authorNoteDepth   = state.authorNoteDepth;
    existing.rpgChar           = { ...state.rpgChar };
    existing.rpgStatus         = { ...state.rpgStatus };
    existing.jrpgNpcs          = JSON.parse(JSON.stringify(state.jrpgNpcs));
    existing.jrpgSocial        = { ...state.jrpgSocial };
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
      novelWordCount:    state.novelWordCount,
      novelPov:          state.novelPov,
      authorNote:        state.authorNote,
      authorNoteDepth:   state.authorNoteDepth,
      rpgChar:           { ...state.rpgChar },
      rpgStatus:         { ...state.rpgStatus },
      jrpgNpcs:          JSON.parse(JSON.stringify(state.jrpgNpcs)),
      jrpgSocial:        { ...state.jrpgSocial }
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

  //260601 Red 按模式过滤历史
  const filtered = state.chatHistory.filter(chat =>
    state.historyFilter === "all" || chat.mode === state.historyFilter
  );

  filtered.slice(0, 30).forEach(chat => {
    const item = document.createElement("div");
    item.className = "history-item";
    item.dataset.id = chat.id;
    item.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="flex-shrink:0">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
      <span class="history-title">${escapeHtml(chat.title)}</span>
      <span class="history-mode-tag" style="margin-left:auto;font-size:10px;opacity:0.5">${chat.mode === "rpg" ? "JRPG" : chat.mode === "novel" ? "小说" : ""}</span>`;
    const renameBtn = document.createElement("button");
    renameBtn.className = "history-rename-btn";
    renameBtn.title = "重命名";
    renameBtn.textContent = "✎";
    renameBtn.addEventListener("click", e => {
      e.stopPropagation();
      //260530 Red 自定义重命名弹窗替代 window.prompt
      const overlay = $("rename-overlay");
      const input = $("rename-input");
      input.value = chat.title;
      overlay.classList.remove("hidden");
      input.focus();
      input.select();
      const confirm = () => {
        const newTitle = input.value.trim();
        if (newTitle && newTitle !== chat.title) {
          chat.title = newTitle;
          bridge.saveHistory(JSON.stringify(state.chatHistory.slice(0, 30)));
          renderHistory();
        }
        overlay.classList.add("hidden");
      };
      const cancel = () => overlay.classList.add("hidden");
      $("rename-confirm").onclick = confirm;
      $("rename-cancel").onclick = cancel;
      $("rename-close").onclick = cancel;
      input.onkeydown = ev => { if (ev.key === "Enter") confirm(); if (ev.key === "Escape") cancel(); };
    });
    item.appendChild(renameBtn);
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
  state.novelWordCount      = chat.novelWordCount    || 200;
  state.novelPov            = chat.novelPov          || "second";
  state.novelHeroName       = chat.novelHeroName     || "林然";
  state.authorNote          = chat.authorNote        || "";
  state.authorNoteDepth     = chat.authorNoteDepth   ?? 3;
  // 旧存档兼容：过滤 rpgChar 中已废弃的社交属性字段
  if (chat.rpgChar) {
    const { knowledge, charm, guts, kindness, craft, ...cleanRpgChar } = chat.rpgChar;
    state.rpgChar = { ...state.rpgChar, ...cleanRpgChar };
  }
  if (chat.rpgStatus) state.rpgStatus = { ...state.rpgStatus, ...chat.rpgStatus };
  // 恢复JRPG状态
  state.jrpgNpcs            = Array.isArray(chat.jrpgNpcs) ? chat.jrpgNpcs : [];
  state.jrpgSocial          = chat.jrpgSocial || { 德行: 1, 智识: 1, 体魄: 1, 魅力: 1 };
  updateRpgStatusBar();
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
    story_char_cards:      state.config.story_char_cards || {},
    templates:             state.config.templates || {},
    default_hero_name:     state.config.default_hero_name || "林然"
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

// ─── 缩放边缘检测（由 Python _EdgeOverlay 处理，JS 不参与） ──
function setupResizeHandles() {}

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

//260601 Red 战斗回合注入完整技能库
function injectCombatSkillTable(messages) {
  const skillLines = Object.entries(JRPG_SKILLS.reduce((acc, sk) => {
    if (!acc[sk.element]) acc[sk.element] = [];
    acc[sk.element].push(sk);
    return acc;
  }, {})).map(([el, skills]) => {
    const emoji = JRPG_TYPE_CHART[el]?.emoji || "?";
    const name = JRPG_TYPE_CHART[el]?.name || el;
    const byTier = [1,2,3,4].map(t => skills.filter(s => s.tier === t).map(s => `${s.name}(${s.type === "physical" ? "物" : s.type === "magic" ? "魔" : "辅"})`).join("、")).filter(Boolean);
    return `${emoji}${name}：${byTier.join(" | ")}`;
  }).join("\n");
  const table = `【完整技能库（按需参考）】\n${skillLines}\n\n注意：当前仅可装备4个技能，需要更换技能时请通过选项提出。`;
  const msgs = [...messages];
  msgs.splice(msgs.length - 1, 0, { role: "system", content: table });
  return msgs;
}

// 渲染好感阶段表格（动态行数）
function renderNovelStages() {
  const table = $("ns-stages-table");
  if (!table) return;
  table.innerHTML = "";
  state.novelStages.forEach((s, i) => {
    const row = document.createElement("div");
    row.className = "ns-stage-row";
    const isLast = i === state.novelStages.length - 1;
    row.innerHTML = `
      <input class="ns-stage-name" type="text" placeholder="阶段${i+1}名称" value="${s.name}">
      <input class="ns-stage-cap" type="number" placeholder="上限" min="1" max="999" value="${isLast ? 100 : s.cap}">
      <input class="ns-stage-rule" type="text" placeholder="行为约束…" value="${s.rule || ""}">
      ${state.novelStages.length > 2 ? '<button class="ns-stage-del" title="删除此阶段">×</button>' : ""}`;
    if (state.novelStages.length > 2) {
      const delBtn = row.querySelector(".ns-stage-del");
      delBtn.addEventListener("click", () => {
        state.novelStages.splice(i, 1);
        // 确保 cap 递增
        for (let j = 1; j < state.novelStages.length; j++) {
          if (state.novelStages[j].cap <= state.novelStages[j-1].cap)
            state.novelStages[j].cap = state.novelStages[j-1].cap + 1;
        }
        renderNovelStages();
      });
    }
    table.appendChild(row);
  });
}

//260530 Red 通用 toast 通知（导入导出等场景，替代原好感度阶段提示）
function showNovelStageToast(msg) {
  const toast = document.createElement("div");
  toast.className = "novel-stage-toast";
  toast.textContent = msg;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 400);
  }, 2000);
}

function buildNovelSystemPrompt() {
  const cfg      = state.config;
  const heroName = (state.novelHeroName || cfg.default_hero_name || "林然").trim();

  // 从模板获取内容
  const templates = cfg.templates || {};
  const tpl = state.activeTemplate ? templates[state.activeTemplate] : null;
  let templateContent = "";
  if (tpl && tpl.content) {
    templateContent = tpl.content;
    // 替换占位符
    templateContent = templateContent
      .replace(/\{hero_name\}/g, heroName)
      .replace(/\{story_dir\}/g, "无特殊设定")
      .replace(/\{word_count\}/g, String(state.novelWordCount || 200))
      .replace(/\{pov\}/g, state.novelPov === "first" ? "第一人称" : "第三人称");
  }

  // 女主角角色卡（不论有无模板都拼进去）
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

  // 用户在系统提示词栏手动输入的内容
  const manualExtra = state.currentSystemPrompt.trim();

  //260530 Red 不再注入好感度阶段规则（favPrompt 已移除），由用户提示词自行定义
  return [templateContent, heroineCard, manualExtra].filter(Boolean).join("\n\n");
}

// 解析 AI 回复：提取正文、[CHOICES] 块（含好感变化/类型）
function parseContentBlocks(text) {
  let mainText = text;
  const choices = [];

  // 主格式：[CHOICES]...[/CHOICES]
  const choicesMatch = mainText.match(/\[CHOICES\]([\s\S]*?)\[\/CHOICES\]/);
  if (choicesMatch) {
    mainText = mainText.slice(0, choicesMatch.index).trimEnd();
    for (const line of choicesMatch[1].trim().split("\n")) {
      const parts = line.trim().split("|");
      if (parts.length >= 3) {
        const label = parts[0].trim();
        const second = parts[1].trim();
        const choiceText = parts.slice(2).join("|").trim();
        if (label && choiceText) {
          const num = parseInt(second);
          if (!isNaN(num) && second === String(num)) {
            choices.push({ label, delta: Math.max(-2, Math.min(5, num)), type: null, text: choiceText });
          } else {
            choices.push({ label, delta: 0, type: second, text: choiceText });
          }
        }
      }
    }
  }

  //260530 Red 选项解析兼容 A. B. C. D. 和 1. 2. 3. 4. 编号格式
  if (choices.length === 0) {
    const lines = mainText.split("\n");
    const idx = new Set();
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^([A-Da-d])[.、．]\s*(.+)$/)
             || lines[i].match(/^([1-4])[.、．]\s*(.+)$/);
      if (m) { choices.push({ label: m[1].toUpperCase(), delta: 0, type: null, text: m[2].trim() }); idx.add(i); }
    }
    if (choices.length >= 2) {
      mainText = lines.filter((_, i) => !idx.has(i)).join("\n").trimEnd();
    } else {
      choices.length = 0;
    }
  }

  return { mainText, choices };
}

// 提取 [角色名] 前缀（RPG 模式 NPC 对话用）
function extractCharName(text) {
  const m = text.match(/^\[([^\]]{1,24})\]\s*/);
  return m ? m[1] : null;
}

// 解析JRPG好感度标签：[FAV:NPC名±数值]
function parseJrpgFav(text) {
  if (!text || state.jrpgNpcs.length === 0) return [];
  const results = [];
  const regex = /\[FAV:([^\]]+?)([+-]\d+)\]/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const npcName = match[1];
    const delta = parseInt(match[2]);
    const npc = state.jrpgNpcs.find(n => n.name === npcName);
    if (npc) {
      applyJrpgFavDelta(npcName, delta);
      results.push({ name: npcName, delta, newFav: npc.fav, stage: npc.stage });
    }
  }
  return results;
}

//260523 Red 小说章回渲染：正文走 Markdown，选项变按钮
function renderNovelChapter(content, bubble, text) {
  const { mainText, choices } = parseContentBlocks(text);

  renderMarkdownBubble(bubble, mainText);

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
    extra:       $("hc-extra").value.trim()
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
  const oldLv = s.lv;
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
  // 升级通知
  if (s.lv > oldLv) {
    showToast(`🎉 LEVEL UP! Lv.${oldLv} → Lv.${s.lv}  HP/MP上限提升！`);
  }
  updateRpgStatusBar();
  return text.slice(0, m.index).trimEnd() + text.slice(m.index + m[0].length).trimStart();
}

//260523 Red 同步 RPG 状态栏显示
function updateRpgStatusBar() {
  const s = state.rpgStatus;
  const social = state.jrpgSocial;
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set("rpg-hp-val", s.hp);   set("rpg-hp-max", s.hpMax);
  set("rpg-mp-val", s.mp);   set("rpg-mp-max", s.mpMax);
  set("rpg-lv", s.lv);
  set("rpg-exp-val", s.exp); set("rpg-exp-next", s.expNext);
  set("rpg-gold", s.gold);
  // 社交属性
  set("rpg-social-virtue", social.德行);
  set("rpg-social-intel", social.智识);
  set("rpg-social-body", social.体魄);
  set("rpg-social-charm", social.魅力);
  const nameTag = $("rpg-char-name-tag");
  if (nameTag) nameTag.textContent = state.rpgChar.name ? `⚔ ${state.rpgChar.name}` : "";
}

//260523 Red RPG 章节渲染：解析 STATUS + CHOICES，正文走 Markdown，选项自动发送
function renderRpgChapter(content, bubble, text) {
  const cleanText = parseRpgStatus(text);
  parseRpgSkills(cleanText); //260601 Red 解析技能数据
  const { mainText, choices } = parseContentBlocks(cleanText);
  renderMarkdownBubble(bubble, mainText);
  // 解析JRPG好感度变化
  const favResults = parseJrpgFav(cleanText);
  favResults.forEach(r => {
    showToast(`${r.name} 好感度 ${r.delta > 0 ? '+' : ''}${r.delta}（${r.stage}）`);
  });
  //260601 Red 角色卡检测：渲染一键导入按钮
  if (text.includes("【角色卡】")) {
    const cardMatch = text.match(/【角色卡】([\s\S]*?)(?=\n【|$)/);
    if (cardMatch) {
      const cardText = cardMatch[1];
      const nameMatch = cardText.match(/姓名[：:]\s*(.+)/);
      const npcName = nameMatch ? nameMatch[1].trim() : "";
      if (npcName && !state.jrpgNpcs.find(n => n.name === npcName)) {
        const importBtn = document.createElement("button");
        importBtn.className = "novel-choice-btn";
        importBtn.textContent = `📥 导入 ${npcName} 到角色库`;
        importBtn.style.cssText = "margin-top:8px;border-color:var(--accent);color:var(--accent)";
        importBtn.addEventListener("click", () => {
          const roleMatch = cardText.match(/角色[：:]\s*(.+)/);
          const persMatch = cardText.match(/性格[：:]\s*(.+)/);
          const appearMatch = cardText.match(/外貌[：:]\s*(.+)/);
          const bodyMatch = cardText.match(/身材[：:]\s*(.+)/);
          const likesMatch = cardText.match(/爱好[：:]\s*(.+)/);
          const elemMatch = cardText.match(/元素[：:]\s*(.+)/);
          // 从元素名反查 key
          let elementKey = "fire";
          if (elemMatch) {
            const elemName = elemMatch[1].trim();
            const found = Object.entries(JRPG_TYPE_CHART).find(([, v]) => v.name === elemName || v.emoji === elemName);
            if (found) elementKey = found[0];
          }
          const npcData = {
            name: npcName,
            role: roleMatch ? roleMatch[1].trim() : "",
            personality: persMatch ? persMatch[1].trim() : "",
            appearance: appearMatch ? appearMatch[1].trim() : "",
            body: bodyMatch ? bodyMatch[1].trim() : "",
            likes: likesMatch ? likesMatch[1].trim() : "",
            element: elementKey,
            fav: 0, stage: "陌生人"
          };
          const library = { ...(state.config.jrpg_npc_library || {}) };
          library[npcName] = npcData;
          state.config.jrpg_npc_library = library;
          postConfig({ jrpg_npc_library: library });
          importBtn.textContent = `✅ ${npcName} 已导入`;
          importBtn.disabled = true;
          importBtn.style.opacity = "0.5";
          showToast(`${npcName} 已保存到角色库`);
        });
        content.appendChild(importBtn);
      }
    }
  }
  // 从正文中提取敌人属性（用于战斗选项提示）
  const enemyElementMatch = mainText.match(/属性[：:]\s*(\S+)/);
  const enemyElement = enemyElementMatch ? enemyElementMatch[1] : null;
  if (choices.length > 0) {
    const choicesDiv = document.createElement("div");
    choicesDiv.className = "novel-choices";
    choices.forEach(c => {
      const btn = document.createElement("button");
      btn.className = "novel-choice-btn";
      // 如果是战斗选项且有敌人属性，显示克制提示
      let hintText = c.text;
      if (c.type === "combat" && enemyElement) {
        const playerElement = state.jrpgNpcs[0]?.element || "fire";
        const chart = JRPG_TYPE_CHART[playerElement];
        if (chart) {
          const enemyKey = Object.keys(JRPG_TYPE_CHART).find(k => JRPG_TYPE_CHART[k].name === enemyElement);
          if (enemyKey) {
            if (chart.strong.includes(enemyKey)) {
              hintText = `🟢 ${c.text}`;
              btn.title = "效果拔群！（2倍伤害）";
            } else if (chart.weak.includes(enemyKey)) {
              hintText = `🔴 ${c.text}`;
              btn.title = "效果不好（0.5倍伤害）";
            }
          }
        }
      }
      btn.textContent = hintText;
      btn.onclick = () => {
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

// ─── JRPG 模式 ──────────────────────────────────────────────────────────────
// 属性克制表
const JRPG_TYPE_CHART = {
  fire:   { name: "火", emoji: "🔥", strong: ["ice", "wood"],        weak: ["water", "ground"] },
  water:  { name: "水", emoji: "💧", strong: ["fire", "ground"],     weak: ["thunder", "ice", "wood"] },
  ground: { name: "地", emoji: "🌍", strong: ["thunder", "fire"],    weak: ["water", "wind", "wood"] },
  wind:   { name: "风", emoji: "🌪", strong: ["ground", "wood"],     weak: ["ice", "thunder"] },
  ice:    { name: "冰", emoji: "❄️", strong: ["wind", "water", "wood"], weak: ["fire"] },
  thunder:{ name: "雷", emoji: "⚡", strong: ["water", "wind"],      weak: ["ground"] },
  wood:   { name: "木", emoji: "🌳", strong: ["water", "ground"],    weak: ["fire", "ice", "wind"] },
  light:  { name: "光", emoji: "✨", strong: ["dark"],               weak: ["dark"] },
  dark:   { name: "暗", emoji: "🌑", strong: ["light"],              weak: ["light"] },
  omni:   { name: "全", emoji: "💫", strong: [],                     weak: [] }
};

//260601 Red 技能库：10 属性 × 13 技能（5初级/4中级/3高级/1究极）
// type: physical=物理(力), magic=魔法(魔), support=辅助(无伤害)
const JRPG_SKILLS = [
  // ── 火系 ──
  { name:"火焰拳",     element:"fire", type:"physical", tier:1, desc:"附着火焰的拳击" },
  { name:"灼烧",       element:"fire", type:"magic",    tier:1, desc:"发射小型火球" },
  { name:"烈焰斩",     element:"fire", type:"physical", tier:1, desc:"刀刃燃起火焰挥砍" },
  { name:"火焰弹",     element:"fire", type:"magic",    tier:1, desc:"快速发射火弹" },
  { name:"火之庇护",   element:"fire", type:"support",  tier:1, desc:"火焰护盾，提升防御" },
  { name:"烈焰冲击",   element:"fire", type:"physical", tier:2, desc:"全身包裹火焰冲撞" },
  { name:"爆炎波",     element:"fire", type:"magic",    tier:2, desc:"释放环形爆炸火焰" },
  { name:"火焰旋风",   element:"fire", type:"magic",    tier:2, desc:"召唤火焰龙卷风" },
  { name:"熔岩护甲",   element:"fire", type:"support",  tier:2, desc:"熔岩包裹全身，大幅提高防御" },
  { name:"炎帝之怒",   element:"fire", type:"magic",    tier:3, desc:"召唤炎帝之力，烈焰焚天" },
  { name:"灰烬风暴",   element:"fire", type:"magic",    tier:3, desc:"释放毁灭性火焰风暴" },
  { name:"不灭之焰",   element:"fire", type:"support",  tier:3, desc:"火焰环绕，持续回复HP" },
  { name:"超新星爆发", element:"fire", type:"magic",    tier:4, desc:"引爆太阳般的火焰，全体毁灭打击" },
  // ── 水系 ──
  { name:"水弹",       element:"water", type:"magic",    tier:1, desc:"发射高压水弹" },
  { name:"水流斩",     element:"water", type:"physical", tier:1, desc:"水刃切割敌人" },
  { name:"水之护盾",   element:"water", type:"support",  tier:1, desc:"水幕环绕，减少伤害" },
  { name:"溅射",       element:"water", type:"magic",    tier:1, desc:"水花四溅攻击多个目标" },
  { name:"治愈之水",   element:"water", type:"support",  tier:1, desc:"召唤治愈之水回复HP" },
  { name:"激流冲击",   element:"water", type:"physical", tier:2, desc:"操控水流猛力冲击" },
  { name:"冰冻水流",   element:"water", type:"magic",    tier:2, desc:"极寒水流冻结敌人" },
  { name:"潮汐之力",   element:"water", type:"magic",    tier:2, desc:"召唤潮汐冲击全场" },
  { name:"水之祝福",   element:"water", type:"support",  tier:2, desc:"水之力量治愈全队" },
  { name:"海神之怒",   element:"water", type:"magic",    tier:3, desc:"召唤海神之力淹没敌人" },
  { name:"深渊水牢",   element:"water", type:"magic",    tier:3, desc:"水之牢笼困住并持续伤害" },
  { name:"生命之泉",   element:"water", type:"support",  tier:3, desc:"召唤生命之泉，大幅回复全队HP" },
  { name:"世界洪流",   element:"water", type:"magic",    tier:4, desc:"引发全球洪流，全体水属性毁灭打击" },
  // ── 地系 ──
  { name:"岩石投掷",   element:"ground", type:"physical", tier:1, desc:"投掷石块攻击" },
  { name:"地震波",     element:"ground", type:"magic",    tier:1, desc:"释放地面震动波" },
  { name:"土之壁垒",   element:"ground", type:"support",  tier:1, desc:"土墙挡在前方，提高防御" },
  { name:"落石",       element:"ground", type:"magic",    tier:1, desc:"召唤落石砸向敌人" },
  { name:"地裂斩",     element:"ground", type:"physical", tier:1, desc:"劈开地面造成裂缝" },
  { name:"岩浆喷发",   element:"ground", type:"magic",    tier:2, desc:"引发岩浆喷涌" },
  { name:"巨石碾压",   element:"ground", type:"physical", tier:2, desc:"操控巨石碾压敌人" },
  { name:"泥沼陷阱",   element:"ground", type:"support",  tier:2, desc:"制造泥沼降低敌人速度" },
  { name:"山脉之力",   element:"ground", type:"physical", tier:2, desc:"借助山脉之力重击" },
  { name:"大地震颤",   element:"ground", type:"magic",    tier:3, desc:"引发剧烈地震" },
  { name:"陨石坠落",   element:"ground", type:"magic",    tier:3, desc:"召唤陨石从天而降" },
  { name:"不屈之岩",   element:"ground", type:"support",  tier:3, desc:"岩石铠甲，大幅提高防御和HP" },
  { name:"大陆崩裂",   element:"ground", type:"magic",    tier:4, desc:"撕裂大地，全体地属性毁灭打击" },
  // ── 风系 ──
  { name:"风刃",       element:"wind", type:"magic",    tier:1, desc:"释放锋利的风之刃" },
  { name:"疾风斩",     element:"wind", type:"physical", tier:1, desc:"借风速挥出快速斩击" },
  { name:"风之加护",   element:"wind", type:"support",  tier:1, desc:"风之力量提升速度" },
  { name:"旋风",       element:"wind", type:"magic",    tier:1, desc:"制造小型旋风" },
  { name:"气流斩",     element:"wind", type:"physical", tier:1, desc:"压缩气流进行斩击" },
  { name:"真空斩",     element:"wind", type:"physical", tier:2, desc:"真空刃切割一切" },
  { name:"雷暴风云",   element:"wind", type:"magic",    tier:2, desc:"召唤雷暴云攻击" },
  { name:"风之翼",     element:"wind", type:"support",  tier:2, desc:"风之力量大幅提升速度和闪避" },
  { name:"龙卷风",     element:"wind", type:"magic",    tier:2, desc:"召唤强力龙卷风" },
  { name:"天风破",     element:"wind", type:"magic",    tier:3, desc:"操控天风之力轰击" },
  { name:"风暴之眼",   element:"wind", type:"magic",    tier:3, desc:"在风暴中心释放毁灭能量" },
  { name:"苍穹之风",   element:"wind", type:"support",  tier:3, desc:"天空之风治愈并加速全队" },
  { name:"永恒风暴",   element:"wind", type:"magic",    tier:4, desc:"引发永恒风暴，全体风属性毁灭打击" },
  // ── 冰系 ──
  { name:"冰锥",       element:"ice", type:"magic",    tier:1, desc:"发射冰锥刺穿敌人" },
  { name:"寒冰斩",     element:"ice", type:"physical", tier:1, desc:"冰刃挥砍，附带冻结" },
  { name:"冰之壁障",   element:"ice", type:"support",  tier:1, desc:"冰墙阻挡攻击" },
  { name:"霜冻气息",   element:"ice", type:"magic",    tier:1, desc:"吐出寒冰气息" },
  { name:"冰晶碎片",   element:"ice", type:"magic",    tier:1, desc:"发射冰晶碎片群" },
  { name:"冰枪穿刺",   element:"ice", type:"physical", tier:2, desc:"巨型冰枪贯穿敌人" },
  { name:"暴风雪",     element:"ice", type:"magic",    tier:2, desc:"召唤暴风雪席卷" },
  { name:"极寒领域",   element:"ice", type:"support",  tier:2, desc:"制造极寒领域降低敌人速度" },
  { name:"冰封之心",   element:"ice", type:"support",  tier:2, desc:"冰之力量提升魔防" },
  { name:"绝对零度",   element:"ice", type:"magic",    tier:3, desc:"释放绝对零度冻结一切" },
  { name:"冰河崩塌",   element:"ice", type:"magic",    tier:3, desc:"巨型冰河崩塌碾压" },
  { name:"永恒冰封",   element:"ice", type:"support",  tier:3, desc:"冰封状态大幅回复HP" },
  { name:"冰河世纪",   element:"ice", type:"magic",    tier:4, desc:"引发冰河世纪，全体冰属性毁灭打击" },
  // ── 雷系 ──
  { name:"电击",       element:"thunder", type:"magic",    tier:1, desc:"释放电流电击敌人" },
  { name:"雷光斩",     element:"thunder", type:"physical", tier:1, desc:"雷电附着刀刃斩击" },
  { name:"静电护盾",   element:"thunder", type:"support",  tier:1, desc:"静电环绕，反弹部分伤害" },
  { name:"闪电链",     element:"thunder", type:"magic",    tier:1, desc:"连锁闪电攻击" },
  { name:"雷鸣",       element:"thunder", type:"magic",    tier:1, desc:"引发雷鸣震击" },
  { name:"雷霆一击",   element:"thunder", type:"physical", tier:2, desc:"集中雷电于一击" },
  { name:"闪电风暴",   element:"thunder", type:"magic",    tier:2, desc:"召唤闪电风暴" },
  { name:"雷之加速",   element:"thunder", type:"support",  tier:2, desc:"雷电之力大幅提升速度" },
  { name:"连环闪电",   element:"thunder", type:"magic",    tier:2, desc:"连续释放多道闪电" },
  { name:"天雷降临",   element:"thunder", type:"magic",    tier:3, desc:"召唤天雷轰击" },
  { name:"雷神之怒",   element:"thunder", type:"magic",    tier:3, desc:"雷神之力毁灭一切" },
  { name:"雷电领域",   element:"thunder", type:"support",  tier:3, desc:"雷电领域大幅提高全队速度和闪避" },
  { name:"万雷天降",   element:"thunder", type:"magic",    tier:4, desc:"万道天雷降世，全体雷属性毁灭打击" },
  // ── 木系 ──
  { name:"藤鞭",       element:"wood", type:"physical", tier:1, desc:"操控藤蔓抽打" },
  { name:"树叶飞镖",   element:"wood", type:"magic",    tier:1, desc:"发射锋利树叶" },
  { name:"自然治愈",   element:"wood", type:"support",  tier:1, desc:"自然之力回复HP" },
  { name:"花粉散播",   element:"wood", type:"magic",    tier:1, desc:"散播花粉干扰敌人" },
  { name:"树根缠绕",   element:"wood", type:"support",  tier:1, desc:"树根缠绕降低敌人速度" },
  { name:"荆棘之盾",   element:"wood", type:"physical", tier:2, desc:"荆棘包裹的盾牌反击" },
  { name:"毒藤蔓延",   element:"wood", type:"magic",    tier:2, desc:"毒藤持续伤害" },
  { name:"森林之力",   element:"wood", type:"support",  tier:2, desc:"借助森林之力回复全队HP" },
  { name:"巨树冲击",   element:"wood", type:"physical", tier:2, desc:"操控巨树撞击" },
  { name:"世界树之光", element:"wood", type:"support",  tier:3, desc:"世界树之力全队大幅回复" },
  { name:"森林怒吼",   element:"wood", type:"magic",    tier:3, desc:"森林之力化为攻击波" },
  { name:"生命之种",   element:"wood", type:"support",  tier:3, desc:"播撒生命种子持续回复" },
  { name:"世界树觉醒", element:"wood", type:"magic",    tier:4, desc:"世界树觉醒，全体木属性毁灭打击" },
  // ── 光系 ──
  { name:"闪光",       element:"light", type:"magic",    tier:1, desc:"释放光芒灼伤" },
  { name:"光刃",       element:"light", type:"physical", tier:1, desc:"光之刃斩击" },
  { name:"净化之光",   element:"light", type:"support",  tier:1, desc:"净化异常状态" },
  { name:"圣光弹",     element:"light", type:"magic",    tier:1, desc:"发射圣光弹" },
  { name:"光之守护",   element:"light", type:"support",  tier:1, desc:"光之护盾提高魔防" },
  { name:"神圣冲击",   element:"light", type:"physical", tier:2, desc:"神圣力量冲击" },
  { name:"光之牢笼",   element:"light", type:"magic",    tier:2, desc:"光之牢笼困住敌人" },
  { name:"圣光治愈",   element:"light", type:"support",  tier:2, desc:"圣光大幅回复HP" },
  { name:"光之加速",   element:"light", type:"support",  tier:2, desc:"光之力量提升速度和闪避" },
  { name:"神圣制裁",   element:"light", type:"magic",    tier:3, desc:"神圣之力制裁邪恶" },
  { name:"天使之翼",   element:"light", type:"support",  tier:3, desc:"天使降临，全队大幅提升属性" },
  { name:"审判之光",   element:"light", type:"magic",    tier:3, desc:"审判之光净化黑暗" },
  { name:"终极审判",   element:"light", type:"magic",    tier:4, desc:"终极审判降临，全体光属性毁灭打击" },
  // ── 暗系 ──
  { name:"暗影爪",     element:"dark", type:"physical", tier:1, desc:"暗影凝聚为爪攻击" },
  { name:"暗箭",       element:"dark", type:"magic",    tier:1, desc:"发射暗影之箭" },
  { name:"暗之屏障",   element:"dark", type:"support",  tier:1, desc:"暗影屏障降低被命中率" },
  { name:"恐惧之眼",   element:"dark", type:"magic",    tier:1, desc:"释放恐惧压制敌人" },
  { name:"暗影潜行",   element:"dark", type:"support",  tier:1, desc:"暗影中隐匿，提升闪避" },
  { name:"暗影吞噬",   element:"dark", type:"physical", tier:2, desc:"暗影吞噬敌人生命力" },
  { name:"噩梦缠绕",   element:"dark", type:"magic",    tier:2, desc:"噩梦之力持续伤害" },
  { name:"暗之诅咒",   element:"dark", type:"support",  tier:2, desc:"诅咒降低敌人全属性" },
  { name:"灵魂吸取",   element:"dark", type:"magic",    tier:2, desc:"吸取敌人灵魂转化为自身HP" },
  { name:"冥界之门",   element:"dark", type:"magic",    tier:3, desc:"开启冥界之门释放黑暗" },
  { name:"深渊凝视",   element:"dark", type:"magic",    tier:3, desc:"深渊之力凝视敌人" },
  { name:"暗之领域",   element:"dark", type:"support",  tier:3, desc:"暗之领域大幅降低敌人命中和速度" },
  { name:"终焉黑暗",   element:"dark", type:"magic",    tier:4, desc:"终焉黑暗降临，全体暗属性毁灭打击" },
  // ── 全能系 ──
  { name:"全能冲击",   element:"omni", type:"physical", tier:1, desc:"全能之力冲击" },
  { name:"全能弹",     element:"omni", type:"magic",    tier:1, desc:"全能能量弹" },
  { name:"全能屏障",   element:"omni", type:"support",  tier:1, desc:"全能护盾提高全属性防御" },
  { name:"全能治愈",   element:"omni", type:"support",  tier:1, desc:"全能之力回复HP" },
  { name:"全能加速",   element:"omni", type:"support",  tier:1, desc:"全能之力提升速度" },
  { name:"全能爆发",   element:"omni", type:"physical", tier:2, desc:"全能力量集中爆发" },
  { name:"全能风暴",   element:"omni", type:"magic",    tier:2, desc:"全能能量风暴" },
  { name:"全能守护",   element:"omni", type:"support",  tier:2, desc:"全能守护大幅回复全队HP" },
  { name:"全能强化",   element:"omni", type:"support",  tier:2, desc:"全能之力提升全队属性" },
  { name:"全能审判",   element:"omni", type:"magic",    tier:3, desc:"全能审判之力" },
  { name:"全能领域",   element:"omni", type:"support",  tier:3, desc:"全能领域全属性大幅提升" },
  { name:"全能毁灭",   element:"omni", type:"magic",    tier:3, desc:"全能毁灭能量" },
  { name:"万物归一",   element:"omni", type:"magic",    tier:4, desc:"万物归于虚无，终极全能毁灭" },
];

// 随机名字生成器
const JRPG_SURNAMES = ["陈","李","王","张","刘","杨","赵","黄","周","吴","徐","孙","马","朱","胡","林","郭","何","高","罗"];
const JRPG_GIVEN_NAMES = ["思雨","晓萌","月琪","灵","可欣","子涵","雨萱","诗涵","欣怡","紫萱","梦琪","雅琴","若兰","静怡","思琪","佳怡","雪珊","美玲","小燕","丽华"];

// 随机生成一个NPC
function generateRandomNpc() {
  const surname = JRPG_SURNAMES[Math.floor(Math.random() * JRPG_SURNAMES.length)];
  const given = JRPG_GIVEN_NAMES[Math.floor(Math.random() * JRPG_GIVEN_NAMES.length)];
  const names = ["同班同学","邻班同学","学姐","学妹","学生会成员","社团同伴","图书馆偶遇","便利店店员","实习老师"];
  const personalities = ["开朗","内向","温柔","傲娇","冷淡","活泼","文静","直爽","毒舌","天然呆","认真","随性"];
  const appearances = ["长发及腰","短发齐耳","双马尾","单马尾","披肩发","波浪卷","齐刘海","空气刘海","银色长发","黑色长发"];
  const bodies = ["纤细","匀称","健美","娇小","高挑","丰满","苗条","运动型"];
  const likes = ["读书","音乐","运动","游戏","动漫","摄影","绘画","烹饪","旅行","天文"];

  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  const pCount = 2 + Math.floor(Math.random() * 2);
  const personality = Array.from({length: pCount}, () => pick(personalities)).filter((v,i,a) => a.indexOf(v) === i).join("、");
  const bust = ["A","B","B+","C","C+","D"][Math.floor(Math.random() * 6)];
  const legLen = 90 + Math.floor(Math.random() * 25);

  return {
    name: surname + given,
    role: pick(names),
    personality,
    appearance: pick(appearances) + "、" + ["清秀","精致","英气","可爱","冷艳"][Math.floor(Math.random()*5)],
    body: `${pick(bodies)}、胸围${bust}、腿长${legLen}cm`,
    likes: Array.from({length: 2}, () => pick(likes)).filter((v,i,a) => a.indexOf(v) === i).join("、"),
    fav: 0,
    stage: "陌生人",
    avatar: "",
    element: ["fire","water","ground","wind","ice","thunder","wood","light","dark"][Math.floor(Math.random()*9)]
  };
}

// 初始化JRPG游戏：生成NPC列表
function initJrpgGame(savedNpcNames = []) {
  const tpl = (state.config.jrpg_templates || {})[state.jrpgTemplate] || {};
  const saved = state.config.jrpg_npc_library || {};
  let npcs = [];

  //260601 Red NPC 数量从配置读取，默认 5
  const npcCount = tpl.npc_count || 5;

  // 先加入用户保存的NPC
  for (const name of savedNpcNames) {
    if (saved[name]) npcs.push({ ...saved[name], fav: 0, stage: "陌生人" });
  }

  // 全部随机生成补齐
  while (npcs.length < npcCount) {
    npcs.push(generateRandomNpc());
  }

  state.jrpgNpcs = npcs;
  return npcs;
}

// 好感度阶段判定
function jrpgFavStage(fav) {
  const stages = [
    { name: "陌生人", cap: 20 },
    { name: "朋友",   cap: 50 },
    { name: "暧昧",   cap: 80 },
    { name: "恋人",   cap: 100 }
  ];
  for (const s of stages) {
    if (fav <= s.cap) return s.name;
  }
  return "恋人";
}

// 好感度变化（含魅力倍率）
function applyJrpgFavDelta(npcName, delta) {
  const npc = state.jrpgNpcs.find(n => n.name === npcName);
  if (!npc) return;
  const charmMultiplier = 1 + (state.jrpgSocial.魅力 - 5) * 0.1; // 魅力5=1x, 每点+10%
  const finalDelta = Math.round(delta * charmMultiplier);
  npc.fav = Math.max(0, Math.min(100, npc.fav + finalDelta));
  npc.stage = jrpgFavStage(npc.fav);
}

// 保存NPC到角色库
function saveJrpgNpcToLibrary(npc) {
  const library = { ...(state.config.jrpg_npc_library || {}) };
  library[npc.name] = { ...npc };
  delete library[npc.name].fav;
  delete library[npc.name].stage;
  state.config.jrpg_npc_library = library;
  postConfig({ jrpg_npc_library: library });
}

// 从角色库删除NPC
function deleteJrpgNpcFromLibrary(name) {
  const library = { ...(state.config.jrpg_npc_library || {}) };
  delete library[name];
  state.config.jrpg_npc_library = library;
  postConfig({ jrpg_npc_library: library });
}

// 渲染NPC关系面板
//260531 Red NPC 面板渲染：P5R 协力者卡片风格
const ELEMENT_EMOJI = {
  fire:"🔥", water:"💧", ground:"🌍", wind:"🌪",
  ice:"❄️", thunder:"⚡", wood:"🌳", light:"✨", dark:"🌑"
};
const ELEMENT_COLOR = {
  fire:"#e74c3c", water:"#3498db", ground:"#e67e22", wind:"#1abc9c",
  ice:"#9b59b6", thunder:"#f1c40f", wood:"#27ae60", light:"#f5f5dc", dark:"#2c3e50"
};

//260601 Red 技能解析：从 AI 输出中提取 [SKILLS]...[/SKILLS]
function parseRpgSkills(text) {
  const m = text.match(/\[SKILLS\]([\s\S]*?)\[\/SKILLS\]/);
  if (!m) return;
  const lines = m[1].trim().split("\n").filter(Boolean);
  const equipped = [];
  const forgotten = [];
  let section = "equipped";
  for (const line of lines) {
    if (line.includes("遗忘") || line.includes("forgotten")) { section = "forgotten"; continue; }
    const parts = line.split("|").map(s => s.trim());
    if (parts.length >= 2) {
      const entry = { name: parts[0], element: parts[1], type: parts[2] || "magic", desc: parts[3] || "" };
      if (section === "forgotten") forgotten.push(entry);
      else equipped.push(entry);
    }
  }
  state.rpgSkills = { equipped, forgotten };
}

//260601 Red 技能面板渲染
function renderJrpgSkillPanel() {
  const list = $("jrpg-skill-list");
  if (!list) return;
  const { equipped, forgotten } = state.rpgSkills;
  list.innerHTML = "";
  if (equipped.length === 0 && forgotten.length === 0) {
    list.innerHTML = '<div style="font-size:12px;color:var(--text-tertiary);padding:8px;text-align:center">尚未习得技能</div>';
    return;
  }
  // 装备区
  const eqTitle = document.createElement("div");
  eqTitle.className = "jrpg-skill-section-title";
  eqTitle.textContent = `已装备（${equipped.length}/4）`;
  list.appendChild(eqTitle);
  const eqGrid = document.createElement("div");
  eqGrid.className = "jrpg-skill-grid";
  equipped.forEach(sk => {
    const chip = document.createElement("div");
    chip.className = `jrpg-skill-chip ${sk.type}`;
    const emoji = ELEMENT_EMOJI[sk.element] || "❓";
    chip.innerHTML = `${emoji} ${sk.name} <span class="skill-type">${sk.type === "physical" ? "物" : sk.type === "magic" ? "魔" : "辅"}</span>`;
    eqGrid.appendChild(chip);
  });
  for (let i = equipped.length; i < 4; i++) {
    const empty = document.createElement("div");
    empty.className = "jrpg-skill-chip";
    empty.style.opacity = "0.3";
    empty.textContent = "空";
    eqGrid.appendChild(empty);
  }
  list.appendChild(eqGrid);
  // 遗忘区
  if (forgotten.length > 0) {
    const fgTitle = document.createElement("div");
    fgTitle.className = "jrpg-skill-section-title";
    fgTitle.style.marginTop = "6px";
    fgTitle.textContent = `已遗忘（${forgotten.length}）`;
    list.appendChild(fgTitle);
    const fgGrid = document.createElement("div");
    fgGrid.className = "jrpg-skill-grid";
    forgotten.forEach(sk => {
      const chip = document.createElement("div");
      chip.className = `jrpg-skill-chip forgotten`;
      const emoji = ELEMENT_EMOJI[sk.element] || "❓";
      chip.innerHTML = `${emoji} ${sk.name}`;
      fgGrid.appendChild(chip);
    });
    list.appendChild(fgGrid);
  }
}

function renderJrpgNpcPanel() {
  const list = $("jrpg-npc-list");
  if (!list) return;
  list.innerHTML = "";
  if (state.jrpgNpcs.length === 0) {
    list.innerHTML = '<div style="text-align:center;color:var(--text-tertiary);font-size:12px;padding:12px">尚未开始冒险</div>';
    return;
  }
  state.jrpgNpcs.forEach(npc => {
    const item = document.createElement("div");
    item.className = "jrpg-npc-card";
    const color = charColor(npc.name);
    const emoji = ELEMENT_EMOJI[npc.element] || "❓";
    const eleColor = ELEMENT_COLOR[npc.element] || "#888";
    const rank = npc.fav <= 20 ? 1 : npc.fav <= 50 ? 2 : npc.fav <= 80 ? 3 : 4;
    const stageLabel = ["陌生人","朋友","暧昧","恋人"][rank - 1];
    // 性格拆为标签（最多 3 个）
    const tags = (npc.personality || "").split(/[、,，]/).slice(0, 3).filter(Boolean);
    item.innerHTML = `
      <div class="jrpg-card-avatar" style="background:${color}">
        ${npc.name.charAt(0)}
        <span class="jrpg-card-element" style="background:${eleColor}" title="${npc.element}">${emoji}</span>
      </div>
      <div class="jrpg-card-body">
        <div class="jrpg-card-header">
          <div class="jrpg-card-name">${npc.name}</div>
          <div class="jrpg-card-role">${npc.role}</div>
        </div>
        <div class="jrpg-card-tags">
          ${tags.map(t => `<span class="jrpg-tag">${t}</span>`).join("")}
        </div>
        <div class="jrpg-card-fav-row">
          <div class="jrpg-card-fav-track">
            <div class="jrpg-card-fav-fill" style="width:${npc.fav}%;background:${eleColor}"></div>
          </div>
          <span class="jrpg-card-fav-num">${npc.fav}</span>
        </div>
      </div>
      <div class="jrpg-card-rank" style="color:${eleColor}">
        <span class="jrpg-card-rank-num">${rank}</span>
        <span class="jrpg-card-rank-label">${stageLabel}</span>
      </div>
      <button class="jrpg-npc-save-btn" title="保存到角色库">💾</button>
    `;
    item.querySelector(".jrpg-npc-save-btn").addEventListener("click", () => {
      saveJrpgNpcToLibrary(npc);
      showToast(`${npc.name} 已保存到角色库`);
    });
    list.appendChild(item);
  });
}

// 构建JRPG系统提示词
function buildJrpgSystemPrompt() {
  const tpl = (state.config.jrpg_templates || {})[state.jrpgTemplate] || {};
  const c = state.rpgChar;
  const s = state.rpgStatus;
  const social = state.jrpgSocial;
  const npcs = state.jrpgNpcs;

  //260601 Red 系统提示词：P5R 五维属性 + 元素
  const charLines = [
    c.name && `姓名：${c.name}`,
    `元素属性：${JRPG_TYPE_CHART[c.element]?.emoji || "?"}${JRPG_TYPE_CHART[c.element]?.name || c.element}`,
    `战斗属性——力${c.str} 魔${c.mag} 速${c.spd} 防${c.def} 体力${c.sta}`,
    `HP：${s.hp}/${s.hpMax}  MP：${s.mp}/${s.mpMax}  Lv.${s.lv}  EXP：${s.exp}/${s.expNext}  金币：${s.gold}`,
    `社交属性——德行${social.德行} 智识${social.智识} 体魄${social.体魄} 魅力${social.魅力}`,
  ].filter(Boolean).join("\n");

  const statusLine = `HP:${s.hp}/${s.hpMax}  MP:${s.mp}/${s.mpMax}  Lv.${s.lv}  EXP:${s.exp}/${s.expNext}  GOLD:${s.gold}`;

  // NPC列表
  const npcLines = npcs.map(n =>
    `【${n.name}】${n.role}｜${n.personality}｜${n.appearance}｜${n.body}｜爱好：${n.likes}｜属性：${JRPG_TYPE_CHART[n.element]?.emoji || "?"}${JRPG_TYPE_CHART[n.element]?.name || n.element}`
  ).join("\n");

  // 属性克制表
  const typeLines = Object.entries(JRPG_TYPE_CHART)
    .filter(([k]) => k !== "omni")
    .map(([k, v]) => `${v.emoji}${v.name}克${v.strong.map(s => JRPG_TYPE_CHART[s]?.name).join("、")}｜被${v.weak.map(w => JRPG_TYPE_CHART[w]?.emoji + JRPG_TYPE_CHART[w]?.name).join("、")}克`)
    .join("\n");

  //260601 Red 世界设定固定从模板读取
  const world = tpl.world_desc || "";
  const manualExtra = state.currentSystemPrompt.trim();

  return `你是一部 JRPG 文字冒险游戏的 DM（地下城主），负责生成整个游戏世界和所有 NPC、怪物、事件。玩家扮演以下角色：

【玩家角色】
${charLines}

${world ? `【世界设定】\n${world}\n` : ""}【主要角色（5位女角色，玩家可发展感情线）】
${npcLines}

【角色卡输出规则】
当新的可攻略女角色（以上5位之一）首次在剧情中正式登场时，必须在正文之前输出角色卡，格式如下：
【角色卡】
姓名：xxx
角色：xxx（身份定位）
性格：xxx
外貌：xxx
身材：xxx
爱好：xxx
元素：xxx（火/水/地/风/冰/雷/木/光/暗）
每个角色只输出一次角色卡，后续登场不再重复。

【属性克制表】
${typeLines}
效果倍率：克制=2倍伤害，普通=1倍，被克制=0.5倍

【技能系统】
技能分物理（受力加成）、魔法（受魔加成）、辅助（无伤害）三类，每元素13个技能（5初级/4中级/3高级/1究极）。
- 玩家最多装备4个技能，可在战斗中自由切换
- 升级或剧情事件时可从技能库学习新技能
- 超出4个时必须替换一个，被替换的技能进入遗忘列表
- 遗忘列表中的技能可随时找回
- NPC也有各自的元素属性和技能，由你根据角色定位分配
- 战斗中会提供完整的技能库列表供参考

【社交属性效果】
德行${social.德行}：影响NPC信任度和队伍管理选项
智识${social.智识}：影响解谜和知识型对话选项
体魄${social.体魄}：影响物理挑战和战斗选项
魅力${social.魅力}：直接影响好感度获取倍率（当前${(1 + (social.魅力 - 5) * 0.1).toFixed(1)}倍）

【输出格式（每次严格遵守）】
第一行：【场景标题】
第二行：📍地点 · 🕐时间 · 天气
空一行，正文约400字，第二人称叙事，描述世界和当前事件。

[STATUS]
HP:{当前}/{最大}  MP:{当前}/{最大}  Lv.{等级}  EXP:{当前}/{下一级}  GOLD:{金币}
[/STATUS]
仅当 HP/MP/Lv/EXP/GOLD 发生变化时才输出 [STATUS] 块，数值无变化时省略此块。

[SKILLS]
技能名|元素|类型(physical/magic/support)
...
[FORGOTTEN]
技能名|元素|类型
...
[/SKILLS]
玩家技能发生变化时（学习/遗忘/装备变更）才输出 [SKILLS] 块，否则省略。

[CHOICES]
A|{类型}|选项文本
B|{类型}|选项文本
C|{类型}|选项文本
D|{类型}|选项文本
[/CHOICES]

选项类型参考：战斗/技能/探索/对话/逃跑/休息
选项解锁条件受社交属性约束（如智识<3则不显示解谜型选项）

【感情线与成人内容规则】
在与五位女角色的感情线发展中，允许并自然融入色情成人内容，但绝不能影响主线剧情、迷宫探索、战斗和核心事件。
- 未确定恋爱关系前：可进行暧昧互动，详细描写女角色的身材曲线、服装下的诱人部位、肢体接触、呼吸、眼神、香味等感官细节，营造情欲氛围
- 确定恋爱关系后：可根据双方好感度与玩家选择，逐步发展至亲密性行为（包括前戏、性爱过程、事后描写等），尺度随好感度提升自然放开，描写要细腻、色情且具有沉浸感
- 所有成人描写必须基于玩家主动选择或明确同意，尊重角色性格与当前关系阶段
- 成人内容仅限于感情线支线，不可干扰主线任务与世界主剧情

【好感度更新格式】
每轮对话末尾必须输出：
[FAV:NPC名±数值]（原因简述）
示例：[FAV:陈思雨+2]（帮她捡起了掉落的书本）

【当前状态】
${statusLine}

【游戏规则】
- HP归零时进入濒死状态，给出最后一次救场机会
- 战斗胜利/探索发现给 EXP，EXP满升级，HP和MP上限提升
- 每次更新后在 [STATUS] 中同步最新数值
- 属性克制关系：克制2倍伤害，被克制0.5倍伤害
- 白天校园可触发NPC社交（好感系统），夜晚进入心之世界战斗探索
- 与NPC互动时，根据当前好感度阶段调整互动尺度
- 魅力属性越高，好感度获取越多（魅力5=1倍，每点+10%）
${manualExtra ? `\n【玩家自定义指令】\n${manualExtra}` : ""}`;
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

// 渲染模板选择器（新故事面板）
function renderTemplateSelect() {
  const wrap = $("ns-template-select");
  if (!wrap) return;
  const templates = state.config.templates || {};
  const names = Object.keys(templates);
  wrap.innerHTML = "";
  if (names.length === 0) {
    wrap.innerHTML = '<span style="font-size:12px;color:var(--text-tertiary)">暂无模板，请先在设置中创建</span>';
    return;
  }
  names.forEach(name => {
    const btn = document.createElement("button");
    btn.className = "ns-template-btn" + (state.activeTemplate === name ? " active" : "");
    btn.textContent = name;
    btn.addEventListener("click", () => {
      state.activeTemplate = name;
      document.querySelectorAll(".ns-template-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      // 填充模板默认值
      const tpl = templates[name];
      if (tpl) {
        $("ns-hero-name").value = tpl.default_hero || state.config.default_hero_name || "林然";
        $("ns-pov").value = tpl.default_pov || "third";
        $("ns-word-count").value = tpl.default_words || 200;
      }
    });
    wrap.appendChild(btn);
  });
  // 默认选中第一个
  if (names.length > 0) {
    const firstBtn = wrap.querySelector(".ns-template-btn");
    if (firstBtn && !state.activeTemplate) {
      state.activeTemplate = names[0];
      firstBtn.classList.add("active");
      const tpl = templates[names[0]];
      if (tpl) {
        $("ns-hero-name").value = tpl.default_hero || state.config.default_hero_name || "林然";
        $("ns-pov").value = tpl.default_pov || "third";
        $("ns-word-count").value = tpl.default_words || 200;
      }
    }
  }
}

// 渲染模板列表（设置面板内）
function renderTemplateList() {
  const list = $("s-template-list");
  if (!list) return;
  const templates = state.config.templates || {};
  const names = Object.keys(templates);
  list.innerHTML = "";
  if (names.length === 0) {
    list.innerHTML = '<div style="font-size:12px;color:var(--text-tertiary);padding:4px 0">暂无模板，点击"+ 新建模板"添加</div>';
    return;
  }
  names.forEach(name => {
    const t = templates[name];
    const item = document.createElement("div");
    item.className = "s-template-item";
    item.innerHTML = `
      <div class="s-template-item-info">
        <span class="s-template-item-name">${escapeHtml(t.name || name)}</span>
        <span class="s-template-item-preview">${escapeHtml((t.content || "").slice(0, 60))}${(t.content||"").length > 60 ? "…" : ""}</span>
      </div>
      <div class="s-template-item-actions">
        <button class="btn-secondary s-tpl-edit" data-name="${name}">编辑</button>
        <button class="btn-secondary s-tpl-del" data-name="${name}" style="color:var(--danger)">删除</button>
      </div>`;
    list.appendChild(item);
  });
  list.querySelectorAll(".s-tpl-edit").forEach(b =>
    b.addEventListener("click", () => openTemplateForm(b.dataset.name)));
  list.querySelectorAll(".s-tpl-del").forEach(b =>
    b.addEventListener("click", () => deleteTemplate(b.dataset.name)));
}

let _editingTemplate = null;

function openTemplateForm(name) {
  _editingTemplate = name || null;
  const templates = state.config.templates || {};
  const t = name ? (templates[name] || {}) : {};
  $("s-template-form-title").textContent = name ? `编辑模板 — ${name}` : "新建模板";
  $("st-name").value = t.name || "";
  $("st-hero").value = t.default_hero || state.config.default_hero_name || "林然";
  $("st-pov").value = t.default_pov || "second";
  $("st-words").value = t.default_words || 200;
  $("st-fav").checked = t.fav_enabled !== false;
  $("st-content").value = t.content || "";
  $("s-template-form").style.display = "block";
}

function closeTemplateForm() {
  _editingTemplate = null;
  $("s-template-form").style.display = "none";
  $("st-name").value = "";
  $("st-content").value = "";
}

function saveTemplate() {
  const name = $("st-name").value.trim();
  if (!name) { $("st-name").focus(); return; }
  const content = $("st-content").value.trim();
  if (!content) { $("st-content").focus(); return; }

  const templates = { ...(state.config.templates || {}) };
  if (_editingTemplate && _editingTemplate !== name) {
    delete templates[_editingTemplate];
    if (state.activeTemplate === _editingTemplate) state.activeTemplate = name;
  }

  templates[name] = {
    name,
    default_hero: $("st-hero").value.trim() || state.config.default_hero_name || "林然",
    default_pov: $("st-pov").value,
    default_words: parseInt($("st-words").value) || 200,
    fav_enabled: $("st-fav").checked,
    content
  };

  state.config.templates = templates;
  postConfig({ templates });
  closeTemplateForm();
  renderTemplateList();
  renderTemplateSelect();
}

function deleteTemplate(name) {
  if (!confirm(`删除模板"${name}"？`)) return;
  const templates = { ...(state.config.templates || {}) };
  delete templates[name];
  if (state.activeTemplate === name) state.activeTemplate = null;
  state.config.templates = templates;
  postConfig({ templates });
  renderTemplateList();
  renderTemplateSelect();
}

// 渲染预设/模板到 presets overlay
function renderPresets() {
  const grid = $("presets-grid");
  if (!grid) return;
  grid.innerHTML = "";
  const templates = state.config.templates || {};
  const names = Object.keys(templates);
  if (names.length === 0) {
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:16px;color:var(--text-tertiary);font-size:12px">暂无模板，请先在设置中创建</div>';
    return;
  }
  names.forEach(name => {
    const t = templates[name];
    const btn = document.createElement("button");
    btn.className = "preset-btn" + (state.activeTemplate === name ? " active" : "");
    btn.textContent = t.name || name;
    btn.title = "点击开始新故事";
    btn.addEventListener("click", () => {
      state.activeTemplate = name;
      $("presets-overlay").classList.remove("open");
      $("novel-new-story-btn").click();
    });
    grid.appendChild(btn);
  });
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
try {
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
  // 模板管理事件
  $("s-template-add-btn").addEventListener("click", () => openTemplateForm(null));
  $("st-cancel").addEventListener("click", closeTemplateForm);
  $("st-save").addEventListener("click", saveTemplate);

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

  //260601 Red 历史分类过滤
  document.querySelectorAll(".history-filter-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".history-filter-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      state.historyFilter = btn.dataset.filter;
      renderHistory();
    });
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
  //260601 Red 技能面板开关
  $("jrpg-skill-toggle").addEventListener("click", () => {
    const panel = $("jrpg-skill-panel");
    panel.classList.toggle("hidden");
    if (!panel.classList.contains("hidden")) renderJrpgSkillPanel();
  });
  // JRPG NPC 关系面板开关
  $("jrpg-npc-toggle").addEventListener("click", () => {
    const panel = $("jrpg-npc-panel");
    panel.classList.toggle("hidden");
    if (!panel.classList.contains("hidden")) renderJrpgNpcPanel();
  });
  //260601 Red 导入角色列表渲染
  function renderImportList() {
    const list = $("rpg-import-list");
    if (!list) return;
    const library = state.config.jrpg_npc_library || {};
    const names = Object.keys(library);
    list.innerHTML = "";
    if (names.length === 0) {
      list.innerHTML = '<span style="font-size:11px;color:var(--text-tertiary)">暂无已保存角色</span>';
      return;
    }
    names.forEach(name => {
      const npc = library[name];
      const btn = document.createElement("button");
      btn.className = "rpg-import-btn";
      btn.textContent = `${ELEMENT_EMOJI[npc.element] || "?"} ${name}`;
      btn.title = `${npc.role || ""} · ${npc.personality || ""}`;
      btn.addEventListener("click", () => {
        $("rpg-char-name").value = name;
        document.querySelectorAll(".rpg-element-btn").forEach(b => {
          b.classList.toggle("active", b.dataset.element === npc.element);
        });
      });
      list.appendChild(btn);
    });
  }
  $("rpg-setup-btn").addEventListener("click", () => {
    const c = state.rpgChar;
    const social = state.jrpgSocial;
    $("rpg-char-name").value   = c.name;
    //260601 Red 高亮当前选择的元素
    document.querySelectorAll(".rpg-element-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.element === c.element);
    });
    $("rpg-str").value = c.str; $("rpg-mag").value = c.mag;
    $("rpg-spd").value = c.spd; $("rpg-def").value = c.def;
    $("rpg-sta").value = c.sta;
    $("rpg-virtue").value = social.德行;
    $("rpg-intel").value  = social.智识;
    $("rpg-body").value   = social.体魄;
    $("rpg-charm").value  = social.魅力;
    renderImportList();
    $("rpg-setup-overlay").classList.add("open");
  });
  //260601 Red 元素选择按钮点击
  document.querySelectorAll(".rpg-element-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".rpg-element-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
    });
  });
  $("rpg-setup-cancel").addEventListener("click", () => $("rpg-setup-overlay").classList.remove("open"));
  $("rpg-setup-confirm").addEventListener("click", () => {
    //260601 Red 角色名必填校验
    const charName = $("rpg-char-name").value.trim();
    if (!charName) {
      showToast("请输入角色名");
      $("rpg-char-name").focus();
      return;
    }
    const activeEl = document.querySelector(".rpg-element-btn.active");
    const element = activeEl ? activeEl.dataset.element : "fire";
    const gi = id => Math.min(100, Math.max(1, parseInt($(id).value) || 1));
    state.rpgChar = {
      name:    charName,
      element: element,
      str: gi("rpg-str"), mag: gi("rpg-mag"),
      spd: gi("rpg-spd"), def: gi("rpg-def"),
      sta: gi("rpg-sta"),
    };
    state.jrpgSocial = {
      德行: Math.min(50, Math.max(1, parseInt($("rpg-virtue").value)||1)),
      智识: Math.min(50, Math.max(1, parseInt($("rpg-intel").value)||1)),
      体魄: Math.min(50, Math.max(1, parseInt($("rpg-body").value)||1)),
      魅力: Math.min(50, Math.max(1, parseInt($("rpg-charm").value)||1)),
    };
    //260601 Red HP 基于体力，MP 基于魔力
    state.rpgStatus = {
      hp: 30 + state.rpgChar.sta * 5,
      hpMax: 30 + state.rpgChar.sta * 5,
      mp: 10 + state.rpgChar.mag * 3,
      mpMax: 10 + state.rpgChar.mag * 3,
      lv: 1, exp: 0, expNext: 100, gold: 50
    };
    initJrpgGame();
    updateRpgStatusBar();
    $("rpg-setup-overlay").classList.remove("open");
    //260601 Red 自动发送"出发"触发第一轮剧情
    newChat();
    userInputEl.value = "出发";
    sendMessage();
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
  //260523 Red 新故事按钮：打开模板驱动的新故事面板
  $("novel-new-story-btn").addEventListener("click", () => {
    renderTemplateSelect();
    const tpl = state.activeTemplate ? (state.config.templates || {})[state.activeTemplate] : null;
    $("ns-hero-name").value  = state.novelHeroName || tpl?.default_hero || state.config.default_hero_name || "林然";
    $("ns-pov").value = state.novelPov || tpl?.default_pov || "third";
    $("ns-word-count").value   = state.novelWordCount || tpl?.default_words || 200;
    $("novel-setup-overlay").classList.add("open");
  });
  $("novel-setup-cancel").addEventListener("click", () => {
    $("novel-setup-overlay").classList.remove("open");
  });
  $("novel-setup-confirm").addEventListener("click", () => {
    state.novelHeroName    = $("ns-hero-name").value.trim() || state.config.default_hero_name || "林然";
    state.novelPov         = $("ns-pov").value;
    state.novelWordCount   = parseInt($("ns-word-count").value) || 200;
    // 从动态表格读取阶段
    const stageRows = [...document.querySelectorAll("#ns-stages-table .ns-stage-row")];
    const defaultStages = [
      { name: "陌生人", cap: 20, rule: "保持礼貌距离" },
      { name: "相识",   cap: 45, rule: "日常接触范畴" },
      { name: "朋友",   cap: 70, rule: "友好亲近" },
      { name: "暧昧",   cap: 90, rule: "可有暧昧互动" },
      { name: "恋人",   cap: 100, rule: "可亲密表达" }
    ];
    state.novelStages = stageRows.map((row, i) => {
      const name = row.querySelector(".ns-stage-name")?.value?.trim() || defaultStages[i]?.name || `阶段${i+1}`;
      const cap  = parseInt(row.querySelector(".ns-stage-cap")?.value) || (defaultStages[i]?.cap || 100);
      const rule = row.querySelector(".ns-stage-rule")?.value?.trim() || defaultStages[i]?.rule || "";
      return { name, cap, rule };
    });
    // 确保 cap 递增
    for (let i = 1; i < state.novelStages.length; i++) {
      if (state.novelStages[i].cap <= state.novelStages[i-1].cap)
        state.novelStages[i].cap = state.novelStages[i-1].cap + 1;
    }
    $("novel-setup-overlay").classList.remove("open");

    const heroine = (state.config.novel_heroines || {})[state.novelHeroine];
    if (heroine) {
      newChat();
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

  setupResizeHandles();
} catch(e) { console.error("setupEventListeners error:", e); }
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