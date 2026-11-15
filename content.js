// content.js —— 注入网页，控制视频播放速度
let currentRate = 1.0;
let blocked = false;
let autoFullscreen = false;
// 用户是否明确选过倍速。1x 默认不干预页面；明确选过 1x 才强制 1x。
let rateExplicit = false;
// init 的 storage 读取完成前，不放行 onChanged，避免 blocked 还没算出来就先应用倍速
let initialized = false;
// 自动全屏去重：按视频源记录，换源后允许再次触发（WeakMap 不阻止 GC）
const autoDoneSrc = new WeakMap();

// 默认排除表与迁移逻辑见 shared.js（与 popup 共用，避免两处漂移）

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
  // 用 host（含端口）而不是 hostname：`//localhost:3000` 这类规则才能命中
  const host = u.host.toLowerCase();
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

// 外部持续改速时的写入限流：滑动窗口限速，不设「放弃期」。
// 只防真正的 ping-pong 死循环：1 秒内写超过 WRITE_LIMIT 次就跳过本次，
// 后续事件或守护循环会继续尝试，不会出现长时间静默。
const WRITE_WINDOW = 1000;
const WRITE_LIMIT = 25;

// 已绑定的视频：WeakSet 用于去重，boundList 供高频守护/按钮定位遍历
const boundVideos = new WeakSet();
const boundList = [];

// 每个视频的写入时间戳，用于限流
const writeLogs = new WeakMap();

// 限流：同一视频在 WRITE_WINDOW 内最多写 limit 次；超出则跳过本次
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

// 事件纠正路径的限流（守护路径用更宽的 KEEP_LIMIT）
function canWrite(v) {
  return canWriteWithin(v, WRITE_LIMIT);
}

// 同时写 defaultPlaybackRate：媒体重新加载（换 src / load()）时浏览器会把
// playbackRate 重置成 defaultPlaybackRate，只写 playbackRate 会被打回 1x。
// 注意：隔离世界有自己的 DOM 原型链，本扩展的写入走原生 setter，
// 不会经过主世界被改写的 setter，因此不需要任何「透传」标记。
function setRate(v, rate) {
  const next = normalizeRate(rate, 1);
  try {
    if (Math.abs(v.defaultPlaybackRate - next) > 1e-6) {
      v.defaultPlaybackRate = next;
    }
    if (Math.abs(v.playbackRate - next) > 1e-6) v.playbackRate = next;
  } catch {
    // 视频已进入不可写状态（如被移除），忽略
  }
}

// 是否应该主动干预页面：
// - 被排除的页面完全不干预；
// - 1x 在用户没有明确选过倍速时保持「不干预」，避免装完扩展就把站点自己的
//   1.5x/2x 压回 1x；在弹窗里明确选择 1x 后 rateExplicit=true，才会强制 1x。
function shouldEnforce() {
  return !blocked && (rateExplicit || Math.abs(currentRate - 1) > 1e-6);
}

// 把目标倍速同步给主世界拦截器；enabled=false 时它完全不干预页面
function syncMainWorld() {
  try {
    document.dispatchEvent(
      new CustomEvent("__vsc_set_rate__", {
        detail: { rate: currentRate, enabled: shouldEnforce() },
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
      if (!shouldEnforce()) return;
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
        if (!shouldEnforce()) return;
        keeperFails.delete(v);
        if (!rateMatches(v, currentRate) && canWrite(v)) {
          setRate(v, currentRate);
        }
        // 播放/起播后拉起守护，靠它压制站点持续重置
        if (!v.paused && !v.ended) startKeeper();
      });
    });

    // 复用同一个 <video> 换源时，清除“已自动全屏过”的标记，让下一个视频能再次触发
    ["emptied", "loadstart"].forEach((evt) => {
      v.addEventListener(evt, () => autoDoneSrc.delete(v));
    });

    // 开启自动网页全屏时，视频开始播放即进入
    v.addEventListener("play", () => maybeAutoFullscreen(v));
  }

  if (!boundList.includes(v)) boundList.push(v);

  // 主世界拦截器只处理带这个属性的 <video>（不影响 <audio> 等媒体元素）。
  // DOM 属性跨世界可见，这是隔离世界与主世界之间最稳的标记方式；
  // 每次 bind 都检查一次，防止站点重渲染时把属性清掉。
  if (!v.hasAttribute("data-vsc-managed")) {
    try {
      v.setAttribute("data-vsc-managed", "1");
    } catch {}
  }

  // 绑定前就已经在播放的视频不会再有 play 事件，这里补一次自动全屏判断
  if (!v.paused && !v.ended) maybeAutoFullscreen(v);
}

