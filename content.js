// content.js —— 注入网页，控制视频播放速度
let currentRate = 1.0;
let blocked = false;
let autoFullscreen = false;

// 历史默认表：命中其中任一份，说明用户从未自定义过排除规则，
// 升级为当前默认表。第一份是初版（`live` 宽松匹配会误伤 `?is_live=1` 这类地址），
// 第二份是加入 `&list=` 之前的版本。
const HISTORICAL_DEFAULT_BLOCKLISTS = [
  ["/list/", "live", "missav", "list=WL", "wanyiwan"],
  ["/list/", "//live\\.", "missav", "list=WL", "wanyiwan"],
];

// 仅作 storage 读取失败时的兜底，真实来源是 storage
const DEFAULT_BLOCKLIST = [
  "/list/",
  "//live\\.",
  "missav",
  "list=WL",
  "&list=",
  "wanyiwan",
];

function sameList(a, b) {
  return a.length === b.length && a.every((p, i) => p === b[i]);
}

// 把未改动过的历史默认表升级成当前默认表
// 用户自己加过/删过规则的列表不会被改动
function migrateBlocklist(list) {
  if (!HISTORICAL_DEFAULT_BLOCKLISTS.some((def) => sameList(def, list))) {
    return list;
  }
  chrome.storage.local.set({ blocklist: DEFAULT_BLOCKLIST });
  return DEFAULT_BLOCKLIST;
}

// 排除规则匹配语义：
// 规则可能是域名（bilibili\.com）、路径（/list/）或参数（list=WL）。
// 旧实现拿完整 URL 直接 test，于是 `live` 这种短词会命中 `?is_live=1`、`alive`，
// 整页被误判成排除页并被打回 1x —— 刷抖音时表现为「突然没倍速了」。
// 现在分两条路：
//   - 规则以 `//` 或 `scheme://` 开头 → 视为「整条 URL」规则（如 `//live\.`），用完整 URL 匹配；
//   - 其他规则 → 用 host + pathname + search 匹配，避开协议与 hash 干扰。
const compiledRules = [];

function compileRule(p) {
  try {
    return { re: new RegExp(p), full: p.includes("://") || p.startsWith("//") };
  } catch {
    return null;
  }
}

function setBlocklist(list) {
  compiledRules.length = 0;
  for (const p of list) {
    const r = compileRule(p);
    if (r) compiledRules.push(r);
  }
}

// 当前 URL 是否命中排除规则
function isBlockedUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return compiledRules.some((r) => r.re.test(url));
  }
  const host = u.hostname.toLowerCase();
  // 两套候选串：带协议（给 `//live\.` 这类域名/URL 规则用）与不带（给路径、参数规则用）。
  // 非 full 规则只测 shortTarget，避免 `live` 这类短词又误命中 `alive.com`。
  const fullTarget = u.protocol + "//" + host + u.pathname + u.search;
  const shortTarget = host + u.pathname + u.search;
  return compiledRules.some((r) =>
    r.full ? r.re.test(fullTarget) : r.re.test(shortTarget)
  );
}

// 监听 DOM 变化，发现新视频
const observedRoots = new WeakSet();

function observeRoot(root) {
  if (observedRoots.has(root)) return;
  observedRoots.add(root);
  new MutationObserver(scheduleScan).observe(root, {
    childList: true,
    subtree: true,
  });
}

// 收集所有 video，并穿透 open Shadow DOM
function collectVideos(root) {
  const videos = Array.from(root.querySelectorAll("video"));
  for (const el of root.querySelectorAll("*")) {
    if (el.shadowRoot) {
      observeRoot(el.shadowRoot);
      videos.push(...collectVideos(el.shadowRoot));
    }
  }
  return videos;
}

// 外部持续改速时的写入限流：只做滑动窗口限速，不设「放弃期」。
// 旧实现是「累计 5 次就静默 10 秒」，而站点每次重置速度都算一次，
// 刷几个视频就进入静默期且结束后无人补救 → 表现成「时不时失效」。
// 这里只防真正的 ping-pong 死循环：1 秒内写超过 25 次就跳过本次，
// 但 500ms 一次的低频校对不受限，保证最多 0.5s 后一定回到目标倍速。
const WRITE_WINDOW = 1000;
const WRITE_LIMIT = 25;

