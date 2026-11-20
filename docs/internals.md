# 实现笔记：为什么这么绕

这份文档记录把「Antigravity 的 Web UI」跑到浏览器里、并让它能在手机上用起来时踩到的坑。
纯技术记录，不涉及任何具体部署信息。README 讲怎么用，这里讲为什么这么做。

---

## 1. Linux 上没有 `language_server`，只有 `agy --hub`

上游 `web-poc` 是按 macOS/Windows 桌面版写的：

```bash
language_server --extension_server_port … --workspace_id … --enable_lsp …
```

但 Linux 的 CLI / IDE 版本里，那个 Go 二进制叫 `agy`，命令行完全是另一套：

```bash
agy --hub --hub-port=35833 --app_data_dir=antigravity \
    --csrf_token=a6403551-f1e7-43f3-a8e4-4b2f867d1027 --add-dir=/data1/workspace
```

`--extension_server_port` 这种参数它根本不认（`flags provided but not defined`）。于是本项目的代理增加了**附加模式**
（`AG_ATTACH_URL` + `AG_CSRF_TOKEN`）：自己按 `agy` 的方式把语言服务器拉起来，再把代理指过去，跳过上游那套 mock extension server 握手。

几个必须知道的细节：

- `agy --hub` 需要 **pty**（它是个 bubbletea TUI），所以要在 tmux / `script` 里跑；
- 必须带 **`AGY_ENABLE_HUB=1`**，否则前端端口虽然起来了但 `/` 一律 404；
- 它同时开两个口：一个 HTTPS（前端 + ConnectRPC，**代理指向这个**），一个明文 HTTP hub 口（TUI 里会打印带 `#t=` 的地址）；
- 端口是随机的（上例的 35833 只是其中一次），所以代理按「哪个口能返回
  `<title>Antigravity</title>`」来识别真正的那个前端端口。

---

## 2. 鉴权：Linux CLI 没有 `state.vscdb`

上游从 `~/.config/Antigravity*/User/globalStorage/state.vscdb` 的 `antigravityUnifiedStateSync.oauthToken`
里取 `OAuthTokenInfo`。Linux CLI 版根本没有这个库，令牌在：

```
~/.gemini/jetski-standalone-oauth-token      # JSON: { token:{access_token, token_type, refresh_token, expiry}, … }
```

所以 `auth-reader.ts` 增加回退：把这个 JSON 重新序列化成 `OAuthTokenInfo` protobuf，再走 USS 的
`oauthTokenInfoSentinelKey` 交给语言服务器。`AG_TOKEN_FILE` 可以覆盖路径。

---

## 3. `preload-shim.js` 会随前端版本失效

前端是 Electron 应用，只依赖 preload 注入的 `window.electron*`。用浏览器跑就得自己实现这些。
2.7.x 的前端启动时会调 `electronUpdater.getState()`，shim 里没有这个方法 → 报
`a.getState is not a function`，页面**直接白屏**（连 React 都没渲染）。补上之后正常。

经验：前端升级后先看 console，这类「缺一个方法就白屏」的问题最难从现象上猜。

---

## 4. 首屏慢的三个真实原因

1. **bundle 大**：`main.js` 原始 12.4 MB。代理为了改写 HTML 会删掉 `accept-encoding`，
   结果连静态资源也走明文 —— 改成只对导航/HTML 请求要 identity，其余透传 gzip → 3.8 MB。
2. **`fonts.googleapis.com` 阻塞渲染**：HTML 里有 `<link rel=stylesheet>`，而且前端 JS 启动后还会**再插一次**。
   该域名不可达时，一个 render-blocking 样式表足以把首屏卡十几秒（看起来像「一直在转圈」）。做法：从 HTML 里删掉，
   并加一条最小 CSP（`style-src 'self' 'unsafe-inline'; font-src 'self' data: blob:`）让它**立即失败**而不是等超时。
3. **上游 `cache-control: no-cache`**：每次访问都重下 3.8 MB。给静态资源加 `max-age` 后，二次打开走缓存。

---

## 5. 隧道不是越"通"越好

- frp 免费/特惠节点经常是**突发型带宽**：同一个 3.8 MB 文件连续 5 次实测 0.14 / 7.1 / 0.14 / 3.6 / 4.7 MB/s。
  慢的那几次就是用户眼里的「一直转圈」。Cloudflare Tunnel 在同一台机器上是稳定的 ~1–3 MB/s。
- frpc 在本地端口不可用时会为**每个进来的连接**打一行 `connection refused`。代理重启期间（尤其是
  `npx tsx` 现场编译要 10–30 s 的那种）日志会被刷屏，看起来像隧道坏了，其实只是重启窗口。
  两个对策：把启动耗时压下去（见下），以及 `frpc/start.sh` 启动时清空日志。
