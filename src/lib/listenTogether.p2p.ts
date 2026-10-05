// 一起听 P2P 通道（基于 PeerJS + 公共信令服务）
import Peer from 'peerjs';
import type { DataConnection } from 'peerjs';
import { scopedStorage, logger } from '@lark-apaas/client-toolkit-lite';
import type { ITrack } from '@/types';

export interface IRoomMember {
  uid: string;
  nickname: string;
  avatarSeed: string;
  isHost: boolean;
  lastSeen: number;
  currentTime?: number;
  joinedAt?: number;
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
}

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
type MessageHandler = (msg: any) => void;

const UID_KEY = 'audioviz_uid';
const NICKNAME_KEY = 'audioviz_nickname';
const AVATAR_KEY = 'audioviz_avatar_seed';

export function getLocalUser(): IListenTogetherUser {
  let uid = scopedStorage.getItem(UID_KEY);
  if (!uid) { uid = 'uid_' + Math.random().toString(36).slice(2, 10); scopedStorage.setItem(UID_KEY, uid); }
  const nickname = scopedStorage.getItem(NICKNAME_KEY) || '听众_' + uid.slice(-4);
  const avatarSeed = scopedStorage.getItem(AVATAR_KEY) || uid;
  return { uid, nickname, avatarSeed };
}

export function updateLocalUser(patch: Partial<Pick<IListenTogetherUser, 'nickname' | 'avatarSeed'>>) {
  if (patch.nickname !== undefined) scopedStorage.setItem(NICKNAME_KEY, patch.nickname);
  if (patch.avatarSeed !== undefined) scopedStorage.setItem(AVATAR_KEY, patch.avatarSeed);
}

