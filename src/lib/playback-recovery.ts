/**
 * HLS 播放错误恢复策略。
 *
 * 解决的问题：player-shell 原实现遇致命错误就无条件 `hls.startLoad()`，
 * errorCount 只增不减：源站挂掉时会形成无限重试风暴，而且永远不会换源；
 * 播放开始（playbackStarted）之后的致命错误甚至完全没有任何处理。
 *
 * 本模块**只做决策，不碰 hls 实例**。调用方拿到 {@link RecoveryDecision}
 * 后自行执行（含延时），这样策略可以独立单测，也便于在 UI 上给出提示。
 *
 * 计数语义：「连续失败次数」——收到 FRAG_LOADED（无论来自网络还是本地片段
 * 缓存）即视为播放链路已恢复，计数归零。动作后设 3s 静默窗，窗内的成功
 * 不清零（防重试成功瞬间的噪声），因此偶发抖动不会被误判为「源已死」，
 * 而源站彻底挂掉时计数会持续累积并最终触发换源。
 */

import { tr } from './i18n';

/** hls.js 的 ErrorTypes 常量值，这里用字面量避免静态引入 hls.js */
export const HLS_ERROR_NETWORK = 'networkError';
export const HLS_ERROR_MEDIA = 'mediaError';

/**
 * 这些致命错误重试没有意义（格式/编码层面的硬失败），直接换源。
 * manifestLoadError / manifestLoadTimeOut **不在其中**——网络抖动值得退避重试。
 */
const HARD_FAIL_DETAILS = new Set([
  'manifestParsingError',
  'manifestIncompatibleCodecsError',
  'levelEmptyError',
]);

export interface RecoveryPolicy {
  /** 连续网络错误的最大退避重试次数，超出后换源 */
  maxNetworkRetries: number;
  /** mediaError 的最大恢复次数，超出后换源 */
  maxMediaRecoveries: number;
  /** 退避基值（毫秒），按 2^(n-1) 指数递增 */
  baseDelayMs: number;
  /** 退避上限（毫秒） */
  maxDelayMs: number;
}

export const DEFAULT_RECOVERY_POLICY: RecoveryPolicy = {
  maxNetworkRetries: 3,
  maxMediaRecoveries: 2,
  baseDelayMs: 800,
  maxDelayMs: 8000,
};

export type RecoveryDecision =
  | { action: 'retry'; delayMs: number; attempt: number; reason: string }
  | { action: 'recover-media'; swapAudio: boolean; attempt: number; reason: string }
  | { action: 'switch-source'; reason: string }
  | { action: 'ignore'; reason: string };

/**
 * 决策原因与错误描述都要给用户看，所以允许注入翻译。
 *
 * 本模块同样是纯逻辑（被 vitest 直接 import），默认走中文字典，
 * 播放器传 useT() 的 t 进来就整体跟着界面语言走。
 */
export type RecoveryTranslator = (key: string, vars?: Record<string, string | number>) => string;

const zhT: RecoveryTranslator = (key, vars) => tr('zh', key, vars);

/** 动作后 3s 内的 FRAG_LOADED 视为重试噪声，不用于清零计数 */
const HEALTHY_QUIET_MS = 3000;

export class PlaybackRecovery {
  private policy: RecoveryPolicy;
  private networkRetries = 0;
  private mediaRecoveries = 0;
  private lastActionAt = 0;
  private disposed = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();

  private t: RecoveryTranslator;

  constructor(policy: Partial<RecoveryPolicy> = {}, t?: RecoveryTranslator) {
    this.policy = { ...DEFAULT_RECOVERY_POLICY, ...policy };
    this.t = t ?? zhT;
  }

  /** 播放链路恢复（FRAG_LOADED / MANIFEST_PARSED）：静默窗外的成功清零计数 */
  markHealthy(): void {
    if (this.disposed) return;
    if (this.lastActionAt && Date.now() - this.lastActionAt < HEALTHY_QUIET_MS) return;
    this.networkRetries = 0;
    this.mediaRecoveries = 0;
  }

  /** 致命错误 → 恢复决策 */
  onFatal(type: string, details: string): RecoveryDecision {
    if (this.disposed) return { action: 'ignore', reason: this.t('recovery.disposed') };
    this.lastActionAt = Date.now();

    if (HARD_FAIL_DETAILS.has(details)) {
      return { action: 'switch-source', reason: this.t('recovery.hardFail') };
    }

    if (type === HLS_ERROR_MEDIA) {
      this.mediaRecoveries += 1;
      if (this.mediaRecoveries > this.policy.maxMediaRecoveries) {
        return { action: 'switch-source', reason: this.t('recovery.mediaDead') };
      }
      return {
        action: 'recover-media',
        // 第 1 次仅 recoverMediaError；第 2 次追加 swapAudioCodec（hls.js 官方推荐链）
        swapAudio: this.mediaRecoveries >= 2,
        attempt: this.mediaRecoveries,
        reason: this.t('recovery.mediaRetry'),
      };
    }

    if (type === HLS_ERROR_NETWORK) {
      this.networkRetries += 1;
      if (this.networkRetries > this.policy.maxNetworkRetries) {
        return {
          action: 'switch-source',
          reason: this.t('recovery.networkDead', { n: this.policy.maxNetworkRetries }),
        };
      }
      return {
        action: 'retry',
        attempt: this.networkRetries,
        delayMs: Math.min(
          this.policy.baseDelayMs * 2 ** (this.networkRetries - 1),
          this.policy.maxDelayMs
        ),
        reason: this.t('recovery.networkRetry'),
      };
    }

    return { action: 'switch-source', reason: this.t('recovery.unknownType', { type }) };
  }

  /** 决策为 retry 时由调用方调用：统一管理定时器，dispose 时全部取消 */
  schedule(delayMs: number, task: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.disposed) task();
    }, delayMs);
    this.timers.add(timer);
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}

/** hls 错误 → 提示文案（用于 hint 浮层 / toast）；t 省略时输出中文 */
export function describeHlsError(type: string, details: string, t?: RecoveryTranslator): string {
  const tt = t ?? zhT;
  if (HARD_FAIL_DETAILS.has(details)) return tt('recovery.desc.hardFail');
  switch (details) {
    case 'manifestLoadError':
    case 'manifestLoadTimeOut':
      return tt('recovery.desc.manifestLoad');
    case 'manifestParsingError':
      return tt('recovery.desc.manifestParse');
    case 'fragLoadError':
    case 'fragLoadTimeOut':
      return tt('recovery.desc.fragLoad');
    case 'keyLoadError':
      return tt('recovery.desc.keyLoad');
    case 'bufferStalledError':
      return tt('recovery.desc.stalled');
    default:
      return type === HLS_ERROR_MEDIA
        ? tt('recovery.desc.media')
        : tt('recovery.desc.generic', { details: details || type });
  }
}
