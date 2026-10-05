// 一起听本地用户信息管理
// 纯 localStorage 操作，不依赖任何网络连接/第三方库。
// 独立成文件是为了 adapter 顶层 re-export 时不引入 WS/Supabase 等大模块。

import { scopedStorage } from '@lark-apaas/client-toolkit-lite';
import type { IListenTogetherUser } from './listenTogether.ws';

const UID_KEY = 'audioviz_uid';
const NICKNAME_KEY = 'audioviz_nickname';
const AVATAR_KEY = 'audioviz_avatar_seed';

export function getLocalUser(): IListenTogetherUser {
  let uid: string | null = null;
  try {
    uid = scopedStorage.getItem(UID_KEY);
  } catch { /* storage 不可用时兜底 */ }

  if (!uid) {
    uid = 'uid_' + Math.random().toString(36).slice(2, 10);
    try {
      scopedStorage.setItem(UID_KEY, uid);
    } catch { /* ignore */ }
  }

  let nickname = '';
  let avatarSeed = '';
  try {
    nickname = scopedStorage.getItem(NICKNAME_KEY) || '听众_' + uid.slice(-4);
    avatarSeed = scopedStorage.getItem(AVATAR_KEY) || uid;
  } catch {
    nickname = '听众_' + uid.slice(-4);
    avatarSeed = uid;
  }

  return { uid, nickname, avatarSeed };
}

export function updateLocalUser(patch: Partial<Pick<IListenTogetherUser, 'nickname' | 'avatarSeed'>>) {
  try {
    if (patch.nickname !== undefined) {
      scopedStorage.setItem(NICKNAME_KEY, patch.nickname);
    }
    if (patch.avatarSeed !== undefined) {
      scopedStorage.setItem(AVATAR_KEY, patch.avatarSeed);
    }
  } catch { /* ignore storage errors */ }
}
