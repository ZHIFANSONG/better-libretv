'use client';

import { useEffect, useMemo, useState } from 'react';
import { Drawer } from './drawer';
import { ConfirmDialog } from './confirm-dialog';
import { Icon, type IconName } from './icon';
import { LiveSourceManager } from './live-source-manager';
import {
  HealthBadge,
  SearchInput,
  SectionTitle,
  SelectRow,
  TestBadge,
  ToggleRow,
  NumberField,
  Switch,
  useSourceTests,
  type TestState,
} from './settings-shared';
import { EmptyState, Spinner } from './states';
import { useSourceProbe } from './use-source-probe';
import { allLiveSources, isSourceDisabled, keyBelongsToSubscription, resolveSource, subKeyPrefix, useAppStore } from '@/lib/store';
import type { SourceConfig } from '@/lib/types';
import { useToast } from './toast';
import { formatRelativeTime, hostnameOf, validateSourceUrl, cn } from '@/lib/utils';
import { exportConfig, importConfig } from '@/lib/db';
import { PERSIST_KEY } from '@/lib/persist-storage';
import { copyToClipboard } from '@/lib/clipboard';
import { useAuth } from './auth';
import { api } from '@/lib/client-api';
import { syncSourceSubscription } from '@/lib/subscription-sync';
import { describeParseStats } from '@/lib/tvbox-parser';
import { LANGUAGES, listSep, tr } from '@/lib/i18n';
import { useLang, useT } from './lang-sync';

/**
 * 设置抽屉：顶部两级导航。
 * - 一级按性质分组：源管理 / 偏好设置 / 数据；
 * - 二级为该分组下的具体面板，每次只渲染一类内容，避免源很多时长距离滚动。
 * 选中位置记忆到 localStorage，再次打开回到上次所在面板。
 */

type PrimaryTab = 'sources' | 'prefs' | 'data';
type SecondaryTab = 'vod' | 'live' | 'subs' | 'general' | 'playback' | 'image' | 'home' | 'io';

// 导航项只存 key，文案在渲染时取：模块级常量拿不到 useT() 的语言
const PRIMARY_TABS: { id: PrimaryTab; labelKey: string; icon: IconName }[] = [
  { id: 'sources', labelKey: 'sm.tabSources', icon: 'link' },
  { id: 'prefs', labelKey: 'sm.tabPrefs', icon: 'gear' },
  { id: 'data', labelKey: 'sm.tabData', icon: 'download' },
];

const SECONDARY_TABS: Record<PrimaryTab, { id: SecondaryTab; labelKey: string }[]> = {
  sources: [
    { id: 'vod', labelKey: 'sm.tabVod' },
    { id: 'live', labelKey: 'sm.tabLive' },
    { id: 'subs', labelKey: 'sm.tabSubs' },
  ],
  prefs: [
    { id: 'general', labelKey: 'sm.tabGeneral' },
    { id: 'playback', labelKey: 'sm.tabPlayback' },
    { id: 'image', labelKey: 'sm.tabImage' },
    { id: 'home', labelKey: 'sm.tabHome' },
  ],
  data: [{ id: 'io', labelKey: 'sm.tabIo' }],
};

const TAB_STORAGE_KEY = 'libretv-settings-tab';

