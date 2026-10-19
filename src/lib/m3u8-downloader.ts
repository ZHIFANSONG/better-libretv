import { parseM3u8Playlist, type ParsedPlaylist } from './m3u8-parse';
import { StreamingTransmuxer } from './mp4-transmuxer';

/**
 * 整集离线下载：
 * - 分片并发下载（默认 8），单分片 3 次重试，已下载分片写入 Cache Storage
 *   （`libretv-dl-v1` 桶）实现网络层断点——中断后续传不再耗流量；
 * - AES-128 解密用 WebCrypto AES-CBC（HLS 标准），不引入 CryptoJS；
 * - 输出：TS 直接顺序拼接；MP4 经 mux.js 流式转封装（边下边写，不聚整集）；
 * - 保存目标（FS Access / 内存）由调用方在用户手势内选好传入，本模块只管写。
 *
 * 文件层断点的现实约束：FS Access 句柄与内存 Blob 都活不过页面刷新，
 * 因此「断点续传」指网络层——刷新后重试同一任务会跳过已下载的分片，
 * 但需要用户重新选择保存位置。
 */

const DL_CACHE_NAME = 'libretv-dl-v1';
const SEGMENT_TIMEOUT_MS = 20_000;
const MAX_SEGMENT_RETRIES = 3;

export class PauseResumeController {
  private paused = false;
  private waiters: Array<() => void> = [];

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    const waiters = this.waiters.splice(0);
    for (const w of waiters) w();
  }

  getPaused(): boolean {
    return this.paused;
  }

  async waitIfPaused(): Promise<void> {
    if (!this.paused) return;
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  destroy(): void {
    this.resume();
  }
}

export interface DownloadProgress {
  current: number;
  total: number;
  percentage: number;
  status: 'downloading' | 'processing' | 'done' | 'error';
  message?: string;
}

/**
 * 分片缓存 key。Cache Storage 的 put/match 只接受 http(s) scheme——
 * 自定义字符串（如 `libretv-dl-v1:dl:...`）会被 URL 解析成同名自定义协议，
 * put 直接抛 "Request scheme ... is unsupported"。因此用一段不会被真实
 * 请求的保留域名构造合法 URL，仅作缓存 key 使用；taskId 经编码避免歧义。
 */
const DL_CHUNK_ORIGIN = 'https://dl.libretv.local';

function dlChunkKey(taskId: string, index: number): string {
  return `${DL_CHUNK_ORIGIN}/${encodeURIComponent(taskId)}/${index}`;
}

export async function clearDownloadChunks(taskId: string): Promise<void> {
  try {
    if (typeof caches === 'undefined') return;
    const cache = await caches.open(DL_CACHE_NAME);
    const keys = await cache.keys();
    const prefix = `${DL_CHUNK_ORIGIN}/${encodeURIComponent(taskId)}/`;
    await Promise.all(keys.filter((r) => r.url.startsWith(prefix)).map((r) => cache.delete(r)));
  } catch { /* 忽略 */ }
}

/**
 * 分片取回失败。retryable=false 表示确定性失败——源站根本没有这个分片（404/410）。
 * 这类缺失在采集站很常见：m3u8 完整列出了整集，但服务器上的分片是转码/上传
 * 不完整的产物。对它重试只会白等（3 次退避共 6 秒），而且最终必然失败——
 * 播放侧 hls.js 会直接跳过这类分片，所以表现为「能播、下不了」。
 */
class SegmentFetchError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
  }
}

async function fetchSegment(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const res = await fetch(url, { signal: AbortSignal.any([AbortSignal.timeout(SEGMENT_TIMEOUT_MS), signal]), headers: { Accept: '*/*' } });
  if (!res.ok) {
    // 5xx / 408 / 429 多为源站抖动或限流，值得退避重试；其余 4xx 视为确定性缺失
    const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
    throw new SegmentFetchError(`HTTP ${res.status}`, retryable);
  }
  return res.arrayBuffer();
}

