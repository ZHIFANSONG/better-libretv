import { describe, expect, it } from 'vitest';

import {
  bufferHealth,
  bufferedAheadOf,
  buildNetworkRows,
  buildStatsGroups,
  codecLabel,
  formatBitrate,
  formatDuration,
  formatFrameRate,
  formatResolution,
  fragmentSpeedSample,
  networkInput,
  networkTypeLabel,
  pushSpeedSample,
  statsToText,
  summarizeSpeedSamples,
} from './playback-stats';

describe('播放统计：数值格式化', () => {
  it('码率按量级切换单位', () => {
    expect(formatBitrate(2_560_000)).toBe('2.56 Mbps');
    expect(formatBitrate(12_800_000)).toBe('12.8 Mbps');
    expect(formatBitrate(640_000)).toBe('640 Kbps');
  });

  it('码率缺失或非法时给出「未知」而不是 NaN', () => {
    expect(formatBitrate(undefined)).toBe('未知');
    expect(formatBitrate(0)).toBe('未知');
    expect(formatBitrate(Number.NaN)).toBe('未知');
    expect(formatBitrate(-1)).toBe('未知');
  });

  it('帧率保留 NTSC 小数，整数不带小数点', () => {
    expect(formatFrameRate(25)).toBe('25 fps');
    expect(formatFrameRate(29.97)).toBe('29.97 fps');
    expect(formatFrameRate(23.976)).toBe('23.98 fps');
    expect(formatFrameRate(0)).toBe('未知');
  });

  it('分辨率要求宽高同时有效', () => {
    expect(formatResolution(1920, 1080)).toBe('1920 × 1080');
    expect(formatResolution(1080, 1920)).toBe('1080 × 1920');
    expect(formatResolution(1920, 0)).toBe('未知');
    expect(formatResolution(undefined, 1080)).toBe('未知');
  });

  it('时长超过一小时用 h/m，否则 m/s', () => {
    expect(formatDuration(2704)).toBe('45m 04s');
    expect(formatDuration(7200)).toBe('2h 00m');
    expect(formatDuration(0)).toBe('未知');
  });

  it('缓冲余量分四档，见底与偏薄都是告警态', () => {
    expect(bufferHealth(0.2)).toEqual({ text: '0.2s · 见底', warn: true });
    expect(bufferHealth(3.4)).toEqual({ text: '3.4s · 偏薄', warn: true });
    expect(bufferHealth(9)).toEqual({ text: '9.0s · 正常', warn: false });
    expect(bufferHealth(40)).toEqual({ text: '40.0s · 充足', warn: false });
    expect(bufferHealth(undefined)).toEqual({ text: '未知', warn: false });
  });
});

