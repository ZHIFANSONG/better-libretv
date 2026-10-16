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
import { bubbleBox, sameBox, type BubbleBox } from '@/lib/glass-nav';

/**
 * 顶部导航（glassium 版）：整条胶囊是一块 runtime 玻璃（`glass="regular"`），
 * 选中态是一块会「飞过去」的玻璃气泡（`glass-glide` + `glass-jelly`）。
 *
 * 为什么不用 <glass-tab-bar>：它的 ::slotted(*) 会把每格塞成「图标 + 文字两行 11px」，
 * 而顶栏要的是横排文字链接与 Next 的 <Link> 语义；官方的 glass-glide 本就是
 * 「元素一帧跳 >24px 就让玻璃飞过去」，挪一块绝对定位的玻璃即可。
 */
const NAV_ITEMS = [
  { href: '/', label: '首页' },
  { href: '/search', label: '搜索' },
  { href: '/live', label: '直播' },
  { href: '/me', label: '我的' },
] as const;

/** 首屏的初始盒子：量到之前不许闪。 */
const BUBBLE_INIT: CSSProperties = { left: 0, top: 0, width: 0, height: 0, opacity: 0 };

export function Header({ showSearch = false }: { showSearch?: boolean }) {
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
   * 把气泡挪到当前选中项上。写 style 而不是走 state：位置只喂给 glassium 的
   * ElementMotion，每帧重渲染 React 没有意义，而且玻璃要看到「一次跳变」才会起飞。
   */
  const syncBubble = useCallback(() => {
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
    if (boxRef.current && sameBox(boxRef.current, box)) {
      bubble.style.opacity = '1';
      return;
    }
    boxRef.current = box;
    bubble.style.left = `${box.x}px`;
    bubble.style.top = `${box.y}px`;
    bubble.style.width = `${box.w}px`;
    bubble.style.height = `${box.h}px`;
    bubble.style.opacity = '1';
  }, []);

  useEffect(() => {
    syncBubble();
    const raf = requestAnimationFrame(syncBubble);
    const onResize = () => syncBubble();
    window.addEventListener('resize', onResize);
    const bar = barRef.current;
    const ro = typeof ResizeObserver !== 'undefined' && bar ? new ResizeObserver(onResize) : null;
    if (bar && ro) ro.observe(bar);
    // 字体晚一步到，链接宽度会变，量一次再定。
    if (typeof document !== 'undefined' && 'fonts' in document) {
      void document.fonts.ready.then(() => syncBubble());
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
          <span
            ref={bubbleRef}
            className="g-nav-bubble"
            style={BUBBLE_INIT}
            glass="tinted"
            glass-blur="10"
            glass-jelly=""
            glass-glide=""
            aria-hidden
          />
          <Link href="/" aria-label="LibreTV 首页" className="g-brand">
            <span className="g-mark" aria-hidden />
            <span className="hidden min-[400px]:inline">LibreTV</span>
          </Link>

          <nav className="hidden sm:flex items-center gap-1" aria-label="主导航">
            {NAV_ITEMS.map((it) => (
              <Link key={it.href} href={it.href} className={cn('g-navlink', isActive(it.href) && 'on')}>
                {it.label}
              </Link>
            ))}
          </nav>
          <nav className="flex sm:hidden items-center gap-0.5" aria-label="主导航">
            {NAV_ITEMS.map((it) => (
              <Link key={it.href} href={it.href} className={cn('g-navlink !px-2.5', isActive(it.href) && 'on')}>
                {it.label}
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
                  aria-label="搜索影片"
                  placeholder="搜索影片…"
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
            title="设置"
            aria-label="设置"
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
            title="观看历史"
            aria-label="观看历史"
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
            title="下载管理"
            aria-label="下载管理"
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
