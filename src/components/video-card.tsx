'use client';

import { useEffect, useMemo, useState } from 'react';
import type { SearchResultItem } from '@/lib/types';
import { useAppStore } from '@/lib/store';
import { latencyLevel, latencyText } from '@/lib/source-switch';
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
 * 聚合结果卡片（m07594 网格版）：搜索结果不再是一行一条的整宽列表（横屏时一行只放得下一部、
 * 屏幕利用率太低），改成 3~4 列的卡片网格 —— 左侧 2:3 竖版海报（左上角标显示来源数量），
 * 右侧标题 / 年份类型徽章 / 两行简介。
 * 点卡片本体打开详情弹窗，在弹窗里再选具体采集源（原来一屏铺满几十个来源胶囊，横屏更浪费）。
 */
export function AggregatedCard({
  group,
  onOpen,
  onPlaySource,
  playingKey,
}: {
  group: AggregatedGroup;
  /** 点卡片本体：打开详情弹窗（可以看到简介、分集、全部来源） */
  onOpen: (item: SearchResultItem, group: AggregatedGroup) => void;
  /** 点某一个来源胶囊：就在本页播放器里放这个源的资源（不跳走，搜索结果不丢） */
  onPlaySource?: (item: SearchResultItem) => void;
  /** 正在本页播放的那条来源，用来在胶囊上打「播放中」标记 */
  playingKey?: string;
}) {
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  // 每个源的本次搜索耗时（来自搜索流里的 outcome）：命中就显示延迟档位圆点，
  // 让用户在点下去之前就知道该挑哪个源 —— 不必先点开播、等转圈再自己试。
  const sourceHealth = useAppStore((s) => s.sourceHealth);
  const [imgFailed, setImgFailed] = useState(false);
  const showImg = !!group.pic && !imgFailed;
  const adult = useMemo(() => group.items.some((i) => i.isAdult), [group.items]);
  const sourceNames = useMemo(
    () => Array.from(new Set(group.items.map((i) => i.sourceName).filter(Boolean))),
    [group.items]
  );
  const count = group.items.length;

  const activate = () => onOpen(group.items[0], group);

  return (
    <div
      className="g-rcard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      role="button"
      tabIndex={0}
      aria-label={group.name + "，" + count + " 个来源"}
      title={sourceNames.length > 1 ? sourceNames.join("、") : undefined}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activate();
        }
      }}
    >
      <div className="g-rcard-pic">
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
        <span className="g-rcard-cnt">
          {count > 1 ? count + " 个来源" : sourceNames[0] || "单一来源"}
        </span>
      </div>

      <div className="g-rcard-bd">
        <h3 title={group.name}>{group.name}</h3>
        {(group.year || group.typeName || adult) && (
          <div className="g-rcard-meta">
            {group.year && <s>{group.year}</s>}
            {group.typeName && <s>{group.typeName}</s>}
            {adult && <s>(18+)</s>}
          </div>
        )}
        <p>{group.remarks || "暂无介绍"}</p>
        {/*
         * 来源行：原来卡上只写「4 个来源」几个字，点进去也只有一个源能播，
         * 用户根本选不了用哪个 API 的资源 —— 现在每个源都是一颗直接开播的胶囊。
         * 单源时也显示，让「哪个站出的片子」这件事一眼可见。
         */}
        <div className="g-rcard-src" onClick={(e) => e.stopPropagation()}>
          {group.items.slice(0, 5).map((it) => {
            const key = `${it.sourceKey}_${it.vodId}`;
            const h = sourceHealth[it.sourceKey];
            const lv = latencyLevel({ ok: h?.ok, ms: h?.ms });
            return (
              <button
                key={key}
                className={`g-rcard-srcrow${playingKey === key ? ' on' : ''}`}
                title={`用「${it.sourceName || it.sourceKey}」播放${it.remarks ? ` · ${it.remarks}` : ""}${h?.ms != null ? ` · 搜索耗时 ${h.ms}ms` : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (onPlaySource) onPlaySource(it);
                  else onOpen(it, group);
                }}
              >
                <i className={cn('g-dot', lv)} />
                {it.sourceName || it.sourceKey}
                {h?.ok && h.ms != null && <em>{latencyText({ ok: h.ok, ms: h.ms })}</em>}
              </button>
            );
          })}
          {count > 5 && (
            <button
              className="g-rcard-srcmore"
              title="查看全部来源"
              onClick={(e) => {
                e.stopPropagation();
                activate();
              }}
            >
              +{count - 5}
            </button>
          )}
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
