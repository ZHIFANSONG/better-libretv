'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client-api';
import type { SearchResultItem, VideoDetail } from '@/lib/types';
import { isSourceDisabled } from '@/lib/store';
import { latencyLevel } from '@/lib/source-switch';
import { qualityKey } from '@/lib/quality';
import { formatRemarks } from '@/lib/remarks';
import { QualityBadge } from './quality-badge';
import { SmartImage } from './smart-image';
import { useAppStore, resolveSource } from '@/lib/store';
import { useToast } from './toast';
import { cn } from '@/lib/utils';
import { copyToClipboard } from '@/lib/clipboard';
import { EmptyState, ErrorState, LoadingState } from './states';
import { useFocusTrap } from './use-focus-trap';
import { Icon } from './icon';
import { useT } from './lang-sync';

/**
 * 详情弹窗：来源切换 + 剧集列表 + 排序 + 复制链接。
 * 剧集点击 → /watch 路由（URL 携带定位参数，可分享、可后退）。
 *
 * 传了 group 时顶部会列出这部片子的**全部来源**：同一个片名往往在好几个源里都有，
 * 但旧版弹窗只认传入的那一条（items[0]），其余源等于被吞掉，用户只能碰运气。
 */

/**
 * 把接口里的 HTML 简介变成纯文本：去掉 <p>/<br>/<img> 之类的标签、还原常见实体。
 * 不做 dangerouslySetInnerHTML —— 简介来自第三方源，直接注入等于把 XSS 交给源站。
 */
