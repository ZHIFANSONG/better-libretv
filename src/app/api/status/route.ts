import { NextResponse } from 'next/server';
import { isPasswordConfigured, sessionFromCookieHeader } from '@/lib/auth';
import { getEnvSources } from '@/lib/env-sources';
import { getEnvLiveSources } from '@/lib/env-live-sources';
import { getEnvSubscriptions } from '@/lib/env-subscriptions';
import { getEnvRecommendSource } from '@/lib/env-recommend-source';
import { getEnvImageMode } from '@/lib/env-image-mode';

export const runtime = 'nodejs';

/**
 * 站点状态：客户端据此决定是否弹出登录框 / 提示管理员配置密码，
 * 并在**已授权**时获取部署者预置的采集站、直播源与订阅。
 *
 * 预置源是本机的部署配置，不是站点元信息：未登录时下发等于把
 * 十几个采集站地址、订阅链接和推荐源白白交出去（这个接口无需鉴权即可访问，
 * 任何爬虫读一次就能拿到整份上游清单）。因此这些字段只在
 * 「未配置密码（公开实例）」或「已登录」时才出现在响应里。
 *
 * 客户端对此无需特殊处理：applyEnvPresets 对缺失字段一律跳过，
 * 登录成功后 AuthProvider 会重新拉一次本接口，届时预置源自然补齐。
 */
export async function GET(req: Request) {
  const passwordRequired = isPasswordConfigured();
  const verified = Boolean(passwordRequired && sessionFromCookieHeader(req.headers.get('cookie')));
  // 公开实例没有登录态可用，只能照常下发；配了密码的实例必须由登录态解锁
  const authorized = !passwordRequired || verified;

  const payload: Record<string, unknown> = {
    passwordRequired,
    verified,
    // 构建时由 next.config.ts 从 package.json 注入
    version: process.env.APP_VERSION || 'dev',
  };

  if (authorized) {
    // 部署者通过 DEFAULT_SOURCES 预置的采集站
    payload.defaultSources = getEnvSources();
    // 部署者通过 DEFAULT_LIVE_SOURCES 预置的直播源（M3U 订阅）
    payload.defaultLiveSources = getEnvLiveSources();
    // 部署者通过 DEFAULT_SUBSCRIPTIONS 预置的 SourceList 订阅链接
    payload.defaultSubscriptions = getEnvSubscriptions();
    // 部署者通过 DEFAULT_RECOMMEND_SOURCE 指定的首页推荐数据源默认值（未配置时为 null）
    payload.defaultRecommendSource = getEnvRecommendSource() ?? null;
    // 部署者通过 DEFAULT_IMAGE_MODE 指定的封面图加载方式默认值（未配置时为 null）
    payload.defaultImageMode = getEnvImageMode() ?? null;
  }

  return NextResponse.json(payload, {
    // 响应内容随登录态变化，任何一层缓存都可能把「有预置源」的版本发给游客
    headers: { 'Cache-Control': 'no-store, no-transform' },
  });
}
