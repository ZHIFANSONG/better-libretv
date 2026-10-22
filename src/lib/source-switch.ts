'use client';

import { api } from './client-api';
import { normalizeTitle } from './cms-parser';
import { tr } from './i18n';
import type { AppLanguage } from './store';
import type { SearchResultItem, SourceConfig, SourceSearchOutcome } from './types';

/**
 * 跨源换源的共享逻辑（播放页换源卡 / 换源弹窗 / 搜索结果卡共用）。
 *
 * 两条铁律：
 * 1. **结果边到边显示**：逐源流式搜索，谁先回就先挂到列表上；测速也逐条完成就逐条更新。
 *    旧实现要等全部源搜索完 + 全部详情测速完才一次性渲染，用户只看到一个转圈，
 *    「想选的那个源明明已经回来了却点不了」—— 这是「搜完选不了要用哪个源」的直接原因。
 * 2. **匹配口径放得够宽**：归一化后相同 / 互为包含 / 同时命中标题里的两个字以上才保留。
 *    旧实现只认「完全同名或以标题开头」，把「后宫·甄嬛传」「甄嬛传[解说]」这类同剧异名全丢掉，
 *    于是换源面板经常只剩 1 个候选甚至 0 个，源明明在线却「换不了源」。
 */

export interface SourceCandidate {
  source: SourceConfig;
  result: SearchResultItem;
  /** 详情测速结果；undefined = 还在测 */
  ms?: number;
  ok?: boolean;
  /** 该源的集数（详情接口返回） */
  episodes?: number;
  /** 详情视频信息里更准确的标题 */
  title?: string;
  /** 详情失败原因 */
  error?: string;
}

/** 标题归一化（复用采集站解析里的口径：去空白/标点/符号并转小写） */
export function normTitle(s: string): string {
  return normalizeTitle(s || '');
}

/**
 * 同一部影片的宽松匹配：
 * 1. 归一化后完全相等；
 * 2. 一方包含另一方（「甄嬛传」⊃「后宫甄嬛传」「甄嬛传电影解说」）；
 * 3. 标题去掉常见后缀（解说/预告/花絮/粤语/国语/HD/BD…）后仍然相同或互相包含。
 * 不做「分词全命中」这类过度放宽——那会把《宝贝小偷与大盗》当成《小偷》。
 */
export function isSameTitle(candidate: string, target: string): boolean {
  const a = normTitle(candidate);
  const b = normTitle(target);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const strip = (s: string) => s.replace(/(电影解说|影视解说|解说|预告片?|花絮|合集|完整版|未删减|国语|粤语|粤语版|国语版|中字|高清)/g, '');
  const sa = strip(a);
  const sb = strip(b);
  if (!sa || !sb) return false;
  return sa === sb || sa.includes(sb) || sb.includes(sa);
}

/** 在一批搜索结果里挑出与目标标题最像的那一条（同名优先，其次前缀，最后宽松匹配） */
export function pickSameItem(hits: SearchResultItem[], targetTitle: string): SearchResultItem | undefined {
  const t = normTitle(targetTitle);
  return (
    hits.find((r) => normTitle(r.name) === t) ??
    hits.find((r) => normTitle(r.name).startsWith(t)) ??
    hits.find((r) => isSameTitle(r.name, targetTitle))
  );
}

export interface CollectCandidatesOptions {
  /** 参与搜索的源（调用方负责去重/过滤） */
  sources: SourceConfig[];
  /** 目标影片标题 */
  title: string;
  filterAdult: boolean;
  signal?: AbortSignal;
  /**
   * 逐条回调：每找到一条候选（还没有测速结果）就回调一次，
   * 测速完成后用相同 sourceKey 再回调一次（带 ms/ok/episodes）。
   */
  onCandidate: (candidate: SourceCandidate) => void;
}

/**
 * 搜索所有源并逐条测速。返回最终候选列表（按测速结果排序由调用方决定）。
 * 单源失败静默跳过：换源场景下「这个源没有」和「这个源挂了」对用户是同一件事。
 */
