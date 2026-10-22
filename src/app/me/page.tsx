'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useLiveQuery } from 'dexie-react-hooks';
import { Header } from '@/components/header';
import { SiteFooter } from '@/components/site-footer';
import { EmptyState, LoadingState } from '@/components/states';
import { SmartImage } from '@/components/smart-image';
import { Icon } from '@/components/icon';
import { useToast } from '@/components/toast';
import { requestShowDownloadManager } from '@/components/download-manager';
import {
  db,
  clearAllHistory,
  removeHistory,
  upsertHistory,
  MAX_HISTORY,
  type DownloadTaskEntry,
} from '@/lib/db';
import { buildWatchUrl, cn, formatRelativeTime, formatTime } from '@/lib/utils';
import { resolveSource, useAppStore, isSourceDisabled } from '@/lib/store';
import { useLang, useT } from '@/components/lang-sync';

/**
 * 我的（proposal 版）：把原本散在抽屉/设置里的三块内容平铺成页面 ——
 * 采集源（带健康度胶囊）、观看历史（g-poster 网格）、离线下载（列表）。
 * 旧的抽屉入口在顶栏仍然保留，两处共用同一份 store / IndexedDB 数据。
 */
type Tab = 'source' | 'history' | 'favorite' | 'download';

/**
 * 每个 tab 记两个名字：i18n 的 key 走当前语言，em 那个小字始终显示「另一种语言」，
 * 这样中英切换后不会出现「History / history」这种同一词重复两遍的怪相。
 */
const TABS: { id: Tab; key: string; zh: string; en: string }[] = [
  { id: 'history', key: 'me.tab.history', zh: '观看历史', en: 'history' },
  { id: 'favorite', key: 'me.tab.favorite', zh: '追剧收藏', en: 'favorites' },
  { id: 'source', key: 'me.tab.source', zh: '采集源', en: 'sources' },
  { id: 'download', key: 'me.tab.download', zh: '离线下载', en: 'downloads' },
];

export default function MePage() {
  const t = useT();
  const lang = useLang();
  const [tab, setTab] = useState<Tab>('history');
  return (
    <div className="g-shell min-h-screen flex flex-col">
      <Header />
      <main className="g-page flex-1">
        <h2 className="g-h2" style={{ marginTop: 8 }}>
          {t('me.title')} <small>{lang === 'en' ? '我的' : 'library'}</small>
        </h2>
        <div className="g-tabs">
          {TABS.map((it) => (
            <button
              key={it.id}
              type="button"
              className={cn('g-tab', tab === it.id && 'on')}
              aria-pressed={tab === it.id}
              onClick={() => setTab(it.id)}
            >
              {t(it.key)}
              <em>{lang === 'en' ? it.zh : it.en}</em>
            </button>
          ))}
        </div>

        {tab === 'history' && <HistoryTab />}
        {tab === 'favorite' && <FavoriteTab />}
        {tab === 'source' && <SourceTab />}
        {tab === 'download' && <DownloadTab />}
      </main>
      <SiteFooter />
    </div>
  );
}

/**
 * 追剧收藏：只记「哪部片」，进度从 IndexedDB 的观看历史里现查现拼。
 * 这样收藏与历史始终一致 —— 删了历史记录，追剧卡片的「看到第几集」会自动退回「未开始」，
 * 不会出现收藏里还挂着上次进度、点进去却从头播的错位。
 */
