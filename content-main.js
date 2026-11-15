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
//   - 扩展自己通过 CustomEvent 声明的写入则照常放行。
// 这样站点无论怎么重置，倍速都不会真的掉下去。

(() => {
  const PROTO = HTMLMediaElement.prototype;
  const RATE = "playbackRate";
  const DEF_RATE = "defaultPlaybackRate";

  const rateDesc = Object.getOwnPropertyDescriptor(PROTO, RATE);
  const defDesc = Object.getOwnPropertyDescriptor(PROTO, DEF_RATE);
  // 环境不支持时直接放弃，不影响扩展其余功能
  if (!rateDesc || !rateDesc.set) return;

  // 当前目标倍速；enabled=false 时完全不干预（页面被排除、或扩展未初始化）
  let target = 1;
  let enabled = false;

  // 扩展自己的写入会带这个标记，避免被自己拦截
  const PASSTHROUGH = "__vsc_passthrough__";

  function shouldCoerce() {
    return enabled && Number.isFinite(target) && target > 0;
  }

  function patch(name, desc, valueOf) {
    if (!desc || !desc.set || !desc.get) return;
    Object.defineProperty(PROTO, name, {
      configurable: true,
      enumerable: desc.enumerable,
      get() {
        return desc.get.call(this);
      },
      set(value) {
        // 扩展自身的写入或显式放行：真实写入
        if (this[PASSTHROUGH]) {
          return desc.set.call(this, value);
        }
        if (!shouldCoerce()) {
          return desc.set.call(this, value);
        }
        // 页面写入的值本来就是目标倍速：照常放行（避免无谓的 ratechange）
        if (Math.abs(value - valueOf()) < 1e-6) {
          return desc.set.call(this, value);
        }
        // 页面脚本想改成别的速度：改写成目标倍速
        return desc.set.call(this, valueOf());
      },
    });
  }

  patch(RATE, rateDesc, () => target);
  patch(DEF_RATE, defDesc, () => target);

  // 接收隔离世界的控制消息（DOM 事件可以跨世界传递）
  document.addEventListener("__vsc_set_rate__", (e) => {
    const d = e.detail || {};
    if (typeof d.rate === "number" && d.rate > 0) target = d.rate;
    enabled = !!d.enabled;
  });
})();
