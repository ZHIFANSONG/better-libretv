import { Header } from '@/components/header';
import { LoadingNote } from '@/components/loading-note';

/**
 * 路由级加载占位（Next 的 app/loading.tsx）：点进 /search、/live、/me 时先渲染它。
 * 顶栏保持常驻，正文用和真实版式同形的占位块 —— 整组模糊 + 呼吸（m06954-2），
 * 不再是 shimmer 扫光：内容一到就原地清晰，视觉上更接近「正在对焦」。
 */
export default function Loading() {
  return (
    <div className="g-shell min-h-screen flex flex-col">
      <Header />
      <main className="g-page flex-1" aria-busy="true" aria-live="polite">
        <div className="g-soft-group" aria-hidden>
          <div className="g-search g-sk-bar" />
          <div className="g-tabs g-sk-tabs">
            {Array.from({ length: 5 }).map((_, i) => (
              <span key={i} className="g-tab g-sk-tab" />
            ))}
          </div>
          <div className="g-grid mt-6">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="g-poster g-sk-poster" />
            ))}
          </div>
        </div>
        <LoadingNote />
      </main>
    </div>
  );
}
