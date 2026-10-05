// 新手引导状态管理（轻量纯函数，首屏也能直接用，不拖慢懒加载拆分）
import { scopedStorage } from '@lark-apaas/client-toolkit-lite';

function getGuideEndedKey(userId: string | number | null | undefined): string {
  const uid = userId ?? 'guest';
  return `onboarding_guide_ended_${uid}`;
}

/** 是否已结束/退出过引导（不再自动弹欢迎页） */
export function isGuideEnded(userId: string | number | null | undefined): boolean {
  try {
    return scopedStorage.getItem(getGuideEndedKey(userId)) === '1';
  } catch {
    return false;
  }
}

/** 标记引导已结束 */
export function markGuideEnded(userId: string | number | null | undefined) {
  try {
    scopedStorage.setItem(getGuideEndedKey(userId), '1');
  } catch {
    /* ignore */
  }
}

/** 重置指定用户的全部新手引导标记 */
export function resetOnboardingAllForUser(userId: string | number | null | undefined) {
  const uid = userId ?? 'guest';
  try {
    scopedStorage.removeItem(getGuideEndedKey(uid));
    scopedStorage.removeItem(`onboarding_portrait_done_${uid}`);
    scopedStorage.removeItem(`onboarding_landscape_done_${uid}`);
    scopedStorage.removeItem(`onboarding_done_${uid}`);
  } catch {
    /* ignore */
  }
}
