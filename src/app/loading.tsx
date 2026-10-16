import { Header } from '@/components/header';

/**
 * 路由级加载骨架（Next 的 app/loading.tsx）：点进 /search、/live、/me 时先渲染它，
 * 顶栏保持常驻，正文用和真实版式同形的骨架块 + shimmer 微光，避免白屏或布局跳动。
 */
export default function Loading() {
  return (
    <div className="g-shell min-h-screen flex flex-col">
      <Header />
      <main className="g-page flex-1" aria-busy="true" aria-live="polite">
        <div className="g-search g-sk-bar" />
        <div className="g-tabs g-sk-tabs">
          {Array.from({ length: 5 }).map((_, i) => (
            <span key={i} className="g-tab g-sk g-sk-tab" />
          ))}
        </div>
        <div className="g-grid mt-6">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="g-poster g-sk g-sk-poster" />
          ))}
        </div>
        <p className="g-note mt-8">正在加载…</p>
      </main>
    </div>
  );
}
