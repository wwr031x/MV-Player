// 一起听 Context
//
// 核心原则：绝不阻塞首屏。
// Service 通过 adapter 动态 import 懒加载，加载失败降级为"未连接"状态。
// children 始终正常渲染，一起听功能不可用时只是相关按钮灰掉。

import { useState, useRef, useEffect, useCallback, createContext, useContext, useMemo, type ReactNode } from 'react';
import { toast } from 'sonner';
import { logger } from '@lark-apaas/client-toolkit-lite';
import { resolveAppUrl } from '@lark-apaas/client-toolkit-lite';
import { usePlayer } from './PlayerContext';
import { appendChatHistory, getChatHistory, clearChatHistory } from '@/lib/listenTogether.danmaku';
import {
  getListenTransportService,
  getCurrentTransportType,
  updateLocalUser,
  type IRoomMember,
  type IRoomState,
  type IInvite,
  type IListenTogetherUser,
  type TransportType,
  type IListenTogetherService,
} from '@/lib/listenTogether.adapter';
import type { ITrack, IDanmakuMessage } from '@/types';

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'loading' | 'error';

/** 从 URL 读取房间号（优先 query，兜底 hash；同时写入 sessionStorage 防 OAuth 跳转丢失） */
function readRoomFromUrl(): { roomId: string; source: string } | null {
  const PENDING_KEY = '__lt_pending_room__';
  const ROOM_RE = /^room_[a-zA-Z0-9]+$/;
  try {
    // 1. 优先读路径形式（/join/<roomId> 或 /room/<roomId>）— 经 OAuth 302 后最可能存活
    const path = window.location.pathname || '';
    const pathMatch = path.match(/\/(join|room)\/(room_[a-zA-Z0-9]+)/i);
    if (pathMatch && pathMatch[2] && ROOM_RE.test(pathMatch[2])) {
      sessionStorage.setItem(PENDING_KEY, pathMatch[2]);
      return { roomId: pathMatch[2], source: 'path' };
    }
  } catch { /* ignore */ }
  try {
    // 2. 读 query 参数
    const sParams = new URLSearchParams(window.location.search);
    const v = sParams.get('room');
    if (v && ROOM_RE.test(v)) {
      sessionStorage.setItem(PENDING_KEY, v);
      return { roomId: v, source: 'query' };
    }
  } catch { /* ignore */ }
  try {
    // 3. 兜底 hash 内参数
    const hash = window.location.hash || '';
    const qIdx = hash.indexOf('?');
    if (qIdx >= 0) {
      const params = new URLSearchParams(hash.slice(qIdx + 1));
      const v = params.get('room');
      if (v && ROOM_RE.test(v)) {
        sessionStorage.setItem(PENDING_KEY, v);
        return { roomId: v, source: 'hash' };
      }
    }
  } catch { /* ignore */ }
  try {
    // 4. 兜底 sessionStorage（OAuth 跳转后 URL 参数可能全丢）
    const cached = sessionStorage.getItem(PENDING_KEY);
    if (cached && ROOM_RE.test(cached)) return { roomId: cached, source: 'sessionStorage' };
  } catch { /* ignore */ }
  return null;
}

function clearPendingRoom() {
  try { sessionStorage.removeItem('__lt_pending_room__'); } catch { /* ignore */ }
}

interface ListenTogetherContextValue {
  user: IListenTogetherUser;
  updateUser: (patch: Partial<Pick<IListenTogetherUser, 'nickname' | 'avatarSeed'>>) => void;
  inRoom: boolean;
  room: IRoomState | null;
  members: IRoomMember[];
  isHost: boolean;
   roomId: string | null;
   connStatus: ConnectionStatus;
  wsUrl: string;
  transportType: TransportType;
  /** URL 中检测到的邀请房间号（query/hash/路径/sessionStorage 任一种） */
  inviteRoomId: string | null;
  /** 邀请房间号的来源，用于面板状态显示 */
  inviteRoomSource: string | null;
  /** 自动加入失败的错误信息（null 表示未失败或未尝试） */
  autoJoinError: string | null;
  createRoom: () => Promise<string>;
  joinRoom: (roomId: string) => Promise<boolean>;
  leaveRoom: () => Promise<void>;
  retryAutoJoin: () => void;
  isUserOnline: (uid: string) => Promise<boolean>;
  getOnlineUserInfo: (uid: string) => any;
  // 弹幕
  danmakuMessages: IDanmakuMessage[];
  sendDanmaku: (content: string) => void;
  chatHistory: IDanmakuMessage[];
  // 共享队列
  sharedQueue: ITrack[];
  addTracksToSharedQueue: (tracks: ITrack[]) => void;
  removeFromSharedQueue: (trackIds: string[]) => void;
  reorderSharedQueue: (fromIndex: number, toIndex: number) => void;
  clearSharedQueue: () => void;
  // 投票切歌（仅多人房 3+ 生效，双人房不使用）
  skipVotes: string[];
  prevVotes: string[];
  skipVoteThreshold: number;
  hasSkippedVoted: boolean;
  hasPrevVoted: boolean;
  castSkipVote: () => void;
  castPrevVote: () => void;
  // 个人暂停
  selfPaused: boolean;
  toggleSelfPlayPause: () => void;
  // 房间内进度条拖动（双人房可用，多人房锁定）
  seekInRoom: (time: number) => void;
   // 是否双人房（用于 UI 切换）
   isDualRoom: boolean;
   // 当前网易云登录用户（同步昵称/头像到房间和消息）
   neteaseUser: { userId: number; nickname: string; avatarUrl: string } | null;
   setNeteaseUser: (u: { userId: number; nickname: string; avatarUrl: string } | null) => void;
   // 获取成员显示信息（昵称/头像/编号），未登录网易云时用「一起听N号」+ 默认头像
   getMemberDisplayInfo: (uid: string) => { nickname: string; avatarUrl?: string; avatarSeed: string; memberIndex: number; isNetease: boolean };
   /** 获取歌曲添加者显示信息：优先从当前成员表取最新资料，降级到 addedBy 快照，再降级到「一起听N号」 */
   getTrackAddedByInfo: (addedBy: ITrack['addedBy'] | undefined) => { nickname: string; avatarUrl?: string; avatarSeed: string; isNetease: boolean; hasLeft: boolean };
 }

const ListenTogetherContext = createContext<ListenTogetherContextValue | null>(null);

export function useListenTogether() {
  const ctx = useContext(ListenTogetherContext);
  if (!ctx) throw new Error('useListenTogether must be used within ListenTogetherProvider');
  return ctx;
}

