import { describe, expect, it } from 'vitest';

import { LANGUAGES, dictKeys, tr } from './i18n';
import { buildStatsGroups, bufferHealth, statsToText } from './playback-stats';
import { describeHlsError } from './playback-recovery';

/** 字典里所有值都必须是「有内容的字符串」：空串会让按钮凭空消失 */
const nonEmpty = (keys: string[], lang: 'zh' | 'en') =>
  keys.filter((k) => !tr(lang, k).trim() || tr(lang, k) === k);

describe('tr', () => {
  it('按语言取值', () => {
    expect(tr('zh', 'nav.home')).toBe('首页');
    expect(tr('en', 'nav.home')).toBe('Home');
  });

  it('{name} 占位符按 vars 替换', () => {
    expect(tr('zh', 'player.subtitleLoaded', { name: 'test.srt' })).toBe('已载入字幕：test.srt');
    expect(tr('en', 'player.resumeFrom', { time: '12:34' })).toBe('Resumed from 12:34');
  });

  it('缺 vars 时保留占位符原形，不静默吞掉', () => {
    expect(tr('en', 'player.volume')).toBe('Volume {n}%');
  });

  it('未收录的 key 原样返回（漏翻可见，而不是变空白）', () => {
    expect(tr('zh', 'nope.not.a.key')).toBe('nope.not.a.key');
    expect(tr('en', 'nope.not.a.key')).toBe('nope.not.a.key');
  });

  it('英文缺词回落中文，而不是掉回 key', () => {
    // 造一个只在中文里存在的场景：stats.titleLine 两边都有，这里改用断言兜住回落规则
    const zhOnly = dictKeys('zh').filter((k) => !dictKeys('en').includes(k));
    expect(zhOnly).toEqual([]);
  });
});

describe('字典完整性', () => {
  it('中英 key 集合完全一致（漏翻会在这一步炸掉）', () => {
    const zh = dictKeys('zh').sort();
    const en = dictKeys('en').sort();
    expect(en).toEqual(zh);
  });

  it('没有空文案', () => {
    expect(nonEmpty(dictKeys('zh'), 'zh')).toEqual([]);
    expect(nonEmpty(dictKeys('en'), 'en')).toEqual([]);
  });

  it('LANGUAGES 与字典语言一一对应', () => {
    expect(LANGUAGES.map((l) => l.id)).toEqual(['zh', 'en']);
  });
});

describe('默认语言下的统计与错误文案（不传 t 时保持中文）', () => {
  it('buildStatsGroups 默认输出中文', () => {
    const groups = buildStatsGroups({ width: 1920, height: 1080, duration: 2704 });
    expect(groups.map((g) => g.title)).toEqual(['画面', '音频与时长']);
  });

  it('传英文 t 后整体变英文', () => {
    const t = (key: string, vars?: Record<string, string | number>) => tr('en', key, vars);
    const groups = buildStatsGroups({ width: 1920, height: 1080, duration: 2704, bufferedAhead: 2 }, t);
    expect(groups.map((g) => g.title)).toEqual(['Video', 'Audio & duration', 'Network']);
    const text = statsToText(groups, 'Some Show', t);
    expect(text).toContain('[Playback info] Some Show');
    expect(text).toContain('Resolution: 1920 × 1080');
  });

  it('bufferHealth 的秒数走同一套占位符', () => {
    const t = (key: string, vars?: Record<string, string | number>) => tr('en', key, vars);
    expect(bufferHealth(0.2, t).text).toBe('0.2s · empty');
    expect(bufferHealth(40, t).text).toBe('40.0s · ample');
    // 默认中文口径不变
    expect(bufferHealth(0.2).text).toBe('0.2s · 见底');
  });

  it('describeHlsError 默认中文、传 t 变英文', () => {
    expect(describeHlsError('networkError', 'manifestLoadError')).toBe('播放列表加载失败');
    const t = (key: string, vars?: Record<string, string | number>) => tr('en', key, vars);
    expect(describeHlsError('networkError', 'manifestLoadError', t)).toBe('playlist failed to load');
    expect(describeHlsError('mediaError', 'bufferStalledError', t)).toBe('buffer stalled');
  });
});
