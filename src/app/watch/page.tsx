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
import { enqueueDownload } from '@/components/download-manager';
import { Icon } from '@/components/icon';
import { Header } from '@/components/header';
import { SiteFooter } from '@/components/site-footer';
import { useAuth } from '@/components/auth';
import { resolveSource, useAppStore } from '@/lib/store';
import {
  clearProgress,
  progressKeyOf,
  saveProgress,
  updateHistoryProgress,
  upsertHistory,
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

  const [reversed, setReversed] = useState(false);
  const [switchOpen, setSwitchOpen] = useState(false);

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

  // 侧栏采集源列表：已勾选的源名；当前源来自 URL（不在勾选列表）时补进首位
  const sourceNames = useMemo(() => {
    const names = store.selectedKeys
      .map((k) => resolveSource(store, k)?.name)
      .filter((n): n is string => Boolean(n));
    if (source && !names.includes(source.name)) names.unshift(source.name);
    return names;
  }, [store, source]);

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

      <main className="g-page flex-1">
        {/* 播放页次级条：返回 + 当前源，动作放右侧（提案稿的浮动胶囊形态） */}
        <div className="g-subbar lg g-glass" data-lg="depth=22 k=0.8">
          <BackButton />
          <span className="g-src-name">
            {source.name}
            {episodes.length > 0 && ` · 第 ${currentIndex + 1}/${episodes.length} 集`}
          </span>
          <span className="g-spacer" />
          <button className="g-act" onClick={handleDownload}>下载本集</button>
          <button className="g-act" onClick={() => setSwitchOpen(true)}>切换资源</button>
        </div>

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

            {/* 信息卡：标题标签 + 元信息 + 简介 + 动作 */}
            <div className="g-info lg lg-panel" data-lg="depth=26 k=0.85 blur=14">
              <h1>
                {videoTitle}
                {videoInfo?.remarks && <s>{videoInfo.remarks}</s>}
                {videoInfo?.year && <s>{videoInfo.year}</s>}
              </h1>
              <div className="g-sub">
                <span>{source.name}</span>
                {videoInfo?.typeName && <span>{videoInfo.typeName}</span>}
                {videoInfo?.area && <span>{videoInfo.area}</span>}
                {videoInfo?.director && <span>导演 {videoInfo.director}</span>}
                {episodes.length > 0 && <span>共 {episodes.length} 集</span>}
              </div>
              {videoInfo?.desc && <p className="g-desc">{videoInfo.desc}</p>}

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
                <label className="g-act">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-[#2563eb]"
                    checked={store.autoplayNext}
                    onChange={(e) => store.updateSettings({ autoplayNext: e.target.checked })}
                  />
                  自动连播
                </label>
                <button className="g-act" onClick={handleDownload}>下载本集</button>
              </div>
            </div>
          </div>

          {/* 侧栏：采集源 / 选集 / 快捷键 */}
          <aside className="g-side">
            <div className="g-card lg lg-panel" data-lg="depth=28 k=0.9 blur=16">
              <h4>
                采集源 <em>sources</em>
              </h4>
              {sourceNames.length > 0 ? (
                <div className="g-src">
                  {sourceNames.map((n) => (
                    <span key={n} className={cn(n === source.name && 'on')}>{n}</span>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-faint">当前源来自分享链接，未加入已启用列表</p>
              )}
              <button
                className="g-act"
                style={{ width: '100%', justifyContent: 'center' }}
                onClick={() => setSwitchOpen(true)}
              >
                搜索其它采集源
              </button>
            </div>

            <div className="g-card lg lg-panel" data-lg="depth=28 k=0.9 blur=16">
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

            <div className="g-card lg lg-panel" data-lg="depth=28 k=0.9 blur=16">
              <h4>
                快捷键 <em>keys</em>
              </h4>
              <div className="g-shortcut">
                <kbd>空格</kbd> 播放/暂停 · <kbd>←</kbd>
                <kbd>→</kbd> 快退/快进 5s
                <br />
                <kbd>↑</kbd>
                <kbd>↓</kbd> 音量 · <kbd>F</kbd> 全屏
                <br />
                <kbd>Alt</kbd>+<kbd>←</kbd>
                <kbd>→</kbd> 切换集数
              </div>
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
          onClose={() => setSwitchOpen(false)}
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

/** 返回上一页：无历史时回首页（外链直开场景） */
function BackButton() {
  const router = useRouter();
  return (
    <button
      className="g-act ic"
      onClick={() => {
        if (window.history.length > 1) router.back();
        else router.push('/');
      }}
      aria-label="返回"
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
      </svg>
    </button>
  );
}
