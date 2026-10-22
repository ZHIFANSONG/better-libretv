'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ThemeToggle } from './theme';
import { SourceManagerDrawer } from './source-manager';
import { HistoryPanel } from './history-panel';
import { requestShowDownloadManager } from './download-manager';
import { Icon } from './icon';
import { SearchHistoryDropdown, useSearchHistory } from './search-history';
import { cn } from '@/lib/utils';
import { bubbleBox, placeSlider, sameBox, type BubbleBox } from '@/lib/glass-nav';
import { useT } from './lang-sync';

/**
 * 顶部导航（glassium 版）：整条胶囊是一块 runtime 玻璃（`glass="regular"`），
 * 选中态是一块会「飞过去」的玻璃气泡（`glass-glide` + `glass-jelly`）。
 *
 * 为什么不用 <glass-tab-bar>：它的 ::slotted(*) 会把每格塞成「图标 + 文字两行 11px」，
 * 而顶栏要的是横排文字链接与 Next 的 <Link> 语义；官方的 glass-glide 本就是
 * 「元素一帧跳 >24px 就让玻璃飞过去」，挪一块绝对定位的玻璃即可。
 */
const NAV_ITEMS = [
  { href: '/', key: 'nav.home' },
  { href: '/search', key: 'nav.search' },
  { href: '/live', key: 'nav.live' },
  { href: '/me', key: 'nav.me' },
] as const;

/** 首屏的初始盒子：量到之前不许闪。 */
const BUBBLE_INIT: CSSProperties = { left: 0, top: 0, width: 0, height: 0, opacity: 0 };