// 已绑定的视频：WeakSet 用于去重，boundList 用于低频校对时遍历
const boundVideos = new WeakSet();
const boundList = [];

// 每个视频的写入时间戳，用于限流
const writeLogs = new WeakMap();

// 正在由本扩展写速的视频：避免自己写的值又触发 ratechange 造成自锁/重复计数
const writing = new WeakSet();

// 限流：同一视频 1 秒内最多纠正 WRITE_LIMIT 次，超出就跳过本次（下个事件/校对再补）
function canWrite(v) {
  const now = Date.now();
  let log = writeLogs.get(v);
  if (!log) {
    log = [];
    writeLogs.set(v, log);
  }
  while (log.length && now - log[0] > WRITE_WINDOW) log.shift();
  if (log.length >= WRITE_LIMIT) return false;
  log.push(now);
  return true;
}

// 同时写 defaultPlaybackRate：媒体重新加载（换 src / load()）时浏览器会把
// playbackRate 重置成 defaultPlaybackRate，只写 playbackRate 会被打回 1x
// 写入时打上透传标记：主世界的 setter 拦截器会放行扩展自己的写入。
function setRate(v, rate) {
  if (writing.has(v)) return;
  writing.add(v);
  try {
    v.__vsc_passthrough__ = true;
    if (Math.abs(v.defaultPlaybackRate - rate) > 1e-6) {
      v.defaultPlaybackRate = rate;
    }
    if (Math.abs(v.playbackRate - rate) > 1e-6) v.playbackRate = rate;
  } catch {
    // 视频已进入不可写状态（如被移除），忽略
  } finally {
    try {
      v.__vsc_passthrough__ = false;
    } catch {}
    writing.delete(v);
  }
}

// 把目标倍速同步给主世界拦截器；enabled=false 时它完全不干预页面
function syncMainWorld() {
  try {
    document.dispatchEvent(
      new CustomEvent("__vsc_set_rate__", {
        detail: { rate: currentRate, enabled: !blocked },
      })
    );
  } catch {}
}

// 当前视频速度是否已是我们想要的状态
function rateMatches(v, rate) {
  return (
    Math.abs(v.playbackRate - rate) < 1e-6 &&
    Math.abs(v.defaultPlaybackRate - rate) < 1e-6
  );
}

// 绑定视频：设置速度并恢复外部改动
function bindVideo(v) {
  if (!boundVideos.has(v)) {
    boundVideos.add(v);

    // 站点脚本 / 自动连播 / 长按加速改动速度时纠正回来。
    // 若视频正在播放，直接拉起逐帧守护，让站点的重置只生效一帧。
    v.addEventListener("ratechange", () => {
      if (blocked) return;
      if (Math.abs(v.playbackRate - currentRate) < 1e-6) return;
      if (!canWrite(v)) return;
      setRate(v, currentRate);
      if (!v.paused && !v.ended) startKeeper();
    });

    // 换源重新加载与起播阶段补一次，覆盖 ratechange 被限流的窗口
    [
      "play",
      "playing",
      "loadeddata",
      "loadedmetadata",
      "canplay",
      "emptied",
      "loadstart",
      "seeking",
    ].forEach((evt) => {
      v.addEventListener(evt, () => {
        if (blocked) return;
        if (!rateMatches(v, currentRate) && canWrite(v)) {
          setRate(v, currentRate);
        }
        // 播放/起播后拉起守护，靠它压制站点持续重置
        if (!v.paused && !v.ended) startKeeper();
      });
    });

    // 开启自动网页全屏时，视频开始播放即进入
    v.addEventListener("play", () => maybeAutoFullscreen(v));
  }

  if (!boundList.includes(v)) boundList.push(v);
}

// 将速度应用到所有视频（用户主动操作，不经过限流）
function applySpeed(rate) {
  currentRate = rate;
  syncMainWorld();
  const videos = collectVideos(document);
  for (const v of videos) {
    bindVideo(v);
    setRate(v, rate);
  }
  // 用户改速后立即拉起守护，压制站点随后可能的重置
  if (videos.some((v) => !v.paused && !v.ended)) startKeeper();
  return videos.length;
}

// 绑定列表中尚未绑定的视频
function bindNewVideos(videos) {
  for (const v of videos) {
    if (boundVideos.has(v)) continue;
    bindVideo(v);
    if (!blocked) setRate(v, currentRate);
  }
}

