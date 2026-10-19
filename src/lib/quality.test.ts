import { describe, expect, it } from 'vitest';
import {
  QUALITY_FAIL_TTL_MS,
  QUALITY_TTL_MS,
  inferHeightFromBitrate,
  isQualityEntryFresh,
  mergeQualityEntries,
  qualityLabel,
} from './quality';
import { parseBestHeight, parseBestResolution, parseMediaPlaylist } from './quality-probe';
import type { QualityEntry } from './types';

/** master playlist 样例：三档，其中一个只有 BANDWIDTH 没有 RESOLUTION */
const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720
720/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2560000,RESOLUTION=1920x1080
1080/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=800000
480/index.m3u8
`;

describe('qualityLabel', () => {
  it('按常见档位命名', () => {
    expect(qualityLabel(2160)).toBe('4K');
    expect(qualityLabel(1440)).toBe('2K');
    expect(qualityLabel(1080)).toBe('1080P');
    expect(qualityLabel(720)).toBe('720P');
    expect(qualityLabel(540)).toBe('540P');
    expect(qualityLabel(480)).toBe('480P');
    expect(qualityLabel(360)).toBe('360P');
  });

  it('轻微裁切仍归原档：1080P 裁掉上下边还是 1080P', () => {
    expect(qualityLabel(1040)).toBe('1080P'); // 1924×1040
    expect(qualityLabel(1030)).toBe('1080P');
    expect(qualityLabel(1110)).toBe('1080P');
  });

  it('1920×960 这类 2.0:1 裁切仍算 1080P（960 不是独立档位）', () => {
    expect(qualityLabel(960)).toBe('1080P');
    expect(qualityLabel(920)).toBe('1080P');
    expect(qualityLabel(1000)).toBe('1080P');
    expect(qualityLabel(700)).toBe('720P');
    expect(qualityLabel(680)).toBe('720P');
  });

  it('偏差过大时不抬档：低分辨率不会被算成 360P', () => {
    expect(qualityLabel(144)).toBe('144P');
    expect(qualityLabel(240)).toBe('240P');
    expect(qualityLabel(800)).toBe('720P');
  });

  it('缺失或非法高度返回 undefined（前端据此显示「未知」）', () => {
    expect(qualityLabel(undefined)).toBeUndefined();
    expect(qualityLabel(0)).toBeUndefined();
  });

  it('裁切过的宽银幕 4K 靠宽度判成 4K（3840×1608 只按高度会落到 2K）', () => {
    // 真 4K 原盘 3840×2160 被裁成宽银幕：高度掉到 1600 附近，永远不会靠近 2160
    expect(qualityLabel(1608, 3840)).toBe('4K');
    expect(qualityLabel(2024, 3840)).toBe('4K');
    // 反例：2K 宽没法冒充 4K
    expect(qualityLabel(1608, 1920)).not.toBe('4K');
    expect(qualityLabel(1080, 2560)).not.toBe('4K');
    // 3840×1080 这类双屏/畸变片源：宽度够但高度太低，不能抬成 4K
    expect(qualityLabel(1080, 3840)).not.toBe('4K');
  });

  it('宽度缺失时行为与旧版一致（持久化的老条目只有 height）', () => {
    expect(qualityLabel(1608)).toBe('2K');
    expect(qualityLabel(1080, undefined)).toBe('1080P');
  });
});

describe('parseBestHeight', () => {
  it('取 master playlist 的最高档', () => {
    expect(parseBestHeight(MASTER)).toBe(1080);
  });

  it('只有 BANDWIDTH 的档位按转码参数反推高度', () => {
    const text = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=6000000
only-bandwidth.m3u8
`;
    expect(parseBestHeight(text)).toBe(inferHeightFromBitrate(6_000_000));
  });

  it('单码率媒体列表没有 STREAM-INF，返回 undefined 而非猜一个档位', () => {
    const text = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:10.0,
seg0.ts
`;
    expect(parseBestHeight(text)).toBeUndefined();
  });

  it('空文本与纯注释返回 undefined', () => {
    expect(parseBestHeight('')).toBeUndefined();
    expect(parseBestHeight('#EXTM3U\n')).toBeUndefined();
  });

  it('变体行缺失时不被上一档的声明污染', () => {
    // STREAM-INF 后紧跟另一条 STREAM-INF（异常清单）：不产生高度，避免误判
    const text = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720
#EXT-X-STREAM-INF:BANDWIDTH=2560000,RESOLUTION=1920x1080
1080/index.m3u8
`;
    expect(parseBestHeight(text)).toBe(1080);
  });

  it('取短边：源站把宽高写反（720x1280）时拿到 720 而非 1280', () => {
    // 实际采集站常见 720P 源被标成 720x1280；之前按 height 取会得到 1280 → qualityLabel 成 2K
    const text = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=720x1280
720p/index.m3u8
`;
    expect(parseBestHeight(text)).toBe(720);
  });

  it('同时给出宽度：宽银幕 4K 的 3840x1608 归一成 宽 3840 / 高 1608', () => {
    const text = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=3573000,RESOLUTION=3840x1608
4k/index.m3u8
`;
    expect(parseBestResolution(text)).toEqual({ width: 3840, height: 1608 });
    // 高度的旧口径不变，避免所有只关心高度的调用方跟着改
    expect(parseBestHeight(text)).toBe(1608);
  });

  it('只有 BANDWIDTH 的档位没有宽度：width 退成 0，不参与判档', () => {
    const text = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=6000000
only-bandwidth.m3u8
`;
    expect(parseBestResolution(text)).toEqual({ width: 0, height: inferHeightFromBitrate(6_000_000) });
  });

  it('取短边：正常的 1280x720 不受影响', () => {
    // 回归保护：取短边后档位判断与原本按 height 写在 16:9 视频上一致
    const text = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720
720p/index.m3u8
`;
    expect(parseBestHeight(text)).toBe(720);
  });
});

