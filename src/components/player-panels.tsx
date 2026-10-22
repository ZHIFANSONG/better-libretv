'use client';

import type { ChangeEvent, RefObject } from 'react';

import type { StatsGroup } from '@/lib/playback-stats';
import type { SubtitleOption } from '@/lib/subtitle';

/**
 * 播放器右上角的两个浮层面板（视频信息 / 字幕）。
 *
 * 抽出来的原因：它们都是「纯展示 + 几个回调」，没有任何播放器内部状态，
 * 留在 player-shell 里只会让那个文件继续膨胀。面板本身仍然由调用方用
 * createPortal 挂到 art.template.$player 上（坐标系在那边，见调用处注释）。
 *
 * 两块的样式类名共用一个体系（.g-vstats / .g-vstats-head / .g-vstats-body），
 * 字幕面板额外带 .g-subpanel。
 */

export type PanelTranslator = (key: string, vars?: Record<string, string | number>) => string;

export interface StatsPanelProps {
  rows: StatsGroup[];
  copied: boolean;
  tt: PanelTranslator;
  onCopy: () => void;
  onClose: () => void;
}

export function StatsPanel({ rows, copied, tt, onCopy, onClose }: StatsPanelProps) {
  return (
    <div className="g-vstats" role="dialog" aria-label={tt('player.statsPanel')}>
      <div className="g-vstats-head">
        <strong>{tt('player.statsPanel')}</strong>
        <button type="button" className="g-vstats-copy" onClick={onCopy}>
          {copied ? tt('player.statsCopied') : tt('player.statsCopy')}
        </button>
        <button type="button" className="g-vstats-x" aria-label={tt('common.close')} onClick={onClose}>
          ×
        </button>
      </div>
      <div className="g-vstats-body">
        {rows.length === 0 ? (
          <p className="g-vstats-empty">{tt('player.statsEmpty')}</p>
        ) : (
          rows.map((group) => (
            <div className="g-vstats-group" key={group.title}>
              <span className="g-vstats-gtitle">{group.title}</span>
              {group.rows.map((row) => (
                <div className={row.warn ? 'g-vstats-row warn' : 'g-vstats-row'} key={row.label}>
                  <span className="g-vstats-k">{row.label}</span>
                  <span className="g-vstats-v">
                    {row.value}
                    {row.hint && <em>{row.hint}</em>}
                  </span>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export interface SubtitlePanelProps {
  options: SubtitleOption[];
  note: string;
  tt: PanelTranslator;
  inputRef: RefObject<HTMLInputElement | null>;
  onPick: (id: string) => void;
  onLoadLocal: (file: File) => void;
  onClose: () => void;
}

export function SubtitlePanel({ options, note, tt, inputRef, onPick, onLoadLocal, onClose }: SubtitlePanelProps) {
  const anyActive = options.some((o) => o.active);
  return (
    <div className="g-vstats g-subpanel" role="dialog" aria-label={tt('player.subtitle')}>
      <div className="g-vstats-head">
        <strong>{tt('player.subtitle')}</strong>
        <button
          type="button"
          className="g-vstats-copy"
          onClick={() => {
            onClose();
            inputRef.current?.click();
          }}
        >
          {tt('player.subtitleLoad')}
        </button>
        <button type="button" className="g-vstats-x" aria-label={tt('common.close')} onClick={onClose}>
          ×
        </button>
      </div>
      <div className="g-vstats-body">
        {note && <p className="g-vstats-empty">{note}</p>}
        <div className="g-sub-list">
          <button type="button" className={anyActive ? 'g-sub-item' : 'g-sub-item on'} onClick={() => onPick('off')}>
            {tt('player.subtitleOff')}
            {!anyActive && <em>{tt('player.current')}</em>}
          </button>
          {options.map((option) => (
            <button
              type="button"
              key={option.id}
              className={option.active ? 'g-sub-item on' : 'g-sub-item'}
              onClick={() => onPick(option.id)}
            >
              {option.label}
              {option.lang && <em>{option.lang}</em>}
              {option.active && <em>{tt('player.current')}</em>}
            </button>
          ))}
        </div>
      </div>
      {/*
        文件选择框放在面板里（display:none），点「载入本地字幕」触发。
        accept 只列 .srt/.vtt：其它格式转不了，让用户在文件对话框里就被挡住比读到一半才报错好。
      */}
      <input
        ref={inputRef}
        type="file"
        accept=".srt,.vtt,text/vtt,application/x-subrip"
        style={{ display: 'none' }}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) onLoadLocal(file);
        }}
      />
    </div>
  );
}
