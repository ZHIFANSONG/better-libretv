/**
 * 按 host 的全局限并发闸门。
 *
 * 为什么需要它：服务端聚合搜索会同时对 N 个源发请求、每个源还要并行抓最多 5 页；
 * 画质探测一次探多个条目；直播测活一次探 50 个 URL。这些请求往往打到**同一个 host**
 * （同一个采集站的多页、同一台 IPTV 服务器的几十个频道），服务端自己的并发上限
 * （每个路由各自的 CONCURRENCY）管不住「跨路由 × 跨请求」的叠加，弱源会被打挂，
 * 甚至封掉本服务出口 IP——现象是「越搜越红」「越测越多源失败」。
 *
 * 闸门是模块级的：跨请求共享，名额满时 FIFO 排队，host 空闲后立刻从 Map 里删除，
 * 避免长跑进程里 Map 无界增长。
 */

export interface HostGate {
  /** 取一个该 host 的在途名额，返回幂等的释放函数；名额满时排队等待 */
  acquire(url: string, signal?: AbortSignal): Promise<() => void>;
  /** 在闸门内执行 fn，无论成功失败都释放名额 */
  run<T>(url: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  /** 当前有在途名额的 host 数量（仅供测试/运维观察） */
  activeHosts(): number;
}

interface Waiter {
  grant: () => void;
}

interface Gate {
  active: number;
  waiters: Waiter[];
}

/** 从 URL 取 host 作为闸门键；脏 URL 退化为原始字符串（不同脏串互不影响，也不会互相串行） */
export function hostOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).host;
  } catch {
    return rawUrl;
  }
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException('已取消', 'AbortError');
}

/**
 * 创建一把闸门。
 * @param perHostConcurrency 同一 host 允许的最多同时在途请求数，必须 >= 1
 */
export function createHostGate(perHostConcurrency: number): HostGate {
  const limit = Number.isFinite(perHostConcurrency) && perHostConcurrency >= 1 ? Math.floor(perHostConcurrency) : 1;
  const gates = new Map<string, Gate>();

  function acquire(rawUrl: string, signal?: AbortSignal): Promise<() => void> {
    const host = hostOf(rawUrl);
    // 已经取消的调用方不该占用名额，也不该进入队列（否则排队到下一位还要立刻弹出去）
    if (signal?.aborted) return Promise.reject(abortReason(signal));

    let gate = gates.get(host);
    if (!gate) {
      gate = { active: 0, waiters: [] };
      gates.set(host, gate);
    }
    const g = gate;

    return new Promise<() => void>((resolve, reject) => {
      /** 真正接管名额：active++ 与 resolve 同步发生，不留被新请求插队的窗口 */
      const take = () => {
        g.active++;
        let released = false;
        resolve(() => {
          // 幂等：调用方在 finally 里释放，异常路径也可能重复调用
          if (released) return;
          released = true;
          g.active--;
          // 唤醒的等待者同步接管名额（active-- 后立刻 ++）
          const next = g.waiters.shift();
          if (next) next.grant();
          else if (g.active === 0) gates.delete(host);
        });
      };

      if (g.active < limit) {
        take();
        return;
      }

      const detach = () => {
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        const i = g.waiters.findIndex((w) => w.grant === grant);
        if (i >= 0) g.waiters.splice(i, 1);
        if (g.active === 0 && g.waiters.length === 0) gates.delete(host);
        reject(abortReason(signal as AbortSignal));
      };
      const grant = () => {
        detach();
        take();
      };

      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      g.waiters.push({ grant });
    });
  }

  async function run<T>(url: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await acquire(url, signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  return {
    acquire,
    run,
    activeHosts: () => gates.size,
  };
}
