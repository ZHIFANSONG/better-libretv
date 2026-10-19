/**
 * 下载相关设置的本地存储。
 *
 * 单独一个 key：与站点配置（libretv-settings）分开存，避免「恢复默认设置」
 * 之类的操作把用户的下载偏好一并重置。
 */

const SETTINGS_KEY = 'libretv-download-settings';

export interface DownloadSettings {
  /**
   * 经服务器中转下载：m3u8 与分片全部经 /api/proxy 转发，用于直连被 CORS /
   * 防盗链 / 混合内容拦下的源。开启后整集流量都会经过服务器，
   * 带宽成本由部署者承担，因此默认关闭、由用户显式开启。
   */
  proxy: boolean;
}

export const DEFAULT_DOWNLOAD_SETTINGS: DownloadSettings = { proxy: false };

export function normalizeDownloadSettings(input: unknown): DownloadSettings {
  const raw = (input ?? {}) as Partial<DownloadSettings>;
  return { proxy: raw.proxy === true };
}

export function loadDownloadSettings(): DownloadSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return normalizeDownloadSettings(raw ? JSON.parse(raw) : undefined);
  } catch {
    return { ...DEFAULT_DOWNLOAD_SETTINGS };
  }
}

export function saveDownloadSettings(next: Partial<DownloadSettings>): DownloadSettings {
  const merged = normalizeDownloadSettings({ ...loadDownloadSettings(), ...next });
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
  } catch {
    /* 隐私模式等场景忽略 */
  }
  return merged;
}
