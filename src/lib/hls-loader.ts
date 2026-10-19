import type HlsType from 'hls.js';
import { stripAdGroups } from './m3u8';
import { recordSegmentTiming } from './segment-timing';

/**
 * hls.js loader 工厂：广告过滤 + 分片计时。
 *
 * - manifest / level：走基类网络加载；blockAd 开启时在 onSuccess 里剔除
 *   片头插入的广告段（整段移除，保留 DISCONTINUITY 时间轴标记）；
 * - fragment：直接走基类网络加载，不经过任何本地存储。
 *
 * 这里曾经还兼着「片段本地缓存命中」：分片先查 Cache Storage，命中就直接合成响应。
 * 已整块移除 —— 预取器为了填缓存会在播放间隙并发抓分片，暂停与后台标签页也不停，
 * 大码率剧集上表现为手机发烫、播放卡顿。顺带 hls.js 的缓冲上限也回到了常规值
 * （见 player-shell.tsx 的 buildHlsConfig），不再为了配合预取把 buffer 抬到 600s/90MB。
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
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HlsLoaderCtor = new (config: any) => any;

export function createHlsLoader(
  HlsCtor: typeof HlsType,
  options: LoaderOptions = {}
): HlsLoaderCtor {
  const { blockAd = false } = options;

  return class InstrumentedHlsLoader extends (HlsCtor.DefaultConfig.loader as HlsLoaderCtor) {
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

        // —— 分片：纯网络加载，只顺手记时刻（面板要用） ——
        tapStats(context, callbacks);
        load(context, config, callbacks);
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
