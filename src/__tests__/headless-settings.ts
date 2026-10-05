/**
 * Headless 渲染验证脚本
 * 挂载真实的 SettingsPanel + EngineeringMenu 组件（不是 mock），
 * 用空存储 / 默认存储断言 FPS 文本渲染出数字、五分区全部可渲染。
 *
 * 用法：node src/__tests__/headless-settings.mjs
 * 退出码 0 = 通过，1 = 失败
 */
import { JSDOM } from 'jsdom';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { logger } from '@lark-apaas/client-toolkit-lite';

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:5173/',
});

const _global = globalThis as any;
_global.window = dom.window;
_global.document = dom.window.document;
Object.defineProperty(_global, 'navigator', { value: dom.window.navigator, writable: true, configurable: true });
Object.defineProperty(_global, 'localStorage', { value: dom.window.localStorage, writable: true, configurable: true });
Object.defineProperty(_global, 'sessionStorage', { value: dom.window.sessionStorage, writable: true, configurable: true });
_global.requestAnimationFrame = (cb: any) => setTimeout(cb, 16);
_global.cancelAnimationFrame = (id: any) => clearTimeout(id);
_global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
_global.IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// 清除所有存储，模拟"全新默认状态"
localStorage.clear();
sessionStorage.clear();

let failed = false;
const errors = [];

process.on('uncaughtException', (err) => {
  errors.push(String(err));
  failed = true;
  logger.error('UNCAUGHT:', err.message);
});
process.on('unhandledRejection', (err) => {
  errors.push(String(err));
  failed = true;
  logger.error('UNHANDLED:', String(err));
});