// 改速时遍历的视频：首次（boundList 为空）用全量扫描发现 Shadow DOM；
// 之后复用已绑定列表 + light DOM 查询，避免每次改速都 querySelectorAll("*")。
function videosForApply() {
  const connected = boundList.filter((v) => v.isConnected);
  if (!connected.length) return collectVideos(document);
  const set = new Set(connected);
  for (const v of document.querySelectorAll("video")) set.add(v);
  return Array.from(set);
}

// 将速度应用到所有视频。
// restore=true 用于被排除的页面：只负责把之前改过的速度还原成 1x，不启用守护。
function applySpeed(rate, restore = false) {
  currentRate = normalizeRate(rate, 1);
  const write = restore || shouldEnforce();
  syncMainWorld();
  const videos = videosForApply();
  for (const v of videos) {
    bindVideo(v);
    if (write) {
      keeperFails.delete(v);
      setRate(v, currentRate);
    }
  }
  // 用户改速后立即拉起守护，压制站点随后可能的重置
  if (write && videos.some((v) => !v.paused && !v.ended)) startKeeper();
  return videos.length;
}

// 绑定列表中尚未绑定的视频
function bindNewVideos(videos) {
  for (const v of videos) {
    if (boundVideos.has(v)) continue;
    bindVideo(v);
    if (shouldEnforce()) setRate(v, currentRate);
  }
}

// ===== 倍速守护 =====
// 兜底链路（主世界拦截已能从源头吞掉站点写入，这里是第二道保险）：
// 抖音这类站点会在播放/切集时把 playbackRate 写回 1，若只靠事件 + 定时校对，
// 纠正频率一旦低于重置频率，视频就始终跑在站点的倍速上。
//
// 因此播放期间用 rAF 逐帧守护（≈60Hz），一旦发现被改就立刻写回，
// 站点的重置最多只生效一帧（<17ms），肉眼不可见。
// rAF 只在「有视频正在播放」时运行，暂停/离开后自动停止，不常驻空转。

// 守护写入的每秒上限：既压住真正的 ping-pong，又远高于站点的重置频率
const KEEP_LIMIT = 30;

// 连续写不进去时的退避：约 1 秒仍未达到目标就冷却 3 秒再试，
// 避免浏览器钳制/异常站点让 rAF 永久以 60Hz 空转。
const KEEP_FAIL_LIMIT = 60;
const KEEP_COOLDOWN = 3000;
const keeperFails = new WeakMap();

// 强制写回目标倍速（守护路径，限额放宽到 KEEP_LIMIT）
function forceRate(v) {
  if (!canWriteWithin(v, KEEP_LIMIT)) return false;
  setRate(v, currentRate);
  return true;
}

let keeperRunning = false;