describe('播放统计：编解码器与网络', () => {
  it('从 codec 串认出常见编码档位', () => {
    expect(codecLabel('avc1.640028')).toBe('H.264 High');
    expect(codecLabel('avc1.4d401f')).toBe('H.264 Main');
    expect(codecLabel('avc1.42e01e')).toBe('H.264 Baseline');
    expect(codecLabel('hvc1.1.6.L93.B0')).toBe('H.265 (HEVC)');
    expect(codecLabel('av01.0.05M.08')).toBe('AV1');
    expect(codecLabel('mp4a.40.2')).toBe('AAC');
  });

  it('认不出的编码原样返回，不硬猜', () => {
    expect(codecLabel('weird-codec-9')).toBe('weird-codec-9');
    expect(codecLabel(undefined)).toBe('');
  });

  it('有效连接类型翻译成中文，未知原样返回', () => {
    expect(networkTypeLabel('4g')).toBe('4G');
    expect(networkTypeLabel('slow-2g')).toBe('极慢');
    expect(networkTypeLabel('wifi')).toBe('wifi');
    expect(networkTypeLabel(undefined)).toBe('');
  });

  it('浏览器不给网络信息时只剩缓冲余量，不编造带宽', () => {
    const rows = buildNetworkRows({ bufferedAhead: 9 });
    expect(rows.map((r) => r.label)).toEqual(['缓冲余量']);
  });

  it('有网络信息时下行估速标注为浏览器档位', () => {
    const rows = buildNetworkRows({ downlinkMbps: 9.6, rttMs: 42, effectiveType: '4g', bufferedAhead: 12 });
    expect(rows.find((r) => r.label === '下行估速')?.hint).toBe('浏览器档位');
    expect(rows.find((r) => r.label === '往返时延')?.value).toBe('42 ms');
    expect(rows.find((r) => r.label === '缓冲余量')?.warn).toBe(false);
    // 浏览器报的 effectiveType 是带宽档不是制式，所以叫「浏览器档位」
    expect(rows.find((r) => r.label === '浏览器档位')?.value).toBe('4G');
  });

  it('有实测吞吐时不再显示浏览器的粗粒度档位，避免两个数打架', () => {
    const rows = buildNetworkRows({
      measuredSpeedBps: 22_730_000,
      measuredTtfbMs: 149.8,
      speedSampleCount: 6,
      downlinkMbps: 1.4,
      rttMs: 250,
      effectiveType: '4g',
      bufferedAhead: 12,
    });
    const labels = rows.map((r) => r.label);
    expect(labels).toContain('实时下载');
    expect(labels).not.toContain('下行估速');
    expect(labels).not.toContain('往返时延');
    expect(rows.find((r) => r.label === '实时下载')?.value).toBe('22.7 Mbps');
    expect(rows.find((r) => r.label === '实时下载')?.hint).toBe('近 6 个分片');
    expect(rows.find((r) => r.label === '首字节延迟')?.value).toBe('150 ms');
    expect(rows.find((r) => r.label === '首字节延迟')?.hint).toBe('分片实测');
  });

  it('没有实测样本时退回浏览器档位兜底', () => {
    const rows = buildNetworkRows({ downlinkMbps: 1.4, rttMs: 250, effectiveType: '4g' });
    expect(rows.find((r) => r.label === '下行估速')?.value).toBe('1.4 Mbps');
    expect(rows.some((r) => r.label === '实时下载')).toBe(false);
  });

  it('样本数缺失时 hint 不写成「近 0 个分片」', () => {
    const rows = buildNetworkRows({ measuredSpeedBps: 8_000_000 });
    expect(rows.find((r) => r.label === '实时下载')?.hint).toBe('分片实测');
  });
});

