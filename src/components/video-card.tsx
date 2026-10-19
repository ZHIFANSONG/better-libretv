'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { QualityEntry, SearchResultItem, SourceConfig } from '@/lib/types';
import { api } from '@/lib/client-api';
import { useAppStore, readQualities } from '@/lib/store';
import { QUALITY_FAIL_TTL_MS, qualityKey } from '@/lib/quality';
import { inferGroupRemarks } from '@/lib/remarks';
import { latencyLevel, latencyText } from '@/lib/source-switch';
import { cn } from '@/lib/utils';
import { QualityBadge } from './quality-badge';
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
    // 同一部剧各源文案详略不同（「全34集」/「完结」/「更新至34集」），推到统一结论，
    // 否则同一部剧的来源列表会看起来状态各异
    remarks: inferGroupRemarks(items.map((i) => i.remarks)),
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
  sources,
}: {
  group: AggregatedGroup;
  /** 点卡片本体：打开详情弹窗（可以看到简介、分集、全部来源） */
  onOpen: (item: SearchResultItem, group: AggregatedGroup) => void;
  /** 点某一个来源胶囊：直接用这个源的资源开播（v14 起跳 /watch，不再本页内嵌播放） */
  onPlaySource?: (item: SearchResultItem) => void;
  /** 完整源配置：探测画质需要 source.url / source.detail，搜索结果里只带 sourceUrl */
  sources?: SourceConfig[];
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

  // 画质状态：按 `sourceKey:vodId` 存放。探测完成后一定会有条目
  // （height 缺失代表「测不出」），所以「无条目」= 尚未探测。
  const [qualities, setQualities] = useState<Record<string, QualityEntry>>({});
  const [probing, setProbing] = useState<Record<string, true>>({});
  // 正在探测中的键：只用于防同一个键并发重复请求，拿到结果或被掐掉就移除
  const inflightRef = useRef<Set<string>>(new Set());
  // 拿到终态结果（有画质 / 测不出 / 失败）的键 → 时间。折叠再展开不重复打源站；
  // 失败是瞬时的，永久锁死会让偶发失败的源再也拿不到画质，所以冷却满 QUALITY_FAIL_TTL_MS 才重试。
  // 只记「拿到结果」的键：请求被掐掉时没有终态，记下来会让该源被锁到冷却结束
  const settledRef = useRef<Map<string, number>>(new Map());
  // 当前批次的键：被下一批掐掉时，靠它把未完成的键解锁
  const batchRef = useRef<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  /**
   * 按需探测各来源画质（本卡片挂载即发起，或用户点了「测画质」）。
   *
   * 不做全页预探测：一次搜索可能几十部片 × 十几个源，全量打会把源站和服务端都压垮，
   * 而用户真正关心的只有他看到的这一屏。所以只在卡片上点了「测画质」时才发起，
   * 以及已知来源少于 4 个（展开一目了然）时随卡片一起探。
   */
  const startQualityProbe = () => {
    const now = Date.now();
    const cached = readQualities(group.items.map((i) => ({ sourceKey: i.sourceKey, vodId: i.vodId })));
    setQualities((prev) => ({ ...cached, ...prev }));

    const selectPending = () =>
      group.items.filter((i) => {
        const key = qualityKey(i.sourceKey, i.vodId);
        const known = cached[key] ?? qualities[key];
        // 已有结论就不再探：成功和「测不出」都是终态，重探也还是同一个结果
        if (known && !known.error) return false;
        // 已在飞：等这一批的结果，不重复打
        if (inflightRef.current.has(key)) return false;
        const last = settledRef.current.get(key);
        if (last === undefined) return true;
        // 探测失败过：冷却满 QUALITY_FAIL_TTL_MS 才重试，
        // 否则每次展开都要重打一遍挂掉的源，白等一轮超时
        return now - last > QUALITY_FAIL_TTL_MS;
      });

    // 没有新要探的键：让上一批跑完，不打断它（结果回来照样更新徽章）
    if (selectPending().length === 0) return;

    // 掐掉上一批：本轮要重发，留着只会互相打断。
    // 同时把它未拿到结果的键解锁——否则这些键既不在飞、又因 inflight 选不进本批，
    // 徽章会一直空着，直到冷却结束才有机会重探
    for (const k of batchRef.current) inflightRef.current.delete(k);
    batchRef.current.clear();
    abortRef.current?.abort();

    const items = selectPending()
      .map((i) => {
        const key = qualityKey(i.sourceKey, i.vodId);
        const source =
          sources?.find((s) => s.key === i.sourceKey) ??
          // 源配置缺失时用搜索结果自带的地址兜底（缺 detail，走不了详情页降级）
          (i.sourceUrl ? { key: i.sourceKey, name: i.sourceName, url: i.sourceUrl } : undefined);
        return source ? { key, item: { source, id: i.vodId } } : undefined;
      })
      .filter((v): v is { key: string; item: { source: SourceConfig; id: string } } => Boolean(v));

    if (items.length === 0) return;
    const keys = items.map((i) => i.key);
    // 探测结果先攒在这里，流结束时一次性写全局缓存：逐条写会让 persist
    // 把整个状态（含最多 400 条画质记录）序列化十几遍
    const collected: Record<string, QualityEntry> = {};
    const batch = new Set(keys);
    for (const k of keys) inflightRef.current.add(k);
    batchRef.current = batch;
    setProbing((prev) => {
      const next = { ...prev };
      for (const k of keys) next[k] = true;
      return next;
    });

    const controller = new AbortController();
    abortRef.current = controller;

    const finish = (targets: string[]) => {
      setProbing((prev) => {
        const next = { ...prev };
        for (const k of targets) delete next[k];
        return next;
      });
    };

    api
      .qualityProbeStream(
        items.map((i) => i.item),
        (result) => {
          const key = qualityKey(result.sourceKey, result.vodId);
          const entry: QualityEntry = {
            height: result.height,
            from: 'probe',
            error: result.error,
            timestamp: Date.now(),
          };
          // 逐条更新本卡片的徽章（流式效果保留）
          setQualities((prev) => ({ ...prev, [key]: entry }));
          collected[key] = entry;
          // 拿到终态：解锁并发标记，并记下冷却起点
          inflightRef.current.delete(key);
          settledRef.current.set(key, Date.now());
          finish([key]);
        },
        controller.signal
      )
      .catch(() => {
        // 探测整批失败（离线/未登录）或被新一轮掐掉：保持「未知」，不打断选源
      })
      .finally(() => {
        // 一次性写入全局缓存：同一部剧在别处（换源面板、再次搜索）也能复用。
        // 中断时也会走到这里，已拿到的结果不会丢
        if (Object.keys(collected).length > 0) useAppStore.getState().setQuality(collected);
        // 本批未拿到终态的键一律解锁，下次可立刻重试
        for (const k of batch) inflightRef.current.delete(k);
        if (batchRef.current === batch) batchRef.current.clear();
        finish(keys);
      });
  };

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
            // key 必须与 qualityKey / probing / qualities 用同一套分隔符（`:`），
            // 原先这里用 `_` 拼 key，徽章永远取不到值，测完也不亮
            const key = qualityKey(it.sourceKey, it.vodId);
            const h = sourceHealth[it.sourceKey];
            const lv = latencyLevel({ ok: h?.ok, ms: h?.ms });
            return (
              <button
                key={key}
                className="g-rcard-srcrow"
                title={`用「${it.sourceName || it.sourceKey}」播放${it.remarks ? ` · ${it.remarks}` : ""}${h?.ms != null ? ` · 搜索耗时 ${h.ms}ms` : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (onPlaySource) onPlaySource(it);
                  else onOpen(it, group);
                }}
              >
                <i className={cn('g-dot', lv)} />
                {it.sourceName || it.sourceKey}
                <QualityBadge entry={qualities[key]} loading={probing[key]} />
                {h?.ok && h.ms != null && <em>{latencyText({ ok: h.ok, ms: h.ms })}</em>}
              </button>
            );
          })}
          {/*
           * 画质探测入口：默认不探（一次搜索几十部片，全量探测会把源站压垮），
           * 用户想知道这部片各源画质时点一下，按需逐个亮起来。
           */}
          <button
            className="g-rcard-qbtn"
            title={Object.keys(probing).length > 0 ? '正在探测画质…' : '探测各来源画质（10 秒内出结果）'}
            onClick={(e) => {
              e.stopPropagation();
              startQualityProbe();
            }}
          >
            {Object.keys(probing).length > 0 ? '探测中…' : '测画质'}
          </button>

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
