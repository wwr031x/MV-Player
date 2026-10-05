// 一起听实时通信层 — WebSocket 版本
import { scopedStorage, logger, getAppId } from '@lark-apaas/client-toolkit-lite';
import type { ITrack } from '@/types';

const UID_KEY = 'audioviz_uid';
const NICKNAME_KEY = 'audioviz_nickname';
const AVATAR_KEY = 'audioviz_avatar_seed';
const HEARTBEAT_INTERVAL = 8000;
const CLOCK_SYNC_INTERVAL = 30_000;
const PROGRESS_SYNC_INTERVAL = 5_000;

export interface IRoomMember {
  uid: string;
  nickname: string;
  avatarSeed: string;
  isHost: boolean;
  lastSeen: number;
  currentTime?: number;
  joinedAt?: number;
  isBackground?: boolean;
  neteaseUserId?: number;
  neteaseAvatarUrl?: string;
}

export interface IRoomState {
  roomId: string;
  hostUid: string;
  members: IRoomMember[];
  currentTrackId: string | null;
  currentTrack: ITrack | null;
  isPlaying: boolean;
  hostTime: number;
  hostTimeAt: number;
  createdAt: number;
  sharedQueue?: ITrack[];
  currentQueueIndex?: number;
}

export interface IInvite {
  id: string;
  fromUid: string;
  fromNickname: string;
  fromAvatarSeed: string;
  toUid: string;
  roomId: string;
  status: 'pending' | 'accepted' | 'rejected' | 'expired' | 'offline';
  createdAt: number;
  expiresAt: number;
}

export interface IListenTogetherUser {
  uid: string;
  nickname: string;
  avatarSeed: string;
  neteaseUserId?: number;
  neteaseAvatarUrl?: string;
}

type MessageHandler = (msg: any) => void;

export function getLocalUser(): IListenTogetherUser {
  let uid = scopedStorage.getItem(UID_KEY);
  if (!uid) {
    uid = 'uid_' + Math.random().toString(36).slice(2, 10);
    scopedStorage.setItem(UID_KEY, uid);
  }
  const nickname = scopedStorage.getItem(NICKNAME_KEY) || '听众_' + uid.slice(-4);
  const avatarSeed = scopedStorage.getItem(AVATAR_KEY) || uid;
  return { uid, nickname, avatarSeed };
}

