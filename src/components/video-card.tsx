'use client';

import { useEffect, useMemo, useState } from 'react';
import type { SearchResultItem } from '@/lib/types';
import { useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { SmartImage } from './smart-image';

// —— 跨源同名聚合 ——

export interface AggregatedGroup {
  key: string;
  name: string;
  year?: string;
  typeName?: string;
  pic?: string;
  remarks?: string;
  items: SearchResultItem[];
}

function buildGroup(name: string, year: string | undefined, items: SearchResultItem[]): AggregatedGroup {
  return {
    key: `${name}|${year ?? ''}|${items.map((i) => `${i.sourceKey}_${i.vodId}`).join(',')}`,
    name,
    year,
    typeName: items.find((i) => i.typeName)?.typeName,
    pic: items.find((i) => i.pic)?.pic,
    remarks: items.find((i) => i.remarks)?.remarks,
    items,
  };
}

/**
 * 把扁平的跨源搜索结果按「同名影片」聚合：
 * - 以名称分桶；桶内年份不一致时（同名翻拍）按年份拆分，无年份的条目并入年份桶；
 * - 保持传入顺序（搜索结果已按名称排序）。
 */
export function aggregateResults(list: SearchResultItem[]): AggregatedGroup[] {
  const byName = new Map<string, SearchResultItem[]>();
  for (const item of list) {
    const k = (item.name || '').trim();
    if (!k) continue;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k)!.push(item);
  }
  const groups: AggregatedGroup[] = [];
  for (const [name, items] of byName) {
    const years = [...new Set(items.map((i) => i.year).filter(Boolean))] as string[];
    if (years.length > 1) {
      for (const y of years) {
        groups.push(buildGroup(name, y, items.filter((i) => i.year === y)));
      }
      const noYear = items.filter((i) => !i.year);
      if (noYear.length) groups.push(buildGroup(name, undefined, noYear));
    } else {
      groups.push(buildGroup(name, years[0], items));
    }
  }
  return groups;
}

/**
 * 聚合结果行（proposal 版）：提案稿的 .g-row 列表形态 —— 88px 竖版缩略图 +
 * 标题（附年份/类型徽章）+ 两行简介 + 每条来源一个可点健康胶囊。
 * 行本体点击打开第一条来源；胶囊各自指向具体来源，避免旧版「先展开再选」的两次点击。
 */
export function AggregatedCard({
  group,
  onOpen,
}: {
  group: AggregatedGroup;
  onOpen: (item: SearchResultItem) => void;
}) {
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const [imgFailed, setImgFailed] = useState(false);
  const showImg = !!group.pic && !imgFailed;
  const adult = useMemo(() => group.items.some((i) => i.isAdult), [group.items]);

  const activate = () => onOpen(group.items[0]);

  return (
    <div
      className="g-row cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      role="button"
      tabIndex={0}
      aria-label={`${group.name}，${group.items.length} 个来源`}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate();
        }
      }}
    >
      <div className="g-th bg-chip">
        {showImg ? (
          <SmartImage
            url={group.pic}
            mode={imageProxyMode}
            customProxy={customImageProxy}
            alt={group.name}
            className="absolute inset-0 h-full w-full object-cover"
            onExhausted={() => setImgFailed(true)}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <svg className="w-7 h-7 text-faint" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 4v16m10-16v16M3 6a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6zm4 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1h-1a1 1 0 01-1-1V6zm8 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1h-1a1 1 0 01-1-1V6zm4 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1h-1a1 1 0 01-1-1V6z" />
            </svg>
          </div>
        )}
        <span className="g-th-q">{group.items.length > 1 ? `${group.items.length} 源` : group.items[0].sourceName}</span>
      </div>

      <div className="g-bd">
        <h3 title={group.name}>
          {group.name}
          {group.year && <s className="g-badge">{group.year}</s>}
          {group.typeName && <s className="g-badge">{group.typeName}</s>}
          {adult && <s className="g-badge">(18+)</s>}
        </h3>
        <p>{group.remarks || '暂无介绍'}</p>
        <div className="g-chips">
          {group.items.map((item) => (
            <button
              key={`${item.sourceKey}_${item.vodId}`}
              type="button"
              className={cn('g-chip', item.isAdult && 'warn')}
              onClick={(e) => {
                e.stopPropagation();
                onOpen(item);
              }}
              aria-label={`使用 ${item.sourceName} 播放`}
              title={`${item.sourceName} · ${item.remarks || '暂无介绍'}`}
            >
              <i />
              <span className="truncate max-w-[9em]">{item.sourceName}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** 影片卡片（未聚合的单一结果使用）：海报复用 g-poster 形态 */
export function VideoCard({ item, onClick }: { item: SearchResultItem; onClick: () => void }) {
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const [imgFailed, setImgFailed] = useState(false);
  const showImg = !!item.pic && !imgFailed;

  return (
    <div
      className="g-poster focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      role="button"
      tabIndex={0}
      aria-label={item.name}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {showImg ? (
        <SmartImage
          url={item.pic}
          mode={imageProxyMode}
          customProxy={customImageProxy}
          alt={item.name}
          className="absolute inset-0 h-full w-full object-cover"
          onExhausted={() => setImgFailed(true)}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <svg className="w-8 h-8 text-faint" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 4v16m10-16v16M3 6a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6zm4 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1h-1a1 1 0 01-1-1V6zm8 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1h-1a1 1 0 01-1-1V6zm4 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1h-1a1 1 0 01-1-1V6z" />
          </svg>
        </div>
      )}
      <div className="g-poster-meta">
        <b title={item.name}>{item.name}</b>
        <span>{[item.year, item.sourceName].filter(Boolean).join(' · ')}</span>
      </div>
    </div>
  );
}

/** 豆瓣推荐海报（proposal 版）：g-poster + 右上评分角标，点击直接搜索 */
export function DoubanCard({ item, onClick }: { item: { title: string; cover: string; rating?: string }; onClick: () => void }) {
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => setImgFailed(false), [item.cover]);

  return (
    <div
      className="g-poster focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      role="button"
      tabIndex={0}
      aria-label={item.title}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {item.cover && !imgFailed ? (
        <SmartImage
          url={item.cover}
          mode={imageProxyMode}
          customProxy={customImageProxy}
          alt={item.title}
          className="absolute inset-0 h-full w-full object-cover"
          onExhausted={() => setImgFailed(true)}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <svg className="w-8 h-8 text-faint" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 4v16m10-16v16M3 6a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6zm4 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1h-1a1 1 0 01-1-1V6zm8 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1h-1a1 1 0 01-1-1V6zm4 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1h-1a1 1 0 01-1-1V6z" />
          </svg>
        </div>
      )}
      {item.rating && <span className="g-rate">★ {item.rating}</span>}
      <div className="g-poster-meta">
        <b title={item.title}>{item.title}</b>
      </div>
    </div>
  );
}
