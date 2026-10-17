'use client';

import { useAppStore } from '@/lib/store';
import { Dropdown } from './dropdown';

/**
 * 首页右侧「播放设置」抽屉（proposal 版）：只留首页真正用得上的两项 ——
 * 封面图加载方式、自动连播。推荐数据源已收进「设置 → 首页与内容过滤」：
 * 它跟「首页推荐」开关是同一件事，而且默认值由部署者的 DEFAULT_RECOMMEND_SOURCE 决定，
 * 摆在首页抽屉里既占地方又容易和设置里那一处对不上。
 */
export function PlaySettingsDrawer() {
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const autoplayNext = useAppStore((s) => s.autoplayNext);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const selectedKeys = useAppStore((s) => s.selectedKeys);
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const sourceHealth = useAppStore((s) => s.sourceHealth);

  const name = (key: string) =>
    customAPIs.find((a) => a.key === key)?.name ?? envSources.find((a) => a.key === key)?.name ?? key;

  const sick = selectedKeys.filter((k) => sourceHealth[k]?.ok === false).length;

  return (
    <aside
      className="g-drawer g-panel"
      glass="frosted"
      glass-blur="16"
      overlay=""
      aria-label="播放设置"
    >
      <h4>
        播放设置 <em>drawer</em>
      </h4>

      <div className="g-drow">
        <span>封面图</span>
        <Dropdown
          value={imageProxyMode}
          onChange={(v) => updateSettings({ imageProxyMode: v as typeof imageProxyMode })}
          ariaLabel="封面图加载方式"
          options={[
            { value: 'direct', label: '直连' },
            { value: 'proxy', label: '内置代理' },
            { value: 'custom', label: '自定义' },
          ]}
          className="w-[104px]"
        />
      </div>

      <div className="g-drow">
        <span>自动连播</span>
        <button
          type="button"
          className="g-chip"
          aria-pressed={autoplayNext}
          onClick={() => updateSettings({ autoplayNext: !autoplayNext })}
        >
          <i />
          {autoplayNext ? '开启' : '关闭'}
        </button>
      </div>

      <div className="g-drow g-drow-block">
        <span>启用中的源</span>
      </div>
      <div className="g-src">
        {selectedKeys.slice(0, 8).map((key) => {
          const h = sourceHealth[key];
          return (
            <span key={key} className={h?.ok === false ? '' : 'on'} title={h?.error || h?.ms ? `${h.ms ?? ''}ms` : ''}>
              {name(key)}
            </span>
          );
        })}
        {selectedKeys.length > 8 && <span>+{selectedKeys.length - 8}</span>}
        {selectedKeys.length === 0 && <span>未勾选</span>}
      </div>
      {sick > 0 && <p className="g-note">{sick} 个源近期无响应，可到「我的」里查看</p>}
      <p className="g-note">换推荐来源请到「设置 · 偏好设置 · 首页与内容」</p>
    </aside>
  );
}