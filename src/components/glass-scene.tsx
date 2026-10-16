'use client';

import glassium, { onStageChange } from 'glassium/runtime';
import { useEffect } from 'react';

/**
 * 页面背景（原来的 .g-mesh 网格 + .g-bg 光斑两层 DOM）搬进 glassium 的场景。
 *
 * 为什么必须搬（glassium 的 R1）：GPU 玻璃画在页面底下那块 `position:fixed; z-index:-1` 的画布上，
 * 任何「画了背景」的 DOM 层只要夹在画布与内容之间，就会把玻璃整块挡住。原来的 .g-mesh(z-index:0) /
 * .g-bg(z-index:1) 正好在那儿，而且它们用的是 ::before 渐变和 SVG 子节点 —— glassium 的背景收编只认
 * 元素自身的 CSS background，收不走。搬进场景之后，玻璃折射到的就是这片极光。
 *
 * 画布压到 720px 宽：极光本来就是大片模糊，被场景按 cover 放大铺满后看不出损失；上传的纹理小 8 倍。
 * 画布每帧都在变（光斑在漂），所以场景设 dynamic —— 副作用是 glassium 的帧循环会一直转，
 * 这正好是 glass-jelly / glass-glide 需要的（它们搭的是同一个帧循环的车）。
 */

/** 画布宽度上限（CSS 像素）。高度按视口比例算，保证 cover 铺满时不裁切。 */
const MAX_W = 720;
/** 重画间隔，毫秒。极光很慢，30fps 足够；scene 那边仍然每帧上传（dynamic）。 */
const PAINT_MS = 33;
/** 与 .dark 的页面底色一致：不透明画布留白处、以及降级时的兜底色。 */
const PAGE_DARK = '#070a12';
const PAGE_LIGHT = '#f7f8fb';

/** 触屏用 CSS 后端：那里的滚动由合成线程直接做，画在页面底下的 GPU 玻璃会慢一两帧、落在文字后面。 */
function coarsePointer(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches
  );
}
// 要紧跟 import 同步调：runtime 的自动启动排在微任务里（runtime/auto.js 的 scheduleAutoStart）。
// auto:false 是必须的 —— 自动启动会在 React hydrate 之前就给 SSR 出来的 [glass] 元素加上
// data-glassium-* 属性，React 一比就报 hydration mismatch（dev 浮层的「1 Issue」）。
// 关掉之后由下面的 useEffect（hydration 之后）手动 start()。
try {
  glassium.configure({ auto: false, backend: coarsePointer() ? 'css' : 'auto' });
} catch {
  /* 配置项在旧版本里可能不存在，忽略 */
}

/** 三角波 + smoothstep：等价于 CSS 的 `ease-in-out alternate`。 */
function alternate(seconds: number, duration: number, delay: number): number {
  const p = (((seconds - delay) / duration) % 1 + 1) % 1;
  const tri = 1 - Math.abs(1 - 2 * p);
  return tri * tri * (3 - 2 * tri);
}

