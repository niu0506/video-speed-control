// shared.js —— content script 与 popup 共用：默认排除表 + 迁移逻辑 + 倍速规范化
//
// 为什么单独一个文件：默认排除表原先在 content.js 和 popup.js 各写一份，
// 改一处忘另一处就会出现「弹窗显示旧规则、页面按新规则执行」的错位
// （历史上 popup 就因为少一份迁移逻辑而落后于 content.js）。

// 合法倍速范围；main world 拦截器里也有一份同样的常量
const RATE_MIN = 0.25;
const RATE_MAX = 16;

// 把任意来源（storage、消息、旧版本数据）的倍速收敛到合法范围。
// 非数字 / 空值回退到 fallback，避免 target 与写入值不一致导致反复纠正。
function normalizeRate(value, fallback = 1) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(RATE_MAX, Math.max(RATE_MIN, n));
}

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
  return (
    Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((p, i) => p === b[i])
  );
}

// 升级未改动过的历史默认表。
// blocklistCustomized=true 时完全信任用户列表（哪怕它恰好等于某份历史默认表）；
// 老版本没有这个标志：不是历史默认表就视为自定义，并补上标志，避免下次再被迁移逻辑误判。
function migrateBlocklist(list, customized) {
  if (!Array.isArray(list)) {
    chrome.storage.local.set({ blocklist: DEFAULT_BLOCKLIST });
    return DEFAULT_BLOCKLIST;
  }

  const clean = list.filter((p) => typeof p === "string");
  if (clean.length !== list.length) {
    chrome.storage.local.set({ blocklist: clean });
  }

  if (customized) return clean;
  if (sameList(clean, DEFAULT_BLOCKLIST)) return clean;

  if (HISTORICAL_DEFAULT_BLOCKLISTS.some((def) => sameList(def, clean))) {
    chrome.storage.local.set({
      blocklist: DEFAULT_BLOCKLIST,
      blocklistCustomized: false,
    });
    return DEFAULT_BLOCKLIST;
  }

  chrome.storage.local.set({
    blocklist: clean,
    blocklistCustomized: true,
  });
  return clean;
}
