#!/usr/bin/env node
/**
 * web-poc/server.ts — Serve the 本家 Antigravity UI as a web app.
 *
 * Architecture:
 *
 *   Browser ──HTTP/2 (TLS)──> this proxy ──HTTP/1.1 (TLS, many sockets)──> language_server
 *
 * WHY HTTP/2 ON THE BROWSER SIDE:
 *   The UI opens many long-lived server-streams at once (AgentState,
 *   ProjectUpdates, AppState, Sidecars, TrajectorySummaries, and one
 *   WatchDirectory PER OPEN FILE). Over HTTP/1.1 a browser allows only ~6
 *   connections per origin, so the extra infinite streams (notably the file
 *   WatchDirectory) get starved → file view spins forever. HTTP/2 multiplexes
 *   them all over a single connection, which is what the real app does
 *   (the LS is spoken to over h2). Browsers only do h2 over TLS, hence the
 *   self-signed cert below.
 *
 * The proxy also:
 *   - Injects the CSRF token header on every upstream request (browser never
 *     needs it) and rewrites Host/Origin/Referer to look same-origin to the LS.
 *   - Injects <script src="/__ag_shim.js"> as the first <head> child so the web
 *     port of preload.js (window.electron* globals) runs before the app bundle.
 *   - Strips CSP/HSTS on HTML and hop-by-hop headers (illegal in h2) on every
 *     response.
 *
 * Run:  npx tsx src/server/web-poc/server.ts [workspacePath] [geminiDir] [appDataDir]
 *       PORT=8765 VERBOSE=1 npx tsx src/server/web-poc/server.ts
 *       GEMINI_DIR=~/.gemini APP_DATA_DIR=antigravity npx tsx src/server/web-poc/server.ts
 *
 * geminiDir defaults to the real ~/.gemini profile and appDataDir to "antigravity"
 * (the IDE's namespace), so the UI shows your existing Projects AND conversations.
 * Override either (argv[3]/GEMINI_DIR, argv[4]/APP_DATA_DIR) for an isolated profile.
 * Close the Antigravity IDE first — two LS writing the same state can corrupt it.
 *
 * The cert is self-signed, so the browser shows a one-time warning — click
 * "Advanced → proceed to localhost". https://localhost is a secure context.
 */
import * as http from "http";
import * as http2 from "http2";
import * as https from "https";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";
import { randomBytes, timingSafeEqual } from "crypto";
// Type-only: the runtime import below is dynamic so attach mode (the normal
// deployment) never pays for loading the whole generated protobuf graph —
// ~10 s of require() time on this NFS checkout.
import type { Launcher } from "../launcher.js";

const PORT = Number(process.env.PORT) || 8765;
const WORKSPACE = process.argv[2] || process.cwd();
// State dir the LS reads existing Projects/history from (loaded from
// <geminiDir>/config/projects). Defaults to the real Antigravity profile so the
// web UI shows your existing Projects; override with argv[3] or GEMINI_DIR to
// point at an isolated/alternate profile. Don't share ~/.gemini with a running
// Antigravity IDE (two LS writing the same state can corrupt it).
const GEMINI_DIR = process.argv[3] || process.env.GEMINI_DIR || path.join(os.homedir(), ".gemini");
// App-data namespace under GEMINI_DIR (LS --app_data_dir). Conversations/history
// live in <GEMINI_DIR>/<appDataDir>/. Defaults to "antigravity" — the real IDE's
// namespace — so the web UI shows your existing conversations too; override with
// argv[4] or APP_DATA_DIR (e.g. "antigravity_client") for an isolated namespace.
const APP_DATA_DIR = process.argv[4] || process.env.APP_DATA_DIR || "antigravity";
const SHIM_PATH = "/__ag_shim.js";
const SHIM_FILE = path.join(__dirname, "preload-shim.js");
const SHIM_TAG = `<script src="${SHIM_PATH}"></script>`;

/**
 * Mobile adaptation (see mobile.css / mobile.js).
 * Opt out with MOBILE_UI=0. Enabled by default so the same server can be reached
 * from a phone through a tunnel without a second launch profile.
 */
