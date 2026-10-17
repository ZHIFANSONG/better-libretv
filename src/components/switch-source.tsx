'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { SourceConfig } from '@/lib/types';
import { buildWatchUrl, cn } from '@/lib/utils';
import { useAppStore, resolveSource } from '@/lib/store';
import { collectSourceCandidates, latencyText, sortCandidates, type SourceCandidate } from '@/lib/source-switch';
import { useToast } from './toast';
import { Icon } from './icon';
import { SmartImage } from './smart-image';
import { EmptyState } from './states';
import { useFocusTrap } from './use-focus-trap';

/**
 * 换源面板：跨源按标题搜索 → 匹配同名资源 → 逐个测速（详情接口耗时）→ 按速度排序。
 * 切换时保留当前集数索引（旧版 switchToResource 逻辑的去 DOM 化重写）。
 *
 * 旧版是「等所有源搜完 + 所有源测速完」才一次性渲染：源一多，弹窗要空转十几秒，
 * 用户连已经出来的结果都点不了。现在逐源出结果、逐源测速，先到先显示。
 */
export function SwitchSourceModal({
  currentTitle,
  currentSourceKey,
  currentVodId,
  currentIndex,
  sourceUrl,
  initialCandidates,
  onClose,
}: {
  currentTitle: string;
  currentSourceKey: string;
  currentVodId: string;
  currentIndex: number;
  /** 当前播放源的接口地址：源 key 对不上时用它兜底 */
  sourceUrl?: string;
  /** 调用方手上已有的候选（换源卡刚测过），直接沿用，避免打开弹窗又从头搜一遍 */
  initialCandidates?: SourceCandidate[];
  onClose: () => void;
}) {
  const store = useAppStore();
  const router = useRouter();
  const { toast } = useToast();
  const [candidates, setCandidates] = useState<SourceCandidate[]>(initialCandidates ?? []);
  const [phase, setPhase] = useState<'searching' | 'done'>('searching');
  /** 封面加载失败记录（按卡片 key）；失败后降级为占位图标，避免破图 */
  const [imgFailed, setImgFailed] = useState<Record<string, boolean>>({});
  const panelRef = useRef<HTMLDivElement>(null);

  // 打开时把焦点移入弹窗、Tab 圈闭在弹窗内、关闭后归还焦点
  useFocusTrap(true, panelRef);

  const sources = useMemo(() => {
    // selectedKeys 可能含历史残留的重复 key：按 key 去重，避免同源重复搜索/测速与 React key 撞车
    const seen = new Set<string>();
    return store.selectedKeys
      .map((key) => resolveSource(store, key, { url: key === currentSourceKey ? sourceUrl : undefined }))
      .filter((s): s is SourceConfig => {
        if (!s || seen.has(s.key)) return false;
        seen.add(s.key);
        return true;
      });
  }, [store, currentSourceKey, sourceUrl]);

  useEffect(() => {
    // 弹窗打开期间锁定背景滚动；Esc 关闭（与其它弹窗一致）
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  useEffect(() => {
    // 关闭弹窗时中止在途请求：否则 N 个源的搜索 + N 个详情测速会继续占用网络与后端
    const controller = new AbortController();

    collectSourceCandidates({
      sources,
      title: currentTitle,
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
      .then(() => {
        if (!controller.signal.aborted) setPhase('done');
      })
      .catch((err) => {
        // 主动中止不算失败，不提示
        const aborted = err instanceof DOMException && err.name === 'AbortError';
        if (!controller.signal.aborted && !aborted) {
          toast(err instanceof Error ? err.message : '换源搜索失败', 'error');
          setPhase('done');
        }
      });

    return () => controller.abort();
    // initialCandidates 只在挂载时取一次：它是调用方的快照，不该随对方更新重启整轮搜索
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTitle, store.yellowFilter]);

  const sorted = useMemo(
    () => sortCandidates(candidates, { sourceKey: currentSourceKey, vodId: currentVodId }),
    [candidates, currentSourceKey, currentVodId]
  );
  const ready = sorted.filter((c) => c.ms !== undefined || c.ok === false);

  const switchTo = (c: SourceCandidate) => {
    if (c.episodes === 0) {
      toast('该源无可用播放资源', 'warning');
      return;
    }
    const targetIndex = c.episodes && currentIndex < c.episodes ? currentIndex : 0;
    onClose(); // 先关闭面板，避免路由参数变化后弹窗残留旧数据
    router.push(
      buildWatchUrl({
        sourceKey: c.source.key,
        vodId: c.result.vodId,
        index: targetIndex,
        title: c.result.name || currentTitle,
        sourceUrl: c.source.url,
        detail: c.source.detail,
      })
    );
  };

  return (
    <div
      className="fixed inset-0 z-[65] flex items-start justify-center overflow-y-auto bg-black/80 py-10 px-4 animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="g-panel rounded-xl w-full max-w-3xl p-5 animate-slide-up outline-none"
        glass="frosted"
        glass-blur="14"
        overlay=""
        role="dialog"
        aria-modal="true"
        aria-label={`换源：${currentTitle}`}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-content truncate" title={currentTitle}>
              {currentTitle}
            </h2>
            <p className="text-xs text-faint">
              {sorted.length === 0
                ? phase === 'searching'
                  ? `正在搜索 ${sources.length} 个源…`
                  : '没有源返回同名资源'
                : `找到 ${sorted.length} 个来源 · ${ready.length} 个已测速 · ${sorted.filter((c) => c.ok).length} 个可用`}
              {phase === 'searching' && sorted.length > 0 && ' · 搜索中…'}
            </p>
          </div>
          <button className="p-1.5 rounded-md text-muted hover:text-content hover:bg-hover" onClick={onClose} aria-label="关闭">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {sorted.length === 0 ? (
          phase === 'searching' ? (
            <div className="py-10 text-center text-sm text-faint">
              <span className="inline-block w-4 h-4 mr-2 align-[-2px] rounded-full border-2 border-current border-r-transparent animate-spin" />
              正在搜索各资源…
            </div>
          ) : (
            <EmptyState variant="plain" title="其他点播源未找到同名资源" />
          )
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {sorted.map((c) => {
              const isCurrent = c.source.key === currentSourceKey && String(c.result.vodId) === String(currentVodId);
              const cardKey = `${c.source.key}_${c.result.vodId}`;
              const img = c.result.pic;
              const coverFailed = imgFailed[cardKey] ?? false;
              const pending = c.ms === undefined && c.ok !== false;
              return (
                <button
                  key={cardKey}
                  className={cn('text-left group relative rounded-lg overflow-hidden bg-card transition-transform', !isCurrent && 'hover:scale-[1.03] cursor-pointer', isCurrent && 'cursor-default')}
                  onClick={() => !isCurrent && switchTo(c)}
                  disabled={isCurrent}
                >
                  <div className="relative aspect-[2/3] bg-chip">
                    {img && !coverFailed ? (
                      <SmartImage
                        url={c.result.pic}
                        mode={store.imageProxyMode}
                        customProxy={store.customImageProxy}
                        alt={c.result.name}
                        className="w-full h-full object-cover"
                        onExhausted={() => setImgFailed((prev) => ({ ...prev, [cardKey]: true }))}
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-faint">
                        <Icon name="link" className="w-6 h-6" />
                      </div>
                    )}
                    <span
                      className={cn(
                        'absolute top-1.5 right-1.5 tag',
                        c.ok === false
                          ? 'bg-danger-solid/85 text-white'
                          : pending
                            ? 'bg-black/60 text-white'
                            : (c.ms ?? 0) > 2000
                              ? 'bg-warning-solid/85 text-white'
                              : 'bg-success-solid/85 text-white'
                      )}
                    >
                      {latencyText(c)}
                    </span>
                    {isCurrent && (
                      <span className="absolute inset-x-0 bottom-0 bg-accent/90 text-on-accent text-xs text-center py-1">当前播放</span>
                    )}
                  </div>
                  <div className="p-2">
                    <div className="text-xs font-medium text-content truncate" title={c.source.name}>
                      {c.source.name}
                    </div>
                    <div className="text-xs text-faint mt-0.5">
                      {c.episodes === undefined ? '测速中…' : c.episodes > 0 ? `${c.episodes} 集` : '无资源'}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
