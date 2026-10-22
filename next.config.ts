import type { NextConfig } from 'next';
import fs from 'node:fs';
import path from 'node:path';

/** 版本号以 package.json 为单一来源，构建时注入 process.env.APP_VERSION（/api/status 使用） */
function readAppVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const nextConfig: NextConfig = {
  // standalone 输出仅供 Docker 镜像构建使用（DOCKER_BUILD=1）；
  // 本地 next start 在 standalone 模式下不受支持，故按环境切换
  output: process.env.DOCKER_BUILD === '1' ? 'standalone' : undefined,
  reactStrictMode: true,
  env: { APP_VERSION: readAppVersion() },
  // 采集站/豆瓣等上游地址在运行时由用户配置，构建期无法枚举，关闭图片优化改用 <img>
  images: { unoptimized: true },
  // Next 16 默认拒绝「Host 与 dev 地址不一致」的开发资源请求（/_next/hmr、HMR websocket），
  // 表现为浏览器控制台刷 "Blocked cross-origin request to Next.js dev resource"、
  // 且 playwright 用 127.0.0.1 访问时客户端组件不水合（页面只剩骨架）。
  // 仅影响 dev，生产镜像不读取该字段。
  allowedDevOrigins: ['127.0.0.1', 'localhost', '192.168.3.64'],
  // Turbopack 默认把仓库根当成 root，而本仓库被包在上一层 monorepo 里（D:\DeepSeekharness\server\site-redesign
  // 也有 package-lock.json），不显式指定会打印「ignored package-lock.json ... outside the current Git repository」。
  turbopack: { root: __dirname },
};

export default nextConfig;
