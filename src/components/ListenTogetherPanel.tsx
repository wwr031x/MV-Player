// 一起听面板
// 功能：查看我的 UID、设置昵称、创建/加入房间、邀请好友、成员列表、退出房间
//
// 设计：玻璃拟态面板，深空黑底 + 霓虹青主色，保持与播放器整体视觉一致

import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { logger } from '@lark-apaas/client-toolkit-lite';
import {
   Users,
   Copy,
   Check,
   Plus,
   LogOut,
   Crown,
   ThumbsUp,
   Share2,
   RefreshCw,
   Music2,
   Zap,
   Search,
   Music,
   Play,
   ListPlus,
   ListMusic,
   AlertCircle,
   ChevronLeft,
   CheckSquare,
   Square,
   Radio,
   LogIn,
 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { useListenTogether } from '@/contexts/ListenTogetherContext';
import { usePlayer } from '@/contexts/PlayerContext';
import { cn } from '@/lib/utils';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Image } from '@/components/ui/image';
import SharedQueuePanel from '@/components/listenTogether/SharedQueuePanel';
import ChatPanel from '@/components/listenTogether/ChatPanel';
import { searchSongs, getUserPlaylists, getPlaylistTracks, getLoginStatus } from '@/lib/netease';
import type { ITrack, IPlaylist, INeteaseUser } from '@/types';

interface ListenTogetherPanelProps {
  isOpen: boolean;
  onClose: () => void;
  /** 网易云登录用户信息，已登录时有值 */
  neteaseUser?: { userId: number; nickname: string; avatarUrl: string } | null;
}

