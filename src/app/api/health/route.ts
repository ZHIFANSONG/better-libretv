import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

/**
 * 存活探针：给容器 HEALTHCHECK / 反代健康检查用。
 *
 * 刻意**不校验登录**，也刻意不返回任何配置信息 —— 只回答「进程还在、路由系统还在」。
 * 探针必须不需要凭据，否则 PASSWORD 一改、Cookie 一过期，容器就会被判死重启。
 * 也不去 ping 上游采集站：那等于让健康检查变成对外部源站的定时请求，
 * 源站抖一下整站就被判不健康。
 */
export async function GET() {
  return NextResponse.json(
    { ok: true },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