// ===== 倍速守护 =====
// 关键认知：抖音这类站点在播放/切集时会以远高于「事件 + 定时校对」的频率
// 把 playbackRate 写回 1。只要我们的纠正频率低于站点的重置频率，
// 视频就始终跑在站点的倍速上 —— 这正是「加了校对还是时不时失效」的原因。
// （站点 100ms 重置一次、我们 500ms 校对一次 → 5/6 的时间是 1x。）
//
// 因此播放期间改用 rAF 逐帧守护（≈60Hz），一旦发现被改就立刻写回，
// 站点的重置最多只生效一帧（<17ms），肉眼不可见。
// rAF 只在「有视频正在播放」时运行，暂停/离开后自动停止，不常驻空转。

// 守护写入的每秒上限：既压住真正的 ping-pong，又远高于站点的重置频率
const KEEP_LIMIT = 30;

function canWriteWithin(v, limit) {
  const now = Date.now();
  let log = writeLogs.get(v);
  if (!log) {
    log = [];
    writeLogs.set(v, log);
  }
  while (log.length && now - log[0] > WRITE_WINDOW) log.shift();
  if (log.length >= limit) return false;
  log.push(now);
  return true;
}

// 强制写回目标倍速（守护路径，限额放宽到 KEEP_LIMIT）
function forceRate(v) {
  if (!canWriteWithin(v, KEEP_LIMIT)) return false;
  setRate(v, currentRate);
  return true;
}

let keeperRunning = false;

function keepTick() {
  if (blocked) {
    keeperRunning = false;
    return;
  }
  let anyPlaying = false;
  for (let i = boundList.length - 1; i >= 0; i--) {
    const v = boundList[i];
    if (!v.isConnected) continue;
    if (v.paused || v.ended) continue;
    anyPlaying = true;
    if (rateMatches(v, currentRate)) continue;
    forceRate(v);
  }
  if (anyPlaying) {
    requestAnimationFrame(keepTick);
  } else {
    keeperRunning = false;
  }
}

// 启动守护：有视频在播时才跑
function startKeeper() {
  if (blocked || keeperRunning) return;
  keeperRunning = true;
  requestAnimationFrame(keepTick);
}

// 文档级捕获监听：抖音等站点会不断新建 <video> 元素，
// 靠 MutationObserver（100ms 防抖）或全量扫描（2.5s）绑定都存在延迟窗口，
// 这期间新视频就是原速播放。用捕获阶段监听媒体事件可以即时绑定并立刻拉起守护。
["play", "playing", "ratechange", "loadedmetadata"].forEach((evt) => {
  document.addEventListener(
    evt,
    (e) => {
      const v = e.target;
      if (!(v instanceof HTMLMediaElement)) return;
      if (blocked) return;
      if (!boundVideos.has(v)) {
        bindVideo(v);
        setRate(v, currentRate);
      }
      if (!v.paused && !v.ended) {
        if (!rateMatches(v, currentRate) && canWrite(v)) {
          setRate(v, currentRate);
        }
        startKeeper();
      }
    },
    true
  );
});

// 低频兜底扫描：清理断开节点，并给「没抛 play 事件」的视频也接上守护
const SWEEP_INTERVAL = 2000;
setInterval(() => {
  if (blocked) return;
  let anyPlaying = false;
  for (let i = boundList.length - 1; i >= 0; i--) {
    const v = boundList[i];
    if (!v.isConnected) {
      boundList.splice(i, 1);
      continue;
    }
    if (!v.paused && !v.ended) anyPlaying = true;
    if (rateMatches(v, currentRate)) continue;
    if (!canWriteWithin(v, WRITE_LIMIT)) continue;
    setRate(v, currentRate);
  }
  if (anyPlaying) startKeeper();
}, SWEEP_INTERVAL);

// 收集单个新增节点（含自身）里的视频
function collectFrom(el) {
  const videos = [];
  if (el.tagName === "VIDEO") videos.push(el);
  if (el.shadowRoot) {
    observeRoot(el.shadowRoot);
    videos.push(...collectVideos(el.shadowRoot));
  }
  videos.push(...collectVideos(el));
  return videos;
}

// 延迟扫描：优先增量（只扫本次新增节点），低频全量兜底（捕获晚挂载的 shadow root）
const FULL_SCAN_INTERVAL = 2500;
let scanTimer = null;
let pendingAdded = [];
let lastFullScan = 0;
// 扫描阶段缓存的视频列表，供按钮定位复用，避免高频全页遍历
let knownVideos = [];

