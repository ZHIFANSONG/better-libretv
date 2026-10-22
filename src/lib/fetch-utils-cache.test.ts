import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getCache, setCache, cacheSize, clearCache } from './fetch-utils';

describe('内存 TTL 缓存', () => {
  beforeEach(() => {
    clearCache();
    vi.useRealTimers();
  });

  it('写入后可读，过期后读不到并自动删除', () => {
    vi.useFakeTimers();
    setCache('a', 1, 1000);
    expect(getCache<number>('a')).toBe(1);
    vi.advanceTimersByTime(1500);
    expect(getCache<number>('a')).toBeUndefined();
    expect(cacheSize()).toBe(0);
  });

  it('超限时逐出最早过期的条目，不清空整表', () => {
    // 500 条长 TTL 的热点数据
    for (let i = 0; i < 500; i += 1) setCache('hot' + i, i, 60_000);
    expect(cacheSize()).toBe(500);

    // 再塞一条新数据：应逐出「最早过期」的一条，其余 499 条热点必须还在。
    // 旧实现在这里走 cache.clear()，把全部热点一起丢掉。
    setCache('fresh', 'v', 60_000);
    expect(cacheSize()).toBe(500);
    expect(getCache<number>('hot1')).toBe(1);
    expect(getCache<string>('fresh')).toBe('v');
  });

  it('超限时优先清掉已过期的条目', () => {
    vi.useFakeTimers();
    for (let i = 0; i < 500; i += 1) setCache('short' + i, i, 1000);
    vi.advanceTimersByTime(2000); // 全部过期但仍在表里
    setCache('fresh', 'v', 60_000);
    // 过期条目被清掉，表里只剩新写入的那条
    expect(cacheSize()).toBe(1);
    expect(getCache<string>('fresh')).toBe('v');
  });
});
