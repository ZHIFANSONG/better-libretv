/** 服务端上游请求工具：超时、重试、安全跳转、JSON 解析 */

import { checkLiveUrlAllowed, checkUpstreamAllowed } from './ssrf';
import { createHostGate } from './host-gate';

export interface FetchOptions extends RequestInit {
  timeoutMs?: number;
  retries?: number;
  /**
   * 安全跳转（默认开启）：禁用 fetch 的自动跟随，改为手动逐跳跟随，
   * 每一跳重新执行 SSRF 校验——否则公网 URL 可 302 跳转到内网地址绕过预检。
   */
  safeRedirects?: boolean;
  /**
   * 直播场景放行内网地址（自建 IPTV）：仅在部署者设置 LIVE_ALLOW_PRIVATE=1 时生效。
   * 校验复用 checkLiveUrlAllowed，与直播流代理使用同一把尺子。
   */
  allowPrivate?: boolean;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECT_HOPS = 5;

export interface FetchResult {
  res: Response;
  /** 跟随重定向后的最终 URL（manual 模式下 res.url 不可靠，须自行跟踪）。
   *  解析 manifest 内的相对地址必须用它，否则分片路径会指向错误目录。 */
  finalUrl: string;
}

export interface SafeRedirectOptions {
  /**
   * 直播场景放行内网地址（自建 IPTV）：仅在部署者设置 LIVE_ALLOW_PRIVATE=1 时生效。
   * 校验复用 checkLiveUrlAllowed，与直播流代理使用同一把尺子。
   */
  allowPrivate?: boolean;
  /**
   * 仅对「响应头等待」限时（直播流专用）：对整个 body 限时会切断
   * HTTP-FLV 单一无限长连接，故拿到响应头后立即清除计时器，body 不再受限。
   * 超时触发即整链失败（内部 controller 已 abort，对齐直播路由原行为）。
   */
  headerTimeoutMs?: number;
}

/**
 * 手动逐跳跟随重定向，每一跳重新执行 SSRF 校验。
 * 不能用 redirect:'follow'——预检之后 fetch 自动跟随的 3xx 可把请求
 * 带进内网/元数据地址，绕过对首跳的校验。
 */
export async function fetchWithSafeRedirects(
  url: string,
  init: Omit<RequestInit, 'redirect'> = {},
  options: SafeRedirectOptions = {}
): Promise<FetchResult> {
  const { allowPrivate = false, headerTimeoutMs } = options;
  let current = url;
  // headerTimeout 超时即 abort 内部 controller；外部 signal（调用方死线/客户端断开）链入同一 controller
  const controller = new AbortController();
  if (init.signal) {
    if (init.signal.aborted) controller.abort(init.signal.reason);
    else init.signal.addEventListener('abort', () => controller.abort(init.signal?.reason), { once: true });
  }
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    const verdict = allowPrivate
      ? await checkLiveUrlAllowed(current)
      : await checkUpstreamAllowed(current);
    if (!verdict.ok) {
      throw new Error(`跳转目标被拒绝: ${verdict.reason}`);
    }
    const timer = headerTimeoutMs ? setTimeout(() => controller.abort(), headerTimeoutMs) : null;
    let res: Response;
    try {
      res = await fetch(current, { ...init, signal: controller.signal, redirect: 'manual' });
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!REDIRECT_STATUSES.has(res.status)) return { res, finalUrl: current };
    const location = res.headers.get('location');
    if (!location) return { res, finalUrl: current };
    current = new URL(location, current).href;
  }
  throw new Error('重定向次数过多');
}

export async function fetchUpstream(url: string, options: FetchOptions = {}): Promise<Response> {
  return (await fetchUpstreamWithMeta(url, options)).res;
}

