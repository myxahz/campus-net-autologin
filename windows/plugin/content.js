// BJTU campus-net helper - login page content script
//
// User rule: do NOT try to handle the password. The password is handled by the
// browser's own autofill. This script only has to CLICK "登录". The retry loop
// is the user's own timing: open -> click 登录 at 3 s -> 1 s later check the
// login status -> if not logged in, refresh -> click again at 3 s after the
// refresh (bounded by MAX_RELOAD).
//
// This script contains no credential and cannot read one - a content script has
// no access to the browser's password store. It only reads the DOM.
//
// Manual test: open the login page, press F12, and run   __bjtuLogin()
//
// History note (2026-10-01): this script used to click "登录" even when the
// password box was still empty ("blind attempt"). The log proved that is
// pointless AND harmful - the portal answers an empty password with an error
// page, and a failed attempt is counted against the account. A one-line guard
// was added to skip the click when the box was still empty. The user then
// explicitly asked for a literal "blind click" at 3 s regardless of fill state,
// so that guard is now removed: at 3 s the script clicks 登录 unconditionally,
// and relies on the refresh/retry loop to recover if the click did not take.
//
// History note (2026-10-01 16:41 run): that blind click turned out to be
// self-defeating when the document had loaded in the BACKGROUND. Four login
// tabs were open at once; each ran its own click+refresh loop, so most of the
// 45 loads in that run happened in hidden tabs. Every one of them reported
// "autofill ready: false" at click time, clicked anyway, got the portal's
// "请输入账号!" error, and refreshed - one more hidden load. The only load that
// did get filled (16:40:37, hidden_at_load=false) logged in immediately. And
// across the whole log, 12 of 12 filled-at-click loads were visible: a hidden
// tab is simply never autofilled. So the click still happens unconditionally,
// but its 3 s clock is anchored at "the page is in front", and a document that
// is never brought to the front neither clicks nor refreshes.
//
// History note (2026-10-10) - THE BLIND CLICK IS GONE. This is the fix for the
// user's "账号已经填好了却提示请输入账号!、点了也不登录" report. Reading the
// portal's own code settles it: a40.js checkForm() does
//     var DDDDD = $(form).find('input[name=DDDDD]').val();
//     var upass = $(form).find('input[name=upass]').val();
//     if (form.name == 'f1') {
//       if (DDDDD == "") { _alert(lang('请输入账号！')); return false; }
// i.e. the portal validates CLIENT-SIDE against the DOM value (that _alert IS
// the dark bubble in the screenshot) and aborts before a single byte is sent.
// So a blind click that lands before Chromium commits the saved password ALWAYS
// shows 请输入账号! and never logs in - and each one is recorded against the
// account as a failed attempt. The click is now gated on the boxes actually
// carrying a value (waitFilled); a load that never fills is reloaded, not
// clicked, because a reload is the load that tends to get autofilled.
//
// The refresh is also the load that gets filled: the 13:24-13:27 run narrowed
// the only per-load difference to nav.type ("reload" filled, "navigate" did not,
// otherwise byte-identical audit, n=1, unproven). Whether or not that holds, the
// user's refresh-and-retry loop exercises exactly the reload path, so it is the
// right shape regardless. See the long note in background.js before claiming a
// mechanism.
//
// Every log line carries a per-load id ([Lxxxx]) and the boot line reports
// nav.type and a password-field audit, so a later "autofill ready: false" can
// be attributed to the exact load that produced it.

