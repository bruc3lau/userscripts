# 爱壹帆去广告脚本

`iyf-tv-adblock.user.js`，油猴脚本。装到 Tampermonkey / Violentmonkey 里，打开 iyf.tv、yifan.tv、yfsp.tv、aiyifan.tv 就会跑。

站点是 Angular + Videogular。广告不是单纯往页面塞 iframe，播放接口会把贴片和正片混在同一个列表里。所以脚本分三层：接口里把广告条目抠掉、CSS 把横幅藏掉、播放器万一还是播了贴片再跳过。

`@run-at document-start` 是必须的。贴片数据在 `/v3/video/play` 里，页面脚本发这个请求非常早。钩子装晚了，播放器已经拿到带广告的 JSON 了。

`@grant GM_addStyle` 之后油猴默认跑在隔离沙箱里。沙箱里改 `window.fetch` 动不到页面那份，所以网络钩子要用 `<script>` 再注进页面上下文。CSS 用 `GM_addStyle` 就行，DOM 是共享的。

---

## 站点广告从哪来

2026 年 9 月在 `www.yifan.tv` 播放页拆过。

播放接口 `GET /v3/video/play` 返回的 `data.info[0]` 大概长这样：

```json
{
  "flvPathList": [
    {
      "result": "https://s1-a1.global-cdn.me/vod/....mp4",
      "duration": 20,
      "isHls": false,
      "link": "https://ppt.yifan.tv/c/c?position=PI&i=482"
    },
    {
      "result": "https://..../chunklist.m3u8",
      "duration": 0,
      "isHls": true,
      "link": null
    }
  ],
  "pauseData": [{ "result": "https://pptstatic.yifan.tv/....jpg", "link": "https://ppt.yifan.tv/c/c?position=PZ..." }],
  "startData": [],
  "maxFrontAds": 1,
  "isUserFilterAd": false
}
```

第一条有 `link`，20 秒 MP4，这就是片头贴片。第二条 `link` 为空，才是片子。站点自己的播放器源码也是这个判断：`if (h.link)` 当广告，否则当正片。VIP 权限名是 `FilterFrontAds` / `FilterPauseAds`。

`pauseData` 是暂停时盖在画面上的图，对应 DOM 里的 `vg-pause-f`。

视频详情里还有 `extraList`，`position: "PB"` 那种，对应播放器底下那条 VIP 横幅。

页面右侧两块图、底下一根横幅，DOM 都是 `.dabf`，图的 `alt="广告"`，点击跳 `ppt.*.tv/c/c?position=PRU|PRD|PB`。右侧栏外层是 `.ps.pggf`，里面广告块和 UP 主卡片（`video-publisher`）排在一起。旧脚本把整个 `.ps.pggf` 藏掉，UP 主一起没了。

`ppt.yifan.tv/play/o` 是 gg-block 接口。这次实测 `data` 经常是空数组，横幅不走它，但别的地区/域名可能还在用，照样清空。

`/assets/prebid-ads.js` 不是广告脚本，是检测广告拦截：去拉 `adsbygoogle.js`，失败就把 `window.isAdsBlocked = true`。我们拦 Google 的话，站点可能弹「请关闭广告拦截」。所以脚本把这个变量钉死成 `false`，Google 框用 CSS 藏，不去掐那个 JS 请求。

---

## 脚本启动顺序

油猴匹配到域名后，立刻进 IIFE，顺序是写死的：

1. `injectPageHook()` — 把网络钩子注进页面
2. `addStyle(...)` — 写入 CSS
3. `hookHistory()` — 包一层 `pushState` / `replaceState`
4. `markPlayPage()` — 播放页给 `<html>` 加上 `iyf-play-page`
5. 等 `document.body`（或 `DOMContentLoaded`）再 `boot()`

`boot()` 里会再标一次播放页、扫一遍播放器、挂 MutationObserver，然后每 500ms 补扫。Angular 是异步插节点的，CSS 能挡住横幅，但跳过贴片、关下载弹窗要等元素出现。

---

## 1. `injectPageHook`：把钩子塞进页面

```js
const source = `;(${pageHook})();`;
el.textContent = source;
root.appendChild(el);
el.remove();
```

`pageHook` 是函数，模板字符串会调用 `Function.prototype.toString()`，得到函数源码，包成 IIFE 插进去。插完立刻删掉 script 标签，钩子已经留在页面 `window` 上了。

用 `__iyfAdNetHook` 防重复。SPA 里如果脚本被触发两次，不能把 `fetch` 套两层。

沙箱里这块失败也没关系（try/catch），CSS 和后面的跳过逻辑还在。

---

## 2. `pageHook`：改播放 JSON

这是去贴片的主路径。跑在页面上下文。

### 钉死 `isAdsBlocked`

```js
Object.defineProperty(window, 'isAdsBlocked', {
  get() { return false; },
  set() {},
});
```

`prebid-ads.js` 后写也写不进去。站点以为广告没被拦，就不会弹拦截提示。

### 要不要改这份响应

只动两类 URL：

- `/v3/video/play`、`/v3/video/detail` — 播放和详情
- `/play/o` — gg-block