/**
 * Attach mode: when set (`AG_ATTACH_URL=https://127.0.0.1:<port>`), proxy into an
 * already-running language server instead of launching one. Pair it with
 * AG_CSRF_TOKEN so upstream requests carry the right CSRF header.
 */
const ATTACH_URL = process.env.AG_ATTACH_URL?.trim() || "";
/**
 * Remove render-blocking third-party <link>/@import for Google Fonts from the
 * HTML. In mainland China fonts.googleapis.com is unreachable, and a failed
 * render-blocking stylesheet stalls the first paint for 10–30 s (the UI looks
 * like it is spinning forever). The app's font stacks already list system
 * fallbacks, so dropping the webfont costs a slightly different typeface.
 * Set STRIP_GOOGLE_FONTS=0 to keep it.
 */
const STRIP_GOOGLE_FONTS = process.env.STRIP_GOOGLE_FONTS !== "0";
/**
 * The app re-injects the Google Fonts stylesheet from JavaScript at startup, so
 * removing it from the HTML is not enough: a blocked stylesheet still stalls
 * first paint for 10–30 s. A minimal CSP fails the request instantly instead.
 * Only style-src/font-src are restricted, so images, XHR streams, WebSockets and
 * same-origin assets keep working. BLOCK_EXTERNAL_FONTS=0 disables this.
 */
const BLOCK_EXTERNAL_FONTS = process.env.BLOCK_EXTERNAL_FONTS !== "0";
const FONT_CSP = "style-src 'self' 'unsafe-inline'; font-src 'self' data: blob:";

/** Static asset extensions we are willing to cache in the browser/edge. */
const STATIC_ASSET_RE = /\.(?:js|mjs|css|woff2?|ttf|otf|svg|png|jpe?g|gif|webp|ico|map)(?:\?|$)/i;
const STATIC_CACHE_SECONDS = Number(process.env.STATIC_CACHE_SECONDS ?? 3600);
function isStaticAsset(url: string): boolean { return STATIC_ASSET_RE.test(url); }
const MOBILE_ENABLED = process.env.MOBILE_UI !== "0";

/**
 * Favicon / home-screen icon.
 *
 * The upstream app ships no icon link, so every path (including /favicon.ico)
 * falls through to the SPA HTML — the browser then draws its generic "globe"
 * placeholder in the tab. We serve real PNGs from `logo/` (generated from
 * logo/antigravity-color.webp) and inject the <link rel="icon"> tags.
 * ICON_DIR can point elsewhere; missing files simply disable the injection.
 */
const ICON_DIR = process.env.ICON_DIR || path.resolve(__dirname, "../../../logo");
const ICON_FILES: Record<string, string> = {
  "/__ag_icon-32.png": "favicon-32.png",
  "/__ag_icon-48.png": "favicon-48.png",
  "/__ag_icon-180.png": "favicon-180.png",
  "/__ag_icon-192.png": "favicon-192.png",
  // Browsers request this implicitly even when a <link rel=icon> exists.
  "/favicon.ico": "favicon-32.png",
};

function serveIcon(req: http2.Http2ServerRequest, res: http2.Http2ServerResponse): boolean {
  const file = ICON_FILES[req.url || ""];
  if (!file) return false;
  let body: Buffer | null = null;
  // src layout: <repo>/src/server/web-poc -> ../../../logo
  // dist layout: <repo>/dist/src/server/web-poc -> ../../../../logo
  const candidates = [
    ICON_DIR,
    path.resolve(__dirname, "../../../logo"),
    path.resolve(__dirname, "../../../../logo"),
  ];
  for (const dir of candidates) {
    const full = path.join(dir, file);
    try {
      if (fs.existsSync(full)) { body = fs.readFileSync(full); break; }
    } catch { /* keep looking */ }
  }
  if (!body) return false;
  res.writeHead(200, {
    "content-type": "image/png",
    "content-length": String(body.length),
    // Icons are static; a day of caching is plenty and avoids re-fetching.
    "cache-control": "public, max-age=86400",
  });
  res.end(body);
  return true;
}

