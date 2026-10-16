/**
 * glassium 是属性驱动的：\`<div glass>\`、\`glass="tinted"\`、\`glass-blur="20"\`、
 * \`glass-jelly\`、\`overlay\`。React 会把这些未知属性原样写到 DOM 上（19 起不再过滤），
 * 但 TypeScript 的 JSX 类型不认识它们 —— 这里补齐，免得每个用到的地方都 as any。
 *
 * 注意：布尔属性要写值的字符串形式（\`glass-jelly=""\`）。React 把 \`glass-jelly={true}\` 渲染成
 * \`glass-jelly="true"\`，glassium 判的是「不是 'false' 就算开」，所以两者都能用。
 */
declare module 'react' {
  interface HTMLAttributes<T> {
    /** 写在这个元素上就是一块玻璃；值是预设名（default / clear / tinted / frosted）。 */
    glass?: string;
    /** 盖在 DOM 内容上的玻璃（下拉、弹窗）：改用 CSS 的 backdrop-filter 画，不上 GPU 场景。 */
    overlay?: string;
    'glass-blur'?: string;
    'glass-refraction'?: string;
    'glass-distortion'?: string;
    'glass-highlight'?: string;
    'glass-dispersion'?: string;
    'glass-saturation'?: string;
    'glass-tint'?: string;
    'glass-opacity'?: string;
    'glass-corner-radius'?: string;
    'glass-squircle'?: string;
    'glass-depth-effect'?: string;
    'glass-adaptive'?: string;
    'glass-shadow'?: string;
    'glass-magnify'?: string;
    'glass-body-light'?: string;
    /** 元素移动时玻璃顺着速度拉长。 */
    'glass-jelly'?: string;
    /** 元素跳到别处时玻璃飞过去（顶栏选中气泡靠它）。 */
    'glass-glide'?: string;
    /** 0–1 或 auto：这一块固定质量档。 */
    'glass-quality'?: string;
  }
}

export {};