describe('parseMediaPlaylist', () => {
  const MEDIA = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:17
#EXT-X-MAP:URI="init.mp4"
#EXTINF:10.0,
seg0.m4s
#EXTINF:10.0,
seg1.m4s
`;

  it('取到 init segment 与第一个分片（分片解析靠这两个）', () => {
    const info = parseMediaPlaylist(MEDIA);
    expect(info.initUri).toBe('init.mp4');
    expect(info.firstSegment).toBe('seg0.m4s'); // 只取第一个，第二个不关心
  });

  it('解析媒体序列号：未显式给 IV 时它就是 IV', () => {
    expect(parseMediaPlaylist(MEDIA).mediaSequence).toBe(17);
    expect(parseMediaPlaylist('#EXTM3U\nseg.ts\n').mediaSequence).toBe(0);
  });

  it('解析 AES-128 的方法、密钥地址与十六进制 IV', () => {
    const info = parseMediaPlaylist(`#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example/key.bin",IV=0x1a2b3c4d5e6f708192a3b4c5d6e7f809
seg0.ts
`);
    expect(info.keyMethod).toBe('AES-128');
    expect(info.keyUri).toBe('https://cdn.example/key.bin');
    expect(info.keyIv).toHaveLength(16);
    expect(info.keyIv![0]).toBe(0x1a);
    expect(info.keyIv![15]).toBe(0x09);
  });

  it('SAMPLE-AES 单独识别：服务端解不开，调用方据此放弃而不是解密出错', () => {
    const info = parseMediaPlaylist('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x"\nseg.ts\n');
    expect(info.keyMethod).toBe('SAMPLE-AES');
    expect(info.keyUri).toBe('skd://x');
  });

  it('相对路径原样保留（拼接由调用方用 new URL 完成）', () => {
    expect(parseMediaPlaylist('#EXTM3U\n/2024/01/abc/index.ts\n').firstSegment).toBe('/2024/01/abc/index.ts');
  });

  it('m3u8 里没有分片时返回空，调用方据此判定测不出', () => {
    expect(parseMediaPlaylist('#EXTM3U\n#EXT-X-ENDLIST\n').firstSegment).toBeUndefined();
  });
});

describe('isQualityEntryFresh', () => {
  const T = 1_700_000_000_000;

  it('成功与「测不出」按长 TTL 判定', () => {
    const ok: QualityEntry = { height: 1080, from: 'probe', timestamp: T };
    const unknown: QualityEntry = { from: 'probe', timestamp: T };
    expect(isQualityEntryFresh(ok, T + QUALITY_TTL_MS - 1)).toBe(true);
    expect(isQualityEntryFresh(unknown, T + QUALITY_TTL_MS - 1)).toBe(true);
    expect(isQualityEntryFresh(ok, T + QUALITY_TTL_MS + 1)).toBe(false);
  });

  it('失败按短 TTL 判定：过期后允许重试', () => {
    const failed: QualityEntry = { from: 'probe', error: 'HTTP 403', timestamp: T };
    expect(isQualityEntryFresh(failed, T + QUALITY_FAIL_TTL_MS - 1)).toBe(true);
    expect(isQualityEntryFresh(failed, T + QUALITY_FAIL_TTL_MS + 1)).toBe(false);
  });

  it('读取路径靠它挡住持久化回来的过期条目', () => {
    // 刷新页面后旧条目直接从 localStorage 回到内存，写入时的清理没机会跑
    const stale: QualityEntry = { height: 720, from: 'play', timestamp: T };
    expect(isQualityEntryFresh(stale, T + QUALITY_TTL_MS * 2)).toBe(false);
  });
});

describe('mergeQualityEntries', () => {
  const T = 1_700_000_000_000;
  const probe = (height?: number, error?: string): QualityEntry => ({ height, from: 'probe', error, timestamp: T });
  const play = (height: number, width?: number): QualityEntry => ({ height, width, from: 'play', timestamp: T });
  const KEY = 'huang:123';

  it('播放实测覆盖此前的「测不出」——单码率源的画质只能这样补上', () => {
    // 先探测：单码率 m3u8，没有画质信息（无 error、无 height）
    const afterProbe = mergeQualityEntries({}, { [KEY]: probe() }, T);
    expect(afterProbe[KEY].height).toBeUndefined();

    // 播放后拿到真实解码高度
    const afterPlay = mergeQualityEntries(afterProbe, { [KEY]: play(1080) }, T + 1000);
    expect(afterPlay[KEY]).toMatchObject({ height: 1080, from: 'play' });
  });

  it('实测值不被后续探测覆盖（m3u8 里写的是声明值，不如解码值可信）', () => {
    const current = { [KEY]: play(1080) };
    const next = mergeQualityEntries(current, { [KEY]: probe(720) }, T + 1000);
    expect(next[KEY]).toMatchObject({ height: 1080, from: 'play' });
  });

  it('多次实测取较大值：ABR 起播先选低档再升档，不能被起播档位低估', () => {
    const current = { [KEY]: play(720) };
    const next = mergeQualityEntries(current, { [KEY]: play(1080) }, T + 1000);
    expect(next[KEY].height).toBe(1080);

    // 反向：后来的低档位不该把已知的高档位拉低
    const back = mergeQualityEntries(next, { [KEY]: play(540) }, T + 2000);
    expect(back[KEY].height).toBe(1080);
  });

  it('宽度跟着实测值一起留下：否则宽银幕 4K 会被下一次缺宽度的实测打回 2K', () => {
    // 第一次实测：解码出 3840×1608，标签应为 4K
    const first = mergeQualityEntries({}, { [KEY]: play(1608, 3840) }, T);
    expect(qualityLabel(first[KEY].height, first[KEY].width)).toBe('4K');

    // 同一档位再报一次（浏览器换档/重播），上报值恰好没带宽度：宽度不能丢
    const again = mergeQualityEntries(first, { [KEY]: play(1608) }, T + 1000);
    expect(again[KEY].width).toBe(3840);
    expect(qualityLabel(again[KEY].height, again[KEY].width)).toBe('4K');

    // 反向：后来报的是更低的 1080P，按「多次实测取较大值」仍要保留 4K 那一档
    const lower = mergeQualityEntries(first, { [KEY]: play(1080, 1920) }, T + 2000);
    expect(qualityLabel(lower[KEY].height, lower[KEY].width)).toBe('4K');

    // 换了更高的一档（如 2560×1440 的 2K 流不会更矮，这里取真 4K 的高度）时宽度跟着换，不留旧值
    const higher = mergeQualityEntries(first, { [KEY]: play(2160, 3840) }, T + 3000);
    expect(higher[KEY]).toMatchObject({ height: 2160, width: 3840 });
  });

  it('已有明确档位时，不被「测不出」的探测抹掉', () => {
    const current = { [KEY]: probe(1080) };
    const next = mergeQualityEntries(current, { [KEY]: probe() }, T + 1000);
    expect(next[KEY].height).toBe(1080);
  });

  it('探测失败按短 TTL 淘汰，成功与「测不出」按长 TTL 保留', () => {
    const now = T + QUALITY_FAIL_TTL_MS + 1000;
    const merged = mergeQualityEntries(
      {
        failed: probe(undefined, 'HTTP 403'),
        unknown: probe(),
        ok: probe(1080),
      },
      {},
      now
    );
    // 失败记录已过期 → 允许重试；另外两条是有效结论，不能反复重探
    expect(merged.failed).toBeUndefined();
    expect(merged.unknown).toBeDefined();
    expect(merged.ok).toBeDefined();
    // 长 TTL 到期后同样清掉
    expect(mergeQualityEntries({ ok: probe(1080) }, {}, T + QUALITY_TTL_MS + 1000).ok).toBeUndefined();
  });

  it('保留未过期条目，避免每次写入都把已有缓存丢掉', () => {
    const current = { other: probe(720) };
    const next = mergeQualityEntries(current, { [KEY]: play(1080) }, T + 1000);
    expect(next.other).toMatchObject({ height: 720 });
    expect(next[KEY]).toMatchObject({ height: 1080 });
  });

  it('超过上限时淘汰最旧条目', () => {
    const current: Record<string, QualityEntry> = {};
    for (let i = 0; i < 400; i++) {
      current[`k${i}`] = { height: 720, from: 'probe', timestamp: T + i };
    }
    const next = mergeQualityEntries(current, { fresh: { height: 1080, from: 'probe', timestamp: T + 9999 } }, T + 9999);
    expect(Object.keys(next)).toHaveLength(400);
    expect(next.k0).toBeUndefined(); // 最旧的一条被淘汰
    expect(next.fresh).toBeDefined();
  });
});