/**
 * HLS AES-128 分片解密（AES-CBC / PKCS7）。
 * IV 规则（RFC 8216 §4.3.2.4）：KEY 带IV 属性时全部分片共用；**无 IV 属性时
 * IV = 分片的媒体序列号（16 字节大端）**，逐分片递增——恒用零向量会导致
 * 首片恰好正确、后续全部解密失败。
 */
function ivForSegment(mediaSequence: number, segmentIndexZeroBased: number): Uint8Array {
  const seq = BigInt(mediaSequence + segmentIndexZeroBased);
  const iv = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    iv[15 - i] = Number((seq >> BigInt(8 * i)) & 0xffn);
  }
  return iv;
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.padStart(32, '0').slice(0, 32).match(/.{2}/g)!.map((h) => parseInt(h, 16)));
}

export async function decryptSegment(
  data: ArrayBuffer,
  key: BufferSource,
  ivHex: string | undefined,
  mediaSequence: number,
  segmentIndexZeroBased: number
): Promise<ArrayBuffer> {
  const iv = ivHex ? hexToBytes(ivHex) : ivForSegment(mediaSequence, segmentIndexZeroBased);
  const cryptoKey = await crypto.subtle.importKey('raw', key, 'AES-CBC', false, ['decrypt']);
  return crypto.subtle.decrypt({ name: 'AES-CBC', iv: iv as BufferSource }, cryptoKey, data);
}

export interface DownloadJobOptions {
  taskId: string;
  url: string;
  title: string;
  format: 'TS' | 'MP4';
  concurrency?: number;
  signal: AbortSignal;
  pause: PauseResumeController;
  onProgress: (p: DownloadProgress) => void;
  /** 在用户手势内选好的保存目标 */
  target: import('./download-saver').SaveTarget;
}

/**
 * 执行一次整集下载。调用方（DownloadManager）负责：
 * 在用户手势内 pickSaveTarget、构造 AbortSignal/PauseResumeController、
 * 更新 Dexie 任务状态；本函数只负责解析 → 并发下载 → 顺序写出。
 */