export default function ListenTogetherPanel({ isOpen, onClose, neteaseUser }: ListenTogetherPanelProps) {
  // 优先用网易云的 uid / 昵称 / 头像；未登录时退回到本地 uid
  const {
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
     addTracksToSharedQueue,
     skipVotes,
     prevVotes,
     skipVoteThreshold,
     hasSkippedVoted,
     hasPrevVoted,
      castSkipVote,
      castPrevVote,
      isDualRoom,
       setNeteaseUser,
       getMemberDisplayInfo,
       getTrackAddedByInfo,
     } = useListenTogether();
  const sharedQueue = room?.sharedQueue || [];
  const { queue, totalCount } = usePlayer();

  const [editingNickname, setEditingNickname] = useState(false);
  const [nicknameInput, setNicknameInput] = useState(user.nickname);
  const [copied, setCopied] = useState(false);
   const [joinRoomId, setJoinRoomId] = useState('');
  const [joining, setJoining] = useState(false);
  const [showJoinDialog, setShowJoinDialog] = useState(false);
  const [showQueueImportDialog, setShowQueueImportDialog] = useState(false);
  // 导入 Dialog 的 Tab：search 搜索导入 / playlist 我的歌单
  const [importTab, setImportTab] = useState<'search' | 'playlist'>('search');
  const [playlists, setPlaylists] = useState<IPlaylist[]>([]);
   const [playlistsLoading, setPlaylistsLoading] = useState(false);
   const [playlistError, setPlaylistError] = useState<string | null>(null);
  // 当前选中的歌单详情（点进去看曲目）
  const [selectedPlaylist, setSelectedPlaylist] = useState<IPlaylist | null>(null);
  const [playlistTracks, setPlaylistTracks] = useState<ITrack[]>([]);
  const [tracksLoading, setTracksLoading] = useState(false);
  // 已选曲目 id 集合（批量导入）
  const [selectedTrackIds, setSelectedTrackIds] = useState<Set<string>>(new Set());
  const [importLoading, setImportLoading] = useState(false);
  // 网易云搜索导入共享队列
  const [searchKeyword, setSearchKeyword] = useState('');
   const [searchResults, setSearchResults] = useState<ITrack[]>([]);
   const [searchLoading, setSearchLoading] = useState(false);
   const [searchError, setSearchError] = useState<string | null>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchReqIdRef = useRef(0);

   useEffect(() => {
     setNicknameInput(user.nickname);
   }, [user.nickname]);

   // 同步网易云登录态到一起听 Context（用于弹幕昵称/头像、成员资料）
   useEffect(() => {
     setNeteaseUser(neteaseUser || null);
   }, [neteaseUser, setNeteaseUser]);

  const copyUid = async () => {
    try {
      await navigator.clipboard.writeText(user.uid);
      setCopied(true);
      toast.success('UID 已复制');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('复制失败');
    }
  };

  const copyRoomId = async () => {
    if (!roomId) return;
    try {
      await navigator.clipboard.writeText(roomId);
      toast.success('房间号已复制');
    } catch {
      toast.error('复制失败');
    }
  };

  const handleSaveNickname = () => {
    const name = nicknameInput.trim();
    if (!name) {
      toast.error('昵称不能为空');
      return;
    }
    updateUser({ nickname: name });
    setEditingNickname(false);
    toast.success('昵称已更新');
  };

  const handleCreateRoom = async () => {
    try {
      await createRoom();
    } catch (e: any) {
      toast.error(e.message || '创建失败');
    }
  };

  const handleJoinRoom = async () => {
    const id = joinRoomId.trim();
    if (!id) {
      toast.error('请输入房间号');
      return;
    }
    setJoining(true);
    try {
      const ok = await joinRoom(id);
      if (ok) {
        setShowJoinDialog(false);
        setJoinRoomId('');
      }
    } finally {
      setJoining(false);
    }
  };

  const handleLeave = async () => {
    await leaveRoom();
    onClose();
  };

  const handleImportToQueue = async () => {
    setShowQueueImportDialog(true);
    setSearchKeyword('');
    setSearchResults([]);
    setImportTab('search');
    setSelectedPlaylist(null);
    setPlaylistTracks([]);
    setSelectedTrackIds(new Set());
    // 切换到歌单Tab时再查登录状态，不阻塞打开
  };

  // 切换到歌单Tab时加载歌单（用 props 传入的网易云登录态）
   const loadMyPlaylists = useCallback(async () => {
     if (!neteaseUser) {
       setPlaylists([]);
       setPlaylistError(null);
       return;
     }
     setPlaylistsLoading(true);
     setPlaylistError(null);
     try {
       const list = await getUserPlaylists(neteaseUser.userId);
       setPlaylists(list);
     } catch (e) {
       setPlaylists([]);
       setPlaylistError(e instanceof Error ? e.message : '加载失败，请稍后重试');
     } finally {
       setPlaylistsLoading(false);
     }
   }, [neteaseUser]);

  const loadPlaylistTracks = useCallback(async (pid: number) => {
    setTracksLoading(true);
    setSelectedTrackIds(new Set());
    try {
      const res = await getPlaylistTracks(pid, 100, 0);
      setPlaylistTracks(res.tracks);
    } catch {
      setPlaylistTracks([]);
    } finally {
      setTracksLoading(false);
    }
  }, []);

  const toggleTrackSelect = (id: string) => {
    setSelectedTrackIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleBatchImport = () => {
    const toAdd = playlistTracks.filter((t) => selectedTrackIds.has(t.id));
    if (toAdd.length === 0) {
      toast.info('请先选择要导入的歌曲');
      return;
    }
    const filtered = toAdd.filter((t) => !sharedQueue.some((q) => q.id === t.id));
    if (filtered.length === 0) {
      toast.info('选中的歌曲已全部在队列中');
      return;
    }
    addTracksToSharedQueue(filtered);
    toast.success(`已添加 ${filtered.length} 首歌到共享队列`);
    setSelectedTrackIds(new Set());
  };

  // 防抖搜索
  useEffect(() => {
     const kw = searchKeyword.trim();
     if (!kw) {
       setSearchResults([]);
       setSearchError(null);
       return;
     }
     // 未登录时不搜索，清空结果
     if (!neteaseUser) {
       setSearchResults([]);
       return;
     }
     if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
     searchDebounceRef.current = setTimeout(async () => {
       const myReqId = ++searchReqIdRef.current;
       setSearchLoading(true);
       setSearchError(null);
       try {
         const res = await searchSongs(kw);
         if (myReqId !== searchReqIdRef.current) return;
         setSearchResults(res.songs);
       } catch (e) {
         if (myReqId === searchReqIdRef.current) {
           setSearchResults([]);
           setSearchError(e instanceof Error ? e.message : '搜索失败，请稍后重试');
         }
       } finally {
         if (myReqId === searchReqIdRef.current) setSearchLoading(false);
       }
     }, 300);
     return () => {
       if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
     };
   }, [searchKeyword, neteaseUser]);

  const handleAddToSharedQueue = (track: ITrack) => {
    if (sharedQueue.some((t) => t.id === track.id)) {
      toast.info('已在共享队列中');
      return;
    }
    addTracksToSharedQueue([track]);
    toast.success(`已添加「${track.name}」到共享队列`);
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="bg-card/95 backdrop-blur-xl border border-border text-foreground w-[92vw] max-w-[440px] max-h-[90dvh] sm:max-h-[85dvh] p-0 overflow-hidden rounded-lg flex flex-col" style={{ touchAction: 'none' }}>
        {/* 顶部标题栏 */}
        <div className="flex items-center justify-between px-4 sm:px-5 pt-[max(12px,env(safe-area-inset-top))] pb-3 sm:py-4 border-b border-border/60 flex-shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-md bg-primary/15 flex items-center justify-center">
              <Users className="w-4 h-4 text-primary" />
            </div>
            <div>
              <DialogTitle className="text-base font-semibold">一起听</DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground">
                邀请好友一起实时听歌
              </DialogDescription>
            </div>
           </div>
          </div>

        {/* 内容滚动区 */}
        <ScrollArea className="flex-1 min-h-0 overflow-y-auto" style={{ WebkitOverflowScrolling: 'touch' as const, touchAction: 'pan-y' }}>
          <div className="px-4 sm:px-5 py-4 space-y-5 pb-[max(16px,env(safe-area-inset-bottom))]">
            {/* 连接状态 */}
            <section>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'w-2 h-2 rounded-full flex-shrink-0',
                      connStatus === 'connected' && 'bg-green-500 shadow-[0_0_8px_hsl(140_70%_50%)]',
                      connStatus === 'connecting' && 'bg-yellow-500 animate-pulse',
                      connStatus === 'reconnecting' && 'bg-orange-500 animate-pulse',
                      connStatus === 'disconnected' && 'bg-red-500',
                    )}
                  />
                  <span className="text-xs font-medium">
                    {connStatus === 'connected' && (transportType === 'webrtc' ? '信令已连接' : transportType === 'supabase' ? '实时通道已连接' : '已连接')}
                    {connStatus === 'connecting' && (transportType === 'webrtc' ? '连接信令中...' : transportType === 'supabase' ? '连接实时通道...' : '连接中...')}
                    {connStatus === 'reconnecting' && '重连中...'}
                    {connStatus === 'disconnected' && '未连接'}
                  </span>
                  {connStatus === 'connected' && inRoom && transportType === 'webrtc' && (
                    <span className="flex items-center gap-1 text-[10px] text-green-400 ml-1">
                      <Zap className="w-3 h-3" />
                      P2P 直连
                    </span>
                  )}
                </div>
                {connStatus === 'disconnected' && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 text-xs"
                    onClick={() => window.location.reload()}
                  >
                    <RefreshCw className="w-3 h-3 mr-1" /> 重试
                  </Button>
                )}
              </div>
              <div className="mt-1.5 text-[10px] text-muted-foreground/70 font-mono truncate flex items-center gap-1.5" title={wsUrl}>
                {transportType === 'webrtc' && (
                  <Radio className="w-3 h-3 text-primary" />
                )}
                {wsUrl || '正在解析服务器地址...'}
              </div>
            </section>

            {/* 我的信息 */}
            <section>
              <div className="text-xs text-muted-foreground mb-2 font-medium">我的信息</div>
              <div className="flex items-center gap-3 p-3 rounded-md bg-accent/40 border border-border/60">
                {neteaseUser?.avatarUrl ? (
                  <Image
                    src={neteaseUser.avatarUrl}
                    alt={neteaseUser.nickname}
                    className="w-10 h-10 rounded-full object-cover flex-shrink-0 border border-primary/30"
                  />
                ) : (
                  <div
                    className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0"
                    style={{
                      background: `linear-gradient(135deg, hsl(185 100% 50%), hsl(322 90% 60%))`,
                      color: '#0a0a0a',
                    }}
                  >
                    {user.nickname.slice(0, 1).toUpperCase()}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  {editingNickname ? (
                    <div className="flex gap-1">
                      <Input
                        value={nicknameInput}
                        onChange={(e) => setNicknameInput(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleSaveNickname()}
                        className="h-7 text-sm bg-background/80"
                        autoFocus
                      />
                      <Button size="sm" variant="secondary" onClick={handleSaveNickname} className="h-7 text-xs">
                        保存
                      </Button>
                       <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setEditingNickname(false);
                          setNicknameInput(user.nickname);
                        }}
                        className="h-7 text-xs text-muted-foreground"
                      >
                        取消
                      </Button>
                    </div>
                  ) : (
                    <div
                      className="text-sm font-medium cursor-pointer hover:text-primary transition-colors truncate"
                      onClick={() => !neteaseUser && setEditingNickname(true)}
                      title={neteaseUser ? '网易云账号昵称' : '点击修改昵称'}
                    >
                      {neteaseUser ? neteaseUser.nickname : user.nickname}
                    </div>
                  )}
                  <div className="flex items-center gap-1 mt-0.5" data-tour="lt-uid">
                     <span className="text-[10px] text-muted-foreground font-mono">
                       {neteaseUser ? `网易云UID ${neteaseUser.userId}` : user.uid}
                     </span>
                    <button
                      onClick={copyUid}
                      className="text-muted-foreground hover:text-primary transition-colors"
                      title="复制 UID"
                    >
                      {copied ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
                    </button>
                  </div>
                </div>
              </div>
            </section>

             {/* 房间状态 */}
            {inRoom && room ? (
              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-xs text-muted-foreground font-medium">当前房间</div>
                  <div className="flex items-center gap-1">
                    <span className="inline-block w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                    <span className="text-[10px] text-green-400">一起听中</span>
                  </div>
                </div>

                <div className="space-y-2 p-3 rounded-md bg-accent/40 border border-border/60">
                  <div className="flex items-center justify-between">
                    <div className="text-[10px] text-muted-foreground">房间号</div>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={copyRoomId}
                      className="h-6 text-[10px] gap-1"
                    >
                      <Copy className="w-3 h-3" />
                      复制房间号
                    </Button>
                  </div>
                  <div className="text-base font-mono font-bold text-primary tracking-wide">
                    {roomId}
                  </div>
                  <div className="text-[10px] text-muted-foreground leading-relaxed pt-1 border-t border-border/40">
                    💡 让朋友点「加入房间」，粘贴此房间号即可一起听。
                  </div>
                </div>

                {/* 当前歌曲（仅房间真正有共享歌曲在播时显示） */}
                {room?.currentTrack && (
                  <div className="flex items-center gap-2 p-3 rounded-md bg-primary/5 border border-primary/20">
                    <Music2 className="w-4 h-4 text-primary flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-muted-foreground">正在播放</div>
                      <div className="text-sm font-medium truncate">{room.currentTrack.name}</div>
                      <div className="text-[10px] text-muted-foreground truncate">
                        {room.currentTrack.artist || '未知歌手'}
                      </div>
                      {room.currentTrack.addedBy && (
                        <div className="flex items-center gap-1 mt-1">
                          <div className="h-4 w-4 shrink-0 rounded-full overflow-hidden border border-border/40 bg-accent/50">
                            {getTrackAddedByInfo(room.currentTrack.addedBy).avatarUrl ? (
                              <Image
                                src={getTrackAddedByInfo(room.currentTrack.addedBy).avatarUrl!}
                                alt={getTrackAddedByInfo(room.currentTrack.addedBy).nickname}
                                className="w-full h-full object-cover"
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-[8px] text-muted-foreground">
                                {getTrackAddedByInfo(room.currentTrack.addedBy).nickname.charAt(0)}
                              </div>
                            )}
                          </div>
                          <span className="text-[10px] text-muted-foreground truncate">
                            由 {getTrackAddedByInfo(room.currentTrack.addedBy).nickname} 添加
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                <Separator className="my-1" />

                {/* 成员列表 */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-xs text-muted-foreground font-medium">
                      成员 ({members.length})
                    </div>
                    {inRoom && !isDualRoom && (skipVotes.length > 0 || prevVotes.length > 0) && (
                       <div className="flex flex-col gap-1 items-end">
                         {skipVotes.length > 0 && (
                           <div className="flex items-center gap-1 text-[10px] text-primary font-medium">
                             <ThumbsUp className="w-3 h-3" />
                             <span>跳过 {skipVotes.length}/{skipVoteThreshold}</span>
                           </div>
                         )}
                         {prevVotes.length > 0 && (
                           <div className="flex items-center gap-1 text-[10px] text-secondary font-medium">
                             <ThumbsUp className="w-3 h-3 rotate-180" />
                             <span>上一首 {prevVotes.length}/{skipVoteThreshold}</span>
                           </div>
                         )}
                       </div>
                     )}
                  </div>
                   <div className="space-y-2">
                     {members.map((m) => {
                       const info = getMemberDisplayInfo(m.uid);
                       return (
                         <div
                           key={m.uid}
                           className={cn(
                             'flex items-center gap-2 px-3 py-2 rounded-md',
                             m.uid === user.uid ? 'bg-primary/10 border border-primary/20' : 'bg-accent/30',
                             !isDualRoom && skipVotes.includes(m.uid) && 'ring-1 ring-primary/50',
                             !isDualRoom && prevVotes.includes(m.uid) && 'ring-1 ring-secondary/50'
                           )}
                         >
                           {/* 成员头像 */}
                           {info.avatarUrl ? (
                             <Image
                               src={info.avatarUrl}
                               alt={info.nickname}
                               className="w-7 h-7 rounded-full object-cover flex-shrink-0 border border-primary/30"
                             />
                           ) : (
                             <div
                               className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
                               style={{
                                 background: `linear-gradient(135deg, hsl(185 100% 50%), hsl(322 90% 60%))`,
                                 color: '#0a0a0a',
                               }}
                             >
                               {info.nickname.slice(0, 1).toUpperCase()}
                             </div>
                           )}
                           <div className="flex-1 min-w-0">
                             <div className="text-sm font-medium truncate flex items-center gap-1">
                               {info.nickname}
                               {m.isHost && (
                                 <Crown className="w-3 h-3 text-yellow-400" />
                               )}
                               {m.uid === user.uid && (
                                 <span className="text-[10px] text-primary">(我)</span>
                               )}
                             </div>
                             <div className="text-[10px] text-muted-foreground font-mono">
                               ID: {m.uid.slice(0, 8)}
                             </div>
                           </div>
                            <div className="flex items-center gap-1">
                              {prevVotes.includes(m.uid) && (
                                <ThumbsUp className="w-3 h-3 text-secondary rotate-180" />
                              )}
                              {skipVotes.includes(m.uid) && (
                                <ThumbsUp className="w-3 h-3 text-primary" />
                              )}
                              <div className="flex items-center gap-1">
                                <div
                                  className={cn(
                                    'w-2 h-2 rounded-full',
                                    m.isBackground ? 'bg-muted-foreground/50' : 'bg-green-500'
                                  )}
                                />
                                <span className={cn(
                                  'text-[9px] leading-none',
                                  m.isBackground ? 'text-muted-foreground' : 'text-green-500'
                                )}>
                                  {m.isBackground ? '后台中' : '在线'}
                                </span>
                              </div>
                            </div>
                         </div>
                       );
                     })}
                   </div>
                </div>

                <Separator className="my-1" />

                {/* 共享队列 */}
                <SharedQueuePanel onImportClick={handleImportToQueue} />

                <Separator className="my-1" />

                {/* 聊天弹幕 */}
                <ChatPanel />

                 <Separator className="my-1" />
               </section>
             ) : (
               /* 未在房间内 — 操作入口 */
               <section className="space-y-3">
                 <div className="text-xs text-muted-foreground font-medium">开始一起听</div>

                  {/* 邀请检测状态：检测到房间号时显示快捷加入入口 */}
                  {inviteRoomId ? (
                    <div className="p-3 rounded-md bg-primary/10 border border-primary/30 space-y-2">
                      <div className="flex items-center gap-2">
                        <Music2 className="w-4 h-4 text-primary shrink-0" />
                        <div className="text-xs text-primary font-medium">检测到邀请房间</div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-muted-foreground">房间号</span>
                        <span className="text-xs font-mono text-foreground truncate flex-1">{inviteRoomId}</span>
                        <Button
                          size="sm"
                          variant="secondary"
                          className="h-6 text-[10px] gap-1 shrink-0"
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(inviteRoomId);
                              toast.success('房间号已复制');
                            } catch { toast.error('复制失败'); }
                          }}
                        >
                          <Copy className="w-3 h-3" />
                          复制
                        </Button>
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        来源：{inviteRoomSource === 'path' ? '链接路径' : inviteRoomSource === 'query' ? 'URL 参数' : inviteRoomSource === 'hash' ? '哈希参数' : '本地缓存'}
                        {connStatus === 'connecting' && ' · 正在连接通道...'}
                      </div>
                      {autoJoinError && (
                        <div className="flex items-start gap-2 pt-1">
                          <AlertCircle className="w-3.5 h-3.5 text-destructive shrink-0 mt-0.5" />
                          <div className="text-[11px] text-destructive leading-relaxed flex-1">{autoJoinError}</div>
                        </div>
                      )}
                      {(autoJoinError || connStatus === 'error') && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={retryAutoJoin}
                          className="w-full h-7 text-xs gap-1.5 mt-1"
                        >
                          <RefreshCw className="w-3 h-3" />
                          重试加入
                        </Button>
                      )}
                    </div>
                  ) : (
                    <div className="p-3 rounded-md bg-accent/30 border border-border/50">
                      <div className="text-[11px] text-muted-foreground leading-relaxed">
                        让朋友把房间号发给你，点下方「加入房间」粘贴房间号即可一起听。
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      onClick={handleCreateRoom}
                      className="h-10 gap-2 bg-primary hover:bg-primary/90 text-primary-foreground"
                    >
                      <Plus className="w-4 h-4" />
                      创建房间
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => setShowJoinDialog(true)}
                      className="h-10 gap-2"
                    >
                      <Share2 className="w-4 h-4" />
                      加入房间
                    </Button>
                  </div>

                  {/* 在线测试提示 */}
                  <div className="p-3 rounded-md bg-secondary/10 border border-secondary/20">
                    <div className="text-xs text-secondary-foreground font-medium mb-1">🧪 测试方式</div>
                    <div className="text-[11px] text-muted-foreground leading-relaxed">
                      在同一浏览器打开两个标签页，每个标签页有独立 UID。一方创建房间后分享房间号，另一方点「加入房间」粘贴房间号即可一起听。
                    </div>
                  </div>
              </section>
            )}
          </div>
        </ScrollArea>

        {/* 底部固定操作栏（退出房间按钮）— 移动端始终可见 */}
        {inRoom && room && (
          <div className="flex-shrink-0 px-4 sm:px-5 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] border-t border-border/60 bg-card/80 backdrop-blur">
            <Button
              variant="destructive"
              onClick={handleLeave}
              className="w-full h-9 gap-2"
            >
              <LogOut className="w-4 h-4" />
              退出房间
            </Button>
          </div>
        )}
      </DialogContent>

      {/* 加入房间 Dialog */}
      <Dialog open={showJoinDialog} onOpenChange={setShowJoinDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>加入房间</DialogTitle>
            <DialogDescription>输入朋友的房间号即可加入</DialogDescription>
          </DialogHeader>
          <Input
             value={joinRoomId}
             onChange={(e) => setJoinRoomId(e.target.value)}
             placeholder="房间号，如 room_xxxxx"
             className="h-9 text-sm"
             onKeyDown={(e) => e.key === 'Enter' && handleJoinRoom()}
             onContextMenu={(e) => e.stopPropagation()}
             autoFocus
           />
           <p className="text-[11px] text-muted-foreground/80 -mt-1">
             电脑端可以用 Ctrl+V 键进行快捷粘贴
           </p>
          <DialogFooter className="gap-2">
            <DialogClose asChild>
              <Button variant="secondary" size="sm" className="h-8">
                取消
              </Button>
            </DialogClose>
            <Button
              onClick={handleJoinRoom}
              size="sm"
              className="h-8 bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              加入
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 网易云导入到共享队列 Dialog（搜索 + 我的歌单 双 Tab） */}
      <Dialog open={showQueueImportDialog} onOpenChange={setShowQueueImportDialog}>
        <DialogContent className="sm:max-w-md p-0">
          <DialogHeader className="px-5 pt-5 pb-0">
            <DialogTitle className="flex items-center gap-2 text-base">
              <Music className="w-4 h-4 text-primary" />
              加歌到共享队列
            </DialogTitle>
            <DialogDescription>添加后全员同步播放，一起听同一首歌</DialogDescription>
          </DialogHeader>

          {/* Tab 切换 */}
          <div className="flex px-5 pt-3 gap-1 border-b border-border/60">
            <button
              onClick={() => setImportTab('search')}
              className={`px-3 py-2 text-sm border-b-2 -mb-px transition-colors ${
                importTab === 'search'
                  ? 'border-primary text-foreground font-medium'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              <span className="flex items-center gap-1.5">
                <Search className="w-3.5 h-3.5" />
                网易云搜索
              </span>
            </button>
            <button
               onClick={() => {
                 setImportTab('playlist');
                 setSelectedPlaylist(null);
                 if (playlists.length === 0 && !playlistsLoading && neteaseUser) {
                   loadMyPlaylists();
                 }
               }}
              className={`px-3 py-2 text-sm border-b-2 -mb-px transition-colors ${
                importTab === 'playlist'
                  ? 'border-primary text-foreground font-medium'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              <span className="flex items-center gap-1.5">
                <ListMusic className="w-3.5 h-3.5" />
                我的歌单
              </span>
            </button>
          </div>

           {/* 搜索 Tab */}
           {importTab === 'search' && (
             <>
               {!neteaseUser ? (
                 <div className="flex flex-col items-center justify-center gap-3 py-12 px-6 text-center">
                   <div className="w-12 h-12 rounded-full bg-accent/40 flex items-center justify-center">
                     <LogIn className="w-5 h-5 text-muted-foreground" />
                   </div>
                   <div className="text-sm text-foreground font-medium">请先登录网易云账号</div>
                   <div className="text-xs text-muted-foreground">
                     登录后可搜索网易云歌曲并添加到共享队列
                   </div>
                   <Button
                     size="sm"
                     variant="secondary"
                     onClick={() => {
                       setShowQueueImportDialog(false);
                       toast.info('请在「设置」中登录网易云账号');
                     }}
                     className="mt-1 h-8"
                   >
                     去登录
                   </Button>
                 </div>
               ) : (
                 <>
                   <div className="px-5 py-3">
                     <div className="relative">
                       <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                       <Input
                         value={searchKeyword}
                         onChange={(e) => setSearchKeyword(e.target.value)}
                         placeholder="搜索歌曲 / 歌手 / 专辑"
                         className="bg-background pl-9"
                         autoFocus
                       />
                     </div>
                   </div>
                   <div className="px-2 pb-2 max-h-[50vh] overflow-y-auto">
                     {searchError && (
                       <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
                         <AlertCircle className="w-6 h-6 text-destructive/80" />
                         <div className="text-sm text-foreground">搜索失败</div>
                         <div className="text-xs text-muted-foreground px-4">{searchError}</div>
                       </div>
                     )}
                     {!searchError && searchResults.length === 0 && !searchLoading && searchKeyword && (
                       <div className="text-center text-muted-foreground py-8 text-sm">未找到结果</div>
                     )}
                     {searchLoading && (
                       <div className="text-center text-muted-foreground py-8 text-sm flex items-center justify-center gap-2">
                         <RefreshCw className="w-4 h-4 animate-spin" />
                         搜索中...
                       </div>
                     )}
                     {!searchError && !searchKeyword && !searchLoading && (
                       <div className="flex flex-col items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
                         <Music className="h-6 w-6 opacity-40" />
                         <span>输入关键词搜索歌曲</span>
                       </div>
                     )}
                     {searchResults.map((t) => (
                  <div
                    key={t.id}
                    className="flex items-center gap-3 p-2 rounded-md hover:bg-accent/40 transition-colors"
                  >
                    <div className="w-10 h-10 rounded bg-accent/30 flex-shrink-0 overflow-hidden">
                      {t.coverUrl ? (
                        <Image src={t.coverUrl} alt={t.name} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <Music className="w-4 h-4 text-muted-foreground/50" />
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm truncate flex items-center gap-1.5">
                        {t.name}
                        {t.isVip && (
                          <span
                            className="text-[10px] px-1 rounded font-bold flex-shrink-0"
                            style={{ backgroundColor: '#f59e0b', color: '#000' }}
                          >VIP</span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">{t.artist}</div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1 text-xs shrink-0"
                      onClick={() => handleAddToSharedQueue(t)}
                    >
                      <ListPlus className="w-3.5 h-3.5" />
                      添加
                    </Button>
                  </div>
                 ))}
               </div>
                 </>
               )}
             </>
           )}

           {/* 歌单 Tab */}
           {importTab === 'playlist' && (
             <div className="max-h-[55vh] overflow-y-auto">
               {/* 未登录提示 */}
               {!neteaseUser && !playlistsLoading && (
                 <div className="flex flex-col items-center justify-center gap-3 py-12 px-6 text-center">
                   <div className="w-12 h-12 rounded-full bg-accent/40 flex items-center justify-center">
                     <LogIn className="w-5 h-5 text-muted-foreground" />
                   </div>
                   <div className="text-sm text-foreground font-medium">请先登录网易云账号</div>
                   <div className="text-xs text-muted-foreground">
                     登录后可导入自己创建和收藏的歌单到共享队列
                   </div>
                   <Button
                     size="sm"
                     variant="secondary"
                     onClick={() => {
                       setShowQueueImportDialog(false);
                       toast.info('请在「设置」中登录网易云账号');
                     }}
                     className="mt-1 h-8"
                   >
                     去登录
                   </Button>
                 </div>
               )}

               {/* 加载中 */}
               {playlistsLoading && (
                 <div className="text-center text-muted-foreground py-12 text-sm flex items-center justify-center gap-2">
                   <RefreshCw className="w-4 h-4 animate-spin" />
                   加载歌单中...
                 </div>
               )}

               {/* 加载失败 */}
               {!playlistsLoading && neteaseUser && playlistError && (
                 <div className="flex flex-col items-center justify-center gap-2 py-12 px-6 text-center">
                   <AlertCircle className="w-8 h-8 text-destructive/80" />
                   <div className="text-sm text-foreground font-medium">歌单加载失败</div>
                   <div className="text-xs text-muted-foreground">{playlistError}</div>
                   <Button size="sm" variant="secondary" onClick={loadMyPlaylists} className="mt-1 h-8 gap-1.5">
                     <RefreshCw className="w-3.5 h-3.5" />
                     重试
                   </Button>
                 </div>
               )}

               {/* 歌单列表（未点进具体歌单时） */}
               {!selectedPlaylist && !playlistsLoading && neteaseUser && !playlistError && playlists.length > 0 && (
                 <div className="p-2 space-y-1">
                  {playlists.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => {
                        setSelectedPlaylist(p);
                        loadPlaylistTracks(p.id);
                      }}
                      className="w-full flex items-center gap-3 p-2 rounded-md hover:bg-accent/40 transition-colors text-left"
                    >
                      <div className="w-11 h-11 rounded bg-accent/30 flex-shrink-0 overflow-hidden">
                        {p.coverUrl ? (
                          <Image src={p.coverUrl} alt={p.name} className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <ListMusic className="w-4 h-4 text-muted-foreground/50" />
                          </div>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm truncate">{p.name}</div>
                        <div className="text-xs text-muted-foreground">{p.trackCount} 首歌</div>
                      </div>
                      <ChevronLeft className="w-4 h-4 text-muted-foreground rotate-180" />
                    </button>
                  ))}
                </div>
              )}

               {/* 歌单为空 */}
               {!selectedPlaylist && !playlistsLoading && neteaseUser && !playlistError && playlists.length === 0 && (
                 <div className="flex flex-col items-center justify-center gap-2 py-12 text-xs text-muted-foreground">
                   <ListMusic className="h-6 w-6 opacity-40" />
                   <span>暂无歌单</span>
                 </div>
               )}

              {/* 具体歌单内：曲目列表 + 多选 + 批量导入 */}
              {selectedPlaylist && (
                <div className="flex flex-col">
                  {/* 顶部返回 + 标题 + 全选/批量导入 */}
                  <div className="px-3 py-2 border-b border-border/60 flex items-center gap-2 bg-card/60 sticky top-0 z-10">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={() => setSelectedPlaylist(null)}
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </Button>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{selectedPlaylist.name}</div>
                      <div className="text-[11px] text-muted-foreground">
                        共 {selectedPlaylist.trackCount} 首 · 已选 {selectedTrackIds.size}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-7 gap-1 text-xs shrink-0"
                      onClick={handleBatchImport}
                      disabled={selectedTrackIds.size === 0}
                    >
                      <ListPlus className="w-3.5 h-3.5" />
                      导入选中
                    </Button>
                  </div>

                  {/* 曲目列表 */}
                  <div className="px-2 py-1">
                    {tracksLoading && (
                      <div className="text-center text-muted-foreground py-8 text-sm">加载中...</div>
                    )}
                    {!tracksLoading && playlistTracks.length === 0 && (
                      <div className="text-center text-muted-foreground py-8 text-sm">暂无曲目</div>
                    )}
                    {!tracksLoading && playlistTracks.length > 0 && (
                      <div className="space-y-0.5">
                        {playlistTracks.map((t) => {
                          const checked = selectedTrackIds.has(t.id);
                          return (
                            <button
                              key={t.id}
                              onClick={() => toggleTrackSelect(t.id)}
                              className={`w-full flex items-center gap-2 p-2 rounded-md text-left transition-colors ${
                                checked ? 'bg-primary/10' : 'hover:bg-accent/30'
                              }`}
                            >
                              {checked ? (
                                <CheckSquare className="w-4 h-4 text-primary shrink-0" />
                              ) : (
                                <Square className="w-4 h-4 text-muted-foreground/60 shrink-0" />
                              )}
                              <div className="w-8 h-8 rounded bg-accent/30 flex-shrink-0 overflow-hidden">
                                {t.coverUrl ? (
                                  <Image src={t.coverUrl} alt={t.name} className="w-full h-full object-cover" />
                                ) : (
                                  <div className="w-full h-full flex items-center justify-center">
                                    <Music className="w-3 h-3 text-muted-foreground/50" />
                                  </div>
                                )}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="text-sm truncate flex items-center gap-1">
                                  {t.name}
                                  {t.isVip && (
                                    <span
                                      className="text-[10px] px-1 rounded font-bold flex-shrink-0"
                                      style={{ backgroundColor: '#f59e0b', color: '#000' }}
                                    >VIP</span>
                                  )}
                                </div>
                                <div className="text-[11px] text-muted-foreground truncate">{t.artist}</div>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          <DialogFooter className="px-5 py-3 border-t border-border/60">
            <DialogClose asChild>
              <Button variant="secondary" size="sm" className="h-8">
                关闭
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}
