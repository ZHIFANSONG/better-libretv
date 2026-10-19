import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearSegmentTimings,
  recordSegmentTiming,
  segmentTimingCount,
  takeSegmentTiming,
} from './segment-timing';

const base = { loaded: 200_000, start: 1000, first: 1150, end: 1250, cached: false };

describe('分片时刻表', () => {
  beforeEach(() => clearSegmentTimings());

  it('记下后取一次就没了，避免同一片被反复当样本', () => {
    recordSegmentTiming('https://cdn.example.com/a.ts', base);
    expect(takeSegmentTiming('https://cdn.example.com/a.ts')?.loaded).toBe(200_000);
    expect(takeSegmentTiming('https://cdn.example.com/a.ts')).toBeUndefined();
  });

  it('相对地址与绝对地址收敛到同一条记录', () => {
    recordSegmentTiming('/api/proxy?url=x&n=1', base);
    // Node 里没有 location，归一化基址退化成 http://localhost
    expect(takeSegmentTiming('http://localhost/api/proxy?url=x&n=1')?.loaded).toBe(200_000);
  });

  it('超出容量时丢弃最旧的记录，Map 不会无限增长', () => {
    for (let i = 0; i < 70; i += 1) recordSegmentTiming('https://cdn.example.com/' + i + '.ts', base);
    expect(segmentTimingCount()).toBe(64);
    expect(takeSegmentTiming('https://cdn.example.com/0.ts')).toBeUndefined();
    expect(takeSegmentTiming('https://cdn.example.com/69.ts')?.loaded).toBe(200_000);
  });

  it('区分缓存命中与真实网络样本', () => {
    recordSegmentTiming('https://cdn.example.com/cached.ts', { ...base, cached: true });
    expect(takeSegmentTiming('https://cdn.example.com/cached.ts')?.cached).toBe(true);
  });
});
