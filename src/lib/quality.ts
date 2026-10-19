/**
 * 画质工具：缓存键、展示标签、高度推断、缓存合并。
 *
 * 画质信息不在 CMS 搜索接口里，只存在于 m3u8 内部（#EXT-X-STREAM-INF 的 RESOLUTION），
 * 因此只能「探测」（拉 m3u8 解析）或「实测」（播放器解码后读 videoHeight）。
 * 本模块只负责这两个来源产出的高度值如何命名与存放，不负责获取。
 */

import type { QualityEntry } from './types';

/** 画质缓存有效期：源站换片源的概率低，30 天内直接复用 */
export const QUALITY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 探测失败结果的缓存有效期。
 * 失败原因多为瞬时（超时/限流/防盗链偶发拒绝），不能像成功结果那样存 30 天，
 * 否则偶发失败会被当成永久结论，用户再也看不到画质。
 */
export const QUALITY_FAIL_TTL_MS = 10 * 60 * 1000;

/**
 * 条目是否仍在有效期内（唯一判定入口，写入与读取都走这里）。
 *
 * 读取路径也必须过滤：qualityMap 是持久化的，刷新页面后旧条目直接从 localStorage
 * 回到内存；而写入路径（mergeQualityEntries）只有在下次写入时才顺带清理。
 * 只清理不过滤的话，过期条目会被当成终态显示，且因为「已有结论就不再探」而永不过期。
 */
export function isQualityEntryFresh(entry: QualityEntry, now = Date.now()): boolean {
  const ttl = entry.error ? QUALITY_FAIL_TTL_MS : QUALITY_TTL_MS;
  return now - entry.timestamp < ttl;
}

/** 缓存键：按「源 + 影片」，同一源的不同剧画质不同，不能按源整体记录 */
export function qualityKey(sourceKey: string, vodId: string): string {
  return `${sourceKey}:${vodId}`;
}

/**
 * 档位容差：与档位值的偏差在此比例内才算同一档。
 *
 * 采集站普遍对片源做裁切（1920×1080 → 1924×1040、1920×960 这类），
 * 严格「必须 ≥ 档位值」会把 1040、960 都打成 720P，与用户观感相反。
 * 15% 覆盖常见的裁边与等比缩放（960 距 1080 差 11%），
 * 又足以挡住反向误判：144 不会被抬成 360P。
 */
const TIER_TOLERANCE = 0.15;

/** 档位表：高度 → 标签 */
const TIERS: ReadonlyArray<readonly [number, string]> = [
  [2160, '4K'],
  [1440, '2K'],
  [1080, '1080P'],
  [720, '720P'],
  [540, '540P'],
  [480, '480P'],
  [360, '360P'],
];

/**
 * 宽银幕 4K 的判定：宽度门槛。
 *
 * 真 4K 原盘是 3840×2160，但采集站对宽银幕电影做裁切后常见 3840×1608、
 * 3840×2024 —— 高度被裁到 1600~2040，用高度就近取档永远够不到 2160
 * （1608 距 1440 只有 11.7%，反而被标成「2K」）。因此宽度必须参与判定。
 * 3200 的门槛高于 2K（2560），低于 4K（3840）裁切后的宽度下限，
 * 再配 WIDE_4K_MIN_HEIGHT 挡住 3840×1080 这类超宽畸变片源。
 */
export const WIDE_4K_MIN_WIDTH = 3200;

/** 宽银幕 4K 的判定：高度门槛（挡住 3840×1080 的双屏/畸变片源） */
export const WIDE_4K_MIN_HEIGHT = 1400;

/**
 * 分辨率 → 展示标签：就近取档。
 * 2160 及以上统称 4K（2K/1440 单独一档，避免 1440 被误标成 1080P）。
 * 偏差超过 15% 的按原样展示（如 144 → 144P、240 → 240P）。
 *
 * width 可选：只有高度时行为与旧版一致；给了宽度才能识别裁切过的宽银幕 4K。
 */
export function qualityLabel(height?: number, width?: number): string | undefined {
  if (!height || height <= 0) return undefined;
  if (width && width >= WIDE_4K_MIN_WIDTH && height >= WIDE_4K_MIN_HEIGHT) return '4K';
  let best: readonly [number, string] | undefined;
  for (const tier of TIERS) {
    const [value] = tier;
    if (Math.abs(value - height) > value * TIER_TOLERANCE) continue;
    if (!best || Math.abs(value - height) < Math.abs(best[0] - height)) best = tier;
  }
  return best ? best[1] : `${height}P`;
}

/** 缓存条目上限（按「源 + 影片」计）：每部剧 × 每个源一条，需防无上限膨胀 */
export const QUALITY_MAX_ENTRIES = 400;

/**
 * 把新结果合并进画质缓存（纯函数，便于单测）。
 *
 * 三条优先级规则，缺一都会让用户看到错误结论：
 * 1. 实测（play）压过探测（probe）——m3u8 里写的是源站「声明」的档位，解码出来的才是真的；
 * 2. 实测之间取较大值——ABR 起播常先选低档再升档，取最大才不会被起播档位低估；
 * 3. 探测之间，已有明确档位时不被「测不出」抹掉——否则一次偶发失败会毁掉已知的好结果。
 */
export function mergeQualityEntries(
  current: Record<string, QualityEntry>,
  incoming: Record<string, QualityEntry>,
  now = Date.now()
): Record<string, QualityEntry> {
  const next: Record<string, QualityEntry> = {};
  // 过期条目顺带清理。「测不出」（无 error）是有效结论，按长 TTL 保留，
  // 否则每次展开来源面板都会白探测一遍同一个源；失败按短 TTL 淘汰，给重试留机会
  for (const [key, entry] of Object.entries(current)) {
    if (isQualityEntryFresh(entry, now)) next[key] = entry;
  }

  for (const [key, value] of Object.entries(incoming)) {
    const prev = next[key];
    if (prev?.from === 'play') {
      if (value.from !== 'play') continue;
      const win = (value.height ?? 0) > (prev.height ?? 0) ? value : prev;
      const other = win === value ? prev : value;
      // 宽度必须跟着一起留下：宽银幕 4K 靠「宽 + 高」两维判档，
      // 若被下一次缺宽度的实测覆盖，标签会从「4K」掉回「2K」
      const height = (win.height ?? other.height) || undefined;
      next[key] = { from: 'play', height, width: win.width ?? other.width, timestamp: now };
      continue;
    }
    if (prev?.from === 'probe' && value.from === 'probe' && prev.height !== undefined && value.height === undefined) {
      continue;
    }
    next[key] = value;
  }

  const overflow = Object.keys(next).length - QUALITY_MAX_ENTRIES;
  if (overflow > 0) {
    const oldest = Object.entries(next)
      .sort((a, b) => a[1].timestamp - b[1].timestamp)
      .slice(0, overflow)
      .map(([key]) => key);
    for (const key of oldest) delete next[key];
  }
  return next;
}

/**
 * 码率 → 推断高度：部分源站的 master playlist 只给 BANDWIDTH 不给 RESOLUTION。
 * 分层取自常见转码参数，仅供档位标识使用（与 m3u8-parse 的推断表保持一致）。
 */
export function inferHeightFromBitrate(bandwidth: number): number {
  const tiers: Array<[number, number]> = [
    [20_000_000, 4320],
    [10_000_000, 2160],
    [5_000_000, 1080],
    [3_000_000, 720],
    [1_500_000, 540],
    [800_000, 480],
    [400_000, 360],
  ];
  for (const [bps, height] of tiers) {
    if (bandwidth >= bps) return height;
  }
  return 240;
}
