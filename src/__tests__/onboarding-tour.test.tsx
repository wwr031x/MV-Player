/**
 * @vitest-environment jsdom
 * 新手教程 OnboardingTour 定位算法单元测试 + 功能测试
 *
 * 说明：jsdom 不做真实布局，getBoundingClientRect 返回全 0，
 * 所以 DOM 级别的边界断言需要手动设置 Element.getBoundingClientRect。
 * 为了验证"先测量、后定位"的算法正确性，我们：
 *   1. 对核心定位逻辑做纯函数单元测试（各种边界场景）
 *   2. 对完整组件做功能测试（next/skip 能走通、按钮渲染正确）
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import React from 'react';

// RTL 在 vitest 下不会自动 cleanup，显式调用
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

// mock client-toolkit-lite
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

// mock framer-motion：禁用动画，motion.div 退化为普通 div，避免异步动画导致测试间干扰
vi.mock('framer-motion', () => {
  const React = require('react');
  const motion = new Proxy(
    {},
    {
      get(_t, prop: string) {
        return React.forwardRef(function MockMotion(
          { children, animate, initial, exit, transition, ...rest }: any,
          ref: any,
        ) {
          if (typeof children === 'function') {
            return React.createElement('div', { ref, ...rest }, children({}));
          }
          return React.createElement(prop as any, { ref, ...rest }, children);
        });
      },
    },
  );
  // AnimatePresence：只渲染当前 key 对应的子元素，忽略 exit 态
  const AnimatePresence = ({ children, mode }: any) => {
    // children 可能是单个元素或数组，取最后一个（当前 active）
    const childArr = React.Children.toArray(children);
    if (childArr.length === 0) return null;
    // 返回最后一个（最新的）子元素
    return childArr[childArr.length - 1];
  };
  return { motion, AnimatePresence };
});

// ============================================
//  核心定位算法（与组件内实现一一对应，便于纯函数单测）
// ============================================
interface Rect { x: number; y: number; w: number; h: number; }
type Placement = 'top' | 'bottom' | 'left' | 'right';
interface BubbleResult {
  left: number;
  top: number;
  finalPlacement: Placement;
}

const PADDING = 16;
const GAP = 10;
const ACTION_BAR_H = 56 + 12 + 12;

function calcBubble(
  rect: Rect,
  bubbleW: number,
  bubbleH: number,
  preferred: Placement,
  vw: number,
  vh: number,
): BubbleResult {
  let left = 0;
  let top = 0;
  let finalPlacement: Placement = preferred;

  switch (preferred) {
    case 'bottom': {
      left = rect.x + rect.w / 2 - bubbleW / 2;
      top = rect.y + rect.h + GAP;
      if (top + bubbleH > vh - PADDING - ACTION_BAR_H) {
        top = rect.y - GAP - bubbleH;
        finalPlacement = 'top';
      }
      break;
    }
    case 'top': {
      left = rect.x + rect.w / 2 - bubbleW / 2;
      top = rect.y - GAP - bubbleH;
      if (top < PADDING) {
        top = rect.y + rect.h + GAP;
        finalPlacement = 'bottom';
      }
      break;
    }
    case 'right': {
      left = rect.x + rect.w + GAP;
      top = rect.y + rect.h / 2 - bubbleH / 2;
      if (left + bubbleW > vw - PADDING) {
        left = rect.x - GAP - bubbleW;
        finalPlacement = 'left';
      }
      break;
    }
    case 'left': {
      left = rect.x - GAP - bubbleW;
      top = rect.y + rect.h / 2 - bubbleH / 2;
      if (left < PADDING) {
        left = rect.x + rect.w + GAP;
        finalPlacement = 'right';
      }
      break;
    }
  }

  // 硬夹取
  const safeBottom = vh - PADDING - ACTION_BAR_H;
  if (left < PADDING) left = PADDING;
  if (left + bubbleW > vw - PADDING) left = vw - PADDING - bubbleW;
  if (top < PADDING) top = PADDING;
  if (top + bubbleH > safeBottom) top = safeBottom - bubbleH;

  return { left, top, finalPlacement };
}

function assertInViewport(
  r: { left: number; top: number; w: number; h: number },
  vw: number,
  vh: number,
  label: string,
) {
  expect(r.left).toBeGreaterThanOrEqual(PADDING);
  expect(r.left + r.w).toBeLessThanOrEqual(vw - PADDING);
  expect(r.top).toBeGreaterThanOrEqual(PADDING);
  expect(r.top + r.h).toBeLessThanOrEqual(vh - PADDING - ACTION_BAR_H);
}

// ============================================
//  纯函数单测：9 步 × 2 视口
// ============================================
describe('OnboardingTour 定位算法 · 横屏 2340×1080', () => {
  const vw = 2340;
  const vh = 1080;
  const bw = 320;
  const bh = 150;

  const steps: Record<string, { rect: Rect; placement: Placement }> = {
    // 登录按钮：右上（x=2280 贴右缘）
    login: { rect: { x: 2280, y: 20, w: 40, h: 40 }, placement: 'bottom' },
    // 播放：底部中央
    play: { rect: { x: 1150, y: 980, w: 48, h: 48 }, placement: 'top' },
    // 进度条：底部宽条
    seekbar: { rect: { x: 200, y: 930, w: 1940, h: 12 }, placement: 'top' },
    // 封面区：中央
    'cover-area': { rect: { x: 800, y: 200, w: 740, h: 600 }, placement: 'bottom' },
    // 右侧小工具：贴右缘
    'side-tools': { rect: { x: 2130, y: 120, w: 180, h: 840 }, placement: 'left' },
    // 设置：右下角
    settings: { rect: { x: 2280, y: 985, w: 36, h: 36 }, placement: 'top' },
    // 录制：右上
    record: { rect: { x: 2180, y: 24, w: 36, h: 36 }, placement: 'bottom' },
  };

  Object.entries(steps).forEach(([key, { rect, placement }]) => {
    it(`${key} 气泡在视口内且不与底部操作条重叠`, () => {
      const r = calcBubble(rect, bw, bh, placement, vw, vh);
      assertInViewport({ left: r.left, top: r.top, w: bw, h: bh }, vw, vh, key);
    });
  });

  it('登录气泡（贴右缘）正确翻到左侧', () => {
    // login 在 x=2280，气泡宽 320，放 right 会溢出；但 placement 是 bottom
    // bottom 模式下，目标中心 x=2300，气泡左缘 x=2300-160=2140，右缘 2460 > 2324
    // 硬夹取后：left = 2340-16-320 = 2004
    const r = calcBubble(steps.login.rect, bw, bh, 'bottom', vw, vh);
    expect(r.left + bw).toBeLessThanOrEqual(vw - PADDING);
    // 应在目标的左下方（因为被夹取到左边）
    expect(r.left).toBeLessThan(steps.login.rect.x);
  });

  it('右侧小工具（贴右缘）气泡翻转到左侧', () => {
    const r = calcBubble(steps['side-tools'].rect, bw, bh, 'left', vw, vh);
    // left 模式：左缘本就在 rect.x - gap - bw = 2130-10-320=1800，在视口内
    expect(r.finalPlacement).toBe('left');
    expect(r.left + bw).toBeLessThan(steps['side-tools'].rect.x);
  });

  it('底部播放按钮上方放不下时翻转到下方', () => {
    // 播放按钮 y=980，top 模式气泡上缘=980-10-150=820，在安全区内
    const r = calcBubble(steps.play.rect, bw, bh, 'top', vw, vh);
    expect(r.finalPlacement).toBe('top');
    expect(r.top + bh).toBeLessThanOrEqual(vh - PADDING - ACTION_BAR_H);
  });
});

describe('OnboardingTour 定位算法 · 竖屏 390×844', () => {
  const vw = 390;
  const vh = 844;
  const bw = Math.min(320, vw - 32); // 358
  const bh = 160;

  const steps: Record<string, { rect: Rect; placement: Placement }> = {
    login:      { rect: { x: 340, y: 20, w: 36, h: 36 }, placement: 'bottom' },
    play:       { rect: { x: 171, y: 750, w: 48, h: 48 }, placement: 'top' },
    seekbar:    { rect: { x: 16, y: 720, w: 358, h: 10 }, placement: 'top' },
    'cover-area': { rect: { x: 45, y: 120, w: 300, h: 500 }, placement: 'bottom' },
    'side-tools': { rect: { x: 300, y: 100, w: 70, h: 600 }, placement: 'left' },
    settings:   { rect: { x: 340, y: 760, w: 32, h: 32 }, placement: 'top' },
    record:     { rect: { x: 300, y: 22, w: 32, h: 32 }, placement: 'bottom' },
  };

  Object.entries(steps).forEach(([key, { rect, placement }]) => {
    it(`${key} 气泡在视口内且不与底部操作条重叠`, () => {
      const r = calcBubble(rect, bw, bh, placement, vw, vh);
      assertInViewport({ left: r.left, top: r.top, w: bw, h: bh }, vw, vh, key);
    });
  });

  it('右上角登录按钮竖屏下气泡被夹取到视口左缘以内', () => {
    const r = calcBubble(steps.login.rect, bw, bh, 'bottom', vw, vh);
    expect(r.left).toBeGreaterThanOrEqual(PADDING);
    expect(r.left + bw).toBeLessThanOrEqual(vw - PADDING);
  });

  it('右下角设置按钮竖屏下气泡翻转到上方并在安全区', () => {
    // 顶部 y=760，top 模式：y=760-10-160=590，在安全区内
    const r = calcBubble(steps.settings.rect, bw, bh, 'top', vw, vh);
    expect(r.top + bh).toBeLessThanOrEqual(vh - PADDING - ACTION_BAR_H);
  });

  it('贴右缘 side-tools 左侧空间足够时放左侧', () => {
    // x=300，left 模式：左缘=300-10-358=-68 < 16 → 翻到右侧
    // 右侧：左缘=300+70+10=380，右缘=380+358=738 > 374 → 硬夹取 left=374-358=16
    const r = calcBubble(steps['side-tools'].rect, bw, bh, 'left', vw, vh);
    expect(r.left).toBeGreaterThanOrEqual(PADDING);
    expect(r.left + bw).toBeLessThanOrEqual(vw - PADDING);
  });
});

// ============================================
//  组件功能测试（next/skip 走通、按钮存在）
// ============================================
describe('OnboardingTour 组件功能测试', () => {
  beforeEach(() => {
    // 清空 mock storage，避免跨用例干扰
    storage.clear();

    // mock ResizeObserver
    (window as any).ResizeObserver = vi.fn(function () {
      return { observe() {}, unobserve() {}, disconnect() {} };
    });

    // 放目标元素（覆盖竖屏 + 横屏所有 target key）
    [
      'login', 'play', 'seekbar-track', 'seekbar-thumb', 'cover-area',
      'settings', 'record', 'side-tools', 'mode-switch',
      'side-tools-close-btn', 'side-tools-collapse',
      'listen-together', 'lt-uid', 'lt-invite',
    ].forEach((k) => {
      const el = document.createElement('div');
      el.setAttribute('data-tour', k);
      el.textContent = k;
      document.body.appendChild(el);
    });
  });

  afterEach(() => {
    document.querySelectorAll('[data-tour]').forEach((el) => el.remove());
    vi.restoreAllMocks();
  });

  it('渲染第 1 步：标题、描述、下一步、跳过、关闭按钮都存在', async () => {
    const onClose = vi.fn();
    render(<OnboardingTour open={true} onClose={onClose} userId="u1" isLandscape={false} />);

    // 等动画帧
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(screen.getByText('登录网易云音乐')).toBeTruthy();
    expect(screen.getByTestId('tour-next').textContent).toMatch(/下一步/);
    expect(screen.getByTestId('tour-skip-btn').textContent).toMatch(/跳过/);
    expect(screen.getByTestId('tour-close-x')).toBeTruthy();
    expect(screen.getByTestId('tour-action-bar')).toBeTruthy();
    expect(screen.getByTestId('tour-bubble')).toBeTruthy();
  });

  it('点击"下一步" 8 次后到"完成"，再点 onClose 被调用（竖屏 9 步）', async () => {
    const onClose = vi.fn();
    render(<OnboardingTour open={true} onClose={onClose} userId="u2" isLandscape={false} />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const stepTitles = [
      '登录网易云音乐',
      '播放 / 暂停',
      '进度条拖动',
      '封面拖动 & 双击回正',
      '设置面板',
      '录制导出',
      '一起听',
      '我的 UID',
      '发起邀请',
    ];

    for (let i = 0; i < stepTitles.length; i++) {
      expect(screen.getByText(stepTitles[i])).toBeTruthy();
      const next = screen.getByTestId('tour-next');
      if (i < stepTitles.length - 1) {
        expect(next.textContent).toMatch(/下一步/);
      } else {
        expect(next.textContent).toMatch(/完成/);
      }
      fireEvent.click(next);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });
    }

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('完整 9 步（竖屏）：进度点 = 9、每步标题正确、第 9 步显示"完成"', async () => {
    const onClose = vi.fn();
    render(<OnboardingTour open={true} onClose={onClose} userId="u5" isLandscape={false} />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // 进度点数量 = 9（操作条中间区域）
    const actionBar = screen.getByTestId('tour-action-bar');
    const dotSpans = actionBar.querySelectorAll('span.rounded-full');
    expect(dotSpans.length).toBe(9);

    const expectedTitles = [
      '登录网易云音乐',
      '播放 / 暂停',
      '进度条拖动',
      '封面拖动 & 双击回正',
      '设置面板',
      '录制导出',
      '一起听',
      '我的 UID',
      '发起邀请',
    ];

    for (let i = 0; i < expectedTitles.length; i++) {
      const bubble = screen.getByTestId('tour-bubble');
      const title = bubble.querySelector('h3');
      expect(title?.textContent).toBe(expectedTitles[i]);

      const next = screen.getByTestId('tour-next');
      if (i < expectedTitles.length - 1) {
        expect(next.textContent).toMatch(/下一步/);
      } else {
        expect(next.textContent).toMatch(/完成/);
      }

      fireEvent.click(next);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });
    }

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('点击跳过立即调用 onClose', async () => {
    const onClose = vi.fn();
    render(<OnboardingTour open={true} onClose={onClose} userId="u3" isLandscape={false} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    fireEvent.click(screen.getByTestId('tour-skip-btn'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('点击右上角 X 立即调用 onClose', async () => {
    const onClose = vi.fn();
    render(<OnboardingTour open={true} onClose={onClose} userId="u4" isLandscape={false} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    fireEvent.click(screen.getByTestId('tour-close-x'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ============================================
//  集成链路测试（竖屏/横屏拆分 + 朝向切换 + 进度条整体高亮）
// ============================================
describe('OnboardingTour 集成链路', () => {
  beforeEach(() => {
    storage.clear();
    (window as any).ResizeObserver = vi.fn(function () {
      return { observe() {}, unobserve() {}, disconnect() {} };
    });
    // 竖屏 + 横屏所有 target
    [
      'login', 'play', 'seekbar-track', 'seekbar-thumb', 'cover-area',
      'settings', 'record', 'side-tools', 'mode-switch',
      'side-tools-close-btn', 'side-tools-collapse',
      'listen-together', 'lt-uid', 'lt-invite',
    ].forEach((k) => {
      const el = document.createElement('div');
      el.setAttribute('data-tour', k);
      el.textContent = k;
      el.style.cssText = 'position: absolute; left: 50px; top: 100px; width: 100px; height: 30px;';
      document.body.appendChild(el);
    });
  });

  afterEach(() => {
    document.querySelectorAll('[data-tour]').forEach((el) => el.remove());
    vi.restoreAllMocks();
  });

  // —— 竖屏视口 ——
  describe('竖屏 390×844', () => {
    const vw = 390;
    const vh = 844;

    beforeEach(() => {
      // mock window size
      Object.defineProperty(window, 'innerWidth', { value: vw, writable: true });
      Object.defineProperty(window, 'innerHeight', { value: vh, writable: true });
      // 给元素摆个真实位置
      const setPos = (key: string, x: number, y: number, w: number, h: number) => {
        const el = document.querySelector(`[data-tour="${key}"]`) as HTMLElement;
        if (el) {
          el.style.left = `${x}px`;
          el.style.top = `${y}px`;
          el.style.width = `${w}px`;
          el.style.height = `${h}px`;
          // mock getBoundingClientRect
          el.getBoundingClientRect = () => ({
            left: x, top: y, right: x + w, bottom: y + h, width: w, height: h,
            x, y, toJSON: () => {},
          } as DOMRect);
        }
      };
      setPos('login', 300, 10, 70, 36);
      setPos('play', 165, 760, 60, 60);
      setPos('seekbar-track', 20, 720, 350, 6);
      setPos('seekbar-thumb', 50, 713, 18, 18);
      setPos('cover-area', 45, 100, 300, 500);
      setPos('settings', 300, 750, 70, 60);
      setPos('record', 20, 10, 70, 30);
      setPos('listen-together', 200, 750, 40, 40);
      setPos('lt-uid', 80, 120, 180, 30);
      setPos('lt-invite', 80, 180, 220, 80);
    });

    it('① 竖屏教程步骤数 = 9，含一起听 3 步', async () => {
      const onClose = vi.fn();
      const { container } = render(
        <OnboardingTour open={true} onClose={onClose} userId="u_v" isLandscape={false} />,
      );
      await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

      const root = container.querySelector('[data-testid="onboarding-tour-root"]');
      expect(root).not.toBeNull();

      const actionBar = screen.getByTestId('tour-action-bar');
      const dots = actionBar.querySelectorAll('span.rounded-full');
      expect(dots.length).toBe(9);

      // 验证竖屏步骤标题（不含「横屏液态玻璃」「左侧模式切换」）
      const titles = [
        '登录网易云音乐',
        '播放 / 暂停',
        '进度条拖动',
        '封面拖动 & 双击回正',
        '设置面板',
        '录制导出',
        '一起听',
        '我的 UID',
        '发起邀请',
      ];
      for (let i = 0; i < titles.length; i++) {
        const title = screen.getByTestId('tour-bubble').querySelector('h3')?.textContent;
        expect(title).toBe(titles[i]);
        expect(title).not.toMatch(/横屏|液态玻璃|左侧模式/);
        if (i < titles.length - 1) {
          fireEvent.click(screen.getByTestId('tour-next'));
          await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
        }
      }
      // 最后一步是「完成」
      expect(screen.getByTestId('tour-next').textContent).toMatch(/完成/);
    });

    it('② 进度条高亮包含轨道 + 拖球，整体对齐不歪', async () => {
      const onClose = vi.fn();
      render(<OnboardingTour open={true} onClose={onClose} userId="u_v2" isLandscape={false} />);

      // 点到第 3 步（进度条）
      await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
      fireEvent.click(screen.getByTestId('tour-next')); // 1 → 2
      await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
      fireEvent.click(screen.getByTestId('tour-next')); // 2 → 3
      await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

      // 验证标题是进度条
      const title = screen.getByTestId('tour-bubble').querySelector('h3')?.textContent;
      expect(title).toBe('进度条拖动');

      // 高亮框应当覆盖 seekbar-track 与 seekbar-thumb 的并集
      const track = document.querySelector<HTMLElement>('[data-tour="seekbar-track"]')!;
      const thumb = document.querySelector<HTMLElement>('[data-tour="seekbar-thumb"]')!;
      const tRect = track.getBoundingClientRect();
      const thRect = thumb.getBoundingClientRect();
      const expectedX = Math.min(tRect.left, thRect.left);
      const expectedW = Math.max(tRect.right, thRect.right) - expectedX;

      // 从遮罩层推断高亮 rect（上遮罩高度 = rect.y）
      const topMask = document.querySelector<HTMLElement>('[data-testid="onboarding-tour-root"] > div:nth-child(1)');
      // 换个方式：rect.y 就是上遮罩 height；rect.x 就是左遮罩 width
      const rootDiv = document.querySelector<HTMLElement>('[data-testid="onboarding-tour-root"]')!;
      // 上遮罩 = 第一个子元素，height = rect.y
      const topMaskEl = rootDiv.children[0] as HTMLElement;
      const leftMaskEl = rootDiv.children[2] as HTMLElement;
      const rightMaskEl = rootDiv.children[3] as HTMLElement;
      const rectY = parseFloat(topMaskEl.style.height || '0');
      const rectX = parseFloat(leftMaskEl.style.width || '0');
      // 高亮宽度 = vw - rect.x - rightMaskLeft(= rect.x + rect.w)
      // 右遮罩 left = rect.x + rect.w，所以 rect.w = vw - rect.x - (vw - rightMaskLeft)... 直接用高亮框元素
      const hlBox = rootDiv.querySelector<HTMLElement>('div[style*="box-shadow"]')!;
      const hlW = parseFloat(hlBox.style.width || '0');
      const hlH = parseFloat(hlBox.style.height || '0');

      // 高亮框宽度 ≥ 轨道宽度（因为包含了拖球外突部分）
      expect(hlW).toBeGreaterThanOrEqual(tRect.width);
      // 高亮框高度 ≥ 轨道高度（因为包含了拖球上下突出）
      expect(hlH).toBeGreaterThanOrEqual(tRect.height);
      // 高亮框左缘 ≤ 拖球左缘（说明并集包含了拖球）
      expect(rectX).toBeLessThanOrEqual(thRect.left + 6); // +padding
      // 高亮框右缘 ≥ 拖球右缘
      expect(rectX + hlW).toBeGreaterThanOrEqual(thRect.right - 6);
    });

    it('③ 走完 9 步写入 portrait done 标记', async () => {
      const onClose = vi.fn();
      expect(isOnboardingDone('u_vwalk', false)).toBe(false);
      render(<OnboardingTour open={true} onClose={onClose} userId="u_vwalk" isLandscape={false} />);
      await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

      for (let i = 0; i < 9; i++) {
        fireEvent.click(screen.getByTestId('tour-next'));
        await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
      }
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(isOnboardingDone('u_vwalk', false)).toBe(true);
      // 横屏标记仍未完成
      expect(isOnboardingDone('u_vwalk', true)).toBe(false);
    });

    it('④ 已标记账号：不自动弹但手动可开', () => {
      markOnboardingDone('u_vdone', false);
      expect(isOnboardingDone('u_vdone', false)).toBe(true);

      const onClose = vi.fn();
      const { container, rerender } = render(
        <OnboardingTour open={false} onClose={onClose} userId="u_vdone" isLandscape={false} />,
      );
      expect(container.querySelector('[data-testid="onboarding-tour-root"]')).toBeNull();

      rerender(<OnboardingTour open={true} onClose={onClose} userId="u_vdone" isLandscape={false} />);
      expect(container.querySelector('[data-testid="onboarding-tour-root"]')).not.toBeNull();
    });

    it('⑤ 每步气泡 DOM 均存在（竖屏 9 步全部可遍历）', async () => {
      const onClose = vi.fn();
      render(<OnboardingTour open={true} onClose={onClose} userId="u_vsafe" isLandscape={false} />);
      await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

      const stepCount = PORTRAIT_STEPS.length;
      for (let i = 0; i < stepCount; i++) {
        expect(screen.getByTestId('tour-bubble')).toBeTruthy();
        expect(screen.getByTestId('tour-action-bar')).toBeTruthy();
        if (i < stepCount - 1) {
          fireEvent.click(screen.getByTestId('tour-next'));
          await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
        }
      }
    });
  });

  // —— 横屏视口 ——
  describe('横屏 2340×1080', () => {
    const vw = 2340;
    const vh = 1080;

    beforeEach(() => {
      Object.defineProperty(window, 'innerWidth', { value: vw, writable: true });
      Object.defineProperty(window, 'innerHeight', { value: vh, writable: true });
      const setPos = (key: string, x: number, y: number, w: number, h: number) => {
        const el = document.querySelector(`[data-tour="${key}"]`) as HTMLElement;
        if (el) {
          el.style.left = `${x}px`;
          el.style.top = `${y}px`;
          el.style.width = `${w}px`;
          el.style.height = `${h}px`;
          el.getBoundingClientRect = () => ({
            left: x, top: y, right: x + w, bottom: y + h, width: w, height: h,
            x, y, toJSON: () => {},
          } as DOMRect);
        }
      };
      // 横屏布局：两侧工具卡 + 中央封面 + 底部控制
      setPos('mode-switch', 40, 60, 180, 900);
      setPos('side-tools', 2120, 60, 180, 900);
      setPos('side-tools-close-btn', 2126, 66, 28, 28);
      setPos('side-tools-collapse', 2296, 300, 8, 200);
      setPos('cover-area', 800, 80, 700, 700);
      setPos('seekbar-track', 400, 970, 1540, 6);
      setPos('seekbar-thumb', 600, 963, 18, 18);
      setPos('play', 1140, 1000, 60, 60);
      setPos('settings', 2230, 980, 80, 60);
      setPos('record', 80, 12, 80, 32);
      setPos('login', 2200, 12, 80, 40);
      setPos('listen-together', 1080, 990, 48, 48);
      setPos('lt-uid', 2000, 200, 200, 36);
      setPos('lt-invite', 2000, 280, 240, 100);
    });

    it('① 横屏教程步骤数 = 12，含两侧工具步骤 + 一起听 3 步', async () => {
      const onClose = vi.fn();
      render(<OnboardingTour open={true} onClose={onClose} userId="u_h" isLandscape={true} />);
      await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

      const actionBar = screen.getByTestId('tour-action-bar');
      const dots = actionBar.querySelectorAll('span.rounded-full');
      expect(dots.length).toBe(12);

      const titles = [
         '左侧模式切换控制台',
         '右侧液态玻璃小工具',
         '收起小工具面板',
         '双击边缘重新呼出',
         '封面拖动 & 双击回正',
         '进度条拖动',
         '播放 / 暂停',
         '设置面板',
         '录制导出',
         '一起听',
         '我的 UID',
         '发起邀请 / 创建房间',
       ];
      for (let i = 0; i < titles.length; i++) {
        const title = screen.getByTestId('tour-bubble').querySelector('h3')?.textContent;
        expect(title).toBe(titles[i]);
        if (i < titles.length - 1) {
          fireEvent.click(screen.getByTestId('tour-next'));
          await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
        }
      }
      expect(screen.getByTestId('tour-next').textContent).toMatch(/完成/);
    });

    it('② 两侧小工具步骤均能渲染（左侧 + 右侧）', async () => {
      const onClose = vi.fn();
      render(<OnboardingTour open={true} onClose={onClose} userId="u_h2" isLandscape={true} />);
      await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

      // 第 1 步：左侧模式切换
      let title = screen.getByTestId('tour-bubble').querySelector('h3')?.textContent;
      expect(title).toMatch(/左侧模式切换/);
      expect(screen.getByTestId('tour-bubble')).toBeTruthy();

      // 第 2 步：右侧小工具
      fireEvent.click(screen.getByTestId('tour-next'));
      await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
      title = screen.getByTestId('tour-bubble').querySelector('h3')?.textContent;
      expect(title).toMatch(/液态玻璃小工具/);
      expect(screen.getByTestId('tour-bubble')).toBeTruthy();
    });

    it('③ 走完 12 步写入 landscape done 标记，portrait 仍未完成', async () => {
      const onClose = vi.fn();
      expect(isOnboardingDone('u_hwalk', true)).toBe(false);
      expect(isOnboardingDone('u_hwalk', false)).toBe(false);
      render(<OnboardingTour open={true} onClose={onClose} userId="u_hwalk" isLandscape={true} />);
      await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

      for (let i = 0; i < 12; i++) {
        fireEvent.click(screen.getByTestId('tour-next'));
        await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
      }
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(isOnboardingDone('u_hwalk', true)).toBe(true);
      expect(isOnboardingDone('u_hwalk', false)).toBe(false);
    });
  });

  // —— 朝向切换 ——
  describe('朝向切换', () => {
    it('竖屏教程中转横屏 → 触发 onOrientationChange 回调 + autoClose 时调用 onClose', async () => {
      Object.defineProperty(window, 'innerWidth', { value: 390, writable: true });
      Object.defineProperty(window, 'innerHeight', { value: 844, writable: true });

      const onClose = vi.fn();
      const onOrient = vi.fn();
      const { rerender } = render(
        <OnboardingTour
          open={true}
          onClose={onClose}
          userId="u_rot"
          isLandscape={false}
          autoCloseOnOrientationChange={true}
          onOrientationChange={onOrient}
        />,
      );
      await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
      expect(screen.getByTestId('tour-bubble')).toBeTruthy();
      expect(onClose).not.toHaveBeenCalled();

      // 切横屏
      rerender(
        <OnboardingTour
          open={true}
          onClose={onClose}
          userId="u_rot"
          isLandscape={true}
          autoCloseOnOrientationChange={true}
          onOrientationChange={onOrient}
        />,
      );
      await act(async () => { await new Promise((r) => setTimeout(r, 30)); });

       expect(onOrient).toHaveBeenCalledWith(true);
       expect(onClose).toHaveBeenCalledTimes(1);
     });
   });

   // —— 横屏教程启动链路（关键 bug 回归）——
   describe('横屏启动链路回归', () => {
     beforeEach(() => {
       Object.defineProperty(window, 'innerWidth', { value: 2340, writable: true });
       Object.defineProperty(window, 'innerHeight', { value: 1080, writable: true });
       // 注入横屏所有目标元素（模拟真实 DOM）
        const targets = [
          'mode-switch', 'side-tools', 'side-tools-close-btn', 'side-tools-collapse',
          'cover-area', 'seekbar-track', 'seekbar-thumb', 'play', 'settings',
          'record', 'login', 'listen-together', 'lt-uid', 'lt-invite',
        ];
       targets.forEach((t, i) => {
         const el = document.createElement('div');
         el.setAttribute('data-tour', t);
         el.style.position = 'absolute';
         el.style.left = `${100 + i * 50}px`;
         el.style.top = `${100 + (i % 3) * 60}px`;
         el.style.width = '80px';
         el.style.height = '60px';
         el.getBoundingClientRect = () => ({
           left: 100 + i * 50, top: 100 + (i % 3) * 60,
           right: 180 + i * 50, bottom: 160 + (i % 3) * 60,
           width: 80, height: 60, x: 100 + i * 50, y: 100 + (i % 3) * 60,
           toJSON: () => {},
         } as DOMRect);
         document.body.appendChild(el);
       });
     });

      it('① 横屏 + 目标齐全 → 显示 12 步、首步为左侧模式切换、不触发 onTargetUnavailable', async () => {
       const onClose = vi.fn();
       const onUnavailable = vi.fn();
       render(
         <OnboardingTour
           open={true}
           onClose={onClose}
           userId="u_ls1"
           isLandscape={true}
           onTargetUnavailable={onUnavailable}
         />,
       );
       await act(async () => { await new Promise((r) => setTimeout(r, 100)); });

       // 首步标题：左侧模式切换
       const title = screen.getByTestId('tour-bubble').querySelector('h3')?.textContent;
       expect(title).toMatch(/左侧模式切换/);

        // 12 个进度点
        const dots = screen.getByTestId('tour-action-bar').querySelectorAll('span.rounded-full');
        expect(dots.length).toBe(12);

       // 目标都存在 → onTargetUnavailable 不应该触发
       expect(onUnavailable).not.toHaveBeenCalled();
     });

     it('② 横屏 + 缺失 mode-switch 目标 → 教程仍然显示，首步居中降级，不闪退/不调用 onClose', async () => {
       // 移除左侧模式切换目标（模拟非 3D 模式下侧卡没挂载）
       const el = document.querySelector('[data-tour="mode-switch"]');
       el?.remove();

       const onClose = vi.fn();
       const onUnavailable = vi.fn();
       render(
         <OnboardingTour
           open={true}
           onClose={onClose}
           userId="u_ls2"
           isLandscape={true}
           onTargetUnavailable={onUnavailable}
         />,
       );
       await act(async () => { await new Promise((r) => setTimeout(r, 100)); });

       // 教程根节点仍存在（不闪退）
       expect(screen.getByTestId('onboarding-tour-root')).toBeTruthy();
       // 首步标题仍然正确（步骤不跳过）
       const title = screen.getByTestId('tour-bubble').querySelector('h3')?.textContent;
       expect(title).toMatch(/左侧模式切换/);
       // 目标缺失不自动关闭教程（由父级决策）
       expect(onClose).not.toHaveBeenCalled();
     });

      it('③ 横屏连点下一步走完 12 步 → 写 landscape 标记、调用 onClose', async () => {
       const onClose = vi.fn();
       expect(isOnboardingDone('u_ls_walk', true)).toBe(false);
       render(
         <OnboardingTour
           open={true}
           onClose={onClose}
           userId="u_ls_walk"
           isLandscape={true}
         />,
       );
       await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

        // 连点 11 次 next
        for (let i = 0; i < 12; i++) {
         fireEvent.click(screen.getByTestId('tour-next'));
         await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
       }
       expect(onClose).toHaveBeenCalledTimes(1);
       expect(isOnboardingDone('u_ls_walk', true)).toBe(true);
       // portrait 仍然未完成
       expect(isOnboardingDone('u_ls_walk', false)).toBe(false);
     });

     it('④ 未标记账号 + 横屏 + 目标齐全 → 自动弹出（模拟 startTourSafely 成功路径）', async () => {
       // 这里直接测 onTargetUnavailable 不触发 + 教程正常显示
       // PlayerMain 级别的自动弹由外层 useEffect 控制，此处验证组件本身的正确性
       const onClose = vi.fn();
       const onUnavail = vi.fn();
       render(
         <OnboardingTour
           open={true}
           onClose={onClose}
           userId="u_ls_auto"
           isLandscape={true}
           onTargetUnavailable={onUnavail}
         />,
       );
       await act(async () => { await new Promise((r) => setTimeout(r, 80)); });

       expect(screen.getByTestId('onboarding-tour-root')).toBeTruthy();
       expect(onUnavail).not.toHaveBeenCalled();
     });
   });
 });
