// BJTU campus-net helper - background service worker (MV3)
// Polls the local watchdog (127.0.0.1) and, when the session is down, brings
// the login tab to the front so the content script can click "登录".
//
// It does not open a *new* tab for the login page. The Python watchdog does
// that (os.startfile). What this worker owns is the thing that actually decides
// whether Chromium fills the saved password at all.
//
// What is ESTABLISHED (2026-10-01, three rounds of real-machine logs):
//
//   * The password is only ever filled by Chromium's own autofill. Clicking
//     "登录" with an empty password cannot work and is counted as a failed
//     login by the gateway, so that is refused.
//   * A page that does get filled is filled within ~1-5 s of the page load, or
//     not at all for that load. It is bimodal per load, not a matter of waiting.
//   * Re-navigating the login tab while it is in the foreground DOES eventually
//     produce such a load: both successful logins (12:52:33, 13:09:29) followed
//     an assisted re-navigation, and the click then went through.
//
// What is NOT established, and what earlier rounds got wrong twice:
//
//   * Round 1 claimed "pages the extension opens are never filled; only a shell
//     open is". Falsified: the worker itself navigated the tab at 12:25:05 and
//     autofill fired immediately.
//   * Round 2 claimed "a page loaded in a background tab is never filled".
//     Also not supported: every failure in the 13:07-13:09 run reported
//     hidden_at_load=false, visible=visible, focused=true - and the form dump
//     was byte-identical to the loads that did get filled.
//   * So the discriminator is something per-load that the log does not yet
//     capture, NOT visibility and NOT who navigated. content.js now tags every
//     log line with a per-load id and reports nav.type plus a password-field
//     audit, so the next run can be attributed to a specific load instead of
//     guessed at. Do NOT write another confident mechanism claim here until
//     that data exists.
//
// First per-load attribution data (2026-10-01 13:24-13:27 run), 8 loads of the
// same tab, same URL:
//
//   * 7 loads with nav.type = "navigate" -> never filled.
//   * 1 load  with nav.type = "reload"   -> filled within 3 s, click went
//     through, session came back at 13:26:53.
//   * Everything else in the boot audit was byte-identical across all 8:
//     hidden_at_load=false, referrer=-, pwdfields=1, visible_idx=[0],
//     picked_visible=true, picked_name=upass, picked_autocomplete=off.
//
// So nav.type is the ONLY per-load difference this run captured. That is n=1 on
// the success side: treat it as a hypothesis, NOT a rule. It is cheap to test,
// though, and reload is also the safer action (it cannot drop a fresh userip
// the tab already carries), so the assist path now prefers a plain reload and
// only falls back to a real navigation when the tab's userip is stale.
//
// Refinement (2026-10-01 16:40-16:42 run), which the earlier "background tabs
// get filled too" rebuttal does NOT cover:
//
//   * 16:40:34 the watchdog's own page loaded in FRONT (nav=navigate,
//     hidden_at_load=false) -> filled within 3 s -> clicked -> logged in at
//     16:40:40. First click, no retry.
//   * 16:41 the user was logged out again and FOUR login tabs were open
//     (login_tabs=4). Across 45 loads in 70 s, every single load reported
//     "autofill ready: false" at click time; two tabs burned all 6 refreshes
//     and gave up. Most of those loads report hidden_at_load=true.
//   * Across the whole log, 12 of 12 loads that were filled at click time were
//     visible. Not one hidden load was ever filled.
//   * The 13:07-13:09 counterexample still stands for its own case (visible
//     loads can fail too) - it does not show that hidden loads get filled.
//
// So: visibility is not a sufficient condition, but it looks like a necessary
// one. The content script now anchors its 3 s click clock at "the page is in
// front" and refuses to click or refresh a document that stays hidden, and this
// worker keeps exactly one login tab alive instead of letting four of them each
// run their own loop.
//
// Given that, the design is split: the CONTENT script owns the retry loop
// (open -> click 登录 at 3 s -> 1 s later check logged_in -> if not, refresh ->
// click again at 3 s after the refresh), because a reload is also the load that
// finally gets filled. The WORKER's job is to keep the window + tab in front
// (autofill needs a focused window) and to answer the content script's
// CHECK_STATUS query. It no longer reloads itself, to avoid racing the content
// script's own reload.

