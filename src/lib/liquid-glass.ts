/**
 * liquid-glass.ts — 位移折射玻璃（Apple Liquid Glass）Web 引擎
 *
 * 组合两套开源思路：
 *  - shuding/liquid-glass：canvas 生成位移贴图 + feImage/feDisplacementMap + backdrop-filter: url(#f)
 *  - nikdelvin/liquid-glass：depth / chromaticAberration 参数化
 *
 * 纯 DOM 实现，无依赖。任何带 .lg 类的元素会被自动处理：
 *   data-lg="depth=40 k=0.95 ca=3 blur=16"   ← 空格分隔的 k=v 参数
 *
 * 关键点：单个元素一张位移贴图 + 一个 SVG 滤镜（id 唯一）；
 * 尺寸没变不重算；浏览器不支持 backdrop-filter:url() 时降级为普通模糊。
 */

/** 位移贴图参数 */
export interface GlassOptions {
  /** 折射带宽度（px）：只影响贴边这条带的厚度，与元素尺寸无关 */
  depth?: number;
  /** 带内最大内推比例：位移上界 = depth * k */
  k?: number;
  /** 色散强度（filter 单位），0 关闭 */
  ca?: number;
  /** 背景模糊半径（px）。小控件保持 0.4 锐利，大面板给 14~16 保证文字可读 */
  blur?: number;
  saturate?: number;
  brightness?: number;
  /** 贴图分辨率倍数，默认 1 */
  dpr?: number;
}

let seq = 0;
const uid = () => `lg${++seq}_${Math.random().toString(36).slice(2, 7)}`;