/**
 * UI language for the injected Chinese text layer (locale-zh.js).
 *   UI_LANG=zh    always inject
 *   UI_LANG=en    never inject
 *   UI_LANG=auto  (default) inject when the browser asks for Chinese, i.e. the
 *                 request's Accept-Language contains zh — what a phone set to
 *                 简体中文 sends.
 */
const UI_LANG = (process.env.UI_LANG || "auto").toLowerCase();
const LOCALE_ZH_PATH = "/__ag_locale_zh.js";
const LOCALE_ZH_FILE = path.join(__dirname, "locale-zh.js");

function wantsZh(req: http2.Http2ServerRequest): boolean {
  if (UI_LANG === "zh" || UI_LANG === "zh-cn" || UI_LANG === "zh_cn") return true;
  if (UI_LANG === "en") return false;
  const al = String(req.headers["accept-language"] || "");
  return /zh(-|\b)|\bzh\b/i.test(al);
}
const MOBILE_CSS_PATH = "/__ag_mobile.css";
const MOBILE_JS_PATH = "/__ag_mobile.js";
const MOBILE_CSS_FILE = path.join(__dirname, "mobile.css");
const MOBILE_JS_FILE = path.join(__dirname, "mobile.js");

/**
 * Locate the Antigravity Language Server binary.
 *
 * The web POC was written against the desktop app layout
 * (/opt/Antigravity/resources/bin/language_server), but the Linux CLI / IDE
 * install drops the same Go binary at ~/.gemini/bin/agy. Precedence:
 * LS_BINARY env → known install locations → the desktop default.
 */
function resolveLsBinary(): string {
  const fromEnv = process.env.LS_BINARY?.trim() || process.env.AGY_BIN?.trim();
  if (fromEnv) return fromEnv;
  const candidates = [
    path.join(os.homedir(), ".gemini", "bin", "agy"),
    "/opt/Antigravity/resources/bin/language_server",
    "/usr/share/antigravity/resources/bin/language_server",
    "/usr/lib/antigravity/resources/bin/language_server",
  ];
  return candidates.find((p) => fs.existsSync(p)) || candidates[1];
}
const LS_BINARY = resolveLsBinary();

/* ---------------------------------------------------------------------------
 * Access token
 *
 * The proxy is reachable from the internet through an frp / Cloudflare tunnel,
 * so every request must carry a token or the UI (and with it the agent, the
 * terminal and the whole workspace) would be open to anyone holding the URL.
 *
 *   AUTH=off                 disable the gate (LAN / Tailscale only)
 *   AUTH_TOKEN=<token>       use this token instead of the stored one
 *   AUTH_TOKEN_FILE=...      read/write the token here
 *   AUTH_MAX_AGE=<seconds>   cookie lifetime (default 365 days)
 *
 * The token lives in .mobile-web/auth_token (mode 600) so restarting the proxy
 * — or the tunnel — does not lock the phone out; delete that file (or run
 * `scripts/start-mobile-web.sh token --rotate`) to rotate it.
 * ------------------------------------------------------------------------ */
const AUTH_ENABLED = (process.env.AUTH || "on").toLowerCase() !== "off";
/**
 * Repo root, regardless of whether we run from src/ (tsx) or dist/ (node).
 * Done by walking up to the directory that holds package.json + src/, because
 * the relative depth changes between the two layouts and the access token must
 * be the same file either way — otherwise a dist run would mint a second token
 * and the browser's cookie would stop matching.
 */
function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    try {
      if (
        fs.existsSync(path.join(dir, "package.json")) &&
        fs.existsSync(path.join(dir, "src"))
      ) {
        return dir;
      }
    } catch { /* keep walking */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}
const REPO_ROOT = findRepoRoot(__dirname);
const AUTH_TOKEN_FILE =
  process.env.AUTH_TOKEN_FILE || path.join(REPO_ROOT, ".mobile-web", "auth_token");
const AUTH_COOKIE = "ag_auth";
const AUTH_MAX_AGE = Number(process.env.AUTH_MAX_AGE || 365 * 24 * 3600);

