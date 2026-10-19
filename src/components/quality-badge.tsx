'use client';

import type { QualityEntry } from '@/lib/types';
import { qualityLabel } from '@/lib/quality';
import { cn } from '@/lib/utils';

/**
 * 画质徽章。
 *
 * 四态：探测中 → 「…」；源站没写画质信息 → 「未知」；探测本身失败 → 「未探到」；
 * 尚未探测 → 不渲染。
 *
 * 后两种在数值上完全一样（都没有 height），但成因完全不同：前者是源站是单码率流、
 * 服务端无论如何测不出；后者是请求被拒/超时。文案与 tooltip 分开，否则用户无法判断
 * 是该等一等重试，还是只能播一次才知道。
 *
 * 样式走 proposal.css 的 .g-qb 系列（搜索结果卡片、详情弹窗、换源卡共用一套，
 * 三处如果各写一份 Tailwind class，暗色主题下很容易只改一处）。
 */
export function QualityBadge({
  entry,
  loading,
  className,
}: {
  entry?: QualityEntry;
  loading?: boolean;
  className?: string;
}) {
  if (loading) {
    return (
      <i className={cn('g-qb g-qb-idle', className)} title="正在探测画质…" aria-label="正在探测画质">
        …
      </i>
    );
  }
  if (!entry) return null;
  const label = qualityLabel(entry.height);
  if (!label) {
    return (
      <i
        className={cn('g-qb g-qb-unknown', className)}
        title={
          entry.error
            ? `画质探测失败：${entry.error}（可能是防盗链或源站超时）`
            : '单码率或直链，播放列表里没有画质信息；播放一次后会记录实测分辨率'
        }
      >
        {entry.error ? '未探到' : '未知'}
      </i>
    );
  }
  const hd = (entry.height ?? 0) >= 1080;
  return (
    <i
      className={cn('g-qb', hd ? 'g-qb-hd' : 'g-qb-sd', className)}
      title={entry.from === 'play' ? '播放时实测的真实分辨率' : '解析播放列表得到的档位'}
    >
      {label}
    </i>
  );
}
