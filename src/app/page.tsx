'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Header } from '@/components/header';
import { RecommendSection, type HeroTab } from '@/components/douban-section';
import { ContinueWatchingSection } from '@/components/continue-watching';
import { PlaySettingsDrawer } from '@/components/play-settings-drawer';
import { SearchHistoryDropdown, useSearchHistory } from '@/components/search-history';
import { Icon } from '@/components/icon';
import { SiteFooter } from '@/components/site-footer';
import { useToast } from '@/components/toast';
import { cn } from '@/lib/utils';

/**
 * 首页（proposal A）：Hero 搜索胶囊 + 分类胶囊 + 热门推荐 / 继续观看两段海报区，
 * 右侧常驻「播放设置」玻璃抽屉。搜索本身交给搜索页（/search?q=），
 * 旧链接 ?s= 会被原地重定向过去，保证老书签与分享链接继续可用。
 */
const HERO_TABS: { id: HeroTab | 'live'; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'movie', label: '电影' },
  { id: 'tv', label: '剧集' },
  { id: 'anime', label: '动漫' },
  { id: 'variety', label: '综艺' },
  { id: 'live', label: '直播' },
];

export default function HomePage() {
  return (
    <Suspense>
      <HomeContent />
    </Suspense>
  );
}

function HomeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const legacyQuery = searchParams.get('s') || '';

  const [input, setInput] = useState('');
  const [tab, setTab] = useState<HeroTab>('all');
  const inputRef = useRef<HTMLInputElement>(null);
  const searchHistory = useSearchHistory(input);

  // 旧版首页搜索结果是 /?s=xxx：直接搬到搜索页，避免同一功能保留两套实现
  useEffect(() => {
    if (legacyQuery) router.replace(`/search?q=${encodeURIComponent(legacyQuery)}`);
  }, [legacyQuery, router]);

  const goSearch = (text: string) => {
    const q = text.trim().slice(0, 100);
    if (!q) {
      toast('请输入搜索内容', 'info');
      inputRef.current?.focus();
      return;
    }
    searchHistory.close();
    searchHistory.record(q);
    router.push(`/search?q=${encodeURIComponent(q)}`, { scroll: false });
  };

  const pickHistory = (text: string) => {
    setInput(text);
    goSearch(text);
  };

  return (
    <div className="g-shell min-h-screen flex flex-col">
      <Header />

      <main className="g-page flex-1">
        <section className="g-hero" aria-label="搜索">
          <div ref={searchHistory.containerRef} className="relative">
            <form
              className={cn('g-search lg', searchHistory.visible && 'g-open')}
              data-lg="depth=40 k=0.95"
              onSubmit={(e) => {
                e.preventDefault();
                goSearch(input);
              }}
            >
              <Icon name="search" className="w-[18px] h-[18px] opacity-50 shrink-0" />
              <input
                ref={inputRef}
                placeholder="搜索影片、剧集、直播…"
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
                aria-controls="home-search-history"
                aria-autocomplete="list"
                aria-activedescendant={
                  searchHistory.visible && searchHistory.activeIndex >= 0
                    ? `home-search-history-${searchHistory.activeIndex}`
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
              <button type="submit" className="go">
                搜索
              </button>
            </form>

            {searchHistory.visible && (
              <SearchHistoryDropdown
                id="home-search-history"
                matches={searchHistory.matches}
                activeIndex={searchHistory.activeIndex}
                onPick={pickHistory}
                onRemove={searchHistory.remove}
                onClearAll={searchHistory.clearAll}
              />
            )}
          </div>

          <div className="g-tabs">
            {HERO_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={cn('g-tab', t.id === tab && 'on')}
                aria-pressed={t.id === tab}
                onClick={() => {
                  if (t.id === 'live') {
                    router.push('/live');
                    return;
                  }
                  setTab(t.id);
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
        </section>

        <RecommendSection onPick={goSearch} tab={tab} />
        <ContinueWatchingSection />
      </main>

      <PlaySettingsDrawer />
      <SiteFooter />
    </div>
  );
}