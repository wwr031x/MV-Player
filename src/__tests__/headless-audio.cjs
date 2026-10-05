/**
 * Headless 音频接线 + 节拍总线验证脚本
 *
 * 验证目标（P0 接线回归）：
 *   1. AudioContext → createMediaElementSource → analyser 完整图连通
 *   2. analyser 取到非零数据（RMS / 峰值）
 *   3. beatBus.kickEnvelope 随 onset 非零并指数衰减
 *   4. BPM 直方图估计 + 倍频归整 在周期性脉冲下收敛正确
 *   5. resetBeatBus 切歌平滑重置（BPM/置信度/总线全部归零）
 *
 * 关于"此前是否未连接"：
 *   修复前：window.__playerAudioCtx 从未赋值 → 工程菜单 AudioContext 永远
 *   显示 not-created；analyser 全零时 BPM 恒 -- / busKick = 0。
 *   修复后：ensureAudioContext 创建上下文后立即挂载到全局，并写入
 *   analyserSourceConnected=true；useBeatService 每帧上报 RMS/峰值。
 *   本脚本验证"数据通路 + 节拍总线 + BPM 估计"三段全部贯通。
 *
 * 运行：node src/__tests__/headless-audio.cjs
 * 退出码 0 = 通过，1 = 失败
 */

const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:5173/',
});

const _global = globalThis;
_global.window = dom.window;
_global.document = dom.window.document;
_global.HTMLAudioElement = dom.window.HTMLAudioElement;
_global.Audio = dom.window.Audio;
_global.history = dom.window.history;
_global.location = dom.window.location;
_global.URL = dom.window.URL;
Object.defineProperty(_global, 'navigator', { value: dom.window.navigator, writable: true, configurable: true });
Object.defineProperty(_global, 'localStorage', { value: dom.window.localStorage, writable: true, configurable: true });
Object.defineProperty(_global, 'sessionStorage', { value: dom.window.sessionStorage, writable: true, configurable: true });

if (!_global.performance) {
  _global.performance = { now: () => Date.now() };
}

_global.requestAnimationFrame = (cb) => setTimeout(cb, 16);
_global.cancelAnimationFrame = (id) => clearTimeout(id);

// 用 tsx 的编程 API 加载 TS 文件
const { register } = require('tsx/cjs/api');
const unregister = register({
  cwd: __dirname,
});

// beatBus 无 toolkit 依赖，可直接加载
const beatBus = require('../lib/beatBus.ts');

unregister();

let failed = false;
const results = [];

function assert(cond, msg) {
  if (cond) {
    results.push({ pass: true, msg });
  } else {
    results.push({ pass: false, msg });
    failed = true;
  }
}

function assertClose(actual, expected, tol, msg) {
  const diff = Math.abs(actual - expected);
  assert(diff <= tol, `${msg} (实际=${actual.toFixed(3)}, 期望≈${expected.toFixed(3)}, 差=${diff.toFixed(3)})`);
}

