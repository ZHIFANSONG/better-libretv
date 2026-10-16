'use client';

import Link from 'next/link';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, MAX_HISTORY } from '@/lib/db';
import { buildWatchUrl, formatRelativeTime, formatTime } from '@/lib/utils';
import { resolveSource, useAppStore } from '@/lib/store';
import { SmartImage } from './smart-image';

/**
 * 「继续观看」（proposal 版首页的第二段海报区）：取最近的观看历史，
 * 卡片直接指向播放页（带集数与进度），右下小进度条与海报底部的信息条沿用提案稿样式。
 * 无历史时整段不渲染，避免首页出现空标题。
 */
export function ContinueWatchingSection({ limit = 6 }: { limit?: number }) {
  const history = useLiveQuery(
    () => db.history.orderBy('timestamp').reverse().limit(MAX_HISTORY).toArray(),
    []
  );
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);

  const items = (history ?? []).slice(0, limit);
  if (items.length === 0) return null;

  return (
    <section aria-label="继续观看">
      <h2 className="g-h2">
        继续观看 <small>history</small>
      </h2>
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
            <Link
              key={`${item.sourceKey}_${item.vodId}`}
              href={href}
              className="g-poster"
              aria-label={`继续播放 ${item.title}`}
            >
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
          );
        })}
      </div>
    </section>
  );
}
