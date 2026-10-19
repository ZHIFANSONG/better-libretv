import type HlsType from 'hls.js';
import { stripAdGroups } from './m3u8';
import { peekSegmentTiming, recordSegmentTiming } from './segment-timing';
import { buildSegmentCacheKey, readCachedSegment, touchMeta } from './video-cache';

/**
 * hls.js loader 工厂：在同一个 loader 里组合「广告过滤」与「片段缓存命中」。
 *
 * - manifest / level：走基类网络加载；blockAd 开启时在 onSuccess 里剔除
 *   片头插入的广告段（整段移除，保留 DISCONTINUITY 时间轴标记）；
 * - fragment：cache-first——本地缓存命中直接合成响应（不回源），未命中走基类。
 *   BYTERANGE 分片（原文件切片）不缓存、直接回源。
 *
 * 关键细节：缓存命中时用预取阶段记录的**真实耗时**（costMs）合成 hls.js 的
 * loader stats——如果让加载时长为 0，ABR 会把它当成无限带宽，错误地拉高码率。
 *
 * 另一个职责：把每片的加载时刻抄进 segment-timing。hls.js 在 onSuccess 之后
 * 立刻 destroy loader，stats 被置空，等 FRAG_LOADED 事件到来时已经读不到时刻了
 * （「视频信息」面板的实时下载就靠这份时刻算）。
 *
 * hls.js 对每次请求都会 new 一个 loader 实例，因此实例上的 destroyed 标记
 * 生命周期安全（abort/destroy 后不再回调，防孤儿 onSuccess）。
 */
interface LoaderOptions {
  blockAd?: boolean;
  /** 缓存命中探针（设置面板展示命中率用），可缺省 */
  onProbe?: (hit: boolean) => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HlsLoaderCtor = new (config: any) => any;

export function createHlsLoader(
  HlsCtor: typeof HlsType,
  options: LoaderOptions = {}
): HlsLoaderCtor {
  const { blockAd = false, onProbe } = options;

  return class CacheFirstHlsLoader extends (HlsCtor.DefaultConfig.loader as HlsLoaderCtor) {
    private destroyed = false;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(config: any) {
      super(config);
      const load = this.load.bind(this);
      /**
       * 在响应转交 hls.js 之前抄一份下载时刻。
       * 顺序很重要：hls.js 的 onSuccess 第一个动作就是 resetLoader() → loader.destroy()，
       * 而 BaseLoader.destroy() 会把 stats 置成 null，之后再读就全空了。
       */
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tapStats = (context: any, callbacks: any) => {
        const onSuccess = callbacks.onSuccess;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        callbacks.onSuccess = (response: any, stats: any, ctx: any, networkDetails: any) => {
          if (!this.destroyed && stats?.loading) {
            recordSegmentTiming(context.url, {
              loaded: Number(stats.loaded) || 0,
              start: Number(stats.loading.start) || 0,
              first: Number(stats.loading.first) || 0,
              end: Number(stats.loading.end) || 0,
              cached: false,
            });
          }
          if (!this.destroyed) onSuccess(response, stats, ctx, networkDetails);
        };
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.load = (context: any, config: any, callbacks: any) => {
        const isPlaylist = context.type === 'manifest' || context.type === 'level';

        // —— 播放列表：网络加载 + 可选广告过滤 ——
        if (isPlaylist) {
           
          if (blockAd) {
             
            const onSuccess = callbacks.onSuccess;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            callbacks.onSuccess = function (response: any, stats: any, ctx: any, networkDetails: any) {
              if (response.data && typeof response.data === 'string') {
                response.data = stripAdGroups(response.data);
              }
              onSuccess(response, stats, ctx, networkDetails);
            };
          }
          load(context, config, callbacks);
          return;
        }

        // —— BYTERANGE 分片：整文件切片，无法独立缓存，直接回源（时刻照记，面板要用） ——
        if (context.rangeStart || context.rangeEnd) {
          tapStats(context, callbacks);
          load(context, config, callbacks);
          return;
        }

        // —— 片段：cache-first ——
        const key = buildSegmentCacheKey(context.url);
        readCachedSegment(key).then((hit) => {
          if (this.destroyed) return;
          if (hit) {
            void touchMeta(key);
            onProbe?.(true);
            const now = performance.now();
            /*
             * 缓存命中不是真实网络往返，但 hls.js 只认 stats 里的时刻差。
             * 关键是把 loading.first 压到贴近 start（而不是现在的 +1ms）：
             * 视频信息面板用 end-first 算「实时下载」、first-start 算「首字节延迟」，
             * first 若只晚 start 1ms，面板就会报「首字节 1ms / 几十 Mbps」这种假数。
             * 这里把预取阶段实测的下载耗时完整放在 first→end 上，首字节记 0，
             * 于是面板显示的是「当初抓这个分片真实花了多久」，而不是凭空捏造的速度。
             */
            Object.assign(this.stats, {
              loading: { start: now - hit.costMs, first: now - hit.costMs, end: now },
              total: hit.data.byteLength,
              loaded: hit.data.byteLength,
            });
            /*
             * 预取那次也是真的走网络了（预取器自己 fetch 的），它的耗时就是这条流的真实速度。
             * 但预取器拿不到 hls 的 stats，只能在「播放时命中缓存」这一刻补记；
             * 若这条 URL 已经有过真实网络样本（比如第二次拖动重载），保留那次，不覆盖。
             */
            const existing = peekSegmentTiming(context.url);
            if (!existing || existing.cached) {
              recordSegmentTiming(context.url, {
                loaded: hit.data.byteLength,
                start: now - hit.costMs,
                first: now - hit.costMs,
                end: now,
                cached: true,
              });
            }
            callbacks.onSuccess({ url: context.url, data: hit.data }, this.stats, context, undefined);
            return;
          }
          onProbe?.(false);
           
          tapStats(context, callbacks);
          load(context, config, callbacks);
        });
      };
    }

    abort(): void {
      this.destroyed = true;
      super.abort();
    }

    destroy(): void {
      this.destroyed = true;
      super.destroy?.();
    }
  };
}
