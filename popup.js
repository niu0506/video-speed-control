// popup.js —— 扩展弹窗：调速面板 + 排除网站管理
const $ = (id) => document.getElementById(id);
let currentRate = 1.0;

// 切换两个视图
function showView(name) {
  $("speedView").style.display = name === "speed" ? "block" : "none";
  $("blockView").style.display = name === "block" ? "block" : "none";
  if (name === "block") getBlocklist().then(renderBlocklist);
}

// 显示/隐藏排除提示
function setBlockedUI(blocked) {
  $("blocked").style.display = blocked ? "block" : "none";
  return blocked;
}

// 更新当前速度 UI
function setCurrent(rate, videoCount) {
  currentRate = rate;
  $("current").textContent = rate.toFixed(2) + "x";
  $("slider").value = rate;
  document.querySelectorAll("#presets button").forEach((b) => {
    b.classList.toggle("active", Number(b.dataset.rate) === rate);
  });
  $("tip").textContent =
    videoCount > 0 ? `已应用到 ${videoCount} 个视频` : "未检测到视频（请先播放）";
}

// 向当前标签页的 content script 发送消息
async function sendToTab(msg) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch {
    $("tip").textContent = "此页面不可用，刷新后重试";
    return null;
  }
}

// 设置倍速并保存
async function setSpeed(rate) {
  setBlockedUI(false);
  setCurrent(rate, 0);
  chrome.storage.local.set({ rate });
  const res = await sendToTab({ type: "setSpeed", rate });
  if (res) {
    setBlockedUI(res.blocked);
    setCurrent(rate, res.count);
  }
}

// 预设按钮
$("presets").addEventListener("click", (e) => {
  if (e.target.dataset.rate) setSpeed(Number(e.target.dataset.rate));
});

// 滑块实时预览 + 松开后应用
$("slider").addEventListener("input", (e) => {
  const rate = Number(e.target.value);
  $("current").textContent = rate.toFixed(2) + "x";
  document.querySelectorAll("#presets button").forEach((b) => {
    b.classList.toggle("active", Number(b.dataset.rate) === rate);
  });
});
$("slider").addEventListener("change", (e) => setSpeed(Number(e.target.value)));

// 网页全屏
function setWebFullscreenUI(on) {
  const btn = $("webFullscreen");
  btn.textContent = on ? "退出网页全屏" : "网页全屏";
  btn.classList.toggle("on", on);
}

// 自动网页全屏开关
async function refreshAutoFsUI() {
  const { autoWebFullscreen } = await chrome.storage.local.get({
    autoWebFullscreen: false,
  });
  const btn = $("autoFs");
  btn.textContent = "自动网页全屏播放：" + (autoWebFullscreen ? "开" : "关");
  btn.classList.toggle("on", autoWebFullscreen);
}

$("autoFs").addEventListener("click", async () => {
  const { autoWebFullscreen } = await chrome.storage.local.get({
    autoWebFullscreen: false,
  });
  await chrome.storage.local.set({ autoWebFullscreen: !autoWebFullscreen });
  refreshAutoFsUI();
});

$("webFullscreen").addEventListener("click", async () => {
  const res = await sendToTab({ type: "toggleWebFullscreen" });
  if (!res) return;
  if (res.found === false) {
    $("tip").textContent = "未检测到视频（请先播放）";
    return;
  }
  setWebFullscreenUI(res.webFullscreen);
  window.close(); // 关闭弹窗，立即查看效果
});

// 视图切换按钮
$("openOptions").addEventListener("click", () => showView("block"));
$("backSpeed").addEventListener("click", () => showView("speed"));

// 默认排除规则（与 content.js 保持一致）
const DEFAULT_BLOCKLIST = ["/list/", "live", "missav", "list=WL", "wanyiwan"];

// 读取/保存排除列表
async function getBlocklist() {
  const { blocklist } = await chrome.storage.local.get({
    blocklist: DEFAULT_BLOCKLIST,
  });
  return blocklist;
}

async function saveBlocklist(list) {
  await chrome.storage.local.set({ blocklist: list });
  renderBlocklist(list);
  notifyAllTabs();
}

// 通知所有标签页重新检查排除规则
async function notifyAllTabs() {
  let tabs;
  try {
    // 只查能注入 content script 的页面，跳过 chrome:// 等无效目标
    tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  } catch {
    tabs = await chrome.tabs.query({});
  }
  await Promise.allSettled(
    tabs
      .filter((t) => t.id != null)
      .map((t) => chrome.tabs.sendMessage(t.id, { type: "checkBlock" }))
  );
}

// 渲染排除规则列表
function renderBlocklist(list) {
  const ul = $("list");
  ul.innerHTML = "";
  $("empty").style.display = list.length ? "none" : "block";
  for (const pattern of list) {
    const li = document.createElement("li");
    li.textContent = pattern;
    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "删除";
    del.onclick = () => {
      saveBlocklist(list.filter((p) => p !== pattern));
    };
    li.appendChild(del);
    ul.appendChild(li);
  }
}

// 添加排除规则
async function addBlockRule() {
  const value = $("input").value.trim();
  $("error").textContent = "";
  if (!value) return;

  try {
    new RegExp(value);
  } catch (e) {
    $("error").textContent = `无效的正则表达式：${e.message}`;
    return;
  }

  const list = await getBlocklist();
  if (list.includes(value)) {
    $("error").textContent = "该规则已存在";
    return;
  }
  $("input").value = "";
  saveBlocklist([...list, value]);
}

// 添加按钮 + 回车提交
$("add").addEventListener("click", addBlockRule);
$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") addBlockRule();
});

// 初始化：读取当前调速状态
(async () => {
  refreshAutoFsUI();
  const { rate } = await chrome.storage.local.get({ rate: 1.0 });
  const res = await sendToTab({ type: "getSpeed" });
  if (res) {
    setBlockedUI(res.blocked);
    setCurrent(res.blocked ? 1.0 : res.rate, res.count);
    setWebFullscreenUI(!!res.webFullscreen);
  } else {
    setCurrent(rate, 0);
  }
})();