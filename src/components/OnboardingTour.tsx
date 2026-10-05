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

export interface TourStep {
  targetKey: string | string[];
  title: string;
  description: string;
  placement?: 'top' | 'bottom' | 'left' | 'right';
  padding?: number;
  beforeEnter?: () => void | Promise<void>;
  fallbackToCenter?: boolean;
  minValidWidth?: number;
  minValidHeight?: number;
}

const PORTRAIT_STEPS: TourStep[] = [
  { targetKey: 'login', title: '登录网易云音乐', description: '点击右上角头像按钮，使用网易云音乐扫码登录，即可加载你的歌单与喜欢的音乐。', placement: 'bottom' },
  { targetKey: 'play', title: '播放 / 暂停', description: '点击底部中央按钮播放或暂停当前曲目。', placement: 'top' },
  { targetKey: ['seekbar-track', 'seekbar-thumb'], title: '进度条拖动', description: '拖动进度条可以跳转播放位置，左右滑动精确控制。', placement: 'top', padding: 4 },
  { targetKey: 'cover-area', title: '封面拖动 & 双击回正', description: '专辑封面模式下可用手指拖动旋转视角，双击画面即可回到初始视角。', placement: 'bottom' },
  { targetKey: 'settings', title: '设置面板', description: '底部右侧齿轮按钮打开设置面板，可切换可视化模式、调节颜色、封面粒子、歌词、录制质量等。', placement: 'top' },
  { targetKey: 'record', title: '录制导出', description: '顶部红色圆点按钮可开始 / 停止录制，导出视频分享给朋友。', placement: 'bottom' },
  { targetKey: 'listen-together', title: '一起听', description: '点击底部双人图标打开一起听面板，可以邀请好友跨设备实时同步听歌。', placement: 'top' },
  { targetKey: 'lt-uid', title: '我的 UID', description: '这里是你的专属 UID，点击复制按钮发给朋友，对方输入后就能和你一起听。', placement: 'bottom', padding: 6 },
  { targetKey: 'lt-invite', title: '发起邀请', description: '输入对方 UID 点击呼叫即可发起邀请；也可以创建房间等待对方呼入。房间内播放、切歌、进度都会实时同步。', placement: 'bottom', padding: 6 },
];
const LANDSCAPE_STEPS: TourStep[] = [
  { targetKey: 'mode-switch', title: '左侧模式切换控制台', description: '横屏沉浸态下左侧提供 2D / 3D / 封面等多种可视化模式一键切换。', placement: 'right' },
  { targetKey: 'side-tools', title: '右侧液态玻璃小工具', description: '横屏沉浸态下右侧提供频谱、电平、波形、BPM 等小工具，随音乐实时变化。', placement: 'left' },
  { targetKey: 'side-tools-close-btn', title: '收起小工具面板', description: '点击面板左上角的 × 按钮可以收起小工具面板，让画面更干净。', placement: 'left', padding: 6, minValidWidth: 24, minValidHeight: 24 },
  { targetKey: 'side-tools-collapse', title: '双击边缘重新呼出', description: '收起后屏幕右边缘会出现一个半透明小竖条，双击它即可重新打开小工具面板。', placement: 'left', padding: 8, minValidWidth: 8, minValidHeight: 64 },
  { targetKey: 'cover-area', title: '封面拖动 & 双击回正', description: '3D 模式下可拖动旋转视角，双击画面回到初始视角。', placement: 'bottom' },
  { targetKey: ['seekbar-track', 'seekbar-thumb'], title: '进度条拖动', description: '拖动进度条可以跳转播放位置。', placement: 'top', padding: 4 },
  { targetKey: 'play', title: '播放 / 暂停', description: '点击底部中央按钮播放或暂停当前曲目。', placement: 'top' },
  { targetKey: 'settings', title: '设置面板', description: '底部右侧齿轮按钮打开设置面板，可调节颜色、粒子、歌词、录制等。', placement: 'top' },
  { targetKey: 'record', title: '录制导出', description: '顶部红色圆点按钮可开始 / 停止录制，导出视频分享给朋友。', placement: 'bottom' },
  { targetKey: 'listen-together', title: '一起听', description: '点击底部双人图标打开一起听面板，邀请好友跨设备实时同步听歌。', placement: 'top' },
  { targetKey: 'lt-uid', title: '我的 UID', description: '这里是你的专属 UID，点击复制按钮发给朋友，对方输入后就能和你一起听。', placement: 'bottom', padding: 6 },
  { targetKey: 'lt-invite', title: '发起邀请 / 创建房间', description: '输入对方 UID 点击呼叫即可发起邀请；也可以创建房间等待对方呼入。房间内播放、切歌、进度都会实时同步。', placement: 'bottom', padding: 6 },
];

