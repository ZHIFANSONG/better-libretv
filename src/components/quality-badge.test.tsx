// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QualityBadge } from './quality-badge';

/**
 * 画质徽章是本项目唯一「把服务端探测结论翻译成用户可见文字」的组件，
 * 四种态（探测中 / 未知 / 未探到 / 有档位）文案完全不同，而搜索结果卡、
 * 详情弹窗、换源卡三处共用它 —— 一旦哪一态写错，三处同时错。
 */

afterEach(cleanup);

describe('QualityBadge', () => {
  it('探测中显示省略号与 aria-label', () => {
    render(<QualityBadge loading />);
    const el = screen.getByLabelText('正在探测画质');
    expect(el.textContent).toBe('…');
    expect(el.className).toContain('g-qb-idle');
  });

  it('尚未探测（没有 entry）时什么都不渲染', () => {
    const { container } = render(<QualityBadge />);
    expect(container.innerHTML).toBe('');
  });

  it('有宽度时按宽度判档：1920×752 是 1080P 且走高清配色', () => {
    render(<QualityBadge entry={{ from: 'play', width: 1920, height: 752, timestamp: 0 }} />);
    const el = screen.getByTitle('播放时实测的真实分辨率');
    expect(el.textContent).toBe('1080P');
    expect(el.className).toContain('g-qb-hd');
  });

  it('只有高度（BANDWIDTH 反推）时退回高度档位表', () => {
    render(<QualityBadge entry={{ from: 'probe', height: 1080, timestamp: 0 }} />);
    const el = screen.getByTitle('解析播放列表得到的档位');
    expect(el.textContent).toBe('1080P');
    expect(el.className).toContain('g-qb-hd');
  });

  it('探测失败与单码率是两种态，文案分开', () => {
    const { unmount } = render(
      <QualityBadge entry={{ from: 'probe', error: '源站超时', timestamp: 0 }} />
    );
    expect(screen.getByText('未探到')).toBeTruthy();
    expect(screen.getByTitle(/画质探测失败：源站超时/)).toBeTruthy();
    unmount();

    render(<QualityBadge entry={{ from: 'probe', timestamp: 0 }} />);
    expect(screen.getByText('未知')).toBeTruthy();
    expect(screen.getByTitle(/单码率或直链/)).toBeTruthy();
  });

  it('低分辨率走标清配色', () => {
    render(<QualityBadge entry={{ from: 'probe', width: 854, height: 480, timestamp: 0 }} />);
    expect(screen.getByText('480P').className).toContain('g-qb-sd');
  });
});
