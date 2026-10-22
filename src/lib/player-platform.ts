/**
 * 播放器的平台判定：Apple 触屏设备的原生全屏入口。
 *
 * 从 player-shell.tsx 抽出来的原因：这几段是纯粹的 UA / 接口探测，
 * 与 React 生命周期无关，留在播放器组件里既不好单测也不好复用。
 */

/**
 * 是否 Apple 触屏设备（iPhone / iPad / iPadOS 桌面 UA）。
 *
 * iPadOS 13+ 的 Safari 默认按桌面 UA 上报（"Macintosh"），所以除了 iPhone/iPad/iPod 的 UA，
 * 还要认「Mac 型 UA + 多点触控」。注意**不能**再并 Artplayer.utils.isSafari 兜底：
 * 那不是设备判断而是浏览器判断，桌面 Mac Safari 会被误判成 iPad，
 * 全屏按钮就被改道去调 webkitEnterFullscreen —— 那正是「点了全屏没反应」的来源。
 */
export const isAppleTouchDevice = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  return isAppleTouchUA(navigator.userAgent, navigator.maxTouchPoints);
};

/** 抽出来便于单测/日志：UA 判定本身不依赖运行环境 */
export function isAppleTouchUA(ua: string, maxTouchPoints: number): boolean {
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  // iPadOS 桌面 UA：Macintosh + 多点触控（桌面 Mac 的触控板 maxTouchPoints 为 0）
  return /\bMacintosh\b/.test(ua) && maxTouchPoints > 1;
}

/**
 * 设备是否真的提供原生（系统播放器）全屏入口。
 *
 * 只认 webkitEnterFullscreen —— 这是 iOS/iPadOS 的专属接口，真正把视频交给系统播放器。
 * webkitEnterFullScreen（大写 S）是老 Android / 部分浏览器外壳的别名，效果只是把 <video> 撑满页面，
 * 也就是用户说的「还是网页播放器」，所以不再算数；没有这个接口时落回 Fullscreen API。
 */
export const canUseNativeFullscreen = (video?: HTMLVideoElement): boolean => {
  if (!video) return false;
  const v = video as HTMLVideoElement & { webkitEnterFullscreen?: () => void };
  return typeof v.webkitEnterFullscreen === 'function';
};

/**
 * 把 <video> 交给系统播放器（iOS/iPadOS 的 HTMLVideoElement.webkitEnterFullscreen）。
 *
 * iOS/iPadOS 上真正能「投到系统播放器 / 画中画 / 屏幕旋转」的是原生全屏，
 * 而 Fullscreen API + playsinline 只会把容器撑满网页，看起来像全屏、实际仍是网页播放器。
 * 代价是原生全屏期间 Artplayer 的控件、上下集与广告过滤都会失效，所以只在 Apple 触屏设备上走这条路。
 */
export function enterNativeFullscreen(video?: HTMLVideoElement): void {
  if (!video) return;
  const v = video as HTMLVideoElement & {
    webkitEnterFullscreen?: () => void;
    webkitDisplayingFullscreen?: boolean;
  };
  /*
   * 不暂停、不调 play()。
   * 以前这里先 pause()、出场后 play()，在 iOS 上正是「点了全屏没反应」的元凶：
   * 原生全屏进入中一旦暂停，系统播放器可能直接停在待播态甚至不拉起；
   * 而退出时用 JS 调 play() 又会被移动端的「必须由用户手势触发」规则拦掉。
   * 让播放连续走，系统播放器接管后自己会接着播。
   */
  try {
    v.webkitEnterFullscreen?.();
  } catch {
    /* 个别浏览器外壳会直接抛错，交给调用方的兜底分支 */
  }
}
