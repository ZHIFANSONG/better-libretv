'use client';

import { useEffect, useState } from 'react';
import { NumberField, SectionTitle, SelectRow, ToggleRow } from './settings-shared';
import { useAppStore } from '@/lib/store';
import { LANGUAGES, tr } from '@/lib/i18n';
import { useT } from './lang-sync';

// —— 偏好设置面板 ——

/**
 * 通用：界面语言。放在「偏好设置」第一格，因为它是唯一一条「影响全部界面」的开关。
 * 采集源名称、影片标题/简介不跟着翻（那是源站原文，翻了反而对不上搜索结果）。
 */
export function GeneralPanel() {
  const lang = useAppStore((s) => s.lang);
  const updateSettings = useAppStore((s) => s.updateSettings);
  return (
    <section>
      <SectionTitle title={tr(lang, 'settings.language')} hint={tr(lang, 'settings.languageHint')} />
      <div className="space-y-2">
        <SelectRow
          label={tr(lang, 'settings.language')}
          value={lang}
          description={tr(lang, 'settings.languageHint')}
          onChange={(v) => updateSettings({ lang: v === 'en' ? 'en' : 'zh' })}
          options={LANGUAGES.map((l) => ({ value: l.id, label: l.label, hint: l.en }))}
        />
      </div>
    </section>
  );
}

export function PlaybackPanel() {
  const store = useAppStore();
  const t = useT();
  return (
    <section>
      <SectionTitle title={t('sm.playbackTitle')} />
      <div className="space-y-3">
        <ToggleRow
          label={t('sm.adFilter')}
          description={t('sm.adFilterDesc')}
          checked={store.adFilter}
          onChange={(v) => store.updateSettings({ adFilter: v })}
        />
        <ToggleRow
          label={t('sm.autoplay')}
          description={t('sm.autoplayDesc')}
          checked={store.autoplayNext}
          onChange={(v) => store.updateSettings({ autoplayNext: v })}
        />
        {/*
          跳过片头/片尾的「全局默认值」。真正的值是按剧存的（播放页动作行可覆盖），
          这里只决定没单独配过的剧用多少秒；填 0 就是默认不跳。
        */}
        <div className="flex items-center justify-between gap-4 py-0.5">
          <div className="min-w-0">
            <div className="text-sm text-content">{t('sm.skipIntro')}</div>
            <div className="text-xs text-faint">{t('sm.skipIntroDesc')}</div>
          </div>
          <NumberField
            value={store.skipIntroSec}
            min={0}
            max={600}
            step={5}
            unit={t('sm.unitSec')}
            ariaLabel={t('sm.skipIntroAria')}
            onChange={(v) => store.updateSettings({ skipIntroSec: v })}
          />
        </div>
        <div className="flex items-center justify-between gap-4 py-0.5">
          <div className="min-w-0">
            <div className="text-sm text-content">{t('sm.skipOutro')}</div>
            <div className="text-xs text-faint">{t('sm.skipOutroDesc')}</div>
          </div>
          <NumberField
            value={store.skipOutroSec}
            min={0}
            max={600}
            step={5}
            unit={t('sm.unitSec')}
            ariaLabel={t('sm.skipOutroAria')}
            onChange={(v) => store.updateSettings({ skipOutroSec: v })}
          />
        </div>
      </div>
    </section>
  );
}

export function ImagePanel() {
  const store = useAppStore();
  const t = useT();
  const mode = store.imageProxyMode;
  const description: Record<'direct' | 'proxy' | 'custom', string> = {
    direct: t('sm.imageDirectDesc'),
    proxy: t('sm.imageProxyDesc'),
    custom: t('sm.imageCustomDesc'),
  };
  return (
    <section>
      <SectionTitle title={t('sm.imageTitle')} />
      <div className="space-y-2">
        <SelectRow
          label={t('sm.imageMode')}
          value={mode}
          description={description[mode]}
          onChange={(v) => store.updateSettings({ imageProxyMode: v as 'direct' | 'proxy' | 'custom' })}
          options={[
            { value: 'direct', label: t('sm.imageDirect'), hint: t('sm.imageDirectHint') },
            { value: 'proxy', label: t('sm.imageProxy'), hint: t('sm.imageProxyHint') },
            { value: 'custom', label: t('sm.imageCustom'), hint: t('sm.imageCustomHint') },
          ]}
        />
        {mode === 'custom' && <CustomProxyInput />}
      </div>
    </section>
  );
}

/**
 * 自定义代理模板输入：本地即时回显 + 300ms 防抖写 store。
 * 直接每次按键写 store 会让全站封面 URL 重算并触发一轮图片重载（模板输入时缩略图持续闪烁）。
 */
export function CustomProxyInput() {
  const t = useT();
  const value = useAppStore((s) => s.customImageProxy);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const [draft, setDraft] = useState(value);

  // 外部值变化（如导入配置）时同步回显
  useEffect(() => setDraft(value), [value]);

  useEffect(() => {
    if (draft === value) return;
    const timer = setTimeout(() => updateSettings({ customImageProxy: draft }), 300);
    return () => clearTimeout(timer);
  }, [draft, value, updateSettings]);

  return (
    <input
      className="input w-full"
      aria-label={t('sm.proxyTemplateAria')}
      placeholder={t('sm.proxyTemplatePlaceholder')}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
    />
  );
}

export function HomePanel() {
  const store = useAppStore();
  const t = useT();
  return (
    <section>
      <SectionTitle title={t('sm.homeTitle')} />
      <div className="space-y-3">
        <ToggleRow
          label={t('sm.yellowFilter')}
          description={t('sm.yellowFilterDesc')}
          checked={store.yellowFilter}
          onChange={(v) => store.updateSettings({ yellowFilter: v })}
        />
        <ToggleRow
          label={t('sm.douban')}
          description={t('sm.doubanDesc')}
          checked={store.doubanEnabled}
          onChange={(v) => store.updateSettings({ doubanEnabled: v })}
        />
        <SelectRow
          label={t('sm.recommendSource')}
          value={store.recommendSource}
          onChange={(v) => store.updateSettings({ recommendSource: v as 'douban' | 'bangumi' | 'hot-list' })}
          options={[
            { value: 'douban', label: t('sm.recommendDouban'), hint: t('sm.recommendDoubanHint') },
            { value: 'bangumi', label: t('sm.recommendBangumi'), hint: t('sm.recommendBangumiHint') },
            { value: 'hot-list', label: t('sm.recommendHot'), hint: t('sm.recommendHotHint') },
          ]}
        />
      </div>
    </section>
  );
}