export function SourceManagerDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const [primary, setPrimary] = useState<PrimaryTab>('sources');
  const [secondary, setSecondary] = useState<Record<PrimaryTab, SecondaryTab>>({
    sources: 'vod',
    prefs: 'general',
    data: 'io',
  });

  // 挂载后读取上次位置（不在渲染期读 localStorage，避免 SSR/hydration 不一致）
  useEffect(() => {
    try {
      const raw = localStorage.getItem(TAB_STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as {
        primary?: PrimaryTab;
        secondary?: Partial<Record<PrimaryTab, SecondaryTab>>;
      };
      // 旧版把「数据源订阅」放在「数据」下，现已迁至「源管理」：自动重定向到新位置
      const migratedSubs = saved.secondary?.data === 'subs';
      const targetPrimary = migratedSubs && saved.primary === 'data' ? 'sources' : saved.primary;
      if (targetPrimary && SECONDARY_TABS[targetPrimary]) setPrimary(targetPrimary);
      setSecondary((prev) => {
        const next = { ...prev };
        if (migratedSubs) next.sources = 'subs';
        for (const key of Object.keys(SECONDARY_TABS) as PrimaryTab[]) {
          const v = saved.secondary?.[key];
          if (v && SECONDARY_TABS[key].some((t) => t.id === v)) next[key] = v;
        }
        return next;
      });
    } catch {
      /* 本地记录损坏时忽略，回到默认面板 */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(TAB_STORAGE_KEY, JSON.stringify({ primary, secondary }));
    } catch {
      /* 隐私模式等无法写入时忽略 */
    }
  }, [primary, secondary]);

  const current = secondary[primary];

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={t('sm.title')}
      resetScrollKey={current}
      subheader={
        <div className="space-y-2">
          <TabRow tabs={PRIMARY_TABS} value={primary} onChange={setPrimary} variant="primary" ariaLabel={t('sm.navPrimaryAria')} />
          {/* 分组下只有一项时无需二级导航，直接展示该面板 */}
          {SECONDARY_TABS[primary].length > 1 && (
            <TabRow
              tabs={SECONDARY_TABS[primary]}
              value={current}
              onChange={(id) => setSecondary((prev) => ({ ...prev, [primary]: id }))}
              variant="secondary"
              ariaLabel={t('sm.navSecondaryAria')}
            />
          )}
        </div>
      }
    >
      {current === 'vod' && <VodSourcesPanel />}
      {current === 'live' && <LiveSourceManager />}
      {current === 'general' && <GeneralPanel />}
      {current === 'playback' && <PlaybackPanel />}
      {current === 'image' && <ImagePanel />}
      {current === 'home' && <HomePanel />}
      {current === 'subs' && <SourceSubscriptions />}
      {current === 'io' && <ConfigIoPanel />}
    </Drawer>
  );
}

/** 一级/二级导航条（role=tablist，左右方向键切换） */
function TabRow<T extends string>({
  tabs,
  value,
  onChange,
  variant,
  ariaLabel,
}: {
  tabs: { id: T; labelKey: string; icon?: IconName }[];
  value: T;
  onChange: (id: T) => void;
  variant: 'primary' | 'secondary';
  ariaLabel: string;
}) {
  // 形参不能叫 t：下面要用 t() 取文案
  const t = useT();
  const move = (dir: 1 | -1) => {
    const idx = tabs.findIndex((tab) => tab.id === value);
    onChange(tabs[(idx + dir + tabs.length) % tabs.length].id);
  };
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn('flex w-full gap-1', variant === 'primary' && 'p-0.5 bg-chip rounded-lg')}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          move(1);
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          move(-1);
        }
      }}
    >
      {tabs.map((tab) => {
        const active = tab.id === value;
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={active}
            className={cn(
              // 两级导航都等宽撑满一行（原先二级按内容宽度、超宽才横滚，与一级不一致）
              'flex-1 min-w-0 inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-md transition-colors',
              variant === 'primary'
                ? cn(
                    'px-2 py-1.5 text-xs',
                    active ? 'bg-surface-raised text-accent font-medium shadow-sm' : 'text-muted hover:text-content'
                  )
                : cn(
                    'px-2.5 py-1 text-xs',
                    active ? 'bg-accent/10 text-accent font-medium' : 'text-muted hover:text-content hover:bg-hover'
                  )
            )}
            onClick={() => onChange(tab.id)}
          >
            {tab.icon && <Icon name={tab.icon} className="w-3.5 h-3.5" />}
            {t(tab.labelKey)}
          </button>
        );
      })}
    </div>
  );
}

// —— 点播源面板 ——

type VodFilter = 'all' | 'enabled' | 'disabled' | 'sub' | 'manual';

// 与直播源面板保持同一组筛选项与顺序：先状态（已启用 / 已停用），后来源（来自订阅 / 手动添加）
const VOD_FILTERS: { id: VodFilter; labelKey: string }[] = [
  { id: 'all', labelKey: 'sm.filterAll' },
  { id: 'enabled', labelKey: 'sm.filterEnabled' },
  { id: 'disabled', labelKey: 'sm.filterDisabled' },
  { id: 'sub', labelKey: 'sm.filterSub' },
  { id: 'manual', labelKey: 'sm.filterManual' },
];

