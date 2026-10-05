// 一起听实时通信层 — Supabase Realtime 版本
//
// 实现思路：
// - 使用 Supabase Realtime 的 Broadcast 做房间内消息广播
// - 使用 Presence 做成员在线状态管理
// - 邀请使用点对点 Broadcast 频道（频道名 = invite:<targetUid>）
// - 自动重连由 Supabase SDK 内置处理
// - 上层 API 与 WebSocket 版本一致，ListenTogetherContext 可无缝切换
//
// 配置：仅需要 Project URL + anon public key，不需要数据库表

import { logger, scopedStorage } from '@lark-apaas/client-toolkit-lite';
import {
  createClient,
  type RealtimeChannel,
  type SupabaseClient,
} from '@supabase/supabase-js';
import type { ITrack } from '@/types';
import {
  getLocalUser,
  updateLocalUser,
  type IRoomMember,
  type IRoomState,
  type IInvite,
  type IListenTogetherUser,
} from './listenTogether.ws';

// Supabase 项目配置 — 从环境变量读取
// 部署前请在 .env.local 中配置 VITE_SUPABASE_URL 和 VITE_SUPABASE_ANON_KEY
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

const HEARTBEAT_INTERVAL = 4000; // 房主心跳 4s 一次，比 8s 更稳
const PROGRESS_SYNC_INTERVAL = 5_000;
const PROGRESS_DRIFT_THRESHOLD = 1.5; // 进度偏差 > 1.5s 才硬对齐

// 后台保留相关常量
const BACKGROUND_PRESENCE_INTERVAL = 15_000; // 后台态每 15s 发一次轻量心跳（降低频率但保活）
const BACKGROUND_GRACE_MS = 30 * 60 * 1000; // 后台保留 30 分钟，超时自动退房
const OFFLINE_THRESHOLD_MS = 20_000; // lastSeen 超过 20s 视为离线/后台中（宽松阈值避免误判）

// 房间频道前缀
const ROOM_CHANNEL_PREFIX = 'room:';
// 邀请频道前缀（点对点）
const INVITE_CHANNEL_PREFIX = 'invite:';

// ===== 消息类型 =====

type MsgType =
  | 'welcome'
  | 'invite'
  | 'invite-reply'
  | 'invite-expired'
  | 'member-joined'
  | 'member-left'
  | 'member-update'
  | 'sync-play'
  | 'sync-track'
  | 'sync-seek'
  | 'host-transfer'
  | 'room-disband'
  | 'heartbeat'
  | 'presence-sync'
  | 'chat-message'
  | 'queue-add'
  | 'queue-remove'
  | 'queue-reorder'
  | 'queue-clear'
  | 'room-snapshot-request'
  | 'room-snapshot';

interface ITogetherMessage {
  type: MsgType;
  payload: any;
  from: string;
  roomId: string;
  timestamp: number;
  serverTime?: number;
  id?: string;
  /** 房主广播消息的单调递增序号，接收端用于丢弃乱序/过期消息 */
  seq?: number;
}

type MessageHandler = (msg: ITogetherMessage) => void;

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

// ===== SupabaseService =====

export class SupabaseListenTogetherService {
  private supabase: SupabaseClient | null = null;
  private user: IListenTogetherUser;
  private status: ConnectionStatus = 'disconnected';
  private statusChangeCb: ((status: ConnectionStatus) => void) | null = null;

  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _connectFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private manualDisconnect = false;

  private handlers = new Map<string, Set<MessageHandler>>();

  // 当前房间频道
  private roomChannel: RealtimeChannel | null = null;
  private roomChannelFirstSubscribe = true;
  private currentRoomId: string | null = null;
  private currentRoom: IRoomState | null = null;

  // 邀请频道（监听发给自己的邀请）
  private inviteChannel: RealtimeChannel | null = null;

  // 心跳定时器
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  // 网络/可见性事件监听器的卸载函数
  private _onlineHandler: (() => void) | null = null;
  private _offlineHandler: (() => void) | null = null;
  private _visibilityHandler: (() => void) | null = null;
  private progressTimer: ReturnType<typeof setInterval> | null = null;

  // 消息 id / seq 计数
  private msgIdCounter = 0;
  // 房主广播消息的本地 seq 序号（单调递增，用于接收方丢弃乱序/过期消息）
  private broadcastSeq = 0;
  // 接收侧：各消息类型最近处理过的 seq，用于丢弃过期消息
  private lastProcessedSeq: Record<string, number> = {};
  // seek 节流定时器
  private seekThrottleTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSeekTime: number | null = null;

  constructor() {
    this.user = getLocalUser();
  }

  // ---- 连接 ----

