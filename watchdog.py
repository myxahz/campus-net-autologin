# -*- coding: utf-8 -*-
"""
Campus-network watchdog (auto-reconnect helper).

What it does:
  * Determines whether this PC is on the campus network
    (any local IPv4 inside campus_subnet, default 10.60.0.0/16).
  * If on campus, probes whether the portal session is still alive using
    several captive-portal beacons. Each probe is classified as:
        online  - strong proof we reached the real outside world
        offline - strong proof we were hijacked by the captive portal
        unknown - inconclusive (errors, 5xx, empty body, ...)
    A beacon is never trusted on its status code alone: the response body is
    sniffed for login-host fingerprints, and a "generate_204" beacon must
    answer a real empty 204. That is what catches a portal which replays
    HTTP 200 + login HTML while leaving the URL untouched (Srun-style).
    Aggregate rule: a single "offline" wins; "online" needs a strict 204
    beacon (or every beacon) to pass; otherwise it is inconclusive -> keep
    the previous state, and if that persists for too long, treat it as
    logged out.
  * Publishes the result on http://127.0.0.1:<port>/status as JSON, for the
    companion browser extension to consume.
  * Never opens a browser itself, and never touches your password.

Scope: Beijing Jiaotong University only (login.bjtu.edu.cn), Windows only.
If the campus portal or the campus subnet changes, edit config.json; if the
login host changes, also edit windows/plugin/manifest.json. See README.

Log file: %TEMP%\\bjtu-net-autologin.log
"""

import csv
import ipaddress
import json
import os
import re
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "config.json")
LOG_PATH = os.path.join(tempfile.gettempdir(), "bjtu-net-autologin.log")

DEFAULTS = {
    "host": "login.bjtu.edu.cn",
    "login_url_template": (
        "https://login.bjtu.edu.cn/a79.htm?userip={userip}"
        "&usermac={usermac}&nas%2dip={nas_ip_encoded}"
    ),
    "login_url_static": "",
    "usermac": "",
    "nas_ip_encoded": "4%2e4%2e110%2e110",
    "campus_subnet": "10.60.0.0/16",
    "probe_urls": [
        {"url": "http://connect.rom.miui.com/generate_204", "expect_204": True},
        {"url": "http://www.baidu.com", "expect_204": False},
    ],
    "hijack_keywords": ["login.bjtu.edu.cn", "a79.htm", "注销页"],
    "unknown_streak_limit": 3,
    "poll_interval_sec": 30,
    "local_port": 5180,
    "http_timeout_sec": 5,
    "auto_open_login_page": True,
    "login_open_interval_sec": 180,
    "login_open_max_per_outage": 3,
    "login_tabs_ttl_sec": 300,
}

STATE_LOCK = threading.Lock()
STATE = {
    "on_campus": False,
    "unknown_streak": 0,
    "logged_in": None,
    "need_login": False,
    "login_url": "",
    "local_ip": "",
    "title": "",
    "reason": "starting",
    "last_check": "",
    "checks": 0,
    "auto_open_count": 0,
    "last_auto_open": "",
    "login_tabs": None,
    "login_tabs_at": 0.0,
}


def log(msg):
    try:
        line = "%s %s\n" % (datetime.now().strftime("%Y/%m/%d %H:%M:%S"), msg)
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception:
        pass


def rotate_log(max_bytes=4 * 1024 * 1024):
    """Keep the debug log from growing without bound across restarts."""
    try:
        if os.path.getsize(LOG_PATH) > max_bytes:
            os.replace(LOG_PATH, LOG_PATH + ".1")
    except Exception:
        pass


def load_config():
    cfg = dict(DEFAULTS)
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg.update(json.load(f))
    except Exception as e:
        log("config load failed (%r); using defaults" % (e,))
    return cfg


def get_local_ip():
    """Return (primary_outbound_ip, [all_local_ipv4])."""
    primary = ""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))  # no packets actually sent
            primary = s.getsockname()[0]
        finally:
            s.close()
    except Exception:
        primary = ""

    ips = []
    if primary:
        ips.append(primary)
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            a = info[4][0]
            if a not in ips:
                ips.append(a)
    except Exception:
        pass
    return primary, ips


# Adapter descriptions that are never the one the campus gateway sees.
_NON_PHYSICAL = (
    "bluetooth", "virtual", "vpn", "tap-", "tap ", "wi-fi direct",
    "wireless direct", "wi-fi network direct", "loopback", "hyper-v",
    "vmware", "virtualbox", "tunnel", "miniport", "pseudo", "npcap",
    "zerotier", "tailscale", "docker", "wsl", "teredo", "isatap",
    "wan miniport", "system", "kernel debug",
)

