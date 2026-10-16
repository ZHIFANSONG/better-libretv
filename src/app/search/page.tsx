'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Header } from '@/components/header';
import { DetailModal } from '@/components/detail-modal';
import { AggregatedCard, VideoCard, aggregateResults, type AggregatedGroup } from '@/components/video-card';
import { useAppStore, resolveSource, isInDisabledSubscription, isSourceDisabled } from '@/lib/store';
import { api } from '@/lib/client-api';
import type { SearchResultItem, SourceSearchOutcome } from '@/lib/types';
import { SearchHistoryDropdown, useSearchHistory } from '@/components/search-history';
import { cn, formatDisableTtl, validateSourceUrl } from '@/lib/utils';
import { useToast } from '@/components/toast';
import { EmptyState } from '@/components/states';
import { Icon } from '@/components/icon';
import { SiteFooter } from '@/components/site-footer';

/**
 * 搜索页（proposal 版）：吸顶玻璃搜索条 + 带计数的分类胶囊 + g-row 结果行列表。
 * URL 由 ?q= 驱动（兼容旧链接的 ?s=），可后退/分享；搜索状态仍由 React Query 管理。
 */
const RESULT_PAGE_SIZE = 60;

const BUCKETS = ['全部', '电影', '剧集', '动漫', '综艺'] as const;
type Bucket = (typeof BUCKETS)[number];

/** 按采集站给的 typeName 粗分桶：只用于筛选，不改变结果本身 */
function bucketOf(g: AggregatedGroup): Bucket {
  const t = `${g.typeName ?? ''}`.toLowerCase();
  if (/综艺|真人秀|脱口秀/.test(t)) return '综艺';
  if (/动漫|动画|anime/.test(t)) return '动漫';
  if (/剧|tv|连续|电视/.test(t)) return '剧集';
  if (/电影|片/.test(t)) return '电影';
  return '全部';
}

export default function SearchPage() {
  return (
    <Suspense>
      <SearchContent />
    </Suspense>
  );
}

function SearchContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { toast } = useToast();
  const urlQuery = searchParams.get('q') || searchParams.get('s') || '';

  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const selectedKeys = useAppStore((s) => s.selectedKeys);
  const yellowFilter = useAppStore((s) => s.yellowFilter);
  const sourceHealth = useAppStore((s) => s.sourceHealth);
  const subscriptions = useAppStore((s) => s.subscriptions);

  const [input, setInput] = useState(urlQuery);
  const [bucket, setBucket] = useState<Bucket>('全部');
  const [detailItem, setDetailItem] = useState<SearchResultItem | null>(null);
  const [streamedOutcomes, setStreamedOutcomes] = useState<SourceSearchOutcome[]>([]);
  /** 刚提交搜索：搜索条播一次扩散光 */
  const [surging, setSurging] = useState(false);
  const [visibleCount, setVisibleCount] = useState(RESULT_PAGE_SIZE);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchHistory = useSearchHistory(input);

  useEffect(() => {
    if (urlQuery) setInput(urlQuery);
  }, [urlQuery]);
  useEffect(() => {
    setBucket('全部');
    setVisibleCount(RESULT_PAGE_SIZE);
  }, [urlQuery]);

  const sourceName = (key: string) =>
    customAPIs.find((a) => a.key === key)?.name ?? envSources.find((a) => a.key === key)?.name ?? key;

  const selectedSources = useMemo(() => {
    const seen = new Set<string>();
    const seenUrls = new Set<string>();
    return selectedKeys
      .map((key) => resolveSource({ customAPIs, envSources }, key))
      .filter((s): s is NonNullable<typeof s> => {
        if (!s || !validateSourceUrl(s.url) || seen.has(s.key)) return false;
        // 同一地址可能同时被预置源与订阅源提供（key 不同）：按 URL 归一后只搜一次，
        // 否则同一个采集站会被并发请求两遍，结果也会重复计入统计
        const url = s.url.replace(/\/+$/, '');
        if (seenUrls.has(url)) return false;
        seen.add(s.key);
        seenUrls.add(url);
        return true;
      })
      .filter((s) => !isSourceDisabled({ sourceHealth }, s.key))
      .filter((s) => !isInDisabledSubscription({ subscriptions }, s.key));
  }, [customAPIs, envSources, selectedKeys, sourceHealth, subscriptions]);

  const disabledSources = useMemo(
    () => selectedKeys.filter((key) => isSourceDisabled({ sourceHealth }, key)),
    [selectedKeys, sourceHealth]
  );
  const offSubscriptionSources = useMemo(
    () =>
      selectedKeys.filter(
        (key) => !isSourceDisabled({ sourceHealth }, key) && isInDisabledSubscription({ subscriptions }, key)
      ),
    [selectedKeys, sourceHealth, subscriptions]
  );

  const searchQuery = useQuery({
    queryKey: ['search', urlQuery, selectedKeys, yellowFilter],
    queryFn: ({ signal }) => {
      setStreamedOutcomes([]);
      return api.search(urlQuery.slice(0, 100), selectedSources, yellowFilter, {
        signal,
        onSource: (outcome) => {
          setStreamedOutcomes((prev) => [...prev, outcome]);
          for (const ev of useAppStore.getState().recordSourceHealth([outcome])) {
            toast(
              ev.permanent
                ? `「${sourceName(ev.key)}」多次失败，已停止参与搜索，可在设置中恢复`
                : `「${sourceName(ev.key)}」连续超时/失败，已停用 ${formatDisableTtl(ev.ttlMs ?? 0)}`,
              'warning'
            );
          }
        },
      });
    },
    enabled: Boolean(urlQuery) && selectedSources.length > 0,
    staleTime: 300_000,
  });

  const runSearch = (q: string) => {
    const query = q.trim().slice(0, 100);
    if (!query) {
      toast('请输入搜索内容', 'info');
      inputRef.current?.focus();
      return;
    }
    if (selectedSources.length === 0) {
      toast('请先在设置中添加并勾选点播源', 'warning');
      return;
    }
    searchHistory.record(query);
    // 搜索动画：搜索条放一圈扩散光（.g-surging），按钮上的放大镜转起来（.go.busy）
    setSurging(true);
    window.setTimeout(() => setSurging(false), 700);
    router.push(`/search?q=${encodeURIComponent(query)}`, { scroll: false });
  };

  const pickHistory = (text: string) => {
    setInput(text);
    searchHistory.close();
    runSearch(text);
  };

  const isSearching = Boolean(urlQuery) && searchQuery.isFetching && !searchQuery.data;
  const streamedList = useMemo(() => streamedOutcomes.flatMap((o) => o.list), [streamedOutcomes]);
  const list = useMemo(
    () => searchQuery.data?.list ?? (isSearching ? streamedList : []),
    [searchQuery.data, isSearching, streamedList]
  );
  const failures =
    searchQuery.data?.failures ??
    streamedOutcomes
      .filter((o) => !o.ok)
      .map((o) => ({ sourceKey: o.sourceKey, error: o.error || '请求失败', timedOut: o.timedOut }));
  const allGroups = useMemo(() => aggregateResults(list), [list]);

  // 分类计数：全部 + 四个桶（桶外的组只在「全部」里出现，编号不重复计）
  const counts = useMemo(() => {
    const c: Record<string, number> = { 全部: allGroups.length, 电影: 0, 剧集: 0, 动漫: 0, 综艺: 0 };
    for (const g of allGroups) {
      const b = bucketOf(g);
      if (b !== '全部') c[b] += 1;
    }
    return c;
  }, [allGroups]);

  const groups = useMemo(
    () => (bucket === '全部' ? allGroups : allGroups.filter((g) => bucketOf(g) === bucket)),
    [allGroups, bucket]
  );
  const visibleGroups = useMemo(() => groups.slice(0, visibleCount), [groups, visibleCount]);

  // 「其它相关」：本次结果里不匹配当前筛选的影片，作为横向补充（仅在筛选态出现）
  const related = useMemo(
    () => (bucket === '全部' ? [] : allGroups.filter((g) => bucketOf(g) !== bucket)).slice(0, 12),
    [allGroups, bucket]
  );

  return (
    <div className="g-shell min-h-screen flex flex-col">
      <Header />

      <main className="g-page flex-1">
        <div ref={searchHistory.containerRef} className="relative">
          <form
            className={cn('g-search', searchHistory.visible && 'g-open', surging && 'g-surging')}
            glass="regular"
            glass-blur="12"
            glass-tint="rgba(255,255,255,.07)"
            onSubmit={(e) => {
              e.preventDefault();
              runSearch(input);
            }}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden
              style={{ opacity: 0.5, flex: 'none' }}
            >
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" strokeLinecap="round" />
            </svg>
            <input
              ref={inputRef}
              placeholder="搜索影片、剧集、动漫…"
              value={input}
              maxLength={100}
              onChange={(e) => {
                setInput(e.target.value);
                searchHistory.resetActive();
              }}
              onFocus={searchHistory.onFocus}
              onKeyDown={(e) => searchHistory.onKeyDown(e, pickHistory)}
              role="combobox"
              aria-label="搜索影片"
              aria-expanded={searchHistory.visible}
              aria-controls="search-history"
              aria-autocomplete="list"
              aria-activedescendant={
                searchHistory.visible && searchHistory.activeIndex >= 0
                  ? `search-history-${searchHistory.activeIndex}`
                  : undefined
              }
            />
            {input && (
              <button
                type="button"
                className="g-ic"
                aria-label="清空"
                onClick={() => {
                  setInput('');
                  searchHistory.resetActive();
                  inputRef.current?.focus();
                }}
              >
                <Icon name="close" className="w-4 h-4" />
              </button>
            )}
            <button type="submit" className={cn('go', isSearching && 'busy')}>
              <Icon name="search" className="w-4 h-4" />
              搜索
            </button>
          </form>

          {searchHistory.visible && (
            <SearchHistoryDropdown
              id="search-history"
              matches={searchHistory.matches}
              activeIndex={searchHistory.activeIndex}
              onPick={pickHistory}
              onRemove={searchHistory.remove}
              onClearAll={searchHistory.clearAll}
            />
          )}
        </div>

        {!urlQuery ? (
          <div className="mt-10">
            <EmptyState
              icon="search"
              title="输入关键词开始搜索"
              description="一次搜索，同时问遍所有已启用的采集源，结果按影片自动合并"
              className="!py-16"
            />
          </div>
        ) : (
          <section aria-label="搜索结果">
            <div className="g-filterbar">
              <div className="g-tabs">
                {BUCKETS.map((b) => (
                  <button
                    key={b}
                    type="button"
                    className={cn('g-tab', b === bucket && 'on')}
                    aria-pressed={b === bucket}
                    onClick={() => {
                      setBucket(b);
                      setVisibleCount(RESULT_PAGE_SIZE);
                    }}
                  >
                    {b}
                    <em>{counts[b] ?? 0}</em>
                  </button>
                ))}
              </div>
              <span className="g-meta">
                {isSearching && <span className="g-pulse" aria-hidden />}
                {isSearching
                  ? `已就绪 ${streamedOutcomes.length}/${selectedSources.length} 个源…`
                  : searchQuery.data
                    ? `${allGroups.length} 部影片 · ${list.length} 条结果${failures.length ? ` · ${failures.length} 源失败` : ''}`
                    : ''}
              </span>
            </div>

            {failures.length > 0 && (
              <div className="g-panel mb-3 px-4 py-3 text-xs flex flex-wrap gap-x-3 gap-y-1">
                <span style={{ color: 'var(--t4)' }}>{isSearching ? '以下源暂时无响应：' : '部分点播源请求失败：'}</span>
                {failures.map((f) => (
                  <span key={f.sourceKey} className={f.timedOut ? 'text-warning' : ''}>
                    {f.timedOut ? '⏱' : '✗'} {sourceName(f.sourceKey)}
                    {f.timedOut ? ' 超时' : ''}
                  </span>
                ))}
              </div>
            )}

            {disabledSources.length > 0 && (
              <div className="g-panel mb-3 px-4 py-3 text-xs" style={{ color: 'var(--t4)' }}>
                {disabledSources.length} 个源因连续超时/失败已暂停参与搜索（临时停用的到期自动恢复，长期停用的需在设置中手动恢复）：
                {disabledSources.map((key) => sourceName(key)).join('、')}
              </div>
            )}

            {offSubscriptionSources.length > 0 && (
              <div className="g-panel mb-3 px-4 py-3 text-xs" style={{ color: 'var(--t4)' }}>
                {offSubscriptionSources.length} 个源所属的订阅已停用，未参与本次搜索（在设置 → 数据源订阅中可重新启用）：
                {offSubscriptionSources.map((key) => sourceName(key)).join('、')}
              </div>
            )}

            {selectedSources.length === 0 ? (
              <NoSourceGuide hasSources={customAPIs.length > 0 || envSources.length > 0} />
            ) : groups.length > 0 ? (
              <>
                {visibleGroups.map((group) => (
                  <AggregatedCard key={group.key} group={group} onOpen={(item) => setDetailItem(item)} />
                ))}
                {groups.length > visibleCount && (
                  <div className="flex justify-center mt-6">
                    <button className="g-btn" onClick={() => setVisibleCount((v) => v + RESULT_PAGE_SIZE)}>
                      加载更多（还有 {groups.length - visibleCount} 部）
                    </button>
                  </div>
                )}
              </>
            ) : isSearching ? (
              <ResultsSkeleton />
            ) : (
              <EmptyState
                icon="search"
                title="没有找到匹配的结果"
                description="请尝试其他关键词、切换分类或更换点播源"
                className="!py-16"
              />
            )}

            {related.length > 0 && (
              <>
                <h2 className="g-h2">
                  其它相关 <small>related</small>
                </h2>
                <div className="g-grid">
                  {related.map((g) => (
                    <VideoCard key={g.key} item={g.items[0]} onClick={() => setDetailItem(g.items[0])} />
                  ))}
                </div>
              </>
            )}
          </section>
        )}

        <p className="g-note mt-10">
          找不到想要的？<Link href="/" className="text-accent">回到首页</Link> 换个关键词，或在设置里增加采集源。
        </p>
      </main>

      <SiteFooter />
      <DetailModal item={detailItem} onClose={() => setDetailItem(null)} />
    </div>
  );
}

function ResultsSkeleton() {
  return (
    <div>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="g-row">
          <div className="g-th bg-chip">
            <div className="shimmer absolute inset-0" />
          </div>
          <div className="g-bd space-y-2 pt-1">
            <div className="h-4 w-1/3 rounded bg-chip animate-pulse" />
            <div className="h-3 w-3/4 rounded bg-chip animate-pulse" />
            <div className="h-3 w-1/2 rounded bg-chip animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}

function NoSourceGuide({ hasSources = false }: { hasSources?: boolean }) {
  return (
    <div className="g-panel p-10 text-center">
      <h3 className="text-content font-medium mb-2">{hasSources ? '尚未勾选点播源' : '先添加一个点播源'}</h3>
      <p className="text-sm text-muted leading-relaxed">
        {hasSources ? (
          <>点击右上角「设置」，勾选要参与搜索的点播源后重新搜索。</>
        ) : (
          <>
            LibreTV 不内置任何采集站。点击右上角「设置 → 添加 API」，填入一个 Apple CMS 采集站地址（如{' '}
            <code className="text-accent text-xs">https://example.com/api.php/provide/vod</code>），勾选后即可开始搜索。
          </>
        )}
      </p>
    </div>
  );
}