function loadOrCreateToken(): string {
  const fromEnv = process.env.AUTH_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    if (fs.existsSync(AUTH_TOKEN_FILE)) {
      const existing = fs.readFileSync(AUTH_TOKEN_FILE, "utf-8").trim();
      if (existing) return existing;
    }
    const token = randomBytes(24).toString("base64url");
    fs.mkdirSync(path.dirname(AUTH_TOKEN_FILE), { recursive: true });
    fs.writeFileSync(AUTH_TOKEN_FILE, token + "\n", { mode: 0o600 });
    return token;
  } catch (e) {
    console.error(`[poc] could not persist the access token (${String(e)}); using an in-memory one`);
    return randomBytes(24).toString("base64url");
  }
}
const AUTH_TOKEN = AUTH_ENABLED ? loadOrCreateToken() : "";

function tokenMatches(candidate: string): boolean {
  if (!candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(AUTH_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieToken(cookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(cookieHeader) ? cookieHeader.join("; ") : String(cookieHeader || "");
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === AUTH_COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
}

/** Minimal, self-contained login page (no app assets, works on a phone). */
function loginPage(failed: boolean): string {
  return `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#161618">
<title>需要访问令牌 · Antigravity</title>
<link rel="icon" type="image/png" sizes="32x32" href="/__ag_icon-32.png">
<link rel="apple-touch-icon" sizes="180x180" href="/__ag_icon-180.png">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100dvh; display: flex; align-items: center; justify-content: center;
         background: #101013; color: #e7e7ea; font: 16px/1.5 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
         padding: 24px calc(20px + env(safe-area-inset-left)) calc(24px + env(safe-area-inset-bottom)); }
  form { width: 100%; max-width: 420px; }
  h1 { margin: 0 0 6px; font-size: 20px; font-weight: 600; }
  p  { margin: 0 0 20px; color: #9a9aa5; font-size: 14px; }
  input { width: 100%; padding: 14px 16px; font-size: 16px; border-radius: 12px;
          border: 1px solid #33333c; background: #17171b; color: #e7e7ea; outline: none; }
  input:focus { border-color: #2f71e3; }
  button { margin-top: 12px; width: 100%; padding: 15px 16px; font-size: 16px; font-weight: 600;
           border: 0; border-radius: 12px; background: #2f71e3; color: #fff; }
  .err { margin-top: 14px; color: #de5555; font-size: 14px; }
  .hint { margin-top: 18px; color: #6a6a76; font-size: 12px; }
</style></head>
<body>
<form method="GET" action="/">
  <h1>访问令牌</h1>
  <p>这个地址需要验证后才能访问。请粘贴启动日志里显示的令牌。</p>
  <input name="t" type="password" autocomplete="current-password" autofocus
         inputmode="text" autocapitalize="off" spellcheck="false" placeholder="令牌">
  <button type="submit">进入</button>
  ${failed ? '<div class="err">令牌不正确，请重试。</div>' : ""}
  <div class="hint">令牌保存在服务器的 .mobile-web/auth_token；可在启动脚本里查看或轮换。</div>
</form>
</body></html>`;
}

// Generated TLS certs live OUTSIDE the package tree (a private key must never be
// shipped in the npm tarball), in a stable per-user dir so the browser only warns
// once. ensureCert() creates them here on first run.
const CERT_DIR = path.join(os.homedir(), ".gemini", "web-poc-certs");

// Hop-by-hop headers — illegal in HTTP/2 responses, must be stripped.
const HOP_BY_HOP = [
  "connection", "keep-alive", "transfer-encoding", "upgrade",
  "proxy-connection", "te", "trailer",
];

/**
 * True for requests whose response may be HTML we must buffer and rewrite.
 * Those need `accept-encoding: identity`; everything else (notably the ~12 MB
 * main.js bundle) is piped straight through, so it keeps the browser's
 * accept-encoding and arrives gzipped — the difference between a 12 MB and a
 * 3.8 MB first load, which matters a lot over a phone connection.
 */
function wantsHtmlResponse(req: http2.Http2ServerRequest): boolean {
  const dest = String(req.headers["sec-fetch-dest"] || "");
  if (dest === "document" || dest === "iframe" || dest === "frame") return true;
  const accept = String(req.headers["accept"] || "");
  if (accept.includes("text/html")) return true;
  const url = req.url || "";
  return url === "/" || /\.html?(\?|$)/.test(url);
}

/** Drop Google-Fonts links/preconnects that block first paint outside the US. */
/**
 * A <link> tag, quote-aware.
 *
 * The app ships its default favicon as an inline data URI that contains real
 * markup (`href="data:image/svg+xml,<svg …><text>🎁</text></svg>"`), i.e. a `>`
 * inside a quoted attribute value. The naive `[^>]*` pattern stopped at that
 * `>`, removed only the head of the tag and left `🎁" />` behind — which the
 * browser then rendered as stray text in the page's top-left corner.
 */
const LINK_TAG_RE = /<link\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;

/** Drop the app's own (or default) icon links so ours is the only one. */
function stripIcons(html: string): string {
  return html.replace(LINK_TAG_RE, (tag) => (/\brel\s*=\s*["'][^"']*icon/i.test(tag) ? "" : tag));
}

function stripGoogleFonts(html: string): string {
  if (!STRIP_GOOGLE_FONTS) return html;
  return html
    .replace(LINK_TAG_RE, (tag) => (/fonts\.(googleapis|gstatic)\.com/i.test(tag) ? "" : tag))
    .replace(/@import\s+url\(\s*["']?https?:\/\/fonts\.(googleapis|gstatic)\.com[^)]*\)\s*;?/gi, "");
}

function injectShim(html: string, req?: http2.Http2ServerRequest): string {
  html = stripIcons(stripGoogleFonts(html));
  const tags = SHIM_TAG + mobileTags(req);
  const headRe = /<head[^>]*>/i;
  if (headRe.test(html)) return html.replace(headRe, (m) => m + tags);
  const htmlRe = /<html[^>]*>/i;
  if (htmlRe.test(html)) return html.replace(htmlRe, (m) => m + tags);
  return tags + html;
}

/** Viewport + mobile stylesheet/script tags, injected into <head>. */
function mobileTags(req?: http2.Http2ServerRequest): string {
  const zh = req ? wantsZh(req) : UI_LANG === "zh";
  const localeTag = zh ? `<script src="${LOCALE_ZH_PATH}" defer></script>` : "";
  if (!MOBILE_ENABLED) return localeTag;
  return [
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<meta name="mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
    '<meta name="theme-color" content="#1e1e1e">',
    '<link rel="icon" type="image/png" sizes="32x32" href="/__ag_icon-32.png">',
    '<link rel="icon" type="image/png" sizes="48x48" href="/__ag_icon-48.png">',
    '<link rel="icon" type="image/png" sizes="192x192" href="/__ag_icon-192.png">',
    '<link rel="apple-touch-icon" sizes="180x180" href="/__ag_icon-180.png">',
    `<link rel="stylesheet" href="${MOBILE_CSS_PATH}">`,
    `<script src="${MOBILE_JS_PATH}" defer></script>`,
    localeTag,
  ].join("");
}

/** Find the openssl binary — checks common bundled locations on Windows first. */
function findOpenssl(): string {
  if (process.platform === "win32") {
    const candidates = [
      path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "usr", "bin", "openssl.exe"),
      path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Git", "usr", "bin", "openssl.exe"),
      path.join(process.env.ProgramFiles || "C:\\Program Files", "OpenSSL-Win64", "bin", "openssl.exe"),
      path.join(process.env.ProgramFiles || "C:\\Program Files", "OpenSSL", "bin", "openssl.exe"),
    ];
    const found = candidates.find(p => fs.existsSync(p));
    if (found) return found;
  }
  return "openssl"; // fall back to PATH
}

/**
 * Load TLS credentials.
 * Priority: TLS_CERT/TLS_KEY env vars → existing self-signed → generate new self-signed.
 *
 * For Tailscale HTTPS (recommended for remote access):
 *   tailscale cert --cert-file ~/.gemini/web-poc-certs/tailscale.crt \
 *                  --key-file  ~/.gemini/web-poc-certs/tailscale.key \
 *                  <hostname>.ts.net
 *   TLS_CERT=~/.gemini/web-poc-certs/tailscale.crt TLS_KEY=~/.gemini/web-poc-certs/tailscale.key npm run web
 */
function ensureCert(): { key: Buffer; cert: Buffer } {
  // 1. External certificate via environment variables
  const extCert = process.env.TLS_CERT?.trim();
  const extKey = process.env.TLS_KEY?.trim();
  if (extCert && extKey) {
    if (!fs.existsSync(extCert)) throw new Error(`[poc] TLS_CERT file not found: ${extCert}`);
    if (!fs.existsSync(extKey)) throw new Error(`[poc] TLS_KEY file not found: ${extKey}`);
    console.log(`[poc] using external TLS cert: ${extCert}`);
    return { key: fs.readFileSync(extKey), cert: fs.readFileSync(extCert) };
  }

  // 2. Self-signed certificate (generate on first run)
  const keyPath = path.join(CERT_DIR, "key.pem");
  const certPath = path.join(CERT_DIR, "cert.pem");
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    fs.mkdirSync(CERT_DIR, { recursive: true });
    const opensslBin = findOpenssl();
    console.log(`[poc] generating self-signed localhost cert… (${opensslBin})`);
    // On some Windows openssl builds, -subj needs //CN= instead of /CN=
    const subj = process.platform === "win32" ? "//CN=localhost" : "/CN=localhost";
    try {
      execFileSync(opensslBin, [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", keyPath, "-out", certPath, "-days", "3650",
        "-subj", subj,
        "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ], { stdio: "ignore" });
    } catch (e) {
      throw new Error(
        `[poc] Failed to generate TLS certificate. openssl is required.\n` +
        (process.platform === "win32"
          ? `On Windows, install OpenSSL via one of:\n` +
            `  - Git for Windows (includes openssl): https://git-scm.com/\n` +
            `  - choco install openssl\n` +
            `  - winget install ShiningLight.OpenSSL\n`
          : `Please install openssl and try again.\n`) +
        `Or manually place key.pem and cert.pem in: ${CERT_DIR}`
      );
    }
  }
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

/**
 * Access control: only allow connections from localhost or Tailscale CGNAT range.
 * This prevents unauthorized access from the local Wi-Fi network, which is critical
 * because the proxy auto-injects CSRF tokens and the UI can execute terminal commands.
 */
function isAllowedClient(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  // Normalize IPv6-mapped IPv4 (e.g., ::ffff:127.0.0.1 → 127.0.0.1)
  const ip = remoteAddress.replace(/^::ffff:/, "");
  // Allow localhost
  if (ip === "127.0.0.1" || ip === "::1") return true;
  // Allow Tailscale CGNAT range (100.64.0.0/10 → 100.64.x.x – 100.127.x.x)
  const parts = ip.split(".");
  if (parts.length === 4) {
    const first = parseInt(parts[0], 10);
    const second = parseInt(parts[1], 10);
    if (first === 100 && second >= 64 && second <= 127) return true;
  }
  return false;
}

async function main() {
  let launcher: Launcher | null = null;
  let upstreamHost = "127.0.0.1";
  let upstreamPort = 0;
  let csrf = "";

  if (ATTACH_URL) {
    // ATTACH MODE (AG_ATTACH_URL): proxy an already-running language server
    // instead of spawning one. Needed on Linux CLI/IDE builds, whose `agy`
    // binary takes a different flag set (`--hub ...`) than the desktop
    // `language_server`, so Launcher's handshake does not apply.
    const u = new URL(ATTACH_URL);
    upstreamHost = u.hostname;
    upstreamPort = Number(u.port || 443);
    csrf = process.env.AG_CSRF_TOKEN?.trim() || "";
    console.log(`[poc] Attaching to existing LS at ${upstreamHost}:${upstreamPort} (mobileUI: ${MOBILE_ENABLED})...`);
  } else {
    console.log(`[poc] Launching language_server (workspace: ${WORKSPACE}, geminiDir: ${GEMINI_DIR}, appDataDir: ${APP_DATA_DIR}, binary: ${LS_BINARY}, mobileUI: ${MOBILE_ENABLED})...`);
    const { Launcher } = await import("../launcher.js");
    launcher = await Launcher.start({ workspacePath: WORKSPACE, geminiDir: GEMINI_DIR, appDataDir: APP_DATA_DIR, lsBinaryPath: LS_BINARY, verbose: !!process.env.VERBOSE });
    upstreamPort = launcher.httpsPort;
    csrf = launcher.csrfToken;
  }

  const upstreamOrigin = `https://${upstreamHost}:${upstreamPort}`;
  console.log(`[poc] LS ready: HTTPS ${upstreamPort}, csrf ${csrf.slice(0, 8)}…`);

  const shimSource = fs.readFileSync(SHIM_FILE);
  const { key, cert } = ensureCert();

  // Many concurrent infinite streams fan out to many upstream sockets.
  const agent = new https.Agent({ rejectUnauthorized: false, maxSockets: Infinity, keepAlive: true });

  const handler = (req: http2.Http2ServerRequest, res: http2.Http2ServerResponse) => {
    // --- Access control: reject requests from untrusted networks ---
    const clientIp = req.socket.remoteAddress;
    if (!isAllowedClient(clientIp)) {
      console.warn(`[poc] BLOCKED connection from ${clientIp}`);
      res.writeHead(403);
      res.end("Forbidden: access is restricted to localhost and Tailscale VPN.");
      return;
    }
    // Chinese text layer.
    if (req.url === LOCALE_ZH_PATH) {
      let body = "";
      try { body = fs.readFileSync(LOCALE_ZH_FILE, "utf-8"); } catch (e) { /* asset missing */ }
      res.writeHead(200, {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(body);
      return;
    }

    // Icons are public: they must load on the login page too.
    if (serveIcon(req, res)) return;

    // --- Access token gate ---------------------------------------------
    if (AUTH_ENABLED) {
      const reqUrl = req.url || "/";
      const qIndex = reqUrl.indexOf("?");
      const params = new URLSearchParams(qIndex >= 0 ? reqUrl.slice(qIndex + 1) : "");
      const provided = params.get("t");
      const wantsHtml =
        String(req.headers.accept || "").includes("text/html") ||
        String(req.headers["sec-fetch-dest"] || "") === "document";

      if (provided) {
        if (tokenMatches(provided)) {
          // Good token: remember it in a cookie and drop it from the URL.
          const rest = qIndex >= 0 ? reqUrl.slice(0, qIndex) || "/" : "/";
          res.writeHead(302, {
            "set-cookie": `${AUTH_COOKIE}=${encodeURIComponent(AUTH_TOKEN)}; Path=/; Max-Age=${AUTH_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`,
            location: rest,
            "cache-control": "no-store",
          });
          res.end();
          return;
        }
        res.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(loginPage(true));
        return;
      }

      if (!tokenMatches(cookieToken(req.headers.cookie))) {
        if (wantsHtml) {
          res.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          res.end(loginPage(false));
        } else {
          res.writeHead(401, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
          res.end("unauthorized");
        }
        return;
      }
    }

    // Serve the mobile adaptation assets (only when enabled).
    if (MOBILE_ENABLED && (req.url === MOBILE_CSS_PATH || req.url === MOBILE_JS_PATH)) {
      const isCss = req.url === MOBILE_CSS_PATH;
      let body = "";
      try {
        body = fs.readFileSync(isCss ? MOBILE_CSS_FILE : MOBILE_JS_FILE, "utf-8");
      } catch (e) {
        console.warn(`[poc] mobile asset missing: ${isCss ? MOBILE_CSS_FILE : MOBILE_JS_FILE}`);
      }
      res.writeHead(200, {
        "content-type": isCss ? "text/css; charset=utf-8" : "application/javascript; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(body);
      return;
    }

    // Serve the shim itself.
    if (req.url === SHIM_PATH) {
      res.writeHead(200, {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(shimSource);
      return;
    }

    // Upstream headers: spoof same-origin + inject CSRF, force identity.
    // Drop HTTP/2 pseudo-headers (":path" etc.) — invalid for an h1 upstream.
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!k.startsWith(":")) headers[k] = v as string | string[];
    }
    headers["host"] = `${upstreamHost}:${upstreamPort}`;
    headers["x-codeium-csrf-token"] = csrf;
    if (headers["origin"]) headers["origin"] = upstreamOrigin;
    if (headers["referer"]) {
      headers["referer"] = String(headers["referer"]).replace(/^https?:\/\/[^/]+/i, upstreamOrigin);
    }
    // Identity only where we rewrite the body; let everything else be compressed.
    if (wantsHtmlResponse(req)) delete headers["accept-encoding"];

    const upReq = https.request(
      { host: upstreamHost, port: upstreamPort, method: req.method, path: req.url, headers, agent },
      (upRes) => {
        const ct = String(upRes.headers["content-type"] || "");
        const isHtml = ct.includes("text/html");

        const outHeaders: http.OutgoingHttpHeaders = {};
        for (const [k, v] of Object.entries(upRes.headers)) {
          const lk = k.toLowerCase();
          if (HOP_BY_HOP.includes(lk)) continue;          // illegal in h2
          if (lk === "content-security-policy") continue; // would block our shim
          if (lk === "content-security-policy-report-only") continue;
          if (lk === "strict-transport-security") continue;
          outHeaders[k] = v as string | string[];
        }

        if (!isHtml) {
          // The UI ships unhashed asset names and the LS answers `cache-control:
          // no-cache`, so every visit re-downloads the ~3.8 MB bundle. Give
          // static assets a short shared cache instead: repeat opens on a phone
          // then cost nothing, while an app update still lands within the hour.
          if (STATIC_CACHE_SECONDS > 0 && isStaticAsset(req.url || "")) {
            outHeaders["cache-control"] = `public, max-age=${STATIC_CACHE_SECONDS}, stale-while-revalidate=86400`;
          }
          res.writeHead(upRes.statusCode || 502, outHeaders);
          upRes.pipe(res);
          return;
        }

        // Buffer HTML, inject the shim, fix content-length.
        const chunks: Buffer[] = [];
        upRes.on("data", (c) => chunks.push(c));
        upRes.on("end", () => {
          const buf = Buffer.from(injectShim(Buffer.concat(chunks).toString("utf-8"), req), "utf-8");
          delete outHeaders["content-encoding"];
          outHeaders["content-length"] = String(buf.length);
          if (BLOCK_EXTERNAL_FONTS) outHeaders["content-security-policy"] = FONT_CSP;
          // Injected tags depend on Accept-Language (UI_LANG=auto).
          outHeaders["vary"] = "Accept-Language";
          res.writeHead(upRes.statusCode || 200, outHeaders);
          res.end(buf);
        });
      }
    );

    upReq.on("error", (err) => {
      console.error(`[poc] upstream error for ${req.url}:`, err.message);
      if (!res.headersSent) res.writeHead(502);
      res.end("Upstream error: " + err.message);
    });

    req.pipe(upReq);
  };

  const server = http2.createSecureServer({ key, cert, allowHTTP1: true }, handler);
  server.on("sessionError", (err) => console.error("[poc] h2 session error:", err.message));

  server.listen(PORT, () => {
    console.log("\n" + "=".repeat(60));
    console.log(`  本家UI (web):  https://localhost:${PORT}/   (HTTP/2)`);
    console.log(`  Upstream LS:    ${upstreamOrigin}`);
    console.log("=".repeat(60) + "\n");
    if (AUTH_ENABLED) {
    console.log("Access token required. Open with:");
    console.log(`  https://<this-host>:${PORT}/?t=${AUTH_TOKEN}`);
    console.log(`(token file: ${AUTH_TOKEN_FILE})`);
  } else {
    console.log("AUTH=off — no token required.");
  }
  console.log("Accept the self-signed cert warning once.");
  });

  const shutdown = async () => {
    console.log("\n[poc] shutting down…");
    server.close();
    await launcher?.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[poc] fatal:", err);
  process.exit(1);
});
