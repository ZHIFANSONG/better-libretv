'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { buildWatchUrl, cn } from '@/lib/utils';
import { isSourceDisabled, resolveSource, useAppStore } from '@/lib/store';
import {
  collectSourceCandidates,
  latencyLevel,
  latencyText,
  sortCandidates,
  type SourceCandidate,
} from '@/lib/source-switch';
import { useToast } from './toast';

/**
 * 播放页侧栏「换源」卡（替代原来的「采集源」装饰卡）。
 *
 * 原来那块只是把已勾选的源名一排 <span> 铺出来，**一个都点不了**，下面唯一的按钮又和
 * 顶部「切换资源」打开同一个弹窗——用户看得到源、换不了源。现在：
 * - 每一行就是一个可以直接播的源（点击即换源，集数索引沿用）；
 * - 延迟来自播放页检测到「源连续失败」时的实时测速，以及「测速全部源」按钮；
 * - 停用/失败的源沉到底部并显示原因，不再混在可用源里误导用户。
 */

interface Props {
  title: string;
  currentSourceKey: string;
  currentVodId: string;
  currentIndex: number;
  /** 播放中致命错误的自增信号：变化即自动测速并提示换源 */
  failedSignal?: number;
  /** 当前播放源的接口地址：源 key 对不上（订阅变更/分享链接）时用它兜底 */
  sourceUrl?: string;
  /** 打开完整换源面板（把已经测到的候选传过去，省掉一轮重复搜索） */
  onMore: (candidates: SourceCandidate[]) => void;
}

