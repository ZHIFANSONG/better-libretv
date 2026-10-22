/**
 * 系统媒体会话（Media Session API）：
 * 让 Windows 媒体浮层、锁屏、蓝牙耳机、车机看到「正在播什么」并能控制播放。
 *
 * 浏览器里这套 API 全是「有没有都不报错」的风格：不支持时 navigator.mediaSession 是 undefined，
 * setPositionState 在 duration 非法（NaN / Infinity / 0）时会抛 TypeError。
 * 所以这里每个出口都做能力检测 + try/catch —— 媒体会话是锦上添花，
 * 绝不能因为它把播放器主流程搞崩。
 */

export interface MediaSessionTrack {
  title: string;
  /** 副标题：本站放采集源名（观众切换来源时能看出区别） */
  artist?: string;
  album?: string;
  /** 封面：锁屏/浮层里的专辑图 */
  posterUrl?: string;
}

export interface MediaSessionHandlers {
  play?: () => void;
  pause?: () => void;
  seekTo?: (time: number) => void;
  seekBy?: (offset: number) => void;
  prev?: () => void;
  next?: () => void;
  stop?: () => void;
}

/** 有些桌面浏览器暴露了 mediaSession 但没有任何后端（不显示浮层），能力检测只做存在性判断 */
export function mediaSessionSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaSession;
}

function artworkFor(posterUrl?: string): MediaMetadataInit['artwork'] {
  if (!posterUrl) return [];
  // 三种尺寸给系统挑：不写 sizes 时部分系统会挑到最小的那张当锁屏大图，糊成一片
  return [
    { src: posterUrl, sizes: '512x512', type: 'image/jpeg' },
    { src: posterUrl, sizes: '256x256', type: 'image/jpeg' },
    { src: posterUrl, sizes: '128x128', type: 'image/jpeg' },
  ];
}

export function setMediaSessionMetadata(track: MediaSessionTrack): void {
  if (!mediaSessionSupported() || typeof MediaMetadata === 'undefined') return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist || '',
      album: track.album || 'LibreTV',
      artwork: artworkFor(track.posterUrl),
    });
  } catch { /* 忽略：元数据只是展示层 */ }
}

/**
 * 挂动作处理器。
 * 传 undefined 的动作会被显式解绑（setActionHandler(action, null)），
 * 这样「没有上一集」时系统面板里不会出现一个点了没反应的按钮。
 */
export function bindMediaSessionHandlers(handlers: MediaSessionHandlers): void {
  if (!mediaSessionSupported()) return;
  const bind = (action: MediaSessionAction, handler: (() => void) | undefined) => {
    try { navigator.mediaSession.setActionHandler(action, handler ?? null); } catch { /* 忽略 */ }
  };
  bind('play', handlers.play);
  bind('pause', handlers.pause);
  bind('stop', handlers.stop);
  bind('seekbackward', handlers.seekBy ? () => handlers.seekBy?.(-10) : undefined);
  bind('seekforward', handlers.seekBy ? () => handlers.seekBy?.(10) : undefined);
  // seekto 的 handler 需要读到 MediaSessionActionDetails.seekTime，只能单独注册（bind 的签名不带参数）
  try {
    navigator.mediaSession.setActionHandler('seekto', handlers.seekTo
      ? (details) => { if (typeof details.seekTime === 'number') handlers.seekTo?.(details.seekTime); }
      : null);
  } catch { /* 忽略 */ }
  bind('previoustrack', handlers.prev);
  bind('nexttrack', handlers.next);
}

export interface MediaSessionState {
  position: number;
  duration: number;
  playbackRate?: number;
  paused?: boolean;
}

export function setMediaSessionState(state: MediaSessionState): void {
  if (!mediaSessionSupported()) return;
  try { navigator.mediaSession.playbackState = state.paused ? 'paused' : 'playing'; } catch { /* 忽略 */ }
  const { position, duration } = state;
  // 位置状态要求 duration 是有限正数且 position <= duration，
  // 否则 Chrome 抛 TypeError；直播（Infinity）与元数据未就绪（NaN）都直接跳过
  if (!Number.isFinite(duration) || duration <= 0) return;
  if (!Number.isFinite(position) || position < 0) return;
  const rate = state.playbackRate && state.playbackRate > 0 ? state.playbackRate : 1;
  try {
    navigator.mediaSession.setPositionState({
      duration,
      position: Math.min(position, duration),
      playbackRate: rate,
    });
  } catch { /* 忽略 */ }
}

export function clearMediaSession(): void {
  if (!mediaSessionSupported()) return;
  const actions: MediaSessionAction[] = [
    'play', 'pause', 'stop', 'seekbackward', 'seekforward', 'seekto', 'previoustrack', 'nexttrack',
  ];
  for (const action of actions) {
    try { navigator.mediaSession.setActionHandler(action, null); } catch { /* 忽略 */ }
  }
  try { navigator.mediaSession.metadata = null; } catch { /* 忽略 */ }
  try { navigator.mediaSession.playbackState = 'none'; } catch { /* 忽略 */ }
}
