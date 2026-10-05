/**
 * 新手引导状态机（欢迎页 → 方向选择 → 等待转向 → 教学 → 询问另一方向 → 结束）
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { RotateCw, Monitor, Smartphone, Sparkles, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import OnboardingTour, { isOnboardingDone, markOnboardingDone, getStepsForOrientation, type TourStep } from './OnboardingTour';
import { logger } from '@lark-apaas/client-toolkit-lite';
import { markGuideEnded } from '@/lib/onboarding';

export type WizardState = 'closed' | 'welcome' | 'orientation-pick' | 'waiting-rotate' | 'tour' | 'ask-other' | 'finish';

export interface OnboardingWizardProps {
  open: boolean;
  skipWelcome?: boolean;
  userId?: string | number | null;
  isLandscape?: boolean;
  onClose: () => void;
  setControlsVisible?: (v: boolean) => void;
  openSettingsPanel?: () => void;
  closeAllPanels?: () => void;
  prepareLandscapeTour?: () => Promise<void> | void;
  landscapeReady?: boolean;
  onCoverStepActiveChange?: (active: boolean) => void;
  onSideToolsCollapseDemo?: (collapsed: boolean) => void;
  openListenTogetherPanel?: () => void;
  closeListenTogetherPanel?: () => void;
}

export { isGuideEnded, markGuideEnded, resetOnboardingAllForUser } from '@/lib/onboarding';

export default function OnboardingWizard({
  open, skipWelcome = false, userId, isLandscape: isLandscapeProp, onClose,
  setControlsVisible, openSettingsPanel, closeAllPanels, prepareLandscapeTour,
  landscapeReady = true, onCoverStepActiveChange, onSideToolsCollapseDemo,
  openListenTogetherPanel, closeListenTogetherPanel,
}: OnboardingWizardProps) {
  const [state, setState] = useState<WizardState>('closed');
  const [targetLandscape, setTargetLandscape] = useState(false);
  const [prevState, setPrevState] = useState<WizardState>('welcome');
  const [tourOpen, setTourOpen] = useState(false);
  const [innerLandscape, setInnerLandscape] = useState(() => window.innerWidth > window.innerHeight);
  const isLandscape = isLandscapeProp ?? innerLandscape;

  useEffect(() => {
    if (isLandscapeProp !== undefined) return;
    const check = () => {
      const w = window.innerWidth, h = window.innerHeight;
      const mqlLandscape = window.matchMedia?.('(orientation: landscape)').matches;
      setInnerLandscape(mqlLandscape && w > h);
    };
    check();
    const onResize = () => check();
    const onOrient = () => check();
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onOrient);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onOrient);
    };
  }, [isLandscapeProp]);

  useEffect(() => {
    if (open) setState(skipWelcome ? 'orientation-pick' : 'welcome');
    else setState('closed');
  }, [open, skipWelcome]);

  const startTourPendingRef = useRef(false);
  useEffect(() => {
    if (state !== 'waiting-rotate') return;
    if (isLandscape === targetLandscape) {
      if (startTourPendingRef.current) return;
      startTourPendingRef.current = true;
      startTourForOrientation(targetLandscape);
    }
  }, [state, isLandscape, targetLandscape]);

  const [tourSessionKey, setTourSessionKey] = useState(0);

  const startTourForOrientation = useCallback(async (landscape: boolean) => {
    setTargetLandscape(landscape);
    if (isLandscape !== landscape) {
      setPrevState('orientation-pick');
      setState('waiting-rotate');
      startTourPendingRef.current = false;
      return;
    }
    if (landscape) {
      closeAllPanels?.();
      if (prepareLandscapeTour) await prepareLandscapeTour();
      if (!landscapeReady) {
        setPrevState('orientation-pick');
        setState('waiting-rotate');
        startTourPendingRef.current = false;
        return;
      }
    }
    setTourSessionKey(k => k + 1);
    setState('tour');
    setTourOpen(true);
    startTourPendingRef.current = false;
  }, [isLandscape, closeAllPanels, prepareLandscapeTour, landscapeReady]);

  const landscapeReadyRef = useRef(landscapeReady);
  useEffect(() => {
    const wasReady = landscapeReadyRef.current;
    landscapeReadyRef.current = landscapeReady;
    if (state === 'waiting-rotate' && targetLandscape && isLandscape && landscapeReady && !wasReady) {
      setTourSessionKey(k => k + 1);
      setState('tour');
      setTourOpen(true);
    }
  }, [state, targetLandscape, isLandscape, landscapeReady]);

  const targetLandscapeRef = useRef(targetLandscape);
  useEffect(() => { targetLandscapeRef.current = targetLandscape; }, [targetLandscape]);

  const handleTourFinished = useCallback(() => {
    setTourOpen(false);
    const currentLandscape = targetLandscapeRef.current;
    markOnboardingDone(userId, currentLandscape);
    const portraitDone = isOnboardingDone(userId, false);
    const landscapeDone = isOnboardingDone(userId, true);
    const bothDone = portraitDone && landscapeDone;
    logger.info(`[OnboardingWizard] tour finished. target=${currentLandscape ? 'landscape' : 'portrait'}, portraitDone=${portraitDone}, landscapeDone=${landscapeDone}, bothDone=${bothDone}`);
    if (bothDone) { markGuideEnded(userId); setState('finish'); }
    else setState('ask-other');
  }, [userId]);

  const handleQuit = useCallback(() => { markGuideEnded(userId); setState('finish'); }, [userId]);
  const handleFinishConfirm = useCallback(() => { markGuideEnded(userId); setState('closed'); onClose(); }, [userId, onClose]);
  const handlePickOrientation = useCallback((landscape: boolean) => { startTourForOrientation(landscape); }, [startTourForOrientation]);
  const handleNeedOther = useCallback(() => { startTourForOrientation(!targetLandscapeRef.current); }, [startTourForOrientation]);
  const handleSkipOther = useCallback(() => {
    markGuideEnded(userId);
    const portraitDone = isOnboardingDone(userId, false);
    const landscapeDone = isOnboardingDone(userId, true);
    logger.info(`[OnboardingWizard] skip other direction. portraitDone=${portraitDone}, landscapeDone=${landscapeDone}`);
    setState('finish');
  }, [userId]);
  const handleCancelRotate = useCallback(() => { startTourPendingRef.current = false; setState(prevState); }, [prevState]);

  const wasTourOpenRef = useRef(false);
  useEffect(() => {
    const wasOpen = wasTourOpenRef.current;
    wasTourOpenRef.current = tourOpen;
    if (wasOpen && !tourOpen) { if (state === 'tour') handleTourFinished(); }
  }, [tourOpen, state, handleTourFinished]);

  const tourSteps = useMemo(() => {
    const baseSteps = getStepsForOrientation(targetLandscape);
    return baseSteps.map((s, i) => {
      const step: TourStep = { ...s };
      if (targetLandscape) {
        if (i === 5) { step.beforeEnter = () => { setControlsVisible?.(true); }; step.minValidWidth = 200; step.minValidHeight = 8; }
        else if (i === 6) { step.beforeEnter = () => { setControlsVisible?.(true); }; step.minValidWidth = 32; step.minValidHeight = 32; }
        else if (i === 7) { step.beforeEnter = () => { closeListenTogetherPanel?.(); setControlsVisible?.(true); }; step.minValidWidth = 32; step.minValidHeight = 32; }
        else if (i === 8) { step.beforeEnter = async () => { closeAllPanels?.(); closeListenTogetherPanel?.(); setControlsVisible?.(true); await new Promise(r => setTimeout(r, 320)); }; step.minValidWidth = 32; step.minValidHeight = 32; }
        else if (i === 9) { step.beforeEnter = async () => { closeListenTogetherPanel?.(); setControlsVisible?.(true); await new Promise(r => setTimeout(r, 200)); }; step.minValidWidth = 32; step.minValidHeight = 32; }
        else if (i === 10 || i === 11) { step.beforeEnter = async () => { openListenTogetherPanel?.(); await new Promise(r => setTimeout(r, 350)); }; }
      } else {
        if (i === 6) { step.beforeEnter = async () => { closeListenTogetherPanel?.(); await new Promise(r => setTimeout(r, 200)); }; step.minValidWidth = 32; step.minValidHeight = 32; }
        else if (i === 7 || i === 8) { step.beforeEnter = async () => { openListenTogetherPanel?.(); await new Promise(r => setTimeout(r, 350)); }; }
      }
      return step;
    });
  }, [targetLandscape, setControlsVisible, openSettingsPanel, closeAllPanels, openListenTogetherPanel, closeListenTogetherPanel]);

  return (
    <>
      <OnboardingTour
        key={tourSessionKey}
        open={tourOpen && state === 'tour'}
        steps={tourSteps}
        onClose={() => setTourOpen(false)}
        userId={userId}
        isLandscape={targetLandscape}
        autoCloseOnOrientationChange={false}
        onOrientationChange={() => {}}
        onTargetUnavailable={() => {}}
        onStepChange={(step, idx) => {
          const isCoverStep = step.targetKey === 'cover-area' || (Array.isArray(step.targetKey) && step.targetKey.includes('cover-area'));
          onCoverStepActiveChange?.(isCoverStep);
          if (step.targetKey === 'side-tools-collapse') onSideToolsCollapseDemo?.(true);
          else onSideToolsCollapseDemo?.(false);
        }}
      />
      <AnimatePresence>
        {state !== 'closed' && state !== 'tour' && (
          <Dialog open={true} onOpenChange={(open) => { if (!open) handleQuit(); }}>
            <DialogContent className="sm:max-w-md gap-0 p-0 overflow-hidden bg-card border-border" data-testid={`wizard-${state}`}>
              <div className="h-1 w-full bg-gradient-to-r from-primary via-secondary to-primary" />
              <div className="p-6">
                {state === 'welcome' && (
                  <>
                    <DialogHeader className="mb-4">
                      <div className="flex items-center gap-2 text-primary mb-2"><Sparkles className="w-5 h-5" /><span className="text-sm font-medium">新手引导</span></div>
                      <DialogTitle className="text-xl">欢迎使用 MV Player</DialogTitle>
                      <DialogDescription className="pt-2 text-base leading-relaxed">接下来会占用你几分钟的时间进行新手教程，好让你更好地使用该软件。</DialogDescription>
                    </DialogHeader>
                    <DialogFooter className="flex-row gap-3 sm:justify-between pt-2">
                      <Button variant="outline" onClick={handleQuit} data-testid="wizard-quit-btn" className="flex-1">退出新手教程</Button>
                      <Button onClick={() => setState('orientation-pick')} data-testid="wizard-continue-btn" className="flex-1">继续</Button>
                    </DialogFooter>
                  </>
                )}
                {state === 'orientation-pick' && (
                  <>
                    <DialogHeader className="mb-5">
                      <DialogTitle className="text-xl text-center">选择学习方向</DialogTitle>
                      <DialogDescription className="text-center pt-1">你想先从横屏还是竖屏开始使用？</DialogDescription>
                    </DialogHeader>
                    <div className="grid grid-cols-2 gap-3 mb-2">
                      <Button variant="outline" onClick={() => handlePickOrientation(true)} data-testid="wizard-landscape-btn" className="h-28 flex-col gap-2 border-border hover:border-primary hover:bg-primary/10"><Monitor className="w-8 h-8 text-primary" /><span className="text-base font-medium">横屏开始</span></Button>
                      <Button variant="outline" onClick={() => handlePickOrientation(false)} data-testid="wizard-portrait-btn" className="h-28 flex-col gap-2 border-border hover:border-primary hover:bg-primary/10"><Smartphone className="w-8 h-8 text-primary" /><span className="text-base font-medium">竖屏开始</span></Button>
                    </div>
                  </>
                )}
                {state === 'waiting-rotate' && (
                  <div className="py-4 text-center">
                    <motion.div animate={{ rotate: 360 }} transition={{ duration: 4, repeat: Infinity, ease: 'linear' }} className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-primary/10 mb-4"><RotateCw className="w-10 h-10 text-primary" /></motion.div>
                    <DialogTitle className="text-lg mb-2">请将设备旋转到{targetLandscape ? '横屏' : '竖屏'}</DialogTitle>
                    <DialogDescription className="mb-6">检测到当前为{isLandscape ? '横屏' : '竖屏'}模式</DialogDescription>
                    <Button variant="outline" onClick={handleCancelRotate} data-testid="wizard-cancel-rotate-btn">取消</Button>
                  </div>
                )}
                {state === 'ask-other' && (
                  <>
                    <DialogHeader className="mb-4">
                      <div className="flex items-center gap-2 text-success mb-2"><CheckCircle2 className="w-5 h-5" /><span className="text-sm font-medium">{targetLandscape ? '横屏' : '竖屏'}教程已完成</span></div>
                      <DialogTitle className="text-xl">是否需要{!targetLandscape ? '横屏' : '竖屏'}的使用教程？</DialogTitle>
                      <DialogDescription className="pt-2">不同屏幕方向下功能布局有所不同，建议都了解一下。</DialogDescription>
                    </DialogHeader>
                    <DialogFooter className="flex-row gap-3 sm:justify-between pt-2">
                      <Button variant="outline" onClick={handleSkipOther} data-testid="wizard-skip-other-btn" className="flex-1">不需要</Button>
                      <Button onClick={handleNeedOther} data-testid="wizard-need-other-btn" className="flex-1">需要</Button>
                    </DialogFooter>
                  </>
                )}
                {state === 'finish' && (
                  <>
                    <DialogHeader className="mb-4 text-center">
                      <div className="flex justify-center mb-3"><CheckCircle2 className="w-12 h-12 text-success" /></div>
                      <DialogTitle className="text-xl" data-testid="wizard-finish-title">{isOnboardingDone(userId, true) && isOnboardingDone(userId, false) ? '教程已全部完成' : '教程已结束'}</DialogTitle>
                      <DialogDescription className="pt-2 text-base">你可以随时在设置中找到新手教程。</DialogDescription>
                    </DialogHeader>
                    <DialogFooter className="pt-2">
                      <Button onClick={handleFinishConfirm} data-testid="wizard-finish-btn" className="w-full">开始使用</Button>
                    </DialogFooter>
                  </>
                )}
              </div>
            </DialogContent>
          </Dialog>
        )}
      </AnimatePresence>
    </>
  );
}
