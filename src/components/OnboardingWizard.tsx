/**
 * 新手引导状态机（欢迎页 → 方向选择 → 等待转向 → 教学 → 询问另一方向 → 结束）
 *
 * 状态枚举：
 *   closed          - 关闭（不显示）
 *   welcome         - 欢迎页（首次进入自动弹）
 *   orientation-pick - 方向选择页（横屏/竖屏）
 *   waiting-rotate  - 等待用户旋转到指定方向
 *   tour            - 正在进行教学（内嵌 OnboardingTour）
 *   ask-other       - 询问是否需要另一方向的教程
 *   finish          - 结束提示
 *
 * 入口：
 *   - 自动弹欢迎页（首次进入，未完成/未退出过引导）
 *   - 设置入口直接进入方向选择页（skipWelcome=true）
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  RotateCw, Monitor, Smartphone, Sparkles, X, CheckCircle2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import OnboardingTour, {
  isOnboardingDone, markOnboardingDone, isLegacyOnboardingDone,
  getStepsForOrientation, type TourStep,
} from './OnboardingTour';
import { scopedStorage, logger } from '@lark-apaas/client-toolkit-lite';
import { markGuideEnded } from '@/lib/onboarding';

export type WizardState =
  | 'closed'
  | 'welcome'
  | 'orientation-pick'
  | 'waiting-rotate'
  | 'tour'
  | 'ask-other'
  | 'finish';

export interface OnboardingWizardProps {
  open: boolean;
  /** 是否跳过欢迎页（从设置入口进入时用） */
  skipWelcome?: boolean;
  userId?: string | number | null;
  /** 当前横屏状态（传 prop 则使用外部判定；不传则内部监听） */
  isLandscape?: boolean;
  onClose: () => void;
  /** 显示/隐藏底部控制栏（用于进度条/播放步） */
  setControlsVisible?: (v: boolean) => void;
  /** 打开设置面板（设置步需要展开面板） */
  openSettingsPanel?: () => void;
  /** 关闭所有面板（设置步结束后恢复） */
  closeAllPanels?: () => void;
  /** 准备横屏教学环境：切 3D 模式 + 进入沉浸态（隐藏控制栏） */
  prepareLandscapeTour?: () => Promise<void> | void;
  /** 横屏环境是否就绪（用于等待侧卡渲染完成） */
  landscapeReady?: boolean;
  /**
   * 新手教程进入/离开「封面步」时调用，用于控制封面占位框显示。
   * 仅在封面步激活时传 true，其它步骤传 false。
   */
  onCoverStepActiveChange?: (active: boolean) => void;
  /** 右侧小工具面板收起/展开演示回调。
    * 教程进行到「小工具收起与呼出」步时，先调用 (true) 收起面板展示边缘站标，
    * 用户下一步后调用 (false) 恢复展开。
    */
   onSideToolsCollapseDemo?: (collapsed: boolean) => void;
   /** 打开一起听面板（一起听教学步需要） */
   openListenTogetherPanel?: () => void;
   /** 关闭一起听面板 */
   closeListenTogetherPanel?: () => void;
 }

/**
 * 新手引导状态工具已迁移到 src/lib/onboarding.ts
 * 这里保持 re-export 兼容旧引用
 */
export { isGuideEnded, markGuideEnded, resetOnboardingAllForUser } from '@/lib/onboarding';

