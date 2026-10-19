/**
 * 清理旧版「片段本地缓存」残留。
 *
 * 该功能已整体移除（预取器把后续分片写进 Cache Storage 会让播放发烫卡顿），
 * 但它是纯浏览器侧存储，代码删掉并不会自动回收老用户机器上的数据：
 *   - Cache Storage 桶 `libretv-video-v1`（单集可堆到几百 MB）
 *   - localStorage 里的缓存偏好 `libretv-video-cache-settings`
 * 项目没有 service worker，也没有别的地方会去碰这两个键，因此在这里一次性抹掉。
 *
 * 只有「确实能碰到 Cache Storage 且删除成功」才写完成标记：
 * 明文 HTTP 下 caches 未定义（非安全上下文），此时若打标记，
 * 用户之后从 HTTPS 进来就再也不会清理了。
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

  let purged = false;
  if (typeof caches !== 'undefined') {
    try {
      await caches.delete(LEGACY_CACHE_NAME);
      purged = true;
    } catch {
      // 删除失败就留着标记位，下次进站再试
    }
  }

  try {
    window.localStorage.removeItem(LEGACY_SETTINGS_KEY);
    if (purged) window.localStorage.setItem(PURGED_FLAG, '1');
  } catch {
    // ignore
  }
}
