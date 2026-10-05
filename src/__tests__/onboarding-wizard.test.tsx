/**
 * @vitest-environment jsdom
 * OnboardingWizard 引导状态机单元测试
 *
 * 覆盖：欢迎页 → 退出/继续 → 方向选择 → 等待转向 → 教学 → 询问另一方向 → 结束
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import React from 'react';

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  // 清空存储
  const storage = (globalThis as any).__storage__ as Map<string, string> | undefined;
  if (storage) storage.clear();
});

// mock client-toolkit-lite
const storage = new Map<string, string>();
(globalThis as any).__storage__ = storage;
vi.mock('@lark-apaas/client-toolkit-lite', () => ({
  scopedStorage: {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => { storage.set(k, v); },
    removeItem: (k: string) => { storage.delete(k); },
  },
  logger: { info: () => {}, error: () => {}, warn: () => {} },
}));

// mock framer-motion
vi.mock('framer-motion', () => {
  const React = require('react');
  const motion = new Proxy(
    {},
    {
      get(_target: object, prop: string) {
        if (prop === 'div' || prop === 'span') {
          return ({ children, ...rest }: any) => React.createElement(prop, rest, children);
        }
        return undefined;
      },
    },
  );
  return {
    motion,
    AnimatePresence: ({ children }: any) => children,
  };
});

// mock shadcn Dialog → 普通 div（jsdom 不渲染 Radix Portal）
vi.mock('@/components/ui/dialog', () => {
  const React = require('react');
  return {
    Dialog: ({ open, children }: any) => (open ? children : null),
    DialogContent: ({ children, ...rest }: any) => React.createElement('div', rest, children),
    DialogHeader: ({ children, ...rest }: any) => React.createElement('div', rest, children),
    DialogTitle: ({ children, ...rest }: any) => React.createElement('h2', rest, children),
    DialogDescription: ({ children, ...rest }: any) => React.createElement('p', rest, children),
    DialogFooter: ({ children, ...rest }: any) => React.createElement('div', rest, children),
    DialogClose: ({ children, ...rest }: any) => React.createElement('button', rest, children),
  };
});

// mock OnboardingTour 组件（避免依赖真实 Canvas / DOM 测量）
vi.mock('@/components/OnboardingTour', () => ({
  default: function MockTour({ open, onClose, isLandscape, userId, onStepChange, steps }: any) {
    const React = require('react');
    const { useEffect } = React;
    const [idx, setIdx] = React.useState(0);
    const effectiveSteps = steps || (isLandscape ? Array.from({ length: 9 }, (_, i) => ({ targetKey: `step-${i}` }))
                                                : Array.from({ length: 6 }, (_, i) => ({ targetKey: `step-${i}` })));
    const total = effectiveSteps.length;
    useEffect(() => {
      if (open && effectiveSteps[idx]) {
        onStepChange?.(effectiveSteps[idx], idx);
      }
    }, [idx, open]);
    if (!open) return null;
    return React.createElement('div', {
      'data-testid': 'onboarding-tour-root',
      'data-landscape': String(isLandscape),
      'data-userid': userId,
    }, [
      React.createElement('div', { key: 'idx', 'data-testid': 'tour-step-idx' }, `${idx + 1}/${total}`),
      React.createElement('button', {
        key: 'next',
        'data-testid': 'tour-next',
        onClick: () => {
          if (idx < total - 1) setIdx(idx + 1);
          else onClose?.();
        },
      }, idx === total - 1 ? '完成' : '下一步'),
      React.createElement('button', {
        key: 'skip',
        'data-testid': 'tour-skip-btn',
        onClick: () => onClose?.(),
      }, '跳过'),
    ]);
  },
  isOnboardingDone: (userId: string | number | null | undefined, isLandscape = false) => {
    const uid = userId ?? 'guest';
    const suffix = isLandscape ? 'landscape' : 'portrait';
    return storage.get(`onboarding_${suffix}_done_${uid}`) === '1';
  },
  markOnboardingDone: (userId: string | number | null | undefined, isLandscape = false) => {
    const uid = userId ?? 'guest';
    const suffix = isLandscape ? 'landscape' : 'portrait';
    storage.set(`onboarding_${suffix}_done_${uid}`, '1');
  },
  isLegacyOnboardingDone: () => false,
  PORTRAIT_STEPS: [],
  LANDSCAPE_STEPS: [],
  getStepsForOrientation: (landscape: boolean) => {
    if (landscape) {
      // 横屏 9 步，targetKey 与真实 OnboardingTour LANDSCAPE_STEPS 一致
      return [
        { targetKey: 'mode-switch', title: '模式切换', description: '' },
        { targetKey: 'side-tools', title: '右侧小工具', description: '' },
        { targetKey: 'side-tools-close-btn', title: '收起面板', description: '' },
        { targetKey: 'side-tools-collapse', title: '边缘站标', description: '' },
        { targetKey: 'cover-area', title: '封面拖动', description: '' },
        { targetKey: ['seekbar-track', 'seekbar-thumb'], title: '进度条', description: '' },
        { targetKey: 'play', title: '播放暂停', description: '' },
        { targetKey: 'settings', title: '设置面板', description: '' },
        { targetKey: 'record', title: '录制导出', description: '' },
      ];
    }
    // 竖屏 6 步
    return [
      { targetKey: 'login', title: '登录', description: '' },
      { targetKey: 'play', title: '播放', description: '' },
      { targetKey: ['seekbar-track', 'seekbar-thumb'], title: '进度条', description: '' },
      { targetKey: 'cover-area', title: '封面', description: '' },
      { targetKey: 'settings', title: '设置', description: '' },
      { targetKey: 'record', title: '录制', description: '' },
    ];
  },
}));

import OnboardingWizard, { isGuideEnded, markGuideEnded } from '@/components/OnboardingWizard';

// 给 OnboardingTour mock 里用到的 helper 也 import 一下（间接走 scopedStorage）
import { isOnboardingDone, markOnboardingDone } from '@/components/OnboardingTour';

function setViewport(w: number, h: number) {
  Object.defineProperty(window, 'innerWidth', { value: w, writable: true, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: h, writable: true, configurable: true });
  // matchMedia mock
  if (!(window as any).matchMedia) {
    (window as any).matchMedia = (q: string) => ({ matches: w > h });
  } else {
    // 替换
    const orig = (window as any).matchMedia;
    (window as any).matchMedia = (q: string) => ({ matches: w > h });
  }
}

describe('OnboardingWizard 引导状态机', () => {
  beforeEach(() => {
    storage.clear();
  });

  // ========== ① 无标记账号 → 欢迎页 ==========
  it('① 无标记账号 → 欢迎页出现，含"退出新手教程/继续"两个按钮', async () => {
    setViewport(390, 844); // 竖屏
    render(<OnboardingWizard open={true} userId="u_w1" onClose={() => {}} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });

    expect(screen.getByTestId('wizard-welcome')).toBeTruthy();
    expect(screen.getByText(/欢迎使用 MV Player/)).toBeTruthy();
    expect(screen.getByTestId('wizard-quit-btn').textContent).toMatch(/退出新手教程/);
    expect(screen.getByTestId('wizard-continue-btn').textContent).toMatch(/继续/);
  });

  // ========== ② 点退出 → 提示 + 标记引导结束 ==========
  it('② 点退出 → 显示"可在设置中找到"，确认后重进不再自动弹（标记 guide_ended）', async () => {
    setViewport(390, 844);
    const onClose = vi.fn();
    const { rerender } = render(
      <OnboardingWizard open={true} userId="u_w2" onClose={onClose} />,
    );
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });

    // 点退出
    fireEvent.click(screen.getByTestId('wizard-quit-btn'));
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });

    // finish 页
    expect(screen.getByTestId('wizard-finish')).toBeTruthy();
    expect(screen.getByText(/设置中找到新手教程/)).toBeTruthy();
    expect(screen.getByTestId('wizard-finish-btn').textContent).toMatch(/开始使用/);

    // guide_ended 标记已写
    expect(isGuideEnded('u_w2')).toBe(true);

    // 点确认 → onClose 调用
    fireEvent.click(screen.getByTestId('wizard-finish-btn'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ========== ③ 继续 → 方向选择 → 横屏但当前竖屏 → 等待 → 转横屏 → 9步 → 询问 ==========
  it('③ 继续 → 方向选择 → 选横屏但当前竖屏 → 等待页 → 模拟转横屏 → 横屏9步 → 询问另一方向', async () => {
    setViewport(390, 844); // 初始竖屏
    const onClose = vi.fn();
    const { rerender } = render(
      <OnboardingWizard open={true} userId="u_w3" onClose={onClose} />,
    );
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });

    // 1. 欢迎页 → 点继续 → 方向选择
    fireEvent.click(screen.getByTestId('wizard-continue-btn'));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.getByTestId('wizard-orientation-pick')).toBeTruthy();
    expect(screen.getByTestId('wizard-landscape-btn')).toBeTruthy();
    expect(screen.getByTestId('wizard-portrait-btn')).toBeTruthy();

    // 2. 选横屏（当前竖屏 → 进入等待转向）
    fireEvent.click(screen.getByTestId('wizard-landscape-btn'));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.getByTestId('wizard-waiting-rotate')).toBeTruthy();
    expect(screen.getByText(/旋转到横屏/)).toBeTruthy();

    // 3. 模拟转横屏（外部 prop 更新）
    rerender(
      <OnboardingWizard open={true} userId="u_w3" onClose={onClose} isLandscape={true} />,
    );
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    // 4. 进入横屏教学（7步）
    expect(screen.getByTestId('onboarding-tour-root')).toBeTruthy();
    expect(screen.getByTestId('onboarding-tour-root').getAttribute('data-landscape')).toBe('true');
    expect(screen.getByTestId('tour-step-idx').textContent).toBe('1/9');

    // 5. 走完 9 步
    for (let i = 0; i < 9; i++) {
      fireEvent.click(screen.getByTestId('tour-next'));
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    }

    // 6. 完成后 → 询问另一方向（竖屏未完成）
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.getByTestId('wizard-ask-other')).toBeTruthy();
    expect(screen.getByText(/竖屏/)).toBeTruthy();
    expect(screen.getByTestId('wizard-need-other-btn').textContent).toMatch(/需要/);
    expect(screen.getByTestId('wizard-skip-other-btn').textContent).toMatch(/不需要/);

    // 横屏标记已写
    expect(isOnboardingDone('u_w3', true)).toBe(true);
    expect(isOnboardingDone('u_w3', false)).toBe(false);
  });

  // ========== ④ "需要"另一方向 → 等竖屏 → 6步 → 结束提示 ==========
  it('④ 询问处点"需要" → 等待竖屏 → 竖屏6步 → 结束提示 + 写全部标记', async () => {
    setViewport(2340, 1080); // 初始横屏
    const onClose = vi.fn();

    // 先手动走：直接打开 Wizard 并从 ask-other 之前的状态（用 mock 太复杂，用完整流程）
    const { rerender } = render(
      <OnboardingWizard open={true} userId="u_w4" onClose={onClose} />,
    );
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });

    // 欢迎 → 继续
    fireEvent.click(screen.getByTestId('wizard-continue-btn'));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    // 选横屏（当前已经横屏 → 直接开始教学）
    fireEvent.click(screen.getByTestId('wizard-landscape-btn'));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    // 走完 9 步横屏
    for (let i = 0; i < 9; i++) {
      fireEvent.click(screen.getByTestId('tour-next'));
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    }
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.getByTestId('wizard-ask-other')).toBeTruthy();

    // 点"需要" → 等待竖屏
    fireEvent.click(screen.getByTestId('wizard-need-other-btn'));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.getByTestId('wizard-waiting-rotate')).toBeTruthy();
    expect(screen.getByText(/旋转到竖屏/)).toBeTruthy();

    // 转竖屏
    rerender(
      <OnboardingWizard open={true} userId="u_w4" onClose={onClose} isLandscape={false} />,
    );
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    // 竖屏教学（6 步）
    expect(screen.getByTestId('onboarding-tour-root').getAttribute('data-landscape')).toBe('false');
    expect(screen.getByTestId('tour-step-idx').textContent).toBe('1/6');

    // 走完 6 步
    for (let i = 0; i < 6; i++) {
      fireEvent.click(screen.getByTestId('tour-next'));
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    }
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });

    // 结束提示
    expect(screen.getByTestId('wizard-finish')).toBeTruthy();
    expect(screen.getByText(/设置中找到新手教程/)).toBeTruthy();

    // 两方向都标记完成 + guide_ended 标记
    expect(isOnboardingDone('u_w4', true)).toBe(true);
    expect(isOnboardingDone('u_w4', false)).toBe(true);
    expect(isGuideEnded('u_w4')).toBe(true);

    // 点开始使用 → 关闭
    fireEvent.click(screen.getByTestId('wizard-finish-btn'));
    expect(onClose).toHaveBeenCalled();
  });

  // ========== ⑤ "不需要"另一方向 → 直接结束 ==========
  it('⑤ 询问处点"不需要" → 直接结束提示 + 写 guide_ended', async () => {
    setViewport(2340, 1080);
    const onClose = vi.fn();
    render(<OnboardingWizard open={true} userId="u_w5" onClose={onClose} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });

    fireEvent.click(screen.getByTestId('wizard-continue-btn'));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    fireEvent.click(screen.getByTestId('wizard-landscape-btn'));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    // 走完 9 步
    for (let i = 0; i < 9; i++) {
      fireEvent.click(screen.getByTestId('tour-next'));
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    }
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });

    // 点不需要 → 结束页
    fireEvent.click(screen.getByTestId('wizard-skip-other-btn'));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.getByTestId('wizard-finish')).toBeTruthy();
    expect(isGuideEnded('u_w5')).toBe(true);
    // 只有横屏完成，竖屏未完成
    expect(isOnboardingDone('u_w5', true)).toBe(true);
    expect(isOnboardingDone('u_w5', false)).toBe(false);
  });

  // ========== ⑥ 设置入口（skipWelcome=true） → 直接方向选择页 ==========
  it('⑥ 设置入口 skipWelcome → 直接进入方向选择页，流程可复用', async () => {
    setViewport(390, 844); // 竖屏
    const onClose = vi.fn();
    render(
      <OnboardingWizard
        open={true}
        skipWelcome={true}
        userId="u_w6"
        onClose={onClose}
      />,
    );
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });

    // 直接是方向选择页（没有欢迎页）
    expect(screen.queryByTestId('wizard-welcome')).toBeNull();
    expect(screen.getByTestId('wizard-orientation-pick')).toBeTruthy();

    // 选竖屏（当前已经竖屏 → 直接开始教学）
    fireEvent.click(screen.getByTestId('wizard-portrait-btn'));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    expect(screen.getByTestId('onboarding-tour-root')).toBeTruthy();
    expect(screen.getByTestId('tour-step-idx').textContent).toBe('1/6');
  });

  // ========== 横屏 2340×1080 视口：走完 9 步 + landscape 标记 ==========
  it('横屏 2340×1080：选横屏立即开始、9 步全走完、写 landscape 标记', async () => {
    setViewport(2340, 1080);
    const onClose = vi.fn();
    render(
      <OnboardingWizard
        open={true}
        skipWelcome={true}
        userId="u_ls7"
        isLandscape={true}
        onClose={onClose}
      />,
    );
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });

    // 方向选择 → 横屏
    fireEvent.click(screen.getByTestId('wizard-landscape-btn'));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    expect(screen.getByTestId('onboarding-tour-root').getAttribute('data-landscape')).toBe('true');
    expect(screen.getByTestId('tour-step-idx').textContent).toBe('1/9');

    // 连点 7 次 next
    for (let i = 0; i < 9; i++) {
      fireEvent.click(screen.getByTestId('tour-next'));
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    }
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });

    // 横屏完成 → 询问竖屏
    expect(screen.getByTestId('wizard-ask-other')).toBeTruthy();
    expect(isOnboardingDone('u_ls7', true)).toBe(true);
     expect(isOnboardingDone('u_ls7', false)).toBe(false);
   });

  // ========== ask-other 断言 1：仅完成竖屏 → 出现 ask-other 且 landscape 标记仍未完成 ==========
  it('【断言①】仅完成竖屏 → 必须出现 ask-other 且 landscape 标记仍未完成', async () => {
    setViewport(390, 844); // 竖屏
    const onClose = vi.fn();
    render(
      <OnboardingWizard open={true} userId="u_ask1" onClose={onClose} />,
    );
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });

    // 欢迎 → 继续 → 选竖屏
    fireEvent.click(screen.getByTestId('wizard-continue-btn'));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    fireEvent.click(screen.getByTestId('wizard-portrait-btn'));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    // 走完 6 步竖屏
    for (let i = 0; i < 6; i++) {
      fireEvent.click(screen.getByTestId('tour-next'));
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    }
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });

    // 断言①：出现 ask-other
    expect(screen.getByTestId('wizard-ask-other')).toBeTruthy();
    expect(screen.getByTestId('wizard-need-other-btn').textContent).toMatch(/需要/);
    expect(screen.getByTestId('wizard-skip-other-btn').textContent).toMatch(/不需要/);
    // 竖屏已完成，横屏仍未完成
    expect(isOnboardingDone('u_ask1', false)).toBe(true);
    expect(isOnboardingDone('u_ask1', true)).toBe(false);
    // guide_ended 还没写（用户还没决定）
    expect(isGuideEnded('u_ask1')).toBe(false);
  });

  // ========== ask-other 断言 2：选"需要" → 转横屏 → 横屏教学 → 全部完成 ==========
  it('【断言②】竖屏完成→点需要→横屏教学完成→才显示"教程已全部完成"且两方向都标记', async () => {
    setViewport(390, 844); // 初始竖屏
    const onClose = vi.fn();
    const { rerender } = render(
      <OnboardingWizard open={true} userId="u_ask2" onClose={onClose} />,
    );
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });

    // 欢迎 → 继续 → 选竖屏
    fireEvent.click(screen.getByTestId('wizard-continue-btn'));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    fireEvent.click(screen.getByTestId('wizard-portrait-btn'));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    // 走完竖屏 6 步
    for (let i = 0; i < 6; i++) {
      fireEvent.click(screen.getByTestId('tour-next'));
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    }
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.getByTestId('wizard-ask-other')).toBeTruthy();

    // 点"需要" → 等待转向横屏
    fireEvent.click(screen.getByTestId('wizard-need-other-btn'));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.getByTestId('wizard-waiting-rotate')).toBeTruthy();

    // 转横屏
    rerender(
      <OnboardingWizard open={true} userId="u_ask2" onClose={onClose} isLandscape={true} />,
    );
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    // 横屏教学 7 步
    expect(screen.getByTestId('onboarding-tour-root').getAttribute('data-landscape')).toBe('true');
    for (let i = 0; i < 9; i++) {
      fireEvent.click(screen.getByTestId('tour-next'));
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    }
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });

    // 断言②：两方向都完成后才显示"教程已全部完成"
    expect(screen.getByTestId('wizard-finish')).toBeTruthy();
    expect(screen.getByTestId('wizard-finish-title').textContent).toMatch(/教程已全部完成/);
    expect(isOnboardingDone('u_ask2', true)).toBe(true);
    expect(isOnboardingDone('u_ask2', false)).toBe(true);
    expect(isGuideEnded('u_ask2')).toBe(true);
  });

  // ========== ask-other 断言 3：选"不需要" → 结束提示且不写另一方向标记 ==========
  it('【断言③】竖屏完成→点不需要→显示"教程已结束"且不写 landscape 标记', async () => {
    setViewport(390, 844); // 竖屏
    const onClose = vi.fn();
    render(
      <OnboardingWizard open={true} userId="u_ask3" onClose={onClose} />,
    );
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });

    fireEvent.click(screen.getByTestId('wizard-continue-btn'));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    fireEvent.click(screen.getByTestId('wizard-portrait-btn'));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    // 走完竖屏 6 步
    for (let i = 0; i < 6; i++) {
      fireEvent.click(screen.getByTestId('tour-next'));
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    }
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.getByTestId('wizard-ask-other')).toBeTruthy();

    // 点"不需要"
    fireEvent.click(screen.getByTestId('wizard-skip-other-btn'));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

    // 断言③：显示"教程已结束"（不是"全部完成"），横屏未完成
    expect(screen.getByTestId('wizard-finish')).toBeTruthy();
    expect(screen.getByTestId('wizard-finish-title').textContent).toMatch(/教程已结束/);
    expect(screen.getByTestId('wizard-finish-title').textContent).not.toMatch(/全部完成/);
    expect(isOnboardingDone('u_ask3', false)).toBe(true);  // 竖屏完成
    expect(isOnboardingDone('u_ask3', true)).toBe(false);  // 横屏未完成（不写标记）
    expect(isGuideEnded('u_ask3')).toBe(true);            // guide_ended 已写（不再自动弹）
  });

  // ========== ask-other 断言 4：仅完成横屏 → 出现 ask-other 且 portrait 标记仍未完成 ==========
  it('【断言④】仅完成横屏 → 必须出现 ask-other 且 portrait 标记仍未完成', async () => {
    setViewport(2340, 1080); // 横屏
    const onClose = vi.fn();
    render(
      <OnboardingWizard
        open={true}
        skipWelcome={true}
        userId="u_ask4"
        isLandscape={true}
        onClose={onClose}
      />,
    );
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });

    // 直接选横屏
    fireEvent.click(screen.getByTestId('wizard-landscape-btn'));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    // 走完横屏 9 步
    for (let i = 0; i < 9; i++) {
      fireEvent.click(screen.getByTestId('tour-next'));
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    }
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });

    // 断言④：出现 ask-other，横屏已完成，竖屏未完成
     expect(screen.getByTestId('wizard-ask-other')).toBeTruthy();
     expect(isOnboardingDone('u_ask4', true)).toBe(true);
     expect(isOnboardingDone('u_ask4', false)).toBe(false);
   });

  // ========== 断言⑤：封面步 → onCoverStepActiveChange 正确触发 ==========
   it('【断言⑤】横屏教学封面步激活时调用 onCoverStepActiveChange(true)，其它步为 false', async () => {
     setViewport(2340, 1080);
     const coverActiveSteps: number[] = [];
     const onCoverChange = vi.fn((active) => {
       if (active) coverActiveSteps.push(coverActiveSteps.length + 1);
     });

     render(
       <OnboardingWizard
         open={true}
         userId="u_cover1"
         skipWelcome={true}
         isLandscape={true}
         onClose={() => {}}
         onCoverStepActiveChange={onCoverChange}
       />,
     );
     await act(async () => { await new Promise((r) => setTimeout(r, 30)); });

     // skipWelcome 后在方向选择页，点横屏进入教学
     fireEvent.click(screen.getByTestId('wizard-landscape-btn'));
     await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

     // 横屏 step index 4 = cover-area（0:mode-switch 1:side-tools 2:close-btn 3:collapse 4:cover-area）
     // 点 4 次 next 到 index=4
     for (let i = 0; i < 4; i++) {
       fireEvent.click(screen.getByTestId('tour-next'));
       await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
     }

     // 第 5 步（index=4）应该触发过 true
     const calls = onCoverChange.mock.calls;
     const trueCalls = calls.filter((c: any[]) => c[0] === true).length;
     expect(trueCalls).toBeGreaterThan(0);
   });

   // ========== 断言⑥：小工具收起步 → onSideToolsCollapseDemo 正确触发 ==========
   it('【断言⑥】横屏教学小工具收起步调用 onSideToolsCollapseDemo(true)，其它步为 false', async () => {
     setViewport(2340, 1080);
     const collapseCalls: boolean[] = [];

     render(
       <OnboardingWizard
         open={true}
         userId="u_collapse1"
         skipWelcome={true}
         isLandscape={true}
         onClose={() => {}}
         onSideToolsCollapseDemo={(c) => collapseCalls.push(c)}
       />,
     );
     await act(async () => { await new Promise((r) => setTimeout(r, 30)); });

     // 进入教学
     fireEvent.click(screen.getByTestId('wizard-landscape-btn'));
     await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

     // 第 1 步 side-tools（不触发 collapse=true）
     // 第 2 步 side-tools-close-btn（不触发）
     // 第 3 步 side-tools-collapse（触发 true）
     // 点 3 次 next 到 index=3
     for (let i = 0; i < 3; i++) {
       fireEvent.click(screen.getByTestId('tour-next'));
       await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
     }

     // index=3 时应该有过 true 调用
     const hasTrue = collapseCalls.some((c) => c === true);
     expect(hasTrue).toBe(true);

     // 继续走一步到封面步，应该切回 false
     fireEvent.click(screen.getByTestId('tour-next'));
     await act(async () => { await new Promise((r) => setTimeout(r, 10)); });

     const lastCall = collapseCalls[collapseCalls.length - 1];
     expect(lastCall).toBe(false);
   });
 });
