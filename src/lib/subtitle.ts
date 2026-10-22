/**
 * 字幕支持。
 *
 * 现实情况：采集站的 m3u8 里几乎不带字幕轨（EXT-X-MEDIA:TYPE=SUBTITLES 一个都没有），
 * 所以「等源给字幕」这条路在真实内容上等于没有字幕。三条可落地的路径：
 *
 * 1. HLS 内嵌字幕轨：少数带字幕的源会有，hls.js 会解析成 hls.subtitleTracks。
 *    只要打开 enableWebVTT / subtitleDisplay，就能用 hls.subtitleTrack 切换。
 * 2. 浏览器原生 textTracks：<track> 元素挂上来的轨道，交给浏览器自己渲染。
 * 3. 用户本地字幕文件（.srt / .vtt）：这是唯一「一定能用」的路径 ——
 *    采集站没有，但用户手上常有对应剧集的字幕文件。
 *
 * SRT 浏览器不认（只认 WebVTT），所以第 3 条必须先转格式再挂成 blob URL。
 */

/** 把 SRT 时间轴改写成 WebVTT：SRT 的 `00:00:01,000 --> 00:00:04,000` 要换成小数点 */
export function srtToVtt(input: string): string {
  if (!input) return 'WEBVTT\n';
  // 已经是 WebVTT 就别重复加工（用户拖进来的可能就是 vtt 改了扩展名）
  if (/^\uFEFF?WEBVTT/.test(input.trimStart())) return input;
  const body = input
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    // 序号行对 WebVTT 不是必需的，留着也不影响；这里只修时间轴
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${body}`;
}

/** 按扩展名/内容判断是不是 SRT */
export function looksLikeSrt(fileName: string, head: string): boolean {
  if (/\.srt$/i.test(fileName)) return true;
  if (/\.vtt$/i.test(fileName)) return false;
  return /-->\s*\d{2}:\d{2}:\d{2},\d{3}/.test(head);
}

/** 字幕菜单里的一项 */
export interface SubtitleOption {
  /** hls 轨道用 'hls:<index>'，原生 <track> 用 'native:<index>'，本地文件用 'local:<index>' */
  id: string;
  label: string;
  /** 语言标记，展示时放在标签后面 */
  lang?: string;
  active: boolean;
}

/** 把 hls 内嵌字幕轨与浏览器原生轨道合成一份可选列表 */
export function collectSubtitleOptions(
  hlsTracks: { name?: string; lang?: string; title?: string }[] | undefined,
  hlsActive: number,
  textTracks: { kind?: string; label?: string; language?: string; mode?: string }[] | undefined
): SubtitleOption[] {
  const out: SubtitleOption[] = [];
  (hlsTracks ?? []).forEach((t, i) => {
    out.push({
      id: `hls:${i}`,
      label: t.name || t.title || `字幕 ${i + 1}`,
      lang: t.lang,
      active: hlsActive === i,
    });
  });
  (textTracks ?? []).forEach((t, i) => {
    // 只列字幕/隐藏字幕；captions 也算，metadata 之类的不是给人看的
    if (t.kind !== 'subtitles' && t.kind !== 'captions') return;
    // hls.js 在 subtitleDisplay 开启时会自己挂原生轨，这些已经由 hls 侧代表，
    // 但用户手动载入的 <track> 没有对应的 hls 轨道，必须补进来
    out.push({
      id: `native:${i}`,
      label: t.label || `字幕 ${i + 1}`,
      lang: t.language,
      active: t.mode === 'showing',
    });
  });
  return out;
}