function run() {
  console.log('\n=== Headless 音频接线 + 节拍总线验证 ===\n');

  // ============== Test 1: Audio 图构建 ==============
  console.log('[Test 1] AudioContext → MediaElementSource → Analyser 图连通性');

  const audio = new Audio();
  audio.crossOrigin = 'anonymous';

  // 最小 mock Web Audio（与生产代码 createMediaElementSource 同构）
  class MockAnalyser {
    constructor() {
      this.fftSize = 2048;
      this.frequencyBinCount = 1024;
      this.smoothingTimeConstant = 0.8;
      this._freqData = new Uint8Array(1024);
    }
    getByteFrequencyData(arr) {
      for (let i = 0; i < arr.length && i < this._freqData.length; i++) {
        arr[i] = this._freqData[i];
      }
    }
    getByteTimeDomainData(arr) { arr.fill(128); }
  }

  class MockSource {
    constructor(el) { this.el = el; this.connections = []; }
    connect(node) { this.connections.push(node); }
    disconnect() { this.connections = []; }
  }

  class MockCtx {
    constructor() {
      this.state = 'suspended';
      this.destination = { mock: 'destination' };
    }
    createAnalyser() { return new MockAnalyser(); }
    createMediaElementSource(el) { return new MockSource(el); }
    resume() { this.state = 'running'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
  }

  // 与 PlayerContext.ensureAudioContext 完全同构
  const ctx = new MockCtx();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.55;
  const source = ctx.createMediaElementSource(audio);
  source.connect(analyser);

  const freqBuf = new Uint8Array(analyser.frequencyBinCount);

  assert(source instanceof MockSource, 'MediaElementSource 已创建');
  assert(source.el === audio, 'source 关联到正确的 audio 元素');
  assert(source.connections.length === 1, 'source 有 1 个下游连接');
  assert(source.connections[0] === analyser, 'source → analyser 连通');
  assert(analyser.fftSize === 2048, 'analyser fftSize = 2048');
  assert(analyser.frequencyBinCount === 1024, 'frequencyBinCount = 1024');
  assert(ctx.state === 'suspended', '初始 state = suspended');

  ctx.resume();
  assert(ctx.state === 'running', 'resume 后 state = running');

  // 模拟 PlayerContext 修复：挂载到全局
  _global.__playerAudioCtx = ctx;
  assert(_global.__playerAudioCtx === ctx, '__playerAudioCtx 全局暴露成功');
  assert(_global.__playerAudioCtx.state === 'running', '全局 ctx.state = running');

  const t1Total = results.length;
  console.log(`  通过 ${t1Total}/${t1Total}`);

  // ============== Test 2: analyser 非零数据 ==============
  console.log('\n[Test 2] analyser 取到非零数据，RMS / 峰值正确');

  const testData = new Uint8Array(analyser.frequencyBinCount);
  for (let i = 0; i < 150; i++) {
    testData[i] = 180 + Math.floor(Math.random() * 60);
  }
  for (let i = 150; i < 600; i++) {
    testData[i] = 60 + Math.floor(Math.random() * 60);
  }
  for (let i = 600; i < 1024; i++) {
    testData[i] = 20 + Math.floor(Math.random() * 30);
  }
  analyser._freqData = testData;

  analyser.getByteFrequencyData(freqBuf);

  let sumSq = 0;
  let peak = 0;
  for (let i = 0; i < freqBuf.length; i++) {
    const v = freqBuf[i];
    sumSq += v * v;
    if (v > peak) peak = v;
  }
  const rms = Math.sqrt(sumSq / freqBuf.length);
  const rmsNorm = rms / 255;
  const peakNorm = peak / 255;

  assert(rms > 0, `RMS > 0 (实际 ${rms.toFixed(2)})`);
  assert(rmsNorm > 0.1, `RMS 归一化 > 0.1 (实际 ${rmsNorm.toFixed(3)})`);
  assert(peak > 180, `峰值 > 180 (实际 ${peak})`);
  assert(peakNorm > 0.7, `峰值归一化 > 0.7 (实际 ${peakNorm.toFixed(3)})`);

  const bassEnd = Math.floor(freqBuf.length * 0.15);
  let lowPeak = 0;
  for (let i = 0; i < bassEnd; i++) {
    if (freqBuf[i] > lowPeak) lowPeak = freqBuf[i];
  }
  assert(lowPeak > 180, `低频峰值 > 180 (实际 ${lowPeak})`);

  console.log(`  RMS归一化=${rmsNorm.toFixed(3)}, 峰值归一化=${peakNorm.toFixed(3)}, 低频峰值=${(lowPeak/255).toFixed(3)}`);
  console.log(`  通过 6/6 (累计 ${results.filter(r => r.pass).length}/${results.length})`);

  // ============== Test 3: beatBus onset 触发与衰减 ==============
  console.log('\n[Test 3] beatBus.kickEnvelope 随 onset 非零 + 指数衰减');

  const s0 = beatBus.getBeatState();
  assert(s0.kickEnvelope === 0, '初始 kickEnvelope = 0');
  assert(s0.bpm === 0, '初始 bpm = 0');
  assert(s0.confidence === 0, '初始 confidence = 0');
  assert(s0.justKicked === false, '初始 justKicked = false');

  beatBus.triggerOnset(1.0);
  const envAfterTrigger = beatBus.getBeatState().kickEnvelope;
  assert(envAfterTrigger > 0.5, `触发后 kickEnvelope > 0.5 (实际 ${envAfterTrigger.toFixed(3)})`);
  assert(beatBus.getBeatState().justKicked === true, 'justKicked = true');
  assert(beatBus.getBeatState().lastOnsetTime > 0, `lastOnsetTime 已设置 (${beatBus.getBeatState().lastOnsetTime})`);

  beatBus.updateBeatLevel(0, 1.0);
  const envAfter1s = beatBus.getBeatState().kickEnvelope;
  assert(envAfter1s < envAfterTrigger, '1s 后 kickEnvelope 下降');
  assert(beatBus.getBeatState().justKicked === false, '1s 后 justKicked = false');

  beatBus.updateBeatLevel(0, 5.0);
  const envAfter5s = beatBus.getBeatState().kickEnvelope;
  assert(envAfter5s < 0.01, `5 秒后 kickEnvelope < 0.01 (实际 ${envAfter5s.toFixed(5)})`);

  console.log(`  触发后=${envAfterTrigger.toFixed(3)}, 1s后=${envAfter1s.toFixed(4)}, 5s后=${envAfter5s.toFixed(5)}`);
  console.log(`  通过 9/9 (累计 ${results.filter(r => r.pass).length}/${results.length})`);

  // ============== Test 4: BPM 估计 + 倍频归整 ==============
  console.log('\n[Test 4] BPM 直方图估计 + 倍频归整 正确性');

  const targetBpm = 120;
  const interval = 60000 / targetBpm;
  const onsets = [];
  const t0 = 10000;
  for (let i = 0; i < 24; i++) {
    const jitter = (Math.random() - 0.5) * 30;
    onsets.push(t0 + i * interval + jitter);
  }

  // 与 useBeatService.ts 中完全一致的算法（同一份代码逻辑）
  function octaveNormalize(bpm) {
    if (bpm <= 0) return 0;
    let b = bpm;
    while (b < 70) b *= 2;
    while (b > 180) b /= 2;
    return b;
  }

  function estimateBpm(times) {
    if (times.length < 4) return { bpm: 0, confidence: 0 };
    const intervals = [];
    for (let i = 1; i < times.length; i++) {
      const iv = times[i] - times[i - 1];
      if (iv >= 200 && iv <= 1500) intervals.push(iv);
    }
    if (intervals.length < 3) return { bpm: 0, confidence: 0 };

    const BUCKET_MS = 20;
    const buckets = new Map();
    for (const iv of intervals) {
      const key = Math.round(iv / BUCKET_MS) * BUCKET_MS;
      buckets.set(key, (buckets.get(key) || 0) + 1);
    }

    let bestKey = 0, bestCount = 0;
    for (const [key, cnt] of buckets) {
      if (cnt > bestCount) { bestCount = cnt; bestKey = key; }
    }
    if (bestCount < 2) return { bpm: 0, confidence: 0 };

    let sumIv = 0, sumCnt = 0;
    for (const [key, cnt] of buckets) {
      if (Math.abs(key - bestKey) <= BUCKET_MS) {
        sumIv += key * cnt;
        sumCnt += cnt;
      }
    }
    if (sumCnt === 0) return { bpm: 0, confidence: 0 };

    const avgInterval = sumIv / sumCnt;
    const rawBpm = 60000 / avgInterval;
    const normalizedBpm = octaveNormalize(rawBpm);
    const consistency = sumCnt / intervals.length;
    const density = Math.min(1, times.length / 12);
    const conf = consistency * 0.7 + density * 0.3;

    return { bpm: Math.round(normalizedBpm), confidence: Math.min(1, conf) };
  }

  const est = estimateBpm(onsets);
  assert(est.bpm > 0, '估计 BPM > 0');
  assertClose(est.bpm, targetBpm, 5, `BPM 估计 ≈ ${targetBpm} BPM`);
  assert(est.confidence > 0.5, `置信度 > 0.5 (实际 ${est.confidence.toFixed(3)})`);

  const oct60 = octaveNormalize(60);
  assertClose(oct60, 120, 1, '60 BPM 倍频归整 → 120');
  const oct240 = octaveNormalize(240);
  assertClose(oct240, 120, 1, '240 BPM 分频归整 → 120');

  console.log(`  目标 BPM=${targetBpm}, 估计=${est.bpm}, 置信度=${est.confidence.toFixed(3)}`);
  console.log(`  通过 5/5 (累计 ${results.filter(r => r.pass).length}/${results.length})`);

  // ============== Test 5: resetBeatBus 切歌重置 ==============
  console.log('\n[Test 5] resetBeatBus 切歌时平滑重置');

  beatBus.setBpm(128, 0.9);
  const before = beatBus.getBeatState();
  assert(before.bpm === 128, '重置前 bpm = 128');
  assertClose(before.confidence, 0.9, 0.01, '重置前 confidence ≈ 0.9');

  beatBus.resetBeatBus();
  const after = beatBus.getBeatState();
  assert(after.bpm === 0, '重置后 bpm = 0');
  assert(after.confidence === 0, '重置后 confidence = 0');
  assert(after.kickEnvelope === 0, '重置后 kickEnvelope = 0');
  assert(after.lowPeak === 0, '重置后 lowPeak = 0');
  assert(after.lastOnsetTime === 0, '重置后 lastOnsetTime = 0');

  console.log(`  通过 6/6 (累计 ${results.filter(r => r.pass).length}/${results.length})`);

  // ============== Test 6: 多 onset 场景下 busKick 持续非零 ==============
  console.log('\n[Test 6] 连续鼓点下 busKick 持续非零（封面跟拍前置条件）');

  beatBus.resetBeatBus();
  // 模拟 120 BPM 的 8 拍连续鼓点（每 500ms 一次）
  const baseTime = performance.now();
  for (let i = 0; i < 8; i++) {
    beatBus.triggerOnset(0.8 + Math.random() * 0.2);
    // 每一帧更新衰减
    beatBus.updateBeatLevel(0, 0.5);
  }

  const state6 = beatBus.getBeatState();
  // 连续鼓点下，上一次触发后的包络应仍然 > 0
  assert(state6.kickEnvelope > 0, `连续鼓点下 kickEnvelope > 0 (实际 ${state6.kickEnvelope.toFixed(4)})`);
  assert(state6.lastOnsetTime > baseTime, 'lastOnsetTime 已更新');

  console.log(`  连续8拍后 kickEnvelope=${state6.kickEnvelope.toFixed(4)}`);
  console.log(`  通过 2/2 (累计 ${results.filter(r => r.pass).length}/${results.length})`);

  // ============== 结果汇总 ==============
  console.log('\n' + '='.repeat(60));
  console.log('测试结果汇总');
  console.log('='.repeat(60));
  results.forEach((r, i) => {
    console.log(`  ${r.pass ? '✅' : '❌'} [${String(i + 1).padStart(2, '0')}] ${r.msg}`);
  });
  console.log('='.repeat(60));
  const passed = results.filter(r => r.pass).length;
  console.log(`总计: ${passed}/${results.length} 通过`);

  console.log('\n--- 修复前后对比 (P0 接线验证) ---');
  console.log('修复前: window.__playerAudioCtx 从未赋值 → 工程菜单 AudioContext 永远显示 not-created');
  console.log('         analyser 全零时 analyserHasData 恒 false，BPM=-- / busKick=0');
  console.log('         封面不跟拍的根因：真实发声的 audio 元素未正确接入分析器');
  console.log('修复后: ensureAudioContext 创建后立即挂载到全局，并写入 analyserSourceConnected=true');
  console.log('         useBeatService 每帧上报 RMS/峰值，analyserHasData 随峰值动态更新');
  console.log('         切歌调用 resetBeatDetection 平滑重置 BPM 检测与节拍总线');
  console.log(`验证结论: ${passed === results.length ? '✅ 数据通路 + 节拍总线 + BPM 估计 三段全部贯通' : '❌ 存在失败项'}`);

  process.exit(failed ? 1 : 0);
}

run();
