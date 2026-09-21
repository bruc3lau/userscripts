// ==UserScript==
// @name         爱壹帆去广告
// @name:zh-CN   爱壹帆去广告
// @namespace    local.iyf.adblock
// @version      1.0.0
// @description  去掉 iyf.tv 页面广告、视频开头贴片和中间插播广告
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
  const emptyAds = makeEmptyList();
  let scanTimer = 0;
  let skipTimer = 0;

  addStyle(`
    a:has(img[alt*="广告"]),
    a[href*="wuye"],
    app-gg-block,
    app-gg-block.d-block,
    [class*="gg-bg-cover"],
    .dabf,
    .dabf.d-block,
    .ps.pggf,
    .video-player + div.ps,
    .page-right:has(app-gg-block),
    .player-side.player-right:has(app-gg-block),

    vg-pause-f,
    vg-pause-ads,
    .vg-overlay-pause,
    .publicbox,
    .video-player .overlay-logo,
    vg-player > vg-pause-ads + div.caption.show,

    #sticky-block .inner,
    html.iyf-play-page #sticky-block #openRechargeBoxService,
    html.iyf-play-page #sticky-block .stick-block-button:has(.iconVIP),
    html.iyf-play-page #sticky-block .appIconColor,
    html.iyf-play-page #sticky-block .stick-block-button:has(.iconxiazaiAPP),

    .cdk-global-overlay-wrapper:has(app-ask-app-download-dialog),
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
    }, 400);
  };

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot);

  function addStyle(css) {
    if (typeof GM_addStyle === 'function') {
      GM_addStyle(css);
      return;
    }
    const el = document.createElement('style');
    el.textContent = css;
    (document.head || document.documentElement).appendChild(el);
  }

  function makeEmptyList() {
    const inner = [];
    return new Proxy(inner, {
      get(target, prop) {
        if (prop === 'length') return 0;
        if (prop === 'push' || prop === 'unshift' || prop === 'splice' || prop === 'concat') {
          return () => 0;
        }
        if (prop === Symbol.iterator) return function* () {};
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set() {
        return true;
      },
    });
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
    if (!ctx) return;

    const pgmp = pickProp(ctx, 'pgmp');
    if (pgmp) freezeAdHost(pgmp);

    const player = findPlayerComp(el);
    if (player) {
      freezeAdHost(player.pgmp);
      freezeAdHost(player.ads);
      freezeAdHost(player.ad);
      if (player.media && player.media.isAd) {
        try {
          player.media.isAd = false;
        } catch (_) {}
      }
    }

    if (!patchedPlayers.has(el)) {
      patchedPlayers.add(el);
      bindVideo(el);
    }
  }

  function freezeAdHost(host) {
    if (!host || typeof host !== 'object') return;
    freezeListField(host, 'dataList');
    for (const key of Object.keys(host)) {
      if (!/^(dataList|ads|adList|preRoll|midRoll|pauseAds|pauseList)$/i.test(key)) continue;
      freezeListField(host, key);
    }
  }

  function freezeListField(host, key) {
    if (!(key in host)) return;
    try {
      Object.defineProperty(host, key, {
        configurable: true,
        enumerable: true,
        get: () => emptyAds,
        set() {},
      });
    } catch (_) {
      try {
        host[key] = emptyAds;
      } catch (_) {}
    }
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
    }, 250);
  }

  function skipPlayingAd() {
    const videos = [...document.querySelectorAll('vg-player video, aa-videoplayer video, video#video_player, video')];
    const seen = new Set();

    for (const video of videos) {
      if (!video || seen.has(video)) continue;
      seen.add(video);

      const playerEl = video.closest('aa-videoplayer, vg-player') || video;
      const comp = findPlayerComp(playerEl);
      const ad = isAdNow(video, comp, playerEl);
      if (!ad) continue;

      clickSkip(playerEl);
      callSkipMethods(comp);
      callSkipMethods(comp && comp.pgmp);

      if (Number.isFinite(video.duration) && video.duration > 0 && video.duration < 90) {
        try {
          video.currentTime = video.duration;
        } catch (_) {}
      }

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

      if (video.paused) {
        const play = video.play();
        if (play && typeof play.catch === 'function') play.catch(() => {});
      }
    }
  }

  function isAdNow(video, comp, playerEl) {
    if (comp && (comp.isPlayingAds || (comp.media && comp.media.isAd))) return true;
    const sec = playerEl.querySelector('.control-fix .second, .publicbox .second');
    const n = sec && String(sec.textContent || '').trim();
    if (n && /^\d+$/.test(n) && Number(n) > 0) return true;
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
    const buttons = findSkipButtons(root);
    for (const el of buttons) {
      try {
        el.click();
      } catch (_) {}
    }

    const countdown = (root || document).querySelector('.control-fix');
    if (countdown) {
      try {
        countdown.click();
      } catch (_) {}
    }
  }

  function callSkipMethods(obj) {
    if (!obj || typeof obj !== 'object') return;
    const names = [
      'skipAd',
      'skipAds',
      'skipCurrentAd',
      'closeAd',
      'endAd',
      'stopAd',
      'finishAd',
      'completeAd',
      'onAdComplete',
      'onAdEnded',
      'adSkip',
    ];
    for (const name of names) {
      if (typeof obj[name] === 'function') {
        try {
          obj[name]();
        } catch (_) {}
      }
    }
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] !== 'function') continue;
      if (!/skip.*ad|ad.*skip|close.*ad|end.*ad/i.test(key)) continue;
      try {
        obj[key]();
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
      if (typeof obj.onSelectBitrate === 'function' && Array.isArray(obj.bitrates)) return true;
      return false;
    });
  }

  function pickProp(root, key) {
    const host = findNg(
      root,
      (obj) => obj && typeof obj === 'object' && !Array.isArray(obj) && obj[key] != null
    );
    return host ? host[key] : null;
  }

  function findNg(root, pred) {
    if (!root) return null;
    const seen = new Set();
    const stack = [root];
    let steps = 0;
    while (stack.length && steps++ < 400) {
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
      seen.add(cur);
      try {
        if (pred(cur)) return cur;
      } catch (_) {}
      if (Array.isArray(cur)) {
        const limit = Math.min(cur.length, 80);
        for (let i = 0; i < limit; i++) stack.push(cur[i]);
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
