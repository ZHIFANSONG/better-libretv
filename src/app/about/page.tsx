'use client';

import { Header } from '@/components/header';
import { SiteFooter } from '@/components/site-footer';
import { useT } from '@/components/lang-sync';

export default function AboutPage() {
  const t = useT();
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 max-w-2xl w-full mx-auto px-4 py-10 space-y-8">
        <section>
          <h1 className="text-xl font-bold text-content mb-3">{t('about.title')}</h1>
          <p className="text-sm text-muted leading-relaxed">{t('about.intro')}</p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-content mb-2.5">{t('about.shortcuts')}</h2>
          <ul className="text-sm text-muted space-y-1.5 list-disc list-inside">
            <li>
              <code className="text-accent">{t('about.keySpace')}</code> {t('about.skPlay')}
            </li>
            <li>
              <code className="text-accent">←</code> / <code className="text-accent">→</code> {t('about.skSeek')}
            </li>
            <li>
              <code className="text-accent">↑</code> / <code className="text-accent">↓</code> {t('about.skVolume')}
            </li>
            <li>
              <code className="text-accent">F</code> {t('about.skFullscreen')}
            </li>
            <li>
              <code className="text-accent">Alt + ←/→</code> {t('about.skEpisode')}
            </li>
            <li>{t('about.skLongPress')}</li>
          </ul>
        </section>

        <section>
          <h2 className="text-base font-semibold text-content mb-2.5">{t('about.privacy')}</h2>
          <p className="text-sm text-muted leading-relaxed">{t('about.privacyBody')}</p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-content mb-2.5">{t('about.disclaimer')}</h2>
          <p className="text-sm text-faint leading-relaxed">{t('about.disclaimerBody')}</p>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
