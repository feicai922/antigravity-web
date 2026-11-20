/*
 * mobile.js — runtime counterpart of mobile.css.
 *
 * Responsibilities:
 *   1. Flag the document as mobile (`html.ag-mobile`) so mobile.css can scope.
 *   2. Publish the visual-viewport height as `--ag-vvh`. On iOS Safari `dvh`
 *      does not shrink when the keyboard opens, so we forward
 *      `window.visualViewport.height` instead; the composer then stays visible.
 *   3. Keep the focused field visible after the keyboard animates in.
 *
 * Everything is wrapped so a failure here can never break the app bundle.
 */
(function () {
  "use strict";

  var de = document.documentElement;
  if (!de || window.__agMobileShim) return;
  window.__agMobileShim = true;

  function isMobile() {
    var coarse = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
    var narrow = window.innerWidth <= 900;
    return coarse || narrow;
  }

  function setMobileClass() {
    de.classList.toggle("ag-mobile", isMobile());
  }

  // --- visual viewport → --ag-vvh ------------------------------------------
  var vv = window.visualViewport;

  function syncViewportHeight() {
    var h = vv ? vv.height : window.innerHeight;
    // Ignore bogus values reported mid-rotation.
    if (!h || h < 120) h = window.innerHeight;
    de.style.setProperty("--ag-vvh", Math.round(h) + "px");
  }

  // --- keyboard-aware focus ------------------------------------------------
  function keepFieldVisible(el) {
    if (!el || !el.isConnected) return;
    // Two frames: one for the keyboard animation start, one for its end.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        try {
          el.scrollIntoView({ block: "nearest", inline: "nearest" });
        } catch (e) {
          /* older browsers: no options object */
        }
      });
    });
  }

  document.addEventListener(
    "focusin",
    function (ev) {
      var t = ev.target;
      if (!t || !t.tagName) return;
      var tag = t.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea" || t.isContentEditable) {
        keepFieldVisible(t);
      }
    },
    true
  );

  // --- wire up ------------------------------------------------------------

  // --- 清理被截断标签留下的碎文本 ----------------------------------------
  //
  // 上游自带的 favicon 是内联 data URI（里面含真实 <svg><text>🎁</text>），旧版
  // 代理的正则在那个 `>` 处截断，把 `🎁" />` 留成了文本节点，浏览器渲染到左上角。
  // 服务端已经改成“整段 <link> 匹配”，这里再把残留碎片清掉（只处理直接挂在
  // body/html 下、又同时带引号尖括号和 emoji 的短文本）。
  function dropBrokenMarkup() {
    try {
      var body = document.body;
      if (!body) return;
      // 残缺片段长这样（直接挂在 body 开头）：
      //   <text y=".9em" font-size="90">🎁</text> " />
      //   —— <text> 是残存的 SVG 片段，后面两个短文本节点是丢失的标签尾巴。
      var kids = Array.prototype.slice.call(body.childNodes);
      var removed = 0;
      for (var i = 0; i < kids.length; i++) {
        var n = kids[i];
        if (n.nodeType === 1 && n.tagName && n.tagName.toLowerCase() === "text") {
          body.removeChild(n);
          removed++;
          continue;
        }
        if (n.nodeType === 3) {
          var t = (n.nodeValue || "").trim();
          if (t && t.length <= 20 && /^["']?\s*\/?>?$/.test(t)) {
            body.removeChild(n);
            removed++;
          }
        }
      }
      return removed > 0;
    } catch (e) {
      return false;                                    // 绝不弄坏页面
    }
  }

  /** 渲染完可能才被插进来，所以重试几次（命中一次就停）。 */
  function scheduleBrokenMarkupCleanup() {
    var delays = [400, 1200, 2500, 5000, 9000];
    for (var i = 0; i < delays.length; i++) {
      (function (d) {
        setTimeout(function () { dropBrokenMarkup(); }, d);
      })(delays[i]);
    }
  }

  setMobileClass();
  syncViewportHeight();
  scheduleBrokenMarkupCleanup();

  window.addEventListener("resize", function () {
    setMobileClass();
    syncViewportHeight();
  });

  window.addEventListener("orientationchange", function () {
    setTimeout(syncViewportHeight, 300);
  });


  // --- 断线自救 -----------------------------------------------------------
  //
  // 代理重启（或隧道抖动）会掐断页面到语言服务器的一堆长连接，应用会挂上
  // "Lost connection to the language server. Agent features may not work."，
  // 而手机上那个提示往往没有可点的重连入口。这里统计 fetch 失败次数（代理对
  // 上游故障返回 5xx），连续失败就浮出一个「重新连接」按钮，点一下整页重载。
  (function reconnectWatch() {
    if (window.__agReconnect || typeof window.fetch !== "function") return;
    window.__agReconnect = true;

    var fails = 0;
    var button = null;

    function show() {
      if (button) return;
      button = document.createElement("button");
      button.type = "button";
      button.textContent = "重新连接";
      button.style.cssText = [
        "position:fixed", "left:50%", "transform:translateX(-50%)",
        "bottom:calc(18px + env(safe-area-inset-bottom,0px))",
        "z-index:2147483000", "padding:12px 20px", "border:0", "border-radius:999px",
        "background:#2f71e3", "color:#fff", "font:600 15px/1 system-ui,-apple-system,'PingFang SC',sans-serif",
        "box-shadow:0 8px 24px rgba(0,0,0,.45)",
      ].join(";");
      button.addEventListener("click", function () {
        button.disabled = true;
        button.textContent = "重连中…";
        location.reload();
      });
      document.body.appendChild(button);
    }

    function hide() {
      if (button && button.parentNode) button.parentNode.removeChild(button);
      button = null;
    }

    function fail() {
      fails += 1;
      if (fails >= 3) show();
    }

    function ok() {
      fails = 0;
      hide();
    }

    var originalFetch = window.fetch;
    window.fetch = function () {
      var call;
      try {
        call = originalFetch.apply(this, arguments);
      } catch (e) {
        fail();
        throw e;
      }
      if (!call || typeof call.then !== "function") return call;
      return call.then(
        function (res) {
          if (res && res.status >= 500) fail();
          else if (res && res.status < 400) ok();
          return res;
        },
        function (err) {
          fail();
          throw err;
        }
      );
    };

    // 回到前台时给一次机会自动收起（连接可能已经恢复）
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") {
        setTimeout(function () { if (!fails) hide(); }, 1500);
      }
    });
  })();

  if (vv) {
    vv.addEventListener("resize", syncViewportHeight);
    vv.addEventListener("scroll", syncViewportHeight);
  }

  // --- sidebar drawer: tap-to-close backdrop -------------------------------
  //
  // mobile.css turns the sidebar into an overlay drawer on narrow screens, so
  // the in-content "Toggle Sidebar" button ends up underneath it. This adds a
  // backdrop that closes the drawer when tapped.
  var SIDEBAR_SEL = ".agy-inset-shell > div > div:first-child:has(.bg-sidebar)";
  var backdrop = null;
  var drawerOpen = false;

  // The label is "Toggle Sidebar" in English but locale-zh.js may have already
  // rewritten it — accept either, so tap-to-close keeps working after i18n.
  var TOGGLE_LABELS = ["Toggle Sidebar", "切换侧边栏"];

  function toggleButton() {
    var btns = document.querySelectorAll("button");
    for (var i = 0; i < btns.length; i++) {
      var label = btns[i].getAttribute("aria-label") || "";
      if (TOGGLE_LABELS.indexOf(label) !== -1) return btns[i];
    }
    return null;
  }

  function sidebarOpen() {
    var el = document.querySelector(SIDEBAR_SEL);
    if (!el) return false;
    var inline = el.getAttribute("style") || "";
    if (/width:\s*0px/.test(inline)) return false;
    var rect = el.getBoundingClientRect();
    return rect.width > 120 && rect.height > 100;
  }

  function closeDrawer() {
    var btn = toggleButton();
    if (btn) btn.click();
  }

  function syncDrawer() {
    if (window.innerWidth > 700) {
      if (backdrop) { backdrop.remove(); backdrop = null; }
      drawerOpen = false;
      return;
    }
    var open = sidebarOpen();
    if (open && !backdrop) {
      backdrop = document.createElement("div");
      backdrop.className = "ag-sb-backdrop";
      backdrop.setAttribute("aria-hidden", "true");
      backdrop.addEventListener("click", closeDrawer);
      backdrop.addEventListener("touchstart", function (e) { e.preventDefault(); closeDrawer(); }, { passive: false });
      document.body.appendChild(backdrop);
      requestAnimationFrame(function () { backdrop && backdrop.classList.add("ag-show"); });
    } else if (!open && backdrop) {
      backdrop.classList.remove("ag-show");
      var el = backdrop;
      backdrop = null;
      setTimeout(function () { el.remove(); }, 180);
    }
    drawerOpen = open;
  }

  // Tapping a conversation row navigates explicitly.
  //
  // Why not rely on the anchor: in the narrow layout the row is a card with a
  // collapsed 0×0 link overlay, a label wrapper that re-enables pointer events
  // deep down, and (for the virtualised list) more than one stacked copy — so a
  // tap often lands on a node that is not inside any link and nothing happens.
  // One delegated handler on the row (which always carries data-cascade-id)
  // makes the whole row tappable.
  /**
   * Client-side navigation.
   *
   * The app is a router-driven SPA: pushing the history entry and firing a
   * `popstate` makes it render the conversation in place — no document reload,
   * so the drawer, scroll position and app state survive (a plain
   * `location.assign` looked like a "page refresh" on the phone).
   * If the router ever stops listening, we fall back to a full load.
   */
  function navigate(path) {
    try {
      history.pushState({}, "", path);
      window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
    } catch (e) {
      location.assign(path);
      return;
    }
    // Success signal: the home view (`.agy-home`) unmounts once a conversation
    // is shown. If it is still there after the route change, the router ignored
    // our popstate and we fall back to a full load so the user always gets in.
    setTimeout(function () {
      if (location.pathname !== path) {
        location.assign(path);
      } else if (document.querySelector(".agy-home")) {
        location.assign(path);
      }
    }, 1200);
  }

  function rowTarget(ev) {
    var t = ev.target;
    if (!t || !t.closest) return null;
    var row = t.closest('[data-testid="conversation-row-sidebar"], [data-testid="conversation-row-history"]');
    if (!row) return null;
    // Let inline row actions (pin / archive / "…") win.
    if (t.closest('button, [role="button"], [role="menuitem"]') && !t.closest("a.agy-button")) return null;
    return row;
  }

  document.addEventListener(
    "click",
    function (ev) {
      if (window.innerWidth > 700) return;          // desktop: the app handles it
      if (ev.defaultPrevented) return;
      var row = rowTarget(ev);
      if (!row) return;
      var id = row.getAttribute("data-cascade-id");
      if (!id) return;
      var target = "/c/" + id;
      if (location.pathname === target) return;
      ev.preventDefault();
      ev.stopPropagation();
      navigate(target);
    },
    true
  );

  // Dismiss the drawer when the route changes. Done by watching location rather
  // than by intercepting the click: closing it from a click handler raced with
  // the anchor's default action and sometimes swallowed the navigation.
  var lastPath = location.pathname;
  function watchRoute() {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      if (window.innerWidth <= 700 && sidebarOpen()) closeDrawer();
    }
  }

  setInterval(function () { syncDrawer(); watchRoute(); }, 250);
  window.addEventListener("resize", syncDrawer);

})();