export async function runDownloadJob(opts: DownloadJobOptions): Promise<void> {
  const { taskId, url, format, signal, pause, onProgress, target } = opts;
  const concurrency = Math.min(Math.max(opts.concurrency ?? 8, 1), 16);

  // 内部硬停控制器：任一 worker 判失败就掐掉其余 worker。否则 Promise.all 已经
  // reject、任务早已标记失败，后台 worker 还在继续请求分片耗流量。与外部 signal
  // 组合后，用户取消（外部 abort）的语义保持不变。
  const hardStop = new AbortController();
  const jobSignal = AbortSignal.any([signal, hardStop.signal]);

  const report = (current: number, total: number, status: DownloadProgress['status'], message?: string) => {
    onProgress({
      current,
      total,
      percentage: total > 0 ? Math.round((current / total) * 100) : 0,
      status,
      message,
    });
  };

  // —— 解析（重试 2 次） ——
  let parsed: ParsedPlaylist;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      parsed = await parseM3u8Playlist(url, 0, undefined, { stripLeadAd: true });
      lastErr = undefined;
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr || !parsed!) {
    throw new Error(`播放列表解析失败：${lastErr instanceof Error ? lastErr.message : '未知错误'}`);
  }
  if (parsed.byterange) throw new Error('该集使用 BYTERANGE 分片，暂不支持下载');

  const total = parsed.segments.length;
  report(0, total, 'downloading');

  // —— AES key 预取 ——
  let aesKey: ArrayBuffer | undefined;
  if (parsed.aesConf) {
    const res = await fetch(parsed.aesConf.uri, { signal: jobSignal });
    if (!res.ok) throw new Error(`解密密钥加载失败：HTTP ${res.status}`);
    aesKey = await res.arrayBuffer();
  }

  // —— 并发下载分片（Cache Storage 断点） ——
  const cache = await caches.open(DL_CACHE_NAME);
  const chunkKey = (index: number) => dlChunkKey(taskId, index);
  let cursor = 0;
  // 恢复：统计已有分片数作为起点
  let current = 0;
  for (let i = 1; i <= total; i++) {
    if (await cache.match(new Request(chunkKey(i)))) current += 1;
  }
  report(current, total, 'downloading');

  const worker = async (): Promise<void> => {
    while (cursor < total) {
      if (jobSignal.aborted) return;
      await pause.waitIfPaused();
      const index = ++cursor; // 1 基
      if (jobSignal.aborted) return;
      await pause.waitIfPaused();
      const cached = await cache.match(new Request(chunkKey(index)));
      if (cached) {
        // 已在恢复预统计里计入，不再累加——否则续传时进度重复计数超过 100%
        continue;
      }
      const seg = parsed.segments[index - 1];
      let buffer: ArrayBuffer | undefined;
      for (let retry = 0; retry < MAX_SEGMENT_RETRIES; retry++) {
        if (jobSignal.aborted) return;
        try {
          buffer = await fetchSegment(seg.url, jobSignal);
          break;
        } catch (err) {
          if (jobSignal.aborted) return;
          // 源站没有这片（404/410 等 4xx）：重试再多次也是同样结果。立刻整集失败
          // 并把原因说清楚——用户需要的是「换源」，不是白等 6 秒后一句笼统的失败
          if (err instanceof SegmentFetchError && !err.retryable) {
            throw new Error(`分片 ${index} 源站缺失（${err.message}），该来源无法完整下载，建议更换来源`);
          }
          await new Promise((r) => setTimeout(r, 1000 * (retry + 1)));
        }
      }
      if (!buffer) {
        throw new Error(`分片 ${index} 下载失败（已重试 ${MAX_SEGMENT_RETRIES} 次）`);
      }
      try {
        await cache.put(
          new Request(chunkKey(index)),
          new Response(buffer.slice(0), { headers: { 'Content-Type': 'video/mp2t' } })
        );
      } catch (err) {
        // 配额不足等存储层错误：浏览器原文（QuotaExceededError）用户看不懂
        throw new Error(
          `分片缓存写入失败（浏览器存储空间可能不足）：${err instanceof Error ? err.message : String(err)}`
        );
      }
      current += 1;
      report(current, total, 'downloading');
    }
  };
  try {
    await Promise.all(Array.from({ length: concurrency }, worker));
  } catch (err) {
    // 先把在途的其它 worker 掐掉再向上抛：任务已判失败，不该继续耗流量
    hardStop.abort();
    throw err;
  }
  if (jobSignal.aborted) return;

  // —— 顺序写出（转封装 / 拼接） ——
  report(total, total, 'processing');
  if (format === 'MP4') {
    // 传入整集时长：mux.js 恒把 moov 时长写成 0xFFFFFFFF（timescale 90000
    // → 播放器显示 13:15:21），必须在写出 initSegment 前回填真实值
    const transmuxer = new StreamingTransmuxer(target, { durationSeconds: parsed.totalDuration });
    for (let i = 1; i <= total; i++) {
      if (jobSignal.aborted) return;
      await pause.waitIfPaused();
      const resp = await cache.match(new Request(chunkKey(i)));
      if (!resp) throw new Error(`分片 ${i} 缓存丢失，请重试`);
      let data = await resp.arrayBuffer();
      if (aesKey && parsed.aesConf) {
        data = await decryptSegment(data, aesKey, parsed.aesConf.iv, parsed.mediaSequence, i - 1);
      }
      await transmuxer.pushAndTransmux(new Uint8Array(data));
    }
    await transmuxer.finish();
  } else {
    for (let i = 1; i <= total; i++) {
      if (jobSignal.aborted) return;
      await pause.waitIfPaused();
      const resp = await cache.match(new Request(chunkKey(i)));
      if (!resp) throw new Error(`分片 ${i} 缓存丢失，请重试`);
      let data = await resp.arrayBuffer();
      if (aesKey && parsed.aesConf) {
        data = await decryptSegment(data, aesKey, parsed.aesConf.iv, parsed.mediaSequence, i - 1);
      }
      await target.write(new Uint8Array(data));
    }
    await target.close();
  }
  report(total, total, 'done');
}
