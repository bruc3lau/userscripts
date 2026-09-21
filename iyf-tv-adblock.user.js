// ==UserScript==
// @name         爱壹帆去广告
// @name:zh-CN   爱壹帆去广告
// @namespace    local.iyf.adblock
// @version      1.1.0
// @description  去掉 iyf.tv 页面广告、暂停广告和视频贴片
// @author       local
// @match        *://*.iyf.tv/*
// @match        *://*.aiyifan.tv/*
// @match        *://*.yfsp.tv/*
// @match        *://*.yifan.tv/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=iyf.tv
// @run-at       document-start
// @grant        GM_addStyle
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
    a:has(img[alt*="广告"]),
    a[href*="/c/c?"][href*="ppt."],
    .ps.pggf > .bl:has(.dabf),

    vg-pause-f,
    vg-pause-ads,
    .vg-overlay-pause,
    .publicbox,
    .video-player .overlay-logo,
    vg-player > vg-pause-ads + div.caption.show,

    html.iyf-play-page #sticky-block #openRechargeBoxService,
    html.iyf-play-page #sticky-block .stick-block-button:has(.iconVIP),
    html.iyf-play-page #sticky-block .appIconColor,
    html.iyf-play-page #sticky-block .stick-block-button:has(.iconxiazaiAPP),

    .cdk-global-overlay-wrapper:has(app-ask-app-download-dialog),
    ins.adsbygoogle,
    iframe[src*="doubleclick"],
    iframe[src*="googlesyndication"],
    iframe[src*="googletag"] {
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
    try {
      const el = document.createElement('script');
      el.textContent = source;
      const root = document.documentElement || document.head;
      if (root) {
        root.appendChild(el);
        el.remove();
      }
    } catch (_) {}
  }

  function pageHook() {
    if (window.__iyfAdNetHook) return;
    window.__iyfAdNetHook = true;

    try {
      Object.defineProperty(window, 'isAdsBlocked', {
        configurable: true,
        get() {
          return false;
        },
        set() {},
      });
    } catch (_) {}

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
  }

  function addStyle(css) {
    if (typeof GM_addStyle === 'function') {
      GM_addStyle(css);
      return;
    }
    const el = document.createElement('style');
    el.textContent = css;
    (document.head || document.documentElement).appendChild(el);
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
    const ctx = el && el.__ngContext__;
    if (ctx) {
      const player = findPlayerComp(el);
      if (player) {
        try {
          player.isPlayingAds = false;
        } catch (_) {}
        if (player.media && player.media.isAd) {
          try {
            player.media.isAd = false;
          } catch (_) {}
        }
        dropAdMedia(player);
      }
      dropAdMedia(ctx);
    }

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
    const videos = document.querySelectorAll('vg-player video, aa-videoplayer video, video#video_player');
    const seen = new Set();

    for (const video of videos) {
      if (!video || seen.has(video) || !isMainVideo(video)) continue;
      seen.add(video);

      const playerEl = video.closest('aa-videoplayer, vg-player') || video;
      const comp = findPlayerComp(playerEl);
      if (!isAdNow(video, comp, playerEl)) continue;

      clickSkip(playerEl);
      if (comp) {
        try {
          comp.isPlayingAds = false;
        } catch (_) {}
        if (comp.media) {
          try {
            comp.media.isAd = false;
          } catch (_) {}
        }
      }

      if (Number.isFinite(video.duration) && video.duration > 1 && video.duration < 90) {
        try {
          video.currentTime = video.duration;
        } catch (_) {}
      }

      if (video.paused) {
        const play = video.play();
        if (play && typeof play.catch === 'function') play.catch(() => {});
      }
    }
  }

  function isMainVideo(video) {
    if (video.id === 'video_player') return true;
    const box = video.getBoundingClientRect();
    return box.width > 120 && box.height > 80;
  }

  function isAdNow(video, comp, playerEl) {
    if (comp && (comp.isPlayingAds || (comp.media && comp.media.isAd))) return true;
    if (playerEl.querySelector('.publicbox, vg-pause-ads, .control-fix')) {
      const sec = playerEl.querySelector('.control-fix .second, .publicbox .second');
      const n = sec && String(sec.textContent || '').trim();
      if (n && /^\d+$/.test(n) && Number(n) > 0) return true;
      if (playerEl.querySelector('.publicbox') && getComputedStyle(playerEl.querySelector('.publicbox')).display !== 'none') {
        return true;
      }
    }
    const src = video.currentSrc || video.src || '';
    if (/\/c\/c|pptstatic|global-cdn\.me\/vod\//i.test(src) && video.duration > 1 && video.duration < 90) return true;
    return false;
  }

  function findSkipButtons(root) {
    const scope = root || document;
    const nodes = scope.querySelectorAll('button, a, span, div, i, p');
    const hits = [];
    for (const el of nodes) {
      if (el.childElementCount > 4) continue;
      const text = (el.textContent || '').replace(/\s+/g, '');
      if (!text || text.length > 16) continue;
      if (/跳过.*广告|关闭广告|跳过广告/.test(text) || /^跳过\d+s?$/.test(text)) {
        hits.push(el);
      }
    }
    return hits;
  }

  function clickSkip(root) {
    for (const el of findSkipButtons(root)) {
      try {
        el.click();
      } catch (_) {}
    }
    const countdown = (root || document).querySelector('.publicbox .control-fix, .control-fix');
    if (countdown && countdown.closest('.publicbox')) {
      try {
        countdown.click();
      } catch (_) {}
    }
  }

  function findPlayerComp(el) {
    const ctx = el && el.__ngContext__;
    if (!ctx) return null;
    return findNg(ctx, (obj) => {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
      if (typeof obj.isPlayingAds === 'boolean') return true;
      if (obj.media && typeof obj.media === 'object' && 'isAd' in obj.media) return true;
      return false;
    });
  }

  function findNg(root, pred) {
    if (!root) return null;
    const seen = new Set();
    const stack = [root];
    let steps = 0;
    while (stack.length && steps++ < 1200) {
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
      if (cur instanceof Node || cur instanceof Window) continue;
      seen.add(cur);
      try {
        if (pred(cur)) return cur;
      } catch (_) {}
      if (Array.isArray(cur)) {
        const limit = Math.min(cur.length, 80);
        for (let i = 0; i < limit; i++) stack.push(cur[i]);
      } else {
        const keys = Object.keys(cur);
        const limit = Math.min(keys.length, 30);
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
    document.querySelectorAll('app-ask-app-download-dialog').forEach((dialog) => {
      const wrap = dialog.closest('.cdk-global-overlay-wrapper');
      const backdrop = wrap && wrap.previousElementSibling;
      if (backdrop && backdrop.classList.contains('cdk-overlay-backdrop')) {
        try {
          backdrop.click();
        } catch (_) {}
      }
    });
  }
})();
