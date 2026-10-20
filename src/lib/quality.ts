/**
 * 画质工具：缓存键、展示标签、高度推断、缓存合并。
 *
 * 画质信息不在 CMS 搜索接口里，只存在于 m3u8 内部（#EXT-X-STREAM-INF 的 RESOLUTION），
 * 因此只能「探测」（拉 m3u8 解析）或「实测」（播放器解码后读 videoWidth / videoHeight）。
 * 本模块只负责这两个来源产出的分辨率如何命名与存放，不负责获取。
 *
 * 判档以**宽度**为准：采集站常把 1920×1080 母带上下裁成 1920×752 再分发，
 * 按高度就近取档会把它标成 720P（见 qualityLabel 的注释）。
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
 * 采集站普遍对片源做裁切/缩放（1920×1040、1920×960、2560×1000 这类），
 * 严格「必须 ≥ 档位值」会把 1040、960 都打成 720P，与用户观感相反。
 * 15% 覆盖常见的裁边与等比缩放（960 距 1080 差 11%），
 * 又足以挡住反向误判：144 不会被抬成 360P。
 */
const TIER_TOLERANCE = 0.15;

/**
 * 档位表：**宽度** → 标签。
 *
 * 为什么按宽度而不是高度：
 * 采集站（尤其是抓院线片/宽银幕剧的源）普遍把 1920×1080 母带上下裁成 1920×752、
 * 1920×800 放在同一档位里。按高度就近取档时 752 距 720 只差 4.4%、距 1080 差 30%，
 * 于是 1080P 的片源被标成「720P」——用户看到的就是「明明是 1920×752 却显示 720P」。
 * 而宽度几乎不动（裁的是上下边），1920 稳定对应 1080P、1280 对应 720P，
 * 与源站自己的档位命名、用户对「几 P」的认知都一致。
 *
 * 档位值取 16:9 的标准宽度：360P=640、480P=854、540P=960、720P=1280、
 * 1080P=1920、2K=2560、4K=3840。
 */
const TIERS: ReadonlyArray<readonly [number, string]> = [
  [3840, '4K'],
  [2560, '2K'],
  [1920, '1080P'],
  [1280, '720P'],
  [960, '540P'],
  [854, '480P'],
  [640, '360P'],
];

/**
 * 没有宽度时退回的高度档位表（BANDWIDTH 反推的高度、只有高没有宽的老缓存、
 * 竖屏片源这类宽度不可用的场景）。
 *
 * 这条路径沿用地道的「短边」口径：720P=720、1080P=1080，
 * 不参与宽银幕裁切的判定（那种情况一定是先有宽度的）。
 */
const HEIGHT_TIERS: ReadonlyArray<readonly [number, string]> = [
  [2160, '4K'],
  [1440, '2K'],
  [1080, '1080P'],
  [720, '720P'],
  [540, '540P'],
  [480, '480P'],
  [360, '360P'],
];

/** 在档位表里就近取一档；偏差都超过容差时返回 undefined */
function nearestTier(tiers: ReadonlyArray<readonly [number, string]>, value: number): string | undefined {
  let best: readonly [number, string] | undefined;
  for (const tier of tiers) {
    const [tierValue] = tier;
    const distance = Math.abs(tierValue - value);
    if (distance > tierValue * TIER_TOLERANCE) continue;
    if (!best || distance < Math.abs(best[0] - value)) best = tier;
  }
  return best?.[1];
}

/**
 * 判档用的「宽度」：宽高里较大的那个。
 *
 * 取较大值而不是死读 width 字段，是因为采集站会把这组元数据写反
 * （1280×720 的档位标成 720x1280），竖屏短剧的真实分辨率也是「宽 < 高」。
 * 这两种情况按短边判档都会掉一档（写反的 720P 会变成 360P），
 * 归一成长边才与「720P = 1280 宽」的常识一致（quality-probe 的 parseBestResolution 同口径）。
 *
 * **只有高度时返回 0**（不是返回高度）：BANDWIDTH 反推出来的高度没有宽度维度，
 * 拿它当宽度会走错档位表（1040 高会被当成「1040 宽」判成 540P）。
 * 调用方看到 0 就知道该退回高度档位表。
 */
export function resolutionWidth(width?: number, height?: number): number {
  if (!width || width <= 0) return 0;
  const h = height && height > 0 ? height : 0;
  return Math.max(width, h);
}

/**
 * 分辨率 → 展示标签。
 *
 * 有宽度时**以宽度为准**（裁切过的宽银幕片源靠宽度才判得准）；
 * 没有宽度时才退回高度。两个方向都不够接近任何档位时按原样展示（如 144 → 144P）。
 *
 * 参数顺序是 (height, width)，与 QualityEntry / hls Levels 的既有调用方保持一致；
 * 高度缺失但宽度可用的场景（只探到 RESOLUTION 的宽银幕源）也允许传 undefined。
 */
export function qualityLabel(height?: number, width?: number): string | undefined {
  const w = resolutionWidth(width, height);
  const h = height && height > 0 ? height : 0;
  if (!w && !h) return undefined;
  // w === 0 表示压根没给宽度（只有 BANDWIDTH 反推的高度），只能走高度档位表
  // 宽度优先：1920×752 判成 1080P，而不是按高度就近落到 720P
  if (w) return nearestTier(TIERS, w) ?? `${w}P`;
  return nearestTier(HEIGHT_TIERS, h) ?? `${h}P`;
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
      // 判档以宽度为准，所以「哪一次实测更清晰」只比宽度；
      // 只在宽度都缺失（老缓存、BANDWIDTH 反推值）时才退回比高度。
      // 这里不能沿用旧的「比高度」：1920×752 的高度比 1280×1080（竖屏/写反）还矮，
      // 按高度取大会把真正的 1080P 挡在门外。
      const wins = (a: QualityEntry, b: QualityEntry) => {
        // 宽度走 resolutionWidth 归一（写反的 720x1280 与竖屏片源都按长边比），
        // 与 qualityLabel 的判档口径保持一致
        const aw = resolutionWidth(a.width, a.height);
        const bw = resolutionWidth(b.width, b.height);
        if (aw > 0 && bw > 0 && aw !== bw) return aw > bw;
        // 宽度相同（同一档重报）或都缺失时，再看高度：3840×2160 比 3840×1608 更接近母带
        return (a.height ?? 0) > (b.height ?? 0);
      };
      const win = wins(value, prev) ? value : prev;
      const other = win === value ? prev : value;
      // 宽度与高度必须成对地取「胜出那一次」的值：
      // 若把胜出的高度配上一个更矮的宽度，标签会从 1080P 掉回 720P
      next[key] = {
        from: 'play',
        height: win.height ?? other.height,
        width: win.width ?? other.width,
        timestamp: now,
      };
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