function VodSourcesPanel() {
  const store = useAppStore();
  const { toast } = useToast();
  const t = useT();
  const [editing, setEditing] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<VodFilter>('all');
  const { tests, runTest } = useSourceTests();
  const { progress, probe, cancel, isProbing } = useSourceProbe();

  const envKeys = useMemo(() => new Set(store.envSources.map((s) => s.key)), [store.envSources]);
  const all = useMemo(() => [...store.envSources, ...store.customAPIs], [store.envSources, store.customAPIs]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((s) => {
      const fromSub = s.key.startsWith('sub_');
      // 已启用 = 勾选中且当前未被自动停用（即真正在参与搜索的源）
      if (filter === 'enabled' && !(store.selectedKeys.includes(s.key) && !isSourceDisabled(store, s.key))) return false;
      if (filter === 'disabled' && !isSourceDisabled(store, s.key)) return false;
      if (filter === 'sub' && !fromSub) return false;
      // 手动添加 = 既非订阅导入、也非部署者预置
      if (filter === 'manual' && (fromSub || envKeys.has(s.key))) return false;
      if (!q) return true;
      return s.name.toLowerCase().includes(q) || s.url.toLowerCase().includes(q);
    });
  }, [all, query, filter, store, envKeys]);

  const visibleKeys = filtered.map((s) => s.key);
  const allSelected = visibleKeys.length > 0 && visibleKeys.every((k) => store.selectedKeys.includes(k));

  const toggleAll = () => {
    if (allSelected) {
      store.setSelectedKeys(store.selectedKeys.filter((k) => !visibleKeys.includes(k)));
      return;
    }
    // 成人过滤开启时成人源不可勾选，与行内复选框保持一致
    const eligible = filtered.filter((s) => !(s.isAdult && store.yellowFilter)).map((s) => s.key);
    const skipped = filtered.length - eligible.length;
    store.setSelectedKeys([...new Set([...store.selectedKeys, ...eligible])]);
    if (skipped > 0) toast(t('sm.enabledSkippedAdult', { n: eligible.length, skipped }), 'info');
  };

  const runAll = async () => {
    if (isProbing) {
      cancel();
      return;
    }
    const result = await probe(filtered.map((s) => ({ key: s.key, url: s.url })));
    if (!result) return; // 被取消则无汇总
    toast(t('sm.probeDone', { ok: result.ok, total: result.total }), result.ok === result.total ? 'success' : 'info');
  };

  /** 一键恢复被自动停用的源（仅「已停用」筛选下提供） */
  const restoreAll = () => {
    const keys = filtered.filter((s) => isSourceDisabled(store, s.key)).map((s) => s.key);
    if (keys.length === 0) return;
    keys.forEach((k) => useAppStore.getState().clearSourceHealth(k));
    toast(t('sm.restoredCount', { n: keys.length }), 'success');
  };

  const empty = store.envSources.length === 0 && store.customAPIs.length === 0;

  return (
    <section>
      <SectionTitle
        title={t('sm.tabVod')}
        hint={
          empty
            ? undefined
            : t('sm.vodHint', { n: all.length, on: all.filter((s) => store.selectedKeys.includes(s.key)).length })
        }
        extra={
          <button className="btn-primary btn-sm" onClick={() => setEditing('__new__')}>
            <Icon name="plus" className="w-3.5 h-3.5" />
            {t('sm.addApi')}
          </button>
        }
      />

      <SourceForm
        visible={editing === '__new__'}
        onCancel={() => setEditing(null)}
        onSubmit={(data) => {
          store.addCustomApi(data);
          setEditing(null);
        }}
      />

      {empty && editing !== '__new__' ? (
        <EmptyState
          icon="link"
          title={t('sm.vodEmptyTitle')}
          description={t('sm.vodEmptyDesc')}
          action={
            <button className="btn-primary btn-sm" onClick={() => setEditing('__new__')}>
              {t('sm.vodEmptyAction')}
            </button>
          }
        />
      ) : (
        <>
          <div className="space-y-2 mb-3">
            <SearchInput value={query} onChange={setQuery} placeholder={t('sm.searchPlaceholder')} />
            <div className="flex flex-wrap items-center gap-1">
              {VOD_FILTERS.map((f) => (
                <button
                  key={f.id}
                  className={cn(
                    'chip',
                    filter === f.id ? 'bg-accent/10 text-accent font-medium' : 'text-muted hover:text-content hover:bg-hover'
                  )}
                  onClick={() => setFilter(f.id)}
                  aria-pressed={filter === f.id}
                >
                  {t(f.labelKey)}
                </button>
              ))}
              <span className="ml-auto text-[11px] text-faint">{t('sm.showing', { n: filtered.length })}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button className="btn-ghost btn-sm" onClick={toggleAll} disabled={filtered.length === 0}>
                {allSelected ? t('sm.disableAll') : t('sm.enableAll')}
              </button>
              <button
                className="btn-ghost btn-sm"
                onClick={runAll}
                disabled={filtered.length === 0}
              >
                {isProbing ? t('sm.probeStop') : t('sm.probeAll')}
              </button>
              {/* 查看「已停用」时提供一键恢复，省去逐个点击 */}
              {filter === 'disabled' && (
                <button className="btn-ghost btn-sm" onClick={restoreAll} disabled={filtered.length === 0}>
                  {t('sm.restoreAll')}
                </button>
              )}
            </div>
            {progress && (
              <div className="flex items-center gap-2 text-[11px] text-muted">
                <div className="flex-1 h-1.5 bg-chip rounded-full overflow-hidden">
                  <div
                    className="h-full bg-accent transition-[width] duration-200"
                    style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
                  />
                </div>
                <span className="tabular-nums shrink-0">
                  {t('sm.progress', { done: progress.done, total: progress.total, ok: progress.ok })}
                  {formatEta(progress.done, progress.total, progress.startedAt, t)}
                </span>
                <button className="btn-ghost btn-sm shrink-0" onClick={cancel}>
                  {t('common.cancel')}
                </button>
              </div>
            )}
          </div>

          {filtered.length === 0 ? (
            <EmptyState variant="plain" title={t('sm.filterEmpty')} />
          ) : (
            <ul className="space-y-2">
              {filtered.map((source) => (
                <VodSourceRow
                  key={source.key}
                  api={source}
                  isEnv={envKeys.has(source.key)}
                  editing={editing === source.key}
                  onEdit={setEditing}
                  onCancelEdit={() => setEditing(null)}
                  onUpdate={(data) => {
                    store.updateCustomApi(source.key, data);
                    setEditing(null);
                  }}
                  testState={tests[source.key]}
                  onTest={() =>
                    runTest(source.key, async () => {
                      const r = await api.testSource(source.url);
                      // 手动测试也写入健康度，与搜索 / 批量测活共用同一份模型（不再存在两套健康度）
                      useAppStore.getState().recordSourceHealth([
                        { sourceKey: source.key, ok: r.ok, ms: r.ms, error: r.error, list: [] },
                      ]);
                      return r;
                    })
                  }
                />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

/** 纯函数拿不到 hook：由组件把当前语言的翻译函数传进来（与 live-channel-list 同范式） */
type Translator = (key: string, vars?: Record<string, string | number>) => string;

function formatEta(done: number, total: number, startedAt: number, t: Translator): string {
  if (done <= 0 || done >= total) return '';
  const elapsed = Date.now() - startedAt;
  const remainSec = Math.max(0, Math.round((elapsed / done) * (total - done) / 1000));
  return remainSec > 0 ? t('sm.eta', { s: remainSec }) : '';
}

/** 单条点播源行：勾选 / 名称标签 / 健康度 / 探活 / 编辑删除（订阅源与预置源按来源限制操作） */
function VodSourceRow({
  api,
  isEnv,
  editing,
  onEdit,
  onCancelEdit,
  onUpdate,
  testState,
  onTest,
}: {
  api: SourceConfig;
  isEnv: boolean;
  editing: boolean;
  onEdit: (key: string) => void;
  onCancelEdit: () => void;
  onUpdate: (data: { name: string; url: string; detail?: string; isAdult?: boolean }) => void;
  testState?: TestState;
  onTest: () => void;
}) {
  const selected = useAppStore((s) => s.selectedKeys.includes(api.key));
  const yellowFilter = useAppStore((s) => s.yellowFilter);
  const toast = useToast().toast;
  const t = useT();
  const fromSubscription = api.key.startsWith('sub_');
  const adultBlocked = !!api.isAdult && yellowFilter;

  const remove = () => {
    const snapshot = useAppStore.getState().removeCustomApi(api.key);
    if (!snapshot) return;
    // 轻操作：不做确认弹窗，给 6 秒撤销窗口
    toast(t('sm.removed', { name: api.name }), 'info', {
      action: {
        label: t('common.undo'),
        onClick: () => {
          const ok = useAppStore.getState().restoreCustomApi(snapshot);
          toast(ok ? t('common.restored') : t('sm.restoreFailed'), ok ? 'success' : 'warning');
        },
      },
    });
  };

  if (editing) {
    return (
      <li className="bg-card rounded-lg p-3">
        <SourceForm visible initial={api} onCancel={onCancelEdit} onSubmit={onUpdate} />
      </li>
    );
  }

  return (
    <li
      className={cn(
        'bg-card rounded-lg p-3 transition-colors hover:bg-hover/50',
        // 未勾选 = 不参与搜索：整行淡显，长列表里才能一眼扫出哪些没启用
        !selected && 'opacity-70'
      )}
    >
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          className="h-4 w-4 accent-accent shrink-0"
          checked={selected}
          onChange={() => useAppStore.getState().toggleSourceSelected(api.key)}
          disabled={adultBlocked}
          title={adultBlocked ? t('sm.adultBlockedTip') : undefined}
          aria-label={t('sm.selectAria', { name: api.name })}
        />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-content truncate">
            {api.name}
            {api.isAdult && <span className="text-pink-400 text-xs ml-1">(18+)</span>}
            {isEnv && (
              <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-chip text-faint align-middle">
                {t('sm.envBadge')}
              </span>
            )}
            {fromSubscription && (
              <span
                className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent align-middle"
                title={t('sm.subBadgeTip')}
              >
                {t('sm.subBadge')}
              </span>
            )}
          </div>
          <div className="text-xs text-faint truncate">{api.url}</div>
        </div>
        <HealthBadge sourceKey={api.key} />
        <TestBadge
          state={testState}
          onTest={onTest}
          title={t('sm.testTip')}
          badgeWhenOk={({ ms }) => `✓ ${ms}ms`}
        />
        {!isEnv &&
          (fromSubscription ? (
            // 订阅源由远端列表管理：编辑会被下次同步覆盖、删除会复活，故置为禁用态并说明去处
            <>
              <button
                className="rounded-md p-2 text-muted/30 cursor-not-allowed shrink-0"
                disabled
                aria-label={t('sm.subEditLockedAria')}
                title={t('sm.subEditLockedTip')}
              >
                <Icon name="edit" className="w-4 h-4" />
              </button>
              <button
                className="rounded-md p-2 text-muted/30 cursor-not-allowed shrink-0"
                disabled
                aria-label={t('sm.subDeleteLockedAria')}
                title={t('sm.subDeleteLockedTip')}
              >
                <Icon name="trash" className="w-4 h-4" />
              </button>
            </>
          ) : (
            <>
              <button
                className="rounded-md p-2 text-muted transition-colors hover:bg-hover hover:text-accent shrink-0"
                onClick={() => onEdit(api.key)}
                aria-label={t('sm.edit')}
                title={t('sm.edit')}
              >
                <Icon name="edit" className="w-4 h-4" />
              </button>
              <button
                className="rounded-md p-2 text-muted transition-colors hover:bg-hover hover:text-danger shrink-0"
                onClick={remove}
                aria-label={t('sm.delete')}
                title={t('sm.removeTip')}
              >
                <Icon name="trash" className="w-4 h-4" />
              </button>
            </>
          ))}
      </div>
    </li>
  );
}

// —— 偏好设置面板 ——

/**
 * 通用：界面语言。放在「偏好设置」第一格，因为它是唯一一条「影响全部界面」的开关。
 * 采集源名称、影片标题/简介不跟着翻（那是源站原文，翻了反而对不上搜索结果）。
 */
function GeneralPanel() {
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

function PlaybackPanel() {
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

function ImagePanel() {
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
function CustomProxyInput() {
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

function HomePanel() {
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

// —— 数据面板 ——

/**
 * 数据源订阅 / 分享：
 * - 订阅：填入远程订阅地址（LibreTV-SourceList JSON 或 TVBOX 配置 JSON，由服务端自动识别），
 *   一次拉取点播源与直播源，可随时重新同步；
 * - 分享：把当前点播源 + 直播源导出为同格式 JSON 文件，托管到任意位置即可被他人订阅。
 */
function SourceSubscriptions() {
  const store = useAppStore();
  const { toast } = useToast();
  const t = useT();
  const lang = useLang();
  const [subUrl, setSubUrl] = useState('');
  // 每个订阅独立的同步状态，允许多个订阅并行同步（此前单值状态会串台）
  const [syncing, setSyncing] = useState<Set<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const sync = async (url: string) => {
    setSyncing((prev) => new Set(prev).add(url));
    try {
      const { vodCount, liveCount, stats } = await syncSourceSubscription(url);
      // 如实说明跳过/截断情况，避免用户疑惑「配置里站点很多，为何只导入了个位数」
      const detail = describeParseStats(stats, { includeSamples: false });
      const formatLabel = stats?.format === 'tvbox' ? t('sm.tvboxFormat') : '';
      toast(
        t('sm.synced', {
          vod: vodCount,
          live: liveCount,
          format: formatLabel,
          detail: detail ? `；${detail}` : '',
        }),
        'success'
      );
      setSubUrl('');
    } catch (err) {
      toast(err instanceof Error ? err.message : t('sm.subSyncFail'), 'error');
    } finally {
      setSyncing((prev) => {
        const next = new Set(prev);
        next.delete(url);
        return next;
      });
    }
  };

  const addAndSync = () => {
    const url = subUrl.trim();
    if (!validateSourceUrl(url)) {
      toast(t('sm.subUrlInvalid'), 'warning');
      return;
    }
    void sync(url);
  };

  // 发布状态：进行中 + 上一次的发布结果（链接、粘贴板来源与条数）
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState<{
    url: string;
    provider: string;
    sources: number;
    liveSources: number;
  } | null>(null);

  /**
   * 发布当前「已勾选启用」的源：只把真正在参与搜索的源发出去
   * （未勾选的、以及被自动停用的都排除）。注意这与「导出数据源」的全量语义不同。
   */
  const publish = async () => {
    const seen = new Set<string>();
    const sources = store.selectedKeys
      .map((key) => resolveSource(store, key))
      .filter((s): s is SourceConfig => !!s && validateSourceUrl(s.url) && !isSourceDisabled(store, s.key))
      .filter((s) => {
        const key = s.url.replace(/\/+$/, '');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(({ name, url }) => ({ name, url }));

    const liveSeen = new Set<string>();
    const liveSources = allLiveSources(store)
      .filter((s) => store.liveSelectedUrls.includes(s.url))
      .filter((s) => {
        if (liveSeen.has(s.url)) return false;
        liveSeen.add(s.url);
        return true;
      })
      .map(({ name, url, epg }) => ({ name: name || hostnameOf(url), url, epg }));

    if (sources.length === 0 && liveSources.length === 0) {
      toast(t('sm.nothingToPublish'), 'warning');
      return;
    }

    setPublishing(true);
    try {
      const result = await api.publishSourceList({ name: 'LibreTV-SourceList', sources, liveSources });
      setPublished(result);
      toast(
        t('sm.published', { vod: result.sources, live: result.liveSources, provider: result.provider }),
        'success'
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : t('sm.publishFail'), 'error');
    } finally {
      setPublishing(false);
    }
  };

  const copyPublished = () => {
    if (!published) return;
    copyToClipboard(published.url).then((ok) =>
      ok ? toast(t('sm.linkCopied'), 'success') : toast(t('sm.copyFail'), 'warning'),
    );
  };

  const exportSources = () => {
    const all = [...store.envSources, ...store.customAPIs];
    const seen = new Set<string>();
    const sources = all
      .filter((s) => {
        const u = s.url.replace(/\/+$/, '');
        if (seen.has(u)) return false;
        seen.add(u);
        return true;
      })
      .map(({ name, url, detail, isAdult }) => ({ name, url, detail, isAdult }));

    // 直播源：预置 + 手动 + 订阅导入，按 URL 去重
    const liveSeen = new Set<string>();
    const liveSources = [...store.liveEnvSources, ...store.liveSubscriptions]
      .filter((s) => {
        if (liveSeen.has(s.url)) return false;
        liveSeen.add(s.url);
        return true;
      })
      .map(({ name, url, epg }) => ({ name: name || hostnameOf(url), url, epg }));

    const payload = { name: 'LibreTV-SourceList', version: 2, exportedAt: Date.now(), sources, liveSources };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `LibreTV-SourceList_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast(t('sm.exported', { vod: sources.length, live: liveSources.length }), 'success');
  };

  const deleteImpact = (url: string) => {
    const prefix = subKeyPrefix(url);
    return {
      vod: store.customAPIs.filter((a) => keyBelongsToSubscription(a.key, prefix)).length,
      live: store.liveSubscriptions.filter((s) => s.fromSubscriptions.includes(url)).length,
    };
  };

  return (
    <section>
      <SectionTitle
        title={t('sm.subsTitle')}
        extra={
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              className="btn-ghost btn-sm"
              onClick={exportSources}
              disabled={
                store.customAPIs.length + store.envSources.length + store.liveSubscriptions.length + store.liveEnvSources.length ===
                0
              }
            >
              {t('sm.exportSources')}
            </button>
            <button
              className="btn-ghost btn-sm"
              onClick={() => void publish()}
              disabled={publishing}
              title={t('sm.publishTip')}
            >
              {publishing ? t('sm.publishing') : t('sm.publish')}
            </button>
          </div>
        }
      />

      {/* 发布结果：链接公开可读、粘贴板也可能随时清理，这些风险直接写在这里而不是只在 toast 里闪一下 */}
      {published && (
        <div className="mb-3 rounded-lg border border-line bg-chip/60 p-2.5">
          <div className="flex items-center gap-1.5">
            <input
              readOnly
              value={published.url}
              className="input flex-1 min-w-0 !py-1.5 text-xs"
              aria-label={t('sm.publishedAria')}
              onFocus={(e) => e.currentTarget.select()}
            />
            <button className="btn-ghost btn-sm shrink-0" onClick={copyPublished}>
              {t('sm.copy')}
            </button>
            <button
              className="btn-ghost btn-sm shrink-0"
              onClick={() => {
                setSubUrl(published.url);
                void sync(published.url);
              }}
            >
              {t('sm.subscribeNow')}
            </button>
          </div>
          <p className="mt-1.5 text-[11px] text-faint leading-relaxed">
            {t('sm.publishedInfo', {
              provider: published.provider,
              vod: published.sources,
              live: published.liveSources,
            })}
          </p>
        </div>
      )}

      <div className="flex gap-2 mb-2">
        <input
          className="input flex-1 min-w-0"
          placeholder={t('sm.subsPlaceholder')}
          value={subUrl}
          onChange={(e) => setSubUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addAndSync();
          }}
        />
        <button
          className="btn-primary btn-sm shrink-0"
          disabled={!subUrl.trim() || syncing.size > 0}
          onClick={addAndSync}
        >
          {syncing.size > 0 ? t('sm.syncing') : t('sm.subscribe')}
        </button>
      </div>
      {store.subscriptions.length === 0 ? (
        <p className="text-xs text-faint">{t('sm.subsEmptyHint')}</p>
      ) : (
        <ul className="space-y-2">
          {store.subscriptions.map((sub) => {
            const vodCount = store.customAPIs.filter((a) => keyBelongsToSubscription(a.key, subKeyPrefix(sub.url))).length;
            const liveCount = store.liveSubscriptions.filter((s) => s.fromSubscriptions.includes(sub.url)).length;
            const isSyncing = syncing.has(sub.url);
            return (
              <li
                key={sub.url}
                className={cn(
                  'bg-card rounded-lg p-3 transition-colors hover:bg-hover/50',
                  // 与源列表的「未勾选」用同一套停用观感：淡显 + 徽章说明
                  sub.enabled === false && 'opacity-70'
                )}
              >
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-content truncate">{sub.name || hostnameOf(sub.url)}</div>
                    <div className="text-xs text-faint truncate">
                      {sub.url}
                      {sub.lastSync && t('sm.syncAt', { time: formatRelativeTime(sub.lastSync, lang) })}
                    </div>
                    <div className="mt-1 flex items-center gap-1 flex-wrap">
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">
                        {t('sm.subVod', { n: vodCount })}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">
                        {t('sm.subLive', { n: liveCount })}
                      </span>
                      {sub.enabled === false && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-warning/15 text-warning">
                          {t('sm.subDisabledBadge')}
                        </span>
                      )}
                      {sub.lastStatus === 'error' ? (
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded bg-danger/15 text-danger"
                          title={sub.lastError}
                        >
                          {t('sm.lastSyncFailed')}
                        </span>
                      ) : sub.lastStatus === 'ok' && sub.lastCounts ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-success/15 text-success">
                          {t('sm.lastImport', { vod: sub.lastCounts.vod, live: sub.lastCounts.live })}
                        </span>
                      ) : null}
                    </div>
                    {sub.lastStatus === 'error' && sub.lastError && (
                      <p className="text-[11px] text-danger mt-1 break-all">{sub.lastError}</p>
                    )}
                  </div>
                  <Switch
                    checked={sub.enabled !== false}
                    onChange={(v) => store.setSubscriptionEnabled(sub.url, v)}
                    label={sub.enabled === false ? t('sm.subEnable') : t('sm.subDisable')}
                    title={sub.enabled === false ? t('sm.subEnableTip') : t('sm.subDisableTip')}
                  />
                  <button
                    className="rounded-md p-2 shrink-0 text-muted transition-colors hover:bg-hover hover:text-accent disabled:opacity-40"
                    disabled={isSyncing}
                    onClick={() => sync(sub.url)}
                    aria-label={t('sm.resyncAria')}
                    title={t('sm.resyncTip')}
                  >
                    {isSyncing ? (
                      <Spinner size="sm" />
                    ) : (
                      <Icon name="refresh" className="w-4 h-4" />
                    )}
                  </button>
                  <button
                    className="rounded-md p-2 shrink-0 text-muted transition-colors hover:bg-hover hover:text-danger"
                    onClick={() => setPendingDelete(sub.url)}
                    aria-label={t('sm.delSubAria')}
                    title={t('sm.delSubTip')}
                  >
                    <Icon name="trash" className="w-4 h-4" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* 重操作：删除订阅会级联移除其导入的源，先确认并说明影响面 */}
      <ConfirmDialog
        open={pendingDelete !== null}
        danger
        title={t('sm.delSubTitle')}
        message={
          pendingDelete
            ? (() => {
                const impact = deleteImpact(pendingDelete);
                const parts: string[] = [];
                if (impact.vod > 0) parts.push(t('sm.summaryVod', { n: impact.vod }));
                if (impact.live > 0) parts.push(t('sm.summaryLive', { n: impact.live }));
                return parts.length > 0
                  ? t('sm.delSubImpact', { parts: parts.join(t('sm.and')) })
                  : t('sm.delSubNoImpact');
              })()
            : undefined
        }
        confirmLabel={t('sm.delSubConfirm')}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const url = pendingDelete;
          if (url) useAppStore.getState().removeSubscription(url);
          setPendingDelete(null);
          toast(t('sm.subDeleted'), 'success');
        }}
      />
    </section>
  );
}

/** 配置导入导出（导出受登录门控；导入前先解析预览再确认，避免误覆盖） */
function ConfigIoPanel() {
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
function summarizeConfig(text: string, t: Translator, sep: string): string {
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

function SourceForm({
  visible,
  initial,
  onCancel,
  onSubmit,
}: {
  visible: boolean;
  initial?: { key: string; name: string; url: string; detail?: string; isAdult?: boolean };
  onCancel: () => void;
  onSubmit: (data: { name: string; url: string; detail?: string; isAdult?: boolean }) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [url, setUrl] = useState(initial?.url ?? '');
  const [detail, setDetail] = useState(initial?.detail ?? '');
  const [isAdult, setIsAdult] = useState(initial?.isAdult ?? false);
  const { toast } = useToast();
  const t = useT();

  useEffect(() => {
    if (visible) {
      setName(initial?.name ?? '');
      setUrl(initial?.url ?? '');
      setDetail(initial?.detail ?? '');
      setIsAdult(initial?.isAdult ?? false);
    }
  }, [visible, initial]);

  if (!visible) return null;

  const submit = () => {
    const n = name.trim();
    const u = url.trim().replace(/\/+$/, '');
    if (!n || !u) {
      toast(t('sm.needNameUrl'), 'warning');
      return;
    }
    if (!validateSourceUrl(u)) {
      toast(t('sm.badUrl'), 'warning');
      return;
    }
    onSubmit({ name: n, url: u, detail: detail.trim() || undefined, isAdult });
  };

  return (
    <div className="space-y-2 border border-line rounded-lg p-3 bg-chip mb-2">
    <input
      className="input w-full"
      aria-label={t('sm.nameAria')}
      placeholder={t('sm.namePlaceholder')}
      value={name}
      onChange={(e) => setName(e.target.value)}
    />
    <input
      className="input w-full"
      aria-label={t('sm.urlAria')}
      placeholder={t('sm.urlPlaceholder')}
      value={url}
      onChange={(e) => setUrl(e.target.value)}
    />
    <input
      className="input w-full"
      aria-label={t('sm.detailAria')}
      placeholder={t('sm.detailPlaceholder')}
      value={detail}
      onChange={(e) => setDetail(e.target.value)}
    />
      <label className="flex items-center gap-2 text-xs text-muted">
        <input
          type="checkbox"
          className="h-3.5 w-3.5 accent-pink-500"
          checked={isAdult}
          onChange={(e) => setIsAdult(e.target.checked)}
        />
        {t('sm.adultMark')}
      </label>
      <div className="flex gap-2 justify-end">
        <button className="btn-ghost btn-sm" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button className="btn-primary btn-sm" onClick={submit}>
          {initial ? t('sm.update') : t('sm.add')}
        </button>
      </div>
    </div>
  );
}