export function updateLocalUser(patch: Partial<Pick<IListenTogetherUser, 'nickname' | 'avatarSeed'>>) {
  if (patch.nickname !== undefined) scopedStorage.setItem(NICKNAME_KEY, patch.nickname);
  if (patch.avatarSeed !== undefined) scopedStorage.setItem(AVATAR_KEY, patch.avatarSeed);
}

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export class ListenTogetherService {
  private ws: WebSocket | null = null;
  private wsUrl = '';
  private handlers = new Map<string, Set<MessageHandler>>();
  private pendingRequests = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void; timer: ReturnType<typeof setTimeout> }>();
  private user: IListenTogetherUser;
  private status: ConnectionStatus = 'disconnected';
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private clockSyncTimer: ReturnType<typeof setInterval> | null = null;
  private progressTimer: ReturnType<typeof setInterval> | null = null;
  private manualDisconnect = false;
  private clockOffset = 0;
  private currentRoomId: string | null = null;
  private currentRoom: IRoomState | null = null;
  private statusChangeCb: ((status: ConnectionStatus) => void) | null = null;

  constructor() { this.user = getLocalUser(); }

  setServerUrl(url: string) { this.wsUrl = url; }

  private deriveWsUrl(): string {
    if (this.wsUrl) return this.wsUrl;
    const { protocol, hostname, port, pathname } = window.location;
    const wsProto = protocol === 'https:' ? 'wss:' : 'ws:';
    if (port === '8001' || port === '5173' || port === '3000') return `${wsProto}//${hostname}:${port}/ws`;
    const portPart = port ? `:${port}` : '';
    let basePath = '';
    const appId = getAppId();
    if (appId && pathname.startsWith(`/app/${appId}/`)) basePath = `/app/${appId}`;
    else { const match = pathname.match(/^\/app\/[^/]+/); if (match) basePath = match[0]; }
    return `${wsProto}//${hostname}${portPart}${basePath}/ws`;
  }

  getStatus(): ConnectionStatus { return this.status; }
  getWsUrl(): string { return this.wsUrl || this.deriveWsUrl(); }
  onStatusChange(cb: (status: ConnectionStatus) => void) { this.statusChangeCb = cb; }
  private setStatus(s: ConnectionStatus) { this.status = s; this.statusChangeCb?.(s); }

  connect() {
    if (this.ws && (this.status === 'connected' || this.status === 'connecting')) return;
    this.manualDisconnect = false;
    const url = this.deriveWsUrl();
    let fullUrl = `${url}?uid=${encodeURIComponent(this.user.uid)}&nickname=${encodeURIComponent(this.user.nickname)}&avatarSeed=${encodeURIComponent(this.user.avatarSeed)}`;
    if (this.user.neteaseUserId) fullUrl += `&neteaseUserId=${this.user.neteaseUserId}`;
    if (this.user.neteaseAvatarUrl) fullUrl += `&neteaseAvatarUrl=${encodeURIComponent(this.user.neteaseAvatarUrl)}`;
    this.setStatus(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');
    logger.info(`[ListenTogether] connecting to ${url} as ${this.user.uid}`);
    try { this.ws = new WebSocket(fullUrl); }
    catch (err) { logger.error('[ListenTogether] WS creation failed:', String(err)); this.scheduleReconnect(); return; }
    this.ws.onopen = () => {
      logger.info('[ListenTogether] connected');
      this.setStatus('connected');
      this.reconnectAttempts = 0;
      this.startHeartbeat();
      this.startClockSync();
    };
    this.ws.onmessage = (e) => {
      let msg: any;
      try { msg = JSON.parse(e.data); } catch { return; }
      this.handleMessage(msg);
    };
    this.ws.onclose = (e) => {
      logger.info(`[ListenTogether] disconnected (code=${e.code})`);
      this.setStatus('disconnected');
      this.stopHeartbeat();
      this.stopClockSync();
      this.currentRoom = null;
      this.currentRoomId = null;
      for (const [, req] of this.pendingRequests) { clearTimeout(req.timer); req.reject(new Error('Connection closed')); }
      this.pendingRequests.clear();
      if (!this.manualDisconnect && e.code !== 4000) this.scheduleReconnect();
    };
    this.ws.onerror = () => { logger.error('[ListenTogether] WebSocket error'); };
  }

  disconnect() {
    this.manualDisconnect = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) { this.ws.close(1000, 'Client disconnect'); this.ws = null; }
    this.setStatus('disconnected');
    this.stopHeartbeat();
    this.stopClockSync();
  }

  private scheduleReconnect() {
    if (this.manualDisconnect) return;
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, Math.min(this.reconnectAttempts - 1, 6)), 60000);
    logger.info(`[ListenTogether] reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})`);
    this.setStatus('reconnecting');
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => { if (this.ws?.readyState === WebSocket.OPEN) this.sendRaw('ping', { clientTime: Date.now() }); }, HEARTBEAT_INTERVAL);
  }
  private stopHeartbeat() { if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; } }

  private startClockSync() {
    this.stopClockSync();
    this.doClockSync();
    this.clockSyncTimer = setInterval(() => this.doClockSync(), CLOCK_SYNC_INTERVAL);
  }
  private stopClockSync() { if (this.clockSyncTimer) { clearInterval(this.clockSyncTimer); this.clockSyncTimer = null; } }

  private async doClockSync() {
    try {
      const t1 = Date.now();
      const res = await this.request('clock-sync', { t1 });
      const t4 = Date.now();
      const t2 = res.t2, t3 = res.t3;
      const rtt = t4 - t1 - (t3 - t2);
      const offset = (t1 + rtt / 2) - t2;
      this.clockOffset = offset;
      logger.info(`[ListenTogether] clock sync: offset=${offset.toFixed(1)}ms, rtt=${rtt.toFixed(0)}ms`);
    } catch {}
  }

  getServerTime(): number { return Date.now() - this.clockOffset; }

  private msgIdCounter = 0;
  private sendRaw(type: string, payload: any = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    const msg = { type, payload, id: `c_${Date.now()}_${++this.msgIdCounter}`, from: this.user.uid, roomId: this.currentRoomId || '', timestamp: Date.now() };
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private request(type: string, payload: any = {}, timeoutMs = 10000): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = `c_${Date.now()}_${++this.msgIdCounter}`;
      const timer = setTimeout(() => { this.pendingRequests.delete(id); reject(new Error('Request timeout')); }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timer });
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        clearTimeout(timer); this.pendingRequests.delete(id); reject(new Error('Not connected')); return;
      }
      const msg = { type, payload, id, from: this.user.uid, roomId: this.currentRoomId || '', timestamp: Date.now() };
      this.ws.send(JSON.stringify(msg));
    });
  }

  private handleMessage(msg: any) {
    if (msg.requestId && this.pendingRequests.has(msg.requestId)) {
      const req = this.pendingRequests.get(msg.requestId)!;
      clearTimeout(req.timer);
      this.pendingRequests.delete(msg.requestId);
      if (msg.ok === false) req.reject(new Error(msg.payload?.error || 'Request failed'));
      else req.resolve(msg.payload);
    }
    if (msg.roomId && msg.roomId === this.currentRoomId) this.updateRoomFromMessage(msg);
    const handlers = this.handlers.get(msg.type);
    if (handlers) handlers.forEach((h) => { try { h(msg); } catch (e) { logger.error('Handler error:', String(e)); } });
  }

  private updateRoomFromMessage(msg: any) {
    if (!this.currentRoom) return;
    switch (msg.type) {
      case 'member-joined':
      case 'member-left':
      case 'member-update':
      case 'host-transfer':
        if (msg.payload?.members) this.currentRoom.members = msg.payload.members.map((m: any) => ({ ...m, lastSeen: m.joinedAt || Date.now() }));
        if (msg.type === 'host-transfer' && msg.payload?.newHostUid) this.currentRoom.hostUid = msg.payload.newHostUid;
        break;
      case 'sync-play':
        this.currentRoom.isPlaying = !!msg.payload?.isPlaying;
        this.currentRoom.hostTime = msg.payload?.currentTime ?? this.currentRoom.hostTime;
        this.currentRoom.hostTimeAt = msg.payload?.serverTime ?? Date.now();
        break;
      case 'sync-track':
        this.currentRoom.currentTrack = msg.payload?.track ?? null;
        this.currentRoom.currentTrackId = msg.payload?.track?.id ?? null;
        this.currentRoom.hostTime = msg.payload?.currentTime ?? 0;
        this.currentRoom.hostTimeAt = msg.payload?.serverTime ?? Date.now();
        break;
      case 'sync-seek':
        this.currentRoom.hostTime = msg.payload?.currentTime ?? 0;
        this.currentRoom.hostTimeAt = msg.payload?.serverTime ?? Date.now();
        break;
      case 'room-disband':
        this.currentRoom = null; this.currentRoomId = null;
        break;
    }
  }

  on(type: string, handler: MessageHandler): () => void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler);
    return () => { this.handlers.get(type)?.delete(handler); };
  }

  getUser(): IListenTogetherUser { return this.user; }

  refreshUser() {
    this.user = getLocalUser();
    if (this.status === 'connected') this.sendRaw('update-profile', { nickname: this.user.nickname, avatarSeed: this.user.avatarSeed, neteaseUserId: this.user.neteaseUserId, neteaseAvatarUrl: this.user.neteaseAvatarUrl });
  }

  setNeteaseInfo(info: { userId: number; nickname: string; avatarUrl: string } | null) {
    if (info) {
      this.user.neteaseUserId = info.userId;
      this.user.neteaseAvatarUrl = info.avatarUrl;
      if (this.user.nickname.startsWith('听众_')) this.user.nickname = info.nickname;
    } else {
      this.user.neteaseUserId = undefined;
      this.user.neteaseAvatarUrl = undefined;
    }
    if (this.status === 'connected') this.sendRaw('update-profile', { nickname: this.user.nickname, avatarSeed: this.user.avatarSeed, neteaseUserId: this.user.neteaseUserId, neteaseAvatarUrl: this.user.neteaseAvatarUrl });
  }

  async checkOnline(uid: string): Promise<{ online: boolean; nickname?: string; avatarSeed?: string }> {
    if (this.status !== 'connected') return { online: false };
    try { const res = await this.request('check-online', { uid }); return { online: !!res.online, nickname: res.nickname, avatarSeed: res.avatarSeed }; }
    catch { return { online: false }; }
  }

  isUserOnline(uid: string): boolean { return false; }
  getOnlineUserInfo(uid: string) { return null; }
  getCurrentRoomId(): string | null { return this.currentRoomId; }

  async createRoom(): Promise<string> {
    if (this.status !== 'connected') throw new Error('未连接到服务器');
    const res = await this.request('create-room', {});
    const room = res.room as IRoomState;
    this.currentRoom = room;
    this.currentRoomId = room.roomId;
    logger.info('[ListenTogether] room created: ' + room.roomId);
    return room.roomId;
  }

  async joinRoom(roomId: string): Promise<boolean> {
    if (this.status !== 'connected') return false;
    try {
      const res = await this.request('join-room', { roomId });
      const room = res.room as IRoomState;
      this.currentRoom = room;
      this.currentRoomId = room.roomId;
      if (res.currentTrack !== undefined) {
        this.currentRoom.currentTrack = res.currentTrack;
        this.currentRoom.currentTrackId = res.currentTrackId;
        this.currentRoom.isPlaying = res.isPlaying;
        this.currentRoom.hostTime = res.hostTime;
        this.currentRoom.hostTimeAt = res.hostTimeAt;
      }
      logger.info('[ListenTogether] joined room: ' + roomId);
      return true;
    } catch (err: any) {
      logger.error('[ListenTogether] join room failed:', err.message);
      return false;
    }
  }

  async leaveRoom(): Promise<void> {
    if (!this.currentRoomId) return;
    const roomId = this.currentRoomId;
    if (this.status === 'connected') { try { await this.request('leave-room', {}); } catch {} }
    this.currentRoom = null;
    this.currentRoomId = null;
    logger.info('[ListenTogether] left room: ' + roomId);
  }

  getRoom(roomId: string): IRoomState | null { if (roomId === this.currentRoomId) return this.currentRoom; return null; }

  async fetchRoomInfo(roomId?: string): Promise<IRoomState | null> {
    if (this.status !== 'connected') return null;
    const rid = roomId || this.currentRoomId;
    if (!rid) return null;
    try {
      const res = await this.request('get-room-info', { roomId: rid });
      if (res?.room && rid === this.currentRoomId) this.currentRoom = res.room;
      return res.room || null;
    } catch { return null; }
  }

  updateRoom(patch: Partial<IRoomState>) { if (!this.currentRoom) return; Object.assign(this.currentRoom, patch); }

  broadcastPlayState(isPlaying: boolean, currentTime: number) {
    if (!this.currentRoomId || this.status !== 'connected') return;
    this.sendRaw('sync-play', { isPlaying, currentTime });
    if (this.currentRoom) { this.currentRoom.isPlaying = isPlaying; this.currentRoom.hostTime = currentTime; this.currentRoom.hostTimeAt = this.getServerTime(); }
  }

  broadcastTrack(track: ITrack | null, currentTime: number) {
    if (!this.currentRoomId || this.status !== 'connected') return;
    this.sendRaw('sync-track', { track, currentTime });
    if (this.currentRoom) { this.currentRoom.currentTrack = track; this.currentRoom.currentTrackId = track?.id || null; this.currentRoom.hostTime = currentTime; this.currentRoom.hostTimeAt = this.getServerTime(); }
  }

  broadcastSeek(currentTime: number) {
    if (!this.currentRoomId || this.status !== 'connected') return;
    this.sendRaw('sync-seek', { currentTime });
    if (this.currentRoom) { this.currentRoom.hostTime = currentTime; this.currentRoom.hostTimeAt = this.getServerTime(); }
  }

  reportProgress(currentTime: number) { if (!this.currentRoomId || this.status !== 'connected') return; this.sendRaw('report-progress', { currentTime }); }

  startProgressReport(getTime: () => number) {
    this.stopProgressReport();
    this.progressTimer = setInterval(() => this.reportProgress(getTime()), PROGRESS_SYNC_INTERVAL);
  }
  stopProgressReport() { if (this.progressTimer) { clearInterval(this.progressTimer); this.progressTimer = null; } }
  checkDrift(): { driftMembers: string[]; correctTime: number } { return { driftMembers: [], correctTime: 0 }; }

  async sendInvite(toUid: string, roomId?: string): Promise<{ success: boolean; message: string; invite?: IInvite; targetOnline: boolean }> {
    if (this.status !== 'connected') return { success: false, message: '未连接到服务器', targetOnline: false };
    try {
      const res = await this.request('invite', { toUid, roomId });
      if (res.roomId && !this.currentRoomId) {
        this.currentRoomId = res.roomId;
        try { const infoRes = await this.request('get-room-info', { roomId: res.roomId }); this.currentRoom = infoRes.room; } catch {}
      }
      if (res.targetOnline) {
        return {
          success: true, message: '邀请已发送，等待对方接受', targetOnline: true,
          invite: { id: res.inviteId, fromUid: this.user.uid, fromNickname: this.user.nickname, fromAvatarSeed: this.user.avatarSeed, toUid, roomId: res.roomId, status: 'pending', createdAt: Date.now(), expiresAt: Date.now() + 30_000 },
        };
      } else {
        return { success: false, message: res.message || '对方不在线', targetOnline: false };
      }
    } catch (err: any) { return { success: false, message: err.message || '邀请发送失败', targetOnline: false }; }
  }

  async replyInvite(inviteId: string, accepted: boolean): Promise<{ accepted: boolean; room?: IRoomState }> {
    if (this.status !== 'connected') return { accepted: false };
    try {
      const res = await this.request('invite-reply', { inviteId, accepted });
      if (accepted && res.room) {
        this.currentRoom = res.room;
        this.currentRoomId = res.room.roomId;
        if (res.currentTrack !== undefined) {
          this.currentRoom.currentTrack = res.currentTrack;
          this.currentRoom.currentTrackId = res.currentTrackId;
          this.currentRoom.isPlaying = res.isPlaying;
          this.currentRoom.hostTime = res.hostTime;
          this.currentRoom.hostTimeAt = res.hostTimeAt;
        }
      }
      return { accepted: res.accepted ?? accepted, room: res.room };
    } catch { return { accepted: false }; }
  }

  cleanupExpiredInvites() {}
}

let serviceInstance: ListenTogetherService | null = null;
export function getListenTogetherService(): ListenTogether {
  if (!serviceInstance) serviceInstance = new ListenTogetherService();
  return serviceInstance;
}