export async function collectSourceCandidates(opts: CollectCandidatesOptions): Promise<SourceCandidate[]> {
  const { sources, title, filterAdult, signal, onCandidate } = opts;
  const bySource = new Map<string, SearchResultItem[]>();
  const emitted: SourceCandidate[] = [];
  const seen = new Set<string>();

  const emit = (c: SourceCandidate) => {
    const key = c.source.key;
    if (!seen.has(key)) {
      seen.add(key);
      emitted.push(c);
    } else {
      const i = emitted.findIndex((x) => x.source.key === key);
      if (i >= 0) emitted[i] = c;
    }
    onCandidate(c);
  };

  const test = async (c: SourceCandidate) => {
    const r = await api.detailSpeed(c.result.vodId, c.source, signal);
    if (signal?.aborted) return;
    emit({
      ...c,
      ok: r.ok,
      ms: r.ms,
      episodes: r.detail?.episodes.length ?? 0,
      title: r.detail?.videoInfo?.title,
      error: r.ok ? undefined : r.error,
    });
  };

  // 逐源结算：立刻匹配并挂到列表上（先显示、后测速）
  const handleOutcome = (outcome: SourceSearchOutcome) => {
    if (!outcome.ok) return;
    const hits = (bySource.get(outcome.sourceKey) ?? []).concat(outcome.list);
    bySource.set(outcome.sourceKey, hits);
    const source = sources.find((s) => s.key === outcome.sourceKey);
    if (!source) return;
    // 同一源可能被拆成多次事件（分页/重复事件）：已有候选就不再重测
    if (seen.has(source.key)) return;
    const picked = pickSameItem(hits, title);
    if (!picked) return;
    emit({ source, result: picked });
    void test({ source, result: picked });
  };

  const { list } = await api.search(title, sources, filterAdult, { signal, onSource: handleOutcome });

  if (signal?.aborted) return emitted;

  // 流式路径下候选已经在 onSource 里测速了；这里兜底补齐「非流式/半路断流」的情况：
  // 逐源事件没有覆盖到的源（多半是走了缓存或流被中断），用最终聚合结果再对齐一次
  const pending: SourceCandidate[] = [];
  for (const source of sources) {
    if (seen.has(source.key)) continue;
    const picked = pickSameItem(bySource.get(source.key) ?? [], title);
    if (picked) pending.push({ source, result: picked });
  }
  // 最终聚合结果里可能还有逐源流没覆盖的条目（缓存命中时只有 done 事件）
  for (const item of list) {
    if (seen.has(item.sourceKey)) continue;
    if (pending.some((p) => p.source.key === item.sourceKey)) continue;
    const source = sources.find((s) => s.key === item.sourceKey);
    if (!source || !isSameTitle(item.name, title)) continue;
    pending.push({ source, result: item });
  }
  await Promise.all(
    pending.map(async (c) => {
      if (seen.has(c.source.key)) return;
      emit(c);
      await test(c);
    })
  );

  return emitted;
}

/** 候选排序：当前源置顶 → 可用优先 → 延迟升序（未测完排在已测完之后） */
export function sortCandidates(
  list: SourceCandidate[],
  current?: { sourceKey: string; vodId?: string }
): SourceCandidate[] {
  return [...list].sort((a, b) => {
    const isCur = (c: SourceCandidate) =>
      !!current && c.source.key === current.sourceKey && (!current.vodId || String(c.result.vodId) === String(current.vodId));
    const aCur = isCur(a);
    const bCur = isCur(b);
    if (aCur !== bCur) return aCur ? -1 : 1;
    const rank = (c: SourceCandidate) => (c.ok === false ? 2 : c.ok === true ? 0 : 1);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return (a.ms ?? Number.MAX_SAFE_INTEGER) - (b.ms ?? Number.MAX_SAFE_INTEGER);
  });
}

/**
 * 只要「有没有结果 / 多少毫秒」就能描述的轻量输入：
 * 换源候选（一轮完整测速）和搜索结果里每个源的耗时（一次搜索的 outcome）都满足它。
 */
export type LatencyLike = Pick<SourceCandidate, 'ok' | 'ms'>;

/**
 * 「12ms」这类短延迟文案；未测完返回「测速中」。
 * 延迟数字本身与语言无关，只有「不可用 / 测速中」两个状态词要翻，
 * 所以形参只是一个可选的界面语言（默认中文，与 tr 的默认一致）。
 */
export function latencyText(c: LatencyLike, lang: AppLanguage = 'zh'): string {
  if (c.ok === false) return tr(lang, 'ss.unavailable');
  if (c.ms === undefined) return tr(lang, 'ss.latencyPending');
  return `${c.ms}ms`;
}

/**
 * 延迟档位：<600ms 绿 / <1500ms 黄 / 更慢红。用于卡片上的小圆点，
 * 让用户不用读数字也能一眼看出哪个源最快。
 */
export function latencyLevel(c: LatencyLike): 'ok' | 'warn' | 'bad' | 'pending' {
  if (c.ok === false) return 'bad';
  if (c.ms === undefined) return 'pending';
  if (c.ms < 600) return 'ok';
  if (c.ms < 1500) return 'warn';
  return 'bad';
}
