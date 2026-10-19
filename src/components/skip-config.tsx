'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './icon';
import { useToast } from './toast';

/**
 * 跳过片头/片尾的就地设置器（播放页动作行里的一个按钮 + 小弹层）。
 *
 * 为什么是「固定秒数」而不是自动识别：国内采集站的片头曲与正片在同一条流里，
 * 没有可用的结构特征（时长、分片边界都不可靠），自动识别会误跳；
 * 片尾则不需要识别——总时长是确定的，「提前 N 秒」等价于播完。
 *
 * 值的归属：本弹层改的是「本剧」的配置（按 sourceKey + vodId 存在 IndexedDB），
 * 改一次全剧生效。全局默认值在「设置 → 播放与过滤」里，本剧没配过时用它。
 */
export function SkipConfigButton({
  introSec,
  outroSec,
  hasOverride,
  introDisabledHint,
  onApply,
  onReset,
}: {
  /** 当前实际生效的片头秒数（已含首集不跳等规则） */
  introSec: number;
  /** 当前实际生效的片尾秒数 */
  outroSec: number;
  /** 本剧是否已有自己的配置（决定要不要显示「恢复默认」） */
  hasOverride: boolean;
  /** 首集不跳片头的说明，传了才显示 */
  introDisabledHint?: string;
  onApply: (introSec: number, outroSec: number) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  // 向上弹：动作行永远贴在信息卡底部，弹层向下必定被视口切掉（1440x900 下按钮 y≈787，
  // 弹层要高 ~300px），所以打开时量一下下方空间，不够就翻到按钮上方
  const [up, setUp] = useState(false);
  const [draftIntro, setDraftIntro] = useState(String(introSec));
  const [draftOutro, setDraftOutro] = useState(String(outroSec));
  const wrapRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  // 每次打开都用最新生效值重置草稿：关掉再打开不该留着上次没提交的输入
  useEffect(() => {
    if (open) {
      setDraftIntro(String(introSec));
      setDraftOutro(String(outroSec));
    }
  }, [open, introSec, outroSec]);

  // 量完再画，避免先向下弹一下再跳上去的闪动
  useLayoutEffect(() => {
    if (!open) {
      setUp(false);
      return;
    }
    const btn = wrapRef.current?.getBoundingClientRect();
    const pop = popRef.current?.getBoundingClientRect();
    if (!btn || !pop) return;
    const gap = 8;
    const below = window.innerHeight - btn.bottom - gap;
    const above = btn.top - gap;
    setUp(below < pop.height && above > below);
  }, [open]);

  // 点外面关闭。用 pointerdown 而不是 click：否则点按钮本身会先关再开，闪一下
  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDocDown);
    return () => document.removeEventListener('pointerdown', onDocDown);
  }, [open]);

  const parse = (raw: string, max: number) => {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(n, max);
  };

  const apply = () => {
    const nextIntro = parse(draftIntro, 600);
    const nextOutro = parse(draftOutro, 600);
    onApply(nextIntro, nextOutro);
    setOpen(false);
    toast(
      nextIntro || nextOutro
        ? `本剧已应用：片头 ${nextIntro ? `${nextIntro}s` : '关'} · 片尾 ${nextOutro ? `${nextOutro}s` : '关'}`
        : '本剧已关闭跳过片头/片尾',
      'success'
    );
  };

  // 按钮文案要一眼看出「当前跳不跳、跳多少」
  const label =
    introSec > 0 || outroSec > 0
      ? `跳过 ${introSec > 0 ? `片头${introSec}s` : ''}${introSec > 0 && outroSec > 0 ? ' · ' : ''}${outroSec > 0 ? `片尾${outroSec}s` : ''}`
      : '跳过片头/片尾';

  return (
    <div className="g-skip" ref={wrapRef}>
      <button
        type="button"
        className={`g-act${introSec > 0 || outroSec > 0 ? ' on' : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="设置本剧要跳过的片头/片尾秒数（只存本地）"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="skip" className="w-3.5 h-3.5 shrink-0" />
        {label}
      </button>

      {open && (
        <div
          ref={popRef}
          className={up ? 'g-skip-pop up' : 'g-skip-pop'}
          role="dialog"
          aria-label="跳过片头片尾设置"
        >
          <div className="g-skip-row">
            <label htmlFor="g-skip-intro">跳过片头</label>
            <div className="g-skip-input">
              <input
                id="g-skip-intro"
                type="number"
                inputMode="numeric"
                min={0}
                max={600}
                step={5}
                value={draftIntro}
                onChange={(e) => setDraftIntro(e.target.value)}
              />
              <s>秒</s>
            </div>
          </div>
          <div className="g-skip-row">
            <label htmlFor="g-skip-outro">提前跳片尾</label>
            <div className="g-skip-input">
              <input
                id="g-skip-outro"
                type="number"
                inputMode="numeric"
                min={0}
                max={600}
                step={5}
                value={draftOutro}
                onChange={(e) => setDraftOutro(e.target.value)}
              />
              <s>秒</s>
            </div>
          </div>
          <p className="g-skip-tip">
            填 0 表示关闭。改动只保存在这台设备，应用到本剧全部剧集；想改所有剧的默认秒数，去「设置 →
            偏好设置 → 播放与过滤」。
          </p>
          {introDisabledHint && <p className="g-skip-tip">{introDisabledHint}</p>}
          <div className="g-skip-acts">
            {hasOverride && (
              <button
                type="button"
                className="g-skip-btn ghost"
                onClick={() => {
                  onReset();
                  setOpen(false);
                  toast('已恢复为默认设置', 'success');
                }}
              >
                恢复默认
              </button>
            )}
            <button type="button" className="g-skip-btn" onClick={apply}>
              应用到本剧
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
