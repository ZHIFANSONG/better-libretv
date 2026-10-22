import { describe, expect, it } from 'vitest';
import { collectSubtitleOptions, looksLikeSrt, srtToVtt } from './subtitle';

describe('srtToVtt', () => {
  it('把 SRT 逗号时间轴换成 WebVTT 的小数点', () => {
    const srt = '1\n00:00:01,000 --> 00:00:04,000\n你好\n';
    const vtt = srtToVtt(srt);
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    expect(vtt).toContain('00:00:01.000 --> 00:00:04.000');
    expect(vtt).toContain('你好');
  });

  it('输入已是 WebVTT 时原样返回', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi\n';
    expect(srtToVtt(vtt)).toBe(vtt);
  });

  it('带 BOM 的 WebVTT 也认得出', () => {
    const vtt = '\uFEFFWEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi\n';
    expect(srtToVtt(vtt)).toBe(vtt);
  });

  it('空输入也给出合法的空 WebVTT', () => {
    expect(srtToVtt('')).toBe('WEBVTT\n');
  });

  it('CRLF 归一成 LF', () => {
    const srt = '1\r\n00:00:01,000 --> 00:00:02,000\r\n嗨\r\n';
    expect(srtToVtt(srt)).not.toContain('\r');
  });
});

describe('looksLikeSrt', () => {
  it('.srt 扩展名直接判 SRT', () => {
    expect(looksLikeSrt('a.srt', '')).toBe(true);
  });
  it('.vtt 扩展名判不是 SRT', () => {
    expect(looksLikeSrt('a.vtt', '1\n00:00:01,000 --> 00:00:02,000')).toBe(false);
  });
  it('无扩展名时看内容里的逗号时间轴', () => {
    expect(looksLikeSrt('a', '1\n00:00:01,000 --> 00:00:02,000')).toBe(true);
    expect(looksLikeSrt('a', 'WEBVTT')).toBe(false);
  });
});

describe('collectSubtitleOptions', () => {
  it('合并 hls 轨道与原生轨道', () => {
    const out = collectSubtitleOptions(
      [{ name: '中文', lang: 'zh' }],
      0,
      [{ kind: 'subtitles', label: 'English', language: 'en', mode: 'showing' }]
    );
    expect(out.map((o) => o.id)).toEqual(['hls:0', 'native:0']);
    expect(out[0].active).toBe(true);
    expect(out[1].active).toBe(true);
  });

  it('跳过 metadata/chapters 这类非字幕轨', () => {
    const out = collectSubtitleOptions([], -1, [
      { kind: 'metadata', label: 'x' },
      { kind: 'chapters', label: 'y' },
    ]);
    expect(out).toHaveLength(0);
  });

  it('captions 也算字幕（部分源用这个 kind）', () => {
    const out = collectSubtitleOptions([], -1, [{ kind: 'captions', label: 'CC', mode: 'disabled' }]);
    expect(out).toHaveLength(1);
    expect(out[0].active).toBe(false);
  });

  it('没有名字时给兜底标签', () => {
    const out = collectSubtitleOptions([{}], -1, []);
    expect(out[0].label).toBe('字幕 1');
  });
});
