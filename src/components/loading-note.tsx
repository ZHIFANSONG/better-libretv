'use client';

import { useT } from './lang-sync';

/**
 * 路由级加载占位的底部提示文案。
 *
 * 单独抽成客户端组件是因为 app/loading.tsx 是 Server Component：
 * useT() 依赖 zustand store（skipHydration 手动 rehydrate），只能在客户端跑。
 */
export function LoadingNote() {
  const t = useT();
  return <p className="g-note mt-8">{t('loading.page')}</p>;
}
