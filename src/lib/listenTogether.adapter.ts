// 一起听通道适配器
//
// 核心原则：绝不阻塞首屏。
// 所有具体通道实现（WS / P2P / Supabase）均通过动态 import 懒加载，
// 首屏模块图完全不含这些依赖，避免任何第三方库加载失败导致整页白屏。
//
// 上层 Context 只依赖适配器，不直接依赖具体实现。

import { logger } from '@lark-apaas/client-toolkit-lite';

export type { IRoomMember, IRoomState, IInvite, IListenTogetherUser } from './listenTogether.ws';
export { updateLocalUser, getLocalUser } from './listenTogether.user';

/** 通道类型 */
export type TransportType = 'websocket' | 'webrtc' | 'supabase';

/** 统一服务接口（用 interface 声明，不依赖具体实现类的类型） */
export interface IListenTogetherService {
  connect: () => Promise<boolean>;
  disconnect: () => void;
  isConnected: () => boolean;
  getConnStatus: () => string;
  on: (event: string, handler: (...args: any[]) => void) => void;
  off: (event: string, handler: (...args: any[]) => void) => void;
  createRoom: () => Promise<string>;
  joinRoom: (roomId: string) => Promise<boolean>;
  leaveRoom: () => Promise<void>;
  getRoom: () => any;
  getMembers: () => any[];
  getMyUid: () => string;
  isHost: () => boolean;
  sendMessage: (msg: any) => void;
  inviteUser: (targetUid: string) => Promise<{ success: boolean; message: string; invite?: any }>;
  replyInvite: (inviteId: string, accepted: boolean) => Promise<void>;
  getInvites: () => any[];
  isUserOnline: (uid: string) => Promise<boolean>;
  getOnlineUserInfo: (uid: string) => any;
  setLocalTrack: (track: any, isPlaying: boolean, currentTime: number) => void;
  setHostPlayState: (isPlaying: boolean, currentTime: number) => void;
  requestSync: () => void;
  kickMember?: (uid: string) => void;
  transferHost?: (uid: string) => void;
  updateMember?: (patch: any) => void;
  getWsUrl?: () => string;
  /** 设置网易云登录信息（登录传对象，登出传 null） */
  setNeteaseInfo?: (info: { userId: number; nickname: string; avatarUrl: string } | null) => void;
}

// ===== 通道检测 =====

let cachedType: TransportType | null = null;

/**
 * 检测当前应使用的通道类型
 * 规则：
 * 1. URL 含参数 ?transport=p2p/ws/supabase → 强制使用
 * 2. 否则默认 Supabase（所有环境统一使用，最稳定）
 */
export function detectTransportType(): TransportType {
  if (cachedType) return cachedType;

  // URL 参数强制
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    const forced = params.get('transport');
    if (forced === 'p2p') {
      cachedType = 'webrtc';
      return cachedType;
    }
    if (forced === 'ws' || forced === 'websocket') {
      cachedType = 'websocket';
      return cachedType;
    }
    if (forced === 'supabase' || forced === 'sb') {
      cachedType = 'supabase';
      return cachedType;
    }
  }

  // 默认 Supabase
  cachedType = 'supabase';
  return cachedType;
}

// ===== 懒加载服务实例 =====

let cachedService: IListenTogetherService | null = null;
let loadingPromise: Promise<IListenTogetherService> | null = null;

async function loadService(type: TransportType): Promise<IListenTogetherService> {
  try {
    if (type === 'websocket') {
      const mod = await import('./listenTogether.ws');
      return mod.getListenTogetherService() as unknown as IListenTogetherService;
    }
    if (type === 'webrtc') {
      const mod = await import('./listenTogether.p2p');
      return mod.getP2PListenTogetherService() as unknown as IListenTogetherService;
    }
    // supabase (default)
    const mod = await import('./listenTogether.supabase');
    return mod.getSupabaseListenTogetherService() as unknown as IListenTogetherService;
  } catch (err) {
    logger.error('[Transport] failed to load ' + type + ' module: ' + String(err));
    // 懒加载失败抛给上层，由 Context 降级为"未连接"状态，绝不阻塞首屏
    throw err;
  }
}

/**
 * 异步获取当前环境对应的一起听服务实例（懒加载）
 * 首次调用会动态 import 对应模块，失败抛错由上层 catch 降级
 */
export async function getListenTransportService(): Promise<IListenTogetherService> {
  if (cachedService) return cachedService;
  if (loadingPromise) return loadingPromise;

  const type = detectTransportType();
  loadingPromise = loadService(type).then((svc) => {
    cachedService = svc;
    loadingPromise = null;
    logger.info('[Transport] using ' + type + ' transport');
    return svc;
  }).catch((err) => {
    loadingPromise = null;
    throw err;
  });

  return loadingPromise;
}

/** 同步获取当前已加载的服务实例（可能为 null） */
export function getListenTransportServiceSync(): IListenTogetherService | null {
  return cachedService;
}

/** 获取当前通道类型（用于 UI 展示，不触发加载） */
export function getCurrentTransportType(): TransportType {
  return detectTransportType();
}

/**
 * 强制切换通道（仅用于调试/演示，会丢弃现有连接）
 * 异步动态加载新模块
 */
export async function forceTransportType(type: TransportType): Promise<IListenTogetherService> {
  // 清理旧实例
  if (cachedService) {
    try {
      cachedService.disconnect?.();
    } catch { /* ignore */ }
    cachedService = null;
  }
  loadingPromise = null;
  cachedType = type;
  const svc = await loadService(type);
  cachedService = svc;
  logger.info('[Transport] forced to ' + type);
  return svc;
}
