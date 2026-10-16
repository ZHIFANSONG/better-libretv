'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ThemeToggle } from './theme';
import { SourceManagerDrawer } from './source-manager';
import { HistoryPanel } from './history-panel';
import { requestShowDownloadManager } from './download-manager';
import { Icon } from './icon';
import { SearchHistoryDropdown, useSearchHistory } from './search-history';
import { cn } from '@/lib/utils';

/**
 * 顶部导航（proposal-3pages 版）：浮动胶囊玻璃条。
 * 左侧品牌 mark + 4 个导航项（首页/搜索/直播/我的），右侧两个圆形玻璃图标（主题、菜单）。
 * 搜索仍走首页 ?s=：这里只做入口与最近搜索下拉，不做结果页。
 */
const NAV_ITEMS = [
  { href: '/', label: '首页' },
  { href: '/search', label: '搜索' },
  { href: '/live', label: '直播' },
  { href: '/me', label: '我的' },
] as const;

export function Header({ showSearch = false }: { showSearch?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchHistory = useSearchHistory(query);

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

  return (
    <>
      <div className="g-nav">
        <div className="g-nav-bar g-glass lg" data-lg="depth=30 k=0.85">
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
              className="hidden lg:block flex-1 max-w-xs"
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
          <div className="g-ic lg" data-lg="depth=18 k=0.7">
            <ThemeToggle />
          </div>
          <button
            type="button"
            className="g-ic lg"
            data-lg="depth=18 k=0.7"
            title="设置"
            aria-label="设置"
            onClick={() => setSettingsOpen(true)}
          >
            <Icon name="gear" className="w-4 h-4" />
          </button>
          <button
            type="button"
            className="g-ic lg hidden sm:grid"
            data-lg="depth=18 k=0.7"
            title="观看历史"
            aria-label="观看历史"
            onClick={() => setHistoryOpen(true)}
          >
            <Icon name="clock" className="w-4 h-4" />
          </button>
          <button
            type="button"
            className="g-ic lg hidden md:grid"
            data-lg="depth=18 k=0.7"
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
