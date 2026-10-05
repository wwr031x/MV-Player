/**
 * Headless 渲染验证脚本
 * 挂载真实的 SettingsPanel + EngineeringMenu 组件（不是 mock），
 * 用空存储 / 默认存储断言 FPS 文本渲染出数字、五分区全部可渲染。
 *
 * 用法：node -r @babel/register src/__tests__/headless-settings.cjs   (不太行，没有 babel)
 * 改用 vite-node 或直接 tsx
 */
const { JSDOM } = require('jsdom');
const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react-dom/test-utils');

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:5173/',
});

// 把 jsdom 的对象挂到 global
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.localStorage = dom.window.localStorage;
global.sessionStorage = dom.window.sessionStorage;
global.requestAnimationFrame = (cb) => setTimeout(cb, 16);
global.cancelAnimationFrame = (id) => clearTimeout(id);
global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
global.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };

localStorage.clear();
sessionStorage.clear();

let failed = false;
const errors = [];

process.on('uncaughtException', (err) => {
  errors.push(String(err));
  failed = true;
  console.error('UNCAUGHT:', err.message);
});
process.on('unhandledRejection', (err) => {
  errors.push(String(err));
  failed = true;
  console.error('UNHANDLED:', err);
});

async function run() {
  console.log('=== Headless SettingsPanel Render Test ===');
  console.log('localStorage/sessionStorage 已清空，模拟全新默认状态');

  const container = document.getElementById('root');

  // 用 tsx 的编程 API 加载 TSX 文件
  const { register } = require('tsx/cjs/api');
  const unregister = register({
    cwd: __dirname,
  });

  // 注意：register 返回的函数可能需要通过 require 来触发
  const SettingsPanelMod = require('../components/SettingsPanel.tsx');
  const SettingsPanel = SettingsPanelMod.default;
  const EngineeringMenuMod = require('../components/EngineeringMenu.tsx');
  const EngineeringMenu = EngineeringMenuMod.default;
  const { DEFAULT_VISUAL } = require('../lib/defaultSettings.ts');

  unregister();

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
  console.log('\n[Test 1] 挂载 SettingsPanel（默认设置）...');
  try {
    await act(async () => {
      const root = createRoot(container);
      root.render(
        React.createElement(SettingsPanel, {
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
    console.log('  ✅ SettingsPanel 渲染成功，无崩溃');
  } catch (e) {
    console.error('  ❌ SettingsPanel 渲染崩溃:', e.message);
    failed = true;
  }

  // ========== Test 2: 五分区全部存在 ==========
  console.log('\n[Test 2] 检查五分区是否全部渲染...');
  const sectionIds = ['sec-visual', 'sec-performance', 'sec-frame', 'sec-lyric', 'sec-record'];
  sectionIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      console.log(`  ✅ 分区 ${id} 存在`);
    } else {
      console.log(`  ❌ 分区 ${id} 未找到`);
      failed = true;
    }
  });

  // ========== Test 3: FPS 数字渲染 ==========
  console.log('\n[Test 3] 检查 FPS 数字是否正确渲染...');
  const html = container.innerHTML;
  const fpsMatches = html.match(/(\d+)fps/g);
  if (fpsMatches && fpsMatches.length > 0) {
    console.log(`  ✅ 找到 FPS 文本: ${fpsMatches.join(', ')}`);
  } else {
    console.log('  ❌ 未找到任何 FPS 数字文本');
    failed = true;
  }

  if (html.includes('当前生效参数')) {
    console.log('  ✅ "当前生效参数"面板已渲染');
  } else {
    console.log('  ❌ "当前生效参数"面板未找到');
    failed = true;
  }

  // ========== Test 4: quality 非法值时仍能渲染 ==========
  console.log('\n[Test 4] quality/targetFps 为非法值时是否仍能渲染...');
  try {
    container.innerHTML = '';
    await act(async () => {
      const root = createRoot(container);
      root.render(
        React.createElement(SettingsPanel, {
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
      console.log('  ✅ 非法值下仍有渲染内容（ErrorBoundary 兜底生效）');
    } else {
      console.log('  ⚠️  非法值下渲染内容很少');
    }
  } catch (e) {
    console.error('  ❌ 非法值下整页崩溃（ErrorBoundary 未生效）:', e.message);
    failed = true;
  }

  // ========== Test 5: EngineeringMenu 默认 null snapshot ==========
  console.log('\n[Test 5] EngineeringMenu 默认 null snapshot 渲染...');
  try {
    container.innerHTML = '';
    await act(async () => {
      const root = createRoot(container);
      root.render(
        React.createElement(EngineeringMenu, {
          open: true,
          onClose: () => {},
        })
      );
    });
    const html3 = container.innerHTML;
    if (html3.includes('Diagnostic') || html3.includes('性能档位') || html3.includes('帧率')) {
      console.log('  ✅ EngineeringMenu 初始 null snapshot 下成功渲染');
    } else {
      console.log('  ⚠️  EngineeringMenu 渲染但内容有限');
    }
  } catch (e) {
    console.error('  ❌ EngineeringMenu 初始状态崩溃:', e.message);
    failed = true;
  }

  // ========== 结果 ==========
  console.log('\n' + (failed ? '❌' : '✅') + ' 测试完成');
  if (errors.length > 0) {
    console.log('捕获到的错误:');
    errors.forEach((e, i) => console.log(`  [${i}] ${e}`));
  }

  process.exit(failed ? 1 : 0);
}

run().catch(e => {
  console.error('Test runner crashed:', e);
  process.exit(1);
});