function scheduleScan(mutations) {
  if (mutations) {
    for (const m of mutations) {
      for (const n of m.addedNodes) {
        if (n.nodeType === 1) pendingAdded.push(n);
      }
    }
  }
  if (scanTimer) return;
  scanTimer = setTimeout(() => {
    scanTimer = null;
    const now = Date.now();
    if (now - lastFullScan >= FULL_SCAN_INTERVAL) {
      lastFullScan = now;
      if (fsVideo && !fsVideo.isConnected) exitWebFullscreen();
      // 保留待处理的增量节点：全量分支只做补充，不能把本轮新节点丢掉，
      // 否则这些视频要等下一次 DOM 变动或 2.5s 后的全量扫描才有倍速
      const added = pendingAdded;
      pendingAdded = [];
      const videos = collectVideos(document);
      knownVideos = videos;
      bindNewVideos(videos);
      for (const el of added) {
        const extra = collectFrom(el);
        knownVideos.push(...extra);
        bindNewVideos(extra);
      }
      updateTrackBtn();
      return;
    }
    const added = pendingAdded;
    pendingAdded = [];
    // 顺带清理已断开的旧节点，避免列表无限增长
    if (knownVideos.length > 64) {
      knownVideos = knownVideos.filter((v) => v.isConnected);
    }
    for (const el of added) {
      const videos = collectFrom(el);
      for (const v of videos) {
        if (!knownVideos.includes(v)) knownVideos.push(v);
      }
      bindNewVideos(videos);
    }
    updateTrackBtn();
  }, 100);
}

// ===== 网页全屏：视频铺满浏览器窗口，隐藏页面其他所有内容 =====
let fsVideo = null;
let fsOverlay = null;
let fsSavedStyle = null;
let fsSavedParent = null;
let fsSavedNext = null;
let fsSavedControls = null;
let fsUIHandlers = null;
let fsWheelHandler = null;

// 选择目标视频：优先正在播放的
function pickVideo() {
  const videos = collectVideos(document);
  return videos.find((v) => !v.paused && !v.ended) || videos[0] || null;
}

// 注入一次全局样式（按钮 + 全屏遮罩，全部 !important 防止被页面 CSS 覆盖）
const FS_STYLE_ID = "__vsc_fs_style__";
const PLAY_BTN_CLASS = "__vsc_webfs_btn__";
const OVERLAY_ID = "__vsc_fs_overlay__";