其它请求原样返回。乱改首页、弹幕、清晰度列表会把站搞坏。

### `isAdStream`

和站点同一条规则：对象带 `isAd` / `isAds`，或者 `link` / `linkUrl` 有值，就当广告流。正片的 `link` 是 `null`。

如果某一档清晰度全是广告、滤完变成空数组，就不动原来的列表，避免播不了。正常片子至少还有一条 HLS。

### `isBanner`

`extraList` 里那种带 `rawImage` + `position` / `linkUrl` 的运营图。详情接口 scrub 的时候会丢掉。

### `scrub`

递归往 JSON 里走（深度最多 8），碰到这些字段就改：

| 字段 | 做法 | 对应什么 |
|---|---|---|
| `flvPathList` | 丢掉带 `link` 的项 | 片头贴片 |
| `pauseData` | 置 `[]` | 暂停广告素材 |
| `startData` | 置 `[]` | 另一路片头 |
| `maxFrontAds` | 置 `0` | 播放器最多塞几条贴片 |
| `isUserFilterAd` | 置 `true` | 假装用户开了过滤 |
| `extraList` | 丢掉 banner 项 | 播放器下方横幅数据 |
| `data`（且每项都是 banner） | 置 `[]` | gg-block 列表 |

`/play/o` 不走完整 scrub，直接 `data = []`。这个接口的 `data` 本来就是广告块数组。

### 钩 `fetch`

匹配 URL 才 `res.text()` 再拼新的 `Response`。不匹配的请求连 body 都不读，免得拖慢或搞坏流式响应。

### 钩 XHR

Angular `HttpClient` 还在用 XHR。改 `open` 把 URL 记在 `this.__iyfAdUrl`。真正动手的是改原型上的 `responseText` / `response` getter：谁读，谁拿到改过的内容。

不能在 `readystatechange` 里事后改，Angular 自己的监听可能更早就读过原文了。改 getter 保证无论谁先读都是过滤后的。

`responseType` 是 `blob` / `arraybuffer` 的不碰。`json` 的把改过的字符串再 `JSON.parse` 一次再给。

同一份 XHR 的结果缓存在 `__iyfAdText`，避免 getter 被读很多次就 parse 很多次。

钩子成功的话，播放器从一开始就只有正片，`#video_player` 的 `duration` 是整部片子（实测玩具总动员 5 是 6206 秒），不会先播 20 秒 MP4。

---

## 3. `addStyle`：藏页面上的广告

`GM_addStyle` 能用就用，没有就自己建 `<style>`。选择器都带 `!important`，跟站点的 Angular 样式抢。

`.dabf` 是横幅容器，播放器下一条、右侧两块都是它。

`.ps.pggf > .bl:has(.dabf)` 只藏包着广告的那一层。`.ps.pggf` 里还有 `video-publisher`，整栏藏掉的话 UP 主卡片会没。1.0.0 就是这么干的，1.1.0 改了。

`a:has(img[alt*="广告"])` 和 `a[href*="/c/c?"][href*="ppt."]` 是兜底，有的广告节点不一定挂着 `.dabf`。

`vg-pause-f` / `vg-pause-ads` / `.publicbox` 是暂停广告和贴片倒计时层。`.publicbox` 在播放器源码里 `z-index: 5003`，盖满画面。部分地区播不出广告素材时，播放器会给它加上 `.blocked`：模糊蒙版 + 倒计时，正片还会被 `pause()`。所以不能只藏图层，还得把 `isPlayingAds` / `isPublicBlocked` 拨掉并恢复播放。

`:has()` 选择器和普通规则拆成两段 CSS。旧版写在同一条规则里，iPad Safari 如果不认 `:has()`，整段（包括 `.publicbox`）都会失效，倒计时蒙版就还在。

播放页右侧工具条不要整列干掉。`#sticky-block .inner` 里有简繁体、换肤、帮助，旧脚本一锅端了。现在只在 `html.iyf-play-page` 下藏 VIP 和下载 APP。

下载 APP 弹窗用 `.cdk-global-overlay-wrapper:has(app-ask-app-download-dialog)` 藏，另外 `closeDownloadDialog` 会去点遮罩，让 Angular 把组件拆掉，不只是看不见。

Google 的 `ins.adsbygoogle` 和 doubleclick / googlesyndication iframe 一并藏。

故意没写的：

- `a[href*="wuye"]` — 侧栏「午夜版」导航，不是广告
- `.page-right:has(app-gg-block)` — 现在横幅根本不是 `app-gg-block`，这个选择器还会误伤「相关内容」

---

## 4. 播放页标记和路由

路径匹配 `/play` 或 `/watch` 就算播放页。`markPlayPage` 给 `<html>` 开关 `iyf-play-page`，给上面那几条 sticky 选择器当条件。

站点是 SPA，切集、点推荐不会整页刷新。`hookHistory` 包了 `pushState` / `replaceState`，再听 `popstate`。每次路由变完（`queueMicrotask` 里）重新标记、重新扫播放器。

---

## 5. `boot` 之后：观察和定时扫

