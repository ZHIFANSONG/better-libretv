/**
 * 清理旧版「片段本地缓存」残留。
 *
 * 该功能已整体移除（预取器把后续分片写进 Cache Storage 会让播放发烫卡顿），
 * 但它是纯浏览器侧存储，代码删掉并不会自动回收老用户机器上的数据：
 *   - Cache Storage 桶 `libretv-video-v1`（单集可堆到几百 MB）
 *   - localStorage 里的缓存偏好 `libretv-video-cache-settings`
 * 项目没有 service worker，也没有别的地方会去碰这两个键，因此在这里一次性抹掉。
 * 清理成功才写标记，避免某次失败后永久跳过。
 */

const LEGACY_CACHE_NAME = 'libretv-video-v1';
const LEGACY_SETTINGS_KEY = 'libretv-video-cache-settings';
const PURGED_FLAG = 'libretv-video-cache-purged';

export async function purgeLegacyVideoCache(): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    if (window.localStorage.getItem(PURGED_FLAG) === '1') return;
  } catch {
    // 隐私模式等场景 localStorage 不可用：照常尝试清理，只是记不住
  }

  try {
    if (typeof caches !== 'undefined') {
      await caches.delete(LEGACY_CACHE_NAME);
    }
  } catch {
    // Cache Storage 不可用（如非安全上下文）时跳过，不影响播放
  }

  try {
    window.localStorage.removeItem(LEGACY_SETTINGS_KEY);
    window.localStorage.setItem(PURGED_FLAG, '1');
  } catch {
    // ignore
  }
}
