'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Artplayer from 'artplayer';
import Hls, { type HlsConfig } from 'hls.js';

import { PlaybackRecovery, describeHlsError } from '@/lib/playback-recovery';
import { createHlsLoader } from '@/lib/hls-loader';
import { formatTime } from '@/lib/utils';
import { qualityLabel } from '@/lib/quality';
import { copyToClipboard } from '@/lib/clipboard';
import { clearSegmentTimings, takeSegmentTiming } from '@/lib/segment-timing';
import {
  bufferedAheadOf,
  buildStatsGroups,
  fragmentSpeedSample,
  networkInput,
  pushSpeedSample,
  statsToText,
  summarizeSpeedSamples,
  type NetworkInformationLike,
  type PlaybackStatsInput,
  type SpeedSample,
  type StatsGroup,
} from '@/lib/playback-stats';

/**
 * 控制栏「视频信息」按钮图标：圆圈 + 竖线 + 点。
 * 每个图形都写死自己的 fill/stroke，避免被 Artplayer 的
 * `.art-video-player svg{fill:var(--art-font-color)}` 灌成实心圆。
 */
const VSTATS_ICON = [
  '<svg viewBox="0 0 22 22" width="22" height="22" xmlns="http://www.w3.org/2000/svg">',
  '<circle cx="11" cy="11" r="8.4" fill="none" stroke="currentColor" stroke-width="1.7"/>',
  '<path d="M11 10.1v5.2" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
  '<circle cx="11" cy="6.9" r="1.05" fill="currentColor" stroke="none"/>',
  '</svg>',
].join('');

/**
 * 播放器外壳：ArtPlayer + hls.js（旧版 player.js 的 React 化）。
 * 保留：广告分片过滤、自动连播回调、进度回调、快捷键、移动端长按倍速、错误恢复。
 * 移除：DOM 手工操作、watch.html 跳转链、localStorage 状态总线。
 *
 * 关键设计：ArtPlayer 实例只在挂载时创建一次，换集（url 变化）只「切换 HLS 源」
 * 而不销毁重建。否则在「网页全屏（页面全屏）」下整实例重建会丢失全屏上下文、
 * 重建 <video> 元素，触发「黑屏有声」的渲染竞态。
 */

interface PlayerShellProps {
  url: string;
  title: string;
  adFilter: boolean;
  autoplayNext: boolean;
  /** 进度恢复：优先 URL position，其次查询该回调（返回 0 表示无记录） */
  getRestorePosition?: () => number | Promise<number>;
  onTimeUpdate?: (position: number, duration: number) => void;
  onEnded?: () => void;
  onPause?: (position: number, duration: number) => void;
  /**
   * 实测画质（视频高度，像素；宽度可选）。
   * 单码率 m3u8 / 直链的分辨率只能等解码后才知道，播放一次后回写缓存，
   * 下次搜索同一部剧就能直接显示画质，不必再探测。
   * 宽度用于识别裁切过的宽银幕 4K（3840×1608 只靠高度会被判成 2K）。
   */
  onQuality?: (height: number, width?: number) => void;
  /** 恢复策略判源不可用（重试耗尽/格式硬失败）时回调：父级弹出换源面板 */
  onRequestSwitchSource?: (reason: string) => void;
  /**
   * 片头跳过秒数（0 = 不跳）。由父级按「本剧配置 → 全局默认」解析后传入：
   * 播放器不关心秒数从哪来，只负责在起播后跳到这个位置。
   */
  introSec?: number;
  /**
   * 片尾跳过秒数（0 = 不跳）：播到 duration - outroSec 就当作本集结束。
   * 由父级决定这是「真的播完」还是「提前跳片尾」——handleEnded 会把位置一起带出去。
   */
  outroSec?: number;
  /** 用户点了「撤销」把片头退回去：父级可借此把本剧片头秒数清掉，下次不再跳 */
  onUndoIntro?: () => void;
}

/**
 * 是否 Apple 触屏设备（iPhone / iPad / iPadOS 桌面 UA）。
 *
 * iPadOS 13+ 的 Safari 默认按桌面 UA 上报（"Macintosh"），所以除了 iPhone/iPad/iPod 的 UA，
 * 还要认「Mac 型 UA + 多点触控」。注意**不能**再并 Artplayer.utils.isSafari 兜底：
 * 那不是设备判断而是浏览器判断，桌面 Mac Safari 会被误判成 iPad，
 * 全屏按钮就被改道去调 webkitEnterFullscreen —— 那正是「点了全屏没反应」的来源。
 */
const isAppleTouchDevice = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  return isAppleTouchUA(navigator.userAgent, navigator.maxTouchPoints);
};