const STATUS_URL = "http://127.0.0.1:5180/status";
// The watchdog also accepts POST /log, which turns these logs into a file on
// disk. The service-worker console is wiped every time MV3 recycles the worker
// (which happens constantly), so without this the plugin side is a black box.
const LOG_URL = "http://127.0.0.1:5180/log";
const LOG_TAG = "bg";
const LOG_BATCH_MS = 500;
const LOG_MAX_LINES = 30; // per flush, mirrors the watchdog's per-request cap
// How many login-page tabs this browser has. The watchdog needs it to stop
// opening yet another tab: it is the only side that cannot see the tabs.
const TABS_URL = "http://127.0.0.1:5180/tabs";

// The worker no longer reloads the page itself - the content script owns that
// loop (see CLICK_AT_MS / CHECK_AT_MS in content.js). Its only remaining job on
// an autofill miss is to keep the window + tab in front, because Chromium ties
// saved-password autofill to a focused window.
// The watchdog's current login url, remembered from /status so triggerLogin can
// navigate to a link carrying the *current* userip when the tab is stale.
let lastLoginUrl = "";
// Whether the last /status said the session is down. The assist path MUST check
// this: a page on the login host that simply is not a login form (a gateway
// error page, or the portal's own "already online" page) also reports a miss,
// and re-navigating it while the session is fine would be an endless reload.
let lastNeedLogin = false;

const LOGIN_HOST = "login.bjtu.edu.cn";
// Intentionally no hardcoded fallback URL: a hardcoded one carries a stale
// userip (the DHCP address changes), and the gateway rejects a login that
// targets another device's IP. When the watchdog is unreachable we simply do
// nothing this round and wait for the next poll.

const MIN_TRIGGER_GAP_MS = 30000; // avoid hammering
let lastTriggerAt = 0;

let logBuf = [];
let logTimer = null;

function flatten(x) {
  if (typeof x === "string") return x;
  try {
    return JSON.stringify(x);
  } catch (e) {
    return String(x);
  }
}

function flushLogs() {
  logTimer = null;
  if (!logBuf.length) return;
  const lines = logBuf.slice(0, LOG_MAX_LINES);
  logBuf = logBuf.slice(LOG_MAX_LINES);
  if (logBuf.length && !logTimer) logTimer = setTimeout(flushLogs, LOG_BATCH_MS);
  fetch(LOG_URL, {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: lines.map((l) => LOG_TAG + ": " + l).join("\n"),
  }).catch(() => {});
}

function log(...a) {
  const line = a.map(flatten).join(" ");
  console.log("[BJTU-bg]", line);
  if (logBuf.length < 200) {
    logBuf.push(line);
    if (!logTimer) logTimer = setTimeout(flushLogs, LOG_BATCH_MS);
  }
}

async function getStatus() {
  const r = await fetch(STATUS_URL, { cache: "no-store" });
  if (!r.ok) throw new Error("status http " + r.status);
  return await r.json();
}

async function findLoginTabs() {
  // Match on the hostname ourselves instead of relying on a URL match pattern:
  // the pattern also has to cope with ports/query strings, and with the "tabs"
  // permission already granted this is both simpler and more reliable.
  try {
    const tabs = await chrome.tabs.query({});
    return tabs.filter((t) => t.url && t.url.indexOf(LOGIN_HOST) !== -1);
  } catch (e) {
    log("tabs.query({}) failed, falling back to url pattern:", e && e.message);
    try {
      return await chrome.tabs.query({ url: "*://" + LOGIN_HOST + "/*" });
    } catch (e2) {
      log("tabs.query(url) failed too:", e2 && e2.message);
      return [];
    }
  }
}

// Raising the WINDOW is the part that matters: chrome.tabs.update({active:true})
// only makes the tab active inside its window, and when that window sits behind
// another one Chromium never gets around to autofilling the saved password.
async function focusTab(tab) {
  if (!tab || tab.id == null) return false;
  let ok = false;
  try {
    if (tab.windowId != null) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    await chrome.tabs.update(tab.id, { active: true });
    ok = true;
    log("focused window", tab.windowId, "+ activated tab", tab.id, "for autofill");
  } catch (e) {
    log("focus failed:", e && e.message);
  }
  return ok;
}