- 很多机房到 Google 的出网是断的：语言服务器拿不到 `loadCodeAssist`，界面就显示「No Model Selected」。
  用 `PROXY_FORWARD=host:7890` 建一条 `ssh -L` 隧道并注入 `HTTP(S)_PROXY` 就恢复了。

---

## 6. 启动时间：28 s → 1 s

`tsx` 现场编译这套 NFS 上的源码要几十秒，期间端口是关的。三层优化：

1. 用仓库内 `node_modules/tsx/dist/cli.mjs` 而不是 `npx tsx`（npx 解析本身就要 ~12 s）；
2. `npm run build` 预编译到 `dist/`，用 `node dist/...` 启动；
3. 把 `Launcher` 改成**动态 import** —— 附加模式下根本不需要那套 protobuf 生成代码，require 它是纯浪费。

副作用要处理：`dist` 布局的 `__dirname` 层级不同，所以
- 令牌文件、静态资源、图标路径都要按「向上找到含 `package.json` + `src/` 的仓库根」来定位；
- `scripts/copy-web-poc-assets.ts` 要把 `mobile.css / mobile.js / locale-zh.js` 一起拷进 `dist`。

---

## 7. 手机端两个结构性问题

**侧栏**：前端给侧栏写的是行内样式 `width: min(256px, min(456px, 100% - 309px))`。
390 px 屏上算出来只有 **81 px**（图标条），还把正文压到 308 px。把侧栏 `position: fixed` 抽出 flex 流后：
抽屉宽 `min(84vw, 340px)`，正文回到整屏宽。它内部的容器查询会随之从图标模式切到带文字的完整布局，
所以**不要**再用 `!important` 去改它内部宽度 —— 会跟容器查询打架。

**会话行点击**：行里真正的链接是 `<a class="absolute inset-0">`，但窄屏布局下它被算成 **0×0**（`position: relative`、无尺寸）；
行内标签容器又在深层把 `pointer-events` 恢复成 `auto` 把点击吃掉；虚拟列表里还叠着多份副本。
纯 CSS 修不好，最后用**事件委托**：任何落在 `[data-testid=conversation-row-sidebar]` 上的点击 →
`history.pushState()` + 派发 `popstate`，让应用自己的路由就地渲染（整页 `location.assign` 会看起来像刷新）。
1.2 s 后如果 `.agy-home` 还挂在 DOM 上，说明路由没响应，再退回整页跳转。

---

## 8. 一个正则引发的血案

剔除上游自带的 favicon 时，用的是 `<link[^>]*>` —— 而它的 `href` 是内联 data URI：

```html
<link rel="icon" href="data:image/svg+xml,<svg …><text y='.9em'>🎁</text></svg>" />
```

`[^>]*` 在 data URI 里第一个 `>` 处就停了，只删掉标签前半截，剩下的碎片被浏览器解析成
一个 `<text>` 元素 + 两个短文本节点，稳稳地渲染在页面左上角。正确写法是**引号感知**的：

```js
const LINK_TAG_RE = /<link\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
```

**教训**：改写 HTML 的正则必须考虑引号内的 `>`；否则「删一半」比不删更糟。
`mobile.js` 里还留了一层兜底，把这类残片清掉。

---

## 9. 令牌门禁的几个设计点

- 令牌是 bearer 语义，但浏览器第二次访问不该再输入 → 校验通过后下发 `ag_auth` Cookie
  （HttpOnly + Secure + SameSite=Lax），并把 URL 里的 `?t=` 去掉；
- **静态资源和 ConnectRPC 也要校验**，否则只是「首页看不见而已」；
- 图标等极少数资源放行（否则登录页没图标）；
- 令牌持久化在 `.mobile-web/auth_token`（600），重启不变；轮换用一条命令。

---

## 10. 中文层为什么不做"翻译整个页面"

前端 bundle 里没有任何 i18n 运行时（连语言列表都没有），所以只有两条路：改前端，或者替换文本。
替换文本必须极其保守：

- **只做精确匹配**，并对带用户数据的文案用窄正则（`Select model, current: X`）；
- 单字通用词（`Open` / `Plan` / `High` / `Default` / `Chat`）不收 —— 否则「Gemini 3.8 Flash **High**」会被翻成「高」；
- `pre / code / textarea / contenteditable / 表格 / 消息气泡` 一律跳过，保证对话与代码原样；
- 调度用**去抖的 `setTimeout`**，不要用 `requestIdleCallback`：这个应用有大量长连接，
  idle 回调会被饿死，表现为「新渲染出来的文案一直是英文」。顺便记一笔，
  `requestIdleCallback(fn, 16)` 传数字当 options 会直接抛 TypeError。