export function SourceSwitchCard({
  title,
  currentSourceKey,
  currentVodId,
  currentIndex,
  failedSignal,
  sourceUrl,
  onMore,
}: Props) {
  const store = useAppStore();
  const router = useRouter();
  const { toast } = useToast();
  const [candidates, setCandidates] = useState<SourceCandidate[]>([]);
  const [testing, setTesting] = useState(false);

  const sources = useMemo(() => {
    // 与搜索页同口径：key 去重、URL 去重（同一采集站可能同时被预置源与订阅源提供）
    const seenKey = new Set<string>();
    const seenUrl = new Set<string>();
    const list = store.selectedKeys
      .map((key) => resolveSource(store, key, { url: key === currentSourceKey ? sourceUrl : undefined }))
      .filter((s): s is NonNullable<typeof s> => {
        if (!s || seenKey.has(s.key)) return false;
        seenKey.add(s.key);
        const url = s.url.replace(/\/+$/, '');
        if (seenUrl.has(url)) return false;
        seenUrl.add(url);
        return true;
      });
    // 当前播放的源来自分享链接（不在已勾选列表）时补进去，否则换源列表里会缺自己
    const current = resolveSource(store, currentSourceKey, { url: sourceUrl });
    if (current && !list.some((s) => s.key === current.key)) list.unshift(current);
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.customAPIs, store.envSources, store.selectedKeys, currentSourceKey, sourceUrl]);

  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setCandidates([]);
    setTesting(true);
    collectSourceCandidates({
      sources,
      title,
      filterAdult: store.yellowFilter,
      signal: controller.signal,
      onCandidate: (c) => {
        if (controller.signal.aborted) return;
        setCandidates((prev) => {
          const i = prev.findIndex((x) => x.source.key === c.source.key);
          if (i < 0) return [...prev, c];
          const next = [...prev];
          next[i] = c;
          return next;
        });
      },
    })
      .then((list) => {
        if (!controller.signal.aborted) setCandidates(list);
      })
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted) setTesting(false);
      });
    return () => controller.abort();
  }, [sources, title, store.yellowFilter]);

  /*
   * 进页面就自动测一轮。
   * 早前版本为了省请求，首次挂载只显示「点测速全部」的空状态 —— 用户看到的就是一块
   * 什么都不能点的装饰卡，正是这次要根治的毛病。延迟要显示出来才有意义，所以默认就测。
   * 延迟 300ms 再跑，避免和详情/剧集请求抢首屏带宽。
   */
  const booted = useRef(false);
  useEffect(() => {
    // 注意：dev 下 StrictMode 会把 effect 跑两遍（mount → cleanup → mount），
    // 所以「已跑过」的标记必须写在定时器里，不能写在调度之前 —— 否则第一遍的
    // cleanup 会把定时器清掉，第二遍又因为标记已置位直接返回，一轮都不会测。
    if (booted.current || sources.length === 0) return;
    const timer = window.setTimeout(() => {
      booted.current = true;
      run();
    }, 300);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources.length]);

  // 播放中真的失败了：重测一轮（用户需要知道现在哪个源还能用）
  const failRef = useRef(0);
  useEffect(() => {
    if (!failedSignal || failedSignal === failRef.current) return;
    failRef.current = failedSignal;
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failedSignal]);

  // 离开页面时中止在途搜索/测速
  useEffect(() => () => abortRef.current?.abort(), []);

  const sorted = useMemo(
    () => sortCandidates(candidates, { sourceKey: currentSourceKey, vodId: currentVodId }),
    [candidates, currentSourceKey, currentVodId]
  );

  const switchTo = (c: SourceCandidate) => {
    const isCurrent = c.source.key === currentSourceKey && String(c.result.vodId) === String(currentVodId);
    if (isCurrent) return;
    if (c.episodes === 0) {
      toast('该源暂无可用剧集', 'warning');
      return;
    }
    const targetIndex = c.episodes ? Math.min(currentIndex, c.episodes - 1) : 0;
    router.push(
      buildWatchUrl({
        sourceKey: c.source.key,
        vodId: c.result.vodId,
        index: targetIndex,
        title: c.result.name || title,
        sourceUrl: c.source.url,
        detail: c.source.detail,
      })
    );
  };

  return (
    <div className="g-card g-panel" glass="frosted" glass-blur="16">
      <h4>
        换源 <em>sources</em>
        <button className="g-act" onClick={run} disabled={testing} title="搜索所有已启用源并测速">
          {testing ? '测速中…' : '测速全部'}
        </button>
      </h4>

      {sorted.length > 0 ? (
        <div className="g-srclist">
          {sorted.map((c) => {
            const isCurrent = c.source.key === currentSourceKey && String(c.result.vodId) === String(currentVodId);
            const level = c.ok === false ? 'bad' : latencyLevel(c);
            const disabled = isSourceDisabled(store, c.source.key);
            return (
              <button
                key={c.source.key}
                className={cn('g-srcrow', isCurrent && 'on', disabled && 'off')}
                onClick={() => switchTo(c)}
                disabled={isCurrent}
                title={
                  disabled
                    ? `${c.source.name}（该源此前连续失败已自动停用，可在设置里恢复）`
                    : c.ok === false
                      ? `${c.source.name}：${c.error || '不可用'}`
                      : c.source.name
                }
              >
                <i className={cn('g-dot', level)} />
                <span className="g-srcrow-name">{c.source.name}</span>
                <em>{isCurrent ? '当前' : latencyText(c)}</em>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="g-srcidle">
          {testing ? (
            <p>正在搜索各源…</p>
          ) : (
            <p>共 {sources.length} 个已启用源，点「测速全部」看看哪个最快</p>
          )}
        </div>
      )}

      {sorted.length > 0 && !testing && (
        <p className="g-srcidle">
          {sorted.filter((c) => c.ok !== false).length} 个可用 ·{' '}
          {sorted.filter((c) => c.ms !== undefined).length}/{sorted.length} 已测速
          {/* 搜索没命中/直接报错的源不会进列表，这里交代一句，免得用户以为源被吞了 */}
          {sources.length > sorted.length && ` · 另有 ${sources.length - sorted.length} 个源没有这部`}
        </p>
      )}

      <button
        className="g-act"
        style={{ width: '100%', justifyContent: 'center' }}
        onClick={() => onMore(sorted)}
      >
        查看更多来源
      </button>
    </div>
  );
}