_MAC_CACHE = {"value": None}


def list_local_macs():
    """Yield (mac_grouped, description, connected) for each adapter.

    Uses the built-in `getmac` tool, which ships with every Windows install.
    Returns [] when it is unavailable.
    """
    try:
        raw = subprocess.run(
            ["getmac", "/v", "/fo", "csv"],
            capture_output=True, timeout=15,
        ).stdout
    except Exception:
        return []
    if not raw:
        return []
    text = raw.decode("gbk", "replace")  # Chinese Windows console codepage
    rows = []
    for row in csv.reader(text.splitlines()):
        if len(row) < 4:
            continue
        desc = (row[1] or "").strip()
        phys = (row[2] or "").strip()
        conn = (row[3] or "").strip()
        if not re.fullmatch(r"(?:[0-9A-Fa-f]{2}-){5}[0-9A-Fa-f]{2}", phys):
            continue
        # Connected adapters expose their transport as \Device\Tcpip_{GUID};
        # disconnected ones show a localized "media disconnected" string.
        rows.append((phys.replace("-", "").upper(), desc, "Tcpip" in conn))
    return rows


def get_mac_dash():
    """Best-effort MAC of the physical adapter: 12 hex digits, 4-4-4 groups.

    uuid.getnode() alone is not good enough here: on a laptop it frequently
    returns the Bluetooth PAN or a virtual adapter (e.g. Wi-Fi Direct, VPN)
    rather than the Wi-Fi/Ethernet adapter the campus gateway authenticates
    against, which would put a wrong usermac into the login URL.
    """
    if _MAC_CACHE["value"] is not None:
        return _MAC_CACHE["value"]

    ranked = []
    for mac, desc, connected in list_local_macs():
        low = desc.lower()
        if any(h in low for h in _NON_PHYSICAL):
            continue
        ranked.append((0 if connected else 1, mac, desc))

    mac = ""
    if ranked:
        ranked.sort(key=lambda c: c[0])
        mac = ranked[0][1]
        hx = "-".join(mac[i:i + 4] for i in range(0, 12, 4))
        detail = ", ".join("%s=%s%s" % ("connected" if c[0] == 0 else "down",
                                        c[2] or "?", "(" + c[1] + ")")
                           for c in ranked)
        log("mac picked %s from %d candidate(s): %s" % (hx, len(ranked), detail))
    else:
        try:
            node = uuid.getnode()
        except Exception:
            node = 0
        if node and not ((node >> 40) & 0x01):
            hx0 = "%012X" % node
            mac = hx0
            hx = "-".join(mac[i:i + 4] for i in range(0, 12, 4))
            log("mac fallback to uuid.getnode(): %s (no physical adapter "
                "matched; set \"usermac\" in config.json to override)" % hx)
        else:
            hx = ""
            log("mac unavailable; set \"usermac\" in config.json to override")

    _MAC_CACHE["value"] = hx
    return hx


def in_subnet(ip, subnet):
    try:
        return ipaddress.ip_address(ip) in ipaddress.ip_network(subnet, strict=False)
    except Exception:
        return False


def build_login_url(cfg, local_ip):
    tmpl = cfg.get("login_url_template") or ""
    usermac = cfg.get("usermac") or get_mac_dash()
    nas = cfg.get("nas_ip_encoded", "")
    if tmpl and local_ip and usermac:
        try:
            return tmpl.format(userip=local_ip, usermac=usermac,
                               nas_ip_encoded=nas)
        except Exception:
            pass
    return cfg.get("login_url_static", "")


def open_login_page(url):
    """Open the login page in the default browser the way a human would.

    os.startfile() calls ShellExecute, i.e. exactly what happens when the .url
    shortcut on the desktop is double-clicked. That is not cosmetic: Chromium
    only autofills the saved password for a navigation it treats as a normal
    browser navigation. Pages opened by the extension (tabs.update/tabs.create)
    were logged as "autofill ready: false" every single time on 2026-10-01,
    while a shell-opened page filled both boxes and logged in on the first
    click. Python is the only side that can do this, hence the split.

    cmd /c start is NOT used: cmd expands %..% sequences, and this URL carries
    percent-escapes (nas%2dip=4%2e4%2e110%2e110). startfile keeps it verbatim.
    """
    if not url or "login.bjtu.edu.cn" not in url:
        log("auto-open skipped: no usable login url (%r)" % (url,))
        return False
    if not hasattr(os, "startfile"):
        log("auto-open skipped: os.startfile is Windows-only")
        return False
    try:
        os.startfile(url)
        return True
    except Exception as e:
        log("auto-open failed (%r)" % (e,))
        return False