async function run() {
  logger.info('=== Headless SettingsPanel Render Test ===');
  logger.info('localStorage/sessionStorage 已清空，模拟全新默认状态');

  const container = document.getElementById('root')!;

  // 动态 import（在 DOM 就绪后）
  const SettingsPanel = (await import('../components/SettingsPanel.tsx')).default;
  const EngineeringMenu = (await import('../components/EngineeringMenu.tsx')).default;
  const { DEFAULT_VISUAL } = await import('../lib/defaultSettings.ts');

  const defaultSettings = {
    mode: 'galaxy',
    primaryColor: '#22d3ee',
    secondaryColor: '#a855f7',
    sensitivity: 100,
    targetFps: DEFAULT_VISUAL.targetFps,
    quality: DEFAULT_VISUAL.quality,
    vizScale: 1,
    vizOffsetX: 0,
    vizOffsetY: 0,
    vizRotation: 0,
  };

  const defaultLyric = {
    show: true,
    fontSize: 28,
    translationFontSize: 16,
    lineHeight: 1.4,
    verticalPosition: 80,
    glowIntensity: 40,
    color: '#ffffff',
    showTranslation: true,
  };

  // ========== Test 1: SettingsPanel 默认状态全量渲染 ==========
  logger.info('\n[Test 1] 挂载 SettingsPanel（默认设置）...');
  try {
    await act(async () => {
      const root = createRoot(container);
      root.render(
        React.createElement(SettingsPanel as any, {
          open: true,
          onClose: () => {},
          mode: defaultSettings.mode,
          setMode: () => {},
          primaryColor: defaultSettings.primaryColor,
          setPrimaryColor: () => {},
          secondaryColor: defaultSettings.secondaryColor,
          setSecondaryColor: () => {},
          sensitivity: defaultSettings.sensitivity,
          setSensitivity: () => {},
          targetFps: defaultSettings.targetFps,
          setTargetFps: () => {},
          quality: defaultSettings.quality,
          setQuality: () => {},
          vizScale: defaultSettings.vizScale,
          setVizScale: () => {},
          vizOffsetX: defaultSettings.vizOffsetX,
          setVizOffsetX: () => {},
          vizOffsetY: defaultSettings.vizOffsetY,
          setVizOffsetY: () => {},
          vizRotation: defaultSettings.vizRotation,
          setVizRotation: () => {},
          recordMode: 'webm',
          setRecordMode: () => {},
          isRecording: false,
          onToggleRecord: () => {},
          recordTime: 0,
          webglSupported: false,
          webglError: null,
          onWebglCardClick: () => {},
          onForce3D: () => {},
          onResetAll: () => {},
          lyricSettings: defaultLyric,
          setLyricSettings: () => {},
        })
      );
    });
    logger.info('  ✅ SettingsPanel 渲染成功，无崩溃');
  } catch (e: any) {
    logger.error('  ❌ SettingsPanel 渲染崩溃:', e.message);
    failed = true;
  }

  // ========== Test 2: 五分区全部存在 ==========
  logger.info('\n[Test 2] 检查五分区是否全部渲染...');
  const sectionIds = ['sec-visual', 'sec-performance', 'sec-frame', 'sec-lyric', 'sec-record'];
  sectionIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      logger.info(`  ✅ 分区 ${id} 存在`);
    } else {
      logger.info(`  ❌ 分区 ${id} 未找到`);
      failed = true;
    }
  });

  // ========== Test 3: FPS 数字渲染 ==========
  logger.info('\n[Test 3] 检查 FPS 数字是否正确渲染...');
  const html = container.innerHTML;
  const fpsMatches = html.match(/(\d+)fps/g);
  if (fpsMatches && fpsMatches.length > 0) {
    logger.info(`  ✅ 找到 FPS 文本: ${fpsMatches.join(', ')}`);
  } else {
    logger.info('  ❌ 未找到任何 FPS 数字文本');
    failed = true;
  }

  if (html.includes('当前生效参数')) {
    logger.info('  ✅ "当前生效参数"面板已渲染');
  } else {
    logger.info('  ❌ "当前生效参数"面板未找到');
    failed = true;
  }

  // ========== Test 4: quality 非法值时仍能渲染 ==========
  logger.info('\n[Test 4] quality/targetFps 为非法值时是否仍能渲染...');
  try {
    container.innerHTML = '';
    await act(async () => {
      const root = createRoot(container);
      root.render(
        React.createElement(SettingsPanel as any, {
          open: true,
          onClose: () => {},
          mode: 'INVALID_MODE',
          setMode: () => {},
          primaryColor: defaultSettings.primaryColor,
          setPrimaryColor: () => {},
          secondaryColor: defaultSettings.secondaryColor,
          setSecondaryColor: () => {},
          sensitivity: defaultSettings.sensitivity,
          setSensitivity: () => {},
          targetFps: null,
          setTargetFps: () => {},
          quality: 'INVALID_QUALITY',
          setQuality: () => {},
          vizScale: NaN,
          setVizScale: () => {},
          vizOffsetX: 0,
          setVizOffsetX: () => {},
          vizOffsetY: 0,
          setVizOffsetY: () => {},
          vizRotation: 0,
          setVizRotation: () => {},
          recordMode: 'webm',
          setRecordMode: () => {},
          isRecording: false,
          onToggleRecord: () => {},
          recordTime: 0,
          webglSupported: false,
          webglError: null,
          onWebglCardClick: () => {},
          onForce3D: () => {},
          onResetAll: () => {},
          lyricSettings: null,
          setLyricSettings: () => {},
        })
      );
    });
    const html2 = container.innerHTML;
    if (html2.length > 100) {
      logger.info('  ✅ 非法值下仍有渲染内容（ErrorBoundary 兜底生效）');
    } else {
      logger.info('  ⚠️  非法值下渲染内容很少');
    }
  } catch (e: any) {
    logger.error('  ❌ 非法值下整页崩溃（ErrorBoundary 未生效）:', e.message);
    failed = true;
  }

  // ========== Test 5: EngineeringMenu 默认 null snapshot ==========
  logger.info('\n[Test 5] EngineeringMenu 默认 null snapshot 渲染...');
  try {
    container.innerHTML = '';
    await act(async () => {
      const root = createRoot(container);
      root.render(
        React.createElement(EngineeringMenu as any, {
          open: true,
          onClose: () => {},
        })
      );
    });
    const html3 = container.innerHTML;
    if (html3.includes('Diagnostic') || html3.includes('性能档位') || html3.includes('帧率')) {
      logger.info('  ✅ EngineeringMenu 初始 null snapshot 下成功渲染');
    } else {
      logger.info('  ⚠️  EngineeringMenu 渲染但内容有限');
    }
  } catch (e: any) {
    logger.error('  ❌ EngineeringMenu 初始状态崩溃:', e.message);
    failed = true;
  }

  // ========== 结果 ==========
  logger.info('\n' + (failed ? '❌' : '✅') + ' 测试完成');
  if (errors.length > 0) {
    logger.info('捕获到的错误:');
    errors.forEach((e, i) => logger.info(`  [${i}] ${e}`));
  }

  process.exit(failed ? 1 : 0);
}

run().catch(e => {
  logger.error('Test runner crashed:', String(e));
  process.exit(1);
});
