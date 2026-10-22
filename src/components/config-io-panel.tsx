'use client';

import { useState } from 'react';
import { ConfirmDialog } from './confirm-dialog';
import { SectionTitle } from './settings-shared';
import { useToast } from './toast';
import { exportConfig, importConfig } from '@/lib/db';
import { PERSIST_KEY } from '@/lib/persist-storage';
import { useAuth } from './auth';
import { listSep, type Translator } from '@/lib/i18n';
import { useLang, useT } from './lang-sync';

/** 配置导入导出（导出受登录门控；导入前先解析预览再确认，避免误覆盖） */
export function ConfigIoPanel() {
  const t = useT();
  const lang = useLang();
  const { toast } = useToast();
  const { verified, openLogin } = useAuth();
  const [pending, setPending] = useState<{ file: File; summary: string } | null>(null);

  const doExport = async () => {
    if (verified === false) {
      openLogin();
      return;
    }
    try {
      const json = await exportConfig();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `LibreTV-Settings_${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast(t('sm.configExported'), 'success');
    } catch {
      toast(t('sm.exportFail'), 'error');
    }
  };

  const pickImport = async (file: File) => {
    try {
      const summary = summarizeConfig(await file.text(), t, listSep(lang));
      setPending({ file, summary });
    } catch (err) {
      toast(err instanceof Error ? err.message : t('sm.importFail'), 'error');
    }
  };

  const confirmImport = async () => {
    if (!pending) return;
    try {
      await importConfig(await pending.file.text());
      setPending(null);
      toast(t('sm.importOk'), 'success');
      setTimeout(() => window.location.reload(), 1500);
    } catch (err) {
      toast(err instanceof Error ? err.message : t('sm.importFail'), 'error');
    }
  };

  return (
    <section>
      <SectionTitle title={t('sm.ioTitle')} hint={t('sm.ioHint')} />
      <div className="flex gap-2">
        <button className="btn-ghost flex-1 text-xs" onClick={doExport}>
          {t('sm.exportConfig')}
        </button>
        <label className="btn-ghost flex-1 text-xs cursor-pointer">
          {t('sm.importConfig')}
          <input
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void pickImport(f);
              e.target.value = '';
            }}
          />
        </label>
      </div>

      {/* 重操作：导入会覆盖全部配置，先确认并展示将导入的内容概要 */}
      <ConfirmDialog
        open={pending !== null}
        danger
        title={t('sm.importTitle')}
        message={pending ? t('sm.importMessage', { summary: pending.summary }) : undefined}
        confirmLabel={t('sm.importConfirm')}
        onCancel={() => setPending(null)}
        onConfirm={confirmImport}
      />
    </section>
  );
}

/** 解析配置文件概要（宽松，仅用于导入前预览） */
export function summarizeConfig(text: string, t: Translator, sep: string): string {
  let cfg: { name?: string; data?: Record<string, unknown> };
  try {
    cfg = JSON.parse(text) as { name?: string; data?: Record<string, unknown> };
  } catch {
    throw new Error(t('sm.badJson'));
  }
  if (cfg.name !== 'LibreTV-Settings') throw new Error(t('sm.badConfig'));

  const parts: string[] = [];
  const settingsRaw = cfg.data?.[PERSIST_KEY];
  if (typeof settingsRaw === 'string') {
    try {
      const state = (JSON.parse(settingsRaw) as { state?: Record<string, unknown> }).state ?? {};
      const vod = Array.isArray(state.customAPIs) ? state.customAPIs.length : 0;
      const live = Array.isArray(state.liveSubscriptions) ? state.liveSubscriptions.length : 0;
      const subs = Array.isArray(state.subscriptions) ? state.subscriptions.length : 0;
      parts.push(
        t('sm.summaryVod', { n: vod }),
        t('sm.summaryLive', { n: live }),
        t('sm.summarySubs', { n: subs })
      );
    } catch {
      /* 设置片段损坏时忽略该部分统计 */
    }
  }
  const historyRaw = cfg.data?.['viewingHistory'];
  if (typeof historyRaw === 'string') {
    try {
      const h = JSON.parse(historyRaw);
      if (Array.isArray(h)) parts.push(t('sm.summaryHistory', { n: h.length }));
    } catch {
      /* 忽略 */
    }
  }
  return parts.length > 0 ? t('sm.summaryPrefix', { items: parts.join(sep) }) : t('sm.summaryEmpty');
}