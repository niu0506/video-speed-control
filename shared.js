// shared.js —— content script 与 popup 共用的排除规则定义
//
// 为什么单独一个文件：默认排除表原先在 content.js 和 popup.js 各写一份，
// 改一处忘另一处就会出现「弹窗显示旧规则、页面按新规则执行」的错位
// （历史上 popup 就因为少一份迁移逻辑而落后于 content.js）。

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