  connect() {
    if (this.supabase && this.status === 'connected') return;

    this.setStatus('connecting');
    logger.info('[SupabaseLT] connecting to Supabase Realtime');

    try {
      this.manualDisconnect = false;
      this.supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        realtime: {
          params: { eventsPerSecond: 20 },
          log_level: 'error',
        },
        auth: {
          persistSession: false, // 纯 anon，不需要会话持久化
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      });

      // 通过订阅 invite 频道建立连接
      this.setupInviteChannel();

      // 首次连接时注册网络/可见性监听（只注册一次）
      if (!this._onlineHandler && typeof window !== 'undefined') {
        this._onlineHandler = () => {
          // 网络恢复：若当前不在 connected，立即尝试重连（重置退避）
          if (this.status !== 'connected' && !this.manualDisconnect) {
            logger.info('[SupabaseLT] network online, triggering reconnect');
            this.reconnectAttempts = 0;
            if (this.reconnectTimer) {
              clearTimeout(this.reconnectTimer);
              this.reconnectTimer = null;
            }
            // 清理旧连接再重连
            if (this.inviteChannel && this.supabase) {
              this.supabase.removeChannel(this.inviteChannel).catch(() => {});
              this.inviteChannel = null;
            }
            this.supabase = null;
            this.connect();
          }
        };
        this._visibilityHandler = () => {
          if (document.visibilityState === 'visible' && !this.manualDisconnect) {
            // 页面回到前台：若连接不健康，立即重连一次
            if (this.status === 'reconnecting' || this.status === 'disconnected') {
              logger.info('[SupabaseLT] page visible, resuming connection');
              this.reconnectAttempts = Math.max(0, this.reconnectAttempts - 2);
              if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
              this.reconnectTimer = null;
              if (this.inviteChannel && this.supabase) {
                this.supabase.removeChannel(this.inviteChannel).catch(() => {});
                this.inviteChannel = null;
              }
              this.supabase = null;
              this.connect();
            }
          }
        };
        window.addEventListener('online', this._onlineHandler);
        this._offlineHandler = () => {
          if (this.status === 'connected') this.setStatus('reconnecting');
        };
        window.addEventListener('offline', this._offlineHandler);
        document.addEventListener('visibilitychange', this._visibilityHandler);
      }

      // 5s 内没得到 SUBSCRIBED 也没报错，先标记 connected（Supabase 建连是异步的）
      this._connectFallbackTimer = setTimeout(() => {
        if (this.status === 'connecting') {
          this.setStatus('connected');
          this.reconnectAttempts = 0;
          this.startHeartbeat();
          logger.info('[SupabaseLT] connected (fallback timeout)');
        }
      }, 5000);
    } catch (err) {
      logger.error('[SupabaseLT] init failed:', String(err));
      this.setStatus('disconnected');
      this.scheduleReconnect();
    }
  }

  disconnect() {
    this.manualDisconnect = true;
    // 清理网络/可见性监听
    if (this._onlineHandler && typeof window !== 'undefined') {
      window.removeEventListener('online', this._onlineHandler);
      this._onlineHandler = null;
    }
    if (this._offlineHandler && typeof window !== 'undefined') {
      window.removeEventListener('offline', this._offlineHandler);
      this._offlineHandler = null;
    }
    if (this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this._connectFallbackTimer) {
      clearTimeout(this._connectFallbackTimer);
      this._connectFallbackTimer = null;
    }
    this.stopHeartbeat();
    this.stopProgressReport();

    if (this.roomChannel && this.supabase) {
      this.supabase.removeChannel(this.roomChannel);
      this.roomChannel = null;
    }
    if (this.inviteChannel && this.supabase) {
      this.supabase.removeChannel(this.inviteChannel);
      this.inviteChannel = null;
    }

    this.currentRoom = null;
    this.currentRoomId = null;
    this.supabase = null;
    this.setStatus('disconnected');
    logger.info('[SupabaseLT] disconnected');
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  getWsUrl(): string {
    return 'Supabase Realtime';
  }

  onStatusChange(cb: (status: ConnectionStatus) => void) {
    this.statusChangeCb = cb;
  }

  private setStatus(s: ConnectionStatus) {
    this.status = s;
    this.statusChangeCb?.(s);
  }

  // ---- 邀请频道（监听发给自己的邀请） ----

  private setupInviteChannel() {
    if (!this.supabase) return;

    const channelName = INVITE_CHANNEL_PREFIX + this.user.uid;
    this.inviteChannel = this.supabase.channel(channelName, {
      config: {
        broadcast: { self: false },
        presence: { key: this.user.uid },
      },
    });

    // 监听邀请消息
    this.inviteChannel.on(
      'broadcast',
      { event: 'invite' },
      (payload) => {
        const msg = payload.payload as ITogetherMessage;
        logger.info('[SupabaseLT] received invite from ' + msg.payload?.invite?.fromNickname);
        this.emit('invite', msg);
      }
    );

    // 监听邀请回复（发给自己的回复）
    this.inviteChannel.on(
      'broadcast',
      { event: 'invite-reply' },
      (payload) => {
        const msg = payload.payload as ITogetherMessage;
        logger.info('[SupabaseLT] received invite-reply from ' + msg.payload?.fromNickname);
        this.emit('invite-reply', msg);
      }
    );

    // 订阅
    this.inviteChannel.subscribe((status) => {
      logger.info('[SupabaseLT] invite channel status: ' + status);
      if (status === 'SUBSCRIBED') {
        if (this.status !== 'connected') {
          this.setStatus('connected');
          this.reconnectAttempts = 0;
          this.startHeartbeat();
          logger.info('[SupabaseLT] connected (invite channel subscribed)');
        }
      } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        const wasConnected = this.status === 'connected';
        this.setStatus(wasConnected ? 'reconnecting' : 'connecting');
        // 触发重连
        if (!this.manualDisconnect) {
          this.scheduleReconnect();
        }
      }
    });
  }

  // ---- 重连 ----

  private scheduleReconnect() {
    if (this.manualDisconnect) return;
    if (this.reconnectTimer) return; // 已经在等重连了，避免重复调度

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, Math.min(this.reconnectAttempts - 1, 6)), 30000);
    logger.info(`[SupabaseLT] reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})`);

    this.setStatus('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // 清理旧频道再重连
      if (this.inviteChannel && this.supabase) {
        this.supabase.removeChannel(this.inviteChannel).catch(() => {});
        this.inviteChannel = null;
      }
      this.supabase = null;
      this.connect();
    }, delay);
  }

  // ---- 房间频道 ----

  private setupRoomChannel(roomId: string) {
    if (!this.supabase) return;

    const channelName = ROOM_CHANNEL_PREFIX + roomId;
    this.roomChannel = this.supabase.channel(channelName, {
      config: {
        broadcast: { self: false },
        presence: { key: this.user.uid },
      },
    });

    // Broadcast 消息分发
    const broadcastEvents: string[] = [
      'sync-play',
      'sync-track',
      'sync-seek',
      'member-joined',
      'member-left',
      'member-update',
      'host-transfer',
      'room-disband',
      'heartbeat',
      'report-progress',
      'chat-message',
      'queue-add',
      'queue-remove',
      'queue-reorder',
      'queue-clear',
      'room-snapshot-request',
      'room-snapshot',
    ];

    for (const evt of broadcastEvents) {
      this.roomChannel.on('broadcast', { event: evt }, (payload) => {
        const msg = payload.payload as ITogetherMessage;
        // 忽略自己发的
        if (msg.from === this.user.uid) return;
        // ---- 乱序/过期消息丢弃 ----
        // 房主权威消息必须 seq > 上次处理过的同类型 seq，避免旧消息把进度往回拽
        // （sync-play/sync-track/sync-seek/heartbeat 都是带权威状态的房主消息）
        const authoritativeTypes = ['sync-play', 'sync-track', 'sync-seek', 'heartbeat'];
        if (msg.seq !== undefined && authoritativeTypes.includes(msg.type)) {
          const last = this.lastProcessedSeq[msg.type] || 0;
          if (msg.seq <= last) {
            logger.info(`[SupabaseLT] drop stale msg ${msg.type} seq=${msg.seq} last=${last}`);
            return;
          }
          this.lastProcessedSeq[msg.type] = msg.seq;
        }
        this.updateRoomFromMessage(msg);
        this.emit(msg.type, msg);
      });
    }

    // Presence 同步
    this.roomChannel.on('presence', { event: 'sync' }, () => {
      if (!this.roomChannel || !this.currentRoom) return;
      const state = this.roomChannel.presenceState();
      const now = Date.now();
      const existing = this.currentRoom.members.reduce<Record<string, IRoomMember>>((acc, m) => {
        acc[m.uid] = m;
        return acc;
      }, {});
      const members: IRoomMember[] = [];

      // 1. 先处理当前有 presence 的成员（在线）
      for (const [uid, presences] of Object.entries(state)) {
        if (presences.length === 0) continue;
        const p = presences[0] as any;
        const prev = existing[uid];
        // 后台标识：presence 中带 isBackground=true 或者 lastSeen 超过阈值
        const markedBg = !!p.isBackground;
        const stale = prev ? (now - (prev.lastSeen || 0)) > OFFLINE_THRESHOLD_MS : false;
        const isBackground = markedBg || stale;
        members.push({
          uid,
          nickname: p.nickname || uid,
          avatarSeed: p.avatarSeed || uid,
          neteaseUserId: p.neteaseUserId,
          neteaseAvatarUrl: p.neteaseAvatarUrl,
          isHost: p.isHost || (uid === this.currentRoom!.hostUid),
          lastSeen: now,
          joinedAt: p.joinedAt || prev?.joinedAt || now,
          currentTime: p.currentTime,
          isBackground,
        });
      }

      // 2. 把后台保留中的成员也加进去（presence 消失但 lastSeen 还在 30 分钟内）
      for (const uid of Object.keys(existing)) {
        if (members.some((m) => m.uid === uid)) continue;
        const prev = existing[uid];
        const elapsed = now - (prev.lastSeen || 0);
        if (elapsed < BACKGROUND_GRACE_MS) {
          members.push({
            ...prev,
            isBackground: true,
          });
        }
        // 超过 30 分钟的成员彻底移除，不进列表
      }

      // 按 joinedAt 排序
      members.sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
      this.currentRoom.members = members;

      // 如果房主彻底离线（超过 30 分钟）才触发转让；只是后台保留的不转让
      const hostPresent = members.find((m) => m.uid === this.currentRoom!.hostUid);
      if (!hostPresent && members.length > 0 && this.currentRoom.hostUid !== this.user.uid) {
        // 第一个在线成员优先；全后台就取第一个
        const onlineFirst = members.find((m) => !m.isBackground) || members[0];
        const newHost = onlineFirst;
        this.currentRoom.hostUid = newHost.uid;
        newHost.isHost = true;
        // 通知 UI
        this.emit('host-transfer', {
          type: 'host-transfer',
          payload: { newHostUid: newHost.uid, members },
          from: '',
          roomId,
          timestamp: Date.now(),
        });
      }

      this.emit('member-update', {
        type: 'member-update',
        payload: { members },
        from: '',
        roomId,
        timestamp: Date.now(),
      });
    });

    // 房间快照请求：收到请求后，房主回复当前房间状态快照
    this.roomChannel.on('broadcast', { event: 'room-snapshot-request' }, (payload) => {
      const msg = payload.payload as ITogetherMessage;
      if (msg.from === this.user.uid) return;
      // 任一在房且有当前歌曲的成员都可以回复快照（提高受邀方首次拿到快照的概率）
      // 房主优先回复；非房主在房主 300ms 内没回复时补位
      if (this.currentRoom && this.currentRoom.currentTrack) {
        const requesterUid = msg.payload?.requesterUid;
        if (this.currentRoom.hostUid === this.user.uid) {
          // 房主立即回复
          this.sendRoomSnapshot(requesterUid);
        } else {
          // 非房主延迟 500ms 补位回复（避免跟房主同时发造成重复）
          setTimeout(() => {
            if (this.currentRoom && this.currentRoom.hostUid !== this.user.uid && this.currentRoom.currentTrack) {
              this.sendRoomSnapshot(requesterUid);
            }
          }, 500);
        }
      }
    });

    // 订阅
    this.roomChannel.subscribe(async (status) => {
       logger.info('[SupabaseLT] room channel status: ' + status);
       if (status === 'SUBSCRIBED') {
         // 进入房间后 track presence
          await this.roomChannel?.track({
            uid: this.user.uid,
            nickname: this.user.nickname,
            avatarSeed: this.user.avatarSeed,
            neteaseUserId: this.user.neteaseUserId,
            neteaseAvatarUrl: this.user.neteaseAvatarUrl,
            isHost: this.currentRoom?.hostUid === this.user.uid,
            joinedAt: Date.now(),
          });

          // 如果是房主，广播成员加入
          if (this.currentRoom?.hostUid === this.user.uid) {
            // presence sync 会自动处理成员列表
          } else {
            // 非房主：主动广播 member-joined，作为 Presence sync 的补充保障
            // （部分网络环境下 Presence 同步可能有延迟，显式广播确保房主立即收到）
            this.sendRoomBroadcast('member-joined', {
              uid: this.user.uid,
              nickname: this.user.nickname,
              avatarSeed: this.user.avatarSeed,
              joinedAt: Date.now(),
            });
          }

         // 重连成功后，非房主向房主请求快照恢复房间状态
         if (!this.roomChannelFirstSubscribe && this.currentRoom && this.currentRoom.hostUid !== this.user.uid) {
           logger.info('[SupabaseLT] reconnected, requesting room snapshot');
           setTimeout(() => this.requestRoomSnapshot(), 500);
         }
         this.roomChannelFirstSubscribe = false;
       }
    });
  }

  // ---- 消息收发 ----

  /** 向房间频道广播一条消息（房主会自动附加 seq） */
  private sendRoomBroadcast(event: string, payload: any = {}) {
    if (!this.roomChannel || !this.currentRoomId) return false;
    const isHost = this.currentRoom?.hostUid === this.user.uid;
    const msg: ITogetherMessage = {
      type: event as MsgType,
      payload,
      from: this.user.uid,
      roomId: this.currentRoomId,
      timestamp: Date.now(),
      id: `c_${Date.now()}_${++this.msgIdCounter}`,
      // 仅房主广播时附加 seq，接收方据此丢弃乱序/过期消息
      seq: isHost ? ++this.broadcastSeq : undefined,
    };
    this.roomChannel.send({
      type: 'broadcast',
      event,
      payload: msg,
    });
    return true;
  }

  /** 向指定用户的邀请频道发消息 */
  private sendInviteBroadcast(targetUid: string, event: string, payload: any = {}) {
    if (!this.supabase) return false;
    // 用临时频道发送 — Supabase broadcast 对端会在自己的频道收到
    // 但 Supabase broadcast 是频道内的广播，所以需要给目标频道发
    // 做法：创建一个临时频道实例来发，发完即弃
    const channelName = INVITE_CHANNEL_PREFIX + targetUid;
    const tempChannel = this.supabase.channel(channelName, {
      config: { broadcast: { self: false } },
    });

    const msg: ITogetherMessage = {
      type: event as MsgType,
      payload,
      from: this.user.uid,
      roomId: '',
      timestamp: Date.now(),
      id: `c_${Date.now()}_${++this.msgIdCounter}`,
    };

    tempChannel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        tempChannel.send({
          type: 'broadcast',
          event,
          payload: msg,
        });
        // 发完延迟清理
        setTimeout(() => {
          this.supabase?.removeChannel(tempChannel);
        }, 1000);
      }
    });

    return true;
  }

  // ---- 事件 ----

  private emit(type: string, msg: ITogetherMessage) {
    const handlers = this.handlers.get(type);
    if (handlers) {
      handlers.forEach((h) => {
        try {
          h(msg);
        } catch (e) {
          logger.error('[SupabaseLT] handler error:', String(e));
        }
      });
    }
  }

  on(type: string, handler: MessageHandler): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);
    return () => {
      this.handlers.get(type)?.delete(handler);
    };
  }

  // ---- 用户 ----

  getUser(): IListenTogetherUser {
    return this.user;
  }

  refreshUser() {
    this.user = getLocalUser();
    // 更新 presence
    if (this.roomChannel && this.currentRoom) {
      this.roomChannel.track({
        uid: this.user.uid,
        nickname: this.user.nickname,
        avatarSeed: this.user.avatarSeed,
        neteaseUserId: this.user.neteaseUserId,
        neteaseAvatarUrl: this.user.neteaseAvatarUrl,
        isHost: this.currentRoom.hostUid === this.user.uid,
        joinedAt: Date.now(),
      });
    }
  }

  /** 设置网易云登录信息（登录传对象，登出传 null），同步到 presence */
  setNeteaseInfo(info: { userId: number; nickname: string; avatarUrl: string } | null) {
    if (info) {
      this.user.neteaseUserId = info.userId;
      this.user.neteaseAvatarUrl = info.avatarUrl;
      // 本地仍是默认昵称时，用网易云昵称覆盖
      if (this.user.nickname.startsWith('听众_')) {
        this.user.nickname = info.nickname;
      }
    } else {
      this.user.neteaseUserId = undefined;
      this.user.neteaseAvatarUrl = undefined;
    }
    // 同步到 room presence，房间内其他人能看到最新头像
    if (this.roomChannel && this.currentRoom) {
      this.roomChannel.track({
        uid: this.user.uid,
        nickname: this.user.nickname,
        avatarSeed: this.user.avatarSeed,
        neteaseUserId: this.user.neteaseUserId,
        neteaseAvatarUrl: this.user.neteaseAvatarUrl,
        isHost: this.currentRoom.hostUid === this.user.uid,
        joinedAt: Date.now(),
      });
    }
  }

  // ---- 在线状态 ----

  async checkOnline(uid: string): Promise<{ online: boolean; nickname?: string; avatarSeed?: string }> {
    // 简化：通过向对方邀请频道发一个 ping 事件，等待回复来判断在线
    // 但这是异步的且需要对方响应。暂时用"在线"做乐观判断，
    // 真实在线状态由邀请是否被及时响应来体现
    if (this.status !== 'connected') {
      return { online: false };
    }
    // Supabase Realtime 是全连接的，只要对方订阅了 invite 频道就是在线
    // 没法直接查询，返回 true 作为乐观值（发邀请后对方无响应再提示离线）
    return { online: true };
  }

  isUserOnline(_uid: string): boolean {
    return false;
  }

  getOnlineUserInfo(_uid: string) {
    return null;
  }

  getServerTime(): number {
    // Supabase 没有服务端时钟同步，直接用本地时间
    return Date.now();
  }

  // ---- 房间 ----

  getCurrentRoomId(): string | null {
    return this.currentRoomId;
  }

  async createRoom(): Promise<string> {
    if (this.status !== 'connected') {
      throw new Error('未连接到服务器');
    }
    if (this.currentRoomId) {
      return this.currentRoomId;
    }

    const roomId = 'room_' + Math.random().toString(36).slice(2, 10);
    this.currentRoom = {
      roomId,
      hostUid: this.user.uid,
      members: [
        {
          uid: this.user.uid,
          nickname: this.user.nickname,
          avatarSeed: this.user.avatarSeed,
          isHost: true,
          lastSeen: Date.now(),
          joinedAt: Date.now(),
        },
      ],
      currentTrackId: null,
      currentTrack: null,
      isPlaying: false,
      hostTime: 0,
      hostTimeAt: Date.now(),
      createdAt: Date.now(),
      sharedQueue: [],
      currentQueueIndex: -1,
    };
    this.currentRoomId = roomId;

    this.setupRoomChannel(roomId);
    logger.info('[SupabaseLT] room created: ' + roomId);
    return roomId;
  }

  async joinRoom(roomId: string): Promise<boolean> {
    if (this.status !== 'connected') return false;

    try {
      this.currentRoomId = roomId;
      this.currentRoom = {
        roomId,
        hostUid: '', // 等 presence sync 后确定
        members: [],
        currentTrackId: null,
        currentTrack: null,
        isPlaying: false,
        hostTime: 0,
        hostTimeAt: Date.now(),
        createdAt: Date.now(),
        sharedQueue: [],
        currentQueueIndex: -1,
      };

      this.setupRoomChannel(roomId);

      // 等一个 presence sync 周期，确保拿到成员列表
      await new Promise((r) => setTimeout(r, 800));

      // 加入后向房主请求房间快照（当前曲+队列+进度）
      // 重试多次（间隔递增），确保房主在 presence 同步完成后能收到请求并回复
      let snapAttempt = 0;
      const tryRequestSnapshot = () => {
        if (!this.currentRoomId || this.currentRoom?.currentTrack) return; // 已收到快照就停止
        if (snapAttempt >= 5) return; // 最多 5 次
        snapAttempt++;
        this.requestRoomSnapshot();
        const nextDelay = 600 + snapAttempt * 400; // 600ms / 1000ms / 1400ms / 1800ms / 2200ms
        setTimeout(() => tryRequestSnapshot(), nextDelay);
      };
      tryRequestSnapshot();

      logger.info('[SupabaseLT] joined room: ' + roomId);
      return true;
    } catch (err: any) {
      logger.error('[SupabaseLT] join room failed:', String(err));
      return false;
    }
  }

  async leaveRoom(): Promise<void> {
    if (!this.currentRoomId || !this.roomChannel || !this.supabase) return;
    const roomId = this.currentRoomId;

    // 通知其他成员（通过 broadcast 一条 member-left）
    this.sendRoomBroadcast('member-left', {
      uid: this.user.uid,
      nickname: this.user.nickname,
    });

    // 房主离开：如果还有其他人，广播转让房主
    const wasHost = this.currentRoom?.hostUid === this.user.uid;
    if (wasHost && this.currentRoom && this.currentRoom.members.length > 1) {
      const nextHost = this.currentRoom.members.find((m) => m.uid !== this.user.uid);
      if (nextHost) {
        this.sendRoomBroadcast('host-transfer', {
          newHostUid: nextHost.uid,
        });
      }
    }

    // 离开频道
    try {
      await this.supabase.removeChannel(this.roomChannel);
    } catch {
      /* ignore */
    }
    this.roomChannel = null;
    this.currentRoom = null;
    this.currentRoomId = null;

    logger.info('[SupabaseLT] left room: ' + roomId);
  }

  getRoom(roomId: string): IRoomState | null {
    if (roomId === this.currentRoomId) return this.currentRoom;
    return null;
  }

  async fetchRoomInfo(roomId?: string): Promise<IRoomState | null> {
    const rid = roomId || this.currentRoomId;
    if (!rid) return null;
    if (rid === this.currentRoomId) return this.currentRoom;
    return null;
  }

  updateRoom(patch: Partial<IRoomState>) {
    if (!this.currentRoom) return;
    Object.assign(this.currentRoom, patch);
  }

  /** 从消息更新本地房间状态 */
  private updateRoomFromMessage(msg: ITogetherMessage) {
    if (!this.currentRoom) return;

    switch (msg.type) {
      case 'sync-play':
        this.currentRoom.isPlaying = !!msg.payload?.isPlaying;
        this.currentRoom.hostTime = msg.payload?.currentTime ?? this.currentRoom.hostTime;
        this.currentRoom.hostTimeAt = msg.timestamp;
        break;
      case 'sync-track':
        this.currentRoom.currentTrack = msg.payload?.track ?? null;
        this.currentRoom.currentTrackId = msg.payload?.track?.id ?? null;
        this.currentRoom.hostTime = msg.payload?.currentTime ?? 0;
        this.currentRoom.hostTimeAt = msg.timestamp;
        if (msg.payload?.queueIndex !== undefined && msg.payload?.queueIndex !== null) {
          this.currentRoom.currentQueueIndex = msg.payload.queueIndex;
        }
        break;
      case 'sync-seek':
        this.currentRoom.hostTime = msg.payload?.currentTime ?? 0;
        this.currentRoom.hostTimeAt = msg.timestamp;
        break;
      case 'host-transfer':
        if (msg.payload?.newHostUid) {
          this.currentRoom.hostUid = msg.payload.newHostUid;
        }
        break;
      case 'member-joined': {
        // 显式成员加入广播（Presence sync 的补充保障）
        const { uid, nickname, avatarSeed, joinedAt } = msg.payload || {};
        if (uid && !this.currentRoom.members.find((m) => m.uid === uid)) {
          this.currentRoom.members.push({
            uid,
            nickname: nickname || uid,
            avatarSeed: avatarSeed || uid,
            isHost: false,
            lastSeen: Date.now(),
            joinedAt: joinedAt || Date.now(),
          });
          this.currentRoom.members.sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
        }
        break;
      }
      case 'member-left': {
        const leftUid = msg.payload?.uid;
        if (leftUid) {
          this.currentRoom.members = this.currentRoom.members.filter((m) => m.uid !== leftUid);
        }
        break;
      }
      case 'room-disband':
        this.currentRoom = null;
        this.currentRoomId = null;
        break;
      case 'queue-add': {
        if (!this.currentRoom.sharedQueue) this.currentRoom.sharedQueue = [];
        const tracks = msg.payload?.tracks || [];
        const insertIndex = msg.payload?.insertIndex;
        if (insertIndex !== undefined && insertIndex >= 0) {
          const q = [...this.currentRoom.sharedQueue];
          q.splice(insertIndex, 0, ...tracks);
          this.currentRoom.sharedQueue = q;
        } else {
          this.currentRoom.sharedQueue = [...this.currentRoom.sharedQueue, ...tracks];
        }
        break;
      }
      case 'queue-remove': {
        const ids = msg.payload?.trackIds || [];
        const set = new Set(ids);
        const q = this.currentRoom.sharedQueue || [];
        this.currentRoom.sharedQueue = q.filter((t) => !set.has(t.id));
        if (this.currentRoom.currentTrackId && set.has(this.currentRoom.currentTrackId)) {
          this.currentRoom.currentQueueIndex = Math.max(0, (this.currentRoom.currentQueueIndex ?? 0) - 1);
        }
        break;
      }
      case 'queue-reorder': {
        const { fromIndex, toIndex } = msg.payload || {};
        if (typeof fromIndex !== 'number' || typeof toIndex !== 'number') break;
        const q = [...(this.currentRoom.sharedQueue || [])];
        const [moved] = q.splice(fromIndex, 1);
        if (moved) q.splice(toIndex, 0, moved);
        this.currentRoom.sharedQueue = q;
        break;
      }
      case 'queue-clear': {
        this.currentRoom.sharedQueue = [];
        this.currentRoom.currentQueueIndex = -1;
        break;
      }
      case 'room-snapshot': {
        const snap = msg.payload || {};
        // 只有请求方自己应用快照（targetUid 等于自己才应用，避免多人重复）
        if (snap.targetUid && snap.targetUid !== this.user.uid) break;
        if (snap.currentTrack !== undefined) this.currentRoom.currentTrack = snap.currentTrack;
        if (snap.currentTrackId !== undefined) this.currentRoom.currentTrackId = snap.currentTrackId;
        if (snap.isPlaying !== undefined) this.currentRoom.isPlaying = snap.isPlaying;
        if (snap.hostTime !== undefined) this.currentRoom.hostTime = snap.hostTime;
        if (snap.hostTimeAt !== undefined) this.currentRoom.hostTimeAt = snap.hostTimeAt;
        if (snap.sharedQueue !== undefined) this.currentRoom.sharedQueue = snap.sharedQueue;
        if (snap.currentQueueIndex !== undefined) this.currentRoom.currentQueueIndex = snap.currentQueueIndex;
        if (snap.hostUid) this.currentRoom.hostUid = snap.hostUid;
        break;
      }
    }
  }

  // ---- 心跳 ----

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      // 仅房主发心跳广播，带完整权威播放状态
      // 跟随方收到后按时间戳插值对齐进度，解决「时好时坏」的积累漂移
      if (
        this.currentRoomId &&
        this.roomChannel &&
        this.currentRoom &&
        this.currentRoom.hostUid === this.user.uid
      ) {
        this.sendRoomBroadcast('sync-play', {
          isPlaying: this.currentRoom.isPlaying,
          currentTime: this.currentRoom.hostTime,
          isHeartbeat: true,
        });
      }
    }, HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ---- 播放同步广播 ----

  broadcastPlayState(isPlaying: boolean, currentTime: number) {
    if (!this.currentRoomId) return;
    this.sendRoomBroadcast('sync-play', { isPlaying, currentTime });
    if (this.currentRoom) {
      this.currentRoom.isPlaying = isPlaying;
      this.currentRoom.hostTime = currentTime;
      this.currentRoom.hostTimeAt = Date.now();
    }
  }

  broadcastTrack(track: ITrack | null, currentTime: number) {
    if (!this.currentRoomId) return;
    this.sendRoomBroadcast('sync-track', { track, currentTime });
    if (this.currentRoom) {
      this.currentRoom.currentTrack = track;
      this.currentRoom.currentTrackId = track?.id || null;
      this.currentRoom.hostTime = currentTime;
      this.currentRoom.hostTimeAt = Date.now();
    }
  }

  broadcastSeek(currentTime: number) {
    if (!this.currentRoomId) return;
    // 节流：300ms 内合并最后一次 seek，避免拖动进度条时高频广播
    this.pendingSeekTime = currentTime;
    if (this.seekThrottleTimer) return;
    this.seekThrottleTimer = setTimeout(() => {
      this.seekThrottleTimer = null;
      if (this.pendingSeekTime === null) return;
      const t = this.pendingSeekTime;
      this.pendingSeekTime = null;
      this.sendRoomBroadcast('sync-seek', { currentTime: t });
      if (this.currentRoom) {
        this.currentRoom.hostTime = t;
        this.currentRoom.hostTimeAt = Date.now();
      }
    }, 300);
  }

  reportProgress(currentTime: number, opts?: { isBackground?: boolean }) {
    if (!this.currentRoomId) return;
    const isBg = opts?.isBackground ?? false;
    if (!isBg) {
      this.sendRoomBroadcast('report-progress', { currentTime });
    }
    // 更新 presence 中的 currentTime 与后台标记
    if (this.roomChannel && this.currentRoom) {
      this.roomChannel.track({
        uid: this.user.uid,
        nickname: this.user.nickname,
        avatarSeed: this.user.avatarSeed,
        neteaseUserId: this.user.neteaseUserId,
        neteaseAvatarUrl: this.user.neteaseAvatarUrl,
        isHost: this.currentRoom.hostUid === this.user.uid,
        joinedAt: Date.now(),
        currentTime,
        isBackground: isBg,
      });
    }
  }

  startProgressReport(getTime: () => number) {
    this.stopProgressReport();
    this.progressTimer = setInterval(() => {
      this.reportProgress(getTime());
    }, PROGRESS_SYNC_INTERVAL);
  }

  stopProgressReport() {
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }

  // ---- 后台保留 ----

  private backgroundTimer: ReturnType<typeof setTimeout> | null = null;
  private backgroundStartTime = 0;
  private isInBackground = false;

  /** 进入后台：降低心跳频率，标记 isBackground，启动超时退房计时 */
  enterBackground(getTime: () => number) {
    if (this.isInBackground || !this.currentRoomId) return;
    this.isInBackground = true;
    this.backgroundStartTime = Date.now();
    // 停止前台高频心跳
    this.stopProgressReport();
    this.stopHeartbeat();
    // 后台轻量心跳：通过 presence track 保活，每 15s 一次
    const beat = () => {
      if (!this.isInBackground) return;
      const elapsed = Date.now() - this.backgroundStartTime;
      if (elapsed >= BACKGROUND_GRACE_MS) {
        // 30 分钟到，自动退房
        this.leaveRoom().catch(() => { /* ignore */ });
        return;
      }
      this.reportProgress(getTime(), { isBackground: true });
      this.backgroundTimer = setTimeout(beat, BACKGROUND_PRESENCE_INTERVAL);
    };
    // 立即发一次，标记后台态
    this.reportProgress(getTime(), { isBackground: true });
    this.backgroundTimer = setTimeout(beat, BACKGROUND_PRESENCE_INTERVAL);
  }

  /** 回到前台：恢复正常心跳；如果已超时返回 false 表示已退房 */
  leaveBackground(getTime: () => number): boolean {
    if (!this.isInBackground) return true;
    // 先清理后台定时器
    if (this.backgroundTimer) {
      clearTimeout(this.backgroundTimer);
      this.backgroundTimer = null;
    }
    const elapsed = Date.now() - this.backgroundStartTime;
    if (elapsed >= BACKGROUND_GRACE_MS || !this.currentRoomId) {
      // 已超时退房
      this.isInBackground = false;
      return false;
    }
    // 回到前台：恢复正常心跳，清除后台标记
    this.isInBackground = false;
    // 立即发一次 presence 更新，恢复在线态
    this.reportProgress(getTime(), { isBackground: false });
    this.startProgressReport(getTime);
    // 房主的话恢复心跳
    if (this.currentRoom?.hostUid === this.user.uid) {
      this.startHeartbeat();
    }
    return true;
  }

  /** 唤醒时自检：如果 lastSeen 超时就主动退房（应对系统挂起定时器不跑的情况） */
  checkBackgroundTimeout(): boolean {
    if (!this.currentRoom || !this.isInBackground) return false;
    const elapsed = Date.now() - this.backgroundStartTime;
    if (elapsed >= BACKGROUND_GRACE_MS) {
      this.leaveRoom().catch(() => { /* ignore */ });
      return true;
    }
    return false;
  }

  checkDrift(): { driftMembers: string[]; correctTime: number } {
    return { driftMembers: [], correctTime: 0 };
  }

  // ---- 聊天弹幕 ----

  broadcastChatMessage(msg: {
    id: string;
    fromUid: string;
    fromNickname: string;
    fromAvatarSeed: string;
    content: string;
    timestamp: number;
  }) {
    if (!this.currentRoomId) return;
    this.sendRoomBroadcast('chat-message', msg);
  }

  // ---- 共享队列同步 ----

  /** 添加曲目到共享队列（批量） */
  broadcastQueueAdd(tracks: ITrack[], insertIndex?: number) {
    if (!this.currentRoomId) return;
    // 仅同步可识别字段（去除 File/url 等大字段，由各端自行解析获取）
    // 附带添加者快照：昵称/头像/uid，防止成员离开后队列项丢失来源
    const addedBy = {
      uid: this.user.uid,
      nickname: this.user.nickname,
      avatarSeed: this.user.avatarSeed,
      neteaseUserId: this.user.neteaseUserId,
      neteaseAvatarUrl: this.user.neteaseAvatarUrl,
    };
    const lightTracks = tracks.map((t) => ({
      id: t.id,
      name: t.name,
      artist: t.artist,
      album: t.album,
      coverUrl: t.coverUrl,
      duration: t.duration,
      neteaseId: t.neteaseId,
      source: t.source,
      isVip: t.isVip,
      fee: t.fee,
      addedBy: t.addedBy || addedBy,
    })) as ITrack[];
    this.sendRoomBroadcast('queue-add', { tracks: lightTracks, insertIndex: insertIndex ?? -1 });
    // 更新本地 room 状态
    if (this.currentRoom) {
      const q = this.currentRoom.sharedQueue || [];
      if (insertIndex !== undefined && insertIndex >= 0) {
        const newQ = [...q];
        newQ.splice(insertIndex, 0, ...lightTracks);
        this.currentRoom.sharedQueue = newQ;
      } else {
        this.currentRoom.sharedQueue = [...q, ...lightTracks];
      }
    }
  }

  /** 从共享队列移除 */
  broadcastQueueRemove(trackIds: string[]) {
    if (!this.currentRoomId || !this.currentRoom) return;
    this.sendRoomBroadcast('queue-remove', { trackIds });
    const q = this.currentRoom.sharedQueue || [];
    const set = new Set(trackIds);
    this.currentRoom.sharedQueue = q.filter((t) => !set.has(t.id));
    // 如果移除的是当前曲，调整 currentIndex
    if (this.currentRoom.currentTrackId && set.has(this.currentRoom.currentTrackId)) {
      this.currentRoom.currentQueueIndex = Math.max(0, (this.currentRoom.currentQueueIndex ?? 0) - 1);
    }
  }

  /** 重排序（简单：把 from 移到 to） */
  broadcastQueueReorder(fromIndex: number, toIndex: number) {
    if (!this.currentRoomId || !this.currentRoom) return;
    this.sendRoomBroadcast('queue-reorder', { fromIndex, toIndex });
    const q = [...(this.currentRoom.sharedQueue || [])];
    const [moved] = q.splice(fromIndex, 1);
    if (moved) q.splice(toIndex, 0, moved);
    this.currentRoom.sharedQueue = q;
  }

  /** 清空共享队列 */
  broadcastQueueClear() {
    if (!this.currentRoomId) return;
    this.sendRoomBroadcast('queue-clear', {});
    if (this.currentRoom) {
      this.currentRoom.sharedQueue = [];
      this.currentRoom.currentQueueIndex = -1;
    }
  }

  /** 设置当前播放索引（切歌时同步） */
  broadcastCurrentIndex(index: number, track: ITrack | null, currentTime: number) {
    if (!this.currentRoomId) return;
    // 复用 sync-track，但附带队列索引
    this.sendRoomBroadcast('sync-track', { track, currentTime, queueIndex: index });
    if (this.currentRoom) {
      this.currentRoom.currentTrack = track;
      this.currentRoom.currentTrackId = track?.id || null;
      this.currentRoom.currentQueueIndex = index;
      this.currentRoom.hostTime = currentTime;
      this.currentRoom.hostTimeAt = Date.now();
    }
  }

  // ---- 房间快照（重连恢复用） ----

  /** 请求房间快照（新加入或重连后调用） */
  requestRoomSnapshot() {
    if (!this.currentRoomId) return;
    this.sendRoomBroadcast('room-snapshot-request', { requesterUid: this.user.uid });
  }

  /** 回复房间快照（房主或任一在房成员回复） */
  sendRoomSnapshot(targetUid?: string) {
    if (!this.currentRoomId || !this.currentRoom) return;
    const snap = {
      targetUid,
      currentTrack: this.currentRoom.currentTrack,
      currentTrackId: this.currentRoom.currentTrackId,
      isPlaying: this.currentRoom.isPlaying,
      hostTime: this.currentRoom.hostTime,
      hostTimeAt: this.currentRoom.hostTimeAt,
      sharedQueue: this.currentRoom.sharedQueue || [],
      currentQueueIndex: this.currentRoom.currentQueueIndex ?? -1,
      hostUid: this.currentRoom.hostUid,
      members: this.currentRoom.members.map((m) => ({
        uid: m.uid,
        nickname: m.nickname,
        avatarSeed: m.avatarSeed,
        neteaseUserId: m.neteaseUserId,
        neteaseAvatarUrl: m.neteaseAvatarUrl,
        isHost: m.isHost,
        joinedAt: m.joinedAt,
      })),
      timestamp: Date.now(),
    };
    this.sendRoomBroadcast('room-snapshot', snap);
  }

  // ---- 邀请 ----

  async sendInvite(
    toUid: string,
    roomId?: string
  ): Promise<{ success: boolean; message: string; invite?: IInvite; targetOnline: boolean }> {
    if (this.status !== 'connected') {
      return { success: false, message: '未连接到服务器', targetOnline: false };
    }

    // 如果没有房间，先创建
    let rid = roomId || this.currentRoomId;
    if (!rid) {
      rid = await this.createRoom();
    }

    const inviteId = 'inv_' + Math.random().toString(36).slice(2, 10);
    const invite: IInvite = {
      id: inviteId,
      fromUid: this.user.uid,
      fromNickname: this.user.nickname,
      fromAvatarSeed: this.user.avatarSeed,
      toUid,
      roomId: rid,
      status: 'pending',
      createdAt: Date.now(),
      expiresAt: Date.now() + 30_000,
    };

    // 发送到对方邀请频道（最多重试 2 次，共 3 次，间隔 1.5s，避免丢包）
    let sendOk = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const resp = this.sendInviteBroadcast(toUid, 'invite', { invite });
        // sendInviteBroadcast 同步返回，这里视为发出成功
        if (resp !== false) {
          sendOk = true;
          break;
        }
      } catch {
        /* 单次失败继续重试 */
      }
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }

    if (!sendOk) {
      return {
        success: false,
        message: '邀请发送失败，请检查网络后重试',
        targetOnline: false,
      };
    }

    // 30 秒后本地标记过期
    setTimeout(() => {
      // 如果用户还在等，就当过期了（实际上对方接受/拒绝会主动通知）
    }, 30_000);

    return {
      success: true,
      message: '邀请已发送，等待对方接受',
      targetOnline: true,
      invite,
    };
  }

  async replyInvite(inviteId: string, accepted: boolean): Promise<{ accepted: boolean; room?: IRoomState }> {
    if (this.status !== 'connected') {
      return { accepted: false };
    }

    // 找到对应邀请（从 invite 消息的 payload 里拿）
    // 这里简化处理：直接回复到发送者的邀请频道
    const invitePayload = this.pendingInvites.get(inviteId);
    if (!invitePayload) {
      return { accepted: false };
    }

    const { fromUid, roomId, fromNickname } = invitePayload;

    // 发送回复到对方邀请频道
    this.sendInviteBroadcast(fromUid, 'invite-reply', {
      inviteId,
      accepted,
      fromUid: this.user.uid,
      fromNickname: this.user.nickname,
      roomId,
    });

    if (accepted && roomId) {
      // 接受邀请 → 加入房间
      const joined = await this.joinRoom(roomId);
      if (joined && this.currentRoom) {
        return { accepted: true, room: this.currentRoom };
      }
    }

    this.pendingInvites.delete(inviteId);
    return { accepted };
  }

  // 暂存收到的邀请（用于 reply 时回查）
  private pendingInvites = new Map<
    string,
    { fromUid: string; roomId: string; fromNickname: string }
  >();

  /** 记录收到的邀请（供 replyInvite 使用） */
  cacheInvite(invite: IInvite) {
    this.pendingInvites.set(invite.id, {
      fromUid: invite.fromUid,
      roomId: invite.roomId,
      fromNickname: invite.fromNickname,
    });
    // 30 秒后清理
    setTimeout(() => {
      this.pendingInvites.delete(invite.id);
    }, 30_000);
  }

  cleanupExpiredInvites() {
    // 由 setTimeout 自动处理
  }
}

// 单例
let serviceInstance: SupabaseListenTogetherService | null = null;

export function getSupabaseListenTogetherService(): SupabaseListenTogetherService {
  if (!serviceInstance) {
    serviceInstance = new SupabaseListenTogetherService();
  }
  return serviceInstance;
}

export { getLocalUser, updateLocalUser };