// ============== 主组件 ==============
export default function OnboardingWizard({
  open,
  skipWelcome = false,
  userId,
  isLandscape: isLandscapeProp,
  onClose,
  setControlsVisible,
  openSettingsPanel,
  closeAllPanels,
  prepareLandscapeTour,
  landscapeReady = true,
   onCoverStepActiveChange,
   onSideToolsCollapseDemo,
   openListenTogetherPanel,
   closeListenTogetherPanel,
 }: OnboardingWizardProps) {
  const [state, setState] = useState<WizardState>('closed');
  // 用户选择的教学方向（横屏/竖屏）
  const [targetLandscape, setTargetLandscape] = useState(false);
  // 等待转向时的前一个状态（用于"取消"按钮回退）
  const [prevState, setPrevState] = useState<WizardState>('welcome');
  // 教学是否正在运行
  const [tourOpen, setTourOpen] = useState(false);

  // 内部朝向监听
  const [innerLandscape, setInnerLandscape] = useState(() => window.innerWidth > window.innerHeight);
  const isLandscape = isLandscapeProp ?? innerLandscape;

  // 监听朝向变化
  useEffect(() => {
    if (isLandscapeProp !== undefined) return; // 外部传入则不监听
    const check = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      // matchMedia 且 innerWidth>innerHeight 双重判定
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

  // 打开时根据 skipWelcome 决定初始状态
  useEffect(() => {
    if (open) {
      if (skipWelcome) {
        setState('orientation-pick');
      } else {
        setState('welcome');
      }
    } else {
      setState('closed');
    }
  }, [open, skipWelcome]);

  // 等待转向页：检测到朝向匹配 → 启动教学
  const startTourPendingRef = useRef(false);
  useEffect(() => {
    if (state !== 'waiting-rotate') return;
    if (isLandscape === targetLandscape) {
      if (startTourPendingRef.current) return;
      startTourPendingRef.current = true;
      // 朝向匹配 → 启动对应教学
      startTourForOrientation(targetLandscape);
    }
  }, [state, isLandscape, targetLandscape]);

  // 教学会话 key（每次开始新教学时递增，强制 OnboardingTour 重新挂载 → index 归零）
  const [tourSessionKey, setTourSessionKey] = useState(0);

  // 启动指定方向的教学
  const startTourForOrientation = useCallback(async (landscape: boolean) => {
    setTargetLandscape(landscape);
    // 如果当前朝向匹配目标 → 直接开始；否则进入等待转向
    if (isLandscape !== landscape) {
      setPrevState('orientation-pick');
      setState('waiting-rotate');
      startTourPendingRef.current = false;
      return;
    }
    // 横屏需要先准备环境（关面板、切3D、进沉浸态）
    if (landscape) {
      closeAllPanels?.();
      if (prepareLandscapeTour) {
        await prepareLandscapeTour();
      }
      // 环境未就绪时先进入 waiting 态，等 landscapeReady 变 true
      if (!landscapeReady) {
        setPrevState('orientation-pick');
        setState('waiting-rotate');
        startTourPendingRef.current = false;
        return;
      }
    }
    // 开始教学
    setTourSessionKey(k => k + 1);
    setState('tour');
    setTourOpen(true);
    startTourPendingRef.current = false;
  }, [isLandscape, closeAllPanels, prepareLandscapeTour, landscapeReady]);

  // 横屏环境就绪时，如果在 waiting-rotate 且朝向匹配 → 进 tour
  const landscapeReadyRef = useRef(landscapeReady);
  useEffect(() => {
    const wasReady = landscapeReadyRef.current;
    landscapeReadyRef.current = landscapeReady;
    if (state === 'waiting-rotate' && targetLandscape && isLandscape && landscapeReady && !wasReady) {
      // 环境就绪 + 朝向匹配 → 直接进 tour
      setTourSessionKey(k => k + 1);
      setState('tour');
      setTourOpen(true);
    }
  }, [state, targetLandscape, isLandscape, landscapeReady]);

  // 用 ref 跟踪当前教学方向，避免 useCallback 闭包陈旧值
  const targetLandscapeRef = useRef(targetLandscape);
  useEffect(() => {
    targetLandscapeRef.current = targetLandscape;
  }, [targetLandscape]);

  // 教学结束（完成 / 跳过）后的下一步
  const handleTourFinished = useCallback(() => {
    setTourOpen(false);
    const currentLandscape = targetLandscapeRef.current;
    // 当前方向标记已完成（OnboardingTour 内部已写，这里再做一次保险）
    markOnboardingDone(userId, currentLandscape);

    const portraitDone = isOnboardingDone(userId, false);
    const landscapeDone = isOnboardingDone(userId, true);
    const bothDone = portraitDone && landscapeDone;

    logger.info(
      `[OnboardingWizard] tour finished. target=${currentLandscape ? 'landscape' : 'portrait'}, portraitDone=${portraitDone}, landscapeDone=${landscapeDone}, bothDone=${bothDone}`
    );

    if (bothDone) {
      // 两方向都完成 → 结束 + 写 guide_ended
      markGuideEnded(userId);
      setState('finish');
    } else {
      // 还有另一方向没完成 → 询问是否需要
      setState('ask-other');
    }
  }, [userId]);

  // 退出新手教程（欢迎页点"退出"）
  const handleQuit = useCallback(() => {
    markGuideEnded(userId);
    // 显示"你可以在设置中找到新手教程"的提示 → 用 finish 态复用结束页
    setState('finish');
  }, [userId]);

  // 结束页确认 → 完全关闭
  const handleFinishConfirm = useCallback(() => {
    markGuideEnded(userId);
    setState('closed');
    onClose();
  }, [userId, onClose]);

  // 方向选择
  const handlePickOrientation = useCallback((landscape: boolean) => {
    startTourForOrientation(landscape);
  }, [startTourForOrientation]);

  // 询问另一方向：需要
  const handleNeedOther = useCallback(() => {
    const otherLandscape = !targetLandscapeRef.current;
    startTourForOrientation(otherLandscape);
  }, [startTourForOrientation]);

  // 询问另一方向：不需要 → 只写 guide_ended（不再自动弹），不写另一方向的完成标记
  const handleSkipOther = useCallback(() => {
    markGuideEnded(userId);
    const portraitDone = isOnboardingDone(userId, false);
    const landscapeDone = isOnboardingDone(userId, true);
    logger.info(
      `[OnboardingWizard] skip other direction. portraitDone=${portraitDone}, landscapeDone=${landscapeDone}`
    );
    setState('finish');
  }, [userId]);

  // 等待转向页取消 → 回上一状态
  const handleCancelRotate = useCallback(() => {
    startTourPendingRef.current = false;
    setState(prevState);
  }, [prevState]);

  // 教学组件关闭（用户中途关闭 / 跳过） —— 已由 tourOpen effect 统一处理
  // 保留 handleTourClose 引用以便将来扩展

  // 教学组件关闭处理：tourOpen 从 true→false
  const wasTourOpenRef = useRef(false);
  const tourCloseSourceRef = useRef<'finished' | 'skip' | 'manual'>('manual');
  useEffect(() => {
    const wasOpen = wasTourOpenRef.current;
    wasTourOpenRef.current = tourOpen;
    if (wasOpen && !tourOpen) {
      if (state === 'tour') {
        handleTourFinished();
      }
    }
  }, [tourOpen, state, handleTourFinished]);

  // ===== 渲染 =====

   // 给步骤注入 beforeEnter，按步骤切换界面状态（控制栏/设置面板/一起听面板等）
    const tourSteps = useMemo(() => {
      const baseSteps = getStepsForOrientation(targetLandscape);
      return baseSteps.map((s, i) => {
        const step: TourStep = { ...s };

        if (targetLandscape) {
          // ========== 横屏步骤 ==========
          // 第 0 步 mode-switch、第 1 步 side-tools：沉浸态，无需 beforeEnter
          // 第 2 步 side-tools-close-btn：面板已展开（由 onStepChange 触发收起演示）
          // 第 3 步 side-tools-collapse：边缘站标（由 onStepChange 触发收起演示）
          // 第 4 步 cover-area：3D 模式已切好（startTour 阶段已准备）
          if (i === 5) {
            // 进度条 → 显示控制栏
            step.beforeEnter = () => { setControlsVisible?.(true); };
            step.minValidWidth = 200;
            step.minValidHeight = 8;
          } else if (i === 6) {
            // 播放/暂停 → 保持控制栏显示
            step.beforeEnter = () => { setControlsVisible?.(true); };
            step.minValidWidth = 32;
            step.minValidHeight = 32;
          } else if (i === 7) {
            // 设置面板 → 显示控制栏，让齿轮按钮可见
            step.beforeEnter = () => {
              closeListenTogetherPanel?.();
              setControlsVisible?.(true);
            };
            step.minValidWidth = 32;
            step.minValidHeight = 32;
          } else if (i === 8) {
            // 录制 → 关闭面板，显示控制栏
            step.beforeEnter = async () => {
              closeAllPanels?.();
              closeListenTogetherPanel?.();
              setControlsVisible?.(true);
              await new Promise(r => setTimeout(r, 320));
            };
            step.minValidWidth = 32;
            step.minValidHeight = 32;
          } else if (i === 9) {
            // 一起听按钮 → 关闭一起听面板，让按钮可见
            step.beforeEnter = async () => {
              closeListenTogetherPanel?.();
              setControlsVisible?.(true);
              await new Promise(r => setTimeout(r, 200));
            };
            step.minValidWidth = 32;
            step.minValidHeight = 32;
          } else if (i === 10 || i === 11) {
            // UID / 邀请 → 打开一起听面板
            step.beforeEnter = async () => {
              openListenTogetherPanel?.();
              await new Promise(r => setTimeout(r, 350));
            };
          }
        } else {
          // ========== 竖屏步骤 ==========
          // 第 6 步：一起听按钮 → 关闭面板，按钮可见
          if (i === 6) {
            step.beforeEnter = async () => {
              closeListenTogetherPanel?.();
              await new Promise(r => setTimeout(r, 200));
            };
            step.minValidWidth = 32;
            step.minValidHeight = 32;
          } else if (i === 7 || i === 8) {
            // UID / 邀请 → 打开一起听面板
            step.beforeEnter = async () => {
              openListenTogetherPanel?.();
              await new Promise(r => setTimeout(r, 350));
            };
          }
        }

        return step;
      });
    }, [
      targetLandscape,
      setControlsVisible,
      openSettingsPanel,
      closeAllPanels,
      openListenTogetherPanel,
      closeListenTogetherPanel,
    ]);

  return (
    <>
      {/* 教学组件（在 tour 态时打开） */}
      <OnboardingTour
        key={tourSessionKey}
        open={tourOpen && state === 'tour'}
        steps={tourSteps}
        onClose={() => {
          setTourOpen(false);
          // 关闭由下方 tourOpen 变化的 useEffect 统一处理（handleTourFinished）
        }}
        userId={userId}
        isLandscape={targetLandscape}
        autoCloseOnOrientationChange={false} // 由 Wizard 统一管理朝向切换
        onOrientationChange={() => { /* Wizard 接管 */ }}
        onTargetUnavailable={() => {
           // 目标缺失不退让关闭，由 OnboardingTour 内部居中降级
         }}
         onStepChange={(step, idx) => {
           // 封面步激活变化 → 通知父级控制占位框显示
           const isCoverStep = step.targetKey === 'cover-area' ||
             (Array.isArray(step.targetKey) && step.targetKey.includes('cover-area'));
           onCoverStepActiveChange?.(isCoverStep);

           // 小工具收起与呼出步：横屏第 2 步（side-tools-collapse）触发收起演示
           if (step.targetKey === 'side-tools-collapse') {
             onSideToolsCollapseDemo?.(true);
           } else {
             onSideToolsCollapseDemo?.(false);
           }
         }}
       />

      {/* 欢迎页 / 方向选择 / 等待转向 / 询问 / 结束 —— 都用 Dialog */}
      <AnimatePresence>
        {state !== 'closed' && state !== 'tour' && (
          <Dialog open={true} onOpenChange={(open) => { if (!open) handleQuit(); }}>
            <DialogContent
              className="sm:max-w-md gap-0 p-0 overflow-hidden bg-card border-border"
              data-testid={`wizard-${state}`}
            >
              {/* 顶部装饰条 */}
              <div className="h-1 w-full bg-gradient-to-r from-primary via-secondary to-primary" />

              <div className="p-6">
                {/* 欢迎页 */}
                {state === 'welcome' && (
                  <>
                    <DialogHeader className="mb-4">
                      <div className="flex items-center gap-2 text-primary mb-2">
                        <Sparkles className="w-5 h-5" />
                        <span className="text-sm font-medium">新手引导</span>
                      </div>
                      <DialogTitle className="text-xl">欢迎使用 MV Player</DialogTitle>
                      <DialogDescription className="pt-2 text-base leading-relaxed">
                        接下来会占用你几分钟的时间进行新手教程，好让你更好地使用该软件。
                      </DialogDescription>
                    </DialogHeader>
                    <DialogFooter className="flex-row gap-3 sm:justify-between pt-2">
                      <Button
                        variant="outline"
                        onClick={handleQuit}
                        data-testid="wizard-quit-btn"
                        className="flex-1"
                      >
                        退出新手教程
                      </Button>
                      <Button
                        onClick={() => setState('orientation-pick')}
                        data-testid="wizard-continue-btn"
                        className="flex-1"
                      >
                        继续
                      </Button>
                    </DialogFooter>
                  </>
                )}

                {/* 方向选择页 */}
                {state === 'orientation-pick' && (
                  <>
                    <DialogHeader className="mb-5">
                      <DialogTitle className="text-xl text-center">选择学习方向</DialogTitle>
                      <DialogDescription className="text-center pt-1">
                        你想先从横屏还是竖屏开始使用？
                      </DialogDescription>
                    </DialogHeader>
                    <div className="grid grid-cols-2 gap-3 mb-2">
                      <Button
                        variant="outline"
                        onClick={() => handlePickOrientation(true)}
                        data-testid="wizard-landscape-btn"
                        className="h-28 flex-col gap-2 border-border hover:border-primary hover:bg-primary/10"
                      >
                        <Monitor className="w-8 h-8 text-primary" />
                        <span className="text-base font-medium">横屏开始</span>
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => handlePickOrientation(false)}
                        data-testid="wizard-portrait-btn"
                        className="h-28 flex-col gap-2 border-border hover:border-primary hover:bg-primary/10"
                      >
                        <Smartphone className="w-8 h-8 text-primary" />
                        <span className="text-base font-medium">竖屏开始</span>
                      </Button>
                    </div>
                  </>
                )}

                {/* 等待转向页 */}
                {state === 'waiting-rotate' && (
                  <div className="py-4 text-center">
                    <motion.div
                      animate={{ rotate: 360 }}
                      transition={{ duration: 4, repeat: Infinity, ease: 'linear' }}
                      className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-primary/10 mb-4"
                    >
                      <RotateCw className="w-10 h-10 text-primary" />
                    </motion.div>
                    <DialogTitle className="text-lg mb-2">
                      请将设备旋转到{targetLandscape ? '横屏' : '竖屏'}
                    </DialogTitle>
                    <DialogDescription className="mb-6">
                      检测到当前为{isLandscape ? '横屏' : '竖屏'}模式
                    </DialogDescription>
                    <Button
                      variant="outline"
                      onClick={handleCancelRotate}
                      data-testid="wizard-cancel-rotate-btn"
                    >
                      取消
                    </Button>
                  </div>
                )}

                {/* 询问另一方向 */}
                {state === 'ask-other' && (
                  <>
                    <DialogHeader className="mb-4">
                      <div className="flex items-center gap-2 text-success mb-2">
                        <CheckCircle2 className="w-5 h-5" />
                        <span className="text-sm font-medium">
                          {targetLandscape ? '横屏' : '竖屏'}教程已完成
                        </span>
                      </div>
                      <DialogTitle className="text-xl">
                        是否需要{!targetLandscape ? '横屏' : '竖屏'}的使用教程？
                      </DialogTitle>
                      <DialogDescription className="pt-2">
                        不同屏幕方向下功能布局有所不同，建议都了解一下。
                      </DialogDescription>
                    </DialogHeader>
                    <DialogFooter className="flex-row gap-3 sm:justify-between pt-2">
                      <Button
                        variant="outline"
                        onClick={handleSkipOther}
                        data-testid="wizard-skip-other-btn"
                        className="flex-1"
                      >
                        不需要
                      </Button>
                      <Button
                        onClick={handleNeedOther}
                        data-testid="wizard-need-other-btn"
                        className="flex-1"
                      >
                        需要
                      </Button>
                    </DialogFooter>
                  </>
                )}

                {/* 结束提示 */}
                {state === 'finish' && (
                  <>
                    <DialogHeader className="mb-4 text-center">
                      <div className="flex justify-center mb-3">
                        <CheckCircle2 className="w-12 h-12 text-success" />
                      </div>
                       <DialogTitle className="text-xl" data-testid="wizard-finish-title">
                         {isOnboardingDone(userId, true) && isOnboardingDone(userId, false)
                           ? '教程已全部完成'
                           : '教程已结束'}
                       </DialogTitle>
                      <DialogDescription className="pt-2 text-base">
                        你可以随时在设置中找到新手教程。
                      </DialogDescription>
                    </DialogHeader>
                    <DialogFooter className="pt-2">
                      <Button
                        onClick={handleFinishConfirm}
                        data-testid="wizard-finish-btn"
                        className="w-full"
                      >
                        开始使用
                      </Button>
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