export function ListenTogetherProvider({ children }: { children: ReactNode }) {
  const {
    currentTrack,
    isPlaying,
    currentTime,
    audioElement,
    playTrackById,
    addTracks,
    queue,
    nextTrack,
    prevTrack,
    seek,
    playListAt,
    clearQueue,
    removeTrack,
  } = usePlayer();

  const serviceRef = useRef<IListenTogetherService | null>(null);
  const isApplyingRemoteRef = useRef(false);
  const lastBroadcastStateRef = useRef({ isPlaying: false, currentTime: 0, trackId: '' });
  const snapshotRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoJoinFnRef = useRef<(() => Promise<void>) | null>(null);

   const [user, setUser] = useState<IListenTogetherUser>(() => ({ uid: '', nickname: '', avatarSeed: '' }));
   const [neteaseUser, setNeteaseUserState] = useState<{ userId: number; nickname: string; avatarUrl: string } | null>(null);

   // 同步网易云登录态到 service（让房间成员能看到头像）
   const setNeteaseUser = useCallback((u: { userId: number; nickname: string; avatarUrl: string } | null) => {
     setNeteaseUserState(u);
     const svc = serviceRef.current;
     if (svc && typeof (svc as any).setNeteaseInfo === 'function') {
       (svc as any).setNeteaseInfo(u);
     }
   }, []);
   const [room, setRoom] = useState<IRoomState | null>(null);
  const [invites, setInvites] = useState<IInvite[]>([]);
  const [inRoom, setInRoom] = useState(false);
  const [connStatus, setConnStatus] = useState<ConnectionStatus>('disconnected');
  const [wsUrl, setWsUrl] = useState('');
  const [transportType, setTransportType] = useState<TransportType>('supabase');
  const [inviteRoomId, setInviteRoomId] = useState<string | null>(null);
  const [inviteRoomSource, setInviteRoomSource] = useState<string | null>(null);
  const [autoJoinError, setAutoJoinError] = useState<string | null>(null);
  // 弹幕相关
  const [danmakuMessages, setDanmakuMessages] = useState<IDanmakuMessage[]>([]);
  const [chatHistory, setChatHistory] = useState<IDanmakuMessage[]>([]);
  const lastDanmakuIdRef = useRef<string>('');
  // 投票切歌：已投票成员 uid 列表
  const [skipVotes, setSkipVotes] = useState<string[]>([]);
  const [prevVotes, setPrevVotes] = useState<string[]>([]);
  // 个人暂停标记：true = 自己手动暂停了，房间仍在播放，恢复时需追赶
  const [selfPaused, setSelfPaused] = useState(false);
  const selfPausedRef = useRef(false);
  selfPausedRef.current = selfPaused;

  // 房间状态引用
  const roomRef = useRef<IRoomState | null>(null);
  roomRef.current = room;

  // ===== 懒加载 service（不阻塞首屏，失败降级） =====
  useEffect(() => {
    let mounted = true;
    let unsubs: (() => void)[] = [];
    let statusTimer: number | null = null;

    setConnStatus('loading');
    setTransportType(getCurrentTransportType());

    // 异步加载 service
    getListenTransportService()
      .then((svc) => {
        if (!mounted) return;
        serviceRef.current = svc;

        try {
          const u = (svc as any).getUser?.() || { uid: '', nickname: '', avatarSeed: '' };
          setUser(u);
          setWsUrl((svc as any).getWsUrl?.() || '');
        } catch { /* ignore */ }

        // 注册事件监听
        const onEvt = (evt: string, handler: (msg: any) => void) => {
          try {
            const unsub = (svc as any).on?.(evt, handler);
            if (typeof unsub === 'function') unsubs.push(unsub);
          } catch { /* ignore */ }
        };

        // 邀请到达
        onEvt('invite', (msg: any) => {
          const inv = msg?.payload?.invite as IInvite;
          if (!inv) return;
          logger.info('[LTCtx] received invite from ' + inv.fromNickname);
          setInvites((prev) => {
            if (prev.find((i) => i.id === inv.id)) return prev;
            return [...prev, inv];
          });
          toast.info(`${inv.fromNickname} 邀请你一起听`, {
            description: '点击「一起听」面板查看',
            duration: 6000,
          });
        });

        // 邀请回复
        onEvt('invite-reply', (msg: any) => {
          const { accepted, fromNickname } = msg?.payload || {};
          if (accepted) {
            toast.success(`${fromNickname} 接受了邀请`);
            refreshRoom();
          } else {
            toast.info(`${fromNickname} 拒绝了邀请`);
          }
        });

        // 邀请过期
        onEvt('invite-expired', (msg: any) => {
          const { inviteId } = msg?.payload || {};
          if (inviteId) setInvites((prev) => prev.filter((i) => i.id !== inviteId));
        });

        // 成员加入
        onEvt('member-joined', (msg: any) => {
          const uid = msg?.payload?.uid;
          const myUid = (svc as any).getUser?.()?.uid;
          if (uid === myUid) return;
          logger.info('[LTCtx] member joined: ' + msg?.payload?.nickname);
          toast.success(`${msg?.payload?.nickname || '新成员'} 加入了房间`);
          refreshRoom();
        });

        // 成员离开
        onEvt('member-left', (msg: any) => {
          const myUid = (svc as any).getUser?.()?.uid;
          if (msg?.payload?.uid === myUid) return;
          logger.info('[LTCtx] member left: ' + msg?.payload?.uid);
          toast.info(`有人离开了房间`);
          refreshRoom();
        });

        // 成员更新
        onEvt('member-update', () => {
          refreshRoom();
        });

        // 播放状态同步（房主心跳也会触发此事件，作为权威状态同步）
        // 注意：个人暂停态下，只更新房间权威进度，不强制恢复播放
        onEvt('sync-play', (msg: any) => {
          const myUid = (svc as any).getUser?.()?.uid;
          if (msg?.from === myUid) return;
          const { isPlaying: remotePlaying, currentTime: remoteTime } = msg?.payload || {};
          // 自我暂停态：忽略远程播放/暂停控制，但保留对 room 状态的更新（用于追赶计算）
          // 这里 applyRemotePlayState 会动 audioElement，所以 selfPaused 时跳过
          if (selfPausedRef.current) return;
          applyRemotePlayState(!!remotePlaying, remoteTime ?? 0, msg.timestamp || Date.now());
        });

         // 切歌同步
         onEvt('sync-track', (msg: any) => {
           const myUid = (svc as any).getUser?.()?.uid;
           if (msg?.from === myUid) return;
           const { track, currentTime: remoteTime } = msg?.payload || {};
           applyRemoteTrack(track, remoteTime ?? 0, msg.timestamp || Date.now());
           // 切歌后清空投票状态
           setSkipVotes([]);
           setPrevVotes([]);
         });

         // 进度 seek 同步（双人房双方都可拖，多人房房主触发）
         // 注意：即使 selfPaused 也要同步进度，保证恢复时能追上；但不改变暂停状态
         onEvt('sync-seek', (msg: any) => {
           const myUid = (svc as any).getUser?.()?.uid;
           if (msg?.from === myUid) return;
           const { currentTime: remoteTime } = msg?.payload || {};
           if (typeof remoteTime !== 'number') return;
           if (selfPausedRef.current) {
             // 暂停中：只更新 audioElement.currentTime，不触发播放
             if (audioElement) {
               const ts = msg.timestamp || Date.now();
               const elapsed = Math.max(0, (Date.now() - ts) / 1000);
               audioElement.currentTime = remoteTime + elapsed;
             }
           } else {
             applyRemoteSeek(remoteTime, msg.timestamp || Date.now());
           }
         });

         // 投票切歌：对方投了/取消了
         onEvt('skip-vote', (msg: any) => {
           const { uid, voted } = msg?.payload || {};
           if (!uid) return;
           handleRemoteSkipVote(uid, !!voted);
         });

         // 上一首投票
         onEvt('prev-vote', (msg: any) => {
           const { uid, voted } = msg?.payload || {};
           if (!uid) return;
           handleRemotePrevVote(uid, !!voted);
         });

        // 房主转让
        onEvt('host-transfer', (msg: any) => {
          const { newHostUid } = msg?.payload || {};
          const myUid = (svc as any).getUser?.()?.uid;
          logger.info('[LTCtx] host transferred to ' + newHostUid);
          if (newHostUid === myUid) {
            toast.success('你成为新房主');
          }
          refreshRoom();
        });

        // 房间解散
        onEvt('room-disband', () => {
          logger.info('[LTCtx] room disbanded');
          handleRemoteDisband();
        });

        // 聊天弹幕
        onEvt('chat-message', (msg: any) => {
          const myUid = (svc as any).getUser?.()?.uid;
          if (msg?.from === myUid) return; // 自己发的不重复接收
          const payload = msg?.payload || {};
          const dm: IDanmakuMessage = {
            id: payload.id || `r_${Date.now()}`,
            fromUid: payload.fromUid || msg.from || '',
            fromNickname: payload.fromNickname || '匿名',
            fromAvatarSeed: payload.fromAvatarSeed || '',
            content: payload.content || '',
            timestamp: payload.timestamp || Date.now(),
            roomId: room?.roomId || '',
          };
          if (!dm.content.trim()) return;
          setDanmakuMessages((prev) => [...prev.slice(-50), dm]);
          // 追加到本地历史
          appendChatHistory(dm.roomId, dm);
          setChatHistory(getChatHistory(dm.roomId));
        });

        // 队列变更 - 添加
        onEvt('queue-add', (msg: any) => {
          const myUid = (svc as any).getUser?.()?.uid;
          if (msg?.from === myUid) return;
          refreshRoom();
        });

        // 队列变更 - 移除
        onEvt('queue-remove', (msg: any) => {
          const myUid = (svc as any).getUser?.()?.uid;
          if (msg?.from === myUid) return;
          refreshRoom();
        });

        // 队列变更 - 重排序
        onEvt('queue-reorder', (msg: any) => {
          const myUid = (svc as any).getUser?.()?.uid;
          if (msg?.from === myUid) return;
          refreshRoom();
        });

        // 队列清空
        onEvt('queue-clear', (msg: any) => {
          const myUid = (svc as any).getUser?.()?.uid;
          if (msg?.from === myUid) return;
          refreshRoom();
        });

        // 收到房间快照（重连或加入时恢复状态）
        onEvt('room-snapshot', (msg: any) => {
          const myUid = (svc as any).getUser?.()?.uid;
          const snap = msg?.payload || {};
          // 只处理目标是自己的快照
          if (snap.targetUid && snap.targetUid !== myUid) return;
          logger.info('[LTCtx] received room snapshot');
          // 收到快照 → 停止重试
          if (snapshotRetryTimerRef.current) {
            clearTimeout(snapshotRetryTimerRef.current);
            snapshotRetryTimerRef.current = null;
          }
          // 应用共享队列到本地（仅当本地队列空时才替换，避免覆盖本地已有数据）
          if (snap.sharedQueue && Array.isArray(snap.sharedQueue) && queue.length === 0) {
            addTracks(snap.sharedQueue, false);
          }
          // 如果有当前歌曲且本地没有，切歌并按权威时间戳对齐进度
          if (snap.currentTrack && audioElement) {
            applyRemoteTrack(snap.currentTrack, snap.hostTime || 0, snap.hostTimeAt || Date.now());
            // 切歌完成后同步播放状态（暂停态也要正确同步）
            setTimeout(() => {
              if (audioElement) {
                applyRemotePlayState(!!snap.isPlaying, snap.hostTime || 0, snap.hostTimeAt || Date.now());
                if (!snap.isPlaying) {
                  // 房间暂停：明确暂停，显示暂停状态
                  audioElement.pause();
                }
              }
            }, 800);
          }
          refreshRoom();
        });

        // 收到快照请求（房主回复，非房主也可以辅助回复）
        onEvt('room-snapshot-request', (msg: any) => {
          const myUid = (svc as any).getUser?.()?.uid;
          if (msg?.from === myUid) return;
          // 只有房主回复，避免多人重复
          if (room?.hostUid === myUid) {
            try {
              (svc as any).sendRoomSnapshot?.(msg?.payload?.requesterUid);
            } catch { /* ignore */ }
          }
        });

        // 连接状态轮询
        let prevStatus = '';
        statusTimer = window.setInterval(() => {
          const s = (svc as any).getStatus?.() || (svc as any).getConnStatus?.() || 'disconnected';
          if (s !== prevStatus) {
            setConnStatus(s as ConnectionStatus);
            if (s === 'reconnecting') {
              toast.warning('连接断开，正在重连...', { id: 'lt-reconnect' });
            } else if (s === 'connected' && prevStatus === 'reconnecting') {
              toast.success('已重新连接', { id: 'lt-reconnect' });
            }
            prevStatus = s;
          }
        }, 500);

        // 连接
        try {
          (svc as any).connect?.();
          setConnStatus('connecting');
        } catch {
          setConnStatus('disconnected');
        }

        // 自动加入房间（受邀方打开邀请链接直接进房）
        // 方案：读 URL（路径 > query > hash），写入 sessionStorage 防 OAuth 跳转丢失；
        // 连接建立后在 status change 回调里触发加入；
        // 加入房间后主动请求快照，指数退避重试直到拿到或超时。
        const pending = readRoomFromUrl();
        const pendingRoom = pending?.roomId || '';
        if (pending) {
          setInviteRoomId(pending.roomId);
          setInviteRoomSource(pending.source);
        }
        let autoJoinDone = false;
        const MAX_SNAPSHOT_RETRIES = 6;
        let snapshotRetries = 0;

        const stopSnapshotRetry = () => {
          if (snapshotRetryTimerRef.current) {
            clearTimeout(snapshotRetryTimerRef.current);
            snapshotRetryTimerRef.current = null;
          }
        };

         const requestSnapshotWithRetry = () => {
          if (!svc || !pendingRoom) return;
          const curRoom = (svc as any).getRoom?.(pendingRoom);
          if (curRoom?.currentTrack || (curRoom?.members?.length || 0) > 1) {
            stopSnapshotRetry();
            return;
          }
          try {
            (svc as any).requestRoomSnapshot?.();
          } catch { /* ignore */ }
          snapshotRetries++;
          if (snapshotRetries < MAX_SNAPSHOT_RETRIES) {
            const delay = Math.min(snapshotRetries * 2000, 10000);
            stopSnapshotRetry();
            snapshotRetryTimerRef.current = setTimeout(requestSnapshotWithRetry, delay);
          } else {
            stopSnapshotRetry();
            const memberCount = curRoom?.members?.length || 0;
            if (memberCount <= 1) {
              setAutoJoinError('房间内暂无其他成员，等待房主加入后自动同步（快照超时）');
            }
          }
        };

        const doAutoJoin = async () => {
          if (autoJoinDone || !pendingRoom) return;
          autoJoinDone = true;
          setAutoJoinError(null);
          try {
            const ok = await (svc as any).joinRoom?.(pendingRoom);
            if (ok) {
              const r = (svc as any).getRoom?.(pendingRoom);
              if (r) {
                setRoom({ ...r });
                setInRoom(true);
              }
              toast.success('已加入房间，正在同步状态...', { id: 'lt-auto-join', duration: 3000 });
              snapshotRetries = 0;
              requestSnapshotWithRetry();
            } else {
              const msg = '加入房间失败，房间可能不存在或已解散';
              setAutoJoinError(msg);
              toast.error(msg);
              clearPendingRoom();
            }
          } catch (err) {
            const msg = '加入房间失败：' + ((err as Error)?.message || '未知错误');
            logger.error('[LTCtx] auto join room error:', String(err));
            setAutoJoinError(msg);
            toast.error(msg);
          }
        };

        // 保存到 ref 供 retryAutoJoin 外部调用
        autoJoinFnRef.current = doAutoJoin;

        // 在连接状态变更回调中触发自动加入（连接成功那一刻立即执行）
        const origStatusCb = (svc as any).statusChangeCb;
        (svc as any).onStatusChange?.((s: string) => {
          origStatusCb?.(s);
          if (s === 'connected' && pendingRoom && !autoJoinDone) {
            setTimeout(doAutoJoin, 200);
          }
          // 重连后如果在房间内也重新请求快照
          if (s === 'connected' && (svc as any).getCurrentRoomId?.()) {
            snapshotRetries = 0;
            requestSnapshotWithRetry();
          }
        });
      })
      .catch((err) => {
        if (!mounted) return;
        logger.error('[LTCtx] failed to load transport service: ' + String(err));
        setConnStatus('error');
        serviceRef.current = null;
      });

    return () => {
      mounted = false;
      if (statusTimer) clearInterval(statusTimer);
      unsubs.forEach((u) => {
        try { u(); } catch { /* ignore */ }
      });
      if (serviceRef.current) {
        try {
          (serviceRef.current as any).disconnect?.();
        } catch { /* ignore */ }
      }
    };
    }, []);

    // 刷新房间状态
   const refreshRoom = useCallback(() => {
    const svc = serviceRef.current as any;
    if (!svc) return;
    const roomId = svc.getCurrentRoomId?.() || svc.getRoom?.()?.roomId;
    if (!roomId) return;
    try {
      const r = svc.getRoom?.(roomId) || svc.getRoom?.();
      if (r) setRoom({ ...r });
    } catch { /* ignore */ }
    }, []);

   // 页面可见性监听：后台保留 30 分钟，回到前台自动同步
   useEffect(() => {
     if (!inRoom || !serviceRef.current) return;
     const svc = serviceRef.current as any;

     const handleVisibility = () => {
       if (!audioElement) return;
       if (document.hidden) {
         // 进入后台：降低心跳频率，标记 isBackground
         try {
           svc.enterBackground?.(() => audioElement?.currentTime || 0);
         } catch { /* ignore */ }
       } else {
         // 回到前台：先自检是否已超时
         let timedOut = false;
         try {
           timedOut = !!svc.checkBackgroundTimeout?.();
         } catch { /* ignore */ }
         if (timedOut) {
           setRoom(null);
           setInRoom(false);
           toast.info('后台时间过长，已自动退出房间');
           return;
         }
         try {
           const ok = svc.leaveBackground?.(() => audioElement?.currentTime || 0);
           if (ok === false) {
             setRoom(null);
             setInRoom(false);
             toast.info('后台时间过长，已自动退出房间');
             return;
           }
         } catch { /* ignore */ }
         // 回到前台后请求一次房间快照，追上播放进度和队列
         try {
           svc.requestRoomSnapshot?.();
         } catch { /* ignore */ }
         setTimeout(() => refreshRoom(), 300);
       }
     };

     document.addEventListener('visibilitychange', handleVisibility);
     return () => {
       document.removeEventListener('visibilitychange', handleVisibility);
     };
   }, [inRoom, audioElement, refreshRoom]);

   // 应用远程播放状态（权威状态 + 时间戳插值，偏差超阈值才硬对齐）
  // - 权威消息包含：isPlaying + hostTime（房主那一瞬间的进度）+ hostTimeAt（房主发送时的本地时间戳）
  // - 跟随方按「当前本地时间 - hostTimeAt」计算流逝时间，得到期望进度
  // - 只有当本地进度与期望进度偏差 > DRIFT_THRESHOLD 时才做硬 seek，避免频繁抖动
  const applyRemotePlayState = useCallback(
    (remotePlaying: boolean, remoteTime: number, remoteTimestamp: number) => {
      if (!audioElement) return;
      isApplyingRemoteRef.current = true;
      try {
        const now = Date.now();
        // 按权威时间戳插值：消息从发出到现在经过了多久，播放态下就累加多久
        const elapsedSinceHost = remotePlaying
          ? Math.max(0, (now - remoteTimestamp) / 1000)
          : 0;
        const expectedTime = remoteTime + elapsedSinceHost;

        // 播放/暂停状态直接同步（状态必须一致）
        if (remotePlaying !== audioElement.paused) {
          if (remotePlaying) {
            audioElement.play().catch(() => {});
          } else {
            audioElement.pause();
          }
        }

        // 进度偏差超过阈值才硬对齐，避免网络抖动造成频繁 seek
        const drift = Math.abs(audioElement.currentTime - expectedTime);
        const DRIFT_THRESHOLD = 1.5;
        if (drift > DRIFT_THRESHOLD) {
          // 直接一步到位，不要分步调整 —— 1.5s 以上的偏差本来就该立刻修正
          audioElement.currentTime = expectedTime;
        }
      } finally {
        setTimeout(() => {
          isApplyingRemoteRef.current = false;
        }, 200);
      }
    },
    [audioElement]
  );

  // 应用远程切歌（按权威时间戳插值对齐）
  const applyRemoteTrack = useCallback(
    (track: ITrack | null, remoteTime: number, remoteTimestamp?: number) => {
      if (!track) return;
      isApplyingRemoteRef.current = true;
      const wasSelfPaused = selfPausedRef.current;
      try {
        const existing = queue.find((t) => t.id === track.id);
        if (existing) {
          playTrackById(track.id);
        } else {
          addTracks([track], true);
        }
        // 加载完成后 seek 到权威进度（考虑消息传输延迟）
        // 如果自己处于暂停态，切歌后也保持暂停
        setTimeout(() => {
          if (audioElement) {
            const ts = remoteTimestamp || Date.now();
            const elapsed = Math.max(0, (Date.now() - ts) / 1000);
            audioElement.currentTime = remoteTime + elapsed;
            if (wasSelfPaused) {
              audioElement.pause();
            }
          }
        }, 500);
      } finally {
        setTimeout(() => {
          isApplyingRemoteRef.current = false;
        }, 700);
      }
    },
    [audioElement, queue, addTracks, playTrackById]
  );

  // 应用远程 seek（按权威时间戳插值，避免网络延迟导致进度越拉越远）
  const applyRemoteSeek = useCallback(
    (remoteTime: number, remoteTimestamp?: number) => {
      if (!audioElement) return;
      isApplyingRemoteRef.current = true;
      try {
        const ts = remoteTimestamp || Date.now();
        const elapsed = Math.max(0, (Date.now() - ts) / 1000);
        audioElement.currentTime = remoteTime + elapsed;
      } finally {
        setTimeout(() => {
          isApplyingRemoteRef.current = false;
        }, 100);
      }
    },
    [audioElement]
  );

  const handleRemoteDisband = useCallback(() => {
    const rid = room?.roomId || '';
    setRoom(null);
    setInRoom(false);
    setDanmakuMessages([]);
    setChatHistory([]);
    setSkipVotes([]);
    setPrevVotes([]);
    setSelfPaused(false);
    if (audioElement) {
      audioElement.muted = false;
    }
    if (rid) {
      clearChatHistory(rid);
    }
    toast.info('房间已解散');
  }, [room, audioElement]);

  // ===== 监听本地播放状态变化并广播 =====

  // 切歌时广播曲目（房主广播权威曲目变更）
  useEffect(() => {
    if (!inRoom || !room || room.hostUid !== user.uid) return;

    const timer = setInterval(() => {
      if (!audioElement || !serviceRef.current) return;
      const svc = serviceRef.current as any;
      // 房主本地 audio 是权威进度来源（房主不会 self-pause，因为房间持续进行靠房主）
      // 但保险起见：房主暂停时 room.isPlaying 也应该是暂停（房主即权威）
      const time = audioElement.currentTime;
      const playing = !audioElement.paused;
      try {
        svc.broadcastPlayState?.(playing, time);
      } catch { /* ignore */ }
    }, 4000);

    return () => clearInterval(timer);
   }, [inRoom, room, user.uid, audioElement]);

   // 切歌时广播曲目变更（房主广播，全员接收同步）
   useEffect(() => {
     if (!inRoom || !serviceRef.current || isApplyingRemoteRef.current) return;
      if (!room || room.hostUid !== user.uid) return; // 只有房主广播切歌
      // 只有当前歌曲在共享队列里时才同步为房间当前曲
      // （本地播放器的单曲/上传曲目不属于一起听共享范围，不应显示为「正在播放」）
      const inSharedQueue = room.sharedQueue?.some((t) => t.id === currentTrack?.id);
      if (!currentTrack || !inSharedQueue) return;
 
     const svc = serviceRef.current as any;
     const last = lastBroadcastStateRef.current;
     const trackId = currentTrack.id || '';
 
     if (trackId !== last.trackId) {
       last.trackId = trackId;
       try {
         const idx = room?.sharedQueue?.findIndex((t) => t.id === currentTrack.id) ?? -1;
         svc.broadcastCurrentIndex?.(idx, currentTrack, 0);
       } catch {
         try { svc.broadcastTrack?.(currentTrack, 0); } catch { /* ignore */ }
       }
       // 房主本地也清空投票
       setSkipVotes([]);
       setPrevVotes([]);
     }
   }, [currentTrack, inRoom, room, user.uid]);

  // ===== API 方法（异步） =====

  const createRoom = useCallback(async (): Promise<string> => {
    const svc = serviceRef.current as any;
    if (!svc) throw new Error('一起听服务未就绪');
    const roomId = await svc.createRoom();
    const r = svc.getRoom?.(roomId);
    if (r) setRoom(r);
    setInRoom(true);
    // 新房初始为空：不带入创建者当前在听的歌，等成员加歌后再播放
    lastBroadcastStateRef.current = {
      isPlaying: false,
      currentTime: 0,
      trackId: '',
    };
    toast.success('房间已创建');
    return roomId;
  }, []);

  const joinRoom = useCallback(
    async (roomId: string): Promise<boolean> => {
      const svc = serviceRef.current as any;
      if (!svc) return false;
      const ok = await svc.joinRoom(roomId);
      if (!ok) {
        toast.error('加入失败');
        return false;
      }
      const r = svc.getRoom?.(roomId);
      if (r) {
        setRoom(r);
        setInRoom(true);

        // 如果房间已有当前歌曲，切歌并按权威时间戳对齐进度（走统一的 applyRemote* 逻辑）
        if (r.currentTrack && audioElement) {
          applyRemoteTrack(r.currentTrack, r.hostTime || 0, r.hostTimeAt || Date.now());
          setTimeout(() => {
            if (audioElement) {
              applyRemotePlayState(!!r.isPlaying, r.hostTime || 0, r.hostTimeAt || Date.now());
              if (!r.isPlaying) {
                audioElement.pause();
              }
            }
          }, 700);
        }
      }
      toast.success('已加入房间');
      return true;
    },
    [audioElement, queue, addTracks, playTrackById]
  );

  const leaveRoom = useCallback(async () => {
    const svc = serviceRef.current as any;
    const rid = room?.roomId || '';
    if (!svc) return;
    await svc.leaveRoom?.();
    setRoom(null);
    setInRoom(false);
    setDanmakuMessages([]);
    setChatHistory([]);
    setSkipVotes([]);
     setPrevVotes([]);
    // 离开房间：恢复个人暂停态 + 取消静音（房主静音过的话）
    setSelfPaused(false);
    if (audioElement) {
      audioElement.muted = false;
    }
    if (rid) {
      clearChatHistory(rid);
    }
    lastBroadcastStateRef.current = { isPlaying: false, currentTime: 0, trackId: '' };
    toast.info('已离开房间');
   }, [room, audioElement]);

   /** 重试自动加入（面板上点「重试」时调用） */
  const retryAutoJoin = useCallback(() => {
    if (autoJoinFnRef.current) {
      autoJoinFnRef.current();
    } else {
      toast.error('服务尚未就绪，请稍候再试');
    }
  }, []);

  /** 生成邀请链接（路径形式 /join/<roomId>，经 OAuth 302 跳转后更可能保留） */
  const getInviteLink = useCallback((): string => {
    const rid = room?.roomId || '';
    if (!rid) return '';
    try {
      return resolveAppUrl(`/join/${rid}`);
    } catch {
      return `${window.location.origin}/join/${rid}`;
    }
  }, [room]);

  const inviteUser = useCallback(
    async (targetUid: string): Promise<{ success: boolean; message: string; invite?: IInvite }> => {
      const svc = serviceRef.current as any;
      if (!svc) return { success: false, message: '服务未就绪' };
      const res = await svc.sendInvite?.(targetUid);
      if (!res) return { success: false, message: '服务未就绪' };
      if (res.success) {
        const r = svc.getRoom?.(res.invite?.roomId || '');
        if (r) {
          setRoom(r);
          setInRoom(true);
        }
      }
      return res;
    },
    []
  );

  const replyInvite = useCallback(
    async (inviteId: string, accepted: boolean) => {
      const svc = serviceRef.current as any;
      if (!svc) return;

      setInvites((prev) => prev.filter((i) => i.id !== inviteId));

      const res = await svc.replyInvite?.(inviteId, accepted);
      if (accepted && res?.room) {
        setRoom(res.room);
        setInRoom(true);

        const r = res.room;
        if (r.currentTrack && audioElement) {
          isApplyingRemoteRef.current = true;
          const existing = queue.find((t) => t.id === r.currentTrack!.id);
          if (existing) {
            playTrackById(r.currentTrack.id);
          } else {
            addTracks([r.currentTrack], true);
          }
          const elapsed = r.isPlaying ? (Date.now() - r.hostTimeAt) / 1000 : 0;
          const targetTime = r.hostTime + elapsed;
          setTimeout(() => {
            if (audioElement) {
              audioElement.currentTime = targetTime;
              if (r.isPlaying) {
                audioElement.play().catch(() => {});
              }
            }
            setTimeout(() => {
              isApplyingRemoteRef.current = false;
            }, 400);
          }, 600);
        }

        toast.success('已加入房间');
      }
    },
    [audioElement, queue, addTracks, playTrackById]
  );

  const updateUser = useCallback(
    (patch: Partial<Pick<IListenTogetherUser, 'nickname' | 'avatarSeed'>>) => {
      updateLocalUser(patch);
      const svc = serviceRef.current as any;
      if (svc) {
        try {
          svc.refreshUser?.();
          const u = svc.getUser?.();
          if (u) setUser(u);
        } catch { /* ignore */ }
      }
    },
    []
  );

  const isUserOnline = useCallback(async (uid: string): Promise<boolean> => {
    const svc = serviceRef.current as any;
    if (!svc) return false;
    const res = await svc.checkOnline?.(uid);
    return res?.online ?? false;
  }, []);

  const getOnlineUserInfo = useCallback((uid: string) => {
    return (serviceRef.current as any)?.checkOnline?.(uid) || null;
  }, []);

  // ===== 弹幕 =====

  const sendDanmaku = useCallback(
    (content: string) => {
      if (!inRoom || !room || !content.trim()) return;
     const msg: IDanmakuMessage = {
         id: `d_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
         fromUid: user.uid,
         fromNickname: user.nickname || '匿名',
         fromAvatarSeed: user.avatarSeed || '',
         fromAvatarUrl: neteaseUser?.avatarUrl || undefined,
         fromNeteaseUserId: neteaseUser?.userId || undefined,
         content: content.trim(),
         timestamp: Date.now(),
         roomId: room.roomId,
       };
       // 本地立即显示
       setDanmakuMessages((prev) => [...prev.slice(-50), msg]);
       appendChatHistory(room.roomId, msg);
       setChatHistory(getChatHistory(room.roomId));
       // 广播
       const svc = serviceRef.current as any;
       try {
         svc?.broadcastChatMessage?.({
           id: msg.id,
           fromUid: msg.fromUid,
           fromNickname: msg.fromNickname,
           fromAvatarSeed: msg.fromAvatarSeed,
           fromAvatarUrl: msg.fromAvatarUrl,
           fromNeteaseUserId: msg.fromNeteaseUserId,
           content: msg.content,
           timestamp: msg.timestamp,
         });
      } catch { /* ignore */ }
     },
     [inRoom, room, user, neteaseUser]
   );

  // 加入房间时加载历史记录
  useEffect(() => {
    if (inRoom && room?.roomId) {
      setChatHistory(getChatHistory(room.roomId));
    } else {
      setChatHistory([]);
    }
  }, [inRoom, room?.roomId]);

  // ===== 共享队列 =====

  const sharedQueue = room?.sharedQueue || [];

  const addTracksToSharedQueue = useCallback(
    (tracks: ITrack[]) => {
      if (!inRoom || tracks.length === 0) return;
      const svc = serviceRef.current as any;
      try {
        svc?.broadcastQueueAdd?.(tracks);
      } catch { /* ignore */ }
      // 本地也加入自己的播放队列
      addTracks(tracks, false);
      // 立即刷新 room
      refreshRoom();
    },
    [inRoom, addTracks]
  );

  const removeFromSharedQueue = useCallback(
    (trackIds: string[]) => {
      if (!inRoom || trackIds.length === 0) return;
      const svc = serviceRef.current as any;
      try {
        svc?.broadcastQueueRemove?.(trackIds);
      } catch { /* ignore */ }
      refreshRoom();
    },
    [inRoom]
  );

  const reorderSharedQueue = useCallback(
    (fromIndex: number, toIndex: number) => {
      if (!inRoom) return;
      const svc = serviceRef.current as any;
      try {
        svc?.broadcastQueueReorder?.(fromIndex, toIndex);
      } catch { /* ignore */ }
      refreshRoom();
    },
    [inRoom]
  );

  const clearSharedQueue = useCallback(() => {
    if (!inRoom) return;
    const svc = serviceRef.current as any;
    try {
      svc?.broadcastQueueClear?.();
    } catch { /* ignore */ }
    refreshRoom();
  }, [inRoom]);

  // ===== 全员控制（同步播放状态） =====

  const broadcastPlay = useCallback(
    (playing: boolean) => {
      if (!inRoom || !serviceRef.current || !currentTrack) return;
      const svc = serviceRef.current as any;
      lastBroadcastStateRef.current.isPlaying = playing;
      try {
        svc.broadcastPlayState?.(playing, currentTime);
      } catch { /* ignore */ }
    },
    [inRoom, currentTrack, currentTime]
  );

  const broadcastSeek = useCallback(
    (time: number) => {
      if (!inRoom || !serviceRef.current || !currentTrack) return;
      const svc = serviceRef.current as any;
      try {
        svc.broadcastSeek?.(time);
      } catch { /* ignore */ }
    },
    [inRoom, currentTrack]
  );

  const isHost = room ? room.hostUid === user.uid : false;
  const roomId = room?.roomId || null;
   const members = room?.members || [];
   const memberCount = members.length;
   const isDualRoom = inRoom && memberCount === 2;

   // 按加入时间排序的成员列表（编号基准）
   const sortedMembers = useMemo(() => {
     return [...members].sort((a, b) => {
       const aTime = (a as any).joinedAt || a.lastSeen || 0;
       const bTime = (b as any).joinedAt || b.lastSeen || 0;
       return aTime - bTime;
     });
   }, [members]);

   // 获取成员显示信息：登录网易云则显示网易云昵称+头像，未登录显示「一起听N号」
   const getMemberDisplayInfo = useCallback(
     (uid: string) => {
       const idx = sortedMembers.findIndex((m) => m.uid === uid);
       const memberIndex = idx >= 0 ? idx + 1 : sortedMembers.length + 1;
       const member = sortedMembers.find((m) => m.uid === uid);

       // 自己：有网易云登录态则用网易云资料
       if (uid === user.uid && neteaseUser) {
         return {
           nickname: neteaseUser.nickname,
           avatarUrl: neteaseUser.avatarUrl,
           avatarSeed: user.avatarSeed,
           memberIndex,
           isNetease: true,
         };
       }

       // 远程成员：优先用 WS 传来的昵称，未设置则用编号
       const nick = member?.nickname || `一起听${memberIndex}号`;
       // 如果昵称是默认的「听众_xxxx」格式，替换为「一起听N号」
       const displayNick = nick.startsWith('听众_') ? `一起听${memberIndex}号` : nick;
       // 远程成员带网易云头像则显示真实头像
       const hasNeteaseAvatar = !!member?.neteaseAvatarUrl;

       return {
         nickname: displayNick,
         avatarUrl: member?.neteaseAvatarUrl || undefined,
         avatarSeed: member?.avatarSeed || uid,
         memberIndex,
         isNetease: hasNeteaseAvatar,
       };
     },
     [sortedMembers, user.uid, user.avatarSeed, neteaseUser]
   );

   // 获取歌曲添加者显示信息：优先用当前成员最新资料，降级到添加时快照，再降级到「已离开成员」
   const getTrackAddedByInfo = useCallback(
     (addedBy: ITrack['addedBy'] | undefined) => {
       // 完全没添加者信息
       if (!addedBy) {
         return {
           nickname: '已离开成员',
           avatarUrl: undefined,
           avatarSeed: 'anon',
           isNetease: false,
           hasLeft: true,
         };
       }

       // 看看添加者是否仍在房间（有最新资料）
       const member = sortedMembers.find((m) => m.uid === addedBy.uid);
       if (member && member.nickname) {
         // 在房间内：用最新资料，保证网易云昵称/头像最新
         const hasNetease = !!member.neteaseAvatarUrl;
         let nick = member.nickname;
         if (nick.startsWith('听众_')) {
           const idx = sortedMembers.findIndex((m) => m.uid === addedBy.uid);
           nick = `一起听${idx >= 0 ? idx + 1 : sortedMembers.length + 1}号`;
         }
         return {
           nickname: nick,
           avatarUrl: member.neteaseAvatarUrl || undefined,
           avatarSeed: member.avatarSeed || addedBy.uid,
           isNetease: hasNetease,
           hasLeft: false,
         };
       }

       // 不在房间：用添加时快照
       const snapshotNick = addedBy.nickname || '';
       const nick = snapshotNick && !snapshotNick.startsWith('听众_')
         ? snapshotNick
         : '已离开成员';
       return {
         nickname: nick,
         avatarUrl: addedBy.avatarUrl || undefined,
         avatarSeed: addedBy.avatarSeed || addedBy.uid,
         isNetease: !!addedBy.neteaseUserId && !!addedBy.avatarUrl,
         hasLeft: true,
       };
     },
     [sortedMembers]
   );

   // ===== 房间内 seek（双人房两人都可以拖，多人房仅房主可触发） =====
  // 双人房：任一人拖动都广播 sync-seek，对方收到后同步进度，不改变对方暂停状态
  // 多人房：进度条锁定，仅房主在投票达标后切歌
  const seekInRoom = useCallback(
    (time: number) => {
      if (!inRoom || !serviceRef.current || !currentTrack || !audioElement) return;
      const svc = serviceRef.current as any;
      // 本地先 seek
      seek(time);
      // 双人房：双方都可以广播 seek
      if (isDualRoom) {
        try {
          svc.broadcastSeek?.(time);
        } catch { /* ignore */ }
      } else if (isHost) {
        // 多人房仅房主能广播 seek（一般由投票触发，这里作为兜底）
        try {
          svc.broadcastSeek?.(time);
        } catch { /* ignore */ }
      }
    },
    [inRoom, currentTrack, audioElement, seek, isDualRoom, isHost]
  );

  // ===== 投票切歌 =====
  // 双人房：不投票，直接切歌（上一首/下一首按钮点击后双方同步）
  // 三人及以上：严格超过半数通过，阈值 floor(n/2)+1
  const skipVoteThreshold = useMemo(() => {
    if (memberCount <= 1) return 1;
    if (memberCount === 2) return 2; // 双人房：一致同意
    return Math.floor(memberCount / 2) + 1; // 多人房：严格超过半数
  }, [memberCount]);

  // 成员变化时清理无效投票（已离开房间的成员的票作废）
  useEffect(() => {
    if (!inRoom || members.length === 0) return;
    const memberUids = new Set(members.map((m) => m.uid));
    setSkipVotes((prev) => {
      const filtered = prev.filter((u) => memberUids.has(u));
      return filtered.length === prev.length ? prev : filtered;
    });
    setPrevVotes((prev) => {
      const filtered = prev.filter((u) => memberUids.has(u));
      return filtered.length === prev.length ? prev : filtered;
    });
  }, [members, inRoom]);

   const hasSkippedVoted = skipVotes.includes(user.uid);
   const hasPrevVoted = prevVotes.includes(user.uid);

   // 投票状态同步：本地计算 + 远程广播双向同步
   // 双人房：点击直接切歌，不走投票
   const castSkipVote = useCallback(() => {
     if (!inRoom || !serviceRef.current || !currentTrack) return;
     const svc = serviceRef.current as any;
     // 双人房：直接切歌（本地切 + 广播），不投票
     if (isDualRoom) {
       nextTrack();
       return;
     }
     const willVote = !hasSkippedVoted;
     // 广播投票状态（实时同步）
     svc.sendRoomBroadcast?.('skip-vote', {
       uid: user.uid,
       voted: willVote,
     });
     // 本地先更新（乐观 UI）
     setSkipVotes((prev) => {
       if (willVote) {
         return prev.includes(user.uid) ? prev : [...prev, user.uid];
       }
       return prev.filter((u) => u !== user.uid);
     });
   }, [inRoom, hasSkippedVoted, user.uid, currentTrack, isDualRoom, nextTrack]);

  // 处理远程投票消息
  const handleRemoteSkipVote = useCallback((uid: string, voted: boolean) => {
    setSkipVotes((prev) => {
      if (voted) {
        return prev.includes(uid) ? prev : [...prev, uid];
      }
      return prev.filter((u) => u !== uid);
    });
  }, []);

  // 投票达标 → 执行切歌 + 清空投票
  useEffect(() => {
    if (!inRoom || !currentTrack || skipVotes.length === 0) return;
    if (skipVotes.length >= skipVoteThreshold && skipVoteThreshold > 0) {
      // 切歌：房主执行（避免多个成员同时切导致重复）
      if (room?.hostUid === user.uid) {
        nextTrack();
        // 切歌广播通过 currentTrack useEffect 自动触发
      }
     // 清空投票（切歌后重置，无论是否是房主都清空本地状态）
     setSkipVotes([]);
   }
 }, [skipVotes, skipVoteThreshold, inRoom, currentTrack, nextTrack, room?.hostUid, user.uid]);

  // ===== 上一首投票 =====
  // 双人房：直接切上一首，不走投票
  const castPrevVote = useCallback(() => {
    if (!inRoom || !serviceRef.current || !currentTrack) return;
    const svc = serviceRef.current as any;
    // 双人房：直接切上一首
    if (isDualRoom) {
      prevTrack();
      return;
    }
    const willVote = !hasPrevVoted;
    svc.sendRoomBroadcast?.('prev-vote', {
      uid: user.uid,
      voted: willVote,
    });
    setPrevVotes((prev) => {
      if (willVote) {
        return prev.includes(user.uid) ? prev : [...prev, user.uid];
      }
      return prev.filter((u) => u !== user.uid);
    });
  }, [inRoom, hasPrevVoted, user.uid, currentTrack, isDualRoom, prevTrack]);

  const handleRemotePrevVote = useCallback((uid: string, voted: boolean) => {
    setPrevVotes((prev) => {
      if (voted) {
        return prev.includes(uid) ? prev : [...prev, uid];
      }
      return prev.filter((u) => u !== uid);
    });
  }, []);

  // 上一首投票达标 → 房主执行 prevTrack
  useEffect(() => {
    if (!inRoom || !currentTrack || prevVotes.length === 0) return;
    if (prevVotes.length >= skipVoteThreshold && skipVoteThreshold > 0) {
      if (room?.hostUid === user.uid) {
        prevTrack();
      }
      setPrevVotes([]);
    }
  }, [prevVotes, skipVoteThreshold, inRoom, currentTrack, prevTrack, room?.hostUid, user.uid]);

   // ===== 个人暂停 / 播放（不广播，不影响他人） =====
  const toggleSelfPlayPause = useCallback(() => {
    if (!audioElement || !currentTrack) return;
    const isHost = room?.hostUid === user.uid;

    if (selfPaused) {
      // 恢复播放
      if (isHost) {
        // 房主：取消静音即可（audio 一直在跑）
        audioElement.muted = false;
      } else {
        // 非房主：追赶房间权威进度后播放
        if (room && room.currentTrack && room.currentTrack.id === currentTrack.id) {
          const elapsed = room.isPlaying ? (Date.now() - (room.hostTimeAt || Date.now())) / 1000 : 0;
          const targetTime = Math.max(0, (room.hostTime || 0) + elapsed);
          if (Math.abs(audioElement.currentTime - targetTime) > 1) {
            audioElement.currentTime = targetTime;
          }
        }
        audioElement.play().catch(() => {});
      }
      setSelfPaused(false);
    } else {
      // 进入个人暂停
      if (isHost) {
        // 房主：静音但 audio 继续跑，保证房间时钟正常
        audioElement.muted = true;
      } else {
        // 非房主：直接暂停 audio
        audioElement.pause();
      }
      setSelfPaused(true);
    }
  }, [audioElement, currentTrack, selfPaused, room, user.uid]);

  // 歌曲自然结束时清空投票（下一首自动续播）
  // 由 currentTrack 变化触发，下面的切歌监听会自然重置

  // 切歌时广播曲目变更（房主广播，跟随方接收）
  // 这是房间权威状态，跟个人暂停/播放无关
  useEffect(() => {
    if (!inRoom || !serviceRef.current || isApplyingRemoteRef.current) return;

    const svc = serviceRef.current as any;
    const last = lastBroadcastStateRef.current;
    const trackId = currentTrack?.id || '';

    if (trackId !== last.trackId && currentTrack) {
      last.trackId = trackId;
      try {
        // 计算当前歌曲在共享队列中的索引
        const idx = room?.sharedQueue?.findIndex((t) => t.id === currentTrack.id) ?? -1;
        svc.broadcastCurrentIndex?.(idx, currentTrack, 0);
      } catch {
        // fallback 到普通 sync-track
        try { svc.broadcastTrack?.(currentTrack, 0); } catch { /* ignore */ }
      }
    }
   }, [currentTrack, inRoom, room?.sharedQueue]);

  const value: ListenTogetherContextValue = {
    user,
    updateUser,
    inRoom,
    room,
    members,
    isHost,
     roomId,
     connStatus,
    wsUrl,
    transportType,
    inviteRoomId,
    inviteRoomSource,
    autoJoinError,
    createRoom,
    joinRoom,
    leaveRoom,
    retryAutoJoin,
    isUserOnline,
    getOnlineUserInfo,
    danmakuMessages,
    sendDanmaku,
    chatHistory,
    sharedQueue,
    addTracksToSharedQueue,
    removeFromSharedQueue,
    reorderSharedQueue,
    clearSharedQueue,
    skipVotes,
    prevVotes,
    skipVoteThreshold,
    hasSkippedVoted,
    hasPrevVoted,
    castSkipVote,
    castPrevVote,
    selfPaused,
    toggleSelfPlayPause,
     seekInRoom,
     isDualRoom,
     neteaseUser,
     setNeteaseUser,
     getMemberDisplayInfo,
     getTrackAddedByInfo,
   };

  return (
    <ListenTogetherContext.Provider value={value}>
      {children}
    </ListenTogetherContext.Provider>
  );
}