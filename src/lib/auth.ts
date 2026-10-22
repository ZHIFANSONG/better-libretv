import crypto from 'node:crypto';

/**
 * 会话鉴权：httpOnly cookie + HMAC 签名。
 *
 * 相比旧版的改进：
 * - 页面源码不再下发 sha256(password)，前端拿不到任何可重放的凭证；
 * - 兼容模式「哈希即凭证」被彻底移除；
 * - 登录接口只接受 POST body，不再把明文密码放 query。
 */

export const SESSION_COOKIE = 'ltv_session';
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 天

export function getPassword(): string {
  return process.env.PASSWORD || '';
}

export function isPasswordConfigured(): boolean {
  return getPassword().length > 0;
}

function getSecret(): string {
  if (process.env.PROXY_SECRET) return process.env.PROXY_SECRET;
  return crypto.createHash('sha256').update(getPassword() + ':libretv::session-salt').digest('hex');
}

function hmac(payload: string): string {
  return crypto.createHmac('sha256', getSecret()).update(payload).digest('hex');
}

/** 生成签名会话 token：`<expiresAtMs>.<hmac>` */
export function signSession(): { token: string; expiresAt: number } {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const payload = String(expiresAt);
  return { token: `${payload}.${hmac(payload)}`, expiresAt };
}

/** 校验会话 token 的签名与有效期 */
export function verifySession(token: string | undefined | null): boolean {
  if (!token) return false;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = hmac(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const expiresAt = parseInt(payload, 10);
  if (!Number.isFinite(expiresAt)) return false;
  return Date.now() < expiresAt;
}

/** 恒定时间比较密码（比较 sha256 摘要避免长度泄漏） */
export function checkPassword(input: string): boolean {
  const password = getPassword();
  if (!password) return false;
  const a = crypto.createHash('sha256').update(input).digest();
  const b = crypto.createHash('sha256').update(password).digest();
  return crypto.timingSafeEqual(a, b);
}

/** 从请求 Cookie 中解析会话 */
export function sessionFromCookieHeader(cookieHeader: string | null): boolean {
  if (!cookieHeader) return false;
  const cookies = cookieHeader.split(';');
  for (const c of cookies) {
    const eq = c.indexOf('=');
    if (eq === -1) continue;
    const name = c.slice(0, eq).trim();
    if (name === SESSION_COOKIE) {
      return verifySession(decodeURIComponent(c.slice(eq + 1).trim()));
    }
  }
  return false;
}

/**
 * 从请求头里取客户端 IP。
 *
 * 只信 `x-real-ip`，或 `x-forwarded-for` 的**最后一段** —— 两者都是
 * 「最靠近我们的那一跳代理写进去的值」。**绝不能取 XFF 的第一段**：那一截是客户端
 * 自己写的，攻击者填什么就是什么，等于每次请求都换一个「新 IP」，按 IP 的限流形同虚设
 * （这个洞曾经真实存在于 auth/route.ts，换着 XFF 连打 12 次错密码从不触发 429）。
 *
 * 部署侧还应让 nginx 覆写这两个头（`proxy_set_header X-Real-IP $remote_addr` /
 * `proxy_set_header X-Forwarded-For $remote_addr`）作为第一道保险；本函数是第二道。
 */
export function clientIpFromHeaders(headers: Headers): string {
  const real = headers.get('x-real-ip')?.trim();
  if (real) return real;
  const xff = headers.get('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',');
    const last = parts[parts.length - 1]?.trim();
    if (last) return last;
  }
  return 'unknown';
}

// —— 登录速率限制（内存实现，单实例部署足够；多实例可换 Redis） ——

const attemptMap = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 10 * 60 * 1000;

/**
 * 全局限流：即使攻击者把 XFF 换成无数个「新 IP」，也会撞到这里。
 * 单靠按 IP 的桶挡不住伪造头 —— 上限必须有一层与 IP 无关的兜底。
 * 个人站正常登录频率远低于此；被锁时可用环境变量 AUTH_GLOBAL_MAX_ATTEMPTS 临时放宽。
 */
const GLOBAL_MAX_ATTEMPTS_DEFAULT = 50;
let globalBucket = { count: 0, resetAt: 0 };

function globalMaxAttempts(): number {
  const raw = Number(process.env.AUTH_GLOBAL_MAX_ATTEMPTS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : GLOBAL_MAX_ATTEMPTS_DEFAULT;
}

/** 全局尝试计数：与来源 IP 无关，任何一次登录请求都会消耗一次 */
export function checkGlobalRateLimit(): boolean {
  const now = Date.now();
  if (now > globalBucket.resetAt) {
    globalBucket = { count: 1, resetAt: now + WINDOW_MS };
    return true;
  }
  if (globalBucket.count >= globalMaxAttempts()) return false;
  globalBucket.count += 1;
  return true;
}

/** 仅供测试与运维重置全局桶 */
export function clearGlobalRateLimit(): void {
  globalBucket = { count: 0, resetAt: 0 };
}

export function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = attemptMap.get(ip);
  if (!entry || now > entry.resetAt) {
    attemptMap.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (entry.count >= MAX_ATTEMPTS) return false;
  entry.count += 1;
  return true;
}

export function clearRateLimit(ip: string): void {
  attemptMap.delete(ip);
}

// 定期清理过期限流记录，避免长期运行下 Map 膨胀
if (typeof setInterval === 'function') {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of attemptMap) {
      if (now > entry.resetAt) attemptMap.delete(ip);
    }
  }, 60 * 1000);
  // 不阻止 Node 进程退出
  if (typeof timer.unref === 'function') timer.unref();
}
