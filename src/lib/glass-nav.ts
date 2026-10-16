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