export function GlassScene() {
  useEffect(() => {
    // 接管页面上已有的 [glass]（header 的气泡、搜索框、图标按钮……）。
    // 不能放在模块顶层（微任务里跑，早于 hydrate），也不能紧跟 effect —— Next 的 Suspense
    // 边界是流式补进来的，那时还没比完属性，一加 data-glassium-* React 就报 hydration mismatch。
    // 所以推迟到本帧的活干完（requestIdleCallback，最迟 500ms）。
    let cancelStart = () => {};
    {
      const w = window as Window & {
        requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
        cancelIdleCallback?: (h: number) => void;
      };
      if (typeof w.requestIdleCallback === 'function') {
        const h = w.requestIdleCallback(() => glassium.start(), { timeout: 500 });
        cancelStart = () => w.cancelIdleCallback?.(h);
      } else {
        const h = window.setTimeout(() => glassium.start(), 250);
        cancelStart = () => window.clearTimeout(h);
      }
    }

    const root = document.documentElement;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let cw = 0;
    let ch = 0;
    let raf = 0;
    let disposed = false;
    let lastPaint = -1e9;
    let stageBound = false;

    const measure = () => {
      const vw = Math.max(1, window.innerWidth);
      const vh = Math.max(1, window.innerHeight);
      cw = Math.max(1, Math.min(MAX_W, Math.round(vw)));
      ch = Math.max(1, Math.round((cw * vh) / vw));
      canvas.width = cw;
      canvas.height = ch;
      lastPaint = -1e9; // 尺寸变了：下一次循环立刻重画
    };

    /** 一团柔光：中心实、边缘透明（原来的 blur(70px) 圆，用径向渐变等价画，比 ctx.filter 便宜）。 */
    const glow = (x: number, y: number, radius: number, rgb: string, alpha: number) => {
      const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
      g.addColorStop(0, `rgba(${rgb},${alpha})`);
      g.addColorStop(0.45, `rgba(${rgb},${alpha * 0.55})`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    };

    const paint = (now: number) => {
      const dark = root.classList.contains('dark');
      const t = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : now / 1000;
      // 以 1440px 宽为设计基准，画布上的一切按这个比例缩（原来 CSS 里的 px 值直接乘 s）
      const s = cw / 1440;

      ctx.globalAlpha = 1;
      ctx.fillStyle = dark ? PAGE_DARK : PAGE_LIGHT;
      ctx.fillRect(0, 0, cw, ch);

      // 顶部大蓝晕（.g-bg::before 的 1500×1100 椭圆）
      glow(cw / 2, 110 * s, 750 * s, '77,107,254', dark ? 0.34 : 0.22);

      // 两团漂移光斑（.g-bg i:nth-child(1)/(2)，24s / 19s alternate ease-in-out）
      const a = alternate(t, 24, 0);
      glow(
        (0.46 * cw) + 260 * s - 200 * s * a,
        (0.12 * ch) + 260 * s + 220 * s * a,
        330 * s,
        '98,134,255',
        dark ? 0.6 : 0.42,
      );
      const b = alternate(t, 19, -6);
      glow(
        (0.06 * cw) + 190 * s + 260 * s * b,
        (0.52 * ch) + 190 * s - 160 * s * b,
        260 * s,
        '158,196,255',
        dark ? 0.5 : 0.36,
      );

      // 46px 网格线（.g-mesh 的 SVG pattern）
      ctx.globalAlpha = dark ? 0.45 : 0.6;
      ctx.strokeStyle = dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.07)';
      ctx.lineWidth = 1;
      const step = 46 * s;
      ctx.beginPath();
      for (let x = 0.5; x <= cw; x += step) {
        ctx.moveTo(Math.round(x) + 0.5, 0);
        ctx.lineTo(Math.round(x) + 0.5, ch);
      }
      for (let y = 0.5; y <= ch; y += step) {
        ctx.moveTo(0, Math.round(y) + 0.5);
        ctx.lineTo(cw, Math.round(y) + 0.5);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    };

    const loop = (now: number) => {
      if (disposed) return;
      if (now - lastPaint >= PAINT_MS) {
        lastPaint = now;
        paint(now);
        // 场景设的是 dynamic:false 时要用它补一帧；dynamic:true 时多调一次也无妨（回退成没有）
        glassium.stage?.refreshScene?.();
      }
      raf = requestAnimationFrame(loop);
    };

    const bind = (stage: NonNullable<typeof glassium.stage>) => {
      if (disposed || stageBound) return;
      stageBound = true;
      paint(performance.now());
      stage
        .setScene(canvas, { fit: 'cover', dynamic: true, background: dark0() })
        .then(() => {
          if (disposed) return;
          // 背景交给场景了：摘掉兜底底色（那层纯色会被收成场景的根填充，压住这块画布）
          root.classList.add('glass-ready');
          // 通知 glassium 重扫一次根背景（absorb 只监听 scroll / resize，root 不跟 class 走）
          window.dispatchEvent(new Event('resize'));
        })
        .catch(() => {
          /* 场景没设成：保留兜底底色 */
        });
    };

    const dark0 = () => (root.classList.contains('dark') ? PAGE_DARK : PAGE_LIGHT);

    measure();
    paint(performance.now());
    raf = requestAnimationFrame(loop);

    const onResize = () => measure();
    window.addEventListener('resize', onResize);

    // 主题切换：canvas 上的颜色要跟着变（html 的 class 由 ThemeProvider 改）
    const themeWatch = new MutationObserver(() => {
      lastPaint = -1e9;
    });
    themeWatch.observe(root, { attributes: true, attributeFilter: ['class'] });

    // 等 stage：start() 之后第一次有 [glass] 被接管时才建。订阅变化的另一个好处是
    // 后端降级 / 重建时能重新 bind —— 轮询 glassium.stage 会漏掉这些。
    const unbindStage = onStageChange((s) => {
      if (disposed || stageBound) return;
      if (s && s.backend !== 'none') bind(s);
    });
    const cur = glassium.stage;
    if (cur && cur.backend !== 'none') bind(cur);

    return () => {
      disposed = true;
      cancelStart();
      unbindStage();
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      themeWatch.disconnect();
      root.classList.remove('glass-ready');
    };
  }, []);

  return null;
}
