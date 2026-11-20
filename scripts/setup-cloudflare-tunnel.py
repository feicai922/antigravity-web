#!/usr/bin/env python3
"""Create/configure the Antigravity Cloudflare Tunnel without printing credentials.

Creates (or reuses) a tunnel named ``antigravity``, points its ingress at the
local web-UI proxy (https://127.0.0.1:8790, self-signed → noTLSVerify), creates
the DNS CNAME for your hostname and stores the connector token in
``cloudflare/tunnel_token`` (mode 600) for ``cloudflare/start.sh``.

Usage:
    CLOUDFLARE_API_TOKEN=... CF_ACCOUNT_ID=... CF_ZONE_ID=... \
      AG_HOSTNAME=antigravity.example.com \
      python3 scripts/setup-cloudflare-tunnel.py

Env:
    CLOUDFLARE_API_TOKEN   API token with Tunnel:Edit + DNS:Edit on the zone
    CF_ACCOUNT_ID          Cloudflare account id
    CF_ZONE_ID             Cloudflare zone id (the domain that hosts AG_HOSTNAME)
    AG_HOSTNAME            public hostname to create, e.g. antigravity.example.com
    CF_PROXY               optional HTTP proxy for the API calls
    ORIGIN                 local origin (default https://127.0.0.1:8790)
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

BASE = "https://api.cloudflare.com/client/v4"
ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID", "").strip()
ZONE_ID = os.environ.get("CF_ZONE_ID", "").strip()
TUNNEL_NAME = os.environ.get("AG_TUNNEL_NAME", "antigravity").strip()
HOSTNAME = os.environ.get("AG_HOSTNAME", "").strip()
ORIGIN = os.environ.get("ORIGIN", "https://127.0.0.1:8790").strip()

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
TUNNEL_TOKEN_PATH = REPO / "cloudflare" / "tunnel_token"


def _api_token() -> str:
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    if token:
        return token
    raise SystemExit("缺少 CLOUDFLARE_API_TOKEN 环境变量。")


def _require_env() -> None:
    missing = [
        name for name, value in (
            ("CF_ACCOUNT_ID", ACCOUNT_ID),
            ("CF_ZONE_ID", ZONE_ID),
            ("AG_HOSTNAME", HOSTNAME),
        ) if not value
    ]
    if missing:
        raise SystemExit("缺少环境变量: " + ", ".join(missing))


def _opener():
    proxy = os.environ.get("CF_PROXY", "").strip()
    candidates = [proxy] if proxy else []
    for candidate in candidates:
        if not candidate:
            continue
        opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({"http": candidate, "https": candidate})
        )
        try:
            opener.open("https://api.cloudflare.com/client/v4/user/tokens/verify", timeout=10).read()
            print("使用代理 %s 访问 Cloudflare API。" % candidate)
            return opener
        except urllib.error.HTTPError:
            # 401/403 still proves the network path works.
            print("使用代理 %s 访问 Cloudflare API(已连通)。" % candidate)
            return opener
        except Exception:
            continue
    print("警告：没有可用代理，尝试直连 Cloudflare API。")
    return urllib.request.build_opener()


OPENER = None


def request(method, path, body=None):
    global OPENER
    if OPENER is None:
        OPENER = _opener()
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Authorization", "Bearer " + _api_token())
    req.add_header("Content-Type", "application/json")
    try:
        with OPENER.open(req, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        try:
            payload = json.loads(exc.read().decode("utf-8"))
            summary = "; ".join(item.get("message", "") for item in payload.get("errors", []))
        except Exception:
            summary = "HTTP " + str(exc.code)
        raise RuntimeError("Cloudflare API %s %s 失败：%s" % (method, path, summary or exc.code)) from exc
    if not payload.get("success"):
        summary = "; ".join(item.get("message", "") for item in payload.get("errors", []))
        raise RuntimeError("Cloudflare API %s %s 失败：%s" % (method, path, summary or "未知错误"))
    return payload.get("result")


def get_tunnel():
    tunnels = request("GET", "/accounts/%s/cfd_tunnel?is_deleted=false" % ACCOUNT_ID) or []
    return next((item for item in tunnels if item.get("name") == TUNNEL_NAME), None)


def ensure_dns(tunnel_id):
    query = urllib.parse.urlencode({"name": HOSTNAME})
    records = request("GET", "/zones/%s/dns_records?%s" % (ZONE_ID, query)) or []
    target = tunnel_id + ".cfargotunnel.com"
    conflicting = [item for item in records if item.get("type") != "CNAME"]
    if conflicting:
        kinds = ", ".join(sorted({item.get("type", "unknown") for item in conflicting}))
        raise RuntimeError("%s 已存在 %s 记录，未覆盖现有非 CNAME DNS。" % (HOSTNAME, kinds))
    body = {
        "type": "CNAME",
        "name": HOSTNAME,
        "content": target,
        "proxied": True,
        "ttl": 1,
        "comment": "Antigravity web UI tunnel",
    }
    if records:
        record = records[0]
        if record.get("content") == target and record.get("proxied"):
            print("DNS 已指向本隧道，保持不变。")
        else:
            request("PUT", "/zones/%s/dns_records/%s" % (ZONE_ID, record["id"]), body)
            print("DNS CNAME 已更新并启用 Cloudflare 代理。")
    else:
        request("POST", "/zones/%s/dns_records" % ZONE_ID, body)
        print("DNS CNAME 已创建并启用 Cloudflare 代理。")


def main():
    _require_env()
    query = urllib.parse.urlencode({"name": HOSTNAME})
    existing = request("GET", "/zones/%s/dns_records?%s" % (ZONE_ID, query)) or []
    if any(item.get("type") != "CNAME" for item in existing):
        kinds = ", ".join(sorted({item.get("type", "unknown") for item in existing}))
        raise RuntimeError("%s 已存在 %s 记录，未覆盖现有非 CNAME DNS。" % (HOSTNAME, kinds))

    tunnel = get_tunnel()
    if tunnel:
        tunnel_id = tunnel["id"]
        print("复用 Cloudflare 上已有的 %s 隧道。" % TUNNEL_NAME)
    else:
        tunnel = request(
            "POST",
            "/accounts/%s/cfd_tunnel" % ACCOUNT_ID,
            {"name": TUNNEL_NAME, "config_src": "cloudflare"},
        )
        tunnel_id = tunnel["id"]
        print("已在 Cloudflare 创建 %s 隧道。" % TUNNEL_NAME)

    ingress = [
        {
            "hostname": HOSTNAME,
            "service": ORIGIN,
            # The local web-UI proxy uses a self-signed certificate.
            "originRequest": {"noTLSVerify": True},
        },
        {"service": "http_status:404"},
    ]
    request(
        "PUT",
        "/accounts/%s/cfd_tunnel/%s/configurations" % (ACCOUNT_ID, tunnel_id),
        {"config": {"ingress": ingress}},
    )
    print("Tunnel ingress 已指向 %s（noTLSVerify）。" % ORIGIN)
    ensure_dns(tunnel_id)

    token = request("GET", "/accounts/%s/cfd_tunnel/%s/token" % (ACCOUNT_ID, tunnel_id))
    if not isinstance(token, str) or not token.strip():
        raise RuntimeError("Cloudflare 没有返回有效的隧道运行凭据。")
    TUNNEL_TOKEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    TUNNEL_TOKEN_PATH.write_text(token.strip() + "\n", encoding="utf-8")
    os.chmod(TUNNEL_TOKEN_PATH, 0o600)
    print("隧道运行凭据已写入 %s（600）。" % TUNNEL_TOKEN_PATH)
    print("TUNNEL_ID=" + tunnel_id)
    print("HOSTNAME=" + HOSTNAME)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
