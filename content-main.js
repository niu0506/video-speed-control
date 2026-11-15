// content-main.js —— 在页面主世界（MAIN world）拦截 playbackRate 写入
//
// 为什么必须放在主世界：
// 内容脚本（content.js）运行在隔离世界，与页面脚本各有一套 JS 原型链。
// 隔离世界里改写 HTMLMediaElement.prototype 影响不到页面脚本，
// 所以抖音这类站点写 video.playbackRate = 1 时，扩展只能「事后纠正」，
// 纠正频率永远追不上站点的重置频率 → 表现为倍速「时不时失效」。
//
// 本脚本在 document_start 注入，早于站点脚本执行，直接改写主世界的
// playbackRate / defaultPlaybackRate setter：
//   - 页面脚本写入时，改写成扩展的目标倍速（写入被吞掉）；
//   - 只处理 content.js 标记了 data-vsc-managed 的 <video>，
//     不碰 <audio> 与其他媒体元素；
//   - enabled=false（排除页 / 1x 未明确设置）时完全不干预。
//
// 注意：content.js 的写入走隔离世界自己的原生 setter，不会进入这里，
// 因此不存在「扩展写入被自己拦截」的问题，不需要任何透传标记。

(() => {
  const PROTO = HTMLMediaElement.prototype;
  const RATE = "playbackRate";
  const DEF_RATE = "defaultPlaybackRate";
  const MANAGED_ATTR = "data-vsc-managed";
  const MIN_RATE = 0.25;
  const MAX_RATE = 16;

  const rateDesc = Object.getOwnPropertyDescriptor(PROTO, RATE);
  const defDesc = Object.getOwnPropertyDescriptor(PROTO, DEF_RATE);
  // 环境不支持时直接放弃，不影响扩展其余功能
  if (!rateDesc || !rateDesc.set) return;

  // 当前目标倍速；enabled=false 时完全不干预
  let target = 1;
  let enabled = false;

  // DOM 属性跨世界可见，这是隔离世界告诉主世界「这个视频归我管」的方式
  function isManaged(el) {
    return (
      !!el &&
      typeof el.tagName === "string" &&
      el.tagName.toUpperCase() === "VIDEO" &&
      el.hasAttribute(MANAGED_ATTR)
    );
  }

  function shouldCoerce() {
    return enabled && Number.isFinite(target) && target > 0;
  }

  function patch(name, desc) {
    if (!desc || !desc.set || !desc.get) return;
    Object.defineProperty(PROTO, name, {
      configurable: true,
      enumerable: desc.enumerable,
      get() {
        return desc.get.call(this);
      },
      set(value) {
        if (!isManaged(this) || !shouldCoerce()) {
          return desc.set.call(this, value);
        }
        // 页面写入的值本来就是目标倍速：照常放行（避免无谓的 ratechange）
        const n = Number(value);
        if (Number.isFinite(n) && Math.abs(n - target) < 1e-6) {
          return desc.set.call(this, value);
        }
        // 页面脚本想改成别的速度：改写成目标倍速
        return desc.set.call(this, target);
      },
    });
  }

  patch(RATE, rateDesc);
  patch(DEF_RATE, defDesc);

  // 接收隔离世界的控制消息（DOM 事件可以跨世界传递）
  document.addEventListener("__vsc_set_rate__", (e) => {
    const d = e.detail || {};
    if (typeof d.rate === "number" && Number.isFinite(d.rate) && d.rate > 0) {
      target = Math.min(MAX_RATE, Math.max(MIN_RATE, d.rate));
    }
    enabled = !!d.enabled;
  });
})();