(function () {
  const RETRY_KEY = "bjtu_login_retry"; // how many refreshes this loop has done
  const MAX_RELOAD = 6;        // safety cap so a truly-dead gateway cannot loop forever
  // User's timing, revised 2026-10-10: open the login page -> wait for the
  // browser to autofill the saved account/password -> click 登录 -> 1 s later
  // check the login status -> if not logged in, refresh and try again. The 3 s
  // mark is now only a FLOOR for the click (never click sooner than that), not a
  // mandate to click an empty form. The password is filled by the browser
  // itself; this script only CLICKS. Do not touch credentials.
  const CLICK_AT_MS = 3000;    // EARLIEST click time, measured from the anchor
  const CHECK_AT_MS = 1000;    // check login status this long after the click
  // After the 3 s floor, how long to keep waiting for Chromium's autofill before
  // giving up on THIS load. The fill is bimodal (it lands within ~5 s or not at
  // all), so waiting longer is pointless - reload instead of clicking blind.
  const FILL_GRACE_MS = 5000;
  // Captured once: was this page load already in the background? If so, autofill
  // for this document is a lost cause and the log should say so up front.
  const LOADED_HIDDEN = document.visibilityState === "hidden";
  // Every page load gets a short id. Without it the log cannot attribute an
  // "autofill ready: true/false" to the load that produced it, which is exactly
  // the ambiguity that made two earlier diagnoses wrong.
  const LOAD_ID = Math.random().toString(36).slice(2, 6);
  const FORM_WAIT_MS = 6000;   // the Dr.COM portal may render the form after load
  const POLL_MS = 300;
  const VISIBLE_WAIT_MS = 6000;
  // When this document started loading, so the click can land at a fixed 3 s.
  const LOAD_START = Date.now();
  // The "click at 3 s" clock is anchored HERE, not at LOAD_START. Two cases:
  //   * the page loads in front  -> anchor = LOAD_START (the user's plain rule);
  //   * the page loads in the background -> the anchor moves to the moment it is
  //     actually shown. Without that, the clock (already past 3 s) fires the
  //     click the instant the tab surfaces, before Chromium has had any chance
  //     to fill the saved password - which is exactly what the 16:41 run did
  //     ~40 times in a row, with four login tabs open at once.
  let anchorAt = LOAD_START;
  // match "登录" / "登陆" / "Login" / "log in" (loose)
  const LOGIN_BTN_RE = /登录|登陆|Login|log\s*in/i;
  const IMG_HINT_RE = /login|logon|登录|登陆/i;

  let running = false;

  // Relay to the background worker, which appends it to the watchdog's log
  // file. The devtools console alone is useless for debugging: this page is
  // usually closed long before anyone looks, and MV3 wipes the worker console.
  function relay(line) {
    try {
      chrome.runtime.sendMessage({ type: "LOG", text: line });
    } catch (e) {}
  }

  // Report whether Chromium filled the saved password. On a miss the worker
  // loads this tab again while it is in front. (An earlier note here claimed a
  // page that loaded hidden is never filled - the 13:07-13:09 run falsified
  // that: every miss reported hidden_at_load=false.)
  // Also sent when the page turns out not to be a login form at all (a gateway
  // error page, say): such a tab is useless and equally worth re-loading.
  function reportAutofill(ok) {
    try {
      chrome.runtime.sendMessage({
        type: "AUTOFILL",
        ok: !!ok,
        hidden_at_load: LOADED_HIDDEN,
      });
    } catch (e) {}
  }

  function log(...a) {
    const line = a
      .map((x) => {
        if (typeof x === "string") return x;
        try {
          return JSON.stringify(x);
        } catch (e) {
          return String(x);
        }
      })
      .join(" ");
    console.log("[BJTU-login]", line);
    relay("[L" + LOAD_ID + "] " + line);
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;
    const st = window.getComputedStyle(el);
    if (!st) return false;
    return (
      st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0"
    );
  }

  function textOf(el) {
    if (!el) return "";
    if (el.tagName === "INPUT") {
      // image / submit / button inputs carry their label in value/alt/title
      if (el.type === "image" || el.type === "submit" || el.type === "button") {
        return (
          el.value || el.alt || el.title || el.getAttribute("aria-label") || ""
        );
      }
      return el.value || "";
    }
    if (el.tagName === "IMG") return el.alt || el.title || "";
    return (el.getAttribute("aria-label") || el.textContent || "").trim();
  }

  function getCreds() {
    const pickVisible = (list) => {
      for (const el of list) if (isVisible(el)) return el;
      return null;
    };
    const all = document.querySelectorAll('input[type="password"]');
    // The a79.htm page literally declares authuserfield='DDDDD' and
    // authpassfield='upass', and the portal's own checkForm() reads exactly
    // input[name=DDDDD] / input[name=upass]. So look those names up FIRST: it
    // makes identification exact and keeps our fill check aligned with the two
    // fields the portal validates. Fall back to the generic heuristics only when
    // the names are absent (a different portal build).
    let pwd = document.querySelector('input[name="upass"]');
    if (pwd && !isVisible(pwd)) pwd = null;
    if (!pwd) {
      // Prefer a VISIBLE password box. A portal page may carry several password
      // inputs (hidden submit templates, a second form): picking the first one
      // in DOM order can mean watching a field Chromium will never fill, and
      // then reporting "autofill never arrived" forever.
      pwd = pickVisible(all);
    }
    if (!pwd && all.length) pwd = all[0]; // fall back so the log can describe it
    if (!pwd) return { pwd: null, user: null };
    const scope = pwd.form || document;
    let user = scope.querySelector('input[name="DDDDD"]');
    if (user && !isVisible(user)) user = null;
    if (!user) {
      // Same reasoning for the username: a hidden template input must not be
      // mistaken for the account field.
      const cands = scope.querySelectorAll(
        'input[type="text"], input[type="email"], input[type="tel"], ' +
        'input[type="number"], input:not([type])'
      );
      user = pickVisible(cands);
      if (!user && cands.length) user = cands[0];
    }
    return { pwd: pwd, user: user };
  }

  function hasPasswordField() {
    return !!document.querySelector('input[type="password"]');
  }

  // Compact, decisive audit of the password fields on THIS page: how many there
  // are, which one we picked, and whether it is visible. "picked is hidden"
  // means the page is not a fillable login form at all, which is a completely
  // different problem from "fillable form but Chromium did not fill it".
  function passwordAudit() {
    const all = document.querySelectorAll('input[type="password"]');
    const picked = getCreds().pwd;
    const vis = [];
    Array.prototype.forEach.call(all, (el, i) => {
      if (isVisible(el)) vis.push(i);
    });
    const bits = ["pwdfields=" + all.length,
                  "visible_idx=[" + vis.join(",") + "]",
                  "picked#" + Array.prototype.indexOf.call(all, picked)];
    if (picked) {
      bits.push("picked_visible=" + isVisible(picked));
      bits.push("picked_name=" + (picked.name || "-"));
      bits.push("picked_id=" + (picked.id || "-"));
      bits.push("picked_autocomplete=" + (picked.autocomplete || "-"));
    }
    return bits.join(" ");
  }

  // How did this document get loaded? "reload" = somebody called reload,
  // "navigate" = a navigation (tabs.update, a link, or a gateway redirect).
  // This is the field that tells us whether our own re-navigation was the load
  // that finally got filled.
  function navType() {
    try {
      const e = performance.getEntriesByType("navigation")[0];
      return (e && e.type) || "?";
    } catch (x) {
      return "?";
    }
  }

  function describe(el) {
    if (!el) return "null";
    const id = el.id ? "#" + el.id : "";
    const nm = el.name ? "[name=" + el.name + "]" : "";
    const ty = el.type ? "(" + el.type + ")" : "";
    return el.tagName + ty + id + nm + " / " + JSON.stringify(textOf(el).slice(0, 24));
  }

  // Attribute-only description of every field: enough to see WHY the browser
  // refuses to autofill (wrong field type, no <form>, autocomplete=off on a
  // JS-injected field, a password box that lives in a second frame ...) without
  // ever putting a value - i.e. a credential - into the log file.
  function describeForm() {
    const out = [];
    const inputs = document.querySelectorAll("input, button");
    for (let i = 0; i < inputs.length && i < 14; i++) {
      const el = inputs[i];
      const bits = [el.tagName + (el.type ? "(" + el.type + ")" : "")];
      if (el.name) bits.push("name=" + el.name);
      if (el.id) bits.push("id=" + el.id);
      if (el.autocomplete) bits.push("autocomplete=" + el.autocomplete);
      if (el.getAttribute && el.getAttribute("aria-hidden") === "true") {
        bits.push("aria-hidden");
      }
      bits.push(isVisible(el) ? "visible" : "hidden");
      bits.push("value=" + (el.value ? "set" : "empty"));
      out.push(bits.join(" "));
    }
    const pwd = document.querySelector('input[type="password"]');
    const form = pwd && pwd.form;
    const formInfo = form
      ? "form[action=" + (form.getAttribute("action") || "") +
        " method=" + (form.getAttribute("method") || "get") + "]"
      : "NO <form> around the password field";
    return formInfo + " | " + out.join(" ; ");
  }

  // Whitespace-collapsed page text: lets the log show what the portal SAID
  // ("密码错误" / "该 IP 已经在线" ...) when a login did not take.
  function pageText() {
    try {
      const t = (document.body && document.body.innerText) || "";
      return t.replace(/\s+/g, " ").trim().slice(0, 200);
    } catch (e) {
      return "";
    }
  }

  function findLoginButton() {
    // 1) real controls whose visible text matches
    const controls = document.querySelectorAll(
      'button, input, a, [role="button"]'
    );
    for (const el of controls) {
      if (!isVisible(el)) continue;
      const t = textOf(el);
      if (t && LOGIN_BTN_RE.test(t)) return el;
    }
    // 2) any visible element with a short label containing the keyword
    //    (catches styled <div>/<span> buttons), but avoid big containers.
    const tagged = document.querySelectorAll(
      'div, span, td, li, p, label, b, strong'
    );
    for (const el of tagged) {
      if (!isVisible(el)) continue;
      const t = (el.getAttribute("aria-label") || el.textContent || "").trim();
      if (t && t.length <= 12 && LOGIN_BTN_RE.test(t)) return el;
    }
    // 3) submit/image control inside the password's form (last resort)
    const { pwd } = getCreds();
    if (pwd && pwd.form) {
      const cands = pwd.form.querySelectorAll(
        'input[type="image"], input[type="submit"], input[type="button"], button'
      );
      for (const el of cands) {
        if (isVisible(el)) return el;
      }
    }
    // 4) any image input whose src/alt hints at login
    const imgs = document.querySelectorAll('input[type="image"]');
    for (const el of imgs) {
      const s = (el.src || "") + " " + (el.alt || el.title || "");
      if (IMG_HINT_RE.test(s) && isVisible(el)) return el;
    }
    return null;
  }

  // Dump the plausible candidates so a screenshot of the console is enough to
  // fix the matcher when the real button has an unusual shape.
  function dumpCandidates() {
    const out = [];
    const all = document.querySelectorAll("input, button, a, div, span, img");
    for (const el of all) {
      if (!isVisible(el)) continue;
      const t = textOf(el);
      const hit =
        (t && LOGIN_BTN_RE.test(t)) ||
        el.type === "image" ||
        el.type === "submit";
      if (hit) out.push(describe(el));
      if (out.length >= 8) break;
    }
    return out;
  }

  // Filled == both boxes carry a value. The username alone is not enough: the
  // portal happily posts an empty password and then reports a login error.
  function filledNow() {
    const { pwd, user } = getCreds();
    return !!(pwd && pwd.value && (!user || user.value));
  }

  function waitFilled(maxMs) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        if (filledNow()) return resolve(true);
        if (Date.now() - t0 > maxMs) return resolve(false);
        setTimeout(tick, POLL_MS);
      };
      tick();
    });
  }

  function waitVisible(maxMs) {
    return new Promise((resolve) => {
      if (document.visibilityState === "visible") return resolve(true);
      const onVis = () => {
        if (document.visibilityState === "visible") {
          document.removeEventListener("visibilitychange", onVis);
          resolve(true);
        }
      };
      document.addEventListener("visibilitychange", onVis);
      setTimeout(() => {
        document.removeEventListener("visibilitychange", onVis);
        resolve(document.visibilityState === "visible");
      }, maxMs);
    });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // The portal sometimes paints an empty shell first and injects the real form
  // afterwards (this one is a Dr.COM page: <body></body> + page.run()). Waiting
  // is mandatory; on load there is literally no form for a few hundred ms.
  function waitForPasswordField(maxMs) {
    if (hasPasswordField()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t0 = Date.now();
      let done = false;
      let tick = null;
      let obs = null;
      const finish = (ok) => {
        if (done) return;
        done = true;
        if (tick) clearInterval(tick);
        try {
          if (obs) obs.disconnect();
        } catch (e) {}
        resolve(ok);
      };
      const check = () => {
        if (hasPasswordField()) finish(true);
        else if (Date.now() - t0 > maxMs) finish(false);
      };
      tick = setInterval(check, POLL_MS);
      try {
        obs = new MutationObserver(check);
        obs.observe(document.documentElement || document, {
          childList: true,
          subtree: true,
        });
      } catch (e) {
        obs = null; // the interval alone still covers us
      }
    });
  }

  function getNum(key) {
    const n = parseInt(sessionStorage.getItem(key) || "0", 10);
    return isNaN(n) ? 0 : n;
  }
  function setNum(key, n) {
    try {
      sessionStorage.setItem(key, String(n));
    } catch (e) {}
  }
  function clearKey(key) {
    try {
      sessionStorage.removeItem(key);
    } catch (e) {}
  }

  // Nudge Chrome's autofill (best effort only). Focusing a field is what makes
  // some Chromium versions reveal/commit the saved credential.
  function nudgeAutofill() {
    const { pwd, user } = getCreds();
    for (const el of [user, pwd]) {
      if (!el) continue;
      try {
        el.focus();
        el.dispatchEvent(new Event("focus", { bubbles: true }));
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } catch (e) {}
    }
  }

  // Click, then escalate if the page did not react. Some legacy portal buttons
  // only listen to a real mousedown/mouseup sequence, or must be submitted
  // through the form; a plain .click() silently does nothing there.
  async function clickLogin(el) {
    try { el.scrollIntoView({ block: "center" }); } catch (e) {}
    try { el.focus(); } catch (e) {}

    try {
      el.click();
      log("click() dispatched on", describe(el));
    } catch (e) {
      log("click() threw:", e && e.message);
    }
    await sleep(500);
    if (!hasPasswordField()) return "click";

    try {
      const r = el.getBoundingClientRect();
      const o = {
        bubbles: true, cancelable: true, view: window,
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      };
      el.dispatchEvent(new MouseEvent("mousedown", o));
      el.dispatchEvent(new MouseEvent("mouseup", o));
      el.dispatchEvent(new MouseEvent("click", o));
      log("mouse sequence dispatched on", describe(el));
    } catch (e) {
      log("mouse sequence threw:", e && e.message);
    }
    await sleep(500);
    if (!hasPasswordField()) return "mouse";

    // Only a real submit control may be handed to requestSubmit(); passing a
    // type="button" throws "The specified element is not a submit button".
    try {
      if (el.form && (el.type === "submit" || el.type === "image")) {
        if (typeof el.form.requestSubmit === "function") {
          el.form.requestSubmit(el);
          log("form.requestSubmit() used.");
        } else {
          el.form.submit();
          log("form.submit() used.");
        }
      }
    } catch (e) {
      log("form submit threw:", e && e.message);
    }
    return "form";
  }

  // Ask the background worker whether the session is up yet. The worker proxies
  // the watchdog's /status (it can read 127.0.0.1 without CORS trouble); the
  // content script cannot, so we round-trip through a message. Times out to
  // "not logged in" so a dead watchdog never stalls the loop.
  function checkLoggedIn() {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      try {
        chrome.runtime.sendMessage({ type: "CHECK_STATUS" }, (resp) => {
          finish(!!(resp && resp.logged_in));
        });
      } catch (e) {
        finish(false);
      }
      setTimeout(() => finish(false), 1500);
    });
  }

  // The user's retry loop, driven entirely from this content script:
  //   open the login page
  //   -> wait for the form, raise the window, nudge autofill
  //   -> at CLICK_AT_MS after load, click 登录 once
  //   -> CHECK_AT_MS later, ask the worker whether we are logged in
  //   -> if not, refresh and the loop restarts from the top (up to MAX_RELOAD)
  async function ensureLogin() {
    if (running) return;

    if (!hasPasswordField()) {
      const appeared = await waitForPasswordField(FORM_WAIT_MS);
      if (!appeared) {
        clearKey(RETRY_KEY);
        // Not a login form at all (already online, or a gateway error page like
        // "Error code: 203 sendtolhttp: tmplen<=0"). Nothing to click here.
        log("form never appeared -> not a login form (already online?). text=" +
            JSON.stringify(pageText()) + " | hidden_at_load=" + LOADED_HIDDEN);
        reportAutofill(false);
        return;
      }
      log("login form appeared after waiting.");
    }

    running = true;
    try {
      // Raise the browser window AND this tab. Chromium ties saved-password
      // autofill to the tab being active in a *focused* window; merely calling
      // tabs.update({active:true}) leaves the window in the background.
      try { chrome.runtime.sendMessage({ type: "FOREGROUND_ME" }); } catch (e) {}
      const surfaced = await waitVisible(VISIBLE_WAIT_MS);
      if (!surfaced) {
        // Loaded in the background and never brought to the front. In the whole
        // log no hidden load has ever been filled (12 of 12 filled-at-click
        // loads were visible, and the 16:41 run's ~40 hidden loads filled none),
        // and clicking there instead produced the portal's "请输入账号!" error
        // plus a failed-login record every single time. Not worth it - leave the
        // document alone; the visibilitychange handler restarts the loop the
        // moment it is shown. Deliberately does NOT bump or clear the retry
        // counter: only real clicks spend the budget.
        log("still in the background after " + VISIBLE_WAIT_MS +
            "ms -> not clicking (no hidden load has ever been filled here); waiting to be shown");
        return;
      }
      nudgeAutofill();

      // Land the click at CLICK_AT_MS after `anchorAt` - the later of "page
      // loaded" and "page came to the front".
      while (Date.now() < anchorAt + CLICK_AT_MS) {
        await sleep(100);
      }

      const btn = findLoginButton();
      log("login button:", describe(btn));
      if (!btn) {
        log("login button NOT FOUND. candidates:", JSON.stringify(dumpCandidates()));
        return;
      }

      // ---- fill gate -------------------------------------------------------
      // The portal validates client-side (a40.js checkForm) by reading the DOM
      // value of input[name=DDDDD] / input[name=upass] and aborting with
      // 请输入账号！ / 请输入密码！ when either is empty - nothing is sent. So a
      // click before Chromium's autofill has committed is a guaranteed, and
      // harmful (counted as a failed attempt), no-op. Wait for the boxes to
      // carry a value, then click; if this load never fills, skip the click and
      // fall through to the reload path so the next load gets a fresh chance.
      const filled = await waitFilled(FILL_GRACE_MS);
      if (filled) {
        log("autofill ready -> clicking 登录 (anchor_delay_ms:",
            Math.max(0, anchorAt - LOAD_START), ")");
        await clickLogin(btn);

        // 1 s after the click, check whether we are logged in yet.
        await sleep(CHECK_AT_MS);
        const loggedIn = await checkLoggedIn();
        if (loggedIn || !hasPasswordField()) {
          clearKey(RETRY_KEY);
          log("logged in (status or page gone) -> done. via",
              loggedIn ? "status" : "page navigated away");
          return;
        }
      } else {
        const { pwd, user } = getCreds();
        log("autofill not ready after", FILL_GRACE_MS,
            "ms -> NOT clicking (a blind click here is exactly what produced " +
            "请输入账号!) | user_set=", !!(user && user.value),
            "pwd_set=", !!(pwd && pwd.value));
      }

      // Not logged in (either the click did not take, or we deliberately
      // skipped it because autofill never arrived): refresh and let the loop
      // restart from the top. A reload is a load that tends to get autofilled.
      const n = getNum(RETRY_KEY) + 1;
      setNum(RETRY_KEY, n);
      if (n <= MAX_RELOAD) {
        if (document.visibilityState !== "visible") {
          // Refreshing a background tab only produces one more hidden load,
          // which can never be filled. Wait until the tab is actually shown.
          log("no login yet, but the tab is in the background ->" +
              " no refresh (a hidden reload is never autofilled)");
          return;
        }
        log("no login yet -> refresh & retry", n, "/", MAX_RELOAD);
        location.reload();
        return; // ensureLogin re-runs on the reloaded document
      }
      clearKey(RETRY_KEY);
      log("gave up after", MAX_RELOAD, "refreshes. If the boxes are filled but " +
          "it still will not log in, the saved password may be wrong; if they " +
          "stay empty, Chromium is not autofilling this site at all.");
    } finally {
      running = false;
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "ENSURE_LOGIN") ensureLogin();
  });

  // If this tab becomes visible again (e.g. foregrounded by the background),
  // re-attempt the login so autofill has a chance to fill.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      // The page just came to the front: restart the 3 s click clock from here
      // (autofill only has a chance once the tab is actually shown) and re-run
      // the loop, in case the previous attempt gave up while it was hidden.
      anchorAt = Date.now();
      ensureLogin();
    }
  });

  // Manual trigger for troubleshooting: run  __bjtuLogin()  in the console.
  try {
    window.__bjtuLogin = function () {
      clearKey(RETRY_KEY);
      running = false;
      log("manual trigger.");
      return ensureLogin();
    };
  } catch (e) {}

  // Dedicated login helper: also run once automatically on page load.
  log("boot | nav=" + navType(),
      "| referrer=" + (document.referrer ? document.referrer.replace(/[?#].*$/, "") : "-"),
      "| hidden_at_load=" + LOADED_HIDDEN,
      "|", passwordAudit());
  ensureLogin();
})();
