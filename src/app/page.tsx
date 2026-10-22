'use client';

import { Suspense, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Header } from '@/components/header';
import { RecommendSection, type HeroTab } from '@/components/douban-section';
import { ContinueWatchingSection } from '@/components/continue-watching';
import { SearchHistoryDropdown, useSearchHistory } from '@/components/search-history';
import { Icon } from '@/components/icon';
import { SiteFooter } from '@/components/site-footer';
import { useT } from '@/components/lang-sync';
import { useToast } from '@/components/toast';
import { cn } from '@/lib/utils';
import { bubbleBox, placeSlider, sameBox, type BubbleBox } from '@/lib/glass-nav';

/**
 * 首页（proposal A）：Hero 搜索胶囊 + 分类胶囊 + 热门推荐 / 继续观看两段海报区。
 * 原来右侧常驻的「播放设置」玻璃抽屉已删除（v16，设置统一走顶栏齿轮）。搜索本身交给搜索页（/search?q=），
 * 旧链接 ?s= 会被原地重定向过去，保证老书签与分享链接继续可用。
 */
/** 首屏分段控件里的分类（直播是独立出去的跳转，不参与选中态） */
const SEG_ITEMS: { id: HeroTab; labelKey: string }[] = [
  { id: 'all', labelKey: 'bucket.all' },
  { id: 'movie', labelKey: 'bucket.movie' },
  { id: 'tv', labelKey: 'bucket.tv' },
  { id: 'anime', labelKey: 'bucket.anime' },
  { id: 'variety', labelKey: 'bucket.variety' },
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
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const t = useT();
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

  // 按钮的「跳转中」状态必须有兜底复位：push 失败（离线 / 被拦截）时首页会永久禁用搜索。
  // 用 8s 超时兜底，另外路由一变就复位。
  useEffect(() => {
    if (!navigating) return;
    const timer = window.setTimeout(() => setNavigating(false), 8000);
    return () => window.clearTimeout(timer);
  }, [navigating]);
  useEffect(() => {
    setNavigating(false);
  }, [pathname, searchParams]);

  // 旧版首页搜索结果是 /?s=xxx：直接搬到搜索页，避免同一功能保留两套实现
  useEffect(() => {
    if (legacyQuery) router.replace(`/search?q=${encodeURIComponent(legacyQuery)}`);
  }, [legacyQuery, router]);

  /**
   * 把高亮块挪到当前选中的分类上。写 style 而不是走 state：位置每帧喂给渲染没有意义。
   * 滑动同样交给 CSS transition（glass-glide 在 CSS 后端不生效，原因见 header.tsx 的 syncBubble）。
   */
  const syncSeg = useCallback((opts: { instant?: boolean } = {}) => {
    const seg = segRef.current;
    const ind = segIndRef.current;
    if (!seg || !ind) return;
    const box = bubbleBox(seg, seg.querySelector<HTMLElement>('.g-seg-i.on'));
    if (!box) {
      ind.style.opacity = '0';
      return;
    }
    const prev = segBoxRef.current;
    if (prev && sameBox(prev, box)) {
      ind.style.opacity = '1';
      return;
    }
    segBoxRef.current = box;
    placeSlider(ind, box, { animate: !opts.instant, key: 'g-seg-ind' });
    ind.style.opacity = '1';
  }, []);

  useEffect(() => {
    syncSeg();
    // rAF 会传时间戳进来，这里只认 opts，包一层。
    const raf = requestAnimationFrame(() => syncSeg());
    // 窗口尺寸变化时元素本身在动，跟着滑反而拖泥带水，直接贴着走。
    const onResize = () => syncSeg({ instant: true });
    window.addEventListener('resize', onResize);
    const seg = segRef.current;
    const ro = typeof ResizeObserver !== 'undefined' && seg ? new ResizeObserver(onResize) : null;
    if (seg && ro) ro.observe(seg);
    // 字体晚一步到，格子的宽度会变，量一次再定。
    if (typeof document !== 'undefined' && 'fonts' in document) {
      void document.fonts.ready.then(() => syncSeg({ instant: true }));
    }
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
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
      toast(t('search.emptyInput'), 'info');
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
        <section className="g-hero" aria-label={t('home.heroLabel')}>
          {/* 品牌区：上游首屏那块渐变字标题，proposal 版式里它被丢了，这里补回来 */}
          <div className="g-hero-head">
            <h1 className="g-hero-title brand-gradient hero-glow">LibreTV</h1>
            <p className="g-hero-sub">
              {t('home.heroTitle')} <small>multi-source</small>
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
                placeholder={t('search.placeholderHome')}
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
              <button type="submit" className={cn('go', navigating && 'busy')} disabled={navigating}>
                <Icon name="search" className="go-ic-only w-4 h-4" />
                <span className="go-tx">{t('search.button')}</span>
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
              {/* 滑动由 .g-seg-ind 的 CSS transition 负责（glass-glide 在 CSS 后端是死代码），
                  所以不再挂 glass-glide / glass-jelly。 */}
              <span className="g-seg-ind" style={IND_INIT} ref={segIndRef} aria-hidden glass="tinted" glass-blur="10" />
              {SEG_ITEMS.map((seg) => (
                <button
                  key={seg.id}
                  type="button"
                  className={cn('g-seg-i', seg.id === tab && 'on')}
                  aria-pressed={seg.id === tab}
                  onClick={() => setTab(seg.id)}
                >
                  {t(seg.labelKey)}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="g-seg-x"
              onClick={() => router.push('/live')}
              aria-label={t('home.liveLabel')}
            >
              <span className="g-livedot" aria-hidden />
              {t('home.live')}
            </button>
          </div>
        </section>

        <RecommendSection onPick={goSearch} tab={tab} />
        <ContinueWatchingSection />
      </main>

      <SiteFooter />
    </div>
  );
}