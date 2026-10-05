//
// 一起听弹幕系统（本地存储 + 渲染调度 + 轨道管理）
// - 实时弹幕通过 Supabase Broadcast 接收
// - 历史消息只存本地 localStorage，随房间关闭清除
// - 轨道分层避免重叠，最多 8 条轨道
//

import { scopedStorage, logger } from '@lark-apaas/client-toolkit-lite';
import type { IDanmakuMessage } from '@/types';

// 本地存储 key 前缀（按房间隔离）
const HISTORY_KEY_PREFIX = 'lt_chat_history_';
// 每个房间最多保留历史消息数
const MAX_HISTORY_PER_ROOM = 200;
// 弹幕轨道数
const DANMAKU_TRACKS = 8;
// 弹幕速度（像素/秒，屏幕宽度约 12-15s 飘完，保证能看清）
const DANMAKU_SPEED = 120;
// 每条弹幕最小间隔（秒），同一轨道不重叠（调大降低密度）
const MIN_TRACK_GAP = 0.8;

// ========== 历史消息存储 ==========

export function getChatHistory(roomId: string): IDanmakuMessage[] {
  try {
    const raw = scopedStorage.getItem(HISTORY_KEY_PREFIX + roomId);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.slice(-MAX_HISTORY_PER_ROOM);
  } catch (e) {
    logger.warn('[Danmaku] get history failed:', String(e));
    return [];
  }
}

export function appendChatHistory(roomId: string, msg: IDanmakuMessage): void {
  try {
    const history = getChatHistory(roomId);
    history.push(msg);
    const trimmed = history.slice(-MAX_HISTORY_PER_ROOM);
    scopedStorage.setItem(HISTORY_KEY_PREFIX + roomId, JSON.stringify(trimmed));
  } catch (e) {
    logger.warn('[Danmaku] append history failed:', String(e));
  }
}

export function clearChatHistory(roomId: string): void {
  try {
    scopedStorage.removeItem(HISTORY_KEY_PREFIX + roomId);
  } catch (e) {
    logger.warn('[Danmaku] clear history failed:', String(e));
  }
}

// ========== 弹幕渲染引擎 ==========
// 负责：维护当前在飞弹幕列表、分配轨道、计算位置、触发重绘

export interface IFlyingDanmaku extends IDanmakuMessage {
  /** 当前 x 坐标（容器内像素，从右往左飘） */
  x: number;
  /** 轨道 index (0 ~ DANMAKU_TRACKS-1) */
  track: number;
  /** 预计宽度（像素，用于判断何时完全飞出） */
  width: number;
  /** 进入屏幕时间（performance.now） */
  enterAt: number;
}

export class DanmakuEngine {
  private containerWidth = 0;
  private containerHeight = 0;
  private flying: IFlyingDanmaku[] = [];
  // 每条轨道下次可用时间（performance.now 毫秒数）
  private trackAvailableAt: number[] = new Array(DANMAKU_TRACKS).fill(0);
  private rafId: number | null = null;
  private onTick: (list: IFlyingDanmaku[]) => void;
  private running = false;

  constructor(onTick: (list: IFlyingDanmaku[]) => void) {
    this.onTick = onTick;
  }

  setSize(width: number, height: number) {
    this.containerWidth = Math.max(0, width);
    this.containerHeight = Math.max(0, height);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.trackAvailableAt = new Array(DANMAKU_TRACKS).fill(0);
    this.loop();
  }

  stop() {
    this.running = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.flying = [];
  }

  /** 发射一条新弹幕，返回是否成功发射（轨道不足会丢弃） */
  emit(msg: IDanmakuMessage, estimatedWidth: number): boolean {
    if (this.containerWidth <= 0 || !this.running) return false;

    const now = performance.now();
    // 找一条最早可用的轨道
    let bestTrack = 0;
    let bestTime = this.trackAvailableAt[0];
    for (let i = 1; i < DANMAKU_TRACKS; i++) {
      if (this.trackAvailableAt[i] < bestTime) {
        bestTime = this.trackAvailableAt[i];
        bestTrack = i;
      }
    }

    // 如果所有轨道都忙，就丢弹幕（宁可丢也不重叠）
    if (bestTime > now + 2000) {
      // 超过 2s 都没空闲，直接丢
      return false;
    }

    const flyDuration = (this.containerWidth + estimatedWidth) / DANMAKU_SPEED * 1000;
    this.trackAvailableAt[bestTrack] = Math.max(now, bestTime) + MIN_TRACK_GAP * 1000 + (estimatedWidth / DANMAKU_SPEED * 1000) * 0.6;

    const item: IFlyingDanmaku = {
      ...msg,
      x: this.containerWidth,
      track: bestTrack,
      width: estimatedWidth,
      enterAt: now,
    };
    this.flying.push(item);
    return true;
  }

  private loop = () => {
    if (!this.running) return;
    const now = performance.now();
    const w = this.containerWidth;

    // 更新位置 + 清理已飞出的
    const alive: IFlyingDanmaku[] = [];
    for (const d of this.flying) {
      const elapsed = (now - d.enterAt) / 1000;
      const newX = w - elapsed * DANMAKU_SPEED;
      if (newX + d.width < -10) {
        // 完全飞出左侧
        continue;
      }
      d.x = newX;
      alive.push(d);
    }
    this.flying = alive;

    this.onTick(alive);
    this.rafId = requestAnimationFrame(this.loop);
  };

  /** 获取轨道 y 坐标 */
  getTrackY(trackIndex: number, lineHeight: number): number {
    return trackIndex * lineHeight + 8; // 顶部 8px 边距
  }

  get trackCount(): number {
    return DANMAKU_TRACKS;
  }
}