export function plainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function DetailModal({
  item,
  group,
  onSelectItem,
  onPlay,
  onClose,
}: {
  item: SearchResultItem | null;
  /** 同名聚合组（含全部来源）；不传时退化为单源弹窗 */
  group?: { items: SearchResultItem[] } | null;
  /** 切换来源：父组件更新 item 后弹窗自动重新取详情 */
  onSelectItem?: (next: SearchResultItem) => void;
  /** 点集数后去哪儿播（搜索页传的是「跳 /watch」）；弹窗自己不决定播放方式 */
  onPlay: (item: SearchResultItem, startIndex: number) => void;
  onClose: () => void;
}) {
  const t = useT();
  const store = useAppStore();
  const { toast } = useToast();
  const [detail, setDetail] = useState<VideoDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reversed, setReversed] = useState(false);
  const [posterFailed, setPosterFailed] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  /*
   * 选源时的画质探测：弹窗一打开就探，因为「这堆源里哪个画质高」正是用户在
   * 这个界面要做的判断（原来只能靠源名猜）。结果直接进全局缓存，
   * 关掉弹窗再到搜索卡片 / 换源卡上都还在。
   */
  const [qualityProbing, setQualityProbing] = useState(false);
  const qualityAbortRef = useRef<AbortController | null>(null);
  const sources = group?.items ?? (item ? [item] : []);
  const qualitySignature = sources.map((s) => `${s.sourceKey}:${s.vodId}`).join(',');

  useEffect(() => {
    if (!qualitySignature) return;
    const targets = sources
      .map((s) => {
        const source = resolveSource(store, s.sourceKey, { url: s.sourceUrl, name: s.sourceName });
        return source ? { source, id: s.vodId } : undefined;
      })
      .filter((v): v is { source: NonNullable<ReturnType<typeof resolveSource>>; id: string } => Boolean(v));
    if (targets.length === 0) return;

    const controller = new AbortController();
    qualityAbortRef.current?.abort();
    qualityAbortRef.current = controller;
    setQualityProbing(true);
    const collected: Record<string, import('@/lib/types').QualityEntry> = {};
    api
      .qualityProbeStream(
        targets,
        (result) => {
          collected[qualityKey(result.sourceKey, result.vodId)] = {
            height: result.height,
            width: result.width,
            from: 'probe',
            error: result.error,
            timestamp: Date.now(),
          };
        },
        controller.signal
      )
      .catch(() => {
        /* 探测失败不影响选源：徽章就是不显示 */
      })
      .finally(() => {
        // 一次性落库，避免 persist 逐条序列化整个画质表
        if (Object.keys(collected).length > 0) useAppStore.getState().setQuality(collected);
        setQualityProbing(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qualitySignature]);

  // 打开时把焦点移入弹窗、Tab 圈闭在弹窗内、关闭后归还焦点
  useFocusTrap(Boolean(item), panelRef);

  useEffect(() => setPosterFailed(false), [item?.pic, store.imageProxyMode, store.customImageProxy]);

  // 弹窗打开期间锁定背景滚动
  useEffect(() => {
    if (!item) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [item]);

  useEffect(() => {
    if (!item) {
      setDetail(null);
      setError('');
      return;
    }
    const source = resolveSource(store, item.sourceKey, {
      url: item.sourceUrl,
      name: item.sourceName,
    });
    if (!source) {
      setError('dm.sourceMissing');
      return;
    }
    setLoading(true);
    setError('');
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    api
      .detail(item.vodId, source, controller.signal)
      .then((d) => setDetail(d))
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'dm.detailFailed');
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item]);

  useEffect(() => {
    if (!item) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [item, onClose]);

  if (!item) return null;

  // error 里可能是字典 key（我们自己写的提示）也可能是源站返回的原文：非 key 时 tr 原样返回
  const errorText = error ? (t(error) === error ? error : t(error)) : '';

  const episodes = detail ? (reversed ? [...detail.episodes].reverse() : detail.episodes) : [];
  const info = detail?.videoInfo;
  const groupItems = group?.items?.length ? group.items : [item];
  // 同一源可能同时被预置源与订阅源提供：按 sourceKey 去重，避免出现两个一模一样的胶囊
  const sourceChips = groupItems.filter(
    (it, i, arr) => arr.findIndex((x) => x.sourceKey === it.sourceKey) === i
  );

  // 播放交给父组件：弹窗只负责「选了哪一集」，不掺和路由（原来这里还有一段
  // addSearchHistory + router.push 的兜底，v14 之后已无调用方能走到，删掉）
  const play = (index: number) => onPlay(item, index);

  const copyLinks = async () => {
    if (!detail) return;
    const ok = await copyToClipboard(detail.episodes.join('\n'));
    if (ok) toast(t('dm.copied'), 'success');
    else toast(t('dm.copyFailed'), 'error');
  };

  const metaRows = [
    info?.typeName && [t('dm.metaType'), info.typeName],
    info?.year && [t('dm.metaYear'), info.year],
    info?.area && [t('dm.metaArea'), info.area],
    info?.director && [t('dm.metaDirector'), info.director],
    info?.actor && [t('dm.metaActor'), info.actor],
    // 备注与卡片同源，同样归一化，避免同一部剧在两处显示不同文案
    formatRemarks(info?.remarks) && [t('dm.metaRemarks'), formatRemarks(info?.remarks)!],
  ].filter(Boolean) as [string, string][];

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-black/80 p-4 animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="g-panel g-detail-modal rounded-xl w-full max-w-4xl max-h-[92vh] overflow-y-auto scrollbar-thin animate-slide-up outline-none"
        glass="frosted"
        glass-blur="14"
        overlay=""
        role="dialog"
        aria-modal="true"
        aria-label={t('dm.aria', { name: item.name })}
      >
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-line">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-content break-words">{item.name}</h2>
            <span className="text-sm text-faint">
              {item.sourceName}
              {sourceChips.length > 1 ? t('dm.sourcesCount', { n: sourceChips.length }) : ''}
            </span>
          </div>
          <button
            className="p-1.5 rounded-md text-muted hover:text-content hover:bg-hover shrink-0"
            onClick={onClose}
            aria-label={t('common.close')}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-5 pt-4">
          {loading && <LoadingState label={t('dm.loading')} />}

          {!loading && error && <ErrorState message={errorText || t('dm.failed')} />}

          {!loading && detail && (
            <>
              {/* 来源胶囊不依赖详情接口：详情挂了照样能换源，所以提到 loading/error 之外 */}
              {sourceChips.length > 1 && (
                <div className="g-srcrow-wrap">
                  <span className="g-srcrow-label">{t('dm.pickSource')}</span>
                  {sourceChips.map((it) => {
                    const active = it.sourceKey === item.sourceKey;
                    const off = isSourceDisabled(store, it.sourceKey);
                    // 同一个源在本页被换过之后，这里补一个耗时圆点：选源时就有依据，
                    // 而不是把每个源都点一遍再等播不出来
                    const h = store.sourceHealth?.[it.sourceKey];
                    return (
                      <button
                        key={it.sourceKey}
                        className={cn('g-srcchip', active && 'on', off && 'off')}
                        disabled={active}
                        title={
                          off
                            ? t('dm.offTip', { name: it.sourceName })
                            : t('dm.switchTip', {
                                name: it.sourceName,
                                extra: h?.ms != null ? t('dm.switchTipExtra', { ms: h.ms }) : '',
                              })
                        }
                        onClick={() => onSelectItem?.(it)}
                      >
                        {h && <i className={cn('g-dot', latencyLevel({ ok: h.ok, ms: h.ms }))} />}
                        {it.sourceName || it.sourceKey}
                        <QualityBadge
                          entry={store.qualityMap?.[qualityKey(it.sourceKey, it.vodId)]}
                          loading={qualityProbing && !store.qualityMap?.[qualityKey(it.sourceKey, it.vodId)]}
                        />
                        {it.remarks ? <em>{it.remarks}</em> : null}
                      </button>
                    );
                  })}
                </div>
              )}

              <div className="flex flex-col sm:flex-row gap-4 mb-4">
                {item?.pic && !posterFailed && (
                  <SmartImage
                    url={item.pic}
                    mode={store.imageProxyMode}
                    customProxy={store.customImageProxy}
                    alt={item.name}
                    className="w-28 sm:w-40 aspect-[2/3] object-cover rounded-lg bg-chip shrink-0 self-center sm:self-start"
                    loading="eager"
                    onExhausted={() => setPosterFailed(true)}
                  />
                )}
                <div className="min-w-0 space-y-3">
                  {metaRows.length > 0 && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
                      {metaRows.map(([k, v]) => (
                        <div key={k} className="truncate" title={`${k}: ${v}`}>
                          <span className="text-faint">{k}:</span>{' '}
                          <span className="text-content">{v}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {/* 很多源的简介是 HTML（<p>、<br>、&nbsp;），直接渲染会把标签当正文显示出来 */}
                  {info?.desc && (
                    <p className="text-sm text-muted leading-relaxed line-clamp-4">{plainText(info.desc)}</p>
                  )}
                </div>
              </div>

              {episodes.length > 0 ? (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                    <div className="flex items-center gap-2">
                      <button
                        className="btn-ghost btn-sm"
                        onClick={() => setReversed((v) => !v)}
                        aria-label={reversed ? t('dm.sortToAsc') : t('dm.sortToDesc')}
                        title={t('dm.sortTip')}
                      >
                        <Icon
                          name="arrowDown"
                          className={cn('w-3.5 h-3.5 transition-transform', reversed && 'rotate-180')}
                        />
                        {reversed ? t('dm.sortAscLabel') : t('dm.sortDescLabel')}
                      </button>
                      <span className="text-sm text-faint">{t('dm.episodesCount', { n: episodes.length })}</span>
                    </div>
                    <button className="btn-primary btn-sm" onClick={copyLinks}>
                      {t('dm.copy')}
                    </button>
                  </div>
                  <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-2 max-h-[36vh] overflow-y-auto scrollbar-thin pr-1">
                    {episodes.map((_, i) => {
                      const realIndex = reversed ? detail.episodes.length - 1 - i : i;
                      return (
                        <button
                          key={realIndex}
                          className="btn-ghost btn-sm !px-1 text-center"
                          onClick={() => play(realIndex)}
                        >
                          {realIndex + 1}
                        </button>
                      );
                    })}
                  </div>
                </>
              ) : (
                <EmptyState
                  icon="alert"
                  title={t('dm.noResource')}
                  description={t('dm.noResourceDesc')}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