const PEER_CONFIG = {
  host: '0.peerjs.com', port: 443, path: '/', secure: true, debug: 1 as const,
  config: { iceServers: [
    { urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }, { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:stun.voipbuster.com' }, { urls: 'stun:stun.sipgate.net' },
  ]},
};

function toPeerId(uid: string): string { return `audioviz_${uid}`; }
function fromPeerId(peerId: string): string { return peerId.replace(/^audioviz_/, ''); }

export class P2PListenTogetherService {
  private peer: Peer | null = null;
  private conn: DataConnection | null = null;
  private handlers = new Map<string, Set<MessageHandler>>();
  private user: IListenTogetherUser;
  private status: ConnectionStatus = 'disconnected';
  private statusChangeCb: ((status: ConnectionStatus) => void) | null = null;
  private currentRoomId: string | null = null;
  private currentRoom: IRoomState | null = null;
  private partner: IRoomMember | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeat = 0;
  private openPromise: Promise<void> | null = null;
  private role: 'host' | 'guest' | null = null;
  private incomingCall: { conn: DataConnection; fromUid: string; fromNickname: string; fromAvatarSeed: string; inviteId: string; roomId: string; expireTimer: ReturnType<typeof setTimeout>; accepted: boolean } | null = null;

  constructor() { this.user = getLocalUser(); }

  async connect(): Promise<void> {
    if (this.peer && this.status === 'connected') return;
    this.setStatus('connecting');
    try {
      const peerId = toPeerId(this.user.uid);
      this.peer = new Peer(peerId, PEER_CONFIG);
      this.openPromise = new Promise((resolve, reject) => {
        if (!this.peer) return reject(new Error('peer not created'));
        const timeout = setTimeout(() => reject(new Error('连接信令服务器超时')), 15000);
        this.peer!.on('open', () => { clearTimeout(timeout); this.setStatus('connected'); logger.info('[P2P] PeerJS connected, id=' + peerId); resolve(); });
        this.peer!.on('error', (err: any) => {
          clearTimeout(timeout);
          logger.error('[P2P] Peer error:', String(err));
          if (err.type === 'unavailable-id') { this.setStatus('disconnected'); reject(new Error('Peer ID 已被占用，请刷新页面重试')); return; }
          if (this.status === 'connecting') { this.setStatus('disconnected'); reject(err); }
        });
        this.peer!.on('disconnected', () => {
          logger.info('[P2P] Peer disconnected from broker');
          if (!this.peer?.destroyed) { this.setStatus('reconnecting'); this.peer!.reconnect(); }
          else this.setStatus('disconnected');
        });
        this.peer!.on('connection', (conn: DataConnection) => {
          logger.info('[P2P] Incoming connection from ' + conn.peer);
          if (this.conn && this.conn.open) {
            conn.on('open', () => { conn.send({ type: 'busy', payload: { message: '当前已在房间中' } }); setTimeout(() => conn.close(), 1500); });
            return;
          }
          if (this.incomingCall) {
            conn.on('open', () => { conn.send({ type: 'busy', payload: { message: '正在处理其他呼叫' } }); setTimeout(() => conn.close(), 1500); });
            return;
          }
          const meta = (conn.metadata as any) || {};
          const fromUid = meta.fromUid || fromPeerId(conn.peer);
          const fromNickname = meta.fromNickname || fromUid;
          const fromAvatarSeed = meta.fromAvatarSeed || fromUid;
          const inviteId = meta.inviteId || ('inc_' + Date.now());
          const roomId = meta.roomId || ('room_' + fromUid);
          conn.on('open', () => {
            logger.info('[P2P] Incoming call from ' + fromUid);
            const expireTimer = setTimeout(() => { this.rejectIncomingCall(); this.emit('invite-expired', { inviteId }); }, 30000);
            this.incomingCall = { conn, fromUid, fromNickname, fromAvatarSeed, inviteId, roomId, expireTimer, accepted: false };
            const invite: IInvite = { id: inviteId, fromUid, fromNickname, fromAvatarSeed, toUid: this.user.uid, roomId, status: 'pending', createdAt: Date.now(), expiresAt: Date.now() + 30_000 };
            this.emit('invite', { invite });
            conn.on('data', (data: any) => { if (data?.type === 'call-cancel') { this.rejectIncomingCall(); this.emit('invite-expired', { inviteId }); } });
            conn.on('close', () => { if (this.incomingCall?.conn === conn && !this.incomingCall.accepted) { this.incomingCall = null; this.emit('invite-expired', { inviteId }); } });
          });
          conn.on('error', () => { if (this.incomingCall?.conn === conn) this.incomingCall = null; });
        });
      });
      await this.openPromise;
    } catch (err: any) {
      logger.error('[P2P] connect failed:', String(err));
      this.setStatus('disconnected');
      throw err;
    }
  }

  disconnect() {
    this.stopHeartbeat();
    if (this.conn) { try { this.conn.close(); } catch {} this.conn = null; }
    if (this.peer) { try { this.peer.destroy(); } catch {} this.peer = null; }
    if (this.incomingCall) { clearTimeout(this.incomingCall.expireTimer); this.incomingCall = null; }
    this.partner = null; this.currentRoom = null; this.currentRoomId = null; this.role = null;
    this.setStatus('disconnected');
  }

  getStatus(): ConnectionStatus { return this.status; }
  getWsUrl(): string { return `p2p://${PEER_CONFIG.host} (WebRTC DataChannel)`; }
  onStatusChange(cb: (status: ConnectionStatus) => void): void { this.statusChangeCb = cb; }
  private setStatus(status: ConnectionStatus) { this.status = status; this.statusChangeCb?.(status); }
  getUser(): IListenTogetherUser { return this.user; }

  updateUser(patch: Partial<Pick<IListenTogetherUser, 'nickname' | 'avatarSeed'>>) {
    const oldNick = this.user.nickname;
    updateLocalUser(patch);
    this.user = getLocalUser();
    if (this.conn?.open && patch.nickname && patch.nickname !== oldNick) {
      this.sendRaw('member-update', { uid: this.user.uid, nickname: this.user.nickname, avatarSeed: this.user.avatarSeed });
    }
  }

  private setupConnection(conn: DataConnection, role: 'host' | 'guest') {
    this.conn = conn;
    this.role = role;
    conn.on('open', () => {
      logger.info('[P2P] DataChannel opened with ' + conn.peer);
      this.startHeartbeat();
      const partnerUid = fromPeerId(conn.peer);
      this.partner = { uid: partnerUid, nickname: partnerUid, avatarSeed: partnerUid, isHost: role === 'guest', lastSeen: Date.now(), joinedAt: Date.now() };
      const roomId = role === 'host' ? `room_${this.user.uid}` : `room_${partnerUid}`;
      const hostUid = role === 'host' ? this.user.uid : partnerUid;
      this.currentRoom = {
        roomId, hostUid,
        members: [
          { uid: this.user.uid, nickname: this.user.nickname, avatarSeed: this.user.avatarSeed, isHost: role === 'host', lastSeen: Date.now(), joinedAt: Date.now() },
          this.partner,
        ],
        currentTrackId: null, currentTrack: null, isPlaying: false, hostTime: 0, hostTimeAt: 0, createdAt: Date.now(),
      };
      this.currentRoomId = roomId;
      this.emit('member-joined', { uid: partnerUid, nickname: this.partner.nickname, avatarSeed: this.partner.avatarSeed, isHost: this.partner.isHost });
      if (role === 'host') setTimeout(() => this.sendRaw('hello', { uid: this.user.uid, nickname: this.user.nickname, avatarSeed: this.user.avatarSeed }), 300);
    });
    conn.on('data', (data: any) => this.handleMessage(data));
    conn.on('close', () => {
      logger.info('[P2P] DataChannel closed');
      this.stopHeartbeat();
      this.conn = null; this.partner = null;
      const leftUid = this.currentRoom?.members.find(m => m.uid !== this.user.uid)?.uid;
      if (leftUid) this.emit('member-left', { uid: leftUid });
      this.currentRoom = null; this.currentRoomId = null; this.role = null;
    });
    conn.on('error', (err) => logger.error('[P2P] DataChannel error:', String(err)));
  }

  private handleMessage(msg: any) {
    if (!msg || !msg.type) return;
    const { type, payload } = msg;
    logger.info('[P2P] recv:', type);
    if (type === 'heartbeat') {
      this.lastHeartbeat = Date.now();
      if (this.partner) this.partner.lastSeen = Date.now();
      if (payload?.reply) this.sendRaw('heartbeat-reply', { t: Date.now() });
      return;
    }
    if (type === 'heartbeat-reply') { this.lastHeartbeat = Date.now(); return; }
    if (type === 'hello') {
      if (this.partner && payload) {
        this.partner.nickname = payload.nickname || this.partner.nickname;
        this.partner.avatarSeed = payload.avatarSeed || this.partner.avatarSeed;
      }
      if (this.currentRoom) {
        const m = this.currentRoom.members.find(x => x.uid === payload.uid);
        if (m) { m.nickname = payload.nickname || m.nickname; m.avatarSeed = payload.avatarSeed || m.avatarSeed; }
      }
      this.emit('member-update', { uid: payload.uid, nickname: payload.nickname, avatarSeed: payload.avatarSeed });
      return;
    }
    if (type === 'member-update') {
      if (this.currentRoom) {
        const m = this.currentRoom.members.find(x => x.uid === payload.uid);
        if (m) { m.nickname = payload.nickname || m.nickname; m.avatarSeed = payload.avatarSeed || m.avatarSeed; }
      }
      this.emit('member-update', payload);
      return;
    }
    if (type === 'room-state' && this.role === 'guest') {
      if (payload && this.currentRoom) {
        this.currentRoom.isPlaying = payload.isPlaying ?? false;
        this.currentRoom.currentTrack = payload.currentTrack ?? null;
        this.currentRoom.currentTrackId = payload.currentTrackId ?? null;
        this.currentRoom.hostTime = payload.hostTime ?? 0;
        this.currentRoom.hostTimeAt = payload.hostTimeAt ?? Date.now();
      }
      return;
    }
    this.emit(type, payload);
  }

  private sendRaw(type: string, payload: any = {}) {
    if (!this.conn?.open) { logger.warn('[P2P] send failed: no open connection, type=' + type); return; }
    this.conn.send({ type, payload, from: this.user.uid, roomId: this.currentRoomId || '', timestamp: Date.now() });
  }

  private emit(type: string, payload: any) {
    const set = this.handlers.get(type);
    if (!set) return;
    const msg = { type, payload, from: '', roomId: this.currentRoomId || '', timestamp: Date.now() };
    set.forEach(h => { try { h(msg); } catch (e: any) { logger.error('[P2P] handler error:', String(e)); } });
  }

  on(type: string, handler: MessageHandler): () => void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler);
    return () => { this.handlers.get(type)?.delete(handler); };
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.lastHeartbeat = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (!this.conn?.open) return;
      this.sendRaw('heartbeat', { reply: true, t: Date.now() });
      if (Date.now() - this.lastHeartbeat > 25000) { logger.warn('[P2P] heartbeat timeout, closing connection'); this.conn?.close(); }
    }, 10000);
  }

  private stopHeartbeat() { if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; } }

  getCurrentRoomId(): string | null { return this.currentRoomId; }

  async createRoom(): Promise<string> {
    if (this.status !== 'connected') await this.connect();
    const roomId = `room_${this.user.uid}`;
    this.currentRoomId = roomId;
    this.role = 'host';
    this.currentRoom = {
      roomId, hostUid: this.user.uid,
      members: [{ uid: this.user.uid, nickname: this.user.nickname, avatarSeed: this.user.avatarSeed, isHost: true, lastSeen: Date.now(), joinedAt: Date.now() }],
      currentTrackId: null, currentTrack: null, isPlaying: false, hostTime: 0, hostTimeAt: 0, createdAt: Date.now(),
    };
    logger.info('[P2P] room created (host mode): ' + roomId);
    return roomId;
  }

  async joinRoom(roomIdOrPeerUid: string): Promise<boolean> {
    if (this.status !== 'connected') await this.connect();
    if (!this.peer) return false;
    let peerUid = roomIdOrPeerUid;
    if (roomIdOrPeerUid.startsWith('room_')) peerUid = roomIdOrPeerUid.slice(5);
    if (peerUid === this.user.uid) return false;
    try {
      const peerId = toPeerId(peerUid);
      logger.info('[P2P] connecting to peer: ' + peerId);
      const conn = this.peer.connect(peerId, { reliable: true, label: 'audioviz_listen_together', metadata: { fromUid: this.user.uid, fromNickname: this.user.nickname, fromAvatarSeed: this.user.avatarSeed, app: 'audioviz' } });
      this.setupConnection(conn, 'guest');
      const connected = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(false), 30000);
        conn.on('open', () => { clearTimeout(timeout); resolve(true); });
        conn.on('error', () => { clearTimeout(timeout); resolve(false); });
        conn.on('close', () => { clearTimeout(timeout); resolve(false); });
      });
      if (connected) { logger.info('[P2P] joined room via P2P'); return true; }
      else { logger.warn('[P2P] failed to connect to peer'); return false; }
    } catch (err: any) {
      logger.error('[P2P] joinRoom error:', String(err));
      return false;
    }
  }

  async leaveRoom(): Promise<void> {
    if (this.conn) {
      try { this.sendRaw('leave', { uid: this.user.uid }); } catch {}
      try { this.conn.close(); } catch {}
      this.conn = null;
    }
    this.partner = null; this.currentRoom = null; this.currentRoomId = null; this.role = null;
    logger.info('[P2P] left room');
  }

  getRoom(roomId: string): IRoomState | null { if (roomId === this.currentRoomId) return this.currentRoom; return null; }
  async fetchRoomInfo(): Promise<IRoomState | null> { return this.currentRoom; }
  updateRoom(patch: Partial<IRoomState>) { if (!this.currentRoom) return; Object.assign(this.currentRoom, patch); }

  broadcastPlayState(isPlaying: boolean, currentTime: number) {
    if (!this.conn?.open || !this.currentRoom) return;
    this.sendRaw('sync-play', { isPlaying, currentTime });
    this.currentRoom.isPlaying = isPlaying;
    this.currentRoom.hostTime = currentTime;
    this.currentRoom.hostTimeAt = Date.now();
  }

  broadcastTrack(track: ITrack | null, currentTime: number) {
    if (!this.conn?.open || !this.currentRoom) return;
    this.sendRaw('sync-track', { track, currentTime });
    this.currentRoom.currentTrack = track;
    this.currentRoom.currentTrackId = track?.id || null;
    this.currentRoom.hostTime = currentTime;
    this.currentRoom.hostTimeAt = Date.now();
  }

  broadcastSeek(currentTime: number) {
    if (!this.conn?.open) return;
    this.sendRaw('sync-seek', { currentTime });
    if (this.currentRoom) { this.currentRoom.hostTime = currentTime; this.currentRoom.hostTimeAt = Date.now(); }
  }

  reportProgress(currentTime: number) { if (!this.conn?.open) return; if (this.role === 'host') this.sendRaw('report-progress', { currentTime }); }
  startProgressReport(_?: () => number) {}
  stopProgressReport() {}
  startProgressSync() {}
  stopProgressSync() {}
  checkDrift(): { driftMembers: string[]; correctTime: number } { return { driftMembers: [], correctTime: 0 }; }

  async sendInvite(toUid: string): Promise<{ success: boolean; message: string; invite?: IInvite; targetOnline: boolean }> {
    if (!this.peer) return { success: false, message: '未连接信令服务器', targetOnline: false };
    const inviteId = 'inv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const roomId = `room_${this.user.uid}`;
    const invite: IInvite = { id: inviteId, fromUid: this.user.uid, fromNickname: this.user.nickname, fromAvatarSeed: this.user.avatarSeed, toUid, roomId, status: 'pending', createdAt: Date.now(), expiresAt: Date.now() + 30_000 };
    if (!this.currentRoomId) await this.createRoom();
    try {
      const peerId = toPeerId(toUid);
      logger.info('[P2P] calling peer: ' + peerId);
      const conn = this.peer.connect(peerId, { reliable: true, label: 'audioviz_listen_together', metadata: { fromUid: this.user.uid, fromNickname: this.user.nickname, fromAvatarSeed: this.user.avatarSeed, inviteId, roomId, app: 'audioviz' } });
      const accepted = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => { try { conn.close(); } catch {} resolve(false); }, 30000);
        conn.on('error', () => { clearTimeout(timeout); resolve(false); });
        conn.on('close', () => { clearTimeout(timeout); resolve(false); });
        conn.on('open', () => {
          logger.info('[P2P] call connected, waiting for answer...');
          conn.on('data', (data: any) => {
            if (data?.type === 'call-accept') { clearTimeout(timeout); resolve(true); }
            else if (data?.type === 'call-reject') { clearTimeout(timeout); try { conn.close(); } catch {} resolve(false); }
            else if (data?.type === 'busy') { clearTimeout(timeout); try { conn.close(); } catch {} resolve(false); }
          });
        });
      });
      if (accepted) {
        if (this.conn && this.conn !== conn) { try { this.conn.close(); } catch {} }
        this.setupConnection(conn, 'host');
        this.emit('invite-reply', { accepted: true, fromNickname: toUid });
        return { success: true, message: '对方已接受，P2P 连接建立成功', targetOnline: true, invite: { ...invite, status: 'accepted' } };
      } else {
        return { success: false, message: '呼叫未接通（对方不在线、拒绝或网络受限）', targetOnline: false };
      }
    } catch (err: any) {
      logger.error('[P2P] sendInvite error:', String(err));
      return { success: false, message: '呼叫失败：' + (err.message || '未知错误'), targetOnline: false };
    }
  }

  async replyInvite(inviteId: string, accepted: boolean): Promise<{ accepted: boolean; room?: IRoomState }> {
    if (!this.incomingCall || this.incomingCall.inviteId !== inviteId) return { accepted: false };
    if (accepted) return this.acceptIncomingCall();
    else { this.rejectIncomingCall(); return { accepted: false }; }
  }

  private acceptIncomingCall(): { accepted: boolean; room?: IRoomState } {
    if (!this.incomingCall) return { accepted: false };
    const { conn, expireTimer } = this.incomingCall;
    this.incomingCall.accepted = true;
    clearTimeout(expireTimer);
    try { conn.send({ type: 'call-accept', payload: { uid: this.user.uid, nickname: this.user.nickname } }); } catch {}
    this.setupConnection(conn, 'guest');
    this.incomingCall = null;
    if (this.currentRoom) return { accepted: true, room: this.currentRoom };
    return { accepted: true };
  }

  private rejectIncomingCall() {
    if (!this.incomingCall) return;
    const { conn, expireTimer } = this.incomingCall;
    clearTimeout(expireTimer);
    try { conn.send({ type: 'call-reject', payload: { reason: 'declined' } }); } catch {}
    setTimeout(() => { try { conn.close(); } catch {} }, 500);
    this.incomingCall = null;
  }

  cleanupExpiredInvites() {}
  async checkOnline(uid: string): Promise<{ online: boolean; nickname?: string; avatarSeed?: string }> { return { online: false }; }
  getOnlineUserInfo(_uid: string) { return null; }
  refreshUser() { if (this.conn?.open) this.sendRaw('member-update', { uid: this.user.uid, nickname: this.user.nickname, avatarSeed: this.user.avatarSeed }); }
}

let p2pInstance: P2PListenTogetherService | null = null;
export function getP2PListenTogetherService(): P2PListenTogetherService { if (!p2pInstance) p2pInstance = new P2PListenTogetherService(); return p2pInstance; }