/** 抽出来便于单测/日志：UA 判定本身不依赖运行环境 */
function isAppleTouchUA(ua: string, maxTouchPoints: number): boolean {
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
const canUseNativeFullscreen = (video?: HTMLVideoElement): boolean => {
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
function enterNativeFullscreen(video?: HTMLVideoElement) {
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

export function PlayerShell({
  url,
  title,
  adFilter,
  autoplayNext,
  getRestorePosition,
  onTimeUpdate,
  onEnded,
  onPause,
  onQuality,
  onRequestSwitchSource,
  introSec = 0,
  outroSec = 0,
  onUndoIntro,
}: PlayerShellProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const artRef = useRef<any>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [error, setError] = useState('');
  const [hint, setHint] = useState('');
  // 片头跳过后的撤销入口倒计时（秒）；>0 时显示「已跳过片头 Ns / 撤销」
  const [undoIntroSec, setUndoIntroSec] = useState(0);
  // 起播前的品牌占位图（沿用旧版 nomedia 素材），实际开始播放后隐藏
  const [showPoster, setShowPoster] = useState(true);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const undoIntroTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 始终持有最新 props/回调，避免重建播放器
  const propsRef = useRef({
    url, title, adFilter, autoplayNext,
    getRestorePosition, onTimeUpdate, onEnded, onPause, onQuality, onRequestSwitchSource,
    introSec, outroSec, onUndoIntro,
  });
  propsRef.current = {
    url, title, adFilter, autoplayNext,
    getRestorePosition, onTimeUpdate, onEnded, onPause, onQuality, onRequestSwitchSource,
    introSec, outroSec, onUndoIntro,
  };

  /** 上报实测画质：多次上报取大值由调用方决定，这里只管把拿到的分辨率传出去 */
  const reportQuality = (height: number, width?: number) => {
    if (height > 0) propsRef.current.onQuality?.(height, width && width > 0 ? width : undefined);
  };

  // 跨集共享、每次换集重置的播放链路状态
  // 媒体健康度：音频轨可播不代表视频轨正常（「黑屏但有声」的假死态）。
  // 仅当有分片真正进入 MSE buffer 后才视为恢复，错误遮罩才能被清除。
  const mediaHealthyRef = useRef(true);
  const playbackStartedRef = useRef(false);
  // 起播阶段的 video 元素级错误允许自愈重试一次（重建 hls/MSE）
  const videoErrorRetryUsedRef = useRef(false);
  // 进度恢复每集只执行一次（MANIFEST_PARSED 可能因代理回退再次触发）
  const restoredRef = useRef(false);
  // 「等时长就绪再恢复」挂在 video 上的监听清理函数：
  // 换集 / 代理回退重建 hls / 卸载时必须摘掉，否则旧监听会在新一集上误恢复进度
  const restoreCleanupRef = useRef<(() => void) | null>(null);
  // setupHls 可能改走代理形式，video:error 重试要用最近一次的地址
  const currentMediaUrlRef = useRef(url);
  // 本集的恢复策略实例：跨直连/代理两级重建共享计数
  const recoveryRef = useRef<PlaybackRecovery | null>(null);
  // 自然播完标记，卸载时不回写进度（避免覆盖「已看完」记录）
  const endedRef = useRef(false);
  // 片头只跳一次：恢复进度、用户手动 seek 回来都不再触发
  const introSkippedRef = useRef(false);
  // 片尾只触发一次：提前跳后 timeupdate 还会继续来，必须挡住
  const outroFiredRef = useRef(false);

  // 是否走原生全屏：Apple 触屏设备（iPhone / iPad / iPadOS 桌面 UA）才需要，
  // 桌面端保持 Artplayer 自带的元素全屏，行为不变
  const isAppleTouch = isAppleTouchDevice();

  const showHint = (text: string) => {
    setHint(text);
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    hintTimerRef.current = setTimeout(() => setHint(''), 2500);
  };

  /**
   * hls.js 配置。
   *
   * 缓冲上限刻意压得保守（30s / 60s / 30MB）：曾经为了配合片段预取器把它抬到
   * 120s / 600s / 90MB，结果是长剧集上 MSE 里堆着几十秒乃至几分钟的分片，
   * 手机端内存与解码压力陡增，表现就是发烫、卡顿。预取器已整块移除，
   * 这里也不再需要为它留余量。
   */
  const buildHlsConfig = (): Partial<HlsConfig> => {
    const p = propsRef.current;
    return {
      debug: false,
      enableWorker: true,
      backBufferLength: 90,
      maxBufferLength: 30,
      maxMaxBufferLength: 60,
      maxBufferSize: 30 * 1000 * 1000,
      maxBufferHole: 0.5,
      fragLoadingMaxRetry: 6,
      fragLoadingRetryDelay: 1000,
      manifestLoadingMaxRetry: 3,
      manifestLoadingRetryDelay: 1000,
      startLevel: -1,
      abrEwmaDefaultEstimate: 500_000,
      appendErrorMaxRetry: 5,
      // 组合 loader：只做广告过滤（blockAd 随设置）与分片计时，不碰任何本地存储
      loader: createHlsLoader(Hls, { blockAd: p.adFilter }) as unknown as HlsConfig['loader'],
    };
  };

  /**
   * —— 控制栏「视频信息」面板 ——
   *
   * 用户诉求：播放时能直接看到码率/帧率/分辨率/网络状况，而不是只有一个「几 P」。
   * 面板内容是纯计算（见 src/lib/playback-stats.ts），这里只负责取数、渲染与定时刷新。
   *
   * 为什么不用 Artplayer 自带的 art.info：它的行标题是写死的英文 i18n key，
   * 也塞不进分组、复制和小字注解；版式我们可以直接照搬（右上角浮层）。
   */
  const [statsOpen, setStatsOpen] = useState(false);
  const [statsRows, setStatsRows] = useState<StatsGroup[]>([]);
  const [statsCopied, setStatsCopied] = useState(false);
  // 帧率采样基线：{ 上一次采样时刻, 累计出帧数 }。帧率只能靠两次采样的差值算，
  // 所以基线要和面板同生共死——面板关掉就清空，免得隔了十分钟还在拿旧差值当帧率。
  const statsFrameRef = useRef<{ at: number; total: number } | null>(null);
  /*
   * 分片吞吐采样窗口（最近 6 个主视频分片的实测速度与首字节时延）。
   *
   * 为什么不直接用 navigator.connection.downlink：那是「有效带宽档」，
   * Chrome 对所有宽带都报同一档，实测面板写 1.4 Mbps 而同刻分片真实吞吐 22.7 Mbps。
   * 分片的字节数与传输耗时是 hls.js 自己量的，这才是这条流真实跑多快。
   * 窗口跨集保留：选集时网络不会变，没必要清空重新攒样本。
   */
  const speedSamplesRef = useRef<SpeedSample[]>([]);
  // 控件在「创建播放器」那个只跑一次的 effect 里注册，闭包会永远停在首帧的 statsOpen，
  // 所以点击回调必须走 ref 转一手，才能拿到最新的 toggleStats。
  const toggleStatsRef = useRef<() => void>(() => {});
  /*
   * portal 目标必须在客户端渲染阶段才能确定（art.template.$player 是 Artplayer 建出来的）。
   * 用 state 而不是直接读 ref：ref 变化不触发重渲染，面板打开后关掉播放器重建会指向旧节点。
   */
  const [statsPortalEl, setStatsPortalEl] = useState<HTMLElement | null>(null);

  /**
   * —— 控制栏画质菜单 ——
   *
   * 画质信息只在 m3u8 内部，用户原来在播放器上完全看不到「现在放的是几 P」，
   * 也没法在多码率源里手动锁档（ABR 只会按带宽自动挑，网络一抖就掉到 360P 且不再升）。
   *
   * 做法：读 hls.levels 的档位表，渲染成右上角一个按钮 + 下拉。
   * 之所以不用 Artplayer 的 setting 面板：那是「设置 > 二级面板」，要看画质得点两下，
   * 而画质是播放时最常切的东西；也不用 art.quality —— 它靠换 URL 切档，
   * 对同一条 master playlist 只会重新 loadSource，等于重开一集（进度、缓冲全丢）。
   * 这里直接写 hls.currentLevel，在同一个 MediaSource 内切档，画面不断。
   *
   * 档位表在 MANIFEST_PARSED 之前是空的，所以由 setupHls 主动调 refreshQualityMenu()，
   * 单码率源永远只有 1 档 —— 那种情况直接把菜单藏起来，不给用户点一个没得选的按钮。
   */
  const qualityMenuRef = useRef<{
    root: HTMLDivElement;
    button: HTMLButtonElement;
    list: HTMLDivElement;
    key: string;
  } | null>(null);
  const qualityMenuDocHandlerRef = useRef<((e: MouseEvent) => void) | null>(null);

  /**
   * 采样一次播放统计。任何一项取不到都不抛出——面板宁可少一行，也不能因为
   * 某个浏览器没有 getVideoPlaybackQuality 就整块不显示。
   *
   * 帧率的取法：清单里没写 FRAME-RATE（采集站常态）时，用「两次采样之间实际出了多少帧」
   * 反推。单次 getVideoPlaybackQuality 只有累计值，没有时间基线就算不出速率，
   * 所以第一次采样只记基线，第二次起才有「实测帧率」这一行。
   */
  const collectStats = (): StatsGroup[] => {
    const art = artRef.current;
    const video = art?.video as HTMLVideoElement | undefined;
    if (!video) return [];

    let droppedFrames: number | undefined;
    let totalFrames: number | undefined;
    try {
      const quality = video.getVideoPlaybackQuality?.();
      if (quality) {
        droppedFrames = quality.droppedVideoFrames;
        totalFrames = quality.totalVideoFrames;
      }
    } catch { /* 个别浏览器抛错：丢帧行隐藏即可，不影响其它行 */ }

    let frameRateMeasured: number | undefined;
    if (Number.isFinite(totalFrames)) {
      const total = totalFrames as number;
      const now = performance.now();
      const prev = statsFrameRef.current;
      if (prev && now - prev.at > 500 && total > prev.total) {
        const fps = ((total - prev.total) * 1000) / (now - prev.at);
        // 采样窗口太短时抖动极大（可能算到 120fps），限幅到 1~120 之外视为噪声丢弃
        if (fps >= 1 && fps <= 120) frameRateMeasured = fps;
      }
      statsFrameRef.current = { at: now, total };
    }

    const hls = hlsRef.current;
    const levels = hls?.levels ?? [];
    const index = hls ? hls.currentLevel : -1;
    const level = index >= 0 ? levels[index] : undefined;

    const connection = (navigator as unknown as { connection?: NetworkInformationLike }).connection;
    const speed = summarizeSpeedSamples(speedSamplesRef.current);
    const input: PlaybackStatsInput = {
      // 有实测分片时用它，没有才让浏览器档位兜底（buildNetworkRows 内部判断）
      measuredSpeedBps: speed.speedBps,
      measuredTtfbMs: speed.ttfbMs,
      speedSampleCount: speed.count,
      width: video.videoWidth,
      height: video.videoHeight,
      duration: video.duration,
      currentTime: video.currentTime,
      bufferedAhead: bufferedAheadOf(video),
      droppedFrames,
      totalFrames,
      frameRateMeasured,
      ...networkInput(connection),
    };
    if (level) {
      input.level = {
        levelIndex: index,
        levelCount: levels.length,
        bitrate: level.bitrate,
        // realBitrate 是「该档实际放了多少字节 / 多少秒」，0 表示还没测到，退回带宽估算
        measuredBitrate: level.realBitrate > 0 ? level.realBitrate : hls?.bandwidthEstimate,
        width: level.width,
        height: level.height,
        frameRate: level.frameRate,
        videoCodec: level.videoCodec,
        audioCodec: level.audioCodec,
      };
    }
    return buildStatsGroups(input);
  };

  const toggleStats = () => {
    // 基线每次开关都重置：重新打开时要从「这一刻」重新算帧率，
    // 否则会拿面板关闭前那半分钟的总帧数差当分子，算出一个毫无意义的数
    statsFrameRef.current = null;
    if (statsOpen) {
      setStatsOpen(false);
      return;
    }
    setStatsRows(collectStats());
    setStatsOpen(true);
  };

  toggleStatsRef.current = toggleStats;

  const copyStats = async () => {
    const text = statsToText(statsRows, propsRef.current.title);
    const ok = await copyToClipboard(text);
    showHint(ok ? '视频信息已复制' : '复制失败，请手动选择文本');
    if (ok) {
      setStatsCopied(true);
      setTimeout(() => setStatsCopied(false), 1500);
    }
  };

  const closeQualityMenu = () => {
    const menu = qualityMenuRef.current;
    if (!menu) return;
    menu.list.style.display = 'none';
    menu.root.classList.remove('open');
  };

  /*
   * 面板打开期间每 800ms 重采一次：缓冲余量/带宽/丢帧都是持续变化的，
   * 一次性快照看到的是「点开那一刻」的数，用户盯着的却是实时状态。
   * 暂停时不刷新（数据不会变，省掉无意义的 setState）。
   */
  useEffect(() => {
    if (!statsOpen) return;
    const timer = setInterval(() => {
      const art = artRef.current;
      if (!art || art.video?.paused) return;
      setStatsRows(collectStats());
    }, 800);
    return () => clearInterval(timer);
  }, [statsOpen]);

  const refreshQualityMenu = () => {
    const hls = hlsRef.current;
    const art = artRef.current;
    if (!hls || !art) return;
    const $player = art.template?.$player as HTMLElement | undefined;
    if (!$player) return;

    // 单码率源的清单里没写 RESOLUTION，level.width / level.height 都是 0，
    // 此时按 level 下标降级显示，而不是编一个「0P」出来
    const levels = hls.levels ?? [];
    const options = levels.map((level, index) => {
      const label = qualityLabel(level.height, level.width);
      return {
        index,
        label: label || `档位 ${index + 1}`,
        bitrate: level.bitrate,
      };
    });

    // 清单还没解析出档位时（hls 刚创建）不留空胶囊，等 MANIFEST_PARSED 再来
    if (options.length === 0) {
      const menu = qualityMenuRef.current;
      if (menu) {
        menu.root.remove();
        qualityMenuRef.current = null;
      }
      return;
    }

    // manualLevel === -1 才是「自动」；currentLevel 只是当前在播档位，两者不能混用
    const manual = hls.manualLevel;
    const currentLevel = hls.currentLevel;
    // 解码后的真实分辨率：单码率源的清单里没有档位，这是唯一可信的画质来源。
    // 判档以宽度为准（1920×752 是 1080P 而不是 720P），所以 width 一定要带上。
    const playing = art.video?.videoHeight ?? 0;
    const playingWidth = art.video?.videoWidth ?? 0;
    const playingLabel = qualityLabel(playing, playingWidth) || (playing > 0 ? `${playing}P` : '');
    /*
     * 档位数 < 2 不再把整个菜单摘掉。
     *
     * 采集站几乎全是单码率（一部片一条 m3u8），按「没得选就别显示」的做法，
     * 真实内容上这个胶囊永远不会出现——用户的原话就是「现在的播放完全不知道是什么画质」。
     * 所以拆成两种形态：多档 = 可切的下拉；单档 = 只读胶囊，把实测档位直接写在脸上，
     * 点一下说明为什么切不了（而不是给一个点不动的灰按钮）。
     */
    const single = options.length < 2;
    const key = single
      ? `single|${playing}|${playingWidth}|${options.map((o) => o.label).join(',')}`
      : `${manual}|${currentLevel}|${playing}|${playingWidth}|${options.map((o) => o.label).join(',')}`;
    let menu = qualityMenuRef.current;
    if (menu && menu.key === key && menu.root.isConnected) return;

    if (!menu) {
      const root = document.createElement('div');
      root.className = 'g-qmenu';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'g-qmenu-btn';
      const list = document.createElement('div');
      list.className = 'g-qmenu-list';
      list.style.display = 'none';
      /*
       * 控制栏点击会冒泡到播放器画面，触发 Artplayer 的「点画面暂停/播放」。
       * 这里统一拦掉，否则点一下「画质」就把视频暂停了。
       */
      const swallow = (e: Event) => e.stopPropagation();
      root.addEventListener('click', swallow);
      root.addEventListener('mousedown', swallow);
      root.addEventListener('dblclick', swallow);

      button.addEventListener('click', (e) => {
        e.stopPropagation();
        // 单档源（采集站常态）没有可切的东西：点一下给个解释，比弹出一个只有一项的列表实在
        if (root.classList.contains('single')) {
          showHint(`本片源只有 ${button.textContent} 一档清晰度`);
          return;
        }
        const open = list.style.display !== 'none';
        if (open) {
          closeQualityMenu();
        } else {
          list.style.display = '';
          root.classList.add('open');
        }
      });
      // 点面板外收起。监听挂在 document 上，卸载时摘掉（见下方 useEffect）
      const onDocClick = (e: MouseEvent) => {
        if (!root.contains(e.target as Node)) closeQualityMenu();
      };
      qualityMenuDocHandlerRef.current = onDocClick;
      document.addEventListener('click', onDocClick);

      root.appendChild(button);
      root.appendChild(list);
      $player.appendChild(root);
      menu = { root, button, list, key: '' };
      qualityMenuRef.current = menu;
    }

    menu.key = key;
    // 按钮上直接写当前画质：正常情况下用户不需要展开菜单就已经知道自己在看几 P
    const active = manual >= 0 ? options.find((o) => o.index === manual) : undefined;
    const headline =
      (single ? playingLabel : active?.label ?? playingLabel) ||
      (single ? options[0]?.label : '') ||
      '';
    menu.root.classList.toggle('single', single);
    menu.button.textContent = single
      ? headline || '画质未知'
      : manual < 0
        ? `自动${headline ? ` · ${headline}` : ''}`
        : headline || '画质';
    menu.button.title = single ? '本片源只有一档清晰度，无法切换' : '切换清晰度';
    // 单档时不展开下拉：列表里只有一个和按钮重复的档位，点开纯属浪费一次点击
    if (single) {
      menu.list.textContent = '';
      menu.list.style.display = 'none';
      menu.root.classList.remove('open');
      menu.list.style.pointerEvents = 'none';
      return;
    }
    menu.list.style.pointerEvents = '';

    menu.list.textContent = '';
    const makeItem = (label: string, active: boolean, onPick: () => void, hint?: string) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = active ? 'g-qmenu-item on' : 'g-qmenu-item';
      item.textContent = label;
      if (hint) {
        const em = document.createElement('em');
        em.textContent = hint;
        item.appendChild(em);
      }
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        onPick();
        closeQualityMenu();
      });
      menu!.list.appendChild(item);
    };

    makeItem('自动', manual < 0, () => {
      const self = hlsRef.current;
      if (!self) return;
      // 回到自动之前先放开手动限制，否则 hls 会继续锁在 currentLevel 上
      self.currentLevel = -1;
      self.nextLevel = -1;
      refreshQualityMenu();
    });
    options.forEach((o) => {
      makeItem(o.label, manual === o.index, () => {
        const self = hlsRef.current;
        if (!self) return;
        self.currentLevel = o.index;
        showHint(`已切换到 ${o.label}`);
        refreshQualityMenu();
      });
    });
  };

  /**
   * 初始化/切换 HLS。allowProxyFallback：直连致命网络错误（CORS/防盗链/分片被拒）时，
   * 自动改走同源 cookie 鉴权的 /api/proxy 重试一次。
   * 注意：不销毁 ArtPlayer，只销毁并重建 hls，从而保留网页全屏等播放器状态。
   */
  const setupHls = (video: HTMLVideoElement, mediaUrl: string, allowProxyFallback: boolean) => {
    // 上一次 setupHls 挂在 video 上的「等时长就绪」监听必须摘掉：
    // 代理回退会重建 hls，旧监听若留着会和新的一起抢着重置进度
    restoreCleanupRef.current?.();
    restoreCleanupRef.current = null;
    hlsRef.current?.destroy();
    currentMediaUrlRef.current = mediaUrl;
    const hls = new Hls(buildHlsConfig());
    hlsRef.current = hls;

    /**
     * 进度恢复 + 起播。
     *
     * 关键在于「什么时候算可以恢复」：MANIFEST_PARSED 只说明 m3u8 解析完了，
     * 很多 HLS 源此时 duration 仍是 0（尤其代理回退后重建的那一次），
     * 拿不到时长就没法判断「保存的进度是不是已经接近片尾」，
     * 旧实现会当场把 restoredRef 置位并放弃——刷新页面后进度静默丢失。
     * 所以时长无效时不消费这次机会，挂到 loadedmetadata/durationchange/canplay 上重试。
     */
    let restoreInFlight = false;
    const restoreAndStart = async () => {
      if (restoredRef.current || restoreInFlight) return;

      const duration = artRef.current?.duration || video.duration || 0;
      if (!Number.isFinite(duration) || duration <= 0) return;

      restoreInFlight = true;
      try {
        const saved = (await propsRef.current.getRestorePosition?.()) ?? 0;
        const currentDuration = artRef.current?.duration || video.duration || duration;
        if (saved > 10 && Number.isFinite(currentDuration) && saved < currentDuration - 2) {
          if (artRef.current) artRef.current.currentTime = saved;
          showHint(`已从 ${formatTime(saved)} 继续播放`);
        }
        restoredRef.current = true;
        restoreCleanupRef.current?.();
        restoreCleanupRef.current = null;
        video.play().catch(() => {});
      } catch {
        // IndexedDB 读取失败不阻塞播放：restoredRef 不置位，后续事件还能再试
      } finally {
        restoreInFlight = false;
      }
    };

    const restoreEvents = ['loadedmetadata', 'durationchange', 'canplay'] as const;
    const onRestoreEvent = () => { void restoreAndStart(); };
    restoreEvents.forEach((event) => video.addEventListener(event, onRestoreEvent));
    restoreCleanupRef.current = () => {
      restoreEvents.forEach((event) => video.removeEventListener(event, onRestoreEvent));
    };

    hls.loadSource(mediaUrl);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      recoveryRef.current?.markHealthy();
      // master playlist 的档位高度：多码率源在这里就能拿到上限。
      // 「挑最高档」仍按高度比较：BANDWIDTH 反推的档位没有 width（0），
      // 混进宽度比较会把它当成最矮的一档。判档由 qualityLabel 按宽度做，两者分工不同。
      const rated = hls.levels.filter((level) => typeof level.height === 'number' && level.height > 0);
      if (rated.length > 0) {
        const top = rated.reduce((a, b) => (b.height > a.height ? b : a));
        reportQuality(top.height, top.width);
      }
      // 档位表就绪后立刻刷新控制栏画质菜单（单码率源在这里只有 1 档，菜单就不出现）
      void refreshQualityMenu();
      void restoreAndStart();
    });
    // 播放链路恢复（FRAG_LOADED / MANIFEST_PARSED）：静默窗外清零连续失败计数
    hls.on(Hls.Events.FRAG_LOADED, (_evt, data) => {
      recoveryRef.current?.markHealthy();
      /*
       * 顺手采一个吞吐样本（面板「实时下载」的数据来源）。
       *
       * 时刻不从 data.frag.stats 读：hls.js 在 onSuccess 里就 resetLoader() → loader.destroy()，
       * 而 BaseLoader.destroy() 会把 stats 置成 null，等这条事件回调执行时已经是空的。
       * 所以时刻由自定义 loader 落在 segment-timing 里，这里按分片 URL 取（取走即删，一片只算一次样本）。
       *
       * 只算主视频分片——音频分片只有几十 KB，混进来会把中位数拉得毫无意义。
       */
      const frag = data.frag;
      if (frag?.type && frag.type !== 'main') return;
      // frag.url 在 hls.js 的 resetLoader 里会被置空，relurl 兜一层（两个都绝对化后再比对）
      const fragUrl = frag?.url || frag?.relurl;
      if (!fragUrl) return;
      const timing = takeSegmentTiming(fragUrl);
      if (!timing) return;
      speedSamplesRef.current = pushSpeedSample(speedSamplesRef.current, fragmentSpeedSample(timing));
    });
    // 单码率源在 MANIFEST 阶段拿不到 height（清单尚未解析），这里补一次。
    // 注意 data.level 是档位下标，分辨率在 levelInfo 上。
    // width 必须一起上报：判档以宽度为准，只给 height 会让 1920×752 落回 720P。
    hls.on(Hls.Events.LEVEL_LOADED, (_evt, data) => {
      const { height, width } = data.levelInfo ?? {};
      if (typeof height === 'number') reportQuality(height, typeof width === 'number' && width > 0 ? width : undefined);
    });
    /*
     * ABR 自动切档本身不经过我们的菜单：不放这条监听，按钮上会一直显示起播那一档，
     * 用户看着「1080P」实际早已掉到 360P —— 比不显示更糟。
     */
    hls.on(Hls.Events.LEVEL_SWITCHED, () => {
      void refreshQualityMenu();
    });
    // 分片真正进入 MSE buffer 才算媒体恢复：此时视频轨可渲染，错误态可解除
    hls.on(Hls.Events.FRAG_BUFFERED, () => {
      mediaHealthyRef.current = true;
    });

    hls.on(Hls.Events.ERROR, (_evt, data) => {
      if (!data.fatal) return;
      const recovery = recoveryRef.current;
      if (!recovery) return;
      const decision = recovery.onFatal(data.type, data.details);
      switch (decision.action) {
        case 'ignore':
          break;
        case 'retry': {
          // 前两次重试保留直连；达到退避阈值或清单级错误时升级为代理形式
          // （同源 cookie 鉴权，规避 CORS/防盗链/分片被拒）
          if (
            allowProxyFallback &&
            !mediaUrl.startsWith('/api/proxy') &&
            (decision.attempt >= 2 || data.details === 'manifestLoadError')
          ) {
            showHint('直连失败，改用代理重试...');
            setupHls(video, `/api/proxy?url=${encodeURIComponent(mediaUrl)}`, false);
            return;
          }
          showHint(`${decision.reason}（第 ${decision.attempt} 次）...`);
          recovery.schedule(decision.delayMs, () => hls.startLoad());
          break;
        }
        case 'recover-media': {
          showHint(`${decision.reason}（第 ${decision.attempt} 次）...`);
          if (decision.swapAudio) hls.swapAudioCodec?.();
          hls.recoverMediaError();
          break;
        }
        case 'switch-source': {
          // 覆盖播放开始后的场景：起播失败走 setError 遮罩；
          // 播放中失败走回调弹换源面板（父级未提供回调时同样 setError）
          const message = `${describeHlsError(data.type, data.details)}：${decision.reason}`;
          if (playbackStartedRef.current) {
            showHint(message);
            propsRef.current.onRequestSwitchSource?.(decision.reason);
          } else {
            setError(`视频加载失败，${message}，请尝试其他视频源`);
          }
          break;
        }
      }
    });
  };

  /** 换集：重置每集状态并切换到新 HLS 源（不重建 ArtPlayer）。 */
  const loadEpisode = (targetUrl: string) => {
    if (!targetUrl) return;
    mediaHealthyRef.current = true;
    playbackStartedRef.current = false;
    videoErrorRetryUsedRef.current = false;
    restoredRef.current = false;
    introSkippedRef.current = false;
    outroFiredRef.current = false;
    setUndoIntroSec(0);
    if (undoIntroTimerRef.current) clearTimeout(undoIntroTimerRef.current);
    recoveryRef.current = new PlaybackRecovery();
    setError('');
    setShowPoster(true);
    const art = artRef.current;
    if (!art) return;
    setupHls(art.video, targetUrl, true);
  };

  // —— 创建播放器（仅一次，挂载即创建） ——
  useEffect(() => {
    if (!containerRef.current || !propsRef.current.url) return;
    const initialUrl = propsRef.current.url;

    // 初始化每集状态
    mediaHealthyRef.current = true;
    playbackStartedRef.current = false;
    videoErrorRetryUsedRef.current = false;
    restoredRef.current = false;
    introSkippedRef.current = false;
    outroFiredRef.current = false;
    setUndoIntroSec(0);
    recoveryRef.current = new PlaybackRecovery();
    endedRef.current = false;

    let lastSave = 0;

    const art = new Artplayer({
      container: containerRef.current,
      url: initialUrl,
      type: 'm3u8',
      volume: 0.8,
      autoplay: true,
      pip: true,
      autoMini: true,
      screenshot: true,
      setting: true,
      playbackRate: true,
      aspectRatio: true,
      // 全屏按钮照常显示；Apple 触屏设备上由下面的 art.fullscreen 拦截改走原生全屏
      fullscreen: true,
      fullscreenWeb: true,
      miniProgressBar: true,
      mutex: true,
      backdrop: true,
      playsInline: true,
      // airplay 关掉：Artplayer 只在 Safari 的 WebKitPlaybackTargetAvailabilityEvent 存在时才注册这个按钮，
      // 桌面 Edge/Chrome 上它照样渲染，点了却只弹一句「AirPlay Not Available」——纯噪音
      airplay: false,
      hotkey: false,
      theme: '#2563eb',
      lang: navigator.language.toLowerCase().startsWith('zh') ? 'zh-cn' : 'en',
      /*
       * 不能用 crossOrigin="anonymous"：
       * 1. 采集站的 m3u8/ts 基本都不带 Access-Control-Allow-Origin，加上它 Safari 直接把整条流判败；
       * 2. 更要命的是——带 crossOrigin 的视频在 iOS/iPadOS 上会被系统判为「跨域媒体」，
       *    video.webkitEnterFullscreen() 调用后不会拉起系统全屏播放器（点了全屏毫无反应）。
       * 代价：canvas 截图遇到跨域源会抛 SecurityError，play() 里的截图已经 catch 掉，不影响播放。
       */
      moreVideoAttr: { playsInline: true },
      /*
       * 自定义「视频信息」控件。挂在 controls-right、index 15：
       * 排在内置 screenshot(20) 之前、画质胶囊（我们自己塞在 $player 上的浮层）之下，
       * 这样它与截图/设置/画饼这些同一类「工具按钮」挨在一起，不打断播放控制。
       *
       * 必须给 name：基类 add() 会对重复 name 直接抛错（"Can't add an existing [...]"），
       * 有名字才能在需要时 art.controls.remove('videoStats') 摘掉。
       * 运行时校验表里没有 beforeUnmount，所以点击事件自己用 proxy 绑定。
       */
      controls: [
        {
          name: 'videoStats',
          position: 'right',
          index: 15,
          html: VSTATS_ICON,
          tooltip: '视频信息',
          click: () => {
            toggleStatsRef.current();
          },
        },
      ],
      customType: {
        m3u8: (video: HTMLVideoElement, mediaUrl: string) => {
          setupHls(video, mediaUrl, true);
        },
      },
    });
    artRef.current = art;
    // 面板的挂载点：$player 是播放器的浮层坐标系，画质胶囊也挂在同一个节点上
    setStatsPortalEl((art.template?.$player as HTMLElement | undefined) ?? null);

    /**
     * 读解码后的真实分辨率。
     * 单码率 m3u8 / mp4 直链的清单里没有画质字段，服务端无论如何探测不到，
     * 只有 video 元素的 videoHeight 是真的——这是「播放一次即记住画质」链路的唯一数据源。
     * loadedmetadata 在部分浏览器上 videoHeight 仍为 0，因此 canplay / playing / resize
     * 各补一次机会，不能只赌单一事件时机。
     */
    const reportVideoHeight = () => {
      const height = art.video?.videoHeight;
      const width = art.video?.videoWidth;
      if (typeof height !== 'number' || height <= 0) return;
      reportQuality(height, typeof width === 'number' && width > 0 ? width : undefined);
      // 单档源（采集站常态）的画质胶囊只能靠实测值填字：清单里没有任何档位信息，
      // 解码后拿到 videoHeight 才算知道在放几 P，所以这里必须顺手刷一次菜单
      void refreshQualityMenu();
    };
    art.on('video:canplay', reportVideoHeight);
    art.on('video:playing', reportVideoHeight);
    // resize 不在 ArtPlayer 的视频事件转发表里，直接挂原生事件
    art.video?.addEventListener('resize', reportVideoHeight);

    /*
     * —— 全屏兜底（所有平台都装）——
     *
     * 读 dist/artplayer.js 才看清的两个坑：
     * 1. Artplayer 的 fullscreen 存取器要等**首次 loadedmetadata** 才定义（It(t) 里的
     *    once("video:loadedmetadata")）。首帧迟迟不来时（流卡住、广告、采集站抽风），
     *    art.fullscreen = true 就是空操作 —— 用户看到的就是「点了全屏没反应」。
     * 2. 它用**不可配置**的 defineProperty 写实例属性，会顶掉我们先装好的同名覆盖，
     *    所以每次 loadedmetadata 之后都要补装一次，否则覆盖活不过第一帧。
     *
     * 这层覆盖按优先级处理：系统播放器全屏（iOS/iPadOS）→ 元素全屏（桌面）→
     * 最后才落回 Artplayer 自己的实现（它会弹「不支持全屏」）。
     * 全屏按钮、设置面板、快捷键 f、双击画面都走 art.fullscreen，改一处即可全覆盖。
     */
    type FullscreenVideo = HTMLVideoElement & {
      webkitEnterFullscreen?: () => void;
      webkitExitFullscreen?: () => void;
      webkitDisplayingFullscreen?: boolean;
    };

    // 装覆盖之前 Artplayer 自己的存取器（loadedmetadata 之后才有，此前是 undefined）
    let artDescriptor: PropertyDescriptor | undefined;
    // 我们最近一次装上去的 getter，用来判断覆盖是否已被 Artplayer 顶掉
    let installedGetter: (() => boolean) | undefined;

    /** 请求/退出**元素全屏**（挂在播放器容器上）。返回是否已经接管，false 表示环境不支持。 */
    const requestElementFullscreen = (on: boolean): boolean => {
      const el = (art.template?.$player ?? containerRef.current) as HTMLElement | null;
      if (!el) return false;
      if (on) {
        if (typeof el.requestFullscreen !== 'function') return false;
        void el
          .requestFullscreen()
          .then(() => {
            // 这条路径绕过了 Artplayer 的监听器（metadata 未到时不装），手动补一次图标状态
            try { art.emit('fullscreen', true); } catch { /* 忽略 */ }
          })
          .catch(() => { /* 浏览器拒绝（无手势 / 被策略拦）：保持原状态 */ });
        return true;
      }
      if (!document.fullscreenElement) return false;
      void document.exitFullscreen?.().catch(() => { /* 忽略 */ });
      return true;
    };

    const installFullscreenOverride = () => {
      const player = art as unknown as { fullscreen: boolean; fullscreenWeb: boolean };
      const current = Object.getOwnPropertyDescriptor(player, 'fullscreen');
      // 我们的 getter 已经被 Artplayer 顶掉：把它的真存取器记成落回目标
      if (current && current.get !== installedGetter) artDescriptor = current;

      const getter = (): boolean => {
        const v = art.video as FullscreenVideo | undefined;
        if (v?.webkitDisplayingFullscreen) return true;
        const el = (art.template?.$player ?? null) as HTMLElement | null;
        if (el && document.fullscreenElement === el) return true;
        return artDescriptor?.get ? !!artDescriptor.get.call(player) : false;
      };
      installedGetter = getter;

      Object.defineProperty(player, 'fullscreen', {
        configurable: true,
        enumerable: true,
        get: getter,
        set: (on: boolean) => {
          const v = art.video as FullscreenVideo | undefined;
          // 已经在系统播放器全屏里：只处理退出（iOS 没有给 JS 的退出接口，交给系统按钮）
          if (v?.webkitDisplayingFullscreen) {
            if (!on) v.webkitExitFullscreen?.();
            return;
          }
          if (document.fullscreenElement) {
            if (!on) void document.exitFullscreen?.().catch(() => { /* 忽略 */ });
            return;
          }
          if (!on) return;
          // 网页全屏先退掉，否则原生全屏退出后会落回「网页全屏」而不是正常页面
          try { if (player.fullscreenWeb) player.fullscreenWeb = false; } catch { /* 忽略 */ }
          // Apple 触屏：优先交给系统播放器（可旋转、可画中画、省电、硬解直通）
          if (isAppleTouch && canUseNativeFullscreen(v)) {
            enterNativeFullscreen(v);
            // iOS 偶发静默失败（不进系统全屏也不报错）：300ms 后仍没进去就用元素全屏兜底
            window.setTimeout(() => {
              if (!(v as FullscreenVideo | undefined)?.webkitDisplayingFullscreen) requestElementFullscreen(true);
            }, 300);
            return;
          }
          if (requestElementFullscreen(true)) return;
          artDescriptor?.set?.call(player, on);
        },
      });
    };

    installFullscreenOverride();
    /*
     * 元素全屏的进出事件由我们（或 Artplayer）接管，必须把状态同步到播放器：
     * .art-fullscreen 类管控件图标，art.state 管内部状态机。
     * metadata 没到时 Artplayer 根本没装这个监听，全靠这里补。
     */
    const syncFullscreenState = () => {
      const el = art.template?.$player as HTMLElement | undefined;
      const on = !!document.fullscreenElement && document.fullscreenElement === el;
      try {
        if (on) {
          art.state = 'fullscreen';
          el?.classList.add('art-fullscreen');
        } else {
          el?.classList.remove('art-fullscreen');
        }
      } catch { /* 忽略 */ }
      try { art.emit('fullscreen', !!document.fullscreenElement); } catch { /* 忽略 */ }
    };
    document.addEventListener('fullscreenchange', syncFullscreenState);

    art.on('video:loadedmetadata', () => {
      // ArtPlayer 运行时支持 title 选项（类型定义未覆盖），用于界面标题展示
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (art as any).title = propsRef.current.title;
      } catch { /* 忽略 */ }
      /*
       * Artplayer 就是在这一帧用不可配置的 defineProperty 重写 fullscreen 的，
       * 我们的覆盖会被顶掉 —— 必须在这里补装一次，否则首帧之后就退回原生实现，
       * 流卡住时又变成「点了全屏没反应」。
       */
      installFullscreenOverride();
      reportVideoHeight();
    });

    art.on('video:playing', () => {
      playbackStartedRef.current = true;
      setShowPoster(false);
      // 仅在媒体真正恢复（有分片进入 buffer）后清错误遮罩：
      // 否则「视频轨挂了、音频轨先播出来」时会清掉遮罩，留下黑屏假死态
      if (mediaHealthyRef.current) setError('');
      // 片头跳过：只在第一次真正起播时执行一次。
      // 已经因为恢复进度/手动 seek 越过片头的（currentTime >= intro）不跳，
      // 否则会把用户从 40 分钟处拽回第 90 秒。
      if (!introSkippedRef.current) {
        introSkippedRef.current = true;
        const intro = propsRef.current.introSec || 0;
        const total = art.duration || 0;
        // 上限 min(180s, 总时长×30%)：短片/花絮不会被整段吃掉
        const cap = Math.min(180, total > 0 ? total * 0.3 : 180);
        const target = Math.min(intro, cap);
        if (target >= 5 && art.currentTime < target) {
          art.currentTime = target;
          setUndoIntroSec(Math.round(target));
          // 撤销窗口 12s：够看清、又不至于一直挂在播放器上
          if (undoIntroTimerRef.current) clearTimeout(undoIntroTimerRef.current);
          undoIntroTimerRef.current = setTimeout(() => setUndoIntroSec(0), 12_000);
        }
      }
    });
    art.on('video:error', () => {
      mediaHealthyRef.current = false;
      // 起播阶段的 video 元素级错误（MSE/解码偶发失败）：重建一次播放链路自愈，
      // 而不是直接钉死错误遮罩——重建后视频轨重新 append，黑屏有声即可解除
      if (!playbackStartedRef.current && !videoErrorRetryUsedRef.current) {
        videoErrorRetryUsedRef.current = true;
        showHint('播放异常，正在重试...');
        setupHls(art.video, currentMediaUrlRef.current, true);
        return;
      }
      setError('视频播放失败，请尝试其他视频源');
    });
    art.on('video:timeupdate', () => {
      const now = Date.now();
      // 片尾跳过：播到 duration - outroSec 就当作本集结束。
      // 只触发一次（跳完 currentTime 仍会继续往前走），并且要求已真正起播，
      // 否则 seek 恢复阶段 duration 可能还是 NaN。
      if (!outroFiredRef.current) {
        const outro = propsRef.current.outroSec || 0;
        const total = art.duration || 0;
        if (outro > 0 && total > outro + 5 && art.currentTime >= total - outro) {
          outroFiredRef.current = true;
          showHint(`已跳过片尾 ${outro}s`);
          endedRef.current = true;
          propsRef.current.onEnded?.();
        }
      }
      if (now - lastSave > 5000) {
        lastSave = now;
        propsRef.current.onTimeUpdate?.(art.currentTime, art.duration);
      }
    });
    art.on('video:pause', () => {
      propsRef.current.onPause?.(art.currentTime, art.duration);
    });
    art.on('video:ended', () => {
      endedRef.current = true;
      propsRef.current.onEnded?.();
    });

    // —— 键盘快捷键（旧版 hotkey:false + 自定义逻辑的移植） ——
    const shortcuts = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      // 输入框或按钮获得焦点时不劫持按键：否则空格会吞掉按钮的默认激活
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.closest('button')) return;
      const current = artRef.current;
      if (!current) return;
      if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); return; } // 由父层处理集数切换
      if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); return; }
      switch (e.key) {
        case 'ArrowLeft':
          if (current.currentTime > 5) { current.currentTime -= 5; showHint('快退 5s'); e.preventDefault(); }
          break;
        case 'ArrowRight':
          if (current.duration - current.currentTime > 5) { current.currentTime += 5; showHint('快进 5s'); e.preventDefault(); }
          break;
        case 'ArrowUp':
          if (current.volume < 1) { current.volume = Math.min(1, current.volume + 0.1); showHint(`音量 ${Math.round(current.volume * 100)}%`); e.preventDefault(); }
          break;
        case 'ArrowDown':
          if (current.volume > 0) { current.volume = Math.max(0, current.volume - 0.1); showHint(`音量 ${Math.round(current.volume * 100)}%`); e.preventDefault(); }
          break;
        case ' ':
          current.toggle(); showHint('播放/暂停'); e.preventDefault();
          break;
        case 'f': case 'F':
          current.fullscreen = !current.fullscreen; e.preventDefault();
          break;
      }
    };
    document.addEventListener('keydown', shortcuts);

    // —— 移动端长按 3 倍速 ——
    let longPressTimer: ReturnType<typeof setTimeout> | null = null;
    let isLongPress = false;
    let originalRate = 1.0;
    const el = containerRef.current;

    const onTouchStart = (e: TouchEvent) => {
      if (art.video?.paused) return;
      // 已有触控在处理时忽略新手指：否则第二指会把 originalRate 捕获成 3.0，
      // 松手后倍速永久卡在 3x；旧定时器句柄也会被覆盖成无法清除的幽灵触发
      if (isLongPress || longPressTimer) return;
      // 控制栏 / 设置面板上的长按不触发倍速（按住进度条拖动、长按倍速菜单项会误触）
      if ((e.target as HTMLElement).closest?.('.art-controls, .art-settings')) return;
      originalRate = art.video.playbackRate;
      longPressTimer = setTimeout(() => {
        if (art.video?.paused) return;
        art.video.playbackRate = 3.0;
        isLongPress = true;
        showHint('3 倍速');
      }, 500);
    };
    const onTouchEnd = () => {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      if (isLongPress) {
        art.video.playbackRate = originalRate;
        isLongPress = false;
        showHint(`${originalRate} 倍速`);
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (isLongPress) e.preventDefault();
    };
    // ArtPlayer 的 contextmenu 组件只在桌面端初始化（移动端构造函数里跳过 init），
    // 长按倍速因而会连带呼出系统原生菜单/气泡。播放器表面没有可用的原生菜单，统一抑制
    const onContextMenu = (e: Event) => e.preventDefault();
    el?.addEventListener('touchstart', onTouchStart, { passive: false });
    el?.addEventListener('touchend', onTouchEnd);
    el?.addEventListener('touchcancel', onTouchEnd);
    el?.addEventListener('touchmove', onTouchMove, { passive: false });
    el?.addEventListener('contextmenu', onContextMenu);

    // 卸载与页面隐藏时保存进度
    const saveOnHide = () => {
      if (document.visibilityState === 'hidden') {
        propsRef.current.onPause?.(art.currentTime, art.duration);
      }
    };
    document.addEventListener('visibilitychange', saveOnHide);

    return () => {
      // 卸载前刷一次最终进度，避免丢失最后几秒。
      // 已自然播完的集数不回写，避免覆盖 onEnded 里清除的「已看完」记录
      if (!endedRef.current) {
        try {
          propsRef.current.onPause?.(art.currentTime, art.duration);
        } catch { /* 忽略 */ }
      }
      document.removeEventListener('keydown', shortcuts);
      document.removeEventListener('visibilitychange', saveOnHide);
      document.removeEventListener('fullscreenchange', syncFullscreenState);
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
      restoreCleanupRef.current?.();
      restoreCleanupRef.current = null;
      el?.removeEventListener('touchstart', onTouchStart);
      el?.removeEventListener('touchend', onTouchEnd);
      el?.removeEventListener('touchcancel', onTouchEnd);
      el?.removeEventListener('touchmove', onTouchMove);
      el?.removeEventListener('contextmenu', onContextMenu);
      art.video?.removeEventListener('resize', reportVideoHeight);
      // 画质菜单是我们直接塞进播放器 DOM 的节点，必须自己摘干净，否则残留到下一集
      if (qualityMenuDocHandlerRef.current) {
        document.removeEventListener('click', qualityMenuDocHandlerRef.current);
        qualityMenuDocHandlerRef.current = null;
      }
      qualityMenuRef.current?.root.remove();
      qualityMenuRef.current = null;
      // 面板虽然是 React 渲染的，但它挂在 $player 里；art.destroy() 会把 $player 整棵树拆掉，
      // 这里只需把内容清空，避免卸载后还有 setInterval 往已销毁的节点上写数据
      statsFrameRef.current = null;
      // 采样窗口跟着播放器生命周期走：重建播放器（换源）时留着旧源的吞吐会误导
      speedSamplesRef.current = [];
      clearSegmentTimings();
      hlsRef.current?.destroy();
      hlsRef.current = null;
      recoveryRef.current?.dispose();
      art.destroy();
      artRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // —— 换集：仅切换 HLS 源，不重建播放器（保留网页全屏等状态） ——
  const firstUrlRef = useRef(true);
  useEffect(() => {
    // 挂载时的首次由创建 effect 的 customType 触发，跳过避免重复加载
    if (firstUrlRef.current) { firstUrlRef.current = false; return; }
    loadEpisode(url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // —— 广告过滤开关变化：重建 HLS loader（无需重建整个播放器） ——
  const firstAdFilterRef = useRef(true);
  useEffect(() => {
    if (firstAdFilterRef.current) { firstAdFilterRef.current = false; return; }
    if (artRef.current && hlsRef.current) {
      // 用当前实际媒体地址：代理回退生效时切广告过滤不应跳回直连形式
      loadEpisode(currentMediaUrlRef.current || propsRef.current.url);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adFilter]);

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="w-full h-full" style={{ WebkitTouchCallout: 'none' }} />
      {showPoster && !error && (
        <div
          className="absolute inset-0 bg-black pointer-events-none"
          style={{
            backgroundImage: 'url(/player-poster.png)',
            backgroundSize: 'contain',
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
          }}
        />
      )}
      {/* 覆盖层必须抬到 .art-video（z-index:10）之上，否则错误遮罩与撤销按钮会被视频层挡住点不到 */}
      {error && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/80">
          <p className="text-danger text-sm">{error}</p>
          <div className="flex items-center gap-2">
            {/* 只给「重新加载」等于让用户自己满页面找换源入口；这里直接引导到右侧换源卡 */}
            {onRequestSwitchSource && (
              <button
                className="btn-primary text-xs"
                onClick={() => {
                  setError('');
                  onRequestSwitchSource('播放失败');
                }}
              >
                换个源
              </button>
            )}
            <button className="btn-ghost text-xs" onClick={() => location.reload()}>
              重新加载
            </button>
          </div>
        </div>
      )}
      {/*
        视频信息面板：用 portal 挂进播放器的 $player 根节点，而不是这个 React 根 div。
        $player 是 Artplayer 自己的浮层坐标系（画质胶囊就挂在那里）；挂在外层根 div 里
        会落在 .art-video、.art-bottom 之下，进全屏（$player 被浏览器拉成全屏元素）时会被裁掉。
        数据每 800ms 刷新，见上面的 setInterval effect，所以面板不必是「点开快照」。
      */}
      {statsOpen &&
        statsPortalEl &&
        createPortal(
          <div className="g-vstats" role="dialog" aria-label="视频信息">
            <div className="g-vstats-head">
              <strong>视频信息</strong>
              <button type="button" className="g-vstats-copy" onClick={() => { void copyStats(); }}>
                {statsCopied ? '已复制' : '复制'}
              </button>
              <button type="button" className="g-vstats-x" aria-label="关闭" onClick={() => setStatsOpen(false)}>
                ×
              </button>
            </div>
            <div className="g-vstats-body">
              {statsRows.length === 0 ? (
                <p className="g-vstats-empty">暂时读不到播放信息</p>
              ) : (
                statsRows.map((group) => (
                  <div className="g-vstats-group" key={group.title}>
                    <span className="g-vstats-gtitle">{group.title}</span>
                    {group.rows.map((row) => (
                      <div className={row.warn ? 'g-vstats-row warn' : 'g-vstats-row'} key={row.label}>
                        <span className="g-vstats-k">{row.label}</span>
                        <span className="g-vstats-v">
                          {row.value}
                          {row.hint && <em>{row.hint}</em>}
                        </span>
                      </div>
                    ))}
                  </div>
                ))
              )}
            </div>
          </div>,
          statsPortalEl,
        )}
      {hint && (
        <div className="absolute z-20 top-4 left-1/2 -translate-x-1/2 bg-black/70 text-white text-sm px-3 py-1.5 rounded-full pointer-events-none animate-fade-in">
          {hint}
        </div>
      )}
      {/*
        片头跳过的撤销入口：独立于 hint（hint 2.5s 就消失，撤销要留得更久），
        且只在「刚跳完片头」这一小段时间里出现，之后收起，不占播放器常驻空间。
      */}
      {undoIntroSec > 0 && (
        <div className="absolute z-20 left-4 bottom-16 flex items-center gap-2 bg-black/70 text-white text-xs px-2.5 py-1.5 rounded-full animate-fade-in">
          <span>已跳过片头 {undoIntroSec}s</span>
          <button
            type="button"
            className="underline decoration-dotted underline-offset-2 hover:text-white/80"
            onClick={() => {
              const art = artRef.current;
              if (art) art.currentTime = 0;
              introSkippedRef.current = true;
              setUndoIntroSec(0);
              propsRef.current.onUndoIntro?.();
            }}
          >
            撤销
          </button>
        </div>
      )}
    </div>
  );
}
