/**
 * 播放统计（视频信息面板的数据层）。
 *
 * 用户诉求（m06825）：播放时要能直接看到码率、帧率、分辨率与网络状况，
 * 而不是只有一句「现在在播几 P」。这些指标分散在三个互不相通的地方：
 *
 * 1. <video> 元素：解码后的真实宽高与总时长（唯一可信的分辨率来源，
 *    清单里的 RESOLUTION 可能写着 1920x1080 而实际编码是 1072 高）。
 * 2. hls.js：当前在播档位、码率（清单 BANDWIDTH 或实测分片带宽）、
 *    实际帧率（hls 从 MPEG-TS 的 SPS 里解析出 frameRate）、编解码器。
 * 3. 浏览器：网络往返估速（Network Information API，仅 Chromium 系提供）
 *    与缓冲健康度。
 *
 * 本模块只做纯计算 + 格式化，取数与渲染在组件里，便于单测。
 */

/** 一次采样得到的原始指标，任何一项都可能缺失（Firefox 没有 netinfo、直链没有 hls 档位） */
export interface PlaybackStatsInput {
  /** 解码后的视频宽高（video.videoWidth / videoHeight） */
  width?: number;
  height?: number;
  /** 播放器总时长与当前进度（秒） */
  duration?: number;
  currentTime?: number;
  /** 已缓冲到的最大时间点（秒）：用「缓冲里还剩多少」判断是否卡顿边缘 */
  bufferedAhead?: number;
  /** video.getVideoPlaybackQuality()：解码后丢弃的帧数 / 累计出帧数 */
  droppedFrames?: number;
  totalFrames?: number;
  /**
   * 实测帧率（fps）。
   * 清单里没写 FRAME-RATE 时（采集站的 HLS 十有八九不写），只能拿「单位时间实际出帧数」反推，
   * 比没有强；但它受掉帧影响，会在帧率行上单独标注「实测」。
   */
  frameRateMeasured?: number;
  /** hls.js 当前在播档位信息 */
  level?: {
    /** 当前在播档位下标与总档位数（单码率源时档位数为 1，这一行不显示） */
    levelIndex?: number;
    levelCount?: number;
    /** 清单声明的码率（bps） */
    bitrate?: number;
    /** hls 实测的最近分片带宽（bps） */
    measuredBitrate?: number;
    width?: number;
    height?: number;
    /** hls 从 SPS 解析的帧率 */
    frameRate?: number;
    /** 如 "avc1.640028" / "mp4a.40.2" */
    videoCodec?: string;
    audioCodec?: string;
  };
  /**
   * 实测下行速度（bps）：由播放器统计「最近若干分片」的字节数与传输耗时得到。
   * 这是唯一能代表「现在这条流到底跑多快」的数，比 navigator.connection.downlink 可靠得多。
   */
  measuredSpeedBps?: number;
  /** 实测首字节时延中位数（ms），与 measuredSpeedBps 同源 */
  measuredTtfbMs?: number;
  /** 上述实测值的样本数，写进 hint 让用户知道这个数背后有多少个分片 */
  speedSampleCount?: number;
  /**
   * 其中走真实网络的样本数。为 0 表示窗口里的样本全来自预取缓存，
   * 这时 hint 要写「预取实测」而不是「近 N 个分片」，否则像刚测的。
   */
  speedLiveCount?: number;
  /** 窗口里没有实时样本时，是否全部来自预取（用于区分「预取实测」与「缓存回放」） */
  speedPrefetchedOnly?: boolean;
  /** 浏览器上报的有效连接类型，如 "4g" / "wifi" */
  effectiveType?: string;
  /**
   * 浏览器估测的下行带宽（Mbps）。
   *
   * 只在拿不到实测速度时兜底显示——它是个粗粒度档位而不是当前吞吐：
   * Chrome 对任意宽带连接都会给 10 Mbps 上限、Wi-Fi/4G 给同一档，
   * 实测过「面板写 1.4 Mbps，同一时间段分片真实吞吐 22.7 Mbps」。
   * 拿它跟码率并列，用户必然以为自己在用 1.4 Mbps 的网。
   */
  downlinkMbps?: number;
  /** 浏览器估测的往返时延（ms），同样只有 0/50/100/200/250/300 这类离散档位 */
  rttMs?: number;
  /** navigator.connection.saveData */
  saveData?: boolean;
}

