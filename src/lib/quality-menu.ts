import { qualityLabel } from './quality';

/**
 * 控制栏右上角的画质菜单（纯 DOM 实现）。
 *
 * 为什么不用 Artplayer 的 setting 面板：那是「设置 > 二级面板」，看画质要点两下，
 * 而画质是播放时最常切的东西；也不用 art.quality —— 它靠换 URL 切档，
 * 对同一条 master playlist 只会重新 loadSource，等于重开一集（进度、缓冲全丢）。
 * 这里直接写 hls.currentLevel，在同一个 MediaSource 内切档，画面不断。
 *
 * 从 player-shell.tsx 抽出来的原因：这段逻辑是「读 hls 状态 → 画一棵游离 DOM」，
 * 与 React 状态无关，混在播放器组件里只会把 1700 行的文件再撑大。抽出来之后
 * 组件只负责提供 getter（hls / video / 挂载点）和两个回调（翻译、提示）。
 */

/** 只用到 hls.js 的这几个字段，用结构化类型避免把整个 Hls 类型引进 lib */
export interface QualityMenuLevel {
  height?: number;
  width?: number;
  bitrate?: number;
}

export interface QualityMenuHls {
  levels?: QualityMenuLevel[];
  /** -1 才是「自动」；currentLevel 只是当前在播档位，两者不能混用 */
  manualLevel?: number;
  currentLevel?: number;
  nextLevel?: number;
}

export interface QualityMenuState {
  root: HTMLDivElement;
  button: HTMLButtonElement;
  list: HTMLDivElement;
  key: string;
}

export type QualityMenuTranslator = (key: string, vars?: Record<string, string | number>) => string;

export interface QualityMenuContext {
  /** 当前菜单节点（null = 还没建或已销毁） */
  getMenu: () => QualityMenuState | null;
  setMenu: (menu: QualityMenuState | null) => void;
  getDocHandler: () => ((e: MouseEvent) => void) | null;
  setDocHandler: (handler: ((e: MouseEvent) => void) | null) => void;
  /** 菜单的挂载点：art.template.$player */
  getPlayerEl: () => HTMLElement | undefined;
  getHls: () => QualityMenuHls | null;
  getVideo: () => HTMLVideoElement | undefined;
  tt: QualityMenuTranslator;
  showHint: (text: string) => void;
}

/** 收起下拉（节点保留，下次展开复用） */
export function closeQualityMenu(ctx: QualityMenuContext): void {
  const menu = ctx.getMenu();
  if (!menu) return;
  menu.list.style.display = 'none';
  menu.root.classList.remove('open');
}

/**
 * 重画整个菜单：档位表、按钮文案、下拉项。
 *
 * 幂等——key 没变且节点还在就原地返回，所以可以在 MANIFEST_PARSED / LEVEL_SWITCHED /
 * LEVEL_LOADED 上无脑多调几次，不会造成 DOM 抖动。
 */
