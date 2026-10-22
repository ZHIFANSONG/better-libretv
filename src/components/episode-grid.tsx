'use client';

import { useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '@/lib/utils';

/**
 * 选集网格（虚拟滚动）。
 *
 * 为什么要虚拟：采集站的国产剧动辄 500~1000 集（短剧更夸张），旧实现把每个集数
 * 都渲染成一个 button —— 一次进播放页就是上千个节点，移动端首屏明显卡顿，
 * 而且每个按钮都挂了一个 useRef + scrollIntoView 的 effect。
 * 现在只渲染可视区那几行，DOM 恒定在 3~4 行（几十个节点）。
 *
 * 列数由**容器宽度**决定而不是视图宽度：同一个组件既用在桌面侧栏（340px 窄卡）
 * 也用在手机单列（满宽），按 viewport 断点会在桌面上得到 4 列、手机上也是 4 列，
 * 但 iPad 竖屏满宽明明放得下 6 列。实测容器宽度最省心。
 */

/** 行间距，必须与 .g-eps-row 的 gap 一致，否则滚动到底部会差几像素 */
const ROW_GAP = 7;
/** 单个格子的高度，与 CSS .g-ep 的 height 绑定 */
const ITEM_HEIGHT = 32;
/** 每个格子至少这么宽，低于它就把列数减一，避免集数被压成省略号 */
const MIN_CELL_WIDTH = 44;

function columnsFor(width: number): number {
  if (!width) return 4;
  const fit = Math.floor((width + ROW_GAP) / (MIN_CELL_WIDTH + ROW_GAP));
  return Math.min(Math.max(fit, 2), 8);
}

export function EpisodeGrid({
  count,
  currentIndex,
  reversed,
  onSelect,
}: {
  count: number;
  currentIndex: number;
  reversed: boolean;
  onSelect: (index: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(4);

  // 容器宽度 → 列数。ResizeObserver 而不是监听 window resize：
  // 侧栏在 900px 断点从「340px 固定宽」变成「满宽」，那是 CSS 造成的宽度变化，
  // window resize 不一定同步触发（比如只是抽屉展开/收起）。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setCols(columnsFor(el.clientWidth));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rowCount = Math.ceil(count / cols);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ITEM_HEIGHT + ROW_GAP,
    overscan: 4,
  });

  // 当前集变化（换集、自动连播、从历史进来）时把它滚进可视区。
  // 倒序时「显示位次」与「真实集号」是镜像关系，按显示位次算行号才不会滚错。
  useEffect(() => {
    if (count === 0) return;
    const display = reversed ? count - 1 - currentIndex : currentIndex;
    if (display < 0 || display >= count) return;
    virtualizer.scrollToIndex(Math.floor(display / cols), { align: 'auto' });
  }, [count, currentIndex, cols, reversed, virtualizer]);

  return (
    <div ref={scrollRef} className="g-eps">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((row) => (
          <div
            key={row.key}
            className="g-eps-row"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: ITEM_HEIGHT,
              transform: `translateY(${row.start}px)`,
              gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
            }}
          >
            {Array.from({ length: cols }, (_, c) => {
              const display = row.index * cols + c;
              if (display >= count) return <span key={c} aria-hidden="true" />;
              const realIndex = reversed ? count - 1 - display : display;
              return (
                <button
                  key={c}
                  type="button"
                  className={cn('g-ep', realIndex === currentIndex && 'on')}
                  onClick={() => onSelect(realIndex)}
                  aria-current={realIndex === currentIndex ? 'true' : undefined}
                >
                  {realIndex + 1}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