function injectFsStyle() {
  if (document.getElementById(FS_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = FS_STYLE_ID;
  style.textContent = `
    /* 「网页全屏」按钮：固定定位，由脚本按视频位置实时设置 left/top */
    .${PLAY_BTN_CLASS} {
      position: fixed !important;
      z-index: 2147483600 !important;
      width: 34px !important;
      height: 34px !important;
      align-items: center !important;
      justify-content: center !important;
      margin: 0 !important;
      padding: 0 !important;
      background: rgba(0,0,0,.55) !important;
      color: #fff !important;
      border: none !important;
      border-radius: 8px !important;
      font-size: 16px !important;
      line-height: 1 !important;
      cursor: pointer !important;
      user-select: none !important;
      opacity: .7 !important;
      transition: opacity .15s, background .15s !important;
      box-sizing: border-box !important;
      pointer-events: auto !important;
    }
    .${PLAY_BTN_CLASS} svg { display: block !important; pointer-events: none !important; }
    .${PLAY_BTN_CLASS}:hover { opacity: 1 !important; background: rgba(0,0,0,.85) !important; }

    /* 网页全屏遮罩：铺满视口、盖住页面所有内容 */
    #${OVERLAY_ID} {
      position: fixed !important;
      inset: 0 !important;
      margin: 0 !important;
      padding: 0 !important;
      background: #000 !important;
      z-index: 2147483647 !important;
      overflow: hidden !important;
      display: block !important;
    }
    #${OVERLAY_ID} video {
      width: 100% !important;
      height: 100% !important;
      max-width: none !important;
      max-height: none !important;
      margin: 0 !important;
      padding: 0 !important;
      background: #000 !important;
      object-fit: contain !important;
      position: static !important;
    }
    /* 自建控制条：不依赖原生控件，避免被站点（如 YouTube）拦截 */
    #__vsc_fs_ui__ {
      position: absolute !important;
      left: 0 !important;
      right: 0 !important;
      bottom: 0 !important;
      z-index: 2147483647 !important;
      display: flex !important;
      align-items: center !important;
      gap: 10px !important;
      padding: 10px 16px 12px !important;
      box-sizing: border-box !important;
      background: linear-gradient(transparent, rgba(0,0,0,.8)) !important;
      font: 13px/1.2 -apple-system,"PingFang SC",sans-serif !important;
      color: #fff !important;
      user-select: none !important;
    }
    #__vsc_fs_ui__ .vsc-btn {
      flex-shrink: 0 !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      height: 28px !important;
      min-width: 28px !important;
      padding: 0 8px !important;
      box-sizing: border-box !important;
      background: rgba(255,255,255,.14) !important;
      color: #fff !important;
      border-radius: 6px !important;
      font-size: 13px !important;
      cursor: pointer !important;
    }
    #__vsc_fs_ui__ .vsc-btn:hover { background: rgba(255,255,255,.3) !important; }
    #__vsc_fs_ui__ .vsc-time {
      flex-shrink: 0 !important;
      font-variant-numeric: tabular-nums !important;
      opacity: .9 !important;
    }
    #__vsc_fs_ui__ .vsc-track {
      position: relative !important;
      flex: 1 1 auto !important;
      height: 20px !important;
      cursor: pointer !important;
      display: flex !important;
      align-items: center !important;
    }
    #__vsc_fs_ui__ .vsc-track::before {
      content: "" !important;
      position: absolute !important;
      left: 0 !important;
      right: 0 !important;
      height: 5px !important;
      border-radius: 3px !important;
      background: rgba(255,255,255,.25) !important;
    }
    #__vsc_fs_ui__ .vsc-buf,
    #__vsc_fs_ui__ .vsc-prog {
      position: absolute !important;
      left: 0 !important;
      height: 5px !important;
      border-radius: 3px !important;
      pointer-events: none !important;
    }
    #__vsc_fs_ui__ .vsc-buf { background: rgba(255,255,255,.4) !important; }
    #__vsc_fs_ui__ .vsc-prog { background: #5b7cff !important; }
    #__vsc_fs_ui__ .vsc-knob {
      position: absolute !important;
      width: 12px !important;
      height: 12px !important;
      margin-left: -6px !important;
      border-radius: 50% !important;
      background: #fff !important;
      pointer-events: none !important;
      opacity: 0 !important;
      transition: opacity .15s !important;
    }
    #__vsc_fs_ui__ .vsc-track:hover .vsc-knob { opacity: 1 !important; }
  `;
  (document.head || document.documentElement).appendChild(style);
}

// 把视频挪进全屏遮罩，隐藏页面其余内容
function enterWebFullscreen(v) {
  injectFsStyle();

  fsVideo = v;
  fsSavedStyle = v.getAttribute("style");
  fsSavedParent = v.parentNode;
  fsSavedNext = v.nextSibling;
  // 关闭原生控制条，改用自建控制条（原生控件会被站点 JS 拦截而无法使用）
  fsSavedControls = v.controls;
  v.controls = false;

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.appendChild(v);
  // 挂在 <html> 上，避免 body 上的 transform/overflow 影响 fixed 定位
  document.documentElement.appendChild(overlay);
  fsOverlay = overlay;

  // 拦截滚轮，避免穿透到页面导致背景滚动（退出时解绑，不改变原滚动位置）
  fsWheelHandler = (e) => e.preventDefault();
  overlay.addEventListener("wheel", fsWheelHandler, { passive: false });

  overlay.appendChild(buildFsUI(v));

  // 节点被挪动后站点常会重建播放器并重置速度，这里主动补一次
  if (!blocked) setRate(v, currentRate);

  updateTrackBtn();
}

// 时间格式化：mm:ss / h:mm:ss
function fmtTime(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const mm = String(m).padStart(h ? 2 : 0, "0");
  return (h ? h + ":" : "") + mm + ":" + String(s).padStart(2, "0");
}

// 自建控制条：播放/暂停、当前时间、可拖动进度条、总时长、退出
function buildFsUI(v) {
  const bar = document.createElement("div");
  bar.id = "__vsc_fs_ui__";

  const play = document.createElement("div");
  play.className = "vsc-btn vsc-play";

  const cur = document.createElement("div");
  cur.className = "vsc-time";

  const track = document.createElement("div");
  track.className = "vsc-track";
  const buf = document.createElement("div");
  buf.className = "vsc-buf";
  const prog = document.createElement("div");
  prog.className = "vsc-prog";
  const knob = document.createElement("div");
  knob.className = "vsc-knob";
  track.append(buf, prog, knob);

  const dur = document.createElement("div");
  dur.className = "vsc-time";

  const exit = document.createElement("div");
  exit.className = "vsc-btn vsc-exit";
  exit.textContent = "退出全屏";

  bar.append(play, cur, track, dur, exit);

  const ratio = () =>
    isFinite(v.duration) && v.duration > 0 ? v.currentTime / v.duration : 0;

  const syncPlay = () => {
    play.textContent = v.paused ? "▶" : "❚❚";
  };

  const syncProgress = () => {
    const r = ratio();
    const pct = (r * 100).toFixed(3) + "%";
    prog.style.width = pct;
    knob.style.left = pct;
    cur.textContent = fmtTime(v.currentTime);
    dur.textContent = fmtTime(v.duration);
    if (v.buffered.length) {
      const end = v.buffered.end(v.buffered.length - 1);
      buf.style.width =
        (isFinite(v.duration) && v.duration > 0
          ? ((end / v.duration) * 100).toFixed(3)
          : 0) + "%";
    }
  };

  // 点击/拖动进度条跳转
  let dragging = false;
  const seekTo = (clientX) => {
    const rect = track.getBoundingClientRect();
    if (!rect.width || !isFinite(v.duration) || v.duration <= 0) return;
    const r = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    v.currentTime = r * v.duration;
    syncProgress();
  };

  track.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    e.preventDefault();
    dragging = true;
    track.setPointerCapture(e.pointerId);
    seekTo(e.clientX);
  });
  track.addEventListener("pointermove", (e) => {
    if (dragging) seekTo(e.clientX);
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    if (track.hasPointerCapture?.(e.pointerId)) {
      track.releasePointerCapture(e.pointerId);
    }
  };
  track.addEventListener("pointerup", endDrag);
  track.addEventListener("pointercancel", endDrag);

  play.addEventListener("click", (e) => {
    e.stopPropagation();
    if (v.paused) v.play();
    else v.pause();
  });
  exit.addEventListener("click", (e) => {
    e.stopPropagation();
    exitWebFullscreen();
  });

  ["play", "pause", "loadedmetadata", "durationchange", "seeked"].forEach((t) =>
    v.addEventListener(t, syncProgress)
  );
  ["play", "pause"].forEach((t) => v.addEventListener(t, syncPlay));
  v.addEventListener("timeupdate", syncProgress);
  v.addEventListener("progress", syncProgress);

  // 记录监听器，退出时解绑
  fsUIHandlers = { v, syncPlay, syncProgress };

  syncPlay();
  syncProgress();
  return bar;
}

// 还原视频到原位置，移除遮罩
function exitWebFullscreen() {
  if (!fsVideo) return;
  const v = fsVideo;
  fsVideo = null;

  if (fsUIHandlers) {
    const { v: sv, syncPlay, syncProgress } = fsUIHandlers;
    sv.removeEventListener("timeupdate", syncProgress);
    sv.removeEventListener("progress", syncProgress);
    ["play", "pause", "loadedmetadata", "durationchange", "seeked"].forEach(
      (t) => sv.removeEventListener(t, syncProgress)
    );
    ["play", "pause"].forEach((t) => sv.removeEventListener(t, syncPlay));
    fsUIHandlers = null;
  }

  try {
    if (v.isConnected) {
      v.removeAttribute("style");
      if (fsSavedStyle) v.setAttribute("style", fsSavedStyle);
      if (fsSavedControls !== null) v.controls = fsSavedControls;

      if (fsSavedParent && fsSavedParent.isConnected) {
        // 原后继节点可能已被站点移除，只有仍属于原父节点时才可作锚点，
        // 否则回退为空（等价 appendChild），避免 insertBefore 抛 NotFoundError
        const anchor =
          fsSavedNext && fsSavedNext.parentNode === fsSavedParent
            ? fsSavedNext
            : null;
        fsSavedParent.insertBefore(v, anchor);
      } else {
        // 原父节点已断开：先把视频移出遮罩，避免它随遮罩一起被移除
        (document.body || document.documentElement).appendChild(v);
      }
    }
  } finally {
    // 无论恢复视频是否出错，都保证遮罩与状态被清理
    if (fsOverlay) {
      if (fsWheelHandler) {
        fsOverlay.removeEventListener("wheel", fsWheelHandler);
        fsWheelHandler = null;
      }
      fsOverlay.remove();
      fsOverlay = null;
    }
    fsSavedStyle = null;
    fsSavedParent = null;
    fsSavedNext = null;
    fsSavedControls = null;
    // 还原到原位置后站点可能再次重置速度，补一次
    if (!blocked && v.isConnected) setRate(v, currentRate);
    updateTrackBtn();
  }
}

// 返回 true=已进入，false=已退出，null=没有可用视频
function toggleWebFullscreen() {
  if (fsVideo) {
    exitWebFullscreen();
    return false;
  }
  // 优先使用悬浮按钮当前定位到的视频，保证与用户看到的那个一致
  const v =
    trackedVideo && trackedVideo.isConnected ? trackedVideo : pickVideo();
  if (!v) return null;
  enterWebFullscreen(v);
  return true;
}

// ===== 「网页全屏」按钮：固定定位、实时跟随视频右下角 =====
// 不塞进播放器内部，避免被 YouTube 等站点的 Shadow DOM / overflow / 覆盖层裁掉
let trackBtn = null;
let trackedVideo = null;

// 挑选当前最值得操作的视频：可见、面积大、正在播放的优先
function pickTrackedVideo() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let best = null;
  let bestScore = -1;
  for (const v of knownVideos) {
    if (!v.isConnected) continue;
    const r = v.getBoundingClientRect();
    const w = Math.min(r.right, vw) - Math.max(r.left, 0);
    const h = Math.min(r.bottom, vh) - Math.max(r.top, 0);
    if (w < 160 || h < 90) continue;
    let score = w * h;
    if (!v.paused && !v.ended) score *= 4;
    if (score > bestScore) {
      bestScore = score;
      best = v;
    }
  }
  return best;
}

