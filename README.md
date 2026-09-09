# 视频倍速播放

一款轻量的 Chrome 扩展（Manifest V3），一键控制网页视频的播放速度，支持 0.25x - 16x 倍速。

## 功能特性

- **快捷调速**：预设 0.5x / 1x / 1.5x / 2x / 3x / 4x / 8x / 16x 按钮，也可用滑块精确调节（步进 0.25）
- **自动应用**：速度设置会保存，新页面、新视频、SPA 路由跳转后自动生效，无需手动操作
- **全页面生效**：注入到所有 http/https 页面（含 iframe），支持穿透 Shadow DOM
- **对抗外部改速**：网站脚本或播放器重置播放速度时自动纠正，避免外部干扰导致速度失效（含冷却机制）
- **排除网站**：支持按正则匹配 URL，命中的页面不会被加速，适合需要保持原速的站点（如考试、直播平台）

## 安装

### 方式一：加载已解压（开发调试）

1. 克隆或下载本仓库代码
2. 打开 Chrome，访问 `chrome://extensions`
3. 开启右上角「开发者模式」
4. 点击「加载已解压的扩展程序」，选择项目目录

### 方式二：打包为 .crx 离线安装

适用于不想长期保留源码目录，或需要分发安装包的场景。

1. 打包生成 `.crx` 文件：

   ```bash
   # 生成私钥（仅需一次，之后升级复用它以保持扩展 ID 不变）
   openssl genrsa -out extension-key.pem 2048

   # 用 Chrome 打包（需退出当前 Chrome，或用独立的临时用户目录）
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
     --user-data-dir=/tmp/crx-profile --no-first-run --no-default-browser-check \
     --pack-extension=/path/to/本项目目录 --pack-extension-key=/path/to/extension-key.pem
   ```

   打包成功后，在源目录的上级目录会生成同名 `.crx` 与 `.pem` 文件。

2. 打开 Chrome，访问 `chrome://extensions`，开启右上角「开发者模式」
3. 将 `.crx` 文件拖入扩展管理页面，按提示确认安装
4. 若扩展被 Chrome 拦截（提示「未列在 Chrome 应用商店中」且开关为灰色），将扩展 ID 加入白名单后重启 Chrome：

   ```bash
   # extension-key.pem 对应的扩展 ID，可用下列命令计算
   openssl rsa -in extension-key.pem -pubout -outform DER | shasum -a 256 | cut -c1-32 | tr '0-9a-f' 'a-p'

   # 写入 Chrome 白名单策略（macOS）
   defaults write com.google.Chrome ExtensionInstallAllowlist -array "<扩展ID>"
   ```

> 注意：`extension-key.pem` 是扩展私钥，**切勿上传到公开仓库**（本项目已将其添加进 `.gitignore`）。

## 使用说明

- 点击工具栏中的扩展图标打开调速面板
- 点击预设倍速按钮或拖动滑块调整速度，立即生效并自动保存
- 面板底部「排除网站设置」可管理排除规则，规则为正则表达式，匹配完整的页面 URL，例如输入 `bilibili\.com` 将排除所有包含该域名的页面

## 项目结构

```
.
├── manifest.json   # 扩展清单（Manifest V3）
├── content.js      # 内容脚本：注入网页，控制视频播放速度
├── popup.html      # 扩展弹窗界面
└── popup.js        # 弹窗逻辑：调速面板 + 排除网站管理
```

## 技术说明

- 使用 `MutationObserver` 监听 DOM 变化，增量扫描新增视频节点，低频全量扫描兜底捕获晚挂载的 Shadow DOM
- 监听 `popstate` / `hashchange` / `navigation` 事件及轮询兜底，处理 SPA 无事件跳转
- 通过 `chrome.storage.local` 持久化倍速和排除规则
- 排除规则按每个 frame 的 URL 分别判断，顶层 frame 负责应答弹窗消息

## 许可证

MIT
