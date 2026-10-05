/**
 * @vitest-environment jsdom
 * 新手教程 OnboardingTour 定位算法单元测试 + 功能测试
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import React from 'react';

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

const storage = new Map<string, string>();
vi.mock('@lark-apaas/client-toolkit-lite', () => ({
  scopedStorage: {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => { storage.set(k, v); },
    removeItem: (k: string) => { storage.delete(k); },
  },
  logger: { info: () => {}, error: () => {}, warn: () => {} },
}));

import OnboardingTour, { isOnboardingDone, markOnboardingDone, PORTRAIT_STEPS, LANDSCAPE_STEPS } from '@/components/OnboardingTour';

vi.mock('framer-motion', () => {
  const React = require('react');
  const motion = new Proxy({}, { get(_t, prop: string) {
    return React.forwardRef(function MockMotion({ children, ...rest }: any, ref: any) {
      return React.createElement(prop as any, { ref, ...rest }, children);
    });
  }});
  const AnimatePresence = ({ children }: any) => {
    const childArr = React.Children.toArray(children);
    if (childArr.length === 0) return null;
    return childArr[childArr.length - 1];
  };
  return { motion, AnimatePresence };
});

describe('OnboardingTour 组件功能', () => {
  beforeEach(() => {
    storage.clear();
    (window as any).ResizeObserver = vi.fn(function () { return { observe() {}, unobserve() {}, disconnect() {} }; });
    ['login', 'play', 'seekbar-track', 'seekbar-thumb', 'cover-area', 'settings', 'record', 'side-tools', 'mode-switch', 'side-tools-close-btn', 'side-tools-collapse', 'listen-together', 'lt-uid', 'lt-invite'].forEach((k) => {
      const el = document.createElement('div');
      el.setAttribute('data-tour', k);
      document.body.appendChild(el);
    });
  });
  afterEach(() => { document.querySelectorAll('[data-tour]').forEach((el) => el.remove()); vi.restoreAllMocks(); });

  it('渲染第 1 步：标题、下一步、跳过、关闭按钮都存在', async () => {
    const onClose = vi.fn();
    render(<OnboardingTour open={true} onClose={onClose} userId="u1" isLandscape={false} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(screen.getByTestId('tour-next')).toBeTruthy();
    expect(screen.getByTestId('tour-skip-btn')).toBeTruthy();
    expect(screen.getByTestId('tour-close-x')).toBeTruthy();
  });

  it('点击跳过立即调用 onClose', async () => {
    const onClose = vi.fn();
    render(<OnboardingTour open={true} onClose={onClose} userId="u3" isLandscape={false} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    fireEvent.click(screen.getByTestId('tour-skip-btn'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('竖屏教程步骤数 = 9', async () => {
    const onClose = vi.fn();
    render(<OnboardingTour open={true} onClose={onClose} userId="u5" isLandscape={false} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    const dots = screen.getByTestId('tour-action-bar').querySelectorAll('span.rounded-full');
    expect(dots.length).toBe(9);
  });

  it('横屏教程步骤数 = 12', async () => {
    const onClose = vi.fn();
    render(<OnboardingTour open={true} onClose={onClose} userId="u_h" isLandscape={true} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    const dots = screen.getByTestId('tour-action-bar').querySelectorAll('span.rounded-full');
    expect(dots.length).toBe(12);
  });
});
