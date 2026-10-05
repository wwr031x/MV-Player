// 3D 可视化管理器 —— 负责 WebGL 能力检测、three.js 动态懒加载、降级策略
import { logger } from '@lark-apaas/client-toolkit-lite';

export type Visualizer3DMode = 'galaxy3d' | 'sphere3d' | 'ring3d' | 'cover3d' | 'sonic';

let webglSupported: boolean | null = null;
let threeModule: any = null; // 缓存已加载的 three 模块
let threeLoading: Promise<any> | null = null;

/** 检测 WebGL 支持（缓存结果）
 *  注意：不使用 failIfMajorPerformanceCaveat，
 *  因为软件渲染、省电模式、华为部分机型都会被误判为「不支持」。
 *  检测通过 → 正常启用 3D；
 *  检测仍为 null 时 → 不置灰按钮，允许用户尝试，运行时真正失败再降级。
 */
export function checkWebGLSupport(): boolean {
  return getWebGLStatus().supported;
}

interface IWebGLStatus {
  supported: boolean;
  reason: 'ok' | 'disabled' | 'context-create-failed' | 'exception';
  message: string;
  contextType?: string;
  renderer?: string;
}

let webglStatus: IWebGLStatus | null = null;

export function getWebGLStatus(): IWebGLStatus {
  if (webglStatus) return webglStatus;

  const fallback: IWebGLStatus = {
    supported: false,
    reason: 'context-create-failed',
    message: '无法创建 WebGL 上下文',
  };

  try {
    const canvas = document.createElement('canvas');
    let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
    let usedType = '';

    // 宽松检测：依次尝试 webgl2 / webgl / experimental-webgl，antialias 失败再降级
    const contexts: Array<[string, WebGLContextAttributes]> = [
      ['webgl2', { antialias: true, failIfMajorPerformanceCaveat: false }],
      ['webgl2', { antialias: false, failIfMajorPerformanceCaveat: false }],
      ['webgl', { antialias: true, failIfMajorPerformanceCaveat: false }],
      ['webgl', { antialias: false, failIfMajorPerformanceCaveat: false }],
      ['experimental-webgl', { antialias: true, failIfMajorPerformanceCaveat: false }],
      ['experimental-webgl', { antialias: false, failIfMajorPerformanceCaveat: false }],
    ];

    for (const [type, attrs] of contexts) {
      try {
        gl = canvas.getContext(type as 'webgl2' | 'webgl', attrs) as WebGLRenderingContext | null;
        if (gl) { usedType = type; break; }
      } catch { /* ignore, try next */ }
    }

    if (!gl) {
      // 区分原因：getContext 本身存在但返回 null = 硬件加速被禁用/上下文创建失败
      const hasAPI = !!window.WebGLRenderingContext || 'WebGL2RenderingContext' in window;
      if (!hasAPI) {
        webglStatus = { supported: false, reason: 'disabled', message: '浏览器不支持 WebGL（请开启硬件加速）' };
      } else {
        webglStatus = { supported: false, reason: 'context-create-failed', message: 'WebGL 上下文创建失败（可能是硬件加速被关闭或 GPU 不可用）' };
      }
      return webglStatus;
    }

    // 成功：记录渲染器信息
    let renderer = '';
    try {
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      renderer = debugInfo ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)) : '';
      if (renderer && /software|swiftshader|llvmpipe/i.test(renderer)) {
        logger.info('WebGL renderer is software, 3D may be slow:', renderer);
      }
    } catch { /* ignore */ }

    webglStatus = {
      supported: true,
      reason: 'ok',
      message: 'WebGL 可用',
      contextType: usedType,
      renderer: renderer || undefined,
    };
    webglSupported = true;
    return webglStatus;
  } catch (e) {
    logger.warn('WebGL check exception:', String(e));
    webglSupported = false;
    webglStatus = {
      supported: false,
      reason: 'exception',
      message: `WebGL 检测异常：${String(e)}`,
    };
    return webglStatus;
  }
}

/** 重置 WebGL 状态（强制尝试时使用） */
export function resetWebGLStatus(): void {
  webglStatus = null;
  webglSupported = null;
}

/** 动态 import three.js（带缓存和失败处理） */
export async function loadThree(): Promise<any> {
  if (threeModule) return threeModule;
  if (threeLoading) return threeLoading;

  threeLoading = (async () => {
    try {
      const mod = await import('three');
      threeModule = mod;
      logger.info('three.js loaded successfully, version:', mod.REVISION || 'unknown');
      return mod;
    } catch (e) {
      logger.error('Failed to load three.js:', String(e));
      threeModule = null;
      threeLoading = null;
      throw e;
    }
  })();

  return threeLoading;
}

/** 获取移动端性能等级（决定粒子数量等） */
export function getPerformanceTier(): 'low' | 'mid' | 'high' {
  if (typeof window === 'undefined') return 'mid';

  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const cores = navigator.hardwareConcurrency || 4;
  const memory = (navigator as any).deviceMemory || 4;

  if (!isMobile && cores >= 8 && memory >= 8) return 'high';
  if (isMobile && (cores <= 4 || memory <= 2)) return 'low';
  return 'mid';
}

/** 根据性能等级返回粒子数 */
export function getParticleCountForTier(tier: 'low' | 'mid' | 'high', mode: Visualizer3DMode): number {
  const base: Record<Visualizer3DMode, Record<string, number>> = {
    galaxy3d: { low: 3000, mid: 6000, high: 12000 },
    sphere3d: { low: 2000, mid: 4000, high: 8000 },
    ring3d: { low: 1500, mid: 3000, high: 6000 },
    // 封面粒子数量更多才能拼出图像（低性能也给足基本分辨率）
    cover3d: { low: 8000, mid: 16000, high: 32000 },
    // 音域回响（燃料棒）网格数，对应 density 参数
    sonic: { low: 2000, mid: 4000, high: 6400 },
  };
  return base[mode][tier];
}

/** 画质档位 → DPR 映射 @deprecated 未使用，保留待用 */
function _getDPRForQuality(quality: 'low' | 'mid' | 'high' | 'native'): number {
  const native = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  switch (quality) {
    case 'low': return Math.min(0.6, native);
    case 'mid': return Math.min(1.0, native);
    case 'high': return Math.min(1.5, native);
    case 'native': return native;
  }
}

/** 画质档位 → Bloom 强度等级（越高质量越高） @deprecated 未使用，保留待用 */
function _getBloomQuality(quality: 'low' | 'mid' | 'high' | 'native'): number {
  switch (quality) {
    case 'low': return 0.6;
    case 'mid': return 0.9;
    case 'high': return 1.2;
    case 'native': return 1.5;
  }
}

/**
 * 帧率节流包装器
 *  把任意 rAF 渲染循环节流到 targetFps，
 *  用于低端机降帧率省电、或者录制时锁定 30/60fps。
 * @deprecated 未使用，保留待用
 */
function _createFpsThrottler(targetFps: number, render: () => void): () => void {
  let lastTime = 0;
  const interval = 1000 / targetFps;
  let rafId = 0;

  const loop = (t: number) => {
    rafId = requestAnimationFrame(loop);
    const delta = t - lastTime;
    if (delta >= interval) {
      lastTime = t - (delta % interval);
      render();
    }
  };

  rafId = requestAnimationFrame(loop);

  return () => {
    cancelAnimationFrame(rafId);
  };
}