export function refreshQualityMenu(ctx: QualityMenuContext): void {
  const hls = ctx.getHls();
  const $player = ctx.getPlayerEl();
  const video = ctx.getVideo();
  if (!hls || !$player) return;

  const tt = ctx.tt;
  // 单码率源的清单里没写 RESOLUTION，level.width / level.height 都是 0，
  // 此时按 level 下标降级显示，而不是编一个「0P」出来
  const levels = hls.levels ?? [];
  const options = levels.map((level, index) => {
    const label = qualityLabel(level.height, level.width);
    return {
      index,
      label: label || tt('player.qualityLevel', { n: index + 1 }),
      bitrate: level.bitrate,
    };
  });

  // 清单还没解析出档位时（hls 刚创建）不留空胶囊，等 MANIFEST_PARSED 再来
  if (options.length === 0) {
    const stale = ctx.getMenu();
    if (stale) {
      stale.root.remove();
      ctx.setMenu(null);
    }
    return;
  }

  const manual = hls.manualLevel ?? -1;
  const currentLevel = hls.currentLevel ?? -1;
  // 解码后的真实分辨率：单码率源的清单里没有档位，这是唯一可信的画质来源。
  // 判档以宽度为准（1920×752 是 1080P 而不是 720P），所以 width 一定要带上。
  const playing = video?.videoHeight ?? 0;
  const playingWidth = video?.videoWidth ?? 0;
  const playingLabel = qualityLabel(playing, playingWidth) || (playing > 0 ? `${playing}P` : '');
  /*
   * 档位数 < 2 不再把整个菜单摘掉。
   *
   * 采集站几乎全是单码率（一部片一条 m3u8），按「没得选就别显示」的做法，
   * 真实内容上这个胶囊永远不会出现——用户的原话就是「现在的播放完全不知道是什么画质」。
   * 所以拆成两种形态：多档 = 可切的下拉；单档 = 只读胶囊，把实测档位直接写在脸上，
   * 点一下说明为什么切不了（而不是给一个点不动的灰按钮）。
   */
  const single = options.length < 2;
  const labels = options.map((o) => o.label).join(',');
  const key = single
    ? `single|${playing}|${playingWidth}|${labels}`
    : `${manual}|${currentLevel}|${playing}|${playingWidth}|${labels}`;
  let menu = ctx.getMenu();
  if (menu && menu.key === key && menu.root.isConnected) return;

  if (!menu) {
    const root = document.createElement('div');
    root.className = 'g-qmenu';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'g-qmenu-btn';
    const list = document.createElement('div');
    list.className = 'g-qmenu-list';
    list.style.display = 'none';
    /*
     * 控制栏点击会冒泡到播放器画面，触发 Artplayer 的「点画面暂停/播放」。
     * 这里统一拦掉，否则点一下「画质」就把视频暂停了。
     */
    const swallow = (e: Event) => e.stopPropagation();
    root.addEventListener('click', swallow);
    root.addEventListener('mousedown', swallow);
    root.addEventListener('dblclick', swallow);

    button.addEventListener('click', (e) => {
      e.stopPropagation();
      // 单档源（采集站常态）没有可切的东西：点一下给个解释，比弹出一个只有一项的列表实在
      if (root.classList.contains('single')) {
        ctx.showHint(ctx.tt('player.qualitySingleOnly', { label: button.textContent ?? '' }));
        return;
      }
      const open = list.style.display !== 'none';
      if (open) {
        closeQualityMenu(ctx);
      } else {
        list.style.display = '';
        root.classList.add('open');
      }
    });
    // 点面板外收起。监听挂在 document 上，destroy 时摘掉
    const onDocClick = (e: MouseEvent) => {
      if (!root.contains(e.target as Node)) closeQualityMenu(ctx);
    };
    ctx.setDocHandler(onDocClick);
    document.addEventListener('click', onDocClick);

    root.appendChild(button);
    root.appendChild(list);
    $player.appendChild(root);
    menu = { root, button, list, key: '' };
    ctx.setMenu(menu);
  }

  const node = menu;
  node.key = key;
  // 按钮上直接写当前画质：正常情况下用户不需要展开菜单就已经知道自己在看几 P
  const active = manual >= 0 ? options.find((o) => o.index === manual) : undefined;
  const headline =
    (single ? playingLabel : active?.label ?? playingLabel) ||
    (single ? options[0]?.label : '') ||
    '';
  node.root.classList.toggle('single', single);
  node.button.textContent = single
    ? headline || tt('player.qualityUnknown')
    : manual < 0
      ? `${tt('player.qualityAuto')}${headline ? ` · ${headline}` : ''}`
      : headline || tt('player.quality');
  node.button.title = single ? tt('player.qualitySingleTip') : tt('player.qualitySwitchTip');
  // 单档时不展开下拉：列表里只有一个和按钮重复的档位，点开纯属浪费一次点击
  if (single) {
    node.list.textContent = '';
    node.list.style.display = 'none';
    node.root.classList.remove('open');
    node.list.style.pointerEvents = 'none';
    return;
  }
  node.list.style.pointerEvents = '';

  node.list.textContent = '';
  const makeItem = (label: string, isActive: boolean, onPick: () => void, hint?: string) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = isActive ? 'g-qmenu-item on' : 'g-qmenu-item';
    item.textContent = label;
    if (hint) {
      const em = document.createElement('em');
      em.textContent = hint;
      item.appendChild(em);
    }
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      onPick();
      closeQualityMenu(ctx);
    });
    node.list.appendChild(item);
  };

  makeItem(tt('player.qualityAuto'), manual < 0, () => {
    const self = ctx.getHls();
    if (!self) return;
    // 回到自动之前先放开手动限制，否则 hls 会继续锁在 currentLevel 上
    self.currentLevel = -1;
    self.nextLevel = -1;
    refreshQualityMenu(ctx);
  });
  options.forEach((o) => {
    makeItem(o.label, manual === o.index, () => {
      const self = ctx.getHls();
      if (!self) return;
      self.currentLevel = o.index;
      ctx.showHint(ctx.tt('player.qualitySwitched', { label: o.label }));
      refreshQualityMenu(ctx);
    });
  });
}

/**
 * 卸载时把塞进播放器 DOM 的节点和 document 监听全摘干净，
 * 否则会残留到下一集 / 下一次重建播放器。
 */
export function destroyQualityMenu(ctx: QualityMenuContext): void {
  const handler = ctx.getDocHandler();
  if (handler) {
    document.removeEventListener('click', handler);
    ctx.setDocHandler(null);
  }
  ctx.getMenu()?.root.remove();
  ctx.setMenu(null);
}
