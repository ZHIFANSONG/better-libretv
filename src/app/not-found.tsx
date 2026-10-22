'use client';

import Link from 'next/link';
import { Header } from '@/components/header';
import { useT } from '@/components/lang-sync';

/**
 * 404：版式与其他页面一致，给两个回得去的入口。
 * 标 'use client' 是为了拿 useT() —— 这里的文案属于界面框架，
 * 跟着语言设置走；Header 本来就是客户端组件，不会多出额外的边界。
 */
export default function NotFound() {
  const t = useT();
  return (
    <div className="g-shell min-h-screen flex flex-col">
      <Header />
      <main className="g-page flex-1 flex items-start justify-center pt-24">
        <div className="g-panel w-full max-w-lg p-8 text-center enter">
          <p className="g-note mb-2">error 404</p>
          <h1 className="text-content font-medium text-lg mb-2">{t('notFound.title')}</h1>
          <p className="text-sm text-muted mb-6">{t('notFound.desc')}</p>
          <div className="flex items-center justify-center gap-3">
            <Link href="/" className="g-act pri">
              {t('notFound.home')}
            </Link>
            <Link href="/search" className="g-act">
              {t('search.label')}
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