/** 面板上的一行 */
export interface StatsRow {
  label: string;
  value: string;
  /** 次要说明（灰色小字），如「估算值」「浏览器上报」 */
  hint?: string;
  /** 需要关注的告警态（缓冲见底、掉档） */
  warn?: boolean;
}

export interface StatsGroup {
  title: string;
  rows: StatsRow[];
}

/** bps → "3.2 Mbps"；低于 1 Mbps 用 Kbps，避免出现 "0.4 Mbps" 这种不好读的数 */
export function formatBitrate(bps?: number): string {
  if (!Number.isFinite(bps) || !bps || bps <= 0) return '未知';
  if (bps >= 1_000_000) {
    const mbps = bps / 1_000_000;
    return `${mbps >= 10 ? mbps.toFixed(1) : mbps.toFixed(2)} Mbps`;
  }
  return `${Math.round(bps / 1000)} Kbps`;
}

/** 帧率：整数直接显示，小数保留两位（29.97 / 23.976 这类必须保留，否则看不出 NTSC） */
export function formatFrameRate(fps?: number): string {
  if (!Number.isFinite(fps) || !fps || fps <= 0) return '未知';
  const rounded = Math.round(fps * 100) / 100;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(2)} fps`;
}

/**
 * 分辨率：宽高都有效才算已知。
 * 竖屏视频（手机拍的、部分短剧）按「宽 < 高」原样输出，不强行转成横屏标法。
 */
export function formatResolution(width?: number, height?: number): string {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return '未知';
  const w = Math.round(width as number);
  const h = Math.round(height as number);
  if (w <= 0 || h <= 0) return '未知';
  return `${w} × ${h}`;
}

/** 秒 → "4h 12m" / "12m 03s"；时长未知返回「未知」 */
export function formatDuration(seconds?: number): string {
  if (!Number.isFinite(seconds) || !seconds || seconds <= 0) return '未知';
  const total = Math.round(seconds as number);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

/**
 * 缓冲健康度。
 *
 * 阈值取 5 秒：低于这个数时 ABR 已经会主动降到下一档，用户体感就是「突然糊一下」；
 * 高于 30 秒再往上加没有意义（hls 的 maxBufferLength 默认也就 30～60），
 * 所以分三档而不是给一个精确到小数点的秒数当结论。
 */
export function bufferHealth(seconds?: number): { text: string; warn: boolean } {
  if (!Number.isFinite(seconds) || (seconds as number) < 0) {
    return { text: '未知', warn: false };
  }
  const s = seconds as number;
  if (s < 1) return { text: `${s.toFixed(1)}s · 见底`, warn: true };
  if (s < 5) return { text: `${s.toFixed(1)}s · 偏薄`, warn: true };
  if (s < 15) return { text: `${s.toFixed(1)}s · 正常`, warn: false };
  return { text: `${s.toFixed(1)}s · 充足`, warn: false };
}

/**
 * 编解码器短名："avc1.640028" → "H.264 High"，"mp4a.40.2" → "AAC-LC"。
 * 认不出就原样返回——采集站的流五花八门，硬猜比显示原始串更误导。
 */
export function codecLabel(codec?: string): string {
  if (!codec) return '';
  const raw = codec.trim();
  const lower = raw.toLowerCase();
  if (lower.startsWith('avc1') || lower.startsWith('avc3')) {
    // profile_idc 在 codec 串的第 2 个字节：64 = High，4d/4D = Main，42 = Baseline
    const hex = raw.split('.')[1]?.slice(0, 2)?.toLowerCase();
    const profile = hex === '64' ? 'High' : hex === '4d' ? 'Main' : hex === '42' ? 'Baseline' : '';
    return profile ? `H.264 ${profile}` : 'H.264';
  }
  if (lower.startsWith('hvc1') || lower.startsWith('hev1')) return 'H.265 (HEVC)';
  if (lower.startsWith('av01')) return 'AV1';
  if (lower.startsWith('vp09')) return 'VP9';
  if (lower.startsWith('mp4a.40.2') || lower.startsWith('mp4a')) return 'AAC';
  if (lower.startsWith('ec-3')) return 'E-AC-3';
  if (lower.startsWith('ac-3')) return 'AC-3';
  if (lower.startsWith('opus')) return 'Opus';
  return raw;
}

/** 有效连接类型的中文名；Chromium 的 effectiveType 是 "slow-2g"/"2g"/"3g"/"4g" */
export function networkTypeLabel(effectiveType?: string): string {
  if (!effectiveType) return '';
  switch (effectiveType.toLowerCase()) {
    case 'slow-2g':
      return '极慢';
    case '2g':
      return '2G';
    case '3g':
      return '3G';
    case '4g':
      return '4G';
    default:
      return effectiveType;
  }
}

/**
 * 「缓冲里还剩多少秒」。
 *
 * 不能用 buffered.end(0) 之外的第一段：用户拖动进度条后会出现多段缓冲，
 * 只有最靠后的结束点才代表「已经铺到哪」。落在空隙里时结果是负数，按未知处理。
 */
export function bufferedAheadOf(video: {
  currentTime: number;
  buffered: { length: number; end: (index: number) => number };
}): number | undefined {
  const ranges = video.buffered;
  if (!ranges || ranges.length === 0) return undefined;
  let end = 0;
  for (let i = 0; i < ranges.length; i += 1) end = Math.max(end, ranges.end(i));
  const ahead = end - video.currentTime;
  return Number.isFinite(ahead) && ahead >= 0 ? ahead : undefined;
}

/**
 * Network Information API 的最小接口。
 *
 * TS 的 lib.dom 至今没有 NetworkInformation 类型（Chromium 专有），
 * 只能自己声明；Firefox/Safari 上 navigator.connection 根本不存在。
 */
export interface NetworkInformationLike {
  /**
   * 浏览器估测的下行带宽（Mbps），**粗粒度档位**不是实测值。
   * Chrome 对 4G/Wi-Fi 都给同一量级的上限，再怎么测也跳不出几个固定值。
   */
  downlink?: number;
  /** 浏览器估测的往返时延（ms），同样只有 0/50/100/150/200/250/300 几个离散档位 */
  rtt?: number;
  /**
   * 有效连接类型（"slow-2g" | "2g" | "3g" | "4g"）。
   * 名字有误导性：它描述的是「等效带宽档位」，不是网络制式——
   * 插网线的桌面 Chrome 一样报 "4g"。所以面板上叫「浏览器档位」而不是「网络类型」。
   */
  effectiveType?: string;
  /** 真实连接制式（"wifi" | "cellular" | "ethernet" | ...），桌面 Chrome 不提供 */
  type?: string;
  saveData?: boolean;
}

/** 把浏览器网络信息映射成输入字段；缺失项一律不填，交给分组函数隐藏 */
export function networkInput(
  connection?: NetworkInformationLike,
): Pick<PlaybackStatsInput, 'downlinkMbps' | 'rttMs' | 'effectiveType' | 'saveData'> {
  if (!connection) return {};
  const out: Pick<PlaybackStatsInput, 'downlinkMbps' | 'rttMs' | 'effectiveType' | 'saveData'> = {};
  if (Number.isFinite(connection.downlink) && (connection.downlink as number) > 0) {
    out.downlinkMbps = connection.downlink;
  }
  if (Number.isFinite(connection.rtt) && (connection.rtt as number) > 0) out.rttMs = connection.rtt;
  if (connection.effectiveType) out.effectiveType = connection.effectiveType;
  if (connection.saveData) out.saveData = true;
  return out;
}

/** 一个分片的传输耗时快照，字段口径与 hls.js 的 LoaderStats 一致 */
export interface FragmentTiming {
  /** 已加载字节数（stats.loaded） */
  loaded?: number;
  /** 请求发出时刻（stats.loading.start，performance.now 口径） */
  start?: number;
  /** 首字节到达时刻（stats.loading.first） */
  first?: number;
  /** 传输结束时刻（stats.loading.end） */
  end?: number;
}

/** 一次分片采样得到的实测值 */
export interface SpeedSample {
  /** 扣掉首字节等待后的纯下载速度（bps） */
  speedBps: number;
  /** 首字节时延（ms），拿不到起始时刻时为 undefined */
  ttfbMs?: number;
  /**
   * 这一片是不是从本地缓存回放的。
   *
   * 预取器把分片提前抓下来，播放时直接命中缓存——这时加载耗时用的是「当初预取花了多久」。
   * 速度仍然是真的（确实从这条流下载过），但首字节时延无从谈起；
   * 全都是缓存样本时 hint 也要改口，不能还说「近 N 个分片」像是刚测的。
   */
  cached?: boolean;
  /**
   * 这一片是预取器自己抓的时候记下的（不是当前这次播放拉的）。
   * 同样是真实网络往返，但可能已是几十秒前的事，hint 上与刚测的区分开。
   */
  prefetched?: boolean;
}

/** 太小的响应（如几十字节的 init 段探测）算出来的速度噪音极大，直接丢 */
const MIN_SAMPLE_BYTES = 8 * 1024;
/** 传输窗口太短时 performance.now 的精度误差会放大成几倍速差 */
const MIN_SAMPLE_MS = 30;

/**
 * 从一个分片的 LoaderStats 反推「真实的下载速度」。
 *
 * 为什么不用 hls 自己的 `stats.bwEstimate`：它是 `total*8000/(end-first)`，
 * 分母含首字节等待，对 2~4 秒的短分片，300ms 的 TTFB 就能把速度算低三成。
 * 这里用 end-first 单独算吞吐，ttfb 另算一行，两个数分开才看得懂。
 */
export function fragmentSpeedSample(timing: FragmentTiming): SpeedSample | null {
  const { loaded, start, first, end } = timing;
  if (!Number.isFinite(loaded) || (loaded as number) < MIN_SAMPLE_BYTES) return null;
  if (!Number.isFinite(first) || !Number.isFinite(end)) return null;
  const downloadMs = (end as number) - (first as number);
  if (downloadMs < MIN_SAMPLE_MS) return null;
  const speedBps = ((loaded as number) * 8000) / downloadMs;
  if (!Number.isFinite(speedBps) || speedBps <= 0) return null;
  const ttfb = Number.isFinite(start) && (start as number) > 0 ? (first as number) - (start as number) : undefined;
  /*
   * 首字节时延出现负值或超过 30 秒时是脏数据（时钟回拨、请求被复用），宁可不显示。
   * ttfb === 0 同样丢掉：缓存命中路径把 first 设成等于 start，0 混进中位数
   * 会把「真实往返 285ms」硬拉成个位数。
   */
  const ttfbMs = ttfb !== undefined && ttfb > 0 && ttfb < 30_000 ? ttfb : undefined;
  return { speedBps, ttfbMs };
}

/** 取中位数：均值会被一次 20 Mbps 的突发拉高，中位数才是「平时有多快」 */
function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** 采样窗口里保留多少个分片：6 个大约覆盖 15~30 秒，够稳定又跟得上网络变化 */
export const SPEED_SAMPLE_WINDOW = 6;

/** 把新样本并入滑动窗口（保留最近 window 个） */
export function pushSpeedSample(
  samples: readonly SpeedSample[],
  sample: SpeedSample | null,
  window: number = SPEED_SAMPLE_WINDOW,
): SpeedSample[] {
  if (!sample) return samples.slice(-window);
  const next = [...samples, sample];
  return next.length > window ? next.slice(next.length - window) : next;
}

/**
 * 汇总滑动窗口：速度与首字节时延都取中位数，样本数一并返回（写进面板 hint，
 * 让用户知道这个数是 3 个分片还是 6 个分片撑起来的）。
 */
export function summarizeSpeedSamples(samples: readonly SpeedSample[]): {
  speedBps?: number;
  ttfbMs?: number;
  count: number;
  /** 窗口里真正走网络的样本数：为 0 说明这几次命中全是本地缓存 */
  liveCount: number;
  /** 全是缓存样本时，它们是否都来自预取器（而不是播放时的缓存回放） */
  prefetchedOnly: boolean;
} {
  /*
   * 窗口里只要还有走网络的样本，就只统计它们。
   *
   * 缓存样本的速度是「当初预取那一刻有多快」，和此刻的网络无关；
   * 两者混在一起取中位数，会出现「四个 8 Mbps 的预取样本 + 两个 80 Mbps 的实时样本
   * 报出 8 Mbps」这种明显偏低的结果——用户看到的仍是错的数。
   * 全部都是缓存样本时才退而求其次用它们，并在文案上标明「预取实测」。
   */
  const live = samples.filter((s) => !s.cached);
  const pool = live.length > 0 ? live : samples;
  const speeds = pool.map((s) => s.speedBps).filter((v) => Number.isFinite(v) && v > 0);
  const ttfbs = live
    .map((s) => s.ttfbMs)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
  return {
    speedBps: median(speeds),
    ttfbMs: median(ttfbs),
    count: speeds.length,
    liveCount: live.length,
    prefetchedOnly: live.length === 0 && samples.length > 0 && samples.every((s) => s.prefetched === true),
  };
}

/** 网络分组：浏览器不提供任何网络信息时（Firefox/Safari）返回空数组，由调用方隐藏整组 */
export function buildNetworkRows(input: PlaybackStatsInput): StatsRow[] {
  const rows: StatsRow[] = [];
  const measuredSpeed = Number.isFinite(input.measuredSpeedBps) && (input.measuredSpeedBps as number) > 0;
  const samples = Number.isFinite(input.speedSampleCount) && (input.speedSampleCount as number) > 0
    ? Math.round(input.speedSampleCount as number)
    : 0;
  if (measuredSpeed) {
    const live = Number.isFinite(input.speedLiveCount) ? Math.max(0, Math.round(input.speedLiveCount as number)) : samples;
    const prefetchedOnly = input.speedPrefetchedOnly === true;
    rows.push({
      label: '实时下载',
      value: formatBitrate(input.measuredSpeedBps),
      /*
       * 实测吞吐才是用户真正想知道的「我这网跑这条流够不够」。
       * 预取缓存命中的样本速度仍然真实（那一片确实从这条流下载过），
       * 但它是「提前抓的时候有多快」，全命中时必须说清楚，不能让用户以为是刚测的。
       */
      hint: samples > 0 ? (live > 0 ? `近 ${samples} 个分片` : (prefetchedOnly ? '预取实测' : '缓存回放')) : '分片实测',
    });
  }
  if (Number.isFinite(input.measuredTtfbMs) && (input.measuredTtfbMs as number) > 0) {
    // 见过 1ms 这种数就明白得加个下限：低于 20ms 多半是本地缓存/SW 直接吐的，
    // 不是真的跨网往返，标出来免得用户以为自家网络比同城机房还快
    const ttfb = Math.round(input.measuredTtfbMs as number);
    rows.push({
      label: '首字节延迟',
      value: `${ttfb} ms`,
      hint: ttfb < 20 ? '疑命中本地缓存' : '分片实测',
    });
  }
  /*
   * 浏览器档位只做兜底：navigator.connection.downlink 是「有效带宽档」，
   * Chrome 对所有宽带都报同一档，实测过与真实吞吐差 16 倍。
   * 有实测值时再并列显示，只会让用户以为自己在用 1.4 Mbps 的网。
   */
  if (!measuredSpeed && Number.isFinite(input.downlinkMbps) && (input.downlinkMbps as number) > 0) {
    rows.push({
      label: '下行估速',
      value: `${(input.downlinkMbps as number).toFixed(1)} Mbps`,
      hint: '浏览器档位',
    });
  }
  if (
    !Number.isFinite(input.measuredTtfbMs) &&
    Number.isFinite(input.rttMs) &&
    (input.rttMs as number) > 0
  ) {
    rows.push({ label: '往返时延', value: `${Math.round(input.rttMs as number)} ms`, hint: '浏览器档位' });
  }
  const typeLabel = networkTypeLabel(input.effectiveType);
  // 叫「浏览器档位」而不是「网络类型」：effectiveType 报的是等效带宽档，插网线也报 4g
  if (typeLabel) rows.push({ label: '浏览器档位', value: typeLabel, hint: '等效带宽档' });
  if (input.saveData) rows.push({ label: '省流模式', value: '已开启', warn: true });
  // 缓冲余量在没有 video 元素时也会是「未知」：不塞一行没信息量的占位，
  // 整组宁可不显示（调用方会把空分组剔除）
  if (Number.isFinite(input.bufferedAhead)) {
    const health = bufferHealth(input.bufferedAhead);
    rows.push({ label: '缓冲余量', value: health.text, warn: health.warn });
  }
  return rows;
}

/**
 * 汇总成面板要渲染的分组。空分组会被剔除，避免出现只有标题没有内容的分区。
 *
 * 关于「哪个码率更可信」：清单里的 BANDWIDTH 是源站声明的上限，
 * hls.js 的 measuredBitrate 是最近若干分片的实测吞吐——两者可能差一倍以上，
 * 所以两个都显示（分别标注），不做合并。用户关心的是「这条流声称多少 / 实际吃掉多少」。
 */
export function buildStatsGroups(input: PlaybackStatsInput): StatsGroup[] {
  const groups: StatsGroup[] = [];

  const video: StatsRow[] = [];
  const res = formatResolution(input.width, input.height);
  if (res !== '未知') video.push({ label: '分辨率', value: res });
  // 清单声明的帧率优先；没有才退回实测值，并在值旁边写清它是怎么来的
  const manifestFps = formatFrameRate(input.level?.frameRate);
  if (manifestFps !== '未知') {
    video.push({ label: '帧率', value: manifestFps });
  } else {
    const measuredFps = formatFrameRate(input.frameRateMeasured);
    if (measuredFps !== '未知') video.push({ label: '帧率', value: measuredFps, hint: '实测' });
  }
  const codec = codecLabel(input.level?.videoCodec);
  if (codec) video.push({ label: '视频编码', value: codec });

  const bitrateRows: StatsRow[] = [];
  // 多档源才有「第几档 / 共几档」的意义：单档源写个 1/1 纯属噪音
  if (
    Number.isFinite(input.level?.levelCount) &&
    (input.level?.levelCount as number) > 1 &&
    Number.isFinite(input.level?.levelIndex) &&
    (input.level?.levelIndex as number) >= 0
  ) {
    bitrateRows.push({
      label: '档位',
      value: `${(input.level?.levelIndex as number) + 1} / ${input.level?.levelCount} 档`,
      hint: 'hls 已选',
    });
  }
  if (Number.isFinite(input.level?.bitrate) && (input.level?.bitrate as number) > 0) {
    bitrateRows.push({ label: '声明码率', value: formatBitrate(input.level?.bitrate) });
  }
  if (Number.isFinite(input.level?.measuredBitrate) && (input.level?.measuredBitrate as number) > 0) {
    bitrateRows.push({
      label: 'ABR 估速',
      value: formatBitrate(input.level?.measuredBitrate),
      /*
       * 这是 hls 自己喂给自动选档的平滑带宽估计（含首字节等待），和网络分组里的
       * 「实时下载」（纯传输耗时口径）不是一回事：前者解释「为什么突然糊了」，
       * 后者回答「我这条网到底跑多快」。两个都留着，但名字必须区分开。
       */
      hint: 'hls 自动选档',
    });
  }
  if (bitrateRows.length > 0) video.push(...bitrateRows);
  // 丢帧是解码侧的真实卡顿证据：网速够但 GPU/CPU 解不动时，画面同样会顿
  if (Number.isFinite(input.totalFrames) && (input.totalFrames as number) > 0) {
    const total = input.totalFrames as number;
    const dropped = Number.isFinite(input.droppedFrames) ? Math.max(0, input.droppedFrames as number) : 0;
    video.push({
      label: '丢帧',
      value: `${dropped} / ${total}`,
      warn: dropped / total > 0.02,
    });
  }
  if (video.length > 0) groups.push({ title: '画面', rows: video });

  const durationRows: StatsRow[] = [];
  const dur = formatDuration(input.duration);
  if (dur !== '未知') durationRows.push({ label: '总时长', value: dur });
  if (Number.isFinite(input.currentTime) && (input.currentTime as number) > 0) {
    durationRows.push({ label: '已播放', value: formatDuration(input.currentTime) });
  }
  const audioCodec = codecLabel(input.level?.audioCodec);
  if (audioCodec) durationRows.push({ label: '音频编码', value: audioCodec });
  if (durationRows.length > 0) groups.push({ title: '音频与时长', rows: durationRows });

  const network = buildNetworkRows(input);
  if (network.length > 0) groups.push({ title: '网络', rows: network });

  return groups;
}

/**
 * 把面板内容拍平成纯文本，供「复制」按钮与用户贴进聊天窗口排障。
 *
 * 用纯文本而不是 JSON：用户求助时贴出来的是人话，而不是一堆键值对；
 * 同时保留 hint（「hls ABR」「估算值」这些限定词不能丢，否则数字会被误读）。
 */
export function statsToText(groups: StatsGroup[], title?: string): string {
  const lines: string[] = [];
  if (title && title.trim()) lines.push(`【视频信息】${title.trim()}`);
  for (const group of groups) {
    lines.push('', group.title);
    for (const row of group.rows) {
      const hint = row.hint ? `（${row.hint}）` : '';
      lines.push(`${row.label}：${row.value}${hint}${row.warn ? ' ⚠' : ''}`);
    }
  }
  return lines.join('\n').trimStart();
}