export function Header({ showSearch = false }: { showSearch?: boolean }) {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchHistory = useSearchHistory(query);
  const barRef = useRef<HTMLDivElement | null>(null);
  const bubbleRef = useRef<HTMLSpanElement | null>(null);
  const boxRef = useRef<BubbleBox | null>(null);

  const submitSearch = (text: string) => {
    const q = text.trim().slice(0, 100);
    if (!q) return;
    searchHistory.close();
    router.push(`/search?q=${encodeURIComponent(q)}`, { scroll: false });
    searchHistory.record(q);
  };

  const pickHistory = (text: string) => {
    setQuery(text);
    submitSearch(text);
  };

  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

  /**
   * 把气泡挪到当前选中项上。写 style 而不是走 state：位置每帧喂给渲染没有意义。
   *
   * 滑动效果：过去指望 glassium 的 glass-glide，但它在 backend:'css' 下是死代码
   * （node_modules/glassium/dist/runtime/glass.js:211 要求 backend !== 'css'），
   * 而本项目为了兼容性锁的就是 CSS 后端 —— 所以改成 CSS transition 自己滑
   * （.g-nav-bubble 的 transition，见 proposal.css）。
   * 首帧与跨大半屏的跳转走 placeSlider(..., { animate: false }) 瞬移。
   */
  const syncBubble = useCallback((opts: { instant?: boolean } = {}) => {
    const bar = barRef.current;
    const bubble = bubbleRef.current;
    if (!bar || !bubble) return;
    let box: BubbleBox | null = null;
    // 两套 <nav> 都在 DOM 里（窄屏那套 display:none），量得到的才是当前生效的那个。
    for (const el of Array.from(bar.querySelectorAll<HTMLElement>('.g-navlink.on'))) {
      const b = bubbleBox(bar, el);
      if (b) {
        box = b;
        break;
      }
    }
    if (!box) {
      bubble.style.opacity = '0';
      return;
    }
    const prev = boxRef.current;
    if (prev && sameBox(prev, box)) {
      bubble.style.opacity = '1';
      return;
    }
    boxRef.current = box;
    // 交给 placeSlider 判定要不要飞：它会记住上一次的真正落点（跨 loading 壳重挂载也接得上）。
    placeSlider(bubble, box, { animate: !opts.instant, key: 'g-nav-bubble' });
    bubble.style.opacity = '1';
  }, []);

  useEffect(() => {
    syncBubble();
    // rAF 会传时间戳进来，这里只认 opts，包一层。
    const raf = requestAnimationFrame(() => syncBubble());
    // 改窗口尺寸时元素本身在动，跟着滑反而拖泥带水，直接贴着走。
    const onResize = () => syncBubble({ instant: true });
    window.addEventListener('resize', onResize);
    const bar = barRef.current;
    const ro = typeof ResizeObserver !== 'undefined' && bar ? new ResizeObserver(onResize) : null;
    if (bar && ro) ro.observe(bar);
    // 字体晚一步到，链接宽度会变，量一次再定。
    if (typeof document !== 'undefined' && 'fonts' in document) {
      void document.fonts.ready.then(() => syncBubble({ instant: true }));
    }
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      ro?.disconnect();
    };
  }, [syncBubble]);

  useEffect(() => {
    syncBubble();
  }, [pathname, showSearch, syncBubble]);

  return (
    <>
      <div className="g-nav">
        <div ref={barRef} className="g-nav-bar g-glass" glass="regular" glass-blur="14" glass-tint="rgba(255,255,255,.08)">
          {/*
            * 这里原本写着 glass-glide / glass-jelly，但运行时的 CSS 后端不会执行它们
            * （glassium/dist/runtime/glass.js:211 要求 backend !== 'css'），留着只会
            * 误导后来人以为滑动是 glassium 给的。滑动改由 .g-nav-bubble 的 CSS
            * transition + syncBubble 里的 placeSlider 负责，所以这两个属性删掉。
            */}
          <span ref={bubbleRef} className="g-nav-bubble" style={BUBBLE_INIT} glass="tinted" glass-blur="10" aria-hidden />
          <Link href="/" aria-label={`LibreTV ${t('nav.home')}`} className="g-brand">
            <span className="g-mark" aria-hidden />
            <span className="hidden min-[400px]:inline">LibreTV</span>
          </Link>

          <nav className="hidden sm:flex items-center gap-1" aria-label={t('nav.home')}>
            {NAV_ITEMS.map((it) => (
              <Link key={it.href} href={it.href} className={cn('g-navlink', isActive(it.href) && 'on')}>
                {t(it.key)}
              </Link>
            ))}
          </nav>
          <nav className="flex sm:hidden items-center gap-0.5" aria-label={t('nav.home')}>
            {NAV_ITEMS.map((it) => (
              <Link key={it.href} href={it.href} className={cn('g-navlink !px-2.5', isActive(it.href) && 'on')}>
                {t(it.key)}
              </Link>
            ))}
          </nav>

          {showSearch && (
            <form
              className="g-nav-search hidden lg:block flex-1 max-w-xs"
              onSubmit={(e) => {
                e.preventDefault();
                submitSearch(query);
              }}
            >
              <div ref={searchHistory.containerRef} className="relative">
                <input
                  className="w-full h-8 rounded-full bg-white/5 border border-white/10 px-3 text-xs text-content placeholder:text-faint focus:outline-none focus:border-accent/60"
                  aria-label={t('nav.searchPlaceholder')}
                  placeholder={t('nav.searchPlaceholder')}
                  value={query}
                  maxLength={100}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    searchHistory.resetActive();
                  }}
                  onFocus={searchHistory.onFocus}
                  onKeyDown={(e) => searchHistory.onKeyDown(e, pickHistory)}
                  role="combobox"
                  aria-expanded={searchHistory.visible}
                  aria-controls="header-search-history"
                  aria-autocomplete="list"
                  aria-activedescendant={
                    searchHistory.visible && searchHistory.activeIndex >= 0
                      ? `header-search-history-${searchHistory.activeIndex}`
                      : undefined
                  }
                />
                {searchHistory.visible && (
                  <SearchHistoryDropdown
                    id="header-search-history"
                    matches={searchHistory.matches}
                    activeIndex={searchHistory.activeIndex}
                    onPick={pickHistory}
                    onRemove={searchHistory.remove}
                    onClearAll={searchHistory.clearAll}
                  />
                )}
              </div>
            </form>
          )}
        </div>

        <div className="g-tools">
          <div className="g-ic" glass="regular" glass-blur="8" glass-tint="rgba(255,255,255,.06)" glass-jelly="">
            <ThemeToggle />
          </div>
          <button
            type="button"
            className="g-ic"
            glass="regular"
            glass-blur="8"
            glass-tint="rgba(255,255,255,.06)"
            glass-jelly=""
            title={t('nav.settings')}
            aria-label={t('nav.settings')}
            onClick={() => setSettingsOpen(true)}
          >
            <Icon name="gear" className="w-4 h-4" />
          </button>
          <button
            type="button"
            className="g-ic g-ic-sm"
            glass="regular"
            glass-blur="8"
            glass-tint="rgba(255,255,255,.06)"
            glass-jelly=""
            title={t('nav.history')}
            aria-label={t('nav.history')}
            onClick={() => setHistoryOpen(true)}
          >
            <Icon name="clock" className="w-4 h-4" />
          </button>
          <button
            type="button"
            className="g-ic g-ic-md"
            glass="regular"
            glass-blur="8"
            glass-tint="rgba(255,255,255,.06)"
            glass-jelly=""
            title={t('nav.downloads')}
            aria-label={t('nav.downloads')}
            onClick={requestShowDownloadManager}
          >
            <Icon name="download" className="w-4 h-4" />
          </button>
        </div>
      </div>

      <SourceManagerDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <HistoryPanel open={historyOpen} onClose={() => setHistoryOpen(false)} />
    </>
  );
}
