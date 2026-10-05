/**
 * 新手引导教程组件（Robust 版）
 * - 高亮遮罩 + 分步气泡，覆盖核心功能
 * - 智能翻转 + 硬夹取，气泡 100% 在视口内
 * - ResizeObserver 实测气泡尺寸，再定位（先测量、后定位、渲染前就位）
 * - 底部独立"操作条"始终夹在视口内，任何情况下按钮都能点到
 * - 小三角指向高亮目标（若翻转则自动换位）
 * - 每步可"下一步 / 跳过"，最后一步"完成 / 跳过"
 * - 按用户 UID 标记已完成（本地存储，每个账号首次登录自动播放一次）
 * - 设置面板中可随时重新激活
 *
 * 目标元素通过 data-tour="xxx" 属性定位。
 */

import { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react';
import { X, ChevronRight, HelpCircle, SkipForward } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { scopedStorage } from '@lark-apaas/client-toolkit-lite';

// ============== 步骤定义 ==============

export interface TourStep {
  /** 单个目标 key 或多个 key（多个时取并集整体高亮，如进度条 + 拖球） */
  targetKey: string | string[];
  title: string;
  description: string;
  placement?: 'top' | 'bottom' | 'left' | 'right';
  padding?: number;
  /**
   * 进入该步前触发（用于切换界面状态、展开面板/控制栏等）。
   * 可返回 Promise，教程会等待 resolve 后再测量目标 rect。
   */
  beforeEnter?: () => void | Promise<void>;
  /** 目标不可见时是否退化为居中提示（不渲染细线/小条），默认 true */
  fallbackToCenter?: boolean;
  /** 目标最小有效宽度（低于此值视为无效目标），默认 24 */
  minValidWidth?: number;
  /** 目标最小有效高度（低于此值视为无效目标），默认 4 */
  minValidHeight?: number;
}

// —— 竖屏教程（仅竖屏可见元素）——
const PORTRAIT_STEPS: TourStep[] = [
  {
    targetKey: 'login',
    title: '登录网易云音乐',
    description: '点击右上角头像按钮，使用网易云音乐扫码登录，即可加载你的歌单与喜欢的音乐。',
    placement: 'bottom',
  },
  {
    targetKey: 'play',
    title: '播放 / 暂停',
    description: '点击底部中央按钮播放或暂停当前曲目。',
    placement: 'top',
  },
  {
    targetKey: ['seekbar-track', 'seekbar-thumb'],
    title: '进度条拖动',
    description: '拖动进度条可以跳转播放位置，左右滑动精确控制。',
    placement: 'top',
    padding: 4,
  },
  {
    targetKey: 'cover-area',
    title: '封面拖动 & 双击回正',
    description: '专辑封面模式下可用手指拖动旋转视角，双击画面即可回到初始视角。',
    placement: 'bottom',
  },
  {
    targetKey: 'settings',
    title: '设置面板',
    description: '底部右侧齿轮按钮打开设置面板，可切换可视化模式、调节颜色、封面粒子、歌词、录制质量等。',
    placement: 'top',
  },
  {
    targetKey: 'record',
    title: '录制导出',
    description: '顶部红色圆点按钮可开始 / 停止录制，导出视频分享给朋友。',
    placement: 'bottom',
  },
  {
    targetKey: 'listen-together',
    title: '一起听',
    description: '点击底部双人图标打开一起听面板，可以邀请好友跨设备实时同步听歌。',
    placement: 'top',
  },
  {
    targetKey: 'lt-uid',
    title: '我的 UID',
    description: '这里是你的专属 UID，点击复制按钮发给朋友，对方输入后就能和你一起听。',
    placement: 'bottom',
    padding: 6,
  },
  {
    targetKey: 'lt-invite',
    title: '发起邀请',
    description: '输入对方 UID 点击呼叫即可发起邀请；也可以创建房间等待对方呼入。房间内播放、切歌、进度都会实时同步。',
    placement: 'bottom',
    padding: 6,
  },
];
const LANDSCAPE_STEPS: TourStep[] = [
  {
    targetKey: 'mode-switch',
    title: '左侧模式切换控制台',
    description: '横屏沉浸态下左侧提供 2D / 3D / 封面等多种可视化模式一键切换。',
    placement: 'right',
  },
  {
    targetKey: 'side-tools',
    title: '右侧液态玻璃小工具',
    description: '横屏沉浸态下右侧提供频谱、电平、波形、BPM 等小工具，随音乐实时变化。',
    placement: 'left',
  },
  {
    targetKey: 'side-tools-close-btn',
    title: '收起小工具面板',
    description: '点击面板左上角的 × 按钮可以收起小工具面板，让画面更干净。',
    placement: 'left',
    padding: 6,
    minValidWidth: 24,
    minValidHeight: 24,
  },
  {
    targetKey: 'side-tools-collapse',
    title: '双击边缘重新呼出',
    description: '收起后屏幕右边缘会出现一个半透明小竖条，双击它即可重新打开小工具面板。',
    placement: 'left',
    padding: 8,
    minValidWidth: 8,
    minValidHeight: 64,
  },
  {
    targetKey: 'cover-area',
    title: '封面拖动 & 双击回正',
    description: '3D 模式下可拖动旋转视角，双击画面回到初始视角。',
    placement: 'bottom',
  },
  {
    targetKey: ['seekbar-track', 'seekbar-thumb'],
    title: '进度条拖动',
    description: '拖动进度条可以跳转播放位置。',
    placement: 'top',
    padding: 4,
  },
  {
    targetKey: 'play',
    title: '播放 / 暂停',
    description: '点击底部中央按钮播放或暂停当前曲目。',
    placement: 'top',
  },
  {
    targetKey: 'settings',
    title: '设置面板',
    description: '底部右侧齿轮按钮打开设置面板，可调节颜色、粒子、歌词、录制等。',
    placement: 'top',
  },
  {
    targetKey: 'record',
    title: '录制导出',
    description: '顶部红色圆点按钮可开始 / 停止录制，导出视频分享给朋友。',
    placement: 'bottom',
  },
  {
    targetKey: 'listen-together',
    title: '一起听',
    description: '点击底部双人图标打开一起听面板，邀请好友跨设备实时同步听歌。',
    placement: 'top',
  },
  {
    targetKey: 'lt-uid',
    title: '我的 UID',
    description: '这里是你的专属 UID，点击复制按钮发给朋友，对方输入后就能和你一起听。',
    placement: 'bottom',
    padding: 6,
  },
  {
    targetKey: 'lt-invite',
    title: '发起邀请 / 创建房间',
    description: '输入对方 UID 点击呼叫即可发起邀请；也可以创建房间等待对方呼入。房间内播放、切歌、进度都会实时同步。',
    placement: 'bottom',
    padding: 6,
  },
];

/** 根据朝向返回对应步骤列表 */
export function getStepsForOrientation(isLandscape: boolean): TourStep[] {
  return isLandscape ? LANDSCAPE_STEPS : PORTRAIT_STEPS;
}

export { PORTRAIT_STEPS, LANDSCAPE_STEPS };

// ============== 存储工具 ==============
function getStorageKey(
  userId: string | number | null | undefined,
  isLandscape: boolean,
) {
  const uid = userId ?? 'guest';
  const suffix = isLandscape ? 'landscape' : 'portrait';
  return `onboarding_${suffix}_done_${uid}`;
}

export function isOnboardingDone(
  userId: string | number | null | undefined,
  isLandscape = false,
): boolean {
  try {
    return scopedStorage.getItem(getStorageKey(userId, isLandscape)) === '1';
  } catch {
    return false;
  }
}

export function markOnboardingDone(
  userId: string | number | null | undefined,
  isLandscape = false,
) {
  try {
    scopedStorage.setItem(getStorageKey(userId, isLandscape), '1');
  } catch {
    /* ignore */
  }
}

/** 兼容旧标记：若旧版 onboarding_done_<uid> 存在，则两套都视为已完成（避免用户被打扰两次） */
export function isLegacyOnboardingDone(userId: string | number | null | undefined): boolean {
  try {
    return scopedStorage.getItem(`onboarding_done_${userId ?? 'guest'}`) === '1';
  } catch {
    return false;
  }
}

/**
 * 重置指定用户的全部新手引导标记
 * - 清除 onboarding_portrait_done_<uid>
 * - 清除 onboarding_landscape_done_<uid>
 * - 清除旧版 onboarding_done_<uid>
 * 不影响 onboarding_guide_ended_<uid>（由向导层自己管理）
 */
export function resetOnboardingForUser(userId: string | number | null | undefined) {
  const uid = userId ?? 'guest';
  try {
    scopedStorage.removeItem(`onboarding_portrait_done_${uid}`);
    scopedStorage.removeItem(`onboarding_landscape_done_${uid}`);
    scopedStorage.removeItem(`onboarding_done_${uid}`);
  } catch {
    /* ignore */
  }
}

// ============== 常量 ==============
const PADDING = 16;          // 视口内边距
const GAP = 10;              // 气泡与高亮框间距
const ACTION_BAR_H = 56;     // 底部操作条高度
const ACTION_BAR_MARGIN = 12;

/** 读取视口安全区（顶部状态栏 + 底部手势条），教程气泡/操作条避让 */
function getSafeAreaInsets(): { top: number; bottom: number; left: number; right: number } {
  if (typeof document === 'undefined') {
    return { top: 0, bottom: 0, left: 0, right: 0 };
  }
  try {
    const cs = getComputedStyle(document.documentElement);
    const parsePx = (v: string) => {
      const n = parseFloat(v);
      return isNaN(n) ? 0 : n;
    };
    return {
      top: parsePx(cs.getPropertyValue('--sat') || getComputedStyle(document.body).getPropertyValue('--sat')) || 0,
      bottom: parsePx(cs.getPropertyValue('--sab') || getComputedStyle(document.body).getPropertyValue('--sab')) || 0,
      left: parsePx(cs.getPropertyValue('--sal') || getComputedStyle(document.body).getPropertyValue('--sal')) || 0,
      right: parsePx(cs.getPropertyValue('--sar') || getComputedStyle(document.body).getPropertyValue('--sar')) || 0,
    };
  } catch {
    return { top: 0, bottom: 0, left: 0, right: 0 };
  }
}

// ============== 主组件 ==============
export interface OnboardingTourProps {
  open: boolean;
  onClose: () => void;
  userId?: string | number | null;
  steps?: TourStep[];
  /** 当前是否横屏（不传则内部监听 window 尺寸） */
  isLandscape?: boolean;
  /**
   * 朝向变化时是否自动关闭当前教程（避免错位 / 出现对面朝向的步骤）。
   * 传 true 时内部监听 resize / orientationchange，检测到朝向变化则调用 onClose。
   */
  autoCloseOnOrientationChange?: boolean;
  /** 朝向变化时的回调（父级可据此重新打开对应朝向的那套） */
  onOrientationChange?: (isLandscape: boolean) => void;
  /**
   * 目标元素不可用时回调（元素不存在 / 被遮挡）。
   * 父级可据此关闭教程（如用户打开了设置面板等）。
   */
  onTargetUnavailable?: () => void;
  /** 步骤变化时回调（第 0 步也会触发一次），传回当前 step 和 index */
  onStepChange?: (step: TourStep, index: number) => void;
}

export default function OnboardingTour({
  open,
  onClose,
  userId,
  steps,
  isLandscape: isLandscapeProp,
  autoCloseOnOrientationChange = false,
  onOrientationChange,
  onTargetUnavailable,
  onStepChange,
}: OnboardingTourProps) {
  // 内部朝向（props 优先，否则监听 window）
  const [innerLandscape, setInnerLandscape] = useState(() => window.innerWidth > window.innerHeight);
  const isLandscape = isLandscapeProp ?? innerLandscape;

  // 使用传入 steps 或按朝向自动选（传入优先，便于测试）
  const effectiveSteps = steps ?? getStepsForOrientation(isLandscape);

  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [safeArea, setSafeArea] = useState(() => getSafeAreaInsets());
  const [bubbleSize, setBubbleSize] = useState({ w: 0, h: 0 });
  const rafRef = useRef<number | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const lastLandscapeRef = useRef(isLandscape);
  const targetAvailableRef = useRef(false);

  const step = effectiveSteps[index];
  const isLast = index === effectiveSteps.length - 1;

  // 打开时回到第 0 步
  useEffect(() => {
    if (open) setIndex(0);
  }, [open]);

  // 打开时重置目标可用状态
  useEffect(() => {
    if (open) targetAvailableRef.current = false;
  }, [open, index]);
  useEffect(() => {
    setIndex(0);
  }, [isLandscape]);

  // 步骤变化时通知父级
  useEffect(() => {
    if (!open || !step) return;
    onStepChange?.(step, index);
  }, [open, index, step, onStepChange]);

  // 每步切换时调用 beforeEnter（用于切换界面状态、准备目标元素）
  // beforeEnter 可能是异步的，等待 resolve 后目标应有非零尺寸
  const beforeEnterPendingRef = useRef(false);
  useEffect(() => {
    if (!open || !step) return;
    if (beforeEnterPendingRef.current) return;
    const fn = step.beforeEnter;
    if (!fn) return;
    beforeEnterPendingRef.current = true;
    Promise.resolve(fn()).finally(() => {
      beforeEnterPendingRef.current = false;
    });
  }, [open, index, step]);

  // 窗口大小 / 横竖屏变化
  useEffect(() => {
    if (!open) return;
    const onResize = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      setViewport({ w, h });
      setSafeArea(getSafeAreaInsets());
      if (isLandscapeProp === undefined) {
        const nextLandscape = w > h;
        setInnerLandscape(nextLandscape);
      }
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, [open, isLandscapeProp]);

  // 朝向变化回调：通知父级 + 可选自动关闭（避免错位步骤）
  useEffect(() => {
    if (!open) {
      lastLandscapeRef.current = isLandscape;
      return;
    }
    if (lastLandscapeRef.current !== isLandscape) {
      lastLandscapeRef.current = isLandscape;
      onOrientationChange?.(isLandscape);
      if (autoCloseOnOrientationChange) {
        onClose();
      }
    }
  }, [isLandscape, open, autoCloseOnOrientationChange, onClose, onOrientationChange]);

  // 每帧更新高亮 rect（目标元素可能在动画中移动）
  // 支持 targetKey 为数组：取并集 → 整体高亮（如进度条轨道 + 拖球，避免分离歪框）
  useEffect(() => {
    if (!open || !step) return;
    const tick = () => {
      const keys = Array.isArray(step.targetKey) ? step.targetKey : [step.targetKey];
      const rects: DOMRect[] = [];
      for (const k of keys) {
        const el = document.querySelector<HTMLElement>(`[data-tour="${k}"]`);
        if (el) rects.push(el.getBoundingClientRect());
      }

      if (rects.length > 0) {
        // 并集 rect：覆盖所有目标元素
        const minX = Math.min(...rects.map((r) => r.left));
        const minY = Math.min(...rects.map((r) => r.top));
        const maxX = Math.max(...rects.map((r) => r.right));
        const maxY = Math.max(...rects.map((r) => r.bottom));
        const rawW = maxX - minX;
        const rawH = maxY - minY;
        const pad = step.padding ?? 6;
        const minW = step.minValidWidth ?? 24;
        const minH = step.minValidHeight ?? 4;
        const fallback = step.fallbackToCenter !== false;

        // 有效性校验：宽/高任一低于阈值 → 视为无效目标，退化居中
        // （避免出现细线 / 小条 / 被裁切的高亮）
        const isValid = rawW >= minW && rawH >= minH;

        if (isValid || !fallback) {
          setRect({
            x: Math.max(0, minX - pad),
            y: Math.max(0, minY - pad),
            w: Math.min(viewport.w, maxX - minX + pad * 2),
            h: Math.min(viewport.h, maxY - minY + pad * 2),
          });
          targetAvailableRef.current = true;
        } else {
          // 退化：居中通用提示，不画高亮框（用隐藏的极小占位）
          const w = Math.min(320, viewport.w - PADDING * 2);
          const h = 60;
          setRect({
            x: (viewport.w - w) / 2,
            y: (viewport.h - h) / 2,
            w, h,
          });
          if (targetAvailableRef.current) {
            targetAvailableRef.current = false;
            onTargetUnavailable?.();
          }
        }
      } else {
        // 目标不存在时：屏幕中央放一个默认占位
        const w = Math.min(320, viewport.w - PADDING * 2);
        const h = 60;
        setRect({
          x: (viewport.w - w) / 2,
          y: (viewport.h - h) / 2,
          w, h,
        });
        // 目标不可用 → 通知父级（只触发一次，避免每帧重复）
        if (targetAvailableRef.current) {
          targetAvailableRef.current = false;
          onTargetUnavailable?.();
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [open, step, viewport.w, viewport.h]);

  // ResizeObserver 实测气泡尺寸
  useLayoutEffect(() => {
    if (!open) return;
    const el = bubbleRef.current;
    if (!el) return;

    const measure = () => {
      const r = el.getBoundingClientRect();
      setBubbleSize({ w: r.width, h: r.height });
    };
    measure();

    roRef.current = new ResizeObserver(measure);
    roRef.current.observe(el);
    return () => {
      roRef.current?.disconnect();
      roRef.current = null;
    };
  }, [open, index, viewport.w, viewport.h, isLandscape]);

  // ===== 气泡位置计算（先测量、后定位、智能翻转 + 硬夹取） =====
  const bubblePos = (() => {
    if (!rect) {
      return {
        left: (viewport.w - Math.min(320, viewport.w - PADDING * 2)) / 2,
        top: viewport.h / 2,
        finalPlacement: 'bottom' as const,
        arrowOffset: 0,
      };
    }
    const bw = bubbleSize.w || Math.min(320, viewport.w - PADDING * 2);
    const bh = bubbleSize.h || 160;
    const preferred = step?.placement ?? 'bottom';

    // 先按首选方向计算，再判断是否溢出
    let left = 0;
    let top = 0;
    let finalPlacement: 'top' | 'bottom' | 'left' | 'right' = preferred;

    switch (preferred) {
      case 'bottom': {
        left = rect.x + rect.w / 2 - bw / 2;
        top = rect.y + rect.h + GAP;
        // 下溢出 → 翻到上面
        if (top + bh > viewport.h - PADDING - ACTION_BAR_H - ACTION_BAR_MARGIN) {
          top = rect.y - GAP - bh;
          finalPlacement = 'top';
        }
        break;
      }
      case 'top': {
        left = rect.x + rect.w / 2 - bw / 2;
        top = rect.y - GAP - bh;
        // 上溢出 → 翻到下面
        if (top < PADDING) {
          top = rect.y + rect.h + GAP;
          finalPlacement = 'bottom';
        }
        break;
      }
      case 'right': {
        left = rect.x + rect.w + GAP;
        top = rect.y + rect.h / 2 - bh / 2;
        // 右溢出 → 翻到左边
        if (left + bw > viewport.w - PADDING) {
          left = rect.x - GAP - bw;
          finalPlacement = 'left';
        }
        break;
      }
      case 'left': {
        left = rect.x - GAP - bw;
        top = rect.y + rect.h / 2 - bh / 2;
        // 左溢出 → 翻到右边
        if (left < PADDING) {
          left = rect.x + rect.w + GAP;
          finalPlacement = 'right';
        }
        break;
      }
    }

    // 硬夹取：最终位置一定要在视口安全区内
    // 底部操作条占用区域：viewport.h - ACTION_BAR_H - ACTION_BAR_MARGIN - sab 以下
    const padT = PADDING + safeArea.top;
    const padB = PADDING + safeArea.bottom;
    const padL = PADDING + safeArea.left;
    const padR = PADDING + safeArea.right;
    const safeBottom = viewport.h - padB - ACTION_BAR_H - ACTION_BAR_MARGIN;
    const safeTop = padT;
    const safeLeft = padL;
    const safeRight = viewport.w - padR;

    if (left < safeLeft) left = safeLeft;
    if (left + bw > safeRight) left = safeRight - bw;
    if (top < safeTop) top = safeTop;
    if (top + bh > safeBottom) top = safeBottom - bh;

    // 小三角箭头水平偏移（仅 top/bottom 时用）
    let arrowOffset = 0;
    if (finalPlacement === 'top' || finalPlacement === 'bottom') {
      // 目标中心相对气泡左缘的偏移
      const targetCenterX = rect.x + rect.w / 2;
      arrowOffset = Math.max(16, Math.min(bw - 16, targetCenterX - left));
    }
    // 小三角垂直偏移（仅 left/right 时用）
    let arrowOffsetY = 0;
    if (finalPlacement === 'left' || finalPlacement === 'right') {
      const targetCenterY = rect.y + rect.h / 2;
      arrowOffsetY = Math.max(16, Math.min(bh - 16, targetCenterY - top));
    }

    return { left, top, finalPlacement, arrowOffset, arrowOffsetY };
  })();

  const handleNext = useCallback(() => {
    if (isLast) {
      markOnboardingDone(userId, isLandscape);
      onClose();
    } else {
      setIndex((i) => i + 1);
    }
  }, [isLast, userId, isLandscape, onClose]);

  const handleSkip = useCallback(() => {
    markOnboardingDone(userId, isLandscape);
    onClose();
  }, [userId, isLandscape, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] pointer-events-none"
      data-testid="onboarding-tour-root"
      data-landscape={isLandscape ? 'true' : 'false'}
      aria-live="polite"
      aria-label="新手引导"
    >
      {/* 遮罩：四矩形挖孔 */}
      {rect && (
        <>
          {/* 上 */}
          <motion.div
            key={`top-${index}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="absolute left-0 right-0 bg-black/70 pointer-events-none"
            style={{ top: 0, height: rect.y }}
          />
          {/* 下 */}
          <motion.div
            key={`bot-${index}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="absolute left-0 right-0 bg-black/70 pointer-events-none"
            style={{ bottom: 0, top: rect.y + rect.h }}
          />
          {/* 左 */}
          <motion.div
            key={`left-${index}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="absolute bg-black/70 pointer-events-none"
            style={{ top: rect.y, left: 0, width: rect.x, height: rect.h }}
          />
          {/* 右 */}
          <motion.div
            key={`right-${index}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="absolute bg-black/70 pointer-events-none"
            style={{ top: rect.y, right: 0, left: rect.x + rect.w, height: rect.h }}
          />

          {/* 高亮框描边 + 呼吸 */}
          <motion.div
            key={`hl-${index}`}
            initial={{ opacity: 0, scale: 1.05 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
            className="absolute pointer-events-none rounded-lg"
            style={{
              left: rect.x,
              top: rect.y,
              width: rect.w,
              height: rect.h,
              boxShadow:
                '0 0 0 2px rgba(34,211,238,0.9), 0 0 24px 4px rgba(34,211,238,0.45)',
            }}
          />
        </>
      )}

      {/* 气泡内容（用 off-screen 测量尺寸，再显示到目标位置） */}
      <AnimatePresence mode="wait">
        {step && rect && (
          <motion.div
            key={`bubble-${index}`}
            ref={bubbleRef}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            data-testid="tour-bubble"
            className="absolute pointer-events-auto"
            style={{
              left: bubblePos.left,
              top: bubblePos.top,
              width: `min(320px, calc(100vw - ${PADDING * 2}px))`,
              maxWidth: `calc(100vw - ${PADDING * 2}px)`,
            }}
          >
            <div
              className="relative rounded-2xl p-4 border border-cyan-400/30"
              style={{
                background:
                  'linear-gradient(145deg, rgba(15,23,42,0.96), rgba(2,6,23,0.98))',
                backdropFilter: 'blur(18px) saturate(180%)',
                WebkitBackdropFilter: 'blur(18px) saturate(180%)',
                boxShadow:
                  '0 20px 50px -12px rgba(0,0,0,0.7), 0 0 0 1px rgba(34,211,238,0.2), inset 0 1px 0 rgba(255,255,255,0.08)',
              }}
            >
              {/* 关闭 X */}
              <button
                onClick={handleSkip}
                className="absolute top-2 right-2 h-7 w-7 rounded-full flex items-center justify-center text-white/50 hover:text-white hover:bg-white/10 transition-colors"
                aria-label="关闭教程"
                title="关闭"
                data-testid="tour-close-x"
              >
                <X className="w-4 h-4" />
              </button>

              {/* 标题 */}
              <div className="flex items-center gap-2 mb-2 pr-8">
                <div className="w-6 h-6 shrink-0 rounded-full bg-cyan-400/15 flex items-center justify-center text-cyan-300">
                  <HelpCircle className="w-3.5 h-3.5" />
                </div>
                <h3 className="text-sm font-semibold text-white truncate">{step.title}</h3>
              </div>

              {/* 描述 */}
              <p className="text-xs text-white/75 leading-relaxed">
                {step.description}
              </p>
            </div>

            {/* 小三角指向高亮目标 */}
            {(bubblePos.finalPlacement === 'top' || bubblePos.finalPlacement === 'bottom') && (
              <div
                className="absolute w-3 h-3 rotate-45"
                style={{
                  left: bubblePos.arrowOffset - 6,
                  backgroundColor: 'rgba(15,23,42,0.96)',
                  borderRight: '1px solid rgba(34,211,238,0.3)',
                  borderBottom: '1px solid rgba(34,211,238,0.3)',
                  ...(bubblePos.finalPlacement === 'top'
                    ? { bottom: -6 }
                    : { top: -6, transform: 'rotate(-135deg)' }),
                }}
              />
            )}
            {(bubblePos.finalPlacement === 'left' || bubblePos.finalPlacement === 'right') && (
              <div
                className="absolute w-3 h-3 rotate-45"
                style={{
                  top: bubblePos.arrowOffsetY - 6,
                  backgroundColor: 'rgba(15,23,42,0.96)',
                  borderRight: '1px solid rgba(34,211,238,0.3)',
                  borderBottom: '1px solid rgba(34,211,238,0.3)',
                  ...(bubblePos.finalPlacement === 'left'
                    ? { right: -6, transform: 'rotate(45deg)' }
                    : { left: -6, transform: 'rotate(-135deg)' }),
                }}
              />
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ===== 底部独立操作条（始终夹在视口内，任何时候都能点到） ===== */}
      <AnimatePresence>
        {open && step && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            transition={{ duration: 0.2 }}
            className="fixed left-0 right-0 z-[101] pointer-events-auto flex items-center justify-center"
            style={{
              bottom: ACTION_BAR_MARGIN + safeArea.bottom,
              paddingLeft: PADDING,
              paddingRight: PADDING,
            }}
            data-testid="tour-action-bar"
          >
            <div
              className="w-full max-w-[320px] rounded-full px-3 py-2 flex items-center justify-between gap-3 border border-cyan-400/30"
              style={{
                background:
                  'linear-gradient(145deg, rgba(15,23,42,0.96), rgba(2,6,23,0.98))',
                backdropFilter: 'blur(18px) saturate(180%)',
                WebkitBackdropFilter: 'blur(18px) saturate(180%)',
                boxShadow:
                  '0 8px 24px -6px rgba(0,0,0,0.6), 0 0 0 1px rgba(34,211,238,0.15)',
              }}
            >
              {/* 左侧：跳过 */}
              <button
                onClick={handleSkip}
                className="flex items-center gap-1 text-xs text-white/60 hover:text-white transition-colors px-2 py-1"
                data-testid="tour-skip-btn"
              >
                <SkipForward className="w-3.5 h-3.5" />
                <span>跳过</span>
              </button>

              {/* 中间：进度点 */}
              <div className="flex items-center gap-1.5">
                {effectiveSteps.map((_, i) => (
                  <span
                    key={i}
                    className={`w-1.5 h-1.5 rounded-full transition-all ${
                      i === index ? 'bg-cyan-400 w-4' : 'bg-white/20'
                    }`}
                  />
                ))}
              </div>

              {/* 右侧：下一步 / 完成 */}
              <Button
                size="sm"
                onClick={handleNext}
                className="h-8 px-3 text-xs bg-cyan-400 hover:bg-cyan-500 text-black font-medium"
                data-testid="tour-next"
              >
                {isLast ? '完成' : '下一步'}
                {!isLast && <ChevronRight className="w-3.5 h-3.5 ml-0.5" />}
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