function FavoriteTab() {
  const t = useT();
  const lang = useLang();
  const favorites = useAppStore((s) => s.vodFavorites);
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const removeVodFavorite = useAppStore((s) => s.removeVodFavorite);
  const toggleVodFavorite = useAppStore((s) => s.toggleVodFavorite);
  const { toast } = useToast();
  const [keyword, setKeyword] = useState('');

  const history = useLiveQuery(() => db.history.toArray(), []);
  const progressByKey = useMemo(() => {
    const map = new Map<string, { episodeIndex: number; totalEpisodes: number }>();
    for (const h of history ?? []) {
      map.set(`${h.sourceKey}_${h.vodId}`, { episodeIndex: h.episodeIndex, totalEpisodes: h.totalEpisodes });
    }
    return map;
  }, [history]);

  const items = useMemo(() => {
    const k = keyword.trim().toLowerCase();
    return k ? favorites.filter((f) => f.title.toLowerCase().includes(k)) : favorites;
  }, [favorites, keyword]);

  return (
    <section aria-label={t('me.favoriteAria')}>
      <div className="g-filterbar">
        <div className="g-search" style={{ margin: 0, flex: '0 1 320px' }}>
          <Icon name="search" className="w-4 h-4 opacity-50" />
          <input
            placeholder={t('me.searchFavorites')}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            aria-label={t('me.searchFavoritesAria')}
          />
        </div>
        <span className="g-meta">
          {t('me.totalShows', { n: favorites.length })}
          {keyword ? t('me.matchShows', { n: items.length }) : ''}
        </span>
      </div>

      {items.length === 0 ? (
        <EmptyState
          variant="plain"
          title={keyword ? t('me.noMatchFavorites', { q: keyword }) : t('me.emptyFavorites')}
          description={keyword ? undefined : t('me.emptyFavoritesDesc')}
        />
      ) : (
        <div className="g-grid">
          {items.map((item) => {
            const key = `${item.sourceKey}_${item.vodId}`;
            const watched = progressByKey.get(key);
            const source = resolveSource({ customAPIs, envSources }, item.sourceKey);
            const href = buildWatchUrl({
              sourceKey: item.sourceKey,
              vodId: item.vodId,
              // 有观看进度就从那一集接着看，没有就从头
              index: watched?.episodeIndex ?? 0,
              title: item.title,
              sourceUrl: source?.url,
              detail: source?.detail,
            });
            return (
              <div key={key} className="g-poster group">
                <Link href={href} className="block h-full w-full" aria-label={t('me.continueFavorite', { title: item.title })}>
                  {item.pic && (
                    <SmartImage
                      url={item.pic}
                      mode={imageProxyMode}
                      customProxy={customImageProxy}
                      alt={item.title}
                      className="absolute inset-0 h-full w-full object-cover"
                    />
                  )}
                  <div className="g-poster-meta">
                    <b title={item.title}>{item.title}</b>
                    <span>
                      {(watched?.totalEpisodes ?? item.totalEpisodes ?? 0) > 1 && watched
                        ? t('me.watchedEp', { n: watched.episodeIndex + 1 })
                        : ''}
                      {t('me.addedAt', { time: formatRelativeTime(item.addedAt, lang) })}
                    </span>
                  </div>
                </Link>
                <button
                  type="button"
                  className="g-ic absolute right-2 top-2 opacity-0 transition-opacity group-hover:opacity-100"
                  style={{ width: 28, height: 28 }}
                  aria-label={t('me.removeFavoriteAria', { title: item.title })}
                  title={t('me.removeFavorite')}
                  onClick={(e) => {
                    e.preventDefault();
                    const snapshot = { ...item };
                    removeVodFavorite(item.sourceKey, item.vodId);
                    toast(t('me.favoriteRemoved'), 'info', {
                      action: {
                        label: t('common.undo'),
                        onClick: () => {
                          // toggleVodFavorite 会带上新的 addedAt；用原快照的 time 无关紧要，
                          // 但重新加入要保证顺序合理，故直接把原对象写回（再 trim 一次去重）
                          void toggleVodFavorite(snapshot);
                          toast(t('common.restored'), 'success');
                        },
                      },
                    });
                  }}
                >
                  <Icon name="trash" className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** 观看历史：海报网格 + 悬停信息，点击继续播放；删除给撤销窗口 */
function HistoryTab() {
  const t = useT();
  const lang = useLang();
  const history = useLiveQuery(() => db.history.orderBy('timestamp').reverse().limit(MAX_HISTORY).toArray(), []);
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const { toast } = useToast();
  const [keyword, setKeyword] = useState('');

  const items = useMemo(() => {
    const all = history ?? [];
    const k = keyword.trim().toLowerCase();
    return k ? all.filter((h) => h.title.toLowerCase().includes(k)) : all;
  }, [history, keyword]);

  if (!history) return <LoadingState />;

  return (
    <section aria-label={t('me.tab.history')}>
      <div className="g-filterbar">
        <div className="g-search" style={{ margin: 0, flex: '0 1 320px' }}>
          <Icon name="search" className="w-4 h-4 opacity-50" />
          <input
            placeholder={t('me.searchHistory')}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            aria-label={t('me.searchHistoryAria')}
          />
        </div>
        <span className="g-meta">
          {t('me.totalRecords', { n: history.length })}
          {keyword ? t('me.matchRecords', { n: items.length }) : ''}
        </span>
      </div>

      {items.length === 0 ? (
        <EmptyState
          variant="plain"
          title={keyword ? t('me.noMatchHistory', { q: keyword }) : t('me.emptyHistory')}
        />
      ) : (
        <div className="g-grid">
          {items.map((item) => {
            const source = resolveSource({ customAPIs, envSources }, item.sourceKey);
            const href = buildWatchUrl({
              sourceKey: item.sourceKey,
              vodId: item.vodId,
              index: item.episodeIndex,
              title: item.title,
              sourceUrl: source?.url,
              detail: source?.detail,
            });
            const pct =
              item.duration > 0 ? Math.min(100, Math.round((item.playbackPosition / item.duration) * 100)) : 0;
            return (
              <div key={`${item.sourceKey}_${item.vodId}`} className="g-poster group">
                <Link href={href} className="block h-full w-full" aria-label={t('me.continuePlay', { title: item.title })}>
                  {item.pic && (
                    <SmartImage
                      url={item.pic}
                      mode={imageProxyMode}
                      customProxy={customImageProxy}
                      alt={item.title}
                      className="absolute inset-0 h-full w-full object-cover"
                    />
                  )}
                  <div className="g-poster-meta">
                    <b title={item.title}>{item.title}</b>
                    <span>
                      {item.totalEpisodes > 1 ? t('me.epShort', { n: item.episodeIndex + 1 }) : ''}
                      {item.playbackPosition > 0 ? formatTime(item.playbackPosition) : t('me.notStarted')}
                      {' · '}
                      {formatRelativeTime(item.timestamp, lang)}
                    </span>
                  </div>
                  {pct > 0 && (
                    <div className="g-prog absolute left-3 right-3 bottom-1.5">
                      <i style={{ width: `${pct}%` }} />
                    </div>
                  )}
                </Link>
                <button
                  type="button"
                  className="g-ic absolute right-2 top-2 opacity-0 transition-opacity group-hover:opacity-100"
                  style={{ width: 28, height: 28 }}
                  aria-label={t('me.deleteRecordAria', { title: item.title })}
                  title={t('me.deleteRecord')}
                  onClick={(e) => {
                    e.preventDefault();
                    void removeHistory(item.sourceKey, item.vodId).then(() =>
                      toast(t('me.recordDeleted'), 'info', {
                        action: {
                          label: t('common.undo'),
                          onClick: () => {
                            const { sourceKey, sourceUrl, vodId, title, pic, episodeIndex, totalEpisodes, playbackPosition, duration, timestamp } = item;
                            void upsertHistory({ sourceKey, sourceUrl, vodId, title, pic, episodeIndex, totalEpisodes, playbackPosition, duration, timestamp }).then(
                              () => toast(t('common.restored'), 'success')
                            );
                          },
                        },
                      })
                    );
                  }}
                >
                  <Icon name="trash" className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {history.length > 0 && (
        <div className="mt-6">
          <button
            className="g-btn"
            style={{ background: 'transparent', border: '1px solid var(--bd)', color: 'var(--t2)' }}
            onClick={() => {
              void clearAllHistory().then(() => toast(t('me.historyCleared'), 'success'));
            }}
          >
            {t('me.clearHistory')}
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * 采集源：可搜索列表 = 名称 + 地址 + 健康度胶囊（绿=可用 / 黄=变慢 / 灰=长期停用）。
 * 只读展示 + 一键测活入口：增删改仍走顶栏「设置」抽屉，避免两处编辑逻辑分叉。
 */
function SourceTab() {
  const t = useT();
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const selectedKeys = useAppStore((s) => s.selectedKeys);
  const sourceHealth = useAppStore((s) => s.sourceHealth);
  const toggleSourceSelected = useAppStore((s) => s.toggleSourceSelected);
  const [keyword, setKeyword] = useState('');

  const all = useMemo(
    () => [
      ...envSources.map((s) => ({ ...s, builtin: true })),
      ...customAPIs.map((s) => ({ ...s, builtin: false })),
    ],
    [customAPIs, envSources]
  );

  const items = useMemo(() => {
    const k = keyword.trim().toLowerCase();
    if (!k) return all;
    return all.filter((s) => `${s.name} ${s.url}`.toLowerCase().includes(k));
  }, [all, keyword]);

  return (
    <section aria-label={t('me.tab.source')}>
      <div className="g-filterbar">
        <div className="g-search" style={{ margin: 0, flex: '0 1 320px' }}>
          <Icon name="search" className="w-4 h-4 opacity-50" />
          <input
            placeholder={t('me.searchSources')}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            aria-label={t('me.searchSourcesAria')}
          />
        </div>
        <span className="g-meta">
          {t('me.selectedSources', { n: selectedKeys.length, total: all.length })}
        </span>
      </div>

      {items.length === 0 ? (
        <EmptyState variant="plain" title={t('me.noMatchSources')} />
      ) : (
        items.map((s) => {
          const h = sourceHealth[s.key];
          const off = isSourceDisabled({ sourceHealth }, s.key);
          const cls = off ? 'none' : h?.ok === false ? 'warn' : '';
          const label = off
            ? t('common.disabled')
            : h?.ok === false
              ? t('me.sourceSlow', { ms: h.ms ? ` ${h.ms}ms` : '' })
              : h?.ok
                ? `${h.ms ?? ''}ms`
                : t('me.sourceUnprobed');
          const on = selectedKeys.includes(s.key);
          return (
            <div key={s.key} className="g-row" style={{ alignItems: 'center' }}>
              <div className="g-bd">
                <h3 style={{ margin: 0 }}>
                  {s.name}
                  {s.builtin && <s className="g-badge">{t('me.builtin')}</s>}
                  {s.detail && <s className="g-badge">{t('me.hasDetail')}</s>}
                </h3>
                <p style={{ margin: '6px 0 8px' }} className="font-mono text-[11.5px]">
                  {s.url}
                </p>
                <div className="g-chips">
                  <button
                    type="button"
                    className={cn('g-chip', on ? '' : 'none')}
                    onClick={() => toggleSourceSelected(s.key)}
                    title={on ? t('me.checkOffTip') : t('me.checkOnTip')}
                  >
                    <i />
                    {on ? t('common.enabled') : t('common.disabled')}
                  </button>
                  <span className={cn('g-chip', cls)}>
                    <i />
                    {label}
                  </span>
                </div>
              </div>
            </div>
          );
        })
      )}

      <p className="g-note mt-6">{t('me.sourceNote')}</p>
    </section>
  );
}

/** 离线下载：任务列表 + 进度（进度条复用 g-prog） */
function DownloadTab() {
  const t = useT();
  const tasks = useLiveQuery(() => db.downloads.orderBy('createdAt').reverse().toArray(), []);

  if (!tasks) return <LoadingState />;

  if (tasks.length === 0) {
    return (
      <EmptyState
        variant="plain"
        title={t('me.emptyDownloads')}
        description={t('me.emptyDownloadsDesc')}
      />
    );
  }

  return (
    <section aria-label={t('me.tab.download')}>
      {tasks.map((t) => (
        <DownloadRow key={t.id} task={t} />
      ))}
      <div className="mt-6">
        <button className="g-btn" onClick={requestShowDownloadManager}>
          <Icon name="download" className="w-4 h-4" />
          {t('me.openDownloadManager')}
        </button>
      </div>
    </section>
  );
}

/** 下载状态：文案走字典，不要再硬编码一张中文表 */
const STATUS_KEY: Record<DownloadTaskEntry['status'], string> = {
  waiting: 'dl.status.waiting',
  downloading: 'dl.status.downloading',
  paused: 'dl.status.paused',
  completed: 'dl.status.completed',
  error: 'dl.status.error',
};

function DownloadRow({ task }: { task: DownloadTaskEntry }) {
  const t = useT();
  const lang = useLang();
  const pct = task.total > 0 ? Math.min(100, Math.round((task.finished / task.total) * 100)) : 0;
  const status = STATUS_KEY[task.status] ? t(STATUS_KEY[task.status]) : task.status;
  return (
    <div className="g-row" style={{ alignItems: 'center' }}>
      <div className="g-bd">
        <h3 style={{ margin: 0 }}>
          <span className="truncate">{task.title}</span>
          <s className="g-badge">
            {task.format} · {status}
          </s>
        </h3>
        <div className="g-prog mt-2 mb-2">
          <i style={{ width: `${pct}%` }} />
        </div>
        <div className="g-chips">
          <span className={cn('g-chip', task.status === 'error' && 'warn')}>
            <i />
            {t('me.parts', { done: task.finished, total: task.total || '?' })}
          </span>
          {task.errorNum > 0 && (
            <span className="g-chip warn">
              <i />
              {t('me.failedParts', { n: task.errorNum })}
            </span>
          )}
          <span className="g-chip none">
            <i />
            {formatRelativeTime(task.updatedAt, lang)}
          </span>
        </div>
      </div>
    </div>
  );
}