function ensureTrackBtn() {
  if (trackBtn && trackBtn.isConnected) return;
  injectFsStyle();
  const btn = document.createElement("div");
  btn.className = PLAY_BTN_CLASS;
  btn.style.display = "none";
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">' +
    '<path d="M4 4h6v2H6v4H4V4zm10 0h6v6h-2V6h-4V4zM4 14h2v4h4v2H4v-6zm14 0h2v6h-6v-2h4v-4z"/></svg>';
  btn.title = "网页全屏";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (fsVideo) {
      exitWebFullscreen();
    } else if (trackedVideo) {
      enterWebFullscreen(trackedVideo);
    }
  });
  document.documentElement.appendChild(btn);
  trackBtn = btn;
}

// 让按钮跟随视频右下角（位于控制栏上方，避免遮挡原生按钮）
function updateTrackBtn() {
  if (!isTop) return;
  ensureTrackBtn();

  if (fsVideo || !trackBtn) {
    trackBtn.style.display = "none";
    return;
  }

  const v = pickTrackedVideo();
  trackedVideo = v;
  if (!v) {
    trackBtn.style.display = "none";
    return;
  }

  const r = v.getBoundingClientRect();
  trackBtn.style.display = "flex";
  trackBtn.style.left = r.left + r.width - 44 + "px";
  trackBtn.style.top = r.bottom - 86 + "px";
}

