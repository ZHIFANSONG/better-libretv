'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import { useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import type { DoubanItem } from '@/lib/types';
import { DoubanCard } from './video-card';

const MOVIE_TAGS = ['热门', '最新', '经典', '豆瓣高分', '冷门佳片', '华语', '欧美', '韩国', '日本', '动画'];
const TV_TAGS = ['热门', '美剧', '英剧', '韩剧', '日剧', '国产剧', '港剧', '日本动画', '综艺', '纪录片'];
const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/** 首页 Hero 分类胶囊：只影响推荐区取哪一档内容，不改用户设置里的数据源 */
export type HeroTab = 'all' | 'movie' | 'tv' | 'anime' | 'variety';

/** 首页推荐区：默认数据源由设置决定（豆瓣热门 / Bangumi 新番放送 / 影视热榜）；
 *  Hero 上选了具体分类时，按分类取对应的那一档推荐（电影/剧集→豆瓣、动漫→新番、综艺→综艺榜）。 */
export function RecommendSection({ onPick, tab = 'all' }: { onPick: (title: string) => void; tab?: HeroTab }) {
  const doubanEnabled = useAppStore((s) => s.doubanEnabled);
  const recommendSource = useAppStore((s) => s.recommendSource);

  if (!doubanEnabled) return null;
  const view =
    tab === 'movie' ? (
      <DoubanView onPick={onPick} typeOverride="movie" />
    ) : tab === 'tv' ? (
      <DoubanView onPick={onPick} typeOverride="tv" />
    ) : tab === 'anime' ? (
      <BangumiView onPick={onPick} />
    ) : tab === 'variety' ? (
      <HotListView onPick={onPick} initialListId="douban_show_chinese" />
    ) : recommendSource === 'bangumi' ? (
      <BangumiView onPick={onPick} />
    ) : recommendSource === 'hot-list' ? (
      <HotListView onPick={onPick} />
    ) : (
      <DoubanView onPick={onPick} />
    );
  return (
    <div>
      <h2 className="g-h2">
        {tab === 'anime' ? '新番放送' : tab === 'variety' ? '综艺榜单' : '热门推荐'}{' '}
        <small>{tab === 'anime' ? 'bangumi' : tab === 'variety' ? 'shows' : 'trending'}</small>
      </h2>
      {view}
    </div>
  );
}

/**
 * 豆瓣推荐：影视切换 + 标签筛选。
 * 一次性渲染全部条目：数据本就一次拉全（50 条），卡片图片又是 lazy 加载，
 * 视口外的图不会请求，因此不需要「加载更多」这类本地切片分页来打断浏览。
 */
function DoubanView({ onPick, typeOverride }: { onPick: (title: string) => void; typeOverride?: 'movie' | 'tv' }) {
  const [type, setType] = useState<'movie' | 'tv'>(typeOverride ?? 'movie');
  const [tag, setTag] = useState('热门');

  const query = useQuery({
    queryKey: ['douban', type, tag],
    queryFn: ({ signal }) => api.douban(type, tag, 0, 50, signal),
  });

  // Hero 分类胶囊切换时同步推荐区（同一个分类在两处都可点，状态不分叉）
  useEffect(() => {
    if (typeOverride) setType(typeOverride);
  }, [typeOverride]);

  const tags = type === 'movie' ? MOVIE_TAGS : TV_TAGS;
  const items = query.data?.items ?? [];

  const switchType = (t: 'movie' | 'tv') => {
    if (t === type) return;
    setType(t);
    setTag('热门');
  };

  return (
    <section aria-label="影视推荐">
      {/* 影视/剧集切换 + 标签串并成一行：两侧渐隐、窄屏横滑（m06954-1） */}
      <div className="g-recbar">
        <div className="g-seg2">
          <TypeButton active={type === 'movie'} onClick={() => switchType('movie')}>
            电影
          </TypeButton>
          <TypeButton active={type === 'tv'} onClick={() => switchType('tv')}>
            剧集
          </TypeButton>
        </div>
        <span className="g-recbar-sep" aria-hidden />
        {tags.map((t) => (
          <button
            key={t}
            className={cn('g-tab', t === tag && 'on')}
            onClick={() => setTag(t)}
          >
            {t}
          </button>
        ))}
      </div>

      {query.isError ? (
        <p className="text-center text-sm text-faint py-8">推荐内容加载失败，可稍后重试或在设置中关闭</p>
      ) : query.isLoading ? (
        <GridSkeleton />
      ) : items.length === 0 ? (
        <p className="text-center text-sm text-faint py-8">该分类暂无推荐内容</p>
      ) : (
        <div className="g-grid">
          {items.map((item) => (
            <DoubanCard key={item.id} item={item} onClick={() => onPick(item.title)} />
          ))}
        </div>
      )}
    </section>
  );
}