export function getStepsForOrientation(isLandscape: boolean): TourStep[] {
  return isLandscape ? LANDSCAPE_STEPS : PORTRAIT_STEPS;
}

export { PORTRAIT_STEPS, LANDSCAPE_STEPS };

function getStorageKey(userId: string | number | null | undefined, isLandscape: boolean) {
  const uid = userId ?? 'guest';
  const suffix = isLandscape ? 'landscape' : 'portrait';
  return `onboarding_${suffix}_done_${uid}`;
}

export function isOnboardingDone(userId: string | number | null | undefined, isLandscape = false): boolean {
  try { return scopedStorage.getItem(getStorageKey(userId, isLandscape)) === '1'; }
  catch { return false; }
}

export function markOnboardingDone(userId: string | number | null | undefined, isLandscape = false) {
  try { scopedStorage.setItem(getStorageKey(userId, isLandscape), '1'); } catch { /* ignore */ }
}

export function isLegacyOnboardingDone(userId: string | number | null | undefined): boolean {
  try { return scopedStorage.getItem(`onboarding_done_${userId ?? 'guest'}`) === '1'; }
  catch { return false; }
}

export function resetOnboardingForUser(userId: string | number | null | undefined) {
  const uid = userId ?? 'guest';
  try {
    scopedStorage.removeItem(`onboarding_portrait_done_${uid}`);
    scopedStorage.removeItem(`onboarding_landscape_done_${uid}`);
    scopedStorage.removeItem(`onboarding_done_${uid}`);
  } catch { /* ignore */ }
}

const PADDING = 16;
const GAP = 10;
const ACTION_BAR_H = 56;
const ACTION_BAR_MARGIN = 12;

function getSafeAreaInsets(): { top: number; bottom: number; left: number; right: number } {
  if (typeof document === 'undefined') return { top: 0, bottom: 0, left: 0, right: 0 };
  try {
    const cs = getComputedStyle(document.documentElement);
    const parsePx = (v: string) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
    return {
      top: parsePx(cs.getPropertyValue('--sat') || getComputedStyle(document.body).getPropertyValue('--sat')) || 0,
      bottom: parsePx(cs.getPropertyValue('--sab') || getComputedStyle(document.body).getPropertyValue('--sab')) || 0,
      left: parsePx(cs.getPropertyValue('--sal') || getComputedStyle(document.body).getPropertyValue('--sal')) || 0,
      right: parsePx(cs.getPropertyValue('--sar') || getComputedStyle(document.body).getPropertyValue('--sar')) || 0,
    };
  } catch { return { top: 0, bottom: 0, left: 0, right: 0 }; }
}

export interface OnboardingTourProps {
  open: boolean;
  onClose: () => void;
  userId?: string | number | null;
  steps?: TourStep[];
  isLandscape?: boolean;
  autoCloseOnOrientationChange?: boolean;
  onOrientationChange?: (isLandscape: boolean) => void;
  onTargetUnavailable?: () => void;
  onStepChange?: (step: TourStep, index: number) => void;
}

