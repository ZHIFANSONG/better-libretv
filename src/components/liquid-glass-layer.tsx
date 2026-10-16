'use client';

import { useEffect } from 'react';
import { initLiquidGlass } from '@/lib/liquid-glass';

/**
 * 折射玻璃引擎的挂载器（全站只挂一次）：
 * - 首帧扫描页面上所有 .lg 元素并生成位移贴图 + SVG 滤镜；
 * - 二级菜单（抽屉 / 下拉 / 弹窗 / 设置面板）都是异步挂载的，
 *   用 MutationObserver 增量扫描，保证新出现的面板也能立刻拿到折射；
 * - 引擎自身按尺寸做脏检查，重复扫描不会重复烘贴图。
 *
 * 注意启动时机：引擎是往元素上写 inline style，而 React 的 hydration 会拿
 * 服务端 HTML 与这些「它没生成过」的属性比对，过早写入会报 hydration mismatch。
 * 所以首扫必须等 hydration 结束（load 事件）之后，MutationObserver 只处理
 * 之后新插入的节点（那时 React 已经 hydrate 完了）。
 */
export function LiquidGlassLayer() {
  useEffect(() => {
    let raf = 0;
    let mo: MutationObserver | null = null;
    let started = false;

    const scan = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => initLiquidGlass());
    };

    const start = () => {
      if (started) return;
      started = true;
      scan();
      mo = new MutationObserver(scan);
      mo.observe(document.body, { childList: true, subtree: true });
    };

    const idle = (window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    }).requestIdleCallback;
    const kick = () => {
      if (idle) idle(start, { timeout: 1200 });
      else window.setTimeout(start, 120);
    };

    if (document.readyState === 'complete') kick();
    else window.addEventListener('load', kick, { once: true });
    // 兜底：图片挂住导致 load 迟迟不来时也要上玻璃
    const fallback = window.setTimeout(start, 1500);

    return () => {
      window.clearTimeout(fallback);
      window.removeEventListener('load', kick);
      cancelAnimationFrame(raf);
      if (mo) mo.disconnect();
    };
  }, []);

  return null;
}