describe('播放统计：分片吞吐采样', () => {
  it('扣掉首字节等待算纯下载速度，TTFB 另算', () => {
    // 200KB 分片、首字节等了 150ms、传输 100ms → 16 Mbps，而不是 6.4 Mbps
    const sample = fragmentSpeedSample({ loaded: 200_000, start: 1000, first: 1150, end: 1250 });
    expect(sample?.speedBps).toBeCloseTo(16_000_000);
    expect(sample?.ttfbMs).toBe(150);
  });

  it('太小的响应与太短的传输窗口都丢弃', () => {
    expect(fragmentSpeedSample({ loaded: 1000, start: 0, first: 10, end: 200 })).toBeNull();
    expect(fragmentSpeedSample({ loaded: 200_000, start: 0, first: 10, end: 20 })).toBeNull();
    expect(fragmentSpeedSample({ loaded: 200_000 })).toBeNull();
  });

  it('首字节时延异常时不写这一项，但速度照算', () => {
    const sample = fragmentSpeedSample({ loaded: 200_000, start: 5000, first: 1150, end: 1250 });
    expect(sample?.speedBps).toBeCloseTo(16_000_000);
    expect(sample?.ttfbMs).toBeUndefined();
  });

  it('缓存命中的 0ms 首字节不进样本，免得把真实往返拉低', () => {
    const sample = fragmentSpeedSample({ loaded: 200_000, start: 1000, first: 1000, end: 1100 });
    expect(sample?.speedBps).toBeCloseTo(16_000_000);
    expect(sample?.ttfbMs).toBeUndefined();
  });

  it('汇总时跳过没有首字节时延的样本', () => {
    const summary = summarizeSpeedSamples([
      { speedBps: 8_000_000 },
      { speedBps: 8_500_000, ttfbMs: 285 },
      { speedBps: 9_000_000, ttfbMs: 300 },
    ]);
    expect(summary.ttfbMs).toBe(292.5);
    expect(summary.count).toBe(3);
  });

  it('滑动窗口只保留最近若干个样本', () => {
    let samples: ReturnType<typeof pushSpeedSample> = [];
    for (let i = 0; i < 10; i += 1) samples = pushSpeedSample(samples, { speedBps: (i + 1) * 1_000_000 }, 6);
    expect(samples).toHaveLength(6);
    expect(samples[samples.length - 1].speedBps).toBe(10_000_000);
  });

  it('汇总取中位数而不是均值，一次突发拉不偏它', () => {
    const summary = summarizeSpeedSamples([
      { speedBps: 2_000_000, ttfbMs: 100 },
      { speedBps: 2_200_000, ttfbMs: 120 },
      { speedBps: 60_000_000, ttfbMs: 400 },
    ]);
    expect(summary.speedBps).toBe(2_200_000);
    expect(summary.ttfbMs).toBe(120);
    expect(summary.count).toBe(3);
  });

  it('空窗口返回 undefined，让面板回退浏览器档位', () => {
    expect(summarizeSpeedSamples([])).toEqual({
      speedBps: undefined,
      ttfbMs: undefined,
      count: 0,
    });
  });

  it('hint 带上样本数，让用户知道这个数是几个分片撑起来的', () => {
    const summary = summarizeSpeedSamples([
      { speedBps: 70_000_000, ttfbMs: 320 },
      { speedBps: 80_000_000, ttfbMs: 330 },
    ]);
    const rows = buildNetworkRows({
      measuredSpeedBps: summary.speedBps,
      speedSampleCount: summary.count,
    });
    expect(rows.find((r) => r.label === '实时下载')?.hint).toBe('近 2 个分片');
  });
});

describe('播放统计：分组', () => {
  it('单码率直链只有分辨率时也要出画面组', () => {
    const groups = buildStatsGroups({ width: 1920, height: 1072, duration: 2704 });
    expect(groups.map((g) => g.title)).toEqual(['画面', '音频与时长']);
    const video = groups[0].rows.map((r) => r.label);
    expect(video).toEqual(['分辨率']);
  });

  it('声明码率与实测带宽分别显示，不合并成一个数', () => {
    const groups = buildStatsGroups({
      level: { bitrate: 2_560_000, measuredBitrate: 3_120_000, frameRate: 25 },
    });
    const rows = groups[0].rows;
    expect(rows.find((r) => r.label === '声明码率')?.value).toBe('2.56 Mbps');
    expect(rows.find((r) => r.label === 'ABR 估速')?.value).toBe('3.12 Mbps');
  });

  it('丢帧行只在有帧计数时出现，占比超过 2% 才告警', () => {
    const calm = buildStatsGroups({ width: 1280, height: 720, totalFrames: 5000, droppedFrames: 20 });
    expect(calm[0].rows.find((r) => r.label === '丢帧')).toEqual({ label: '丢帧', value: '20 / 5000', warn: false });
    const rough = buildStatsGroups({ width: 1280, height: 720, totalFrames: 5000, droppedFrames: 900 });
    expect(rough[0].rows.find((r) => r.label === '丢帧')?.warn).toBe(true);
    const none = buildStatsGroups({ width: 1280, height: 720 });
    expect(none[0].rows.some((r) => r.label === '丢帧')).toBe(false);
  });

  it('完全没有数据时不返回空分组', () => {
    const groups = buildStatsGroups({ bufferedAhead: 8 });
    expect(groups.map((g) => g.title)).toEqual(['网络']);
  });

  it('档位行只在多档源出现，单档源不写 1/1 的噪音', () => {
    const multi = buildStatsGroups({ level: { levelIndex: 2, levelCount: 6, bitrate: 2_560_000 } });
    expect(multi[0].rows.find((r) => r.label === '档位')?.value).toBe('3 / 6 档');
    const single = buildStatsGroups({ width: 1280, height: 720, level: { levelIndex: 0, levelCount: 1 } });
    expect(single[0].rows.some((r) => r.label === '档位')).toBe(false);
    // 自动档时 hls 的 currentLevel 可能是 -1（还没定档），不显示「0 / 6 档」
    const auto = buildStatsGroups({ width: 1280, height: 720, level: { levelIndex: -1, levelCount: 6 } });
    expect(auto[0].rows.some((r) => r.label === '档位')).toBe(false);
  });
});

