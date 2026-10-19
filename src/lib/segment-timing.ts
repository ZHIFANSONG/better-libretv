/**
 * 分片下载时刻的记录表（「视频信息」面板测速用）。
 *
 * 为什么需要它：hls.js 拿到分片后的 stats 会随 loader.destroy() 被置空
 * （BaseLoader.destroy 里 `this.stats = null`，而 resetLoader 在 onSuccess 里就调了），
 * 等到 FRAG_LOADED 事件回调执行时已经读不到 loading 时刻。
 * 唯一能在分片加载完成的瞬间拿到 stats 的地方是自定义 loader 的 onSuccess——
 * 所以由 loader 记一笔，播放器读出来算速度。
 *
 * 为什么记在模块级的 Map 而不是 loader 实例上：hls 每次请求都 new 一个 loader，
 * 实例之间不共享状态；播放器侧只想知道「最近这些分片的耗时」，与哪个实例无关。
 *
 * 只保留真实网络往返的样本：分片本地缓存已经整块移除（见 hls-loader.ts 顶部注释），
 * 这里不再区分「缓存命中」与「实时下载」。
 */
export interface SegmentTiming {
  /** 分片字节数 */
  loaded: number;
  /** 请求发出 / 首字节 / 传输结束（performance.now 口径） */
  start: number;
  first: number;
  end: number;
  /** 最近一次被读取时的时间戳，用于淘汰，避免 Map 无限增长 */
  touchedAt: number;
}

/** 最多留存多少个分片的时刻（按加载完成顺序，超出的丢最旧） */
const MAX_ENTRIES = 64;

const timings = new Map<string, SegmentTiming>();

function normalizeUrl(url: string): string {
  try {
    return new URL(url, typeof location !== 'undefined' ? location.href : 'http://localhost').href;
  } catch {
    return url;
  }
}

/** 记录一片的加载时刻（由 hls loader 在拿到响应时调用） */
export function recordSegmentTiming(url: string, timing: Omit<SegmentTiming, 'touchedAt'>): void {
  const key = normalizeUrl(url);
  timings.set(key, { ...timing, touchedAt: Date.now() });
  while (timings.size > MAX_ENTRIES) {
    const oldest = timings.keys().next();
    if (oldest.done) break;
    timings.delete(oldest.value);
  }
}

/**
 * 取出并**移除**一片的时刻：一片只算一次样本。
 * 用掉就删是关键——拖动进度条时同一片会被再次加载，
 * 留着会拿同一次下载反复喂中位数，把窗口变成「某一片的历史耗时」。
 */
export function takeSegmentTiming(url: string): SegmentTiming | undefined {
  const key = normalizeUrl(url);
  const hit = timings.get(key);
  if (hit) timings.delete(key);
  return hit;
}

/** 测试与重建播放器用：清空全部记录 */
export function clearSegmentTimings(): void {
  timings.clear();
}

/** 仅供测试：当前记录数 */
export function segmentTimingCount(): number {
  return timings.size;
}
