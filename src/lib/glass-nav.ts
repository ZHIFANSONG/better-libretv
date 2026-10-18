/**
 * 顶栏那块「选中气泡」的位置：由激活项自己的盒子决定。
 *
 * 为什么不用 glass-tab-bar：它的 ::slotted(*) 会把每格塞成「图标 + 文字两行 11px」，
 * 而顶栏要的是横排文字链接与 Next 的 <Link> 语义。glassium 的 glass-glide 本来就只是
 * 「元素一帧挪超过 24px 就让玻璃飞过去」——把一块绝对定位的玻璃挪到新位置就够了。
 */

export interface BubbleBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 把激活项在容器坐标系里的矩形算出来；没有激活项或量不到时返回 null。 */
export function bubbleBox(container: HTMLElement | null, active: HTMLElement | null): BubbleBox | null {
  if (!container || !active) return null;
  const c = container.getBoundingClientRect();
  const a = active.getBoundingClientRect();
  if (a.width <= 0 || a.height <= 0) return null;
  return { x: a.left - c.left, y: a.top - c.top, w: a.width, h: a.height };
}

/** 两个盒子是不是同一个位置（1px 内当作没动，避免来回写 style 触发 glassium 的飞行）。 */
export function sameBox(a: BubbleBox | null, b: BubbleBox | null): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(a.w - b.w) < 1 && Math.abs(a.h - b.h) < 1;
}

/**
 * 给一块「滑块」写位置。
 *
 * 为什么要模块级记住上次落点（lastBoxes）：换路由时 Next 会先渲染 app/loading.tsx
 * 里的另一份 <Header/>，真实页面的 Header 再挂载一次 —— DOM 节点整个换新，
 * 组件内的 ref 拿不到「之前在哪」，新元素只会凭空出现在终点，滑动动画自然没有。
 * 把落点存到模块作用域就能跨这次重挂载接上。
 *
 * 为什么自己补动画：glassium 的 glass-glide 是死路 —— runtime/glass.js:211 要求
 * backend !== 'css'，而本项目为了兼容性锁的就是 CSS 后端（src/components/glass-runtime.tsx）。
 */
const lastBoxes = new Map<string, BubbleBox>();

export function placeSlider(
  el: HTMLElement | null,
  box: BubbleBox,
  opts: { animate?: boolean; key?: string } = {},
): void {
  if (!el) return;
  const key = opts.key;
  const prev = key ? lastBoxes.get(key) ?? null : null;
  if (key) lastBoxes.set(key, box);

  const write = (b: BubbleBox) => {
    el.style.left = `${b.x}px`;
    el.style.top = `${b.y}px`;
    el.style.width = `${b.w}px`;
    el.style.height = `${b.h}px`;
  };

  const fly = opts.animate !== false && shouldAnimate(prev, box);
  if (!fly) {
    // 首帧 / 缩窗口 / 跨了大半屏：直接落位，不出动画。
    const saved = el.style.transition;
    el.style.transition = 'none';
    write(box);
    void el.offsetWidth; // 让无动画的写值立刻成立，再交还给 CSS
    el.style.transition = saved;
    return;
  }

  // 先无动画退回到上次落点（老元素本来就在那儿，这步是空转；
  // 刚重挂载的新元素则靠这步「站到旧位置」），下一帧再交给 transition 滑过去。
  const saved = el.style.transition;
  el.style.transition = 'none';
  write(prev!);
  void el.offsetWidth;
  el.style.transition = saved;
  requestAnimationFrame(() => write(box));
}

/** 目标位置离得太远（跨了大半屏）时不做滑动，直接瞬移 —— 免得滑块横穿整页。 */
export function shouldAnimate(from: BubbleBox | null, to: BubbleBox): boolean {
  if (!from) return false;
  return Math.abs(to.x - from.x) <= 260 && Math.abs(to.y - from.y) <= 120;
}
