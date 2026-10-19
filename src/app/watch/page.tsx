'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
// 播放器（artplayer + hls.js）按需加载：拆出独立 chunk，不占首屏 First Load JS
const PlayerShell = dynamic(() => import('@/components/player-shell').then((m) => m.PlayerShell), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center">
      <Spinner size="lg" />
    </div>
  ),
});
import { EmptyState, LoadingState, Spinner } from '@/components/states';
import { SwitchSourceModal } from '@/components/switch-source';
import type { SourceCandidate } from '@/lib/source-switch';
import { SourceSwitchCard } from '@/components/source-switch-card';
import { SkipConfigButton } from '@/components/skip-config';
import { enqueueDownload } from '@/components/download-manager';
import { plainText } from '@/components/detail-modal';
import { Icon } from '@/components/icon';
import { Header } from '@/components/header';
import { SiteFooter } from '@/components/site-footer';
import { useAuth } from '@/components/auth';
import { resolveSource, useAppStore } from '@/lib/store';
import { qualityKey } from '@/lib/quality';
import {
  clearProgress,
  progressKeyOf,
  saveProgress,
  updateHistoryProgress,
  upsertHistory,
  getSkipConfig,
  saveSkipConfig,
  clearSkipConfig,
  db,
} from '@/lib/db';
import { cn } from '@/lib/utils';

/**
 * 播放页（唯一入口，替代旧版 watch.html → player.html 跳转链）。
 * 状态全部由 URL 驱动：/watch?source=xx&id=..&index=..&title=..
 * 集数列表由服务端详情接口获取；进度与历史走 IndexedDB。
 */
export default function WatchPage() {
  return (
    <Suspense>
      <WatchContent />
    </Suspense>
  );
}

function WatchContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const store = useAppStore();
  const { verified } = useAuth();

  const sourceKey = searchParams.get('source') || '';
  const vodId = searchParams.get('id') || '';
  const directUrl = searchParams.get('url') || '';
  const titleParam = searchParams.get('title') || '';
  const indexParam = parseInt(searchParams.get('index') || '0', 10) || 0;

  // —— 跳过片头/片尾 ——
  // 本剧的覆盖值（IndexedDB，按 sourceKey+vodId 绑定整部剧）；null = 没配过，用全局默认。
  // 存在本地是刻意的：不同采集站的同一部剧片头长度不同，跟着「源+剧」走才不会串。
  const [skipOverride, setSkipOverride] = useState<{ introSec: number; outroSec: number } | null>(null);

  const [reversed, setReversed] = useState(false);
  // 简介是否展开（默认收起，限高 3~4 行）
  const [descOpen, setDescOpen] = useState(false);
  // 换源弹窗：null = 关闭；数组 = 打开，并带上换源卡已经测到的候选（省掉一轮重复搜索）
  const [switchOpen, setSwitchOpen] = useState<SourceCandidate[] | null>(null);
  // 播放中致命错误的次数：每次 +1 触发侧栏换源卡自动测速
  const [failedSignal, setFailedSignal] = useState(0);

  const source = resolveSource(store, sourceKey, {
    url: searchParams.get('sourceUrl') || undefined,
    detail: searchParams.get('detail') || undefined,
  });

  // 详情查询：无 id（纯直连链接分享）时跳过
  const detailQuery = useQuery({
    queryKey: ['detail', sourceKey, vodId, source?.url],
    queryFn: ({ signal }) => api.detail(vodId, source!, signal),
    enabled: Boolean(source && vodId && verified),
    staleTime: 5 * 60_000,
  });

  const videoInfo = detailQuery.data?.videoInfo;
  const episodes = useMemo(() => detailQuery.data?.episodes ?? [], [detailQuery.data]);
  // 简介是第三方源的 HTML 片段，转纯文本再判断长度（<p> 标签本身也算字符，不转会误判）
  const descText = useMemo(() => (videoInfo?.desc ? plainText(videoInfo.desc) : ''), [videoInfo?.desc]);
  const videoTitle = titleParam || videoInfo?.title || '未知视频';

  // 当前播放地址：优先取剧集列表中的当前集，其次直连 URL 参数
  const currentUrl = useMemo(() => {
    if (episodes.length > 0) {
      const idx = Math.min(Math.max(indexParam, 0), episodes.length - 1);
      return episodes[idx] || directUrl;
    }
    return directUrl;
  }, [episodes, indexParam, directUrl]);

  const currentIndex = useMemo(() => {
    if (episodes.length > 0) return Math.min(Math.max(indexParam, 0), episodes.length - 1);
    return indexParam;
  }, [episodes, indexParam]);

  // 实际生效的秒数：本剧覆盖 > 全局默认。
  // 首集不跳片头——不少采集站第一集是预告/花絮，固定秒数对它不成立。
  const introSec = currentIndex > 0 ? (skipOverride?.introSec ?? store.skipIntroSec) : 0;
  const outroSec = skipOverride?.outroSec ?? store.skipOutroSec;

  // 读完本剧配置后再把值覆盖上去（首次进页面只有全局默认可用，跳转稍晚也不会漏）
  useEffect(() => {
    let cancelled = false;
    if (!sourceKey || !vodId) {
      setSkipOverride(null);
      return;
    }
    getSkipConfig(sourceKey, vodId)
      .then((entry) => {
        if (!cancelled) {
          setSkipOverride(entry ? { introSec: entry.introSec, outroSec: entry.outroSec } : null);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sourceKey, vodId]);

  const goEpisode = useCallback(
    (index: number) => {
      const sp = new URLSearchParams(searchParams.toString());
      sp.set('index', String(index));
      sp.set('url', episodes[index] || directUrl);
      sp.delete('position');
      router.replace(`/watch?${sp.toString()}`, { scroll: false });
    },
    [router, searchParams, episodes, directUrl]
  );

  // 进度恢复优先级：URL position 参数 > IndexedDB 记录
  const getRestorePosition = useCallback(async () => {
    const urlPos = parseInt(searchParams.get('position') || '0', 10) || 0;
    if (urlPos > 0) return urlPos;
    if (!vodId) return 0;
    const entry = await db.progress.get(progressKeyOf(sourceKey, vodId, currentIndex));
    return entry?.position ?? 0;
  }, [searchParams, sourceKey, vodId, currentIndex]);

  // 写入观看历史（进入页面即记录，进度后续增量更新）
  useEffect(() => {
    if (!verified || !sourceKey || !currentUrl) return;
    const timer = setTimeout(() => {
      upsertHistory({
        sourceKey,
        sourceUrl: source?.url,
        vodId: vodId || currentUrl,
        title: videoTitle,
        pic: detailQuery.data?.videoInfo?.cover,
        episodeIndex: currentIndex,
        totalEpisodes: episodes.length,
        playbackPosition: 0,
        duration: 0,
        timestamp: Date.now(),
      }).catch(() => {});
    }, 2000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verified, sourceKey, vodId, currentIndex, videoTitle, currentUrl]);

  // 播放中与暂停时的进度落盘逻辑一致，共用同一回调
  const handleProgress = useCallback(
    (position: number, duration: number) => {
      if (vodId) {
        saveProgress(sourceKey, vodId, currentIndex, position, duration).catch(() => {});
        updateHistoryProgress(sourceKey, vodId || currentUrl, position, duration).catch(() => {});
      }
    },
    [sourceKey, vodId, currentIndex, currentUrl]
  );

  // 跳过片头/片尾：写本剧配置（只落本地 IndexedDB），并立即生效
  const handleApplySkip = useCallback(
    (nextIntro: number, nextOutro: number) => {
      setSkipOverride({ introSec: nextIntro, outroSec: nextOutro });
      if (sourceKey && vodId) {
        saveSkipConfig(sourceKey, vodId, nextIntro, nextOutro).catch(() => {});
      }
    },
    [sourceKey, vodId]
  );

  const handleResetSkip = useCallback(() => {
    setSkipOverride(null);
    if (sourceKey && vodId) clearSkipConfig(sourceKey, vodId).catch(() => {});
  }, [sourceKey, vodId]);

  // 播放器里点了「撤销」：把本剧片头关掉，下次进来自动跳不会再发生
  const handleUndoIntro = useCallback(() => {
    const nextOutro = skipOverride?.outroSec ?? store.skipOutroSec;
    setSkipOverride({ introSec: 0, outroSec: nextOutro });
    if (sourceKey && vodId) saveSkipConfig(sourceKey, vodId, 0, nextOutro).catch(() => {});
  }, [sourceKey, vodId, skipOverride, store.skipOutroSec]);

  // 自动连播的 800ms 延迟切集要在卸载时取消，避免离开页面后跳转
  const autoNextTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (autoNextTimer.current) clearTimeout(autoNextTimer.current);
  }, []);

  const handleEnded = useCallback(() => {
    if (vodId) clearProgress(sourceKey, vodId, currentIndex).catch(() => {});
    if (store.autoplayNext && currentIndex < episodes.length - 1) {
      autoNextTimer.current = setTimeout(() => goEpisode(currentIndex + 1), 800);
    }
  }, [store.autoplayNext, currentIndex, episodes.length, goEpisode, sourceKey, vodId]);

  // Alt+←/→ 集数切换快捷键
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      if (e.key === 'ArrowLeft' && currentIndex > 0) {
        e.preventDefault();
        goEpisode(currentIndex - 1);
      } else if (e.key === 'ArrowRight' && currentIndex < episodes.length - 1) {
        e.preventDefault();
        goEpisode(currentIndex + 1);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [currentIndex, episodes.length, goEpisode]);

  const orderedEpisodes = reversed ? [...episodes].map((_, i) => episodes.length - 1 - i) : episodes.map((_, i) => i);
  const hasNext = episodes.length > 0 && currentIndex < episodes.length - 1;

  // 下载本集：多集才带集数后缀；单集影片（含电影）文件名就是纯标题
  const handleDownload = useCallback(() => {
    if (!currentUrl) return;
    enqueueDownload({
      url: currentUrl,
      title: `${videoTitle}${episodes.length > 1 ? ` 第${currentIndex + 1}集` : ''}`,
      format: 'MP4',
    });
    // 「已加入下载队列」由 DownloadManager 在真正入队后提示：
    // 这里先提示的话，用户随后取消保存位置会出现「已加入→已取消」的矛盾
  }, [currentUrl, videoTitle, episodes.length, currentIndex]);

  if (!verified) {
    return (
      <div className="g-shell min-h-screen flex flex-col">
        <Header />
        <main className="g-page flex-1 flex items-center justify-center">
          <p className="text-faint text-sm">等待访问验证...</p>
        </main>
      </div>
    );
  }

  if (!source) {
    return (
      <div className="g-shell min-h-screen flex flex-col">
        <Header />
        <main className="g-page flex-1 flex items-center justify-center">
          <div className="text-center max-w-md">
            <h1 className="text-content font-medium mb-2">点播源不存在</h1>
            <p className="text-sm text-muted mb-4">
              该视频来自点播源「{sourceKey}」，但它可能已被删除。请在设置中重新添加后重试。
            </p>
            <Link href="/" className="g-act pri">返回首页</Link>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="g-shell min-h-screen flex flex-col">
      <Header />

      <main className="g-page g-watch flex-1">
        {/*
          版式参考爱奇艺网页版：左列 = 播放器 + 标题 + 信息 + 动作（播放器上是片名），
          右列 = 换源 + 选集，页头之下直接是内容，不再有独立的「返回 + 源名」次级条。
        */}
        <div className="g-layout">
          <div>
            {/* 舞台：16:9 圆角，与提案稿一致 */}
            <div className="g-stage">
              {currentUrl ? (
                <PlayerShell
                  url={currentUrl}
                  title={videoTitle}
                  adFilter={store.adFilter}
                  autoplayNext={store.autoplayNext}
                  episodeKey={`${sourceKey}:${vodId}:${currentIndex}`}
                  nextUrl={hasNext ? episodes[currentIndex + 1] : undefined}
                  nextEpisodeKey={hasNext ? `${sourceKey}:${vodId}:${currentIndex + 1}` : undefined}
                  getRestorePosition={getRestorePosition}
                  onTimeUpdate={handleProgress}
                  onPause={handleProgress}
                  onEnded={handleEnded}
                  onQuality={(height, width) => {
                    // 播放实测比探测结论更权威：回写后搜索卡片、换源卡、详情弹窗同时更新。
                    // width 一起存：宽银幕 4K（3840×1608）必须靠宽度才判得出 4K
                    if (!sourceKey || !vodId) return;
                    useAppStore.getState().setQuality({
                      [qualityKey(sourceKey, vodId)]: { height, width, from: 'play', timestamp: Date.now() },
                    });
                  }}
                  introSec={introSec}
                  outroSec={outroSec}
                  onUndoIntro={handleUndoIntro}
                  onRequestSwitchSource={() => setFailedSignal((n) => n + 1)}
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  {detailQuery.isLoading ? (
                    <Spinner size="lg" />
                  ) : (
                    <p className="text-faint text-sm">
                      {detailQuery.isError ? '视频加载失败，请尝试其他资源' : '无可用播放地址'}
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* 播放器下方标题行（爱奇艺式）：片名 + 当前集数，后面跟着信息卡 */}
            <h1 className="g-watch-title">
              {videoTitle}
              {episodes.length > 0 && (
                <s>
                  第 {currentIndex + 1}/{episodes.length} 集
                </s>
              )}
            </h1>

            {/* 信息卡：标签 + 元信息 + 简介 + 动作 */}
            <div className="g-info g-panel" glass="frosted" glass-blur="14">
              <div className="g-tags">
                {videoInfo?.remarks && <s>{videoInfo.remarks}</s>}
                {videoInfo?.year && <s>{videoInfo.year}</s>}
              </div>
              <div className="g-sub">
                {/* 源名链回搜索结果：想换别的源，点它就能比一比 */}
                <span>
                  <Link href={`/search?q=${encodeURIComponent(videoTitle)}`} title="用这个片名去搜索其它源">
                    {source.name}
                  </Link>
                </span>
                {videoInfo?.typeName && <span>{videoInfo.typeName}</span>}
                {videoInfo?.area && <span>{videoInfo.area}</span>}
                {videoInfo?.director && <span>导演 {videoInfo.director}</span>}
                {/* 集数不再在这里重复：上面 g-tags 有「全 N 集」，标题行有「第 x/N 集」，
                    右侧选集卡也写着 N 集 —— 第四遍没有任何新信息 */}
              </div>
              {/* 简介默认限高 3~4 行保住首屏；超长的给一个「展开」，不要让人对着半截文字猜结局 */}
              {descText && (
                <p className={cn('g-desc', descOpen && 'open')}>{descText}</p>
              )}
              {descText.length > 96 && (
                <button
                  type="button"
                  className="g-desc-toggle"
                  onClick={() => setDescOpen((v) => !v)}
                >
                  {descOpen ? '收起简介' : '展开简介'}
                </button>
              )}

              <div className="g-acts">
                <button
                  className="g-act"
                  disabled={currentIndex <= 0}
                  onClick={() => goEpisode(currentIndex - 1)}
                >
                  上一集
                </button>
                <button
                  className="g-act"
                  disabled={!hasNext}
                  onClick={() => goEpisode(currentIndex + 1)}
                >
                  下一集
                </button>
                {/* 下载并入集数操作行：它按集工作，跟上一集/下一集是同一类动作，
                    单独挂在顶部「次级条」里只会让那一条空出一大半宽度 */}
                <button className="g-act" onClick={handleDownload} disabled={!currentUrl}>
                  下载本集
                </button>
                <label className="g-act">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-[#2563eb]"
                    checked={store.autoplayNext}
                    onChange={(e) => store.updateSettings({ autoplayNext: e.target.checked })}
                  />
                  自动连播
                </label>
                {/* 跳过片头/片尾：值按「源+剧」存在本地，改一次本剧全部剧集生效 */}
                <SkipConfigButton
                  introSec={introSec}
                  outroSec={outroSec}
                  hasOverride={skipOverride !== null}
                  introDisabledHint={
                    currentIndex === 0 ? '当前是第 1 集，片头跳过对首集不生效（首集常是预告/花絮）。' : undefined
                  }
                  onApply={handleApplySkip}
                  onReset={handleResetSkip}
                />
              </div>
            </div>
          </div>

          {/* 侧栏：换源 / 选集（快捷键说明改由播放器 first-ready 提示给出，不再常驻一卡） */}
          {/* 320px+ 宽度下侧栏在右，窄屏时自动落到播放器下方（见 proposal.css） */}
          <aside className="g-side">
            <SourceSwitchCard
              title={videoTitle}
              currentSourceKey={sourceKey}
              currentVodId={vodId}
              currentIndex={currentIndex}
              failedSignal={failedSignal}
              sourceUrl={source.url}
              onMore={(candidates) => setSwitchOpen(candidates)}
            />

            <div className="g-card g-panel" glass="frosted" glass-blur="16">
              <h4>
                选集
                {episodes.length > 1 && (
                  <button
                    className="g-act"
                    onClick={() => setReversed((v) => !v)}
                    aria-label={reversed ? '切换为正序排列' : '切换为倒序排列'}
                    title="调整剧集列表的排列顺序"
                  >
                    <Icon
                      name="arrowDown"
                      className={cn('w-3.5 h-3.5 transition-transform', reversed && 'rotate-180')}
                    />
                    {reversed ? '正序' : '倒序'}
                  </button>
                )}
                <em>{episodes.length > 0 ? `${episodes.length} 集` : 'episodes'}</em>
              </h4>
              {episodes.length === 0 ? (
                detailQuery.isLoading ? (
                  <LoadingState />
                ) : (
                  <EmptyState variant="plain" title={detailQuery.isError ? '获取剧集失败' : '暂无剧集信息'} />
                )
              ) : (
                <div className="g-eps">
                  {orderedEpisodes.map((realIndex) => (
                    <EpisodeButton
                      key={realIndex}
                      index={realIndex}
                      active={realIndex === currentIndex}
                      onClick={() => goEpisode(realIndex)}
                    />
                  ))}
                </div>
              )}
            </div>

          </aside>
        </div>
      </main>

      <SiteFooter />

      {switchOpen && (
        <SwitchSourceModal
          currentTitle={videoTitle}
          currentSourceKey={sourceKey}
          currentVodId={vodId}
          currentIndex={currentIndex}
          initialCandidates={switchOpen}
          onClose={() => setSwitchOpen(null)}
        />
      )}
    </div>
  );
}

/** 集数按钮：激活时自动滚动进可视区（长剧列表） */
function EpisodeButton({ index, active, onClick }: { index: number; active: boolean; onClick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <button ref={ref} className={cn('g-ep', active && 'on')} onClick={onClick}>
      {index + 1}
    </button>
  );
}

