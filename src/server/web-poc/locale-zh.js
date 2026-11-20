/*
 * locale-zh.js — Chinese (zh-CN) text layer for the Antigravity web UI.
 *
 * The frontend bundle ships English strings only (no i18n runtime), so this is a
 * *dictionary substitution* layer, not a locale switch:
 *   - only EXACT matches are replaced (plus a few regex families for labels that
 *     embed user data, e.g. "Select model, current: <model>");
 *   - text inside code blocks, tables, editors and message bubbles is never
 *     touched, so conversation content, code and file names stay verbatim;
 *   - a MutationObserver re-applies after React re-renders.
 *
 * Anything not in the dictionary stays English — extend DICT to cover more.
 * Enabled by the proxy (UI_LANG=zh, or auto when the browser asks for zh).
 */
(function () {
  "use strict";
  if (window.__agZh) return;
  window.__agZh = true;

  /* ---------------------------------------------------------------- strings */
  var DICT = {
    // menubar / global
    "Workspace": "工作区",
    "View": "视图",
    "Window": "窗口",
    "Settings": "设置",
    "Shortcuts": "快捷键",
    "Keyboard shortcuts": "键盘快捷键",
    "Sign Out": "退出登录",
    "Upgrade": "升级",
    "Legal Help": "法律帮助",
    "Open Settings": "打开设置",
    "Open System Preferences": "打开系统设置",
    "Open Links In": "链接打开方式",
    "Reset Zoom": "重置缩放",
    "Zoom In": "放大",
    "Zoom Out": "缩小",
    "Maximize": "最大化",
    "Minimize": "最小化",
    "Close": "关闭",
    "Cancel": "取消",
    "Submit": "提交",
    "Change…": "更改…",
    "Done": "完成",
    "Continue": "继续",
    "Learn more": "了解更多",

    // NOTE: single generic words ("Open", "Plan", "High", "Default", ...) are
    // deliberately absent — they collide with conversation titles and model
    // names such as "Gemini 3.8 Flash High".

    // home / composer
    "Ask anything, @ to mention, / for actions": "随便问 · @ 引用文件 · / 触发操作",
    "New Conversation": "新建会话",
    "Customizations": "自定义",
    "Projects": "项目",
    "Create Project": "新建项目",
    "No conversations yet": "还没有会话",
    "Search Conversations": "搜索会话",
    "Message input": "消息输入框",
    "Add context": "添加上下文",
    "Attach a screenshot (optional)": "附加截图（可选）",
    "Queue": "排队",
    "Queued Messages": "排队中的消息",
    "Send Immediately": "立即发送",
    "Cancel Generation": "取消生成",
    "Cancel": "取消",

    // sidebar / panels
    "Toggle Sidebar": "切换侧边栏",
    "Sidebar": "侧边栏",
    "Toggle Side Panel": "切换侧面板",
    "Display Options": "显示选项",
    "More options": "更多选项",
    "Project options": "项目选项",
    "Create New Project": "新建项目",
    "New Conversation in Project": "在项目中新建会话",
    "Pin conversation": "置顶会话",
    "Pin / Unpin Conversation": "置顶 / 取消置顶会话",
    "Archive conversation": "归档会话",
    "Archive This Conversation": "归档此会话",
    "Copy path": "复制路径",
    "Search Conversations": "搜索会话",
    "Toggle Overview Panel": "切换概览面板",
    "Toggle Maximize Side Panel": "最大化侧面板",
    "Next Side Panel Tab": "下一个侧面板",
    "Previous Side Panel Tab": "上一个侧面板",
    "Toggle Model Selector": "切换模型",
    "Toggle Project Selector": "切换项目",
    "Toggle Environment Selector": "切换环境",
    "Toggle Terminal": "切换终端",
    "Toggle Voice Recording": "切换语音录制",
    "Start Voice mode": "开始语音模式",
    "Voice mode": "语音模式",

    // conversations
    "Find in Conversation": "在会话中查找",
    "Find in Pane": "在面板中查找",
    "New Tab": "新建标签页",
    "Close Tab": "关闭标签页",
    "Reopen Closed Tab": "重新打开标签页",
    "New Terminal Tab": "新建终端标签页",
    "Split Terminal": "拆分终端",
    "Split Conversation Horizontally": "水平拆分会话",
    "Split Conversation Vertically": "垂直拆分会话",
    "Go Back": "后退",
    "Go Forward": "前进",
    "Focus Input": "聚焦输入框",
    "Open Command Palette": "打开命令面板",
    "Open Conversation Picker": "打开会话选择器",
    "Open File Search": "打开文件搜索",
    "Open Keyboard Shortcuts": "打开快捷键设置",
    "Comment on Selection": "对选中内容评论",
    "Add to Chat/Quote": "添加到对话 / 引用",
    "Side Question Selection": "对选区侧边提问",
    "Jump to Next Prompt": "跳到下一个提问",
    "Jump to Previous Prompt": "跳到上一个提问",
    "Select Next Conversation": "下一个会话",
    "Select Previous Conversation": "上一个会话",
    "Move Conversation Up": "上移会话",
    "Move Conversation Down": "下移会话",
    "Mute Voice Mic": "麦克风静音",
    "Mute Voice Speaker": "扬声器静音",
    "Submit Prompt (Alternate to Enter)": "提交内容（Enter 的替代键）",
    "Terminal: Add to Chat": "终端：添加到对话",
    "Terminal: Select All": "终端：全选",
    "Conversation": "会话",
    "Conversation Log": "会话记录",
    "Load older messages": "加载更早的消息",
    "Agent said": "智能体说",
    "Agent": "智能体",
    "Thinking": "思考中",
    "Steps": "步骤",
    "Show more": "展开",
    "Show less": "收起",
    "Copy": "复制",
    "Copied": "已复制",
    "Retry": "重试",
    "Undo": "撤销",
    "Send": "发送",
    "Stop": "停止",
    "Attach": "附加",
    "Context": "上下文",
    "Review": "审查",
    "Apply": "应用",
    "Accept": "接受",
    "Reject": "拒绝",
    "Approve": "批准",
    "Deny": "拒绝",
    "Run": "运行",
    "Terminal": "终端",
    "Files Changed": "更改的文件",
    "Checkpoints": "检查点",
    "Token Usage": "令牌用量",
    "Conversation Steps": "会话步骤",
    "Show 1 breakdown": "展开 1 项明细",

    // settings
    "General": "通用",
    "Appearance": "外观",
    "Interface Layout": "界面布局",
    "Dark Theme": "深色主题",
    "Default Dark": "默认深色",
    "Light": "浅色",
    "Dark": "深色",
    "System": "跟随系统",
    "System default": "跟随系统默认",
    "Font Size": "字号",
    "Accent": "强调色",
    "Background": "背景",
    "Foreground": "前景",
    "Contrast": "对比度",
    "Enable Sounds for Agent": "启用智能体提示音",
    "Set the volume of agent sounds.": "设置智能体提示音的音量。",
    "Notifications": "通知",
    "Enable Notifications for Agent": "启用智能体通知",
    "Marketing Emails": "营销邮件",
    "Prevent Sleep": "防止休眠",
    "Prevent the computer from sleeping while the app is running.": "应用运行时阻止电脑休眠。",
    "Keep In Menu Bar": "保留在菜单栏",
    "External Browser": "外部浏览器",
    "Built-in Browser": "内置浏览器",
    "Voice engine": "语音引擎",
    "Models & Usage": "模型与用量",
    "Model Quota": "模型配额",
    "Model Credits": "模型额度",
    "Auth and Billing": "账户与计费",
    "Application": "应用",
    "Advanced Settings": "高级设置",
    "Developer": "开发者",
    "Enable Telemetry": "启用遥测",
    "Remote Control": "远程控制",
    "Enable Remote Control": "启用远程控制",
    "Work with local agents from another device.": "从其他设备操作本机智能体。",
    "Build With Google Plugins": "使用 Google 插件构建",
    "Tool Permissions": "工具权限",
    "Global Permissions": "全局权限",
    "Permission Preset": "权限预设",
    "Browser Actuation Rules": "浏览器操作规则",
    "Network Access Rules": "网络访问规则",
    "Not set": "未设置",
    "Verbose": "详细",
    "Configure default behaviors, skills, and MCP servers.": "配置默认行为、技能和 MCP 服务器。",
    "Configure the agent's visual theme and display preferences.": "配置智能体的主题和显示偏好。",
    "Manage Antigravity app settings.": "管理 Antigravity 应用设置。",
    "Manage your plan, credentials, and general preferences.": "管理你的方案、凭据和通用偏好。",
    "Manage your model quota and credits.": "管理模型配额和额度。",
    "Manage your notification preferences.": "管理通知偏好。",
    "Choose where links open by default when clicked.": "选择点击链接时的默认打开方式。",
    "Choose how much detail is shown during a conversation.": "选择会话中展示的详细程度。",
    "Controls the actions the agent can take.": "控制智能体可以执行的操作。",
    "Configure when follow-up messages are sent.": "配置后续消息的发送时机。",
    "Configure global allowed and denied resource permissions.": "配置全局允许 / 禁止的资源权限。",
    "Configure allowed and denied URLs for reading.": "配置允许 / 禁止读取的网址。",
    "Modify permissions for file, terminal, and MCP tools.": "调整文件、终端和 MCP 工具的权限。",

    // onboarding / NUX dialog (first screen a new phone sees)
    "One last thing before getting started…": "开始前的最后一步…",
    "A few things to know, and a couple settings to review.": "几件需要了解的事，以及两项需要确认的设置。",
    "Optimized for you": "为你优化",
    "Built to help, not hurt": "为帮助而生，而非伤害",
    "You are in control": "控制权在你手中",
    "Antigravity’s agents are powerful and will help you get a lot done better and faster than before, but still make sure to verify the actions taken by the agent.": "Antigravity 的智能体很强大，能比以往更快更好地帮你完成大量工作，但请仍然核实它执行的每一个动作。",
    "Stay up to date. Sign up for newsletters, tips and tricks, and other notifications about Antigravity.": "保持关注：订阅 Antigravity 的邮件简报、技巧与通知。",
    "Customize your experience across the agent, plugins, and product from the settings and marketplace. We won’t show you ads or let advertisers influence what Antigravity says.": "你可以在设置与市场里定制智能体、插件和产品体验。我们不会向你展示广告，也不会让广告主影响 Antigravity 的回答。",
    "Automated safeguards help to protect your conversations from insecure or unsafe content. That being said, users should be aware of potential agentic risks, including data exfiltration.": "自动化的安全机制会保护你的对话免受不安全内容影响。但用户仍需留意智能体可能带来的风险，包括数据外泄。",
    "Got it": "知道了",
    "Get started": "开始使用",
    "Get Started": "开始使用",
    "Review settings": "检查设置",
    "Set up later": "稍后设置",

    // feedback dialog
    "Give Feedback": "反馈",
    "Bug Report": "缺陷报告",
    "Feature Request": "功能建议",
    "General Feedback": "一般反馈",
    "Feedback Type": "反馈类型",
    "Actual behavior": "实际表现",
    "Expected behavior": "期望表现",
    "Steps to Reproduce": "复现步骤",
    "Any error messages": "错误信息",
    "Any relevant information": "其他相关信息",
    "Attach Antigravity server logs": "附加 Antigravity 服务器日志",
    "Knowledge Work": "知识工作",
    "Software Engineering": "软件工程",
  };

  /* Regex families: labels that embed user data — translate the frame only. */
  var PATTERNS = [
    [/^Hey (.+), what should we build today\?$/, function (m) { return "你好，" + m[1] + "，今天想做点什么？"; }],
    [/^Welcome back, (.+?)\. Where should we pick up\?$/, function (m) { return "欢迎回来，" + m[1] + "。从哪里继续？"; }],
    [/^Good (morning|afternoon|evening), (.+)$/, function (m) {
      var zh = { morning: "早上好", afternoon: "下午好", evening: "晚上好" }[m[1]] || "你好";
      return zh + "，" + m[2];
    }],
    [/^Worked for (.+)$/, function (m) { return "工作了 " + m[1]; }],
    [/^Thinking for (.+)$/, function (m) { return "思考了 " + m[1]; }],
    [/^(\d+) breakdown$/, function (m) { return m[1] + " 项明细"; }],
    [/^Show (\d+) breakdown$/, function (m) { return "展开 " + m[1] + " 项明细"; }],
    [/^Your Plan: (.+)$/, function (m) { return "当前方案：" + tr(m[1]); }],
    [/^Select model, current: (.+)$/, function (m) { return "选择模型，当前：" + m[1]; }],
    [/^Select project, current: (.+)$/, function (m) { return "选择项目，当前：" + m[1]; }],
    [/^Select environment, current: (.+)$/, function (m) { return "选择环境，当前：" + m[1]; }],
    [/^Agent permissions preset selector, current: (.+)$/, function (m) { return "智能体权限预设，当前：" + m[1]; }],
    [/^Add shortcut for (.+)$/, function (m) { return "为「" + tr(m[1]) + "」添加快捷键"; }],
    [/^Remove shortcut (.+) for (.+)$/, function (m) { return "移除「" + tr(m[2]) + "」的快捷键 " + m[1]; }],
    [/^Shortcut (.+) for (.+)$/, function (m) { return "「" + tr(m[2]) + "」的快捷键 " + m[1]; }],
    [/^Send feedback as (.+)$/, function (m) { return "以 " + m[1] + " 身份发送反馈"; }],
  ];

  function tr(s) {
    var v = DICT[s];
    return v === undefined ? s : v;
  }

  function translate(text) {
    var t = text.trim();
    if (!t) return null;
    // Fast path: exact dictionary hit (whitespace preserved around it).
    var hit = DICT[t];
    if (hit !== undefined) return text.replace(t, hit);
    for (var i = 0; i < PATTERNS.length; i++) {
      var m = t.match(PATTERNS[i][0]);
      if (m) return text.replace(t, PATTERNS[i][1](m));
    }
    return null;
  }

  /* --------------------------------------------------------------- DOM walk */
  var SKIP = "pre, code, kbd, samp, textarea, input, select, [contenteditable='true'], [contenteditable=''], .agy-md-table, .agy-user-bubble, .agy-user-bubble-frame, .agy-code-block, .xterm";

  function allowed(node) {
    var el = node.parentElement;
    if (!el) return false;
    if (el.closest(SKIP)) return false;
    // Do not translate inside anything that looks like rendered markdown/message text.
    if (el.closest("[data-agy-i18n-skip]")) return false;
    return true;
  }

  var ATTRS = ["aria-label", "placeholder", "title"];

  function translateAttrs(el) {
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i];
      var v = el.getAttribute && el.getAttribute(a);
      if (!v) continue;
      var out = translate(v);
      if (out !== null && out !== v) el.setAttribute(a, out);
    }
  }

  function translateElement(root) {
    // text nodes
    if (root.nodeType === 3) {
      if (allowed(root)) {
        var out = translate(root.nodeValue || "");
        if (out !== null && out !== root.nodeValue) root.nodeValue = out;
      }
      return;
    }
    if (root.nodeType !== 1) return;
    translateAttrs(root);
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, null);
    var n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === 3) {
        if (!allowed(n)) continue;
        var v = translate(n.nodeValue || "");
        if (v !== null && v !== n.nodeValue) n.nodeValue = v;
      } else {
        translateAttrs(n);
      }
    }
  }

  /* --------------------------------------------------------------- observer */
  var queue = new Set();
  var scheduled = false;

  function flush() {
    scheduled = false;
    var roots = Array.from(queue);
    queue.clear();
    for (var i = 0; i < roots.length; i++) {
      try {
        if (roots[i] === document.body || document.body.contains(roots[i]) || roots[i].nodeType === 3) {
          translateElement(roots[i]);
        }
      } catch (e) { /* never break the app */ }
    }
  }

  var timer = null;

  function schedule(root) {
    // Never walk rendered messages / code blocks: they can be megabytes.
    try {
      if (root && root.nodeType === 1 && root.closest && root.closest(SKIP)) return;
      if (root && root.nodeType === 3 && root.parentElement && root.parentElement.closest(SKIP)) return;
    } catch (e) { /* ignore */ }
    queue.add(root);
    // Plain debounced timer: requestIdleCallback gets starved by this app (it
    // keeps long-lived streams busy), which left late-rendered labels — e.g. the
    // conversation header — in English.
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(function () { timer = null; flush(); }, 60);
    scheduled = true;
  }

  var observer = new MutationObserver(function (mutations) {
    try {
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];
      if (m.type === "childList") {
        for (var j = 0; j < m.addedNodes.length; j++) schedule(m.addedNodes[j]);
      } else if (m.type === "characterData") {
        schedule(m.target);
      } else if (m.type === "attributes") {
        schedule(m.target);
      }
    }
    } catch (e) { /* never break the app */ }
  });

  function start() {
    translateElement(document.body);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ATTRS,
    });
    if (document.documentElement.lang !== "zh-CN") document.documentElement.lang = "zh-CN";
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
