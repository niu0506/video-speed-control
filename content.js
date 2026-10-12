// content.js —— 注入网页，控制视频播放速度
let currentRate = 1.0;
let blocked = false;
let autoFullscreen = false;

// 仅作 storage 读取失败时的兜底，真实来源是 storage
const DEFAULT_BLOCKLIST = ["/list/", "live", "missav", "list=WL", "wanyiwan"];

// 排除规则的正则缓存
let compiledRules = [];

function setBlocklist(list) {
  compiledRules = list
    .map((p) => {
      try {
        return new RegExp(p);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// 当前 URL 是否命中排除规则
function isBlockedUrl(url) {
  return compiledRules.some((re) => re.test(url));
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

// 外部持续改速时的对抗上限与冷却期
const FIGHT_LIMIT = 5;
const COOLDOWN = 10000;

// 已绑定的视频，避免重复绑定
const boundVideos = new WeakSet();

// 绑定视频：设置速度并恢复外部改动
function bindVideo(v) {
  if (boundVideos.has(v)) return;
  boundVideos.add(v);

  let fights = 0;
  let giveUpUntil = 0;

  v.addEventListener("ratechange", () => {
    if (blocked) return;
    if (Math.abs(v.playbackRate - currentRate) < 1e-6) return;
    if (Date.now() < giveUpUntil) return;

    fights++;
    if (fights > FIGHT_LIMIT) {
      fights = 0;
      giveUpUntil = Date.now() + COOLDOWN;
      return;
    }
    v.playbackRate = currentRate;
  });

  ["play", "loadeddata", "canplay"].forEach((evt) => {
    v.addEventListener(evt, () => {
      if (blocked) return;
      if (Date.now() < giveUpUntil) return;
      v.playbackRate = currentRate;
    });
  });

  // 开启自动网页全屏时，视频开始播放即进入
  v.addEventListener("play", () => maybeAutoFullscreen(v));
}

// 将速度应用到所有视频
function applySpeed(rate) {
  currentRate = rate;
  const videos = collectVideos(document);
  for (const v of videos) {
    bindVideo(v);
    if (Math.abs(v.playbackRate - rate) > 1e-6) v.playbackRate = rate;
  }
  return videos.length;
}

// 绑定列表中尚未绑定的视频
function bindNewVideos(videos) {
  for (const v of videos) {
    if (boundVideos.has(v)) continue;
    bindVideo(v);
    if (!blocked) v.playbackRate = currentRate;
  }
}

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
      pendingAdded = [];
      const videos = collectVideos(document);
      knownVideos = videos;
      bindNewVideos(videos);
      updateTrackBtn();
      return;
    }
    const added = pendingAdded;
    pendingAdded = [];
    for (const el of added) {
      const videos = collectFrom(el);
      knownVideos.push(...videos);
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
      setBlocklist(blocklist);
      const nowBlocked = isBlockedUrl(location.href);
      if (nowBlocked !== blocked) {
        blocked = nowBlocked;
        applySpeed(nowBlocked ? 1.0 : rate);
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
      setBlocklist(blocklist);
      autoFullscreen = !!autoFs;
      blocked = isBlockedUrl(location.href);
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