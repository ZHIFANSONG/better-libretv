'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';

/**
 * 顶部导航进度条（App Router 没有路由事件，只能自己拼）：
 * - 起：捕获阶段拦 document 上的左键点击，命中「同源、目标不同路径」的 <a> 就开始爬；back/forward 走 popstate；
 * - 止：usePathname 变化（新页面挂载）后冲到 100% 再淡出。
 * 进度是估计值（先快后慢逼近 90%），只表达「正在导航」，不承诺真实完成度。
 */
export function TopProgress() {
  const pathname = usePathname();
  const [progress, setProgress] = useState(0);
  const [visible, setVisible] = useState(false);
  const tick = useRef<number | null>(null);
  const fade = useRef<number | null>(null);
  const running = useRef(false);
  const mounted = useRef(false);

  const stopTick = () => {
    if (tick.current !== null) {
      window.clearInterval(tick.current);
      tick.current = null;
    }
  };

  const start = () => {
    if (running.current) return;
    running.current = true;
    if (fade.current !== null) {
      window.clearTimeout(fade.current);
      fade.current = null;
    }
    setVisible(true);
    setProgress(6);
    stopTick();
    tick.current = window.setInterval(() => {
      setProgress((p) => (p >= 90 ? p : p + Math.max(0.6, (90 - p) * 0.08)));
    }, 90);
  };

  const finish = () => {
    if (!running.current) return;
    running.current = false;
    stopTick();
    setProgress(100);
    if (fade.current !== null) window.clearTimeout(fade.current);
    fade.current = window.setTimeout(() => {
      setVisible(false);
      setProgress(0);
    }, 320);
  };

  // 路由变化 → 收尾（首帧不算）
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    finish();
    // finish 只读写 ref，不需要进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!link) return;
      if (link.target && link.target !== '_self') return;
      const href = link.getAttribute('href') || '';
      if (!href || href.startsWith('#') || link.hasAttribute('download')) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      start();
    };
    const onPop = () => start();
    document.addEventListener('click', onClick, true);
    window.addEventListener('popstate', onPop);
    return () => {
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('popstate', onPop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => () => {
      stopTick();
      if (fade.current !== null) window.clearTimeout(fade.current);
    },
    []
  );

  return (
    <div className="g-progress" data-on={visible ? '1' : '0'} aria-hidden="true">
      <div className="g-progress-bar" style={{ width: `${progress}%` }} />
    </div>
  );
}