// 滚动/缩放/定时刷新按钮位置
window.addEventListener("scroll", updateTrackBtn, true);
window.addEventListener("resize", updateTrackBtn);
setInterval(updateTrackBtn, 300);

// Esc 退出网页全屏（capture 阶段优先于网站自身的按键处理）
document.addEventListener(
  "keydown",
  (e) => {
    if (e.key === "Escape" && fsVideo) {
      e.preventDefault();
      e.stopImmediatePropagation();
      exitWebFullscreen();
    }
  },
  true
);

// 请求序号：丢弃过期的 storage 读取结果
let refreshSeq = 0;

// 重算排除状态，必要时切换速度；状态确定后调用 callback
function refreshBlocked(callback) {
  const seq = ++refreshSeq;
  chrome.storage.local.get(
    { rate: 1.0, blocklist: DEFAULT_BLOCKLIST },
    ({ rate, blocklist }) => {
      if (seq !== refreshSeq) return;
      setBlocklist(migrateBlocklist(blocklist));
      const nowBlocked = isBlockedUrl(location.href);
      if (nowBlocked !== blocked) {
        blocked = nowBlocked;
        applySpeed(nowBlocked ? 1.0 : rate);
      } else if (!blocked && Math.abs(currentRate - rate) > 1e-6) {
        // URL 未变但倍速被改过（其他标签页/排除规则刷新），顺带同步
        applySpeed(rate);
      }
      if (callback) callback();
    }
  );
}