export default function OnboardingTour({
  open, onClose, userId, steps, isLandscape: isLandscapeProp,
  autoCloseOnOrientationChange = false, onOrientationChange, onTargetUnavailable, onStepChange,
}: OnboardingTourProps) {
  const [innerLandscape, setInnerLandscape] = useState(() => window.innerWidth > window.innerHeight);
  const isLandscape = isLandscapeProp ?? innerLandscape;
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

  useEffect(() => { if (open) setIndex(0); }, [open]);
  useEffect(() => { if (open) targetAvailableRef.current = false; }, [open, index]);
  useEffect(() => { setIndex(0); }, [isLandscape]);
  useEffect(() => { if (!open || !step) return; onStepChange?.(step, index); }, [open, index, step, onStepChange]);

  const beforeEnterPendingRef = useRef(false);
  useEffect(() => {
    if (!open || !step) return;
    if (beforeEnterPendingRef.current) return;
    const fn = step.beforeEnter;
    if (!fn) return;
    beforeEnterPendingRef.current = true;
    Promise.resolve(fn()).finally(() => { beforeEnterPendingRef.current = false; });
  }, [open, index, step]);

  useEffect(() => {
    if (!open) return;
    const onResize = () => {
      const w = window.innerWidth, h = window.innerHeight;
      setViewport({ w, h });
      setSafeArea(getSafeAreaInsets());
      if (isLandscapeProp === undefined) setInnerLandscape(w > h);
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, [open, isLandscapeProp]);

  useEffect(() => {
    if (!open) { lastLandscapeRef.current = isLandscape; return; }
    if (lastLandscapeRef.current !== isLandscape) {
      lastLandscapeRef.current = isLandscape;
      onOrientationChange?.(isLandscape);
      if (autoCloseOnOrientationChange) onClose();
    }
  }, [isLandscape, open, autoCloseOnOrientationChange, onClose, onOrientationChange]);

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
        const minX = Math.min(...rects.map((r) => r.left));
        const minY = Math.min(...rects.map((r) => r.top));
        const maxX = Math.max(...rects.map((r) => r.right));
        const maxY = Math.max(...rects.map((r) => r.bottom));
        const rawW = maxX - minX, rawH = maxY - minY;
        const pad = step.padding ?? 6;
        const minW = step.minValidWidth ?? 24;
        const minH = step.minValidHeight ?? 4;
        const fallback = step.fallbackToCenter !== false;
        const isValid = rawW >= minW && rawH >= minH;
        if (isValid || !fallback) {
          setRect({ x: Math.max(0, minX - pad), y: Math.max(0, minY - pad), w: Math.min(viewport.w, maxX - minX + pad * 2), h: Math.min(viewport.h, maxY - minY + pad * 2) });
          targetAvailableRef.current = true;
        } else {
          const w = Math.min(320, viewport.w - PADDING * 2), h = 60;
          setRect({ x: (viewport.w - w) / 2, y: (viewport.h - h) / 2, w, h });
          if (targetAvailableRef.current) { targetAvailableRef.current = false; onTargetUnavailable?.(); }
        }
      } else {
        const w = Math.min(320, viewport.w - PADDING * 2), h = 60;
        setRect({ x: (viewport.w - w) / 2, y: (viewport.h - h) / 2, w, h });
        if (targetAvailableRef.current) { targetAvailableRef.current = false; onTargetUnavailable?.(); }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); };
  }, [open, step, viewport.w, viewport.h]);

  useLayoutEffect(() => {
    if (!open) return;
    const el = bubbleRef.current;
    if (!el) return;
    const measure = () => { const r = el.getBoundingClientRect(); setBubbleSize({ w: r.width, h: r.height }); };
    measure();
    roRef.current = new ResizeObserver(measure);
    roRef.current.observe(el);
    return () => { roRef.current?.disconnect(); roRef.current = null; };
  }, [open, index, viewport.w, viewport.h, isLandscape]);

  const bubblePos = (() => {
    if (!rect) {
      return { left: (viewport.w - Math.min(320, viewport.w - PADDING * 2)) / 2, top: viewport.h / 2, finalPlacement: 'bottom' as const, arrowOffset: 0, arrowOffsetY: 0 };
    }
    const bw = bubbleSize.w || Math.min(320, viewport.w - PADDING * 2);
    const bh = bubbleSize.h || 160;
    const preferred = step?.placement ?? 'bottom';
    let left = 0, top = 0, finalPlacement: 'top' | 'bottom' | 'left' | 'right' = preferred;
    switch (preferred) {
      case 'bottom': left = rect.x + rect.w / 2 - bw / 2; top = rect.y + rect.h + GAP;
        if (top + bh > viewport.h - PADDING - ACTION_BAR_H - ACTION_BAR_MARGIN) { top = rect.y - GAP - bh; finalPlacement = 'top'; }
        break;
      case 'top': left = rect.x + rect.w / 2 - bw / 2; top = rect.y - GAP - bh;
        if (top < PADDING) { top = rect.y + rect.h + GAP; finalPlacement = 'bottom'; }
        break;
      case 'right': left = rect.x + rect.w + GAP; top = rect.y + rect.h / 2 - bh / 2;
        if (left + bw > viewport.w - PADDING) { left = rect.x - GAP - bw; finalPlacement = 'left'; }
        break;
      case 'left': left = rect.x - GAP - bw; top = rect.y + rect.h / 2 - bh / 2;
        if (left < PADDING) { left = rect.x + rect.w + GAP; finalPlacement = 'right'; }
        break;
    }
    const padT = PADDING + safeArea.top, padB = PADDING + safeArea.bottom;
    const safeBottom = viewport.h - padB - ACTION_BAR_H - ACTION_BAR_MARGIN;
    const safeTop = padT, safeLeft = PADDING + safeArea.left, safeRight = viewport.w - PADDING - safeArea.right;
    if (left < safeLeft) left = safeLeft;
    if (left + bw > safeRight) left = safeRight - bw;
    if (top < safeTop) top = safeTop;
    if (top + bh > safeBottom) top = safeBottom - bh;
    let arrowOffset = 0, arrowOffsetY = 0;
    if (finalPlacement === 'top' || finalPlacement === 'bottom') {
      const targetCenterX = rect.x + rect.w / 2;
      arrowOffset = Math.max(16, Math.min(bw - 16, targetCenterX - left));
    }
    if (finalPlacement === 'left' || finalPlacement === 'right') {
      const targetCenterY = rect.y + rect.h / 2;
      arrowOffsetY = Math.max(16, Math.min(bh - 16, targetCenterY - top));
    }
    return { left, top, finalPlacement, arrowOffset, arrowOffsetY };
  })();

  const handleNext = useCallback(() => {
    if (isLast) { markOnboardingDone(userId, isLandscape); onClose(); }
    else setIndex((i) => i + 1);
  }, [isLast, userId, isLandscape, onClose]);

  const handleSkip = useCallback(() => { markOnboardingDone(userId, isLandscape); onClose(); }, [userId, isLandscape, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] pointer-events-none" data-testid="onboarding-tour-root" data-landscape={isLandscape ? 'true' : 'false'} aria-live="polite" aria-label="新手引导">
      {rect && (
        <>
          <motion.div key={`top-${index}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="absolute left-0 right-0 bg-black/70 pointer-events-none" style={{ top: 0, height: rect.y }} />
          <motion.div key={`bot-${index}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="absolute left-0 right-0 bg-black/70 pointer-events-none" style={{ bottom: 0, top: rect.y + rect.h }} />
          <motion.div key={`left-${index}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="absolute bg-black/70 pointer-events-none" style={{ top: rect.y, left: 0, width: rect.x, height: rect.h }} />
          <motion.div key={`right-${index}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="absolute bg-black/70 pointer-events-none" style={{ top: rect.y, right: 0, left: rect.x + rect.w, height: rect.h }} />
          <motion.div key={`hl-${index}`} initial={{ opacity: 0, scale: 1.05 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.25, ease: 'easeOut' }} className="absolute pointer-events-none rounded-lg" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, boxShadow: '0 0 0 2px rgba(34,211,238,0.9), 0 0 24px 4px rgba(34,211,238,0.45)' }} />
        </>
      )}
      <AnimatePresence mode="wait">
        {step && rect && (
          <motion.div key={`bubble-${index}`} ref={bubbleRef} initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }} transition={{ duration: 0.2, ease: 'easeOut' }} data-testid="tour-bubble" className="absolute pointer-events-auto" style={{ left: bubblePos.left, top: bubblePos.top, width: `min(320px, calc(100vw - ${PADDING * 2}px))`, maxWidth: `calc(100vw - ${PADDING * 2}px)` }}>
            <div className="relative rounded-2xl p-4 border border-cyan-400/30" style={{ background: 'linear-gradient(145deg, rgba(15,23,42,0.96), rgba(2,6,23,0.98))', backdropFilter: 'blur(18px) saturate(180%)', WebkitBackdropFilter: 'blur(18px) saturate(180%)', boxShadow: '0 20px 50px -12px rgba(0,0,0,0.7), 0 0 0 1px rgba(34,211,238,0.2), inset 0 1px 0 rgba(255,255,255,0.08)' }}>
              <button onClick={handleSkip} className="absolute top-2 right-2 h-7 w-7 rounded-full flex items-center justify-center text-white/50 hover:text-white hover:bg-white/10 transition-colors" aria-label="关闭教程" title="关闭" data-testid="tour-close-x"><X className="w-4 h-4" /></button>
              <div className="flex items-center gap-2 mb-2 pr-8">
                <div className="w-6 h-6 shrink-0 rounded-full bg-cyan-400/15 flex items-center justify-center text-cyan-300"><HelpCircle className="w-3.5 h-3.5" /></div>
                <h3 className="text-sm font-semibold text-white truncate">{step.title}</h3>
              </div>
              <p className="text-xs text-white/75 leading-relaxed">{step.description}</p>
            </div>
            {(bubblePos.finalPlacement === 'top' || bubblePos.finalPlacement === 'bottom') && (
              <div className="absolute w-3 h-3 rotate-45" style={{ left: bubblePos.arrowOffset - 6, backgroundColor: 'rgba(15,23,42,0.96)', borderRight: '1px solid rgba(34,211,238,0.3)', borderBottom: '1px solid rgba(34,211,238,0.3)', ...(bubblePos.finalPlacement === 'top' ? { bottom: -6 } : { top: -6, transform: 'rotate(-135deg)' }) }} />
            )}
            {(bubblePos.finalPlacement === 'left' || bubblePos.finalPlacement === 'right') && (
              <div className="absolute w-3 h-3 rotate-45" style={{ top: bubblePos.arrowOffsetY - 6, backgroundColor: 'rgba(15,23,42,0.96)', borderRight: '1px solid rgba(34,211,238,0.3)', borderBottom: '1px solid rgba(34,211,238,0.3)', ...(bubblePos.finalPlacement === 'left' ? { right: -6, transform: 'rotate(45deg)' } : { left: -6, transform: 'rotate(-135deg)' }) }} />
            )}
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {open && step && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }} transition={{ duration: 0.2 }} className="fixed left-0 right-0 z-[101] pointer-events-auto flex items-center justify-center" style={{ bottom: ACTION_BAR_MARGIN + safeArea.bottom, paddingLeft: PADDING, paddingRight: PADDING }} data-testid="tour-action-bar">
            <div className="w-full max-w-[320px] rounded-full px-3 py-2 flex items-center justify-between gap-3 border border-cyan-400/30" style={{ background: 'linear-gradient(145deg, rgba(15,23,42,0.96), rgba(2,6,23,0.98))', backdropFilter: 'blur(18px) saturate(180%)', WebkitBackdropFilter: 'blur(18px) saturate(180%)', boxShadow: '0 8px 24px -6px rgba(0,0,0,0.6), 0 0 0 1px rgba(34,211,238,0.15)' }}>
              <button onClick={handleSkip} className="flex items-center gap-1 text-xs text-white/60 hover:text-white transition-colors px-2 py-1" data-testid="tour-skip-btn"><SkipForward className="w-3.5 h-3.5" /><span>跳过</span></button>
              <div className="flex items-center gap-1.5">{effectiveSteps.map((_, i) => (<span key={i} className={`w-1.5 h-1.5 rounded-full transition-all ${i === index ? 'bg-cyan-400 w-4' : 'bg-white/20'}`} />))}</div>
              <Button size="sm" onClick={handleNext} className="h-8 px-3 text-xs bg-cyan-400 hover:bg-cyan-500 text-black font-medium" data-testid="tour-next">{isLast ? '完成' : '下一步'}{!isLast && <ChevronRight className="w-3.5 h-3.5 ml-0.5" />}</Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
