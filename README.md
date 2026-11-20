# Antigravity Web（非官方）

> 在**纯浏览器**里跑 Antigravity IDE 的 Web UI，并把「远程 + 手机」这条路上的坑补平：
> 手机排版、中文界面、访问令牌门禁、内网穿透脚本、首屏提速。

本项目是 [jkfujinami/antigravity-client](https://github.com/jkfujinami/antigravity-client) 中 `web-poc` 思路的延续与工程化：
用反向代理把官方前端原样搬到浏览器里，并在代理层补齐它缺少的东西。
**非官方项目，与 Google / Antigravity 官方无关。**

---

## 它做了什么

| 能力 | 说明 |
| --- | --- |
| 浏览器跑官方 UI | 反向代理语言服务器自带的前端，注入 Electron `preload.js` 的 Web 等价实现，前端 bundle 本身不改一行 |
| 接入已有语言服务器 | 支持 `AG_ATTACH_URL` 直接挂到已在运行的语言服务器（Linux 上 `agy --hub` 的形态），不必重新启动一个 |
| Linux 适配 | Linux 的「language server」其实是 `~/.gemini/bin/agy --hub`，命令行参数与桌面版 `language_server` 完全不同；这里做了适配，并从 CLI 的 OAuth 令牌文件回退鉴权 |
| 手机排版 | 侧栏改为浮层抽屉、键盘避让、触控热区放大、会话列表点击走 SPA 路由 |
| 中文界面 | 前端没有 i18n，这里用「精确匹配词表 + DOM 观察器」做中文层，不动消息内容和代码 |
| 访问令牌 | 公网暴露必须的令牌门禁：登录页 → `ag_auth` Cookie，静态资源与 RPC 同样校验 |
| 内网穿透 | 自带 frp 与 Cloudflare Tunnel 两套启动脚本，含出网代理（SSH 隧道）处理 |
| 首屏优化 | 只对 HTML 要 identity、其余透传 gzip（12.4 MB → 3.8 MB）、静态资源缓存、屏蔽会阻塞渲染的 Google Fonts |

---

## 快速开始

### 前置

- 已安装 Antigravity（或它的 CLI / IDE），且**已登录**
  - 桌面版：读 `~/.config/Antigravity( IDE)/User/globalStorage/state.vscdb`
  - Linux CLI：读 `~/.gemini/jetski-standalone-oauth-token`
- Node.js ≥ 20、`openssl`（首次生成自签证书用）

### 安装

```bash
git clone https://github.com/feicai922/antigravity-web.git
cd antigravity-web
npm install
npm run build          # 预编译到 dist/，启动快一个数量级
```

### 启动（两种模式）

```bash
# A. 独立模式：由本项目拉起一个语言服务器（桌面版布局 / Windows / macOS）
npm run web -- /path/to/workspace

# B. 附加模式：挂到已经跑着的语言服务器（Linux `agy --hub` 场景，推荐）
#    端口和 CSRF 令牌在语言服务器的启动日志里；下面的值只是格式示例。
#    用 ./scripts/start-mobile-web.sh 启动时会自动探测，不需要手填。
AG_ATTACH_URL=https://127.0.0.1:39165 \
AG_CSRF_TOKEN=a6403551-f1e7-43f3-a8e4-4b2f867d1027 \
  node dist/src/server/web-poc/server.js /data1/workspace/demo
```

打开终端里打印的地址（首次需接受自签证书），形如：

```
https://localhost:8790/?t=WoxOOeQ-GEPBLkxLG19Q6YETGtDlsQf
```

`?t=` 后面那一串是访问令牌，启动时会自动生成并打印在终端里。

> 一键脚本（推荐）见下方「内网穿透」。

---

## 内网穿透

目标：在手机上打开一个带令牌的地址，直接使用桌面版 UI，例如：

```
https://antigravity.example.com/?t=WoxOOeQ-GEPBLkxLG19Q6YETGtDlsQf
https://203.0.113.10:8790/?t=WoxOOeQ-GEPBLkxLG19Q6YETGtDlsQf
```

### 方案对比

| 方案 | 需要什么 | 优点 | 缺点 |
| --- | --- | --- | --- |
| **frp** | 一台有公网 IP 的服务器 / 面板账号 | 延迟低、可控、便宜 | 免费节点常限速，带宽抖动大 |
| **Cloudflare Tunnel** | 一个托管在 Cloudflare 的域名 | 证书有效（手机不弹告警）、速度稳定、无需公网 IP、无需备案 | 依赖 Cloudflare 边缘可达 |
| **Tailscale** | 装客户端 | 零配置、最安全（不暴露公网） | 手机需装 VPN 类 App |

代理内置了访问控制：默认只允许 `127.0.0.1` 与 Tailscale CGNAT 段（`100.64.0.0/10`）直接连接。
frp / cloudflared 都是**从本机 `127.0.0.1` 转发**，所以天然放行；其余来源必须过令牌门禁。

### A. frp

1. 在 frp 面板建一条 **TCP 隧道**：本地 `127.0.0.1:8790`，远程端口任选；
2. 把面板生成的配置保存成 `frpc/frpc.toml`（**不要提交**，仓库里只有 `frpc/frpc.toml.example`）；
3. 启动：

```bash
cp frpc/frpc.toml.example frpc/frpc.toml   # 首次：按注释改成你自己的面板信息
./frpc/start.sh start      # 后台跑在 tmux 会话里
./frpc/start.sh status     # 打印公网地址并探测（401 = 隧道通、只是要令牌）
./frpc/start.sh stop
```

> **注意**：便宜节点的带宽经常是「突发型」，同一个 3.8 MB 的 bundle 可能 0.5 s 下完，
> 也可能要 26 s —— 首屏一直转圈多半是它。要么换节点，要么走 Cloudflare。
> 静态资源已加 `max-age`，只有**首次**访问吃这个带宽。

### B. Cloudflare Tunnel

```bash
# 临时隧道（无需账号，域名每次重启都变，适合先试）
./cloudflare/start.sh start
./cloudflare/start.sh url

# 固定域名：先准备 Cloudflare API Token（Tunnel:Edit + DNS:Edit）
export CLOUDFLARE_API_TOKEN=...
export CF_ACCOUNT_ID=...      CF_ZONE_ID=...
export AG_HOSTNAME=antigravity.example.com
python3 scripts/setup-cloudflare-tunnel.py     # 建隧道 + 配 ingress + 建 CNAME + 存 token
./cloudflare/start.sh start                    # 检测到 token 就走 named 模式
```

`setup-cloudflare-tunnel.py` 会把 ingress 指到 `https://127.0.0.1:8790` 并带上
`noTLSVerify: true`（本代理是自签证书），连接器凭据写到 `cloudflare/tunnel_token`（600，已 gitignore）。

### C. 出网代理（很多机房需要）

语言服务器要访问 `oauth2.googleapis.com` / `daily-cloudcode-pa.googleapis.com` 才能拿到模型列表和鉴权；
不少 GPU 节点 / 内网机器**直连不到**，表现就是界面里「No Model Selected」、项目列表空。

如果你有一台能出网的机器（且它能 SSH），可以让脚本顺手建一条 `ssh -L` 隧道并注入 `HTTPS_PROXY`：

```bash
PROXY_FORWARD=jumphost:7890 ./scripts/start-mobile-web.sh start
# 等价于：ssh -N -L 127.0.0.1:7999:127.0.0.1:7890 jumphost
# 并把 HTTP(S)_PROXY=http://127.0.0.1:7999 传给语言服务器
```

`LOCAL_PROXY_PORT`（默认 7999）可以改。Cloudflare 连接器同理可用 `CONNECT_PROXY`。

### D. 访问令牌（务必开启）

公网地址一旦泄露，等于把你的工作区、终端、模型额度一起交出去。代理默认开启令牌门禁：

```bash
./scripts/start-mobile-web.sh token             # 查看
./scripts/start-mobile-web.sh token --rotate    # 轮换（重启后生效，手机需重新登录）
AUTH=off ./scripts/start-mobile-web.sh start    # 只在内网/Tailscale 使用时关闭
```

- 令牌首次启动随机生成，存 `.mobile-web/auth_token`（600），**重启不变**；
- 首次访问会看到「访问令牌」页，粘贴后写入 `ag_auth` Cookie（HttpOnly + Secure + SameSite=Lax）；
- 也可以直接用 `?t=WoxOOeQ-GEPBLkxLG19Q6YETGtDlsQf` 这种形式登录，服务器会把参数从地址栏去掉；
- 无 Cookie 的静态资源与 RPC 一律 401。

### 一键脚本

```bash
PORT=8790 WORKSPACE=/path/to/workspace \
PROXY_FORWARD=jumphost:7890 \
  ./scripts/start-mobile-web.sh start     # 启动 / 幂等
./scripts/start-mobile-web.sh status
./scripts/start-mobile-web.sh stop
```

脚本会：选启动方式（`dist` 新鲜就用 `node dist/…`，否则退回 `tsx` 并提示先 build）→
确保出网隧道 → 拉起语言服务器（tmux）→ 探测前端端口 → 拉起代理（tmux）→ 冒烟自检 → 打印带令牌的地址。

---

## 移动端适配

在代理层注入两份资源（`src/server/web-poc/mobile.css` + `mobile.js`），`MOBILE_UI=0` 可关闭。

| 问题 | 做法 |
| --- | --- |
| 侧栏在窄屏只剩 81 px 图标条，还把正文压到 308 px | 把侧栏抽出 flex 流做成浮层抽屉 `min(84vw, 340px)`，正文回到整屏宽；点击遮罩收起 |
| 会话行点不动（链接层被压成 0×0、标签容器吃掉点击） | 事件委托：点行 → `pushState` + `popstate`，走应用自己路由**就地渲染**，不整页刷新 |
| 键盘弹出挡住输入框 | 用 `visualViewport.height` 驱动根容器高度，而非 `dvh` |
| iOS 聚焦输入框会放大页面 | 触屏设备强制 `font-size: 16px` |
| 图标按钮 24–28 px，点不准 | `min-width/height: 32px` + `::after` 把热区撑到 ~44 px |
| hover 才出现的行内操作点不到 | 抽屉内改为路由优先，行内按钮仍可点 |
| 对话框/表格/长链接撑破屏宽 | 限宽、横向滚动、`overflow-wrap: anywhere` |
| 刘海与底部指示条 | `env(safe-area-inset-*)` 内边距 |

---

## 中文界面

前端 bundle 没有任何 i18n 运行时，所以中文是**注入的词表替换层**（`src/server/web-poc/locale-zh.js`）：

- 只做**精确匹配**（少量带用户数据的正则，如 `Select model, current: X`）；
- `pre / code / textarea / input / contenteditable / 表格 / 消息气泡` 内容一律不碰 → 对话、代码、文件名保持原样；
- `MutationObserver` 跟随 React 重渲染重新贴；
- 单字通用词（`Open` / `Plan` / `High` / `Default` …）故意不收，避免把「Gemini 3.8 Flash High」这类模型名翻掉；
- 没收录的字符串保持英文，往 `DICT` 里加即可。

开关：`UI_LANG=auto`（默认，浏览器 `Accept-Language` 含 `zh` 才注入）/ `zh` 强制 / `en` 关闭。

---

## 首屏为什么能快一点

| 手段 | 效果 |
| --- | --- |
| 只对 HTML 要 identity，其余保留浏览器的 `accept-encoding` | 主 bundle 12.4 MB → **3.8 MB** |
| 静态资源加 `cache-control: max-age=3600` | 二次打开基本秒开，也让 Cloudflare 边缘能缓存 |
| 剥掉 `<link>` 到 `fonts.googleapis.com`，并用最小 CSP 让它**立刻失败** | 该域名不可达时，一个 render-blocking 样式表会把首屏卡十几秒 |
| 预编译 + 懒加载 launcher | 代理启动从 ~28 s 降到 ~1 s，重启窗口内的连接失败日志几乎消失 |

---

## 常见问题

**一直转圈进不去？**
先量带宽：
```bash
curl -o /dev/null -w '%{speed_download}\n' https://antigravity.example.com/main.js
```
低于 500 KB/s 基本就是隧道节点限速，换节点或用 Cloudflare。

**界面显示「No Model Selected」/ 项目为空？**
语言服务器出不了网，见「出网代理」。

**白屏 / 证书告警？**
本代理用自签证书，浏览器首次要「继续访问」。想彻底无告警，给代理传 `TLS_CERT` / `TLS_KEY`
（真域名证书，或 Cloudflare 托管证书）。用 App 内嵌 WebView 时，自签证书默认会被拒绝，需要自行放行。

**提示 Lost connection to the language server？**
代理重启会掐断页面到语言服务器的一批长连接。`mobile.js` 已内置兜底：连续 3 次失败会浮出「重新连接」按钮。

**标签页图标不更新？**
图标缓存很顽固，清理站点数据或重建桌面图标。

---

## 目录

```
src/server/web-poc/     反向代理、移动端适配、中文词表、preload shim
scripts/                start-mobile-web.sh（编排）、setup-cloudflare-tunnel.py
frpc/                   frp 启动脚本 + frpc.toml.example
cloudflare/             Cloudflare Tunnel 启动脚本
logo/                   favicon 源图与生成的多尺寸 PNG
docs/                   深入说明、上游 README
```

## 主要环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | 8790 | 代理监听端口（内网穿透的本地端口） |
| `WORKSPACE` | 仓库目录 | agent 的工作区 |
| `AG_ATTACH_URL` / `AG_CSRF_TOKEN` | — | 附加到一个已在运行的语言服务器 |
| `AUTH` / `AUTH_TOKEN` / `AUTH_TOKEN_FILE` | on | 访问令牌门禁 |
| `MOBILE_UI` / `UI_LANG` | 1 / auto | 移动端适配 / 中文界面 |
| `STRIP_GOOGLE_FONTS` / `BLOCK_EXTERNAL_FONTS` | 1 | 剥掉阻塞渲染的 Google Fonts |
| `STATIC_CACHE_SECONDS` | 3600 | 静态资源缓存时长（0 关闭） |
| `PROXY_FORWARD` / `LOCAL_PROXY_PORT` | — / 7999 | 语言服务器的出网代理 |
| `TLS_CERT` / `TLS_KEY` | 自签 | 自定义证书 |

## 已知限制 / 免责

- 本项目**不是**官方客户端，也不是 IDE 的扩展；它只是把语言服务器自带的前端搬进浏览器。
- 反向代理会自动注入 CSRF 令牌，等于把语言服务器的能力完全暴露给能访问该端口的人 —— **公网部署必须开令牌门禁**（默认已开）。
- 自签证书 + `noTLSVerify` 会关闭对中间人的防护，只应在你自己控制的链路上使用。
- 中文界面是词表替换，新版本前端新增文案需要补词表；移动端适配依赖前端的若干结构特征，前端大改后可能需要同步调整（失败时通常只是规则失效，不会弄坏页面）。
- 「Antigravity」「Gemini」等名称与图标归 Google 所有；本仓库仅作个人使用与学习交流。

## License

MIT（见 `LICENSE`）。上游部分代码版权归 [jkfujinami/antigravity-client](https://github.com/jkfujinami/antigravity-client) 作者所有，原始说明见 `docs/upstream-README.md`。