def maybe_open_login_page(snap, cfg, gate, now=None):
    """Decide whether to open the login page, and do it.

    Kept out of main() so the throttling can be unit-tested without a browser.
    gate is a dict holding {"last_ts", "count"}; it is updated in place.

    Rules:
      - only while the session is down (need_login);
      - skipped entirely while the browser still has a login tab open (the
        extension reports that through POST /tabs; the report has to be fresh,
        otherwise a stale one would block the fallback forever);
      - at most once per login_open_interval_sec;
      - at most login_open_max_per_outage times per outage, so a long outage
        (laptop left on, network gone) cannot fill the browser with tabs;
      - the counters reset as soon as the session is healthy, so the next drop
        reacts immediately instead of waiting out the interval;
      - a failed open does NOT consume the budget (we retry next round).
    """
    now = time.time() if now is None else now
    if not cfg.get("auto_open_login_page", True) or not snap.get("need_login"):
        gate["last_ts"] = 0.0
        gate["count"] = 0
        gate["capped"] = False
        gate["tabs_skip_logged"] = False
        return False
    with STATE_LOCK:
        tabs = STATE.get("login_tabs")
        tabs_at = float(STATE.get("login_tabs_at") or 0.0)
    ttl = max(60, int(cfg.get("login_tabs_ttl_sec", 300)))
    if tabs and (now - tabs_at) <= ttl:
        if not gate.get("tabs_skip_logged"):
            gate["tabs_skip_logged"] = True
            log("auto-open skipped: the browser already has %d login tab(s) "
                "open - the extension will just re-click that one" % tabs)
        return False        # a login tab is already on screen; don't add another
    limit = max(1, int(cfg.get("login_open_max_per_outage", 3)))
    if gate.get("count", 0) >= limit:
        if not gate.get("capped"):
            gate["capped"] = True
            log("auto-open paused: already opened %d time(s) for this outage; "
                "click 登录 manually if you are still offline" % limit)
        return False
    interval = max(30, int(cfg.get("login_open_interval_sec", 180)))
    if now - gate.get("last_ts", 0.0) < interval:
        return False
    if not open_login_page(snap.get("login_url", "")):
        return False
    gate["last_ts"] = now
    gate["count"] = gate.get("count", 0) + 1
    with STATE_LOCK:
        STATE["auto_open_count"] += 1
        STATE["last_auto_open"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        n = STATE["auto_open_count"]
    log("opened login page in the default browser (#%d for this outage, "
        "%d total): %s" % (gate["count"], n, snap.get("login_url", "")))
    return True


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # do not follow -> surface the 3xx


# Bypass any system/IE proxy: the whole point is to detect the campus captive
# portal redirect directly, and loopback status must not be proxied either.
_NO_PROXY = urllib.request.ProxyHandler({})
_OPENER = urllib.request.build_opener(_NoRedirect, _NO_PROXY)


_DEFAULT_HIJACK = ("login.bjtu.edu.cn", "a79.htm")


def _norm_spec(spec):
    """Accept a plain URL string or {"url": ..., "expect_204": bool}."""
    if isinstance(spec, dict):
        url = str(spec.get("url", "") or "")
        if "expect_204" in spec:
            return {"url": url, "expect_204": bool(spec["expect_204"])}
        return {"url": url, "expect_204": "generate_204" in url}
    url = str(spec)
    return {"url": url, "expect_204": "generate_204" in url}


def _hijack_hit(blob, host, keywords):
    """Return the portal fingerprint found in the response, or ''."""
    if host and host.lower() in blob:
        return host
    for k in keywords:
        k = (k or "").lower()
        if k and k in blob:
            return k
    return ""


def _classify_one(cfg, spec):
    """Return (verdict, detail): online / offline / unknown.

    The status code alone is never trusted - the response body is sniffed as
    well, because a Srun-style portal answers HTTP 200 with the login page
    while leaving the request URL untouched. Judging by the URL only would
    read that as a perfectly healthy reply.
    """
    sp = _norm_spec(spec)
    url = sp["url"]
    if not url:
        return "unknown", "empty probe url"
    timeout = float(cfg.get("http_timeout_sec", 5))
    host = (cfg.get("host") or "").strip()
    keywords = list(cfg.get("hijack_keywords") or []) or list(_DEFAULT_HIJACK)

    code = None
    final = ""
    loc = ""
    body = b""
    try:
        resp = _OPENER.open(url, timeout=timeout)
        code = int(getattr(resp, "status", None) or resp.getcode())
        final = resp.geturl() or ""
        try:
            body = resp.read(4096)
        except Exception:
            body = b""
        resp.close()
    except urllib.error.HTTPError as e:
        code = int(e.code)
        try:
            loc = (e.headers.get("Location", "") if e.headers else "") or ""
        except Exception:
            loc = ""
        try:
            body = e.read(4096)
        except Exception:
            body = b""
    except Exception as e:
        return "unknown", "%s error %r" % (url, e)

    blob = " ".join([final, loc, body.decode("utf-8", "ignore")]).lower()
    detail = "%s %s -> %s" % (url, code, final or loc)

    hit = _hijack_hit(blob, host, keywords)
    if hit:
        return "offline", "%s [hijack:%s]" % (detail, hit)

    if sp.get("expect_204"):
        # The golden beacon: on a genuinely open network this endpoint always
        # answers a bare, empty 204. Anything else was rewritten on the way.
        if code == 204 and not body:
            return "online", detail
        if 200 <= code < 400:
            return "offline", "%s [204 beacon tampered]" % detail
        return "unknown", detail

    if 200 <= code < 300:
        if body:
            return "online", detail
        return "unknown", "%s [empty body]" % detail
    return "unknown", detail


def probe_all(cfg):
    """Aggregate several beacons. Return (verdict, detail).

    Deliberately conservative: a single piece of hijack evidence is enough to
    call it offline, while "online" needs hard proof - a strict 204 beacon
    passing on its own, or every beacon passing - so a portal that rewrites
    only part of the traffic can never fake a live session.
    """
    specs = list(cfg.get("probe_urls") or [])
    if not specs and cfg.get("probe_url"):
        specs = [cfg["probe_url"]]
    if not specs:
        return "unknown", "no probe urls"

    n_online = n_offline = 0
    golden = False  # a strict 204 beacon gave us hard proof of the internet
    details = []
    for spec in specs:
        v, d = _classify_one(cfg, spec)
        details.append(d)
        if v == "online":
            n_online += 1
            if _norm_spec(spec).get("expect_204"):
                golden = True
        elif v == "offline":
            n_offline += 1

    if n_offline:
        # Any hijack fingerprint anywhere outweighs everything else.
        verdict = "offline"
    elif golden or n_online == len(specs):
        # A strict, empty 204 from the beacon is hard proof on its own; the
        # remaining beacons only have to not contradict it (a flaky timeout
        # on one of them must not drag a healthy session down to "unknown").
        verdict = "online"
    else:
        verdict = "unknown"
    return verdict, " | ".join(details)


def check_once(cfg):
    primary, ips = get_local_ip()
    on_campus = any(in_subnet(ip, cfg.get("campus_subnet", "")) for ip in ips)
    login_url = build_login_url(cfg, primary)

    with STATE_LOCK:
        prev = STATE.get("logged_in")
        prev_streak = int(STATE.get("unknown_streak") or 0)

    logged_in = None
    streak = 0
    title = ""
    if not on_campus:
        reason = "not on campus (ips=%s)" % ",".join(ips)
        need_login = False
    else:
        verdict, detail = probe_all(cfg)
        reason = "verdict=%s | %s" % (verdict, detail)
        if verdict == "online":
            logged_in = True
        elif verdict == "offline":
            logged_in = False
        else:
            # Inconclusive (transient 403 / DNS blip, or a portal that eats
            # the probes). Keep the previous state - but not forever: if we
            # go several rounds without proof of being online, treat it as
            # logged out so the reconnect path still fires.
            streak = prev_streak + 1
            limit = int(cfg.get("unknown_streak_limit", 3) or 3)
            if prev is not True and streak >= limit:
                logged_in = False
                reason += (" | unknown x%d (>= %d) -> treat as logged out"
                           % (streak, limit))
            else:
                logged_in = prev
                reason += (" | inconclusive (x%d), keep logged_in=%s"
                           % (streak, prev))
        need_login = (logged_in is False)

    with STATE_LOCK:
        STATE["on_campus"] = bool(on_campus)
        STATE["unknown_streak"] = streak
        STATE["logged_in"] = logged_in
        STATE["need_login"] = bool(need_login)
        STATE["login_url"] = login_url
        STATE["local_ip"] = primary
        STATE["title"] = title
        STATE["reason"] = reason
        STATE["last_check"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        STATE["checks"] += 1
        snap = dict(STATE)
    return snap


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, obj, code=200):
        # Never answer while the client may still be sending. Replying with an
        # unread request body still in the socket makes Windows reset the
        # connection, and the caller sees "connection aborted" (WinError 10053)
        # instead of our status code - which is a maddening way to be told 404.
        # This bit the unmatched-path branch in do_POST (a 1-byte body was
        # enough to make "unknown path -> 404" flake roughly one run in fifteen).
        if not getattr(self, "_body_drained", False):
            self._read_body()
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("/status", "/"):
            with STATE_LOCK:
                snap = dict(STATE)
            self._send_json(snap)
        else:
            self._send_json({"error": "not found"}, 404)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path == "/log":
            # The browser extension posts its own log lines here so that the
            # plugin side stops being a black box: the service-worker console is
            # wiped every time MV3 recycles the worker, while this file survives.
            text = self._read_body()
            kept = 0
            for line in text.splitlines():
                line = line.strip()
                if not line or kept >= 40:      # cap a single burst
                    continue
                log("[plugin] %s" % line[:700])  # cap a single line
                kept += 1
            self._send_json({"ok": True, "lines": kept})
            return

        if path == "/tabs":
            # The extension reports how many login-page tabs its browser has.
            # We need that to stop piling up tabs: opening the page again is
            # pointless when one is already in front of the user, and the
            # extension is the only side that can see the tabs.
            text = self._read_body()
            n = None
            try:
                data = json.loads(text or "{}")
                n = int(data.get("login_tabs"))
            except Exception:
                n = None
            if n is None or n < 0:
                self._send_json({"error": "bad body, want {\"login_tabs\":N}"}, 400)
                return
            with STATE_LOCK:
                STATE["login_tabs"] = n
                STATE["login_tabs_at"] = time.time()
            self._send_json({"ok": True, "login_tabs": n})
            return

        self._send_json({"error": "not found"}, 404)

    def _read_body(self, max_bytes=64 * 1024, drain_max=1024 * 1024):
        """Return the request body, never buffering more than max_bytes of it.

        An oversized body is drained (bounded, so this cannot become a memory
        DoS) *before* we answer. Replying while the client is still writing made
        Windows reset the connection, and the caller saw "connection aborted"
        instead of our 400 - which is a confusing way to be told "too big".
        """
        self._body_drained = True
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except Exception:
            return ""
        if n <= 0:
            return ""
        if n <= max_bytes:
            try:
                return self.rfile.read(n).decode("utf-8", "replace")
            except Exception:
                return ""
        left = min(n, drain_max)
        try:
            while left > 0:
                chunk = self.rfile.read(min(8192, left))
                if not chunk:
                    break
                left -= len(chunk)
        except Exception:
            pass
        return ""

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, *args):
        pass  # keep console/err quiet


