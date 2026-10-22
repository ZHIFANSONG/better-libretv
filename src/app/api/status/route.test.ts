import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET } from './route';
import { SESSION_COOKIE, signSession } from '@/lib/auth';

/**
 * /api/status 脱敏单测：预置采集站、直播源、订阅、推荐源、图片模式
 * 都是部署者配置，未登录时不得下发；登录后才补齐。
 */

interface StatusPayload {
  passwordRequired?: boolean;
  verified?: boolean;
  version?: string;
  defaultSources?: { name: string; url: string }[];
  defaultLiveSources?: unknown[];
  defaultSubscriptions?: unknown[];
  defaultRecommendSource?: string | null;
  defaultImageMode?: string | null;
}

async function readJson(res: Response): Promise<StatusPayload> {
  return (await res.json()) as StatusPayload;
}

function anonymousRequest(): Request {
  return new Request('https://local.test/api/status');
}

function authedRequest(): Request {
  const { token } = signSession();
  return new Request('https://local.test/api/status', {
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  });
}

beforeEach(() => {
  delete process.env.DEFAULT_SOURCES;
  delete process.env.DEFAULT_LIVE_SOURCES;
  delete process.env.DEFAULT_SUBSCRIPTIONS;
  delete process.env.DEFAULT_RECOMMEND_SOURCE;
  delete process.env.DEFAULT_IMAGE_MODE;
});

describe('配了密码的实例', () => {
  beforeAll(() => {
    process.env.PASSWORD = 'test-password';
  });

  beforeEach(() => {
    process.env.DEFAULT_SOURCES = JSON.stringify([{ name: '测试源', url: 'https://up.example.com/api.php/provide/vod' }]);
    // DEFAULT_SUBSCRIPTIONS 是 JSON 数组（元素可为 URL 字符串或 {url,name}），不是裸 URL
    process.env.DEFAULT_SUBSCRIPTIONS = JSON.stringify(['https://up.example.com/sources.json']);
    process.env.DEFAULT_RECOMMEND_SOURCE = 'bangumi';
  });

  it('未登录：只回公开字段，预置源一个都不带', async () => {
    const body = await readJson(await GET(anonymousRequest()));
    expect(body.passwordRequired).toBe(true);
    expect(body.verified).toBe(false);
    expect(body.version).toBeTruthy();
    // 关键断言：上游清单不能泄漏给游客
    expect(body.defaultSources).toBeUndefined();
    expect(body.defaultLiveSources).toBeUndefined();
    expect(body.defaultSubscriptions).toBeUndefined();
    expect(body.defaultRecommendSource).toBeUndefined();
    expect(body.defaultImageMode).toBeUndefined();
  });

  it('伪造/过期的 cookie 也算未登录', async () => {
    const req = new Request('https://local.test/api/status', {
      headers: { cookie: `${SESSION_COOKIE}=forged-token` },
    });
    const body = await readJson(await GET(req));
    expect(body.verified).toBe(false);
    expect(body.defaultSources).toBeUndefined();
  });

  it('已登录：预置源完整下发', async () => {
    const body = await readJson(await GET(authedRequest()));
    expect(body.verified).toBe(true);
    // getEnvSources 会补 key/isAdult，这里只断言部署者写进去的部分
    expect(body.defaultSources).toHaveLength(1);
    expect(body.defaultSources?.[0]).toMatchObject({
      name: '测试源',
      url: 'https://up.example.com/api.php/provide/vod',
    });
    expect(body.defaultSubscriptions?.[0]).toMatchObject({ url: 'https://up.example.com/sources.json' });
    expect(body.defaultRecommendSource).toBe('bangumi');
  });

  it('响应禁缓存：登录态与游客态的响应不能互相串', async () => {
    const res = await GET(authedRequest());
    expect(res.headers.get('cache-control')).toContain('no-store');
  });
});

describe('未配密码的公开实例', () => {
  beforeAll(() => {
    delete process.env.PASSWORD;
  });

  it('没有登录态可用，预置源照常下发（否则整站没有源）', async () => {
    process.env.DEFAULT_SOURCES = JSON.stringify([{ name: '公开源', url: 'https://up.example.com/api.php/provide/vod' }]);
    const body = await readJson(await GET(anonymousRequest()));
    expect(body.passwordRequired).toBe(false);
    expect(body.defaultSources).toHaveLength(1);
    expect(body.defaultSources?.[0]).toMatchObject({
      name: '公开源',
      url: 'https://up.example.com/api.php/provide/vod',
    });
  });
});