/**
 * 上游请求的全局 per-host 并发上限。
 *
 * 为什么闸门放在 fetch-utils 而不是各个路由：聚合搜索一个请求就打 N 个源 × 最多 5 页，
 * 画质探测一次 6 并发、每条还要连拉清单和分片，直播测活一次 16 并发。各路由自己的
 * CONCURRENCY 只管单次请求内部，管不住「多个用户 × 多个路由」叠加到同一个 host 上；
 * 采集站与 IPTV 服务器被这样打会直接拒绝连接甚至封 IP，表现就是「越用越红」。
 * 放在唯一的出网入口上，等于所有上游请求共享同一把尺子。
 *
 * 统计类请求（豆瓣、Bangumi）也走这里，但它们各自的 host 只有自己，不受影响。
 */
const UPSTREAM_HOST_CONCURRENCY = (() => {
  const n = parseInt(process.env.UPSTREAM_HOST_CONCURRENCY || '4', 10);
  if (!Number.isFinite(n)) return 4;
  return Math.min(32, Math.max(1, n));
})();

const upstreamGate = createHostGate(UPSTREAM_HOST_CONCURRENCY);

/** 仅供测试与运维：当前有在途名额的上游 host 数 */
export function upstreamHostCount(): number {
  return upstreamGate.activeHosts();
}

/**
 * 同 fetchUpstream，额外返回重定向后的最终 URL。
 * 所有上游请求都要先拿到「该 host 的在途名额」，名额满时 FIFO 排队（见 host-gate.ts）。
 */
export async function fetchUpstreamWithMeta(url: string, options: FetchOptions = {}): Promise<FetchResult> {
  const { timeoutMs = 8000, retries = 0, safeRedirects = true, allowPrivate = false, ...init } = options;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    // 每次尝试（含重试）都重新排队拿名额，名额在请求结束（含异常）时立刻归还，
    // 不把名额和重试睡退避绑在一起，否则排队的人会被前面的重试一起拖住。
    // 排队本身不算进超时预算：先拿到名额，再起计时，不然排 3 秒的队伍会让
    // 8 秒的上游超时只剩 5 秒，把「排队慢」误报成「上游慢」。
    const release = await upstreamGate.acquire(url, init.signal ?? undefined);
    // 外部 signal（调用方的总死线中断）与单次超时合并：任一触发即中断请求
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    try {
      if (!safeRedirects) {
        const res = await fetch(url, {
          ...init,
          signal,
          redirect: init.redirect ?? 'follow',
        });
        return { res, finalUrl: res.url || url };
      }
      // 手动逐跳跟随，每一跳重新过 SSRF 校验
      return await fetchWithSafeRedirects(url, { ...init, signal }, { allowPrivate });
    } catch (err) {
      lastError = err;
    } finally {
      release();
    }
  }
  throw lastError instanceof Error ? lastError : new Error('上游请求失败');
}


/** 内存 TTL 缓存（豆瓣推荐等热点数据） */
const cache = new Map<string, { value: unknown; expiresAt: number }>();

export function getCache<T>(key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.value as T;
}

const MAX_CACHE_ENTRIES = 500;

export function setCache(key: string, value: unknown, ttlMs: number): void {
  const now = Date.now();
  if (cache.size >= MAX_CACHE_ENTRIES) {
    // 先清过期；仍然超限时逐出「最早过期」的那一条，而不是整表 clear()。
    // clear() 会连带清掉豆瓣推荐等仍有效的热点条目 —— 一次突发写入就把所有用户
    // 的缓存打空、下一波请求全部回源，正是要避免的情形。
    for (const [k, v] of cache) {
      if (now > v.expiresAt) cache.delete(k);
    }
    while (cache.size >= MAX_CACHE_ENTRIES) {
      let oldestKey: string | undefined;
      let oldestExpiry = Infinity;
      for (const [k, v] of cache) {
        if (v.expiresAt < oldestExpiry) {
          oldestExpiry = v.expiresAt;
          oldestKey = k;
        }
      }
      if (oldestKey === undefined) break;
      cache.delete(oldestKey);
    }
  }
  cache.set(key, { value, expiresAt: now + ttlMs });
}

/** 仅供测试：当前缓存条目数 */
export function cacheSize(): number {
  return cache.size;
}

/** 仅供测试与运维：清空缓存 */
export function clearCache(): void {
  cache.clear();
}
