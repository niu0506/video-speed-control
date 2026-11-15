const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// shared.js 是给浏览器 content script / popup 用的普通脚本，
// 这里用 vm + mock chrome.storage 在 Node 里直接跑它的纯逻辑。
function loadShared() {
  const writes = [];
  const sandbox = {
    chrome: { storage: { local: { set: (o) => writes.push(o) } } },
    console,
  };
  const code = fs.readFileSync(path.join(__dirname, "..", "shared.js"), "utf8");
  const api = vm.runInNewContext(
    code + "\n;({ normalizeRate, migrateBlocklist, DEFAULT_BLOCKLIST })",
    sandbox
  );
  return { ...api, writes };
}

const json = (value) => JSON.stringify(value);

test("normalizeRate 收敛到 [0.25, 16] 并处理非法值", () => {
  const { normalizeRate } = loadShared();
  assert.equal(normalizeRate("2"), 2);
  assert.equal(normalizeRate(undefined), 1);
  assert.equal(normalizeRate(null, 2), 2);
  assert.equal(normalizeRate(""), 1);
  assert.equal(normalizeRate("abc"), 1);
  assert.equal(normalizeRate(100), 16);
  assert.equal(normalizeRate(0), 0.25);
  assert.equal(normalizeRate(0.1), 0.25);
  assert.equal(normalizeRate(1.555), 1.555);
});

test("当前默认表原样返回，不写 storage", () => {
  const { migrateBlocklist, DEFAULT_BLOCKLIST, writes } = loadShared();
  assert.equal(json(migrateBlocklist(DEFAULT_BLOCKLIST, false)), json(DEFAULT_BLOCKLIST));
  assert.equal(writes.length, 0);
});

test("历史默认表迁移到当前默认表", () => {
  const { migrateBlocklist, DEFAULT_BLOCKLIST, writes } = loadShared();
  const historical = ["/list/", "//live\\.", "missav", "list=WL", "wanyiwan"];
  assert.equal(json(migrateBlocklist(historical, false)), json(DEFAULT_BLOCKLIST));
  assert.equal(
    json(writes),
    json([{ blocklist: DEFAULT_BLOCKLIST, blocklistCustomized: false }])
  );
});

test("用户自定义列表会打上 customized 标志", () => {
  const { migrateBlocklist, writes } = loadShared();
  assert.equal(json(migrateBlocklist(["custom"], false)), json(["custom"]));
  assert.equal(
    json(writes),
    json([{ blocklist: ["custom"], blocklistCustomized: true }])
  );
});

test("customized=true 时完全信任用户列表", () => {
  const { migrateBlocklist, writes } = loadShared();
  const historical = ["/list/", "//live\\.", "missav", "list=WL", "wanyiwan"];
  assert.equal(json(migrateBlocklist(historical, true)), json(historical));
  assert.equal(writes.length, 0);
});

test("storage 中 blocklist 非数组时修复为默认表", () => {
  const { migrateBlocklist, DEFAULT_BLOCKLIST, writes } = loadShared();
  assert.equal(json(migrateBlocklist(null, false)), json(DEFAULT_BLOCKLIST));
  assert.equal(json(writes), json([{ blocklist: DEFAULT_BLOCKLIST }]));
});

test("过滤非字符串规则，空列表视为自定义", () => {
  const { migrateBlocklist, writes } = loadShared();
  assert.equal(json(migrateBlocklist([1, "a", null], false)), json(["a"]));
  assert.equal(
    json(writes),
    json([{ blocklist: ["a"] }, { blocklist: ["a"], blocklistCustomized: true }])
  );

  writes.length = 0;
  assert.equal(json(migrateBlocklist([], false)), json([]));
  assert.equal(json(writes), json([{ blocklist: [], blocklistCustomized: true }]));
});