function pickLoginUrl(raw) {
  // Only trust a URL that targets the login host AND came from the watchdog,
  // because only the watchdog knows the current userip/usermac.
  if (raw && typeof raw === "string" && raw.indexOf(LOGIN_HOST) !== -1) {
    return raw;
  }
  return "";
}

// Is this tab already pointed at the same login target as `wantUrl`?
// Comparing the raw strings is unreliable: chrome.tabs.query hands back the URL
// with percent-escapes resolved differently than /status carries it, so a
// byte comparison can read "different" for two URLs that address the same
// device. What actually has to match is the userip the gateway authenticates
// against - the DHCP address of this machine.
function sameLoginTarget(tabUrl, wantUrl) {
  const userip = (s) => {
    const m = /[?&]userip=([^&]+)/.exec(s || "");
    return m ? m[1] : null;
  };
  const a = userip(tabUrl);
  const b = userip(wantUrl);
  return !!(a && b && a === b);
}

// Tell the watchdog how many login tabs exist, so it does not keep opening new
// ones while one already sits in front of the user.
async function reportTabs(count) {
  try {
    await fetch(TABS_URL, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ login_tabs: count }),
    });
  } catch (e) {
    // watchdog not running - nothing to report to
  }
}

async function triggerLogin(rawUrl) {
  const tabs = await findLoginTabs();
  await reportTabs(tabs.length);
  if (!tabs.length) {
    // Not an error: the watchdog opens the login page itself (os.startfile),
    // and that navigation is the one Chromium autofills. Wait for the next poll.
    log("no login tab open; waiting for the watchdog to open one");
    return;
  }
  // Newest tab first: a page the watchdog just opened is the fresh one.
  tabs.sort((a, b) => (b.id || 0) - (a.id || 0));
  const tab = tabs[0];
  // Keep exactly ONE login page. Several of them each run their own 3 s-click +
  // refresh loop (content.js), and the extra reloads land in background tabs,
  // which are never autofilled - so they add nothing but the portal's
  // "请输入账号!" error and failed-login records on the account. Measured on
  // 2026-10-01 16:41: 4 login tabs -> 45 loads in 70 s, 0 of them filled at
  // click time, while the run's single foreground load (16:40:37) logged in on
  // the first click. Pruning here also keeps the /tabs count we report honest,
  // so the watchdog stops opening yet another page.
  if (tabs.length > 1) {
    log("login tabs found:", tabs.length, "- keeping the newest (id " + tab.id +
        "), closing", tabs.length - 1, "stale one(s)");
    for (const t of tabs.slice(1)) {
      try {
        await chrome.tabs.remove(t.id);
      } catch (e) {
        log("closing tab", t.id, "failed:", e && e.message);
      }
    }
    await reportTabs(1);
  }
  // Order matters: raise the WINDOW first, then make the tab active. Only then
  // is the tab "front" in the way Chromium's password manager cares about.
  await focusTab(tab);
  // Refresh the URL only when it is not already the current one (a stale tab
  // carries an expired userip). Deliberately NOT reloading an up-to-date tab:
  // a page the watchdog just opened already has the fresh URL, and a needless
  // navigation is one more chance to lose what the browser autofilled.
  const url = pickLoginUrl(rawUrl);
  if (url && !sameLoginTarget(tab.url, url)) {
    try {
      await chrome.tabs.update(tab.id, { url: url, active: true });
      log("tab", tab.id, "url was stale; navigated to the fresh login url");
    } catch (e) {
      log("tabs.update failed:", e && e.message);
    }
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "ENSURE_LOGIN" });
    log("sent ENSURE_LOGIN to tab", tab.id);
  } catch (e) {
    // Normal while the page is still loading: content.js also runs on load.
    log("sendMessage failed (page still loading?):", e && e.message);
  }
}