`observe` 在 `documentElement` 上挂 MutationObserver，子树有增删就 `scheduleScan`。200ms 节流，Angular 一次渲染会改很多节点，不能每次 mutation 都全量扫。

`setInterval(..., 500)` 是第二道。有的弹窗、贴片倒计时不是作为 childList 插进来，或者 observer 漏了。只在播放页才 `scan()` 播放器，下载弹窗每次都检查。

`scan` 就三件事：找 `aa-videoplayer` / `vg-player` 做 `neutralizePlayer`，播放页再 `skipPlayingAd`，然后 `closeDownloadDialog`。

---

## 6. `neutralizePlayer`：改播放器内存

接口钩子是主路径。这里防的是钩子没装上（沙箱注入失败、请求走了别的通道）时，播放器对象里已经有广告列表。

Angular Ivy 把组件实例放在元素的 `__ngContext__` 里，这是一个 LView 数组，不是简单的 `el.component`。`findNg` 在这个图上走，最多 1200 步，数组最多看 80 格，普通对象最多看 30 个 key。跳过 `Node` 和 `window`，不然会扫进整棵 DOM。

`findPlayerComp` 认两种对象：有布尔值 `isPlayingAds`，或者 `media.isAd`。找到了就把广告标志拨掉，再 `dropAdMedia`。

`dropAdMedia` 不返回命中（predicate 永远 false），它是借 `findNg` 的遍历，把带 `isAd` / `isAds` 的数组滤干净。播放器把 `flvPathList` 转成 `{ src, isAd, ... }` 之后，就是这种数组。

每个播放器节点只 `bindVideo` 一次，用 `WeakSet` 记。页面关了，引用跟着没。

---

## 7. 跳过已经在播的贴片

接口过滤失败时的退路。

`bindVideo` 在 `play` / `loadedmetadata` / `durationchange` / `pause` / `timeupdate` 上听，200ms 节流后进 `skipPlayingAd`。`timeupdate` 很密，节流是必要的。

只处理主视频：`#video_player`，或者面积大于 120×80 的。页面里还有一个 `empty2.mp4`（大约 1.1 秒、1×1 像素），是播放器占位，不能 seek。

`isAdNow` 几条路，满足一条就算广告：

1. 组件上 `isPlayingAds` 或 `media.isAd`
2. 组件上 `isPublicBlocked` 或 `leftSecond > 0`（被地区拦截的空蒙版倒计时）
3. DOM 里有 `.publicbox`（藏掉也算，因为正片可能已经被 pause）
4. 当前地址像广告 CDN（`pptstatic`、`global-cdn.me/vod/`、`/c/c`），而且时长 1～90 秒

确认是广告之后：点「跳过广告」按钮；把 `isPlayingAds` 拨回去；时长小于 90 秒就 seek 到结尾；如果暂停了就 `play()`。

点跳过很保守。只点文字匹配 `跳过广告` / `关闭广告` / `跳过12s` 这种短节点。`.control-fix` 只有落在 `.publicbox` 里才点，免得点到普通进度条。旧脚本见着 `.control-fix` 就点，会误伤控件。

---

## 8. `closeDownloadDialog`

找 `app-ask-app-download-dialog`，点它前面的 `.cdk-overlay-backdrop`。这是 Angular CDK 的标准关法，组件会卸掉，不是只靠 CSS 藏。

---

## 改动对照（1.0.0 → 1.1.0）

1.0.0 只靠 CSS 藏横幅，加上在 Angular 上下文里找 `pgmp` / `isPlayingAds`。2026 年 9 月的包里，播放器认的是 `flvPathList[].link`，`pgmp` 已经搜不到。而且 `findNg` 以前只走进数组，Ivy 的组件实例大量挂在对象 key 上，等于白找。

CSS 过杀：`.ps.pggf` 干掉 UP 主，`#sticky-block .inner` 干掉整列工具条，`a[href*="wuye"]` 干掉午夜版入口。

1.1.0 按站点现在的接口改 JSON，CSS 收到具体广告节点，跳过逻辑加上面积和 URL 判断，避免动到占位视频和普通控件。

1.1.1 处理空蒙版倒计时：地区播不出广告时播放器会盖 `.publicbox.blocked` 并暂停正片。CSS 把 `:has()` 拆出去，避免 iPad 整段样式失效；扫到蒙版就 `stopPlay` / 恢复 `play()`。油猴增加 `unsafeWindow`，iPad 上脚本进不了页面上下文时还能钩请求。

脚本不管清晰度 VIP。播放接口给免费用户的 `clarity` 里，720 / 1080 / 4K 是 `isVIP: true` 且 `path: null`，根本没有高清地址，改菜单点不出来。

在 `www.yifan.tv/play/...` 上对过：右侧两块图和底下一根 VIP 横幅没了，UP 主还在，右侧简繁体 / 换肤 / 帮助还在，VIP 和下载 APP 在播放页藏掉。暂停广告节点 `vg-pause-f` 被 CSS 藏掉。贴片这条依赖 document-start 的 fetch/XHR 钩子，油猴里 `@run-at document-start` 会比这次浏览器注入测试更早装上。
