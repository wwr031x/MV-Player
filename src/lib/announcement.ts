// 公告工具函数（纯函数，首屏可直接 import 不阻塞懒加载）
import { ANNOUNCEMENTS } from '@/announcements/announcements';
import type { Announcement } from '@/announcements/announcements';
import { scopedStorage } from '@lark-apaas/client-toolkit-lite';

const LAST_READ_KEY = 'announcement_last_read_id';

/** 读取最后已读公告 id */
function getLastReadId(): string | number | null {
  try {
    const v = scopedStorage.getItem(LAST_READ_KEY);
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
  } catch {
    return null;
  }
}

/** 获取最新公告 */
export function getLatestAnnouncement(): Announcement | null {
  if (!ANNOUNCEMENTS || ANNOUNCEMENTS.length === 0) return null;
  return ANNOUNCEMENTS[0] ?? null;
}

/** 是否有未读的最新公告 */
export function hasUnreadAnnouncement(): boolean {
  const latest = getLatestAnnouncement();
  if (!latest) return false;
  const lastRead = getLastReadId();
  if (lastRead === null) return true;
  return String(lastRead) !== String(latest.id);
}

/** 标记指定公告 id 已读 */
export function markAnnouncementRead(id: string | number) {
  try {
    scopedStorage.setItem(LAST_READ_KEY, String(id));
  } catch {
    /* ignore */
  }
}