// 监听路由变化，重算排除状态
window.addEventListener("popstate", () => refreshBlocked());
window.addEventListener("hashchange", () => refreshBlocked());
if (typeof navigation !== "undefined") {
  navigation.addEventListener("currententrychange", () => refreshBlocked());
}

// 兜底轮询：捕获无事件的 SPA 跳转
let lastHref = location.href;
setInterval(() => {
  if (location.href !== lastHref) {
    lastHref = location.href;
    refreshBlocked();
  }
}, 1500);

// 是否顶层 frame（仅顶层负责应答消息）
const isTop = (() => {
  try {
    return window.top === window;
  } catch {
    return true;
  }
})();

// 接收弹窗消息
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "setSpeed") {
    if (blocked) {
      if (isTop) sendResponse({ count: 0, blocked: true });
    } else {
      const count = applySpeed(msg.rate);
      if (isTop) sendResponse({ count, blocked: false });
    }
  } else if (msg.type === "getSpeed") {
    if (isTop) {
      sendResponse({
        rate: currentRate,
        count: collectVideos(document).length,
        blocked,
        webFullscreen: !!fsVideo,
      });
    }
  } else if (msg.type === "toggleWebFullscreen") {
    if (isTop) {
      const result = toggleWebFullscreen();
      sendResponse(
        result === null
          ? { found: false }
          : { found: true, webFullscreen: result }
      );
    }
  } else if (msg.type === "checkBlock") {
    refreshBlocked(isTop ? () => sendResponse({ blocked }) : null);
    return isTop; // 顶层需保持消息通道等待异步回复
  }
  return false;
});

// 自动网页全屏：已触发过的视频不再重复进入
const autoDone = new WeakSet();

function maybeAutoFullscreen(v) {
  if (!isTop || !autoFullscreen || blocked || fsVideo) return;
  if (autoDone.has(v)) return;

  const fits = () => {
    const r = v.getBoundingClientRect();
    return r.width >= 400 && r.height >= 200;
  };

  if (fits()) {
    autoDone.add(v);
    enterWebFullscreen(v);
    return;
  }
  // 尺寸暂不满足（可能尚未完成布局），稍后重新检查一次，仍不满足则放弃
  setTimeout(() => {
    if (!isTop || !autoFullscreen || blocked || fsVideo) return;
    if (autoDone.has(v) || !v.isConnected) return;
    if (!fits()) return;
    autoDone.add(v);
    enterWebFullscreen(v);
  }, 300);
}

// 开关/倍速变化时立即生效，无需刷新页面
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.autoWebFullscreen) {
    autoFullscreen = !!changes.autoWebFullscreen.newValue;
  }
  // 其他标签页改变倍速时同步；被排除页面忽略
  if (changes.rate && !blocked) {
    applySpeed(changes.rate.newValue);
  }
});

// 初始化：应用已保存的速度并判断排除状态
(function init() {
  observeRoot(document.documentElement);
  chrome.storage.local.get(
    { rate: 1.0, blocklist: DEFAULT_BLOCKLIST, autoWebFullscreen: false },
    ({ rate, blocklist, autoWebFullscreen: autoFs }) => {
      const rules = migrateBlocklist(blocklist);
      setBlocklist(rules);
      autoFullscreen = !!autoFs;
      blocked = isBlockedUrl(location.href);
      // 先告诉主世界当前倍速与是否启用，再应用到视频
      syncMainWorld();
      if (blocked) {
        collectVideos(document).forEach(bindVideo);
      } else {
        applySpeed(rate);
      }
      knownVideos = collectVideos(document);
      updateTrackBtn();
    }
  );
})();