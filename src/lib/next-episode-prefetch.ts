/**
 * 下一集预取。
 *
 * 目的：自动连播（或手动点下一集）时，「换集 → 首个分片到达」这一段空窗最长，
 * 实测能到 1~3 秒。把下一集的「清单 + 头两个分片」提前灌进浏览器 HTTP 缓存，
 * hls.js 真正要播时直接命中缓存，起播几乎立刻。
 *
 * 为什么只预取两片而不是整集：
 * 1. 采集站分片一个 3~8 MB，整集预取会和当前正在播的流抢带宽，反而卡顿；
 * 2. 起播只需要首片进 buffer，后面的分片边播边下即可；
 * 3. 用户点「下一集」之前大概率看了很久，缓存里留太多也无意义。
 *
 * 为什么走 /api/proxy 而不是直连上游：直连会被 CORS 拦掉（浏览器不会真的写入缓存），
 * 而播放本身也全走代理，这样预取的分片 URL 与 hls.js 之后请求的完全一致，才能命中。
 */
import { PROXY_BASE } from './m3u8';

/** 预取的分片数量上限。够起播即可，多了纯抢带宽。 */
const PREFETCH_SEGMENTS = 2;
/** 整个预取任务的预算：超时即收手，别让后台任务一直挂着 */
const PREFETCH_BUDGET_MS = 20_000;

interface NetworkInformationLike {
  saveData?: boolean;
  effectiveType?: string;
}

/**
 * 该不该预取。
 * 省流模式、2G/3G 这类慢网下一律不预取 —— 抢带宽的代价远大于省下的起播时间。
 */
export function shouldPrefetch(conn?: NetworkInformationLike | null): boolean {
  if (!conn) return true;
  if (conn.saveData) return false;
  const type = conn.effectiveType;
  if (type === 'slow-2g' || type === '2g' || type === '3g') return false;
  return true;
}

/** 从媒体播放列表里取前 n 个分片地址（relative 已由代理重写成绝对本站地址） */
export function firstSegments(playlist: string, n: number): string[] {
  const out: string[] = [];
  if (!playlist) return out;
  for (const raw of playlist.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    out.push(line);
    if (out.length >= n) break;
  }
  return out;
}

/** 把上游 m3u8 地址转成本站代理地址（与播放链路完全同形，才能命中同一份缓存） */
export function proxiedPlaylistUrl(url: string): string {
  if (url.startsWith('/api/proxy')) return url;
  return PROXY_BASE + encodeURIComponent(url);
}

/**
 * 预取一集的起播资源。返回一个 abort 函数。
 *
 * 静默失败：预取是纯优化，任何环节出错都不该影响播放，所以所有异常都吞掉。
 */
export function prefetchEpisode(url: string | undefined): () => void {
  if (!url) return () => {};
  if (typeof window === 'undefined') return () => {};
  const conn = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
  if (!shouldPrefetch(conn)) return () => {};

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PREFETCH_BUDGET_MS);

  const run = async () => {
    try {
      const playlistUrl = proxiedPlaylistUrl(url);
      const res = await fetch(playlistUrl, { signal: controller.signal, credentials: 'same-origin' });
      if (!res.ok) return;
      const text = await res.text();
      // 多码率 master 的话先不深挖：起播档位由 ABR 决定，预取错档反而白下。
      // 真实场景里采集站全是单码率媒体列表，这一条分支基本不触发。
      if (text.includes('#EXT-X-STREAM-INF')) return;
      for (const segment of firstSegments(text, PREFETCH_SEGMENTS)) {
        if (controller.signal.aborted) return;
        try {
          await fetch(segment, { signal: controller.signal, credentials: 'same-origin' });
        } catch { /* 单个分片失败不影响后面的 */ }
      }
    } catch {
      /* 预取失败静默：播放链路自己有重试与换源兜底 */
    } finally {
      clearTimeout(timeout);
    }
  };

  // 等浏览器空闲再动手：正片起播阶段主线程与网络都紧张
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
  if (typeof idle === 'function') idle(() => void run(), { timeout: 3000 });
  else setTimeout(() => void run(), 1500);

  return () => {
    clearTimeout(timeout);
    controller.abort();
  };
}