function smoothStep(a: number, b: number, t: number): number {
  t = Math.max(0, Math.min(1, (t - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function len(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

/** 圆角矩形 SDF：内部为负，边界为 0，外部为正 */
function roundedRectSDF(x: number, y: number, hw: number, hh: number, r: number): number {
  const qx = Math.abs(x) - hw + r;
  const qy = Math.abs(y) - hh + r;
  return Math.min(Math.max(qx, qy), 0) + len(Math.max(qx, 0), Math.max(qy, 0)) - r;
}

interface FragmentParams {
  width: number;
  height: number;
  radius: number;
  depth: number;
  k: number;
}

/** 位移贴图像素函数：折射带内把采样点沿外法线朝里推 */
function makeFragment(o: FragmentParams) {
  const w = o.width;
  const h = o.height;
  const r = Math.min(o.radius, Math.min(w, h) / 2 - 1);
  const depth = o.depth;
  const k = o.k;
  const hw = w / 2;
  const hh = h / 2;
  const e = 1;
  return (u: number, v: number): { x: number; y: number } => {
    const x = (u - 0.5) * w;
    const y = (v - 0.5) * h;
    const d = roundedRectSDF(x, y, hw, hh, r); // <0 在内部
    if (d > 0) return { x: u, y: v }; // 外圈不动
    const t = smoothStep(-depth, 0, d); // 1 = 贴边, 0 = 带内深处
    if (t <= 0) return { x: u, y: v };
    // 数值梯度 -> 外法线方向
    const dx = (roundedRectSDF(x + e, y, hw, hh, r) - roundedRectSDF(x - e, y, hw, hh, r)) / (2 * e);
    const dy = (roundedRectSDF(x, y + e, hw, hh, r) - roundedRectSDF(x, y - e, hw, hh, r)) / (2 * e);
    const push = t * t * depth * k; // t^2：影响集中在最外圈
    return { x: u - (dx * push) / w, y: v - (dy * push) / h };
  };
}

/** 把 fragment 逐像素烘成 dataURL 位移贴图（R=X位移 G=Y位移，+128 偏置） */
function buildCanvas(
  fragment: (u: number, v: number) => { x: number; y: number },
  w: number,
  h: number,
  dpr: number
): { url: string; max: number } {
  const cw = Math.max(2, Math.round(w * dpr));
  const ch = Math.max(2, Math.round(h * dpr));
  const c = document.createElement('canvas');
  c.width = cw;
  c.height = ch;
  const ctx = c.getContext('2d');
  if (!ctx) return { url: '', max: 1 };
  const img = ctx.createImageData(cw, ch);
  const data = img.data;
  const raw = new Float32Array(cw * ch * 2);
  let max = 1e-6;
  let k = 0;
  for (let i = 0; i < cw * ch; i++) {
    const px = i % cw;
    const py = (i / cw) | 0;
    const p = fragment(px / cw, py / ch);
    const dx = p.x * cw - px;
    const dy = p.y * ch - py;
    raw[k++] = dx;
    raw[k++] = dy;
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    if (m > max) max = m;
  }
  k = 0;
  for (let i = 0; i < cw * ch; i++) {
    const j = i * 4;
    data[j] = (raw[k++] / max) * 127 + 128; // R -> X 位移
    data[j + 1] = (raw[k++] / max) * 127 + 128; // G -> Y 位移
    data[j + 2] = 0;
    data[j + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return { url: c.toDataURL('image/png'), max };
}

const NS = 'http://www.w3.org/2000/svg';

/** 生成该元素的 SVG 滤镜（feImage 位移图 + feDisplacementMap，可选三通道色散） */
function buildFilter(id: string, w: number, h: number, mapUrl: string, scale: number, ca: number): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'lg-svg-defs');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  const defs = document.createElementNS(NS, 'defs');
  const f = document.createElementNS(NS, 'filter');
  f.setAttribute('id', id);
  f.setAttribute('filterUnits', 'userSpaceOnUse');
  f.setAttribute('color-interpolation-filters', 'sRGB');
  f.setAttribute('x', '0');
  f.setAttribute('y', '0');
  f.setAttribute('width', String(w));
  f.setAttribute('height', String(h));
  const im = document.createElementNS(NS, 'feImage');
  im.setAttribute('href', mapUrl);
  im.setAttribute('x', '0');
  im.setAttribute('y', '0');
  im.setAttribute('width', String(w));
  im.setAttribute('height', String(h));
  im.setAttribute('result', 'map');
  f.appendChild(im);
  const base = document.createElementNS(NS, 'feDisplacementMap');
  base.setAttribute('in', 'SourceGraphic');
  base.setAttribute('in2', 'map');
  base.setAttribute('scale', String(scale));
  base.setAttribute('xChannelSelector', 'R');
  base.setAttribute('yChannelSelector', 'G');
  f.appendChild(base);
  if (ca > 0) {
    // 三通道各自位移（scale ± ca）后只保留一个通道，再以 screen 混合出彩边。
    // 注意：合成前必须移除基准 feDisplacementMap，否则画面会重复叠加。
    const chans = [
      '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0',
      '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0',
      '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0',
    ];
    let prev: SVGFEBlendElement | null = null;
    for (let ci = 0; ci < 3; ci++) {
      const dm = document.createElementNS(NS, 'feDisplacementMap');
      dm.setAttribute('in', 'SourceGraphic');
      dm.setAttribute('in2', 'map');
      dm.setAttribute('scale', String(scale + (ci - 1) * ca));
      dm.setAttribute('xChannelSelector', 'R');
      dm.setAttribute('yChannelSelector', 'G');
      const cm = document.createElementNS(NS, 'feColorMatrix');
      cm.setAttribute('type', 'matrix');
      cm.setAttribute('values', chans[ci]);
      f.appendChild(dm);
      f.appendChild(cm);
      const bx = document.createElementNS(NS, 'feBlend');
      bx.setAttribute('in', ci === 0 ? 'map' : (prev as unknown as string));
      bx.setAttribute('in2', cm as unknown as string);
      bx.setAttribute('mode', 'screen');
      if (ci === 0) {
        f.removeChild(base);
        bx.setAttribute('in', dm as unknown as string);
      }
      f.appendChild(bx);
      prev = bx;
    }
  }
  defs.appendChild(f);
  svg.appendChild(defs);
  document.body.appendChild(svg);
  return svg;
}

/** Chromium 支持 backdrop-filter: url(#id)，Safari/Firefox 不支持（引擎会自动降级） */
export const supportsRefraction: boolean = (() => {
  if (typeof document === 'undefined') return false;
  const el = document.createElement('div');
  el.style.cssText = 'backdrop-filter:url(#x)';
  const v = el.style.backdropFilter;
  return v === 'url(#x)' || v === 'url("#x")';
})();

export class LiquidGlass {
  el: HTMLElement;
  opts: Required<GlassOptions>;
  id: string;
  svg: SVGSVGElement | null = null;
  /** 上次测量尺寸的缓存键（w x h r），相同则跳过重算 */
  private last = '';
  /** 上一次生成的耗时（ms，调试用） */
  cost = 0;

  constructor(el: HTMLElement, opts: GlassOptions = {}) {
    this.el = el;
    // 二级菜单/弹窗这类承载文字的玻璃面板需要足够大的背景模糊，否则文字会被光斑穿透。
    // 小控件（按钮、搜索框）保持锐利折射，模糊沿用全局默认的 0.4px。
    const panel = el.classList.contains('lg-panel');
    // lg-ctl：条状玻璃（顶栏、播放页标题栏），面积大但文字细，模糊取中间值
    const ctl = !panel && el.classList.contains('lg-ctl');
    this.opts = {
      depth: opts.depth ?? (panel ? 28 : ctl ? 22 : 18),
      k: opts.k ?? (panel ? 0.9 : ctl ? 0.7 : 0.55),
      ca: opts.ca ?? 0,
      blur: opts.blur ?? (panel ? 14 : ctl ? 10 : 0.4),
      saturate: opts.saturate ?? 1.35,
      brightness: opts.brightness ?? 1.06,
      dpr: opts.dpr ?? 1,
    };
    this.id = uid();
    el.classList.add('lg');
  }

  measure = (): void => {
    const r = this.el.getBoundingClientRect();
    const w = Math.round(r.width);
    const h = Math.round(r.height);
    if (w < 4 || h < 4) return;
    const cs = getComputedStyle(this.el);
    const radius = parseFloat(cs.borderTopLeftRadius) || 0;
    const key = `${w}x${h}r${radius}`;
    if (key === this.last) return;
    this.last = key;
    const o = this.opts;
    const t0 = performance.now();
    const frag = makeFragment({
      width: w * o.dpr,
      height: h * o.dpr,
      radius: radius * o.dpr,
      depth: o.depth * o.dpr,
      k: o.k,
    });
    const map = buildCanvas(frag, w * o.dpr, h * o.dpr, 1);
    const scale = map.max * 2;
    if (this.svg) this.svg.remove();
    this.svg = buildFilter(this.id, w, h, map.url, scale, o.ca);
    const chain = `url(#${this.id}) blur(${o.blur}px) saturate(${o.saturate}) brightness(${o.brightness})`;
    if (supportsRefraction) {
      this.el.style.backdropFilter = chain;
      this.el.style.setProperty('-webkit-backdrop-filter', chain);
    } else {
      // 不支持 url() 滤镜的浏览器：退化为普通毛玻璃
      this.el.style.backdropFilter = 'blur(14px) saturate(1.6)';
      this.el.style.setProperty('-webkit-backdrop-filter', 'blur(14px) saturate(1.6)');
      this.el.classList.add('lg-nofilter');
    }
    this.cost = performance.now() - t0;
  };
}

const instances: LiquidGlass[] = [];
/** 所有已挂载实例（探针/调试用） */
export const glassInstances = instances;

interface GlassEl extends HTMLElement {
  __lg?: LiquidGlass;
}

let observer: ResizeObserver | null = null;

/** 扫描 root 下所有尚未初始化的 .lg 元素并逐个建立折射滤镜 */
export function initLiquidGlass(root?: ParentNode): void {
  if (typeof document === 'undefined') return;
  const scope: ParentNode = root ?? document;
  scope.querySelectorAll<GlassEl>('.lg').forEach((el) => {
    if (el.__lg) return;
    const o: GlassOptions = {};
    (el.dataset.lg || '')
      .split(/\s+/)
      .forEach((kv) => {
        const m = kv.split('=');
        if (m.length === 2) {
          const v = parseFloat(m[1]);
          if (!Number.isNaN(v)) (o as Record<string, number>)[m[0]] = v;
        }
      });
    const inst = new LiquidGlass(el, o);
    el.__lg = inst;
    instances.push(inst);
    inst.measure();
    if (!observer) {
      observer = new ResizeObserver(() => instances.forEach((i) => i.measure()));
    }
    observer.observe(el);
  });
}
