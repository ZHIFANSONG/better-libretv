'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Header } from '@/components/header';
import { DetailModal } from '@/components/detail-modal';
import { AggregatedCard, VideoCard, aggregateResults, type AggregatedGroup } from '@/components/video-card';
import { useAppStore, resolveSource, isInDisabledSubscription, isSourceDisabled } from '@/lib/store';
import { buildWatchUrl } from '@/lib/utils';
import { addSearchHistory } from '@/lib/db';
import { api } from '@/lib/client-api';
import type { SearchResultItem, SourceSearchOutcome } from '@/lib/types';
import { SearchHistoryDropdown, useSearchHistory } from '@/components/search-history';
import { cn, formatDisableTtl, validateSourceUrl } from '@/lib/utils';
import { useToast } from '@/components/toast';
import { EmptyState } from '@/components/states';
import { Icon } from '@/components/icon';
import { SiteFooter } from '@/components/site-footer';
import { useLang, useT } from '@/components/lang-sync';
import { listSep } from '@/lib/i18n';

/**
 * 搜索页（proposal 版）：高斯模糊搜索条 + 带计数的分类胶囊 + g-rcard 结果网格（横屏 3~4 列）。
 * URL 由 ?q= 驱动（兼容旧链接的 ?s=），可后退/分享；搜索状态仍由 React Query 管理。
 */
const RESULT_PAGE_SIZE = 60;

const BUCKETS = ['all', 'movie', 'tv', 'anime', 'variety'] as const;
type Bucket = (typeof BUCKETS)[number];

/**
 * 桶 id 与文案 key 分开：id 只用于筛选与计数（跟语言无关），文案走字典。
 * 早前直接把中文当成 id，切换英文后 aria-label、计数键全部会跟着坏掉。
 */
const BUCKET_LABEL: Record<Bucket, string> = {
  all: 'bucket.all',
  movie: 'bucket.movie',
  tv: 'bucket.tv',
  anime: 'bucket.anime',
  variety: 'bucket.variety',
};

