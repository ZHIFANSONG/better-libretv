'use client';

import { useEffect, useRef, useState } from 'react';
import { buildImageCandidates } from '@/lib/utils';

interface SmartImageProps {
  /** 原始图片地址（未经代理加工，降级链由本组件按加载方式生成） */
  url?: string;
  mode: 'direct' | 'proxy' | 'custom';
  customProxy?: string;
  alt: string;
  className?: string;
  loading?: 'lazy' | 'eager';
  /** 候选链耗尽后回调，调用方切换占位图等兜底 UI */
  onExhausted?: () => void;
}

/**
 * 带降级链的封面图组件：direct 模式按 buildImageCandidates 的顺序加载，
 * onError 逐级回退（豆瓣图：直连 → 公共镜像 → 内置代理）；
 * 全部失败后触发 onExhausted 并停止渲染，由调用方展示占位图。
 * referrerPolicy=no-referrer：不向图床暴露来源页，规避部分站点的 Referer 校验。
 *
 * 加载动画：图片挂上 .g-img（opacity 0），load 之后再加 .g-img-in 淡入（cover 同时从 scale 1.03 归位），
 * 别让几十张封面在网络回来时整块"啪"地出现。候选链降级时重新等下一张；全部失败保持不可见，
 * 由调用方的占位图接管。
 */
export function SmartImage({
  url,
  mode,
  customProxy = '',
  alt,
  className,
  loading = 'lazy',
  onExhausted,
}: SmartImageProps) {
  const candidates = buildImageCandidates(url, mode, customProxy);
  const [idx, setIdx] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  // 地址或加载方式变化时重置降级进度
  useEffect(() => {
    setIdx(0);
    setLoaded(false);
  }, [url, mode, customProxy]);
  // 命中缓存的图可能在 React 挂上 onLoad 之前就已经 complete，这里补一次
  useEffect(() => {
    if (imgRef.current?.complete) setLoaded(true);
  }, [idx, url, mode, customProxy]);
  useEffect(() => {
    if (idx >= candidates.length) onExhausted?.();
    // 候选数组随 url/mode 变化，length 是充分的稳定信号
  }, [idx, candidates.length, onExhausted]);

  const src = candidates[idx];
  if (!src) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={imgRef}
      src={src}
      alt={alt}
      className={`g-img${loaded ? ' g-img-in' : ''}${className ? ` ${className}` : ''}`}
      loading={loading}
      referrerPolicy="no-referrer"
      onLoad={() => setLoaded(true)}
      onError={() => {
        setLoaded(false);
        setIdx((i) => i + 1);
      }}
    />
  );
}
