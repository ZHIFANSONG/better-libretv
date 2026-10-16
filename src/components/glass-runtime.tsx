'use client';

import glassium from 'glassium/runtime';
import { useEffect } from 'react';

/**
 * 玻璃材质引导（CSS 后端）。
 *
 * 为什么放弃 GPU/WebGL 后端（用户 m06347：「如果液态玻璃实现不了的话你就还改回和主站一样的模糊吧」）：
 * 1. 线上 8443 生产构建下 WebGL 后端把海报全部盖空 —— 场景画布是不透明的、铺满视口，图片元素在它下面；
 *    实测 img.complete=true / naturalWidth=540 / 光线命中栈里图片就在画布下方，改成 CSS 后端海报立刻正常。
 * 2. CSS 后端本来就有真 blur：glassium 的 BASE_CSS 给每个 [glass] 元素挂了
 *    `backdrop-filter: blur(var(--glassium-blur)) saturate(var(--glassium-saturate)) var(--glassium-refract,)`
 *    （Chromium 上 cssRefraction 还会往 --glassium-refract 里塞位移贴图 url()，棱边折射照样有）。
 *    项目自己的 .g-glass / .g-panel / .g-ic 也补了同款声明（proposal.css），不依赖 runtime 兜底。
 * 3. 少一颗每帧跑的帧循环、少一张全屏画布 → 手机端省电、合成线程不被拖。
 *
 * 页面背景（网格 + 极光）不再由画布画，改回 .g-mesh / .g-bg 两层 fixed DOM（见 app/layout.tsx 与
 * proposal.css 的「背景层」段落），它们 z-index 0/1、内容 z-index 2，正好在玻璃下面被模糊到。
 *
 * absorbContent / absorbBackgrounds 都关掉：没有场景可画，收编只会白白改写
 * [data-glassium-absorbed] / [data-glassium-content] 属性，把元素自己的底色和文字清掉。
 *
 * auto:false 是必须的：自动启动会在 React hydrate 之前给 SSR 出来的 [glass] 元素加 data-glassium-* 属性，
 * React 一比就报 hydration mismatch（dev 浮层的「1 Issue」）。
 */
try {
  glassium.configure({
    auto: false,
    backend: 'css',
    absorbContent: false,
    absorbBackgrounds: false,
  });
} catch {
  /* 配置项在旧版本里可能不存在，忽略 */
}

export function GlassRuntime() {
  useEffect(() => {
    // 接管页面上已有的 [glass]（顶栏胶囊、气泡、搜索框、图标按钮、各种面板……）。
    // 不能放模块顶层（微任务里跑，早于 hydrate），也不能紧跟 effect —— Next 的 Suspense 边界是
    // 流式补进来的，那时还没比完属性，一加 data-glassium-* React 就报 hydration mismatch。
    // 推迟到本帧的活干完（requestIdleCallback，最迟 500ms）。
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (h: number) => void;
    };
    let cancel = () => {};
    if (typeof w.requestIdleCallback === 'function') {
      const h = w.requestIdleCallback(() => glassium.start(), { timeout: 500 });
      cancel = () => w.cancelIdleCallback?.(h);
    } else {
      const h = window.setTimeout(() => glassium.start(), 250);
      cancel = () => window.clearTimeout(h);
    }
    return cancel;
  }, []);

  return null;
}