/** 按采集站给的 typeName 粗分桶：只用于筛选，不改变结果本身（typeName 是数据，恒为中文） */
function bucketOf(g: AggregatedGroup): Bucket {
  const t = `${g.typeName ?? ''}`.toLowerCase();
  if (/综艺|真人秀|脱口秀/.test(t)) return 'variety';
  if (/动漫|动画|anime/.test(t)) return 'anime';
  if (/剧|tv|连续|电视/.test(t)) return 'tv';
  if (/电影|片/.test(t)) return 'movie';
  return 'all';
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
  const t = useT();
  const urlQuery = searchParams.get('q') || searchParams.get('s') || '';

  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const selectedKeys = useAppStore((s) => s.selectedKeys);
  const yellowFilter = useAppStore((s) => s.yellowFilter);
  const sourceHealth = useAppStore((s) => s.sourceHealth);
  const subscriptions = useAppStore((s) => s.subscriptions);

  const [input, setInput] = useState(urlQuery);
  const [bucket, setBucket] = useState<Bucket>('all');
  const [detailItem, setDetailItem] = useState<SearchResultItem | null>(null);
  // 与 detailItem 配套的聚合组：弹窗里要列出这部片子的全部来源，光给一条 item 不够
  const [detailGroup, setDetailGroup] = useState<AggregatedGroup | null>(null);

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
    setBucket('all');
    setVisibleCount(RESULT_PAGE_SIZE);
  }, [urlQuery]);

  // 源名兜底：自定义源/环境源之外，还有「分享链接带进来的源」和订阅源，用 resolveSource 统一解析
  const sourceName = (key: string) =>
    resolveSource({ customAPIs, envSources }, key)?.name ??
    customAPIs.find((a) => a.key === key)?.name ??
    envSources.find((a) => a.key === key)?.name ??
    key;

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
      // 已知还在停用期内的源直接不参与：以前会把它们再打一遍、再超时一次，
      // 页面上同时还挂着「N 个源已暂停参与搜索」的提示，自相矛盾
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
                ? t('search.autoDisabled', { name: sourceName(ev.key) })
                : t('search.autoDisabledTtl', {
                    name: sourceName(ev.key),
                    ttl: formatDisableTtl(ev.ttlMs ?? 0),
                  }),
              'warning'
            );
          }
        },
      });
    },
    enabled: Boolean(urlQuery) && selectedSources.length > 0,
    staleTime: 300_000,
  });

  /**
   * 「再试一次」：先抹掉这些源的停用/失败记录，再重跑一次搜索。
   * 用户的心智模型是「这个源应该还能用」——让他能一键证明，而不是去设置里翻找。
   */
  const retryDisabledSources = (keys: string[]) => {
    const { clearSourceHealth } = useAppStore.getState();
    for (const key of keys) clearSourceHealth(key);
    void searchQuery.refetch();
  };

  const runSearch = (q: string) => {
    const query = q.trim().slice(0, 100);
    if (!query) {
      toast(t('search.emptyInput'), 'info');
      inputRef.current?.focus();
      return;
    }
    if (selectedSources.length === 0) {
      toast(t('search.noSources'), 'warning');
      return;
    }
    searchHistory.record(query);
    // 搜索动画：搜索条放一圈扩散光 + 胶囊轻微模糊呼吸（.g-surging），按钮压暗（.go.busy）
    setSurging(true);
    window.setTimeout(() => setSurging(false), 700);
    // scroll: true —— 从详情/播放页回到搜索页时，用户要看到结果列表的第一行，
    // 沿用 false 会让新搜索的结果停在视口外
    router.push(`/search?q=${encodeURIComponent(query)}`, { scroll: true });
  };

  const pickHistory = (text: string) => {
    setInput(text);
    searchHistory.close();
    runSearch(text);
  };

  // 换关键词的首帧 data 会被 v5 清成 undefined、但 isFetching 还没翻上来，
  // 用 isPending 兜住这个窗口，否则会闪一下空态（子代理审计发现）。
  const isSearching =
    Boolean(urlQuery) &&
    (searchQuery.isPending || searchQuery.isFetching) &&
    !searchQuery.data;
  const streamedList = useMemo(() => streamedOutcomes.flatMap((o) => o.list), [streamedOutcomes]);
  const list = useMemo(
    () => searchQuery.data?.list ?? (isSearching ? streamedList : []),
    [searchQuery.data, isSearching, streamedList]
  );
  const failures =
    searchQuery.data?.failures ??
    streamedOutcomes
      .filter((o) => !o.ok)
      .map((o) => ({ sourceKey: o.sourceKey, error: o.error || t('search.requestFailed'), timedOut: o.timedOut }));
  const allGroups = useMemo(() => aggregateResults(list), [list]);

  // 分类计数：全部 + 四个桶（桶外的组只在「全部」里出现，编号不重复计）
  const counts = useMemo(() => {
    const c: Record<Bucket, number> = { all: allGroups.length, movie: 0, tv: 0, anime: 0, variety: 0 };
    for (const g of allGroups) {
      const b = bucketOf(g);
      if (b !== 'all') c[b] += 1;
    }
    return c;
  }, [allGroups]);

  const groups = useMemo(
    () => (bucket === 'all' ? allGroups : allGroups.filter((g) => bucketOf(g) === bucket)),
    [allGroups, bucket]
  );
  const visibleGroups = useMemo(() => groups.slice(0, visibleCount), [groups, visibleCount]);

  /**
   * 点某个源的资源 → 直接进 /watch 播放页。
   * 早前版本在结果上方塞了半屏的就地播放器，结果一播就看不到列表、换源还得往上翻；
   * 播放页本身已经有换源卡和选集，入口统一到那里更顺。
   * 离开前记下滚动位置，返回时用 router.back() 能原样回到这批结果。
   */
  const playSource = (item: SearchResultItem, index = 0) => {
    addSearchHistory(item.name).catch(() => {});
    setDetailItem(null);
    setDetailGroup(null);
    router.push(
      buildWatchUrl({
        sourceKey: item.sourceKey,
        vodId: item.vodId,
        index,
        title: item.name,
        sourceUrl: item.sourceUrl,
      })
    );
  };

  // 「其它相关」：本次结果里不匹配当前筛选的影片，作为横向补充（仅在筛选态出现）
  const related = useMemo(
    () => (bucket === 'all' ? [] : allGroups.filter((g) => bucketOf(g) !== bucket)).slice(0, 12),
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
              placeholder={t('search.placeholder')}
              value={input}
              maxLength={100}
              onChange={(e) => {
                setInput(e.target.value);
                searchHistory.resetActive();
              }}
              onFocus={searchHistory.onFocus}
              onKeyDown={(e) => searchHistory.onKeyDown(e, pickHistory)}
              role="combobox"
              aria-label={t('search.label')}
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
                aria-label={t('search.clear')}
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
              <Icon name="search" className="go-ic w-4 h-4" />
              <span className="go-tx">{t('search.button')}</span>
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
              title={t('search.idleTitle')}
              description={t('search.idleDesc')}
              className="!py-16"
            />
          </div>
        ) : (
          <section aria-label={t('search.resultsLabel')}>
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
                    {t(BUCKET_LABEL[b])}
                    <em>{counts[b] ?? 0}</em>
                  </button>
                ))}
              </div>
              <span className="g-meta">
                {isSearching && <span className="g-pulse" aria-hidden />}
                {isSearching
                  ? t('search.streaming', {
                      done: streamedOutcomes.length,
                      total: selectedSources.length,
                    })
                  : searchQuery.data
                    ? t('search.summary', { groups: allGroups.length, rows: list.length })
                    : ''}
              </span>
            </div>

            {/*
             * 源状态提示（原来三整条横幅，加起来比结果区还高）：
             * 合并成一条可展开的细行 —— 默认只给一行摘要，点「详情」才看到逐个源名与处理方式。
             */}
            {(failures.length > 0 || disabledSources.length > 0 || offSubscriptionSources.length > 0) && (
              <SourceStatusStrip
                searching={isSearching}
                failures={failures}
                disabled={disabledSources}
                offSubscription={offSubscriptionSources}
                nameOf={sourceName}
                onRetryDisabled={retryDisabledSources}
              />
            )}

            {selectedSources.length === 0 ? (
              <NoSourceGuide hasSources={customAPIs.length > 0 || envSources.length > 0} />
            ) : groups.length > 0 ? (
              <>
                <div className="g-rows">
                  {visibleGroups.map((group) => (
                    <AggregatedCard
                      key={group.key}
                      group={group}
                      onOpen={(item, g) => {
                        setDetailGroup(g);
                        setDetailItem(item);
                      }}
                      onPlaySource={playSource}
                      sources={selectedSources}
                    />
                  ))}
                </div>
                {groups.length > visibleCount && (
                  <div className="flex justify-center mt-6">
                    <button className="g-btn" onClick={() => setVisibleCount((v) => v + RESULT_PAGE_SIZE)}>
                      {t('search.loadMore', { n: groups.length - visibleCount })}
                    </button>
                  </div>
                )}
              </>
            ) : isSearching ? (
              <ResultsSkeleton />
            ) : (
              <EmptyState
                icon="search"
                title={t('search.noneTitle')}
                description={t('search.noneDesc')}
                className="!py-16"
              />
            )}

            {related.length > 0 && (
              <>
                <h2 className="g-h2">
                  {t('search.relatedTitle', { n: related.length })} <small>related</small>
                </h2>
                <div className="g-grid">
                  {related.map((g) => (
                    <VideoCard
                      key={g.key}
                      item={g.items[0]}
                      onClick={() => {
                        setDetailGroup(g);
                        setDetailItem(g.items[0]);
                      }}
                    />
                  ))}
                </div>
              </>
            )}
          </section>
        )}

        <p className="g-note mt-10">
          {t('search.tryElseA')}
          <Link href="/" className="text-accent">
            {t('search.backHome')}
          </Link>
          {t('search.tryElseB')}
        </p>
      </main>

      <SiteFooter />
      <DetailModal
        item={detailItem}
        group={detailGroup}
        onSelectItem={(next) => setDetailItem(next)}
        onPlay={playSource}
        onClose={() => {
          setDetailItem(null);
          setDetailGroup(null);
        }}
      />
    </div>
  );
}

