import Link from 'next/link';
import { Header } from '@/components/header';

/** 404：版式与其他页面一致，给两个回得去的入口 */
export default function NotFound() {
  return (
    <div className="g-shell min-h-screen flex flex-col">
      <Header />
      <main className="g-page flex-1 flex items-start justify-center pt-24">
        <div className="g-panel w-full max-w-lg p-8 text-center enter">
          <p className="g-note mb-2">error 404</p>
          <h1 className="text-content font-medium text-lg mb-2">这个页面不存在</h1>
          <p className="text-sm text-muted mb-6">链接可能已经失效，或者地址输错了。</p>
          <div className="flex items-center justify-center gap-3">
            <Link href="/" className="g-act pri">
              回到首页
            </Link>
            <Link href="/search" className="g-act">
              搜索影片
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
