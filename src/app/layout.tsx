import type { Metadata, Viewport } from 'next';
import './globals.css';
import './proposal.css';
import { Providers } from '@/components/providers';
import { GlassRuntime } from '@/components/glass-runtime';
import { TopProgress } from '@/components/top-progress';

export const metadata: Metadata = {
  title: {
    default: 'LibreTV - 免费在线视频搜索与观看平台',
    template: '%s - LibreTV',
  },
  description:
    'LibreTV 是一个免费的在线视频搜索平台，无广告、安全，提供来自多个视频源的内容搜索与观看服务，无需注册即可使用。',
  manifest: '/manifest.webmanifest',
  // 图标与门户站（LibreTV-portal）同一套：同一张 artwork 导出的多尺寸 + 根目录 favicon.ico 兜底。
  // 只声明单张 512 时，抓取端只能拿大图缩放，小尺寸下易糊、看起来「没填满」。
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '48x48' },
      { url: '/icons/icon-96.png', sizes: '96x96', type: 'image/png' },
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
};

export const viewport: Viewport = {
  themeColor: '#0a0a0a',
  width: 'device-width',
  initialScale: 1,
  // 必须开 cover：否则 iPhone 的 Safari 会把视口限制在「安全区」以内，
  // env(safe-area-inset-*) 恒等于 0，底部导航/tab 条会压在 Home 指示条下面。
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        {/* 首屏前同步主题，避免亮暗闪烁 */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var t=localStorage.getItem('libretv-theme')||'dark';var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);}catch(e){}})()",
          }}
        />
      </head>
      <body>
        {/* 背景层：46px 网格 + 蓝晕 + 两团漂移光斑。
            它们由 CSS 画在 DOM 里（CSS 后端下玻璃就是 backdrop-filter，必须自己下面有东西可模糊）；
            .g-mesh z-index:0 / .g-bg z-index:1，主内容 .g-shell/.g-page 是 z-index:2，天然压在上面。 */}
        <div className="g-mesh" aria-hidden="true">
          <svg width="100%" height="100%">
            <defs>
              <pattern id="g-grid" width="46" height="46" patternUnits="userSpaceOnUse">
                <path d="M46 0H0V46" fill="none" stroke="rgba(255,255,255,.08)" strokeWidth="1" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#g-grid)" />
          </svg>
        </div>
        <div className="g-bg" aria-hidden="true">
          <i />
          <i />
        </div>
        <GlassRuntime />
        <TopProgress />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