/**
 * 采集源状态条：把「本次失败 / 已停用 / 订阅停用」三类信息压进一行。
 * 默认只给计数摘要（用户不关心细节时不该占掉半屏），展开后才列出源名与各自的恢复方式。
 */
function SourceStatusStrip({
  searching,
  failures,
  disabled,
  offSubscription,
  nameOf,
  onRetryDisabled,
}: {
  searching: boolean;
  failures: { sourceKey: string; error?: string; timedOut?: boolean }[];
  disabled: string[];
  offSubscription: string[];
  nameOf: (key: string) => string;
  /** 「再试一次」：清掉这些源的停用记录并重新搜索 */
  onRetryDisabled: (keys: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const t = useT();
  const sep = listSep(useLang());
  const bad = failures.length + disabled.length + offSubscription.length;

  return (
    <div className="g-srcstatus">
      <button className="g-srcstatus-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <i className={cn('g-dot', bad > 0 ? 'warn' : 'ok')} />
        <span>
          {searching && failures.length > 0 ? t('search.stripFailures', { n: failures.length }) : ''}
          {searching && failures.length > 0 && (disabled.length > 0 || offSubscription.length > 0) ? ' · ' : ''}
          {disabled.length > 0 ? t('search.stripDisabled', { n: disabled.length }) : ''}
          {disabled.length > 0 && offSubscription.length > 0 ? ' · ' : ''}
          {offSubscription.length > 0 ? t('search.stripOffSub', { n: offSubscription.length }) : ''}
          {!searching && failures.length > 0 ? t('search.stripFailed', { n: failures.length }) : ''}
        </span>
        <em>{open ? t('search.stripLess') : t('search.stripMore')}</em>
      </button>
      {open && (
        <div className="g-srcstatus-body">
          {failures.length > 0 && (
            <p>
              <b>{searching ? t('search.noRespTitle') : t('search.failTitle')}</b>
              {failures
                .map((f) => `${nameOf(f.sourceKey)}${f.timedOut ? t('search.timeoutSuffix') : ''}`)
                .join(sep)}
              <s>{t('search.failHint')}</s>
            </p>
          )}
          {disabled.length > 0 && (
            <p>
              <b>{t('search.disabledTitle')}</b>
              {disabled.map(nameOf).join(sep)}
              <s>{t('search.disabledHint')}</s>
              <button className="g-act" onClick={() => onRetryDisabled(disabled)} disabled={searching}>
                {searching ? t('search.retrying') : t('search.retry')}
              </button>
            </p>
          )}
          {offSubscription.length > 0 && (
            <p>
              <b>{t('search.offSubTitle')}</b>
              {offSubscription.map(nameOf).join(sep)}
              <s>{t('search.offSubHint')}</s>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 搜索结果加载占位（m06954-2）：不再是 shimmer 扫光，而是「一整组内容被模糊盖住」。
 * 真实版式（海报 + 标题 + 简介三行）保持不变，只是整体很糊 —— 结果一到就原地清晰。
 */
function ResultsSkeleton() {
  return (
    <div className="g-soft-group g-rows" aria-hidden>
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="g-rcard">
          <div className="g-rcard-pic bg-chip" />
          <div className="g-rcard-bd">
            <div className="h-3.5 w-2/3 rounded bg-chip" />
            <div className="mt-2 h-2.5 w-1/3 rounded bg-chip" />
            <div className="mt-3 h-2.5 w-full rounded bg-chip" />
            <div className="mt-1.5 h-2.5 w-4/5 rounded bg-chip" />
          </div>
        </div>
      ))}
    </div>
  );
}

function NoSourceGuide({ hasSources = false }: { hasSources?: boolean }) {
  const t = useT();
  return (
    <div className="g-panel p-10 text-center">
      <h3 className="text-content font-medium mb-2">
        {hasSources ? t('search.noSourceTitle') : t('search.noSourceAdd')}
      </h3>
      <p className="text-sm text-muted leading-relaxed">
        {hasSources ? (
          <>{t('search.noSourceHint')}</>
        ) : (
          <>
            {t('search.noSourceHint2a')}
            <code className="text-accent text-xs">https://example.com/api.php/provide/vod</code>
            {t('search.noSourceHint2b')}
          </>
        )}
      </p>
    </div>
  );
}
