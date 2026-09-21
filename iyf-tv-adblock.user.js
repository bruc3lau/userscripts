// ==UserScript==
// @name         爱壹帆去广告
// @name:zh-CN   爱壹帆去广告
// @namespace    local.iyf.adblock
// @version      1.1.3
// @description  去掉 iyf.tv 页面广告、暂停广告和视频贴片
// @author       local
// @match        *://*.iyf.tv/*
// @match        *://*.aiyifan.tv/*
// @match        *://*.yfsp.tv/*
// @match        *://*.yifan.tv/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=iyf.tv
// @run-at       document-start
// @grant        GM_addStyle
// @grant        unsafeWindow
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  const PLAY_RE = /\/(play|watch)(\/|$)/;
  const patchedPlayers = new WeakSet();
  let scanTimer = 0;
  let skipTimer = 0;

  injectPageHook();
  addStyle(`
    .dabf,
    app-gg-block,
    [class*="gg-bg-cover"],
    .gg-tips-text,
    a[href*="/c/c?"][href*="ppt."],

    vg-pause-f,
    vg-pause-f .vg-vvk-p,
    vg-pause-f .vg-bg,
    vg-pause-f .vg-b,
    vg-pause-ads,
    .vg-overlay-pause,
    .vg-learn-more,
    .vg-tips-text,
    .publicbox,
    .publicbox.blocked,
    .publicbox .block-center,
    .publicbox .learn-more,
    vg-player .publicbox,
    .video-container .publicbox,
    .video-player .overlay-logo,
    #coin-or-upgrade-to-skip-ad,

    html.iyf-play-page #sticky-block #openRechargeBoxService,
    html.iyf-play-page #sticky-block .appIconColor,
    ins.adsbygoogle,
    iframe[src*="doubleclick"],
    iframe[src*="googlesyndication"],
    iframe[src*="googletag"] {
      display: none !important;
      visibility: hidden !important;
      pointer-events: none !important;
    }
  `);
  addStyle(`
    a:has(img[alt*="广告"]),
    .ps.pggf > .bl:has(.dabf),
    vg-player > vg-pause-ads + div.caption.show,
    html.iyf-play-page #sticky-block .stick-block-button:has(.iconVIP),
    html.iyf-play-page #sticky-block .stick-block-button:has(.iconxiazaiAPP),
    .cdk-global-overlay-wrapper:has(app-ask-app-download-dialog) {
      display: none !important;
    }
  `);

  hookHistory();
  markPlayPage();

  const boot = () => {
    markPlayPage();
    scan();
    observe();
    setInterval(() => {
      markPlayPage();
      if (isPlayPage()) scan();
      closeDownloadDialog();
    }, 500);
  };

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot);

  function injectPageHook() {
    const source = `;(${pageHook})();`;
    const inject = (el) => {
      const root = document.documentElement || document.head;
      if (!root) return false;
      root.appendChild(el);
      el.remove();
      return true;
    };
    try {
      const el = document.createElement('script');
      el.textContent = source;
      inject(el);
    } catch (_) {}
    if (typeof unsafeWindow !== 'undefined') {
      try {
        unsafeWindow.eval(source);
      } catch (_) {}
    }
    try {
      const blob = new Blob([source], { type: 'text/javascript' });
      const url = URL.createObjectURL(blob);
      const el = document.createElement('script');
      el.src = url;
      inject(el);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (_) {}
    try {
      pageHook();
    } catch (_) {}
  }

  function pageHook() {
    if (window.__iyfAdNetHook) return;
    window.__iyfAdNetHook = true;

    pinAdsBlocked();
    injectPageCss();
    setInterval(pinAdsBlocked, 800);
    setInterval(kickBlockedOverlay, 400);
    watchOverlays();

    const PLAY_JSON = /\/v3\/video\/(?:play|detail)(?:\?|$)/i;
    const GG_JSON = /\/play\/o(?:\?|$)/i;

    function shouldPatch(url) {
      const u = String(url || '');
      return PLAY_JSON.test(u) || GG_JSON.test(u);
    }

    function isAdStream(item) {
      if (!item || typeof item !== 'object') return false;
      if (item.isAd || item.isAds) return true;
      const link = item.link || item.linkUrl || '';
      return Boolean(link);
    }

    function isBanner(item) {
      if (!item || typeof item !== 'object') return false;
      if (item.rawImage && (item.position || item.linkUrl)) return true;
      const link = String(item.linkUrl || item.link || '');
      return /\/c\/c\?|position=/i.test(link);
    }

    function scrub(obj, depth) {
      if (!obj || typeof obj !== 'object' || depth > 8) return;
      if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) scrub(obj[i], depth + 1);
        return;
      }

      if (Array.isArray(obj.flvPathList)) {
        const kept = obj.flvPathList.filter((item) => !isAdStream(item));
        if (kept.length) obj.flvPathList = kept;
      }
      if (Array.isArray(obj.pauseData)) obj.pauseData = [];
      if (Array.isArray(obj.startData)) obj.startData = [];
      if ('maxFrontAds' in obj) obj.maxFrontAds = 0;
      if ('isUserFilterAd' in obj) obj.isUserFilterAd = true;
      if (Array.isArray(obj.extraList)) {
        obj.extraList = obj.extraList.filter((item) => !isBanner(item));
      }
      if (Array.isArray(obj.data) && obj.data.length && obj.data.every(isBanner)) {
        obj.data = [];
      }

      for (const key of Object.keys(obj)) {
        const val = obj[key];
        if (val && typeof val === 'object') scrub(val, depth + 1);
      }
    }

    function patchText(url, text) {
      if (!text || (text[0] !== '{' && text[0] !== '[')) return text;
      try {
        const data = JSON.parse(text);
        if (GG_JSON.test(url) && data && 'data' in data) {
          data.data = [];
          return JSON.stringify(data);
        }
        scrub(data, 0);
        return JSON.stringify(data);
      } catch (_) {
        return text;
      }
    }

    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        return origFetch.apply(this, arguments).then((res) => {
          const finalUrl = res.url || url;
          if (!shouldPatch(url) && !shouldPatch(finalUrl)) return res;
          return res.text().then((text) => {
            const patched = patchText(finalUrl, text);
            return new Response(patched, {
              status: res.status,
              statusText: res.statusText,
              headers: res.headers,
            });
          });
        });
      };
    }

    const xhrProto = XMLHttpRequest.prototype;
    const origOpen = xhrProto.open;
    xhrProto.open = function (method, url) {
      this.__iyfAdUrl = url;
      return origOpen.apply(this, arguments);
    };

    const rtDesc = Object.getOwnPropertyDescriptor(xhrProto, 'responseText');
    const rpDesc = Object.getOwnPropertyDescriptor(xhrProto, 'response');
    if (rtDesc && rtDesc.get) {
      Object.defineProperty(xhrProto, 'responseText', {
        configurable: true,
        get() {
          const raw = rtDesc.get.call(this);
          if (this.readyState !== 4 || !shouldPatch(this.__iyfAdUrl)) return raw;
          if (this.__iyfAdText == null) this.__iyfAdText = patchText(this.__iyfAdUrl, raw);
          return this.__iyfAdText;
        },
      });
    }
    if (rpDesc && rpDesc.get) {
      Object.defineProperty(xhrProto, 'response', {
        configurable: true,
        get() {
          const raw = rpDesc.get.call(this);
          if (this.readyState !== 4 || this.responseType === 'blob' || this.responseType === 'arraybuffer') {
            return raw;
          }
          if (!shouldPatch(this.__iyfAdUrl)) return raw;
          const text = typeof raw === 'string' ? raw : rtDesc && rtDesc.get ? rtDesc.get.call(this) : '';
          if (this.__iyfAdText == null) this.__iyfAdText = patchText(this.__iyfAdUrl, text);
          if (this.responseType === 'json') {
            try {
              return JSON.parse(this.__iyfAdText);
            } catch (_) {
              return raw;
            }
          }
          return this.__iyfAdText;
        },
      });
    }

    function pinAdsBlocked() {
      try {
        window.isAdsBlocked = false;
      } catch (_) {}
      try {
        Object.defineProperty(window, 'isAdsBlocked', {
          configurable: true,
          enumerable: true,
          get() {
            return false;
          },
          set() {},
        });
      } catch (_) {
        try {
          window.isAdsBlocked = false;
        } catch (__) {}
      }
    }

    function injectPageCss() {
      if (document.getElementById('iyf-adblock-page-css')) return;
      const el = document.createElement('style');
      el.id = 'iyf-adblock-page-css';
      el.textContent =
        '.dabf,app-gg-block,[class*="gg-bg-cover"],.gg-tips-text,a[href*="/c/c?"][href*="ppt."],' +
        'vg-pause-f,vg-pause-f .vg-vvk-p,vg-pause-f .vg-bg,vg-pause-f .vg-b,vg-pause-ads,.vg-overlay-pause,' +
        '.vg-learn-more,.vg-tips-text,.publicbox,.publicbox.blocked,.publicbox .block-center,.publicbox .learn-more,' +
        'vg-player .publicbox,.video-container .publicbox,#coin-or-upgrade-to-skip-ad,' +
        'ins.adsbygoogle,iframe[src*="doubleclick"],iframe[src*="googlesyndication"],iframe[src*="googletag"]' +
        '{display:none!important;visibility:hidden!important;pointer-events:none!important}';
      const root = document.head || document.documentElement;
      if (root) root.appendChild(el);
    }

    function overlaySelector() {
      return 'vg-pause-f, vg-pause-f .vg-vvk-p, vg-pause-f .vg-bg, vg-pause-f .vg-b, .vg-learn-more, .vg-tips-text, .publicbox, .publicbox .block-center, .publicbox .learn-more';
    }

    function watchOverlays() {
      let kickTimer = 0;
      const run = () => {
        injectPageCss();
        hideOverlays();
        if (kickTimer) return;
        kickTimer = setTimeout(() => {
          kickTimer = 0;
          kickBlockedOverlay();
        }, 80);
      };
      const start = () => {
        run();
        const root = document.documentElement;
        if (!root || root.__iyfAdMo) return;
        root.__iyfAdMo = true;
        new MutationObserver(run).observe(root, { childList: true, subtree: true });
      };
      if (document.documentElement) start();
      else document.addEventListener('DOMContentLoaded', start);
    }

    function hideOverlays() {
      const nodes = document.querySelectorAll(overlaySelector());
      for (let i = 0; i < nodes.length; i++) hideNode(nodes[i]);
      const closer = document.querySelector('vg-pause-f .vg-pause-close-font');
      if (closer) {
        try {
          closer.click();
        } catch (_) {}
      }
      clearPauseImage();
    }

    function clearPauseImage() {
      const el = document.querySelector('vg-pause-f');
      const ctx = el && el.__ngContext__;
      if (!ctx) return;
      const seen = [];
      const stack = [ctx];
      let steps = 0;
      while (stack.length && steps++ < 500) {
        const cur = stack.pop();
        if (!cur || typeof cur !== 'object') continue;
        let known = false;
        for (let i = 0; i < seen.length; i++) if (seen[i] === cur) known = true;
        if (known || cur.nodeType) continue;
        seen.push(cur);
        if ('pauseImage' in cur) {
          try {
            cur.pauseImage = null;
          } catch (_) {}
          try {
            cur.shouldShow = false;
          } catch (_) {}
          try {
            if (Array.isArray(cur.list)) cur.list = [];
          } catch (_) {}
          return;
        }
        if (Array.isArray(cur)) {
          const limit = Math.min(cur.length, 80);
          for (let i = 0; i < limit; i++) stack.push(cur[i]);
        }
      }
    }

    function wrapApi(api) {
      if (!api || api.__iyfSkipPlay) return;
      api.__iyfSkipPlay = true;
      const orig = api.playVideo;
      if (typeof orig !== 'function') return;
      api.playVideo = function (list, asAd) {
        if (asAd) return;
        const cleaned = Array.isArray(list) ? list.filter((item) => item && !item.isAd) : list;
        return orig.call(this, cleaned && cleaned.length ? cleaned : list, false);
      };
    }

    function isPlayerComp(obj) {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
      if (typeof obj.skipAd === 'function' && 'isPublicBlocked' in obj) return true;
      if (typeof obj.filterAllAds === 'function' && obj.pgmp) return true;
      if (typeof obj.isPublicBlocked === 'boolean' && 'leftSecond' in obj) return true;
      return false;
    }

    function readNgComp(el) {
      const ctx = el && el.__ngContext__;
      if (!ctx) return null;
      const direct = [ctx[8], ctx[9], ctx[20]];
      for (let i = 0; i < direct.length; i++) {
        if (isPlayerComp(direct[i])) return direct[i];
      }
      return null;
    }

    function findPagePlayer() {
      const nodes = document.querySelectorAll(
        '.video-container, aa-videoplayer, vg-player, .aa-videoplayer-wrap'
      );
      for (let i = 0; i < nodes.length; i++) {
        const comp = readNgComp(nodes[i]);
        if (comp) return comp;
      }
      return null;
    }

    function kickBlockedOverlay() {
      pinAdsBlocked();
      hideOverlays();
      const comp = findPagePlayer();
      if (!comp) return;
      try {
        if (comp._utility) comp._utility.canViewPublic = true;
      } catch (_) {}
      try {
        if (comp.api) {
          comp.api.canViewPublic = true;
          wrapApi(comp.api);
        }
      } catch (_) {}
      const dummyAd = comp.currentPlayingAds && comp.currentPlayingAds.isAd && !comp.currentPlayingAds.src;
      if (comp.isPublicBlocked || dummyAd) {
        try {
          comp.isPublicBlocked = false;
        } catch (_) {}
        try {
          comp.isPlayingAds = false;
        } catch (_) {}
        try {
          comp.leftSecond = 0;
        } catch (_) {}
        if (dummyAd) {
          try {
            comp.currentPlayingAds = null;
          } catch (_) {}
        }
        try {
          if (comp.pgmp && typeof comp.pgmp.cancel === 'function') comp.pgmp.cancel();
        } catch (_) {}
        try {
          if (comp.pgmp && typeof comp.pgmp.stopPlay === 'function') comp.pgmp.stopPlay();
        } catch (_) {}
        try {
          if (comp.api && typeof comp.api.play === 'function') comp.api.play();
        } catch (_) {}
        try {
          if (typeof comp.toPlay === 'function') comp.toPlay();
        } catch (_) {}
      }
    }

    function hideNode(el) {
      if (!el || !el.style) return;
      el.style.setProperty('display', 'none', 'important');
      el.style.setProperty('visibility', 'hidden', 'important');
      el.style.setProperty('pointer-events', 'none', 'important');
      el.hidden = true;
    }
  }

  function addStyle(css) {
    try {
      const el = document.createElement('style');
      el.setAttribute('data-iyf-adblock', '1');
      el.textContent = css;
      (document.head || document.documentElement).appendChild(el);
    } catch (_) {}
    if (typeof GM_addStyle === 'function') {
      try {
        GM_addStyle(css);
      } catch (_) {}
    }
  }

  function isPlayPage() {
    return PLAY_RE.test(location.pathname);
  }

  function markPlayPage() {
    document.documentElement.classList.toggle('iyf-play-page', isPlayPage());
  }

  function hookHistory() {
    const wrap = (fn) =>
      function () {
        const ret = fn.apply(this, arguments);
        queueMicrotask(() => {
          markPlayPage();
          scheduleScan();
        });
        return ret;
      };
    history.pushState = wrap(history.pushState);
    history.replaceState = wrap(history.replaceState);
    window.addEventListener('popstate', () => {
      markPlayPage();
      scheduleScan();
    });
  }

  function observe() {
    const root = document.documentElement;
    if (!root || root.__iyfAdObs) return;
    root.__iyfAdObs = true;
    new MutationObserver(() => {
      markPlayPage();
      scheduleScan();
    }).observe(root, { childList: true, subtree: true });
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      scan();
    }, 200);
  }

  function scan() {
    document.querySelectorAll('aa-videoplayer, vg-player').forEach(neutralizePlayer);
    if (isPlayPage()) skipPlayingAd();
    closeDownloadDialog();
  }

  function neutralizePlayer(el) {
    const player = findPlayerComp(el);
    if (player && isAdNow(null, player, el)) {
      leaveAdState(player);
      dropAdMedia(player);
    }
    const ctx = el && el.__ngContext__;
    if (ctx) dropAdMedia(ctx);

    if (!patchedPlayers.has(el)) {
      patchedPlayers.add(el);
      bindVideo(el);
    }
  }

  function dropAdMedia(root) {
    findNg(root, (obj) => {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
      for (const key of Object.keys(obj)) {
        const val = obj[key];
        if (!Array.isArray(val) || !val.length) continue;
        if (!val.some((item) => item && typeof item === 'object' && (item.isAd || item.isAds))) continue;
        try {
          obj[key] = val.filter((item) => !(item && (item.isAd || item.isAds)));
        } catch (_) {}
      }
      return false;
    });
  }

  function bindVideo(root) {
    root.querySelectorAll('video').forEach((video) => {
      if (video.__iyfAdBound) return;
      video.__iyfAdBound = true;
      ['play', 'loadedmetadata', 'durationchange', 'pause', 'timeupdate'].forEach((evt) => {
        video.addEventListener(evt, () => scheduleSkip(), { passive: true });
      });
    });
  }

  function scheduleSkip() {
    if (skipTimer) return;
    skipTimer = setTimeout(() => {
      skipTimer = 0;
      skipPlayingAd();
    }, 200);
  }

  function skipPlayingAd() {
    hideBlockedOverlay();
    const videos = document.querySelectorAll('vg-player video, aa-videoplayer video, video#video_player');
    const seen = new Set();
    const playerEl =
      document.querySelector('aa-videoplayer') ||
      document.querySelector('.video-container') ||
      document.querySelector('vg-player');
    const rootComp = findPlayerComp(playerEl);
    if (rootComp && isAdNow(null, rootComp, playerEl)) leaveAdState(rootComp);

    for (const video of videos) {
      if (!video || seen.has(video)) continue;
      seen.add(video);

      const box = video.closest('aa-videoplayer, .video-container, vg-player') || video;
      const comp = findPlayerComp(box) || rootComp;
      if (!isAdNow(video, comp, box)) continue;
      if (comp) leaveAdState(comp);

      if (isMainVideo(video) && Number.isFinite(video.duration) && video.duration > 1 && video.duration < 90) {
        try {
          video.currentTime = video.duration;
        } catch (_) {}
      }

      resumeVideo(video);
    }
  }

  function leaveAdState(comp) {
    if (!comp) return;
    try {
      if (comp._utility) comp._utility.canViewPublic = true;
    } catch (_) {}
    try {
      comp.isPlayingAds = false;
    } catch (_) {}
    try {
      comp.isPublicBlocked = false;
    } catch (_) {}
    try {
      comp.leftSecond = 0;
    } catch (_) {}
    if (comp.media) {
      try {
        comp.media.isAd = false;
      } catch (_) {}
    }
    if (comp.currentPlayingAds && !comp.currentPlayingAds.src) {
      try {
        comp.currentPlayingAds = null;
      } catch (_) {}
    }
    const pgmp = comp.pgmp;
    if (pgmp) {
      try {
        pgmp.isPlayingAds = false;
      } catch (_) {}
      if (typeof pgmp.cancel === 'function') {
        try {
          pgmp.cancel();
        } catch (_) {}
      }
      if (typeof pgmp.stopPlay === 'function') {
        try {
          pgmp.stopPlay();
        } catch (_) {}
      }
    }
    const api = comp.api;
    if (api) {
      try {
        api.isPlayingAds = false;
      } catch (_) {}
      try {
        api.canViewPublic = true;
      } catch (_) {}
      if (typeof api.backToPlay === 'function') {
        try {
          api.backToPlay();
        } catch (_) {}
      }
      if (typeof api.play === 'function') {
        try {
          api.play();
        } catch (_) {}
      }
    }
    if (typeof comp.toPlay === 'function') {
      try {
        comp.toPlay();
      } catch (_) {}
    }
  }

  function resumeVideo(video) {
    if (!video || !video.paused) return;
    const play = video.play();
    if (play && typeof play.catch === 'function') play.catch(() => {});
  }

  function isMainVideo(video) {
    if (video.id === 'video_player') return true;
    const box = video.getBoundingClientRect();
    return box.width > 120 && box.height > 80;
  }

  function isAdNow(video, comp, playerEl) {
    if (comp) {
      if (comp.isPublicBlocked) return true;
      if (comp.currentPlayingAds && (comp.currentPlayingAds.isAd || !comp.currentPlayingAds.src)) return true;
      if (comp.isPlayingAds && comp.media && comp.media.isAd) return true;
    }
    if (playerEl && playerEl.querySelector && playerEl.querySelector('.publicbox, vg-pause-ads')) return true;
    if (!video) return false;
    const src = video.currentSrc || video.src || '';
    if (/\/c\/c|pptstatic|global-cdn\.me\/vod\//i.test(src) && video.duration > 1 && video.duration < 90) return true;
    return false;
  }

  function hideBlockedOverlay() {
    document
      .querySelectorAll(
        'vg-pause-f, vg-pause-f .vg-vvk-p, vg-pause-f .vg-bg, vg-pause-f .vg-b, .vg-learn-more, .vg-tips-text, .publicbox, .publicbox .block-center, .publicbox .learn-more'
      )
      .forEach(hideDom);
    const closer = document.querySelector('vg-pause-f .vg-pause-close-font');
    if (closer) {
      try {
        closer.click();
      } catch (_) {}
    }
    const root = document.querySelector('vg-player, .video-container, aa-videoplayer');
    if (!root) return;
    root.querySelectorAll('div, span, p').forEach((el) => {
      if (el.childElementCount > 3) return;
      const text = (el.textContent || '').replace(/\s+/g, '');
      if (text.indexOf('暂时无法显示广告') !== -1) hideDom(el.closest('.publicbox') || el);
    });
  }

  function hideDom(el) {
    if (!el || !el.style) return;
    el.style.setProperty('display', 'none', 'important');
    el.style.setProperty('visibility', 'hidden', 'important');
    el.style.setProperty('pointer-events', 'none', 'important');
    el.hidden = true;
  }

  function isPlayerComp(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    if (typeof obj.skipAd === 'function' && 'isPublicBlocked' in obj) return true;
    if (typeof obj.filterAllAds === 'function' && obj.pgmp) return true;
    if (typeof obj.isPublicBlocked === 'boolean' && 'leftSecond' in obj) return true;
    if (obj.pgmp && typeof obj.pgmp.stopPlay === 'function') return true;
    return false;
  }

  function readNgComp(el) {
    const ctx = el && el.__ngContext__;
    if (!ctx) return null;
    const direct = [ctx[8], ctx[9], ctx[20]];
    for (let i = 0; i < direct.length; i++) {
      if (isPlayerComp(direct[i])) return direct[i];
    }
    return findNg(ctx, isPlayerComp);
  }

  function findPlayerComp(el) {
    const nodes = [];
    if (el && el.querySelector) {
      const inner = el.querySelector('.video-container, vg-player, aa-videoplayer');
      if (inner) nodes.push(inner);
    }
    let node = el;
    while (node && node !== document.documentElement) {
      nodes.push(node);
      node = node.parentElement;
    }
    for (let i = 0; i < nodes.length; i++) {
      const found = readNgComp(nodes[i]);
      if (found) return found;
    }
    return readNgComp(document.querySelector('.video-container')) || readNgComp(document.querySelector('aa-videoplayer'));
  }

  function isDomLike(obj) {
    if (!obj || typeof obj !== 'object') return false;
    if (obj === window) return true;
    const type = obj.nodeType;
    return type === 1 || type === 3 || type === 9 || type === 11;
  }

  function findNg(root, pred) {
    if (!root) return null;
    const seen = new Set();
    const stack = [root];
    let steps = 0;
    while (stack.length && steps++ < 4000) {
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
      if (isDomLike(cur)) continue;
      seen.add(cur);
      try {
        if (pred(cur)) return cur;
      } catch (_) {}
      if (Array.isArray(cur)) {
        const limit = Math.min(cur.length, 400);
        for (let i = 0; i < limit; i++) stack.push(cur[i]);
      } else {
        const keys = Object.keys(cur);
        const limit = Math.min(keys.length, 80);
        for (let i = 0; i < limit; i++) {
          try {
            stack.push(cur[keys[i]]);
          } catch (_) {}
        }
      }
    }
    return null;
  }

  function closeDownloadDialog() {
    document.querySelectorAll('app-ask-app-download-dialog, #coin-or-upgrade-to-skip-ad').forEach((dialog) => {
      const wrap = dialog.closest('.cdk-global-overlay-wrapper') || dialog;
      const backdrop = wrap.previousElementSibling;
      if (backdrop && backdrop.classList.contains('cdk-overlay-backdrop')) {
        try {
          backdrop.click();
        } catch (_) {}
      }
    });
  }
})();