function keepTick() {
  if (!shouldEnforce()) {
    keeperRunning = false;
    return;
  }
  let anyPlaying = false;
  for (let i = boundList.length - 1; i >= 0; i--) {
    const v = boundList[i];
    if (!v.isConnected) continue;
    if (v.paused || v.ended) continue;
    anyPlaying = true;
    if (rateMatches(v, currentRate)) {
      keeperFails.delete(v);
      continue;
    }

    const now = Date.now();
    const st = keeperFails.get(v);
    if (st && st.until > now) continue; // 冷却中
    if (st && st.until && st.until <= now) keeperFails.delete(v);

    if (!forceRate(v)) continue;
    if (rateMatches(v, currentRate)) {
      keeperFails.delete(v);
      continue;
    }
    const n = (st && st.until === 0 ? st.n : 0) + 1;
    keeperFails.set(v, {
      n,
      until: n >= KEEP_FAIL_LIMIT ? now + KEEP_COOLDOWN : 0,
    });
  }
  if (anyPlaying) {
    requestAnimationFrame(keepTick);
  } else {
    keeperRunning = false;
  }
}

// 启动守护：有视频在播时才跑
function startKeeper() {
  if (!shouldEnforce() || keeperRunning) return;
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
      // 1x 不干预 / 排除页也保持绑定，但只有需要强制时才写速
      if (!boundVideos.has(v)) bindVideo(v);
      if (!shouldEnforce()) return;
      // 自己的写速也会触发 ratechange，不能让它清掉退避计数
      if (evt !== "ratechange") keeperFails.delete(v);
      if (!rateMatches(v, currentRate) && canWrite(v)) {
        setRate(v, currentRate);
      }
      if (!v.paused && !v.ended) startKeeper();
    },
    true
  );
});

// 低频兜底扫描：清理断开节点，并给「没抛 play 事件」的视频也接上守护
const SWEEP_INTERVAL = 2000;
setInterval(() => {
  let anyPlaying = false;
  for (let i = boundList.length - 1; i >= 0; i--) {
    const v = boundList[i];
    if (!v.isConnected) {
      boundList.splice(i, 1);
      continue;
    }
    if (!v.paused && !v.ended) anyPlaying = true;
    if (!shouldEnforce()) continue;
    if (rateMatches(v, currentRate)) continue;
    if (!canWriteWithin(v, WRITE_LIMIT)) continue;
    setRate(v, currentRate);
  }
  if (anyPlaying && shouldEnforce()) startKeeper();
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
const FULL_SCAN_INTERVAL = 5000;
let scanTimer = null;
let pendingAdded = [];
let lastFullScan = 0;

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
      // 后台标签页不做全页遍历；保留 pendingAdded，等可见后再处理
      if (document.hidden) return;
      if (fsVideo && !fsVideo.isConnected) exitWebFullscreen();
      // 全量扫描覆盖整棵文档树（含已发现的 shadow root），
      // 新节点也已包含在内，无需再单独处理 pendingAdded
      pendingAdded.length = 0;
      bindNewVideos(collectVideos(document));
      return;
    }
    const added = pendingAdded;
    pendingAdded = [];
    for (const el of added) {
      bindNewVideos(collectFrom(el));
    }
  }, 100);
}

// 从后台切回前台时补一次扫描，处理隐藏期间积压的节点
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) scheduleScan();
});

// ===== 网页全屏：视频铺满浏览器窗口，隐藏页面其他所有内容 =====
let fsVideo = null;
let fsOverlay = null;
let fsSavedStyle = null;
let fsSavedParent = null;
let fsSavedNext = null;
let fsSavedControls = null;
let fsUIHandlers = null;
let fsWheelHandler = null;

// 选择目标视频：优先正在播放且实际有布局尺寸的
function hasBox(v) {
  const r = v.getBoundingClientRect();
  return r.width > 1 && r.height > 1;
}

