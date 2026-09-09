// content.js —— 注入网页，控制视频播放速度
let currentRate = 1.0;
let blocked = false;

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
      pendingAdded = [];
      bindNewVideos(collectVideos(document));
      return;
    }
    const added = pendingAdded;
    pendingAdded = [];
    for (const el of added) bindNewVideos(collectFrom(el));
  }, 100);
}

// 请求序号：丢弃过期的 storage 读取结果
let refreshSeq = 0;

// 重算排除状态，必要时切换速度；状态确定后调用 callback
function refreshBlocked(callback) {
  const seq = ++refreshSeq;
  chrome.storage.local.get({ rate: 1.0, blocklist: [] }, ({ rate, blocklist }) => {
    if (seq !== refreshSeq) return;
    setBlocklist(blocklist);
    const nowBlocked = isBlockedUrl(location.href);
    if (nowBlocked !== blocked) {
      blocked = nowBlocked;
      applySpeed(nowBlocked ? 1.0 : rate);
    }
    if (callback) callback();
  });
}

// 监听路由变化，重算排除状态
window.addEventListener("popstate", () => refreshBlocked());
window.addEventListener("hashchange", () => refreshBlocked());
if (typeof navigation !== "undefined") {
  navigation.addEventListener("navigate", () => refreshBlocked());
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
      });
    }
  } else if (msg.type === "checkBlock") {
    refreshBlocked(isTop ? () => sendResponse({ blocked }) : null);
    return isTop; // 顶层需保持消息通道等待异步回复
  }
  return false;
});

// 初始化：应用已保存的速度并判断排除状态
(function init() {
  observeRoot(document.documentElement);
  chrome.storage.local.get({ rate: 1.0, blocklist: [] }, ({ rate, blocklist }) => {
    setBlocklist(blocklist);
    blocked = isBlockedUrl(location.href);
    if (blocked) {
      collectVideos(document).forEach(bindVideo);
    } else {
      applySpeed(rate);
    }
  });
})();