/** Bangumi 每日放送：星期筛选，一次拉全量无分页 */
function BangumiView({ onPick }: { onPick: (title: string) => void }) {
  const [weekday, setWeekday] = useState<number | 'all'>('all');

  const query = useQuery({
    queryKey: ['bangumi-calendar'],
    queryFn: ({ signal }) => api.bangumiCalendar(signal),
  });

  let items: DoubanItem[] = [];
  if (query.data) {
    items = weekday === 'all'
      ? query.data.days.flatMap((d) => d.items)
      : (query.data.days.find((d) => d.weekday === weekday)?.items ?? []);
  }

  return (
    <section aria-label="新番放送推荐">
      <div className="g-recbar">
        <ChipButton active={weekday === 'all'} onClick={() => setWeekday('all')}>
          全部
        </ChipButton>
        {WEEKDAYS.map((name, i) => (
          <ChipButton key={name} active={weekday === i + 1} onClick={() => setWeekday(i + 1)}>
            {name}
          </ChipButton>
        ))}
      </div>

      {query.isError ? (
        <p className="text-center text-sm text-faint py-8">推荐内容加载失败，可稍后重试或在设置中关闭</p>
      ) : query.isLoading ? (
        <GridSkeleton />
      ) : (
        <div className="g-grid">
          {items.map((item) => (
            <DoubanCard key={item.id} item={item} onClick={() => onPick(item.title)} />
          ))}
        </div>
      )}
    </section>
  );
}

const HOT_LISTS = [
  { id: 'douban_movie_weekly', label: '电影周榜' },
  { id: 'douban_tv_chinese', label: '国产剧周榜' },
  { id: 'douban_tv_global', label: '海外剧周榜' },
  { id: 'douban_show_chinese', label: '国内综艺' },
  { id: 'douban_show_global', label: '海外综艺' },
  { id: 'baidu_teleplay', label: '百度热播剧' },
];

/** 影视热榜（60s API）：豆瓣五个周榜 + 百度热播剧，chips 切换 */
function HotListView({ onPick, initialListId }: { onPick: (title: string) => void; initialListId?: string }) {
  const [listId, setListId] = useState(initialListId ?? HOT_LISTS[0].id);

  useEffect(() => {
    if (initialListId) setListId(initialListId);
  }, [initialListId]);

  const query = useQuery({
    queryKey: ['hot-list', listId],
    queryFn: ({ signal }) => api.hotList(listId, signal),
  });

  const items = query.data?.items ?? [];

  return (
    <section aria-label="影视榜单推荐">
      <div className="g-recbar">
        {HOT_LISTS.map((l) => (
          <ChipButton key={l.id} active={listId === l.id} onClick={() => setListId(l.id)}>
            {l.label}
          </ChipButton>
        ))}
      </div>

      {query.isError ? (
        <p className="text-center text-sm text-faint py-8">推荐内容加载失败，可稍后重试或在设置中关闭</p>
      ) : query.isLoading ? (
        <GridSkeleton />
      ) : (
        <div className="g-grid">
          {items.map((item) => (
            <DoubanCard key={item.id} item={item} onClick={() => onPick(item.title)} />
          ))}
        </div>
      )}
    </section>
  );
}

function GridSkeleton() {
  return (
    // 模糊占位（m06954-2）：整组模糊 + 呼吸，和路由骨架同一套语言
    <div className="g-grid g-soft-group" aria-hidden>
      {Array.from({ length: 16 }).map((_, i) => (
        <div key={i}>
          <div className="aspect-[2/3] rounded-xl bg-chip" />
          <div className="h-3 mt-2 rounded bg-chip" />
        </div>
      ))}
    </div>
  );
}

function ChipButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className={cn('g-tab', active && 'on')}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function TypeButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className={cn('g-seg2-i', active && 'on')}
      onClick={onClick}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}