function pickVideo() {
  let fallback = null;
  for (const v of boundList) {
    if (!v.isConnected || !hasBox(v)) continue;
    if (!v.paused && !v.ended) return v;
    if (!fallback) fallback = v;
  }
  if (fallback) return fallback;
  // 兜底：列表还空（页面刚打开、尚未扫描到视频）时做一次扫描并绑定
  const videos = collectVideos(document);
  videos.forEach(bindVideo);
  return (
    videos.find((v) => hasBox(v) && !v.paused && !v.ended) ||
    videos.find((v) => hasBox(v)) ||
    null
  );
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
  if (shouldEnforce()) setRate(v, currentRate);

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

  const mute = document.createElement("div");
  mute.className = "vsc-btn vsc-mute";
  mute.title = "静音 (m)";

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

  bar.append(play, mute, cur, track, dur, exit);

  const ratio = () =>
    isFinite(v.duration) && v.duration > 0 ? v.currentTime / v.duration : 0;

  const syncPlay = () => {
    play.textContent = v.paused ? "▶" : "❚❚";
  };

  const syncMute = () => {
    mute.textContent = v.muted || v.volume === 0 ? "🔇" : "🔊";
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
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  });
  mute.addEventListener("click", (e) => {
    e.stopPropagation();
    if (v.muted || v.volume === 0) {
      v.muted = false;
      if (v.volume === 0) v.volume = 0.5;
    } else {
      v.muted = true;
    }
    syncMute();
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
  v.addEventListener("volumechange", syncMute);

  // 记录监听器，退出时解绑
  fsUIHandlers = { v, syncPlay, syncProgress, syncMute };

  syncPlay();
  syncMute();
  syncProgress();
  return bar;
}

// 还原视频到原位置，移除遮罩
function exitWebFullscreen() {
  if (!fsVideo) return;
  const v = fsVideo;
  fsVideo = null;

  if (fsUIHandlers) {
    const { v: sv, syncPlay, syncProgress, syncMute } = fsUIHandlers;
    sv.removeEventListener("timeupdate", syncProgress);
    sv.removeEventListener("progress", syncProgress);
    ["play", "pause", "loadedmetadata", "durationchange", "seeked"].forEach(
      (t) => sv.removeEventListener(t, syncProgress)
    );
    ["play", "pause"].forEach((t) => sv.removeEventListener(t, syncPlay));
    sv.removeEventListener("volumechange", syncMute);
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
    if (shouldEnforce() && v.isConnected) setRate(v, currentRate);
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
    trackedVideo && trackedVideo.isConnected && hasBox(trackedVideo)
      ? trackedVideo
      : pickVideo();
  if (!v) return null;
  // pickVideo 内部的 bindVideo 可能已经触发自动全屏，避免重复进入
  if (fsVideo) return true;
  enterWebFullscreen(v);
  return true;
}

// ===== 「网页全屏」按钮：固定定位、实时跟随视频右下角 =====
// 不塞进播放器内部，避免被 YouTube 等站点的 Shadow DOM / overflow / 覆盖层裁掉
let trackBtn = null;
let trackedVideo = null;
let lastBtnLeft = null;
let lastBtnTop = null;
let lastBtnVisible = false;

// 挑选当前最值得操作的视频：可见、面积大、正在播放的优先
// 复用 boundList（所有绑定过的视频），避免每次定位都全页遍历
function pickTrackedVideo() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let best = null;
  let bestScore = -1;
  for (const v of boundList) {
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
    toggleWebFullscreen();
  });
  document.documentElement.appendChild(btn);
  trackBtn = btn;
  lastBtnVisible = false;
  lastBtnLeft = null;
  lastBtnTop = null;
}

// 只在可见状态/坐标真正变化时写 style，减少滚动时的 layout/style 抖动
function setTrackBtnVisible(visible) {
  if (!trackBtn || lastBtnVisible === visible) return;
  lastBtnVisible = visible;
  trackBtn.style.display = visible ? "flex" : "none";
}