describe('播放统计：复制为文本', () => {
  it('保留分组标题、标注与告警，不含 JSON 括号', () => {
    const groups = buildStatsGroups({
      width: 1920,
      height: 1080,
      duration: 2704,
      level: { bitrate: 2_560_000, measuredBitrate: 3_120_000, frameRate: 25 },
      bufferedAhead: 0.4,
    });
    const text = statsToText(groups, '甄嬛传 第1集');
    expect(text.startsWith('【视频信息】甄嬛传 第1集')).toBe(true);
    expect(text).toContain('画面');
    expect(text).toContain('分辨率：1920 × 1080');
    expect(text).toContain('ABR 估速：3.12 Mbps（hls 自动选档）');
    expect(text).toContain('缓冲余量：0.4s · 见底 ⚠');
    expect(text).not.toContain('{');
  });

  it('清单没写帧率时退回实测值，并标注来源', () => {
    const measured = buildStatsGroups({ width: 1920, height: 1080, frameRateMeasured: 29.97 });
    expect(measured[0].rows.find((r) => r.label === '帧率')).toEqual({
      label: '帧率',
      value: '29.97 fps',
      hint: '实测',
    });
    // 清单声明了就以清单为准，实测值不覆盖也不重复出两行
    const declared = buildStatsGroups({
      width: 1920,
      height: 1080,
      frameRateMeasured: 30,
      level: { frameRate: 25 },
    });
    expect(declared[0].rows.filter((r) => r.label === '帧率')).toEqual([{ label: '帧率', value: '25 fps' }]);
  });

  it('没标题时不留空行', () => {
    const text = statsToText(buildStatsGroups({ width: 1280, height: 720 }));
    expect(text.startsWith('画面')).toBe(true);
  });
});

describe('播放统计：缓冲与网络取值', () => {
  const fakeVideo = (ranges: Array<[number, number]>, currentTime: number) => ({
    currentTime,
    buffered: {
      length: ranges.length,
      end: (i: number) => ranges[i][1],
    },
  });

  it('多段缓冲取最靠后的结束点，不看第一段', () => {
    // 拖动后常见：0-10s 与 240-300s 两段，播到 245s 时余量是 55s 而不是负的
    expect(bufferedAheadOf(fakeVideo([[0, 10], [240, 300]], 245))).toBeCloseTo(55);
  });

  it('落在空隙里或没有缓冲时返回 undefined', () => {
    expect(bufferedAheadOf(fakeVideo([], 0))).toBeUndefined();
    expect(bufferedAheadOf(fakeVideo([[0, 10]], 120))).toBeUndefined();
  });

  it('网络信息缺项就不填，不写 0 冒充', () => {
    expect(networkInput(undefined)).toEqual({});
    expect(networkInput({ downlink: 9.6, rtt: 0, saveData: false })).toEqual({ downlinkMbps: 9.6 });
    expect(networkInput({ effectiveType: '3g', saveData: true })).toEqual({
      effectiveType: '3g',
      saveData: true,
    });
  });
});
