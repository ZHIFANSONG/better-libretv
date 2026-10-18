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

/**
 * 我的（proposal 版）：把原本散在抽屉/设置里的三块内容平铺成页面 ——
 * 采集源（带健康度胶囊）、观看历史（g-poster 网格）、离线下载（列表）。
 * 旧的抽屉入口在顶栏仍然保留，两处共用同一份 store / IndexedDB 数据。
 */
type Tab = 'source' | 'history' | 'download';

const TABS: { id: Tab; label: string; en: string }[] = [
  { id: 'history', label: '观看历史', en: 'history' },
  { id: 'source', label: '采集源', en: 'sources' },
  { id: 'download', label: '离线下载', en: 'downloads' },
];

export default function MePage() {
  const [tab, setTab] = useState<Tab>('history');
  return (
    <div className="g-shell min-h-screen flex flex-col">
      <Header />
      <main className="g-page flex-1">
        <h2 className="g-h2" style={{ marginTop: 8 }}>
          我的 <small>library</small>
        </h2>
        <div className="g-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={cn('g-tab', tab === t.id && 'on')}
              aria-pressed={tab === t.id}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              <em>{t.en}</em>
            </button>
          ))}
        </div>

        {tab === 'history' && <HistoryTab />}
        {tab === 'source' && <SourceTab />}
        {tab === 'download' && <DownloadTab />}
      </main>
      <SiteFooter />
    </div>
  );
}

/** 观看历史：海报网格 + 悬停信息，点击继续播放；删除给撤销窗口 */
function HistoryTab() {
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
    <section aria-label="观看历史">
      <div className="g-filterbar">
        <div className="g-search" style={{ margin: 0, flex: '0 1 320px' }}>
          <Icon name="search" className="w-4 h-4 opacity-50" />
          <input
            placeholder="搜索观看历史…"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            aria-label="搜索观看历史"
          />
        </div>
        <span className="g-meta">
          共 {history.length} 条
          {keyword ? ` · 匹配 ${items.length} 条` : ''}
        </span>
      </div>

      {items.length === 0 ? (
        <EmptyState
          variant="plain"
          title={keyword ? `没有匹配「${keyword}」的记录` : '暂无观看记录'}
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
                <Link href={href} className="block h-full w-full" aria-label={`继续播放 ${item.title}`}>
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
                      {item.totalEpisodes > 1 ? `第 ${item.episodeIndex + 1} 集 · ` : ''}
                      {item.playbackPosition > 0 ? formatTime(item.playbackPosition) : '未开始'}
                      {' · '}
                      {formatRelativeTime(item.timestamp)}
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
                  aria-label={`删除 ${item.title} 的记录`}
                  title="删除记录"
                  onClick={(e) => {
                    e.preventDefault();
                    void removeHistory(item.sourceKey, item.vodId).then(() =>
                      toast('已删除该记录', 'info', {
                        action: {
                          label: '撤销',
                          onClick: () => {
                            const { sourceKey, sourceUrl, vodId, title, pic, episodeIndex, totalEpisodes, playbackPosition, duration, timestamp } = item;
                            void upsertHistory({ sourceKey, sourceUrl, vodId, title, pic, episodeIndex, totalEpisodes, playbackPosition, duration, timestamp }).then(
                              () => toast('已恢复', 'success')
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
              void clearAllHistory().then(() => toast('观看历史已清空', 'success'));
            }}
          >
            清空全部历史
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
    <section aria-label="采集源">
      <div className="g-filterbar">
        <div className="g-search" style={{ margin: 0, flex: '0 1 320px' }}>
          <Icon name="search" className="w-4 h-4 opacity-50" />
          <input
            placeholder="搜索采集源…"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            aria-label="搜索采集源"
          />
        </div>
        <span className="g-meta">
          已勾选 {selectedKeys.length}/{all.length} 个源
        </span>
      </div>

      {items.length === 0 ? (
        <EmptyState variant="plain" title="没有匹配的采集源" />
      ) : (
        items.map((s) => {
          const h = sourceHealth[s.key];
          const off = isSourceDisabled({ sourceHealth }, s.key);
          const cls = off ? 'none' : h?.ok === false ? 'warn' : '';
          const label = off ? '已停用' : h?.ok === false ? `变慢${h.ms ? ` ${h.ms}ms` : ''}` : h?.ok ? `${h.ms ?? ''}ms` : '未测活';
          const on = selectedKeys.includes(s.key);
          return (
            <div key={s.key} className="g-row" style={{ alignItems: 'center' }}>
              <div className="g-bd">
                <h3 style={{ margin: 0 }}>
                  {s.name}
                  {s.builtin && <s className="g-badge">预置</s>}
                  {s.detail && <s className="g-badge">详情</s>}
                </h3>
                <p style={{ margin: '6px 0 8px' }} className="font-mono text-[11.5px]">
                  {s.url}
                </p>
                <div className="g-chips">
                  <button
                    type="button"
                    className={cn('g-chip', on ? '' : 'none')}
                    onClick={() => toggleSourceSelected(s.key)}
                    title={on ? '点击取消勾选（不参与搜索）' : '点击勾选（参与搜索）'}
                  >
                    <i />
                    {on ? '已启用' : '未启用'}
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

      <p className="g-note mt-6">
        增删采集源、导入订阅、调整图片代理等设置，请点右上角齿轮图标；本页只做只读总览与快速勾选。
      </p>
    </section>
  );
}

/** 离线下载：任务列表 + 进度（进度条复用 g-prog） */
function DownloadTab() {
  const tasks = useLiveQuery(() => db.downloads.orderBy('createdAt').reverse().toArray(), []);

  if (!tasks) return <LoadingState />;

  if (tasks.length === 0) {
    return (
      <EmptyState
        variant="plain"
        title="暂无下载任务"
        description="在播放页点「下载本集」，任务会出现在这里。"
      />
    );
  }

  return (
    <section aria-label="离线下载">
      {tasks.map((t) => (
        <DownloadRow key={t.id} task={t} />
      ))}
      <div className="mt-6">
        <button className="g-btn" onClick={requestShowDownloadManager}>
          <Icon name="download" className="w-4 h-4" />
          打开下载管理器
        </button>
      </div>
    </section>
  );
}

const STATUS_LABEL: Record<DownloadTaskEntry['status'], string> = {
  waiting: '排队中',
  downloading: '下载中',
  paused: '已暂停',
  completed: '已完成',
  error: '失败',
};

function DownloadRow({ task }: { task: DownloadTaskEntry }) {
  const pct = task.total > 0 ? Math.min(100, Math.round((task.finished / task.total) * 100)) : 0;
  const status = STATUS_LABEL[task.status] ?? task.status;
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
            {task.finished}/{task.total || '?'} 分片
          </span>
          {task.errorNum > 0 && (
            <span className="g-chip warn">
              <i />
              {task.errorNum} 个失败
            </span>
          )}
          <span className="g-chip none">
            <i />
            {formatRelativeTime(task.updatedAt)}
          </span>
        </div>
      </div>
    </div>
  );
}