// Called when the content script reports that the password box stayed empty.
// The reload/retry loop now lives in the content script (its 3s-click + refresh
// cycle), so the worker must NOT reload here - that would race the content
// script's own reload. The only useful thing left is to keep the window + tab
// in front, because Chromium ties saved-password autofill to a focused window.
async function assistAutofill(tab) {
  if (!tab || tab.id == null) return;
  // Only while the session is actually down. Otherwise a tab on the login host
  // that merely is not a login form (gateway error page, "already online" page)
  // has no business being disturbed.
  if (!lastNeedLogin) return;
  await focusTab(tab); // window focused + tab active
  log("autofill missed on tab", tab.id,
      "-> kept it in front (content script owns the refresh/retry loop)");
}

let lastStatusKey = "";
let lastDownLogAt = 0;
let lastThrottleLogAt = 0;
let lastTabsReportAt = 0;

function summary(s) {
  return "on_campus=" + s.on_campus + " logged_in=" + s.logged_in +
         " need_login=" + s.need_login + " ip=" + s.local_ip +
         " checks=" + s.checks + " | " + s.reason;
}

async function poll() {
  let s;
  try {
    s = await getStatus();
  } catch (e) {
    log("watchdog status unavailable:", e && e.message);
    return;
  }
  const now = Date.now();
  if (s && s.login_url) lastLoginUrl = s.login_url;
  if (s) lastNeedLogin = !!s.need_login;
  // There is no top-level "verdict" field in /status (it lives inside reason),
  // so the transition key is built from the three boolean-ish flags.
  const key = [s && s.on_campus, s && s.logged_in, s && s.need_login].join("/");
  if (key !== lastStatusKey) {
    // Transitions get the full JSON; it is the one moment it is worth reading.
    lastStatusKey = key;
    log("status", flatten(s));
    if (s && s.need_login) lastDownLogAt = now;
  } else if (s && s.need_login && now - lastDownLogAt >= 60000) {
    // Still down: one compact line a minute, not 500 bytes every 15 s.
    lastDownLogAt = now;
    log("still down:", summary(s));
  }
  if (s && s.on_campus && s.need_login) {
    if (now - lastTriggerAt >= MIN_TRIGGER_GAP_MS) {
      lastTriggerAt = now;
      log("need_login -> trigger login");
      await triggerLogin(s.login_url);
    } else if (now - lastThrottleLogAt >= 60000) {
      lastThrottleLogAt = now;
      log("need_login but throttled");
    }
  } else if (s && !s.need_login) {
    // Session is healthy: keep the watchdog's view of our tabs fresh, otherwise
    // a stale "1 login tab" report could block its fallback open.
    if (now - lastTabsReportAt >= 60000) {
      lastTabsReportAt = now;
      reportTabs((await findLoginTabs()).length);
    }
  }
}

// Reliable periodic wake-up (service worker may be recycled).
chrome.alarms.create("bjtu-poll", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a && a.name === "bjtu-poll") poll();
});

chrome.runtime.onStartup.addListener(() => poll());
chrome.runtime.onInstalled.addListener(() => poll());

// Content script asks us to raise its window/tab so the browser autofills the
// password (a tab that is active but whose window is in the background gets
// nothing). It also relays its own log lines here, because a content script
// cannot POST to 127.0.0.1 as freely as the worker can.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  const tab = sender && sender.tab ? sender.tab : null;
  if (msg.type === "CHECK_STATUS") {
    // The content script asks whether the session is up yet. The worker can read
    // 127.0.0.1 directly (no CORS), so it proxies the watchdog's /status.
    getStatus()
      .then((s) => sendResponse({ logged_in: !!(s && s.logged_in) }))
      .catch(() => sendResponse({ logged_in: false }));
    return true; // keep the message channel open for the async response
  }
  if ((msg.type === "FOREGROUND_ME" || msg.type === "FOCUS_WINDOW") && tab) {
    focusTab(tab);
  } else if (msg.type === "AUTOFILL") {
    // The content script's verdict on whether Chromium filled the boxes. The
    // reload/retry loop now lives in the content script (its 3s-click + refresh
    // cycle), so on a miss the worker only keeps the window in front; it never
    // reloads here, to avoid racing the content script's own reload.
    if (!msg.ok && tab) {
      assistAutofill(tab);
    }
  } else if (msg.type === "LOG" && typeof msg.text === "string") {
    log("cs:", msg.text);
  }
});

// Responsive polling while the worker happens to be alive.
setInterval(poll, 15000);

poll();
