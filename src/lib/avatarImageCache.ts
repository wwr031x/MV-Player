// EXPORTS: avatarImageCache
/**
 * 网易云头像图片缓存
 * - 全局单例，避免每条弹幕/每条消息重复加载
 * - 加载失败/空 URL 自动降级为 null，调用方用首字/默认头像兜底
 */

type CacheEntry = {
  status: 'loading' | 'ready' | 'failed';
  image?: HTMLImageElement;
};

// 缓存上限：头像按会话内出现的用户有限，但仍加一道 LRU 兜底，避免长时间运行无界膨胀
const MAX_ENTRIES = 500;

class AvatarImageCache {
  private cache = new Map<string, CacheEntry>();

  /**
   * 同步获取已缓存的图片；未加载则触发异步加载并返回 null
   * 调用方在下一帧自然就能拿到（Canvas 每帧重绘）
   */
  get(url: string | undefined | null): HTMLImageElement | null {
    if (!url) return null;

    const existing = this.cache.get(url);
    if (existing) {
      // LRU：命中后挪到末尾，保证最久未用的排到队首被淘汰
      this.cache.delete(url);
      this.cache.set(url, existing);
      return existing.status === 'ready' && existing.image ? existing.image : null;
    }

    // 触发异步加载
    const entry: CacheEntry = { status: 'loading' };
    // 超过上限：淘汰最久未访问的队首条目（释放对 HTMLImageElement 的引用）
    if (this.cache.size >= MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(url, entry);

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      entry.status = 'ready';
      entry.image = img;
    };
    img.onerror = () => {
      entry.status = 'failed';
      entry.image = undefined;
    };
    img.src = url;

    return null;
  }

  /** 查询状态（用于调试） */
  getStatus(url: string): CacheEntry['status'] | 'none' {
    return this.cache.get(url)?.status ?? 'none';
  }

  /** 清空缓存（一般不需要，除非登出换号） */
  clear() {
    this.cache.clear();
  }
}

export const avatarImageCache = new AvatarImageCache();
