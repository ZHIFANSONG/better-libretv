'use client';

import type { QualityEntry } from '@/lib/types';
import { qualityLabel } from '@/lib/quality';
import { cn } from '@/lib/utils';
import { useT } from './lang-sync';

/**
 * 画质徽章。
 *
 * 四态：探测中 → 「…」；源站没写画质信息 → 「未知」；探测本身失败 → 「未探到」；
 * 尚未探测 → 不渲染。
 *
 * 后两种在数值上完全一样（都没有分辨率），但成因完全不同：前者是源站是单码率流、
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
  const t = useT();
  if (loading) {
    return (
      <i className={cn('g-qb g-qb-idle', className)} title={t('qb.probing')} aria-label={t('qb.probingAria')}>
        …
      </i>
    );
  }
  if (!entry) return null;
  const label = qualityLabel(entry.height, entry.width);
  if (!label) {
    return (
      <i
        className={cn('g-qb g-qb-unknown', className)}
        title={entry.error ? t('qb.failTip', { msg: entry.error }) : t('qb.unknownTip')}
      >
        {entry.error ? t('qb.untested') : t('qb.unknown')}
      </i>
    );
  }
  // 配色与判档同口径，以宽度为准：1920×752 这类裁切过的高清源宽度仍是 1920，
  // 按高度（752）会把它误踢进标清配色。宽度缺失时才退回高度判断。
  const width = entry.width ?? 0;
  const height = entry.height ?? 0;
  const hd = width > 0 ? width >= 1920 : height >= 1080;
  return (
    <i
      className={cn('g-qb', hd ? 'g-qb-hd' : 'g-qb-sd', className)}
      title={entry.from === 'play' ? t('qb.measuredTip') : t('qb.parsedTip')}
    >
      {label}
    </i>
  );
}
