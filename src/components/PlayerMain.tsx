import { lazy, Suspense, useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
   Play, Pause, SkipBack, SkipForward, Volume2, VolumeX,
   Settings, List, Search, X, Music, Music2, Repeat, Repeat1, Shuffle,
   Monitor, Sparkles, Activity, Globe, Waves, Users,
   CircleDot, Square, LogOut, LogIn, Copy, Check, ChevronRight,
    User as UserIcon, ListMusic, Heart, Clock, AlertCircle, RefreshCw,
    Image as ImageIcon, Loader2, Bell, SkipForward as SkipForwardIcon,
 } from 'lucide-react';
const SettingsPanel = lazy(() => import('@/components/SettingsPanel'));
const EngineeringMenu = lazy(() => import('@/components/EngineeringMenu'));
const ListenTogetherPanel = lazy(() => import('@/components/ListenTogetherPanel'));
const OnboardingWizard = lazy(() => import('@/components/OnboardingWizard'));
const AnnouncementModal = lazy(() => import('@/announcements/AnnouncementModal'));
import { isGuideEnded, resetOnboardingAllForUser } from '@/lib/onboarding';
import { getLatestAnnouncement, hasUnreadAnnouncement } from '@/lib/announcement';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Image } from '@/components/ui/image';
import VirtualList from '@/components/VirtualList';
import { usePlayer } from '@/contexts/PlayerContext';
import { useListenTogether } from '@/contexts/ListenTogetherContext';
import VisualizerCanvas from '@/components/VisualizerCanvas';
import VisualizerLayer from '@/components/VisualizerLayer';
import { searchSongs, getQrKey, getQrImage, checkQrStatus, getLoginStatus, hasLocalCookie, getUserPlaylists, getPlaylistTracks, getAllPlaylistTracks, getLikedSongs, updateLikedCache, toggleLike, getRecentSongs, getSongDetail, getDailyRecommend, getPersonalizedPlaylists, getIntelligenceList, getVipGrowthPoint, getCoverUrl, logout as neteaseLogout, resetLoginBase, type ILyricLine } from '@/lib/netease';
import { getWebGLStatus, resetWebGLStatus } from '@/lib/visualizerManager';
import { resetBeatBus, getBeatState } from '@/lib/beatBus';
import { useBeatService, resetBeatDetection } from '@/lib/useBeatService';
import { getDiagnosticService } from '@/lib/diagnosticService';
import { DEFAULT_LYRIC } from '@/lib/defaultSettings';
import type { ITrack, INeteaseUser, IPlaylist, PlayMode, ILyricSettings, IVisualizerSettings } from '@/types';
type VisualizerMode = IVisualizerSettings['mode'];
type PanelType = 'none' | 'search' | 'queue' | 'settings' | 'login' | 'playlist' | 'playlistDetail' | 'recommendPlaylists' | 'account';
const formatTime = (s: number) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
};
export default function PlayerMain({
  mode, setMode,
  primaryColor, setPrimaryColor,
  secondaryColor, setSecondaryColor,
  sensitivity, setSensitivity,
  targetFps, setTargetFps,
  quality, setQuality,
  vizScale, setVizScale,
  vizOffsetX, setVizOffsetX,
   vizOffsetY, setVizOffsetY,
   coverParticleCount, setCoverParticleCount,
   coverBrightness, setCoverBrightness,
   coverParticleSize, setCoverParticleSize,
   coverDensity, setCoverDensity,
    coverOpacity, setCoverOpacity,
     coverTwist, setCoverTwist,
    coverScatter, setCoverScatter,
    coverSpeed, setCoverSpeed,
    coverColorBoost, setCoverColorBoost,
     coverEdgeEnabled, setCoverEdgeEnabled,
     coverPreset, setCoverPreset,
     coverIntensity, setCoverIntensity,
     coverDepth, setCoverDepth,
     coverBloomStrength, setCoverBloomStrength,
     coverStarRiver, setCoverStarRiver,
     coverBgFade, setCoverBgFade,
     cover2dScale, setCover2dScale,
     cover2dGlow, setCover2dGlow,
      coverBeatSensitivity, setCoverBeatSensitivity,
       bgImageUrl, bgImageType,
      setBgImageUrl, setBgImageType,
     lyricSettings, setLyricSettings,
    isRecording, onToggleRecord, recordTime, isStoppingRecord,
   onPlaySingle,
   onResetAll,
   onOpenTour,
   openTour,
   onCloseTour,
 }: {
  mode: VisualizerMode;
  setMode: (m: VisualizerMode) => void;
  primaryColor: string;
  setPrimaryColor: (c: string) => void;
  secondaryColor: string;
  setSecondaryColor: (c: string) => void;
  sensitivity: number;
  setSensitivity: (n: number) => void;
  targetFps: number;
  setTargetFps: (n: number) => void;
  quality: 'low' | 'mid' | 'high' | 'native';
  setQuality: (q: 'low' | 'mid' | 'high' | 'native') => void;
  vizScale: number;
  setVizScale: (n: number) => void;
  vizOffsetX: number;
  setVizOffsetX: (n: number) => void;
   vizOffsetY: number;
   setVizOffsetY: (n: number) => void;
   coverParticleCount: number;
   setCoverParticleCount: (n: number) => void;
   coverBrightness: number;
   setCoverBrightness: (n: number) => void;
   coverParticleSize: number;
   setCoverParticleSize: (n: number) => void;
   coverDensity: number;
   setCoverDensity: (n: number) => void;
    coverOpacity: number;
    setCoverOpacity: (n: number) => void;
     coverTwist: number;
    setCoverTwist: (n: number) => void;
    coverScatter: number;
    setCoverScatter: (n: number) => void;
    coverSpeed: number;
    setCoverSpeed: (n: number) => void;
    coverColorBoost: number;
    setCoverColorBoost: (n: number) => void;
     coverEdgeEnabled: boolean;
     setCoverEdgeEnabled: (v: boolean) => void;
     coverPreset: number;
     setCoverPreset: (n: number) => void;
     coverIntensity: number;
     setCoverIntensity: (n: number) => void;
     coverDepth: number;
     setCoverDepth: (n: number) => void;
     coverBloomStrength: number;
     setCoverBloomStrength: (n: number) => void;
     coverStarRiver: boolean;
     setCoverStarRiver: (v: boolean) => void;
     coverBgFade: number;
     setCoverBgFade: (n: number) => void;
     cover2dScale: number;
     setCover2dScale: (n: number) => void;
     cover2dGlow: number;
     setCover2dGlow: (n: number) => void;
      coverBeatSensitivity: number;
      setCoverBeatSensitivity: (n: number) => void;
      bgImageUrl: string;
     bgImageType: 'image' | 'video';
     setBgImageUrl: (url: string) => void;
      setBgImageType: (t: 'image' | 'video') => void;
     lyricSettings: ILyricSettings;
   setLyricSettings: (s: ILyricSettings) => void;
   isRecording: boolean;
   isStoppingRecord?: boolean;
   onToggleRecord: () => void;
  recordTime: number;
   onPlaySingle?: (track: ITrack) => void;
   onResetAll: () => void;
  onOpenTour?: () => void;
  openTour?: boolean;
  onCloseTour?: () => void;
 }) {
   const {
      currentTrack, currentIndex, queue, isPlaying,
      currentTime, duration, volume,
      playMode, playTrack, prevTrack, nextTrack, togglePlay,
      seek, setVolume, cyclePlayMode, addTracks, replaceQueue, playListAt,
      getNextTrack, removeTrack, clearQueue,
       getFrequencyData,
       getTimeDomainData,
       lyric, currentLyricIndex,
       windowStart, totalCount,
    } = usePlayer();
  const [panel, setPanel] = useState<PanelType>('none');
  const [rightQueueOpen, setRightQueueOpen] = useState(false);
  const [openEngMenu, setOpenEngMenu] = useState(false);
   const [controlsVisible, setControlsVisible] = useState(true);
   const [floatingControlsVisible, setFloatingControlsVisible] = useState(false);
   const floatingHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
   const [togetherOpen, setTogetherOpen] = useState(false);
   const [announcementOpen, setAnnouncementOpen] = useState(false);
   const [hasUnreadAnnounce, setHasUnreadAnnounce] = useState(() => hasUnreadAnnouncement());
    const { inRoom, inviteRoomId, skipVotes, prevVotes, skipVoteThreshold, hasSkippedVoted, hasPrevVoted, castSkipVote, castPrevVote, selfPaused, toggleSelfPlayPause, seekInRoom, isDualRoom } = useListenTogether();
    const autoOpenFromUrlRef = useRef(false);
    useEffect(() => {
      if (autoOpenFromUrlRef.current) return;
      if (!inviteRoomId) return;
      if (inRoom) {
        autoOpenFromUrlRef.current = true;
        setTogetherOpen(true);
      }
    }, [inRoom, inviteRoomId]);
  const s_lyric = { ...DEFAULT_LYRIC, ...(lyricSettings || {}) };
  const [webglError, setWebglError] = useState<string>('');
  const [showNextPreview, setShowNextPreview] = useState(false);
  useBeatService({ getFrequencyData, sensitivity });
  useEffect(() => {
    const diag = getDiagnosticService();
    diag.setFields({ targetFps, qualityTier: quality, webgl: webglError ? 'error' : 'available', webglError: webglError || undefined });
  }, [targetFps, quality, webglError]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) { getDiagnosticService().setField('audioContextState', 'unsupported'); return; }
    const check = () => {
      const diag = getDiagnosticService();
      try {
        const ctx = (window as any).__playerAudioCtx;
        if (ctx) diag.setField('audioContextState', ctx.state || 'unknown');
        else diag.setField('audioContextState', 'not-created');
      } catch { diag.setField('audioContextState', 'unknown'); }
    };
    check();
    const timer = setInterval(check, 1000);
    return () => clearInterval(timer);
   }, []);
    const [isLandscape, setIsLandscape] = useState(false);
    useEffect(() => {
      const check = () => { setIsLandscape(window.innerWidth > window.innerHeight); };
      check();
      window.addEventListener('resize', check);
      window.addEventListener('orientationchange', check);
      return () => { window.removeEventListener('resize', check); window.removeEventListener('orientationchange', check); };
    }, []);
   const is3DMode = mode === 'galaxy3d' || mode === 'sphere3d' || mode === 'ring3d' || mode === 'cover3d';
   const showSideCards = isLandscape && is3DMode && !controlsVisible;
   const [leftCardExpanded, setLeftCardExpanded] = useState(true);
   const [rightCardExpanded, setRightCardExpanded] = useState(true);
   const [showCoverPlaceholder, setShowCoverPlaceholder] = useState(false);
   const [rightCardDemoCollapsed, setRightCardDemoCollapsed] = useState(false);
   type SideTool = 'spectrum' | 'vu' | 'scope' | 'bpm';
  const [sideTool, setSideTool] = useState<SideTool>(() => {
    try { const saved = localStorage.getItem('__app_side_tool'); if (saved === 'spectrum' || saved === 'vu' || saved === 'scope' || saved === 'bpm') return saved; } catch {}
    return 'spectrum';
  });
  const [sidePeakDb, setSidePeakDb] = useState(0);
   useEffect(() => { try { localStorage.setItem('__app_side_tool', sideTool); } catch {} }, [sideTool]);
   const [user, setUser] = useState<INeteaseUser | null>(null);
   const [isRestoringLogin, setIsRestoringLogin] = useState<boolean>(() => hasLocalCookie());
   const [likedIds, setLikedIds] = useState<Set<number>>(new Set());
   const [likedLoading, setLikedLoading] = useState(false);
   const hasAutoShownRef = useRef<{ portrait: boolean; landscape: boolean }>({ portrait: false, landscape: false });
   const autoTourPendingRef = useRef(false);
  const [playlistDetail, setPlaylistDetail] = useState<IPlaylist | null>(null);
  const [playlistTracks, setPlaylistTracks] = useState<ITrack[]>([]);
  const [playlistLoading, setPlaylistLoading] = useState(false);
  const [playlistOffset, setPlaylistOffset] = useState(0);
  const [playlistHasMore, setPlaylistHasMore] = useState(true);
  const [playlistTotal, setPlaylistTotal] = useState(0);
  const [recommendPlaylists, setRecommendPlaylists] = useState<IPlaylist[]>([]);
   const PLAYLIST_PAGE_SIZE = 50;
   useEffect(() => {
     if (duration <= 0 || !currentTrack) { setShowNextPreview(false); return; }
     const remaining = duration - currentTime;
     const next = getNextTrack();
     setShowNextPreview(remaining <= 10 && next);
   }, [currentTime, duration, currentTrack, getNextTrack]);
   useEffect(() => { if (!currentTrack) return; resetBeatDetection(); }, [currentTrack?.id]);
   const nextTrackInfo = getNextTrack?.() ?? null;
  const roamAutoLoadRef = useRef(false);
  useEffect(() => {
    if (!roamRef.current.seedSongId) return;
    if (roamAutoLoadRef.current) return;
    const remaining = totalCount - currentIndex - 1;
    if (remaining <= 5 && totalCount > 0) {
      roamAutoLoadRef.current = true;
      const seedId = currentTrack?.neteaseId || roamRef.current.seedSongId || 0;
      if (!seedId) { roamAutoLoadRef.current = false; return; }
      getIntelligenceList(seedId, 30).then(res => {
        if (res.authRequired) { toast.error('登录已过期，请重新登录'); roamRef.current.seedSongId = 0; return; }
        if (res.tracks.length > 0) {
          const result = addTracks(res.tracks, false);
          if (result && 'added' in result && result.added > 0) {
            const existed = new Set(playlistTracks.map(t => t.id));
            const newForDisplay = res.tracks.filter(t => !existed.has(t.id));
            if (newForDisplay.length > 0) { setPlaylistTracks(prev => [...prev, ...newForDisplay]); setPlaylistTotal(prev => prev + newForDisplay.length); }
          }
          roamRef.current.seedSongId = seedId;
        }
      }).catch(() => {}).finally(() => { setTimeout(() => { roamAutoLoadRef.current = false; }, 3000); });
    }
  }, [currentIndex, totalCount, currentTrack, addTracks, playlistTracks]);
  useEffect(() => {
    if (!hasLocalCookie()) { setIsRestoringLogin(false); return; }
    setIsRestoringLogin(true);
    const checkLogin = async () => {
      let retryCount = 0;
      while (retryCount < 3) {
        const u = await getLoginStatus(retryCount > 0);
        if (u) {
          setUser(u); setIsRestoringLogin(false); loadLikedSongs(u.userId);
          if (u.vipLabel && u.growthLevel === undefined) {
            const growth = await getVipGrowthPoint();
            if (growth) setUser((prev) => prev ? { ...prev, growthLevel: growth.level, growthValue: growth.growthValue, growthNextLevel: growth.nextLevelValue, growthProgress: growth.progress } : prev);
          }
          return;
        }
        retryCount += 1;
        if (retryCount < 3) await new Promise(r => setTimeout(r, 800));
      }
      setIsRestoringLogin(false);
    };
    const run = () => { checkLogin(); };
    let idleId: number | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    if (typeof requestIdleCallback === 'function') idleId = requestIdleCallback(run, { timeout: 500 });
    else timeoutId = setTimeout(run, 300);
    return () => { if (idleId !== null) cancelIdleCallback(idleId); if (timeoutId !== null) clearTimeout(timeoutId); };
  }, []);
  const loadLikedSongs = async (uid: number) => {
    if (likedLoading) return;
    setLikedLoading(true);
    try {
      const res = await getLikedSongs(uid);
      if (res.authRequired) { setLikedIds(new Set()); return; }
      setLikedIds(new Set(res.ids));
    } catch {} finally { setLikedLoading(false); }
  };
  const handleToggleLike = async (track: ITrack) => {
    if (!user) { toast.info('请先登录后收藏歌曲'); setPanel('login'); return; }
    if (!track.neteaseId) return;
    const id = track.neteaseId;
    const isCurrentlyLiked = likedIds.has(id);
    const nextLiked = !isCurrentlyLiked;
    setLikedIds(prev => { const next = new Set(prev); if (nextLiked) next.add(id); else next.delete(id); return next; });
    updateLikedCache(user.userId, id, nextLiked);
    try {
      const result = await toggleLike(id, nextLiked);
      if (result.authRequired) {
        setLikedIds(prev => { const next = new Set(prev); if (isCurrentlyLiked) next.add(id); else next.delete(id); return next; });
        updateLikedCache(user.userId, id, isCurrentlyLiked);
        toast.error('登录已过期，请重新登录'); setPanel('login'); return;
      }
      if (!result.success) {
        setLikedIds(prev => { const next = new Set(prev); if (isCurrentlyLiked) next.add(id); else next.delete(id); return next; });
        updateLikedCache(user.userId, id, isCurrentlyLiked);
        toast.error(nextLiked ? '收藏失败' : '取消收藏失败'); return;
      }
      toast.success(nextLiked ? '已收藏到我喜欢的音乐' : '已取消收藏');
    } catch {
      setLikedIds(prev => { const next = new Set(prev); if (isCurrentlyLiked) next.add(id); else next.delete(id); return next; });
      updateLikedCache(user.userId, id, isCurrentlyLiked);
      toast.error('操作失败，请稍后再试');
    }
  };
  const openPanel = (p: PanelType) => { setRightQueueOpen(false); setPanel(p); };
  const closePanel = () => setPanel('none');
  const togglePanel = (p: PanelType) => setPanel(prev => prev === p ? 'none' : p);
   const resetTourAndReopen = useCallback(() => {
     resetOnboardingAllForUser(user?.userId); setAutoWizardOpen(false);
     if (panel !== 'none') closePanel();
     toast.success('新手引导已重置，将从欢迎页重新开始');
     setTimeout(() => { setAutoWizardOpen(true); }, 200);
   }, [user?.userId, panel]);
   const startTourSafely = useCallback(() => {
     const needSideCards = isLandscape && (!is3DMode || controlsVisible);
     if (panel !== 'none' || needSideCards) {
       if (panel !== 'none') closePanel();
        const isCover3DMode = mode === 'cover3d';
        if (needSideCards) {
          if (!is3DMode) setMode('cover3d');
          if (controlsVisible && isCover3DMode) setControlsVisible(false);
        }
       autoTourPendingRef.current = true; return;
     }
     autoTourPendingRef.current = false;
     if (onOpenTour) onOpenTour();
   }, [panel, isLandscape, is3DMode, controlsVisible, onOpenTour, closePanel, setMode]);
   useEffect(() => {
     if (!autoTourPendingRef.current) return;
     const ready = panel === 'none' && (!isLandscape || (is3DMode && !controlsVisible));
     if (ready) {
       autoTourPendingRef.current = false;
       const t = window.setTimeout(() => { if (onOpenTour) onOpenTour(); }, 400);
       return () => window.clearTimeout(t);
     }
   }, [panel, isLandscape, is3DMode, controlsVisible, onOpenTour]);
    const [autoWizardOpen, setAutoWizardOpen] = useState(false);
    useEffect(() => {
      if (!user || !user.userId) return;
      if (hasAutoShownRef.current.portrait) return;
      const timer = setTimeout(() => {
        const ended = isGuideEnded(user.userId);
        if (!ended && panel === 'none') setAutoWizardOpen(true);
        hasAutoShownRef.current.portrait = true;
       }, 1000);
       return () => clearTimeout(timer);
     }, [user, panel]);
    useEffect(() => {
      if (!getLatestAnnouncement()) return;
      if (!hasUnreadAnnounce) return;
      const timer = setTimeout(() => {
        if (panel === 'none' && !togetherOpen && !autoWizardOpen && !openTour) setAnnouncementOpen(true);
      }, 1500);
      return () => clearTimeout(timer);
    }, [hasUnreadAnnounce, panel, togetherOpen, autoWizardOpen, openTour]);
  const showFloatingControls = () => { setFloatingControlsVisible(true); resetFloatingHideTimer(); };
  const hideFloatingControls = () => {
    setFloatingControlsVisible(false);
    if (floatingHideTimerRef.current) { clearTimeout(floatingHideTimerRef.current); floatingHideTimerRef.current = null; }
  };
  const resetFloatingHideTimer = () => {
    if (floatingHideTimerRef.current) clearTimeout(floatingHideTimerRef.current);
    floatingHideTimerRef.current = setTimeout(() => { setFloatingControlsVisible(false); floatingHideTimerRef.current = null; }, 30000);
  };
  const handleCanvasClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('.control-bar') || target.closest('.panel-area')) return;
    setControlsVisible(v => !v);
  };
  const lastClickRef = useRef<{ time: number; x: number } | null>(null);
  const handleCanvasDoubleClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('.control-bar') || target.closest('.panel-area') || target.closest('.side-card-area')) return;
    triggerDoubleClickAction(e.clientX);
  };
  const lastTouchRef = useRef<{ time: number; x: number } | null>(null);
  const handleCanvasTouchStart = (e: React.TouchEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('.control-bar') || target.closest('.panel-area') || target.closest('.side-card-area')) return;
    const touch = e.touches[0]; if (!touch) return;
    const now = Date.now(); const last = lastTouchRef.current;
    if (last && now - last.time < 400 && Math.abs(touch.clientX - last.x) < 30) { lastTouchRef.current = null; triggerDoubleClickAction(touch.clientX); }
    else lastTouchRef.current = { time: now, x: touch.clientX };
  };
  const triggerDoubleClickAction = (x: number) => {
    const w = window.innerWidth;
    const edgeThreshold = Math.min(60, w * 0.08);
    let handled = false;
    if (showSideCards) {
      if (x < edgeThreshold && !leftCardExpanded) { setLeftCardExpanded(true); handled = true; }
      else if (x > w - edgeThreshold && !rightCardExpanded) { setRightCardExpanded(true); handled = true; }
    }
    if (!isLandscape) showFloatingControls();
    if (!handled && !controlsVisible) setControlsVisible(true);
  };
  const playModeLabel = playMode === 'loop' ? '单曲循环' : playMode === 'shuffle' ? '随机播放' : '列表循环';
  const openPlaylistDetail = async (list: IPlaylist) => {
    roamRef.current.seedSongId = 0;
    setPlaylistDetail(list); setPlaylistTracks([]); setPlaylistOffset(0); setPlaylistHasMore(true); setPlaylistLoading(true); setPanel('playlistDetail');
    try {
      const res = await getPlaylistTracks(list.id, PLAYLIST_PAGE_SIZE, 0);
      setPlaylistTracks(res.tracks); setPlaylistTotal(res.total); setPlaylistHasMore(res.tracks.length < res.total); setPlaylistOffset(PLAYLIST_PAGE_SIZE);
    } catch { toast.error('加载歌单失败'); } finally { setPlaylistLoading(false); }
  };
  const loadMorePlaylistTracks = async () => {
    if (playlistLoading || !playlistHasMore || !playlistDetail) return;
    setPlaylistLoading(true);
    try {
      if (playlistDetail.id === -3) {
        const lastTrack = playlistTracks[playlistTracks.length - 1];
        const seedId = lastTrack?.neteaseId || roamRef.current.seedSongId || 0;
        roamRef.current.seedSongId = seedId;
        const res = await getIntelligenceList(seedId, 30);
        if (res.authRequired) { toast.error('登录已过期，请重新登录'); setPlaylistHasMore(false); return; }
        const existed = new Set(playlistTracks.map(t => t.id));
        const newTracks = res.tracks.filter(t => !existed.has(t.id));
        if (newTracks.length === 0) { setPlaylistHasMore(false); return; }
        setPlaylistTracks(prev => [...prev, ...newTracks]); setPlaylistTotal(prev => prev + newTracks.length);
        setPlaylistHasMore(true); setPlaylistOffset(prev => prev + newTracks.length); return;
      }
      const res = await getPlaylistTracks(playlistDetail.id, PLAYLIST_PAGE_SIZE, playlistOffset);
      setPlaylistTracks(prev => [...prev, ...res.tracks]);
      setPlaylistHasMore(playlistOffset + res.tracks.length < res.total);
      setPlaylistOffset(prev => prev + PLAYLIST_PAGE_SIZE);
    } finally { setPlaylistLoading(false); }
  };
   const playEntirePlaylist = async () => {
     if (!playlistDetail) return;
     setPlaylistLoading(true); closePanel(); toast.info('正在加载歌单曲目…');
     try {
       let tracks: ITrack[] = []; let total = 0;
       if (playlistDetail.id < 0) { tracks = playlistTracks; total = playlistTotal || tracks.length; }
       else { const res = await getAllPlaylistTracks(playlistDetail.id); tracks = res.tracks; total = res.total; }
       if (tracks.length === 0) { toast.error('歌单为空或加载失败'); return; }
       replaceQueue(tracks, 0); toast.success(`已开始播放 · 共 ${total} 首`);
     } catch { toast.error('加载歌单失败'); } finally { setPlaylistLoading(false); }
   };
  const openDailyRecommend = async () => {
    if (!user) { setPanel('login'); return; }
    roamRef.current.seedSongId = 0; setPlaylistLoading(true);
    try {
      const { tracks, total, authRequired } = await getDailyRecommend();
      if (tracks.length === 0) {
        if (authRequired) { toast.error('登录已失效，请重新登录'); setPanel('login'); }
        else toast.error('每日推荐加载失败，请稍后重试');
        return;
      }
      const dailyPlaylist: IPlaylist = { id: -2, name: '每日推荐', coverUrl: '', trackCount: total };
      setPlaylistDetail(dailyPlaylist); setPlaylistTracks(tracks); setPlaylistTotal(total); setPlaylistHasMore(false); setPlaylistOffset(tracks.length); setPanel('playlistDetail');
    } catch { toast.error('加载每日推荐失败'); } finally { setPlaylistLoading(false); }
  };
  const roamRef = useRef({ seedSongId: 0 as number, loading: false });
  const openRoam = async (): Promise<boolean> => {
    if (!user) { toast.info('请先登录后使用漫游功能'); setPanel('login'); return false; }
    const seedId = currentTrack?.neteaseId || 0;
    if (!seedId) { toast.info('请先播放一首网易云歌曲，再开启漫游'); return false; }
    setPlaylistLoading(true); roamRef.current.loading = true;
    try {
      roamRef.current.seedSongId = seedId;
      const res = await getIntelligenceList(seedId, 30);
      if (res.authRequired) { toast.error('登录已过期，请重新登录'); roamRef.current.seedSongId = 0; setPanel('login'); return false; }
      if (!res.tracks || res.tracks.length === 0) { toast.error('暂无推荐歌曲，换一首试试'); roamRef.current.seedSongId = 0; return false; }
      const radioPlaylist: IPlaylist = { id: -3, name: '漫游', coverUrl: '', trackCount: res.total };
      setPlaylistDetail(radioPlaylist); setPlaylistTracks(res.tracks); setPlaylistTotal(res.tracks.length); setPlaylistHasMore(true); setPlaylistOffset(res.tracks.length);
      playListAt(res.tracks, 0); setPanel('playlistDetail'); toast.success('漫游已开启，歌曲播完自动续推'); return true;
    } catch { toast.error('加载漫游歌曲失败'); roamRef.current.seedSongId = 0; return false; }
    finally { setPlaylistLoading(false); roamRef.current.loading = false; }
  };
  const handleForce3D = () => { resetWebGLStatus(); setWebglError(''); toast.info('正在强制尝试 3D 模式...'); };
  const handle3DError = useCallback((_reason: string, detail: string) => { setWebglError(detail || '3D 不可用'); }, []);
  return (
    <>
      <div className="relative w-full h-full overflow-hidden select-none" onClick={handleCanvasClick} onDoubleClick={handleCanvasDoubleClick} onTouchStart={handleCanvasTouchStart}>
      <style>{`@keyframes glassShimmer { 0%, 100% { transform: translateY(-20px); opacity: 0.6; } 50% { transform: translateY(20px); opacity: 1; } }`}</style>
      <header className={`absolute top-0 left-0 right-0 z-40 pointer-events-none transition-all duration-300 ${controlsVisible ? 'translate-y-0 opacity-100' : '-translate-y-full opacity-0'}`}>
         <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-b from-black/60 to-transparent pointer-events-auto">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full flex items-center justify-center" style={{ backgroundColor: primaryColor }}><Music className="w-4 h-4 text-black" /></div>
            <span className="text-white font-semibold text-base">M V Player</span>
          </div>
           <div className="flex items-center gap-1">
             <Button variant="ghost" size="icon" className="text-white/80 hover:text-white hover:bg-white/10 h-9 w-9" onClick={(e) => { e.stopPropagation(); togglePanel('search'); }}><Search className="w-4 h-4" /></Button>
             <Button variant="ghost" size="icon" className={`relative h-9 w-9 ${hasUnreadAnnounce ? 'text-primary' : 'text-white/80 hover:text-white hover:bg-white/10'}`} onClick={(e) => { e.stopPropagation(); setAnnouncementOpen(true); }} title="更新公告">
               <Bell className="w-4 h-4" />{hasUnreadAnnounce && <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-destructive ring-2 ring-card pointer-events-none" />}
             </Button>
            <Button variant="ghost" size="icon" className={`h-9 w-9 ${isRecording ? 'text-red-400' : 'text-white/80 hover:text-white hover:bg-white/10'}`} onClick={(e) => { e.stopPropagation(); onToggleRecord(); }} disabled={isStoppingRecord} title={isStoppingRecord ? '正在生成文件…' : isRecording ? '停止录制' : '开始录制'} data-tour="record">
               {isStoppingRecord ? <Loader2 className="w-4 h-4 animate-spin" /> : <CircleDot className={`w-4 h-4 ${isRecording ? 'fill-red-500' : ''}`} />}
             </Button>
             <Button variant="ghost" size="icon" className="text-white/80 hover:text-white hover:bg-white/10 h-9 w-9" onClick={(e) => { e.stopPropagation(); togglePanel(user ? 'account' : 'login'); }} title={user ? `${user.nickname} · 个人中心` : '登录 / 个人中心'} data-tour="login">
               {user ? (<div className="w-7 h-7 rounded-full overflow-hidden border border-white/20">{user.avatarUrl ? <Image src={user.avatarUrl} alt={user.nickname} className="w-full h-full object-cover" /> : <UserIcon className="w-3.5 h-3.5 text-white/60" />}</div>) : isRestoringLogin ? <div className="w-4 h-4 border-2 border-primary/40 border-t-primary rounded-full animate-spin" /> : <UserIcon className="w-4 h-4" />}
            </Button>
          </div>
        </div>
      </header>
       <VisualizerLayer mode={mode} primaryColor={primaryColor} secondaryColor={secondaryColor} sensitivity={sensitivity} vizScale={vizScale} vizOffsetX={vizOffsetX} vizOffsetY={vizOffsetY} targetFps={targetFps} quality={quality} coverParticleCount={coverParticleCount} coverBrightness={coverBrightness} coverParticleSize={coverParticleSize} coverDensity={coverDensity} coverOpacity={coverOpacity} coverTwist={coverTwist} coverScatter={coverScatter} coverSpeed={coverSpeed} coverColorBoost={coverColorBoost} coverEdgeEnabled={coverEdgeEnabled} coverPreset={coverPreset} coverIntensity={coverIntensity} coverDepth={coverDepth} coverBloomStrength={coverBloomStrength} coverStarRiver={coverStarRiver} coverBgFade={coverBgFade} cover2dScale={cover2dScale} cover2dGlow={cover2dGlow} coverBeatSensitivity={coverBeatSensitivity} lyricLines={lyric} currentLyricIndex={currentLyricIndex} lyricColor={s_lyric.color} bgImageUrl={bgImageUrl} bgImageType={bgImageType} isRecording={isRecording} showCoverPlaceholder={showCoverPlaceholder} on3DError={handle3DError} />