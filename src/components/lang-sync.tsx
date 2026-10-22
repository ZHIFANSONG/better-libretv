'use client';

import { useEffect } from 'react';
import { useAppStore } from '@/lib/store';
import { tr } from '@/lib/i18n';

/**
 * 语言同步 + 取文案。
 *
 * store 用 skipHydration 手动 rehydrate（见 Providers）：首帧 lang 一定是初始值 'zh'，
 * rehydrate 完成后才可能变成 'en'。所以这里不能把 lang 写进 <html lang> 的 SSR 输出，
 * 只能挂载后同步 —— 服务端渲染的静态元信息本来也只有中文一份。
 */

/** 当前界面语言（响应式；rehydrate 后自动更新） */
export function useLang() {
  return useAppStore((s) => s.lang);
}

/** 绑定当前语言的翻译函数：const t = useT(); t('nav.home') */
export function useT() {
  const lang = useLang();
  return (key: string, vars?: Record<string, string | number>) => tr(lang, key, vars);
}

/**
 * 把 <html lang> 与 data-lang 跟 store 同步。
 * data-lang 给 CSS 用（例如按语言调字距/行高，中文字距偏小、拉丁字母需要更多行高）。
 */
export function LangSync() {
  const lang = useLang();
  useEffect(() => {
    const root = document.documentElement;
    root.lang = lang === 'en' ? 'en' : 'zh-CN';
    root.dataset.lang = lang;
  }, [lang]);
  return null;
}
