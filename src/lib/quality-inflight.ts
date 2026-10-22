/**
 * 画质探测的「同 key 合并」表。
 *
 * 单独放在 lib 里而不是 route.ts 内：Next 的 route 文件只允许导出 HTTP 方法
 * 和 runtime/dynamic 等白名单字段，多导出一个函数会让 tsc 报
 * 「Property 'x' is incompatible with index signature」。
 *
 * 必须在探测结束（成功/失败/中断）后移除条目：这是模块级 Map，
 * 每个 key 都是「源地址 + detail + 影片」的长字符串，只 set 不 delete
 * 会随条目数无限增长。
 */

export interface CachedProbe {
  height?: number;
  /** 宽度与高度一起缓存：宽银幕 4K（3840×1608）只靠高度会被标成 2K */
  width?: number;
  error?: string;
}

const inflight = new Map<string, Promise<CachedProbe>>();

/** 取走同 key 的在途探测；没有则返回 undefined */
export function getInflight(key: string): Promise<CachedProbe> | undefined {
  return inflight.get(key);
}

/** 登记一个在途探测，并在它 settle（含中断）后自动移除 */
export function setInflight(key: string, pending: Promise<CachedProbe>): void {
  inflight.set(key, pending);
  void pending.finally(() => {
    // 只有当表里还是这一条时才删：否则可能误删后来者登记的新条目
    if (inflight.get(key) === pending) inflight.delete(key);
  });
}

/** 仅供测试：当前在途条目数 */
export function inflightSize(): number {
  return inflight.size;
}

/** 仅供测试：清空 */
export function clearInflight(): void {
  inflight.clear();
}