// 让按钮跟随视频右下角（位于控制栏上方，避免遮挡原生按钮）
function updateTrackBtn() {
  if (!isTop) return;
  if (fsVideo) {
    setTrackBtnVisible(false);
    return;
  }

  const v = pickTrackedVideo();
  trackedVideo = v;
  if (!v) {
    setTrackBtnVisible(false);
    return;
  }

  ensureTrackBtn();
  if (!trackBtn) return;

  const r = v.getBoundingClientRect();
  const left = r.left + r.width - 44;
  const top = r.bottom - 86;
  if (left !== lastBtnLeft || top !== lastBtnTop) {
    lastBtnLeft = left;
    lastBtnTop = top;
    trackBtn.style.left = left + "px";
    trackBtn.style.top = top + "px";
  }
  setTrackBtnVisible(true);
}

// 滚动/缩放/定时刷新按钮位置：用 rAF 合并，避免每个 scroll 事件都重新测量
let trackRaf = 0;
function scheduleTrackBtn() {
  if (!isTop || trackRaf) return;
  trackRaf = requestAnimationFrame(() => {
    trackRaf = 0;
    updateTrackBtn();
  });
}

window.addEventListener("scroll", scheduleTrackBtn, true);
window.addEventListener("resize", scheduleTrackBtn);
setInterval(scheduleTrackBtn, 300);

