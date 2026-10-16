'use client';

import { Suspense, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
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
import { bubbleBox, sameBox, type BubbleBox } from '@/lib/glass-nav';

/**
 * 首页（proposal A）：Hero 搜索胶囊 + 分类胶囊 + 热门推荐 / 继续观看两段海报区，
 * 右侧常驻「播放设置」玻璃抽屉。搜索本身交给搜索页（/search?q=），
 * 旧链接 ?s= 会被原地重定向过去，保证老书签与分享链接继续可用。
 */
/** 首屏分段控件里的分类（直播是独立出去的跳转，不参与选中态） */
const SEG_ITEMS: { id: HeroTab; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'movie', label: '电影' },
  { id: 'tv', label: '剧集' },
  { id: 'anime', label: '动漫' },
  { id: 'variety', label: '综艺' },
];

/** 指示块的初始样式：量到之前不可见，避免 SSR/首帧在左上角闪一下 */
const IND_INIT: CSSProperties = { left: 0, top: 0, width: 0, height: 0, opacity: 0 };

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
  // 提交后到搜索页渲染出来之前，搜索按钮压暗（页面很快卸载，不需要清理定时器）
  const [navigating, setNavigating] = useState(false);
  const [tab, setTab] = useState<HeroTab>('all');
  const inputRef = useRef<HTMLInputElement>(null);
  const searchHistory = useSearchHistory(input);
  const segRef = useRef<HTMLDivElement>(null);
  const segIndRef = useRef<HTMLSpanElement>(null);
  const segBoxRef = useRef<BubbleBox | null>(null);

  // 旧版首页搜索结果是 /?s=xxx：直接搬到搜索页，避免同一功能保留两套实现
  useEffect(() => {
    if (legacyQuery) router.replace(`/search?q=${encodeURIComponent(legacyQuery)}`);
  }, [legacyQuery, router]);

  /**
   * 把高亮块挪到当前选中的分类上。写 style 而不是走 state：位置只喂给 glassium 的
   * ElementMotion，每帧重渲染 React 没有意义，而且玻璃要看到「一次跳变」才会起飞。
   * 和顶栏气泡同一套做法（src/components/header.tsx 的 syncBubble）。
   */
  const syncSeg = useCallback(() => {
    const seg = segRef.current;
    const ind = segIndRef.current;
    if (!seg || !ind) return;
    const box = bubbleBox(seg, seg.querySelector<HTMLElement>('.g-seg-i.on'));
    if (!box) {
      ind.style.opacity = '0';
      return;
    }
    if (segBoxRef.current && sameBox(segBoxRef.current, box)) {
      ind.style.opacity = '1';
      return;
    }
    segBoxRef.current = box;
    ind.style.left = `${box.x}px`;
    ind.style.top = `${box.y}px`;
    ind.style.width = `${box.w}px`;
    ind.style.height = `${box.h}px`;
    ind.style.opacity = '1';
  }, []);

  useEffect(() => {
    syncSeg();
    const raf = requestAnimationFrame(syncSeg);
    window.addEventListener('resize', syncSeg);
    const seg = segRef.current;
    const ro = typeof ResizeObserver !== 'undefined' && seg ? new ResizeObserver(syncSeg) : null;
    if (seg && ro) ro.observe(seg);
    // 字体晚一步到，格子的宽度会变，量一次再定。
    if (typeof document !== 'undefined' && 'fonts' in document) {
      void document.fonts.ready.then(() => syncSeg());
    }
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', syncSeg);
      ro?.disconnect();
    };
  }, [syncSeg]);

  useEffect(() => {
    syncSeg();
  }, [tab, syncSeg]);

  const goSearch = (text: string) => {
    const q = text.trim().slice(0, 100);
    if (navigating) return;
    if (!q) {
      toast('请输入搜索内容', 'info');
      inputRef.current?.focus();
      return;
    }
    searchHistory.close();
    searchHistory.record(q);
    setNavigating(true);
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
          {/* 品牌区：上游首屏那块渐变字标题，proposal 版式里它被丢了，这里补回来 */}
          <div className="g-hero-head">
            <h1 className="g-hero-title brand-gradient hero-glow">LibreTV</h1>
            <p className="g-hero-sub">
              自由观影，畅想精彩 <small>multi-source</small>
            </p>
          </div>

          <div ref={searchHistory.containerRef} className="g-hero-search relative">
            <form
              className={cn('g-search', searchHistory.visible && 'g-open')}
              glass="regular"
              glass-blur="12"
              glass-tint="rgba(255,255,255,.07)"
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
              <button type="submit" className={cn('go', navigating && 'busy')} disabled={navigating}>
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

          {/* 分类：原来 6 个散胶囊收成一条分段控件，选中项由一块滑动玻璃标出 */}
          <div className="g-seg-row">
            <div className="g-seg" ref={segRef}>
              <span
                className="g-seg-ind"
                style={IND_INIT}
                ref={segIndRef}
                aria-hidden
                glass="tinted"
                glass-blur="10"
                glass-jelly=""
                glass-glide=""
              />
              {SEG_ITEMS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={cn('g-seg-i', t.id === tab && 'on')}
                  aria-pressed={t.id === tab}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="g-seg-x"
              onClick={() => router.push('/live')}
              aria-label="进入直播"
            >
              <span className="g-livedot" aria-hidden />
              直播
            </button>
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