def port_in_use(port, host="127.0.0.1"):
    """True if something already answers on host:port.

    On Windows SO_REUSEADDR lets a second process bind the same port, so a
    plain bind() cannot detect a running instance; an explicit connect can.
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(1.0)
    try:
        s.connect((host, port))
        return True
    except Exception:
        return False
    finally:
        try:
            s.close()
        except Exception:
            pass


def main():
    cfg = load_config()
    port = int(cfg.get("local_port", 5180))
    rotate_log()
    if port_in_use(port):
        log("127.0.0.1:%s already answers (another watchdog running?); exit."
            % port)
        return
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError as e:
        log("cannot bind 127.0.0.1:%s (%r); another instance running? exit."
            % (port, e))
        return
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    log("watchdog started; status = http://127.0.0.1:%s/status" % port)

    interval = max(5, int(cfg.get("poll_interval_sec", 30)))
    gate = {"last_ts": 0.0, "count": 0, "capped": False}
    log("auto-open login page: %s (interval %ss, max %s per outage)"
        % ("on" if cfg.get("auto_open_login_page", True) else "off",
           max(30, int(cfg.get("login_open_interval_sec", 180))),
           max(1, int(cfg.get("login_open_max_per_outage", 3)))))
    while True:
        try:
            snap = check_once(cfg)
            log("check#%s on_campus=%s logged_in=%s need_login=%s ip=%s | %s"
                % (snap["checks"], snap["on_campus"], snap["logged_in"],
                   snap["need_login"], snap["local_ip"], snap["reason"]))
            # While the session is down, put the login page in front of the
            # user's browser. That navigation is the one Chromium autofills the
            # saved password for; the extension's content script then clicks
            # "登录". See open_login_page() for why Python owns this.
            maybe_open_login_page(snap, cfg, gate)
        except Exception as e:
            log("check error: %r" % (e,))
        time.sleep(interval)


if __name__ == "__main__":
    main()