// 网页全屏下的键盘快捷键（capture 阶段优先于网站自身的按键处理）
document.addEventListener(
  "keydown",
  (e) => {
    if (!fsVideo) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      exitWebFullscreen();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (
      t &&
      (t.tagName === "INPUT" ||
        t.tagName === "TEXTAREA" ||
        t.tagName === "SELECT" ||
        t.isContentEditable)
    ) {
      return;
    }

    const v = fsVideo;
    let handled = true;
    switch (e.key) {
      case " ":
      case "Spacebar":
      case "k":
      case "K":
        if (v.paused) v.play().catch(() => {});
        else v.pause();
        break;
      case "ArrowLeft":
        v.currentTime = Math.max(0, v.currentTime - 5);
        break;
      case "ArrowRight":
        v.currentTime = Math.min(
          isFinite(v.duration) && v.duration > 0 ? v.duration : Infinity,
          v.currentTime + 5
        );
        break;
      case "ArrowUp":
        v.volume = Math.min(1, Math.round((v.volume + 0.05) * 100) / 100);
        break;
      case "ArrowDown":
        v.volume = Math.max(0, Math.round((v.volume - 0.05) * 100) / 100);
        break;
      case "m":
      case "M":
        v.muted = !v.muted;
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  },
  true
);

// 请求序号：丢弃过期的 storage 读取结果
let refreshSeq = 0;

// 重算排除状态，必要时切换速度
function refreshBlocked() {
  // init 还没完成时直接忽略：init 自己会按当前 URL 计算 blocked 并应用
  if (!initialized) return;
  const seq = ++refreshSeq;
  chrome.storage.local.get(
    {
      rate: 1.0,
      blocklist: DEFAULT_BLOCKLIST,
      blocklistCustomized: false,
    },
    ({ rate, blocklist, blocklistCustomized: customized }) => {
      if (seq !== refreshSeq) return;
      setBlocklist(migrateBlocklist(blocklist, customized));
      const nowBlocked = isBlockedUrl(location.href);
      if (nowBlocked !== blocked) {
        blocked = nowBlocked;
        // 被排除时把之前改过的速度还原成 1x，但不再启用拦截
        applySpeed(nowBlocked ? 1.0 : rate, nowBlocked);
      } else if (!blocked && Math.abs(currentRate - rate) > 1e-6) {
        // URL 未变但倍速被改过（其他标签页/排除规则刷新），顺带同步
        applySpeed(rate);
      }
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
    // 从弹窗点选倍速属于明确操作；1x 也要强制，因此置位 rateExplicit
    rateExplicit = true;
    if (blocked) {
      if (isTop) sendResponse({ count: 0, blocked: true });
    } else {
      const count = applySpeed(msg.rate);
      if (isTop) {
        sendResponse({ count, blocked: false, enforcing: shouldEnforce() });
      }
    }
  } else if (msg.type === "getSpeed") {
    if (isTop) {
      sendResponse({
        rate: currentRate,
        count: boundList.filter((v) => v.isConnected).length,
        blocked,
        webFullscreen: !!fsVideo,
        enforcing: shouldEnforce(),
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
  }
  return false;
});

// 自动网页全屏：按“视频源”去重，同一个 <video> 换源后可以再次触发；
// 同一个视频手动退出后不再自动进入。
function maybeAutoFullscreen(v) {
  if (!isTop || !autoFullscreen || blocked || fsVideo) return;

  const src = v.currentSrc || v.src || "";
  if (autoDoneSrc.has(v) && autoDoneSrc.get(v) === src) return;

  const fits = () => {
    const r = v.getBoundingClientRect();
    return r.width >= 400 && r.height >= 200;
  };

  const mark = () => autoDoneSrc.set(v, src);

  if (fits()) {
    mark();
    enterWebFullscreen(v);
    return;
  }
  // 尺寸暂不满足（可能尚未完成布局），稍后重新检查一次，仍不满足则放弃
  setTimeout(() => {
    if (!isTop || !autoFullscreen || blocked || fsVideo) return;
    if (!v.isConnected) return;
    // 源已换掉（feed 复用同一个元素）就不要为旧源进入全屏
    if ((v.currentSrc || v.src || "") !== src) return;
    if (autoDoneSrc.has(v) && autoDoneSrc.get(v) === src) return;
    if (!fits()) return;
    mark();
    enterWebFullscreen(v);
  }, 300);
}

// 开关/倍速/排除规则变化时立即生效，无需刷新页面
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  // init 还没算出 blocked 时先忽略，避免被排除页面在初始化前被应用倍速
  if (!initialized) return;
  if (changes.autoWebFullscreen) {
    autoFullscreen = !!changes.autoWebFullscreen.newValue;
    if (autoFullscreen) {
      // 打开开关时，已经处于播放中的视频也应立即进入
      for (const v of boundList) {
        if (v.isConnected && !v.paused && !v.ended) maybeAutoFullscreen(v);
      }
    }
  }
  // 先更新「用户是否明确设置过」，再统一应用一次倍速，避免同一次 storage 变更
  // 同时带 rate 和 rateExplicit 时触发两轮全量扫描
  if (changes.rateExplicit) {
    rateExplicit = !!changes.rateExplicit.newValue;
  }
  if (changes.rate && !blocked) {
    applySpeed(changes.rate.newValue);
  } else if (changes.rateExplicit && !blocked) {
    applySpeed(currentRate);
  }
  // 排除规则由 storage 事件驱动，所有 frame 都会收到，无需 popup 逐个 tab 发消息
  if (changes.blocklist || changes.blocklistCustomized) {
    refreshBlocked();
  }
});

// 初始化：应用已保存的速度并判断排除状态
(function init() {
  observeRoot(document.documentElement);
  chrome.storage.local.get(
    {
      rate: 1.0,
      blocklist: DEFAULT_BLOCKLIST,
      autoWebFullscreen: false,
      rateExplicit: false,
      blocklistCustomized: false,
    },
    ({
      rate,
      blocklist,
      autoWebFullscreen: autoFs,
      rateExplicit: explicit,
      blocklistCustomized: customized,
    }) => {
      rateExplicit = !!explicit;
      const rules = migrateBlocklist(blocklist, customized);
      setBlocklist(rules);
      autoFullscreen = !!autoFs;
      blocked = isBlockedUrl(location.href);
      // 先告诉主世界当前倍速与是否启用，再应用到视频
      syncMainWorld();
      if (blocked) {
        collectVideos(document).forEach(bindVideo);
      } else {
        // 1x 且用户没有明确设置过时，applySpeed 不会写视频，只完成绑定
        applySpeed(rate);
      }
      updateTrackBtn();
      initialized = true;
    }
  );
})();