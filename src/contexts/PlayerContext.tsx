import { createContext, useContext, useState, useRef, useCallback, useEffect, type ReactNode } from 'react';
 import type { ITrack, PlayMode } from '@/types';
 import { getSongUrl, getLyric, type ILyricLine } from '@/lib/netease';
import { toast } from 'sonner';
import { scopedStorage, logger } from '@lark-apaas/client-toolkit-lite';
import { getDiagnosticService } from '@/lib/diagnosticService';
import { resetBeatDetection } from '@/lib/useBeatService';
import {
  setFrequencyDataSource,
  setTimeDomainDataSource,
  setAnalyserConnected,
} from '@/lib/audioFrameBus';

 const PLAYER_STORAGE_KEY = 'audioviz_player_state';

 /** 可持久化的播放器状态（不含 file/blob 等不可序列化内容） */
 interface ISavedPlayerState {
   queue: Array<Pick<ITrack, 'id' | 'name' | 'artist' | 'album' | 'coverUrl' | 'duration' | 'source' | 'neteaseId' | 'isVip' | 'fee'>>;
   currentIndex: number;
   currentTime: number;
   playMode: PlayMode;
   volume: number;
   isPlaying: boolean;
 }

// ===== 播放器状态 =====
interface PlayerState {
   /** UI 展示用的滑动窗口歌曲列表（只包含 windowStart..windowStart+windowSize 范围） */
   queue: ITrack[];
   /** 窗口在完整数据源中的起始偏移 */
   windowStart: number;
   /** 完整数据源总条数 */
   totalCount: number;
   currentIndex: number;
  currentTrack: ITrack | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  playMode: PlayMode;
  lyric: ILyricLine[];
  currentLyricIndex: number;
  isLoading: boolean;
}

interface PlayerContextValue extends PlayerState {
  audioElement: HTMLAudioElement | null;
  analyser: AnalyserNode | null;
  addTracks: (tracks: ITrack[], playFirst?: boolean) => { added: number; duplicates: number } | void;
  replaceQueue: (tracks: ITrack[], startIndex?: number) => void;
  removeTrack: (index: number) => void;
  clearQueue: () => void;
  playTrack: (index: number) => void;
  playTrackById: (id: string) => void;
  playListAt: (tracks: ITrack[], index: number) => void;
  togglePlay: () => void;
  nextTrack: () => void;
  prevTrack: () => void;
    seek: (time: number) => void;
    setVolume: (v: number) => void;
    cyclePlayMode: () => void;
    getNextTrack: () => ITrack | null;
    getFrequencyData: () => Uint8Array | null;
    getTimeDomainData: () => Uint8Array | null;
  }

  const PlayerContext = createContext<PlayerContextValue | null>(null);

export function usePlayer() {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error('usePlayer must be used within PlayerProvider');
  return ctx;
}

// ===== Provider =====
export function PlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const freqDataRef = useRef<Uint8Array | null>(null);
  const timeDomainDataRef = useRef<Uint8Array | null>(null);
  const audioContextReadyRef = useRef(false);
  const currentTimeRef = useRef(0);
  const lyricRef = useRef<import('@/lib/netease').ILyricLine[]>([]);

  // 当前队列（ref 版本，用于 next/prev 等内部操作，避免闭包）
  const queueRef = useRef<ITrack[]>([]);
  const currentIndexRef = useRef<number>(-1);
   const playModeRef = useRef<PlayMode>('sequence');
   // 完整数据源（所有导入的歌曲，不进入 React state，避免大队列重渲染卡顿）
   const fullQueueRef = useRef<ITrack[]>([]);
   // 滑动窗口参数
   const WINDOW_SIZE = 30;      // 窗口大小（UI 物化的歌曲数）
   const LOOKAHEAD = 5;        // 距窗口末尾多少首时开始前向扩窗
   const KEEP_BEHIND = 5;      // 窗口始终保留当前曲目之前的歌曲数（保证上一首可用）
   const windowStartRef = useRef(0);

  const [state, setState] = useState<PlayerState>({
     queue: [],
     windowStart: 0,
     totalCount: 0,
     currentIndex: -1,
    currentTrack: null,
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    volume: 0.8,
    playMode: 'sequence',
    lyric: [],
    currentLyricIndex: -1,
    isLoading: false,
  });

  // ===== 初始化 audio 元素 =====
  useEffect(() => {
    const audio = new Audio();
    audio.crossOrigin = 'anonymous';
    audio.preload = 'metadata';
    audio.volume = state.volume;
    audioRef.current = audio;

    // timeupdate 节流到 100ms（~10fps），避免浏览器默认 4Hz 触发全树重渲染导致 watchdog 超时
    let lastTimeUpdate = 0;
    let pendingTime = 0;
    let pendingIdx = -1;
    let rafScheduled = false;
    const onTimeUpdate = () => {
      const now = performance.now();
      const time = audio.currentTime;
      // 用 ref 暂存最新时间和歌词索引（不触发 React）
      if (currentTimeRef) currentTimeRef.current = time;
      // 计算歌词索引（纯计算，不 setState）
      let idx = -1;
      const curLyric = lyricRef.current;
      if (curLyric.length > 0) {
        for (let i = curLyric.length - 1; i >= 0; i--) {
          if (time >= curLyric[i].time) {
            idx = i;
            break;
          }
        }
      }
      pendingTime = time;
      pendingIdx = idx;
      // 节流：100ms 内最多一次 setState
      if (now - lastTimeUpdate < 100) {
        if (!rafScheduled) {
          rafScheduled = true;
          requestAnimationFrame(() => {
            rafScheduled = false;
            lastTimeUpdate = performance.now();
            setState(s => {
              // 只有时间或歌词索引真正变化时才返回新对象
              if (s.currentTime === pendingTime && s.currentLyricIndex === pendingIdx) {
                return s;
              }
              return {
                ...s,
                currentTime: pendingTime,
                currentLyricIndex: pendingIdx,
              };
            });
          });
        }
        return;
      }
      lastTimeUpdate = now;
      setState(s => {
        if (s.currentTime === pendingTime && s.currentLyricIndex === pendingIdx) return s;
        return {
          ...s,
          currentTime: pendingTime,
          currentLyricIndex: pendingIdx,
        };
      });
    };

    const onLoadedMetadata = () => {
      setState(s => ({ ...s, duration: audio.duration || 0, isLoading: false }));
    };

    const onCanPlay = () => {
      setState(s => ({ ...s, isLoading: false }));
    };

    const onEnded = () => {
      nextTrackInternal();
    };

    const onError = () => {
      setState(s => ({ ...s, isLoading: false }));
      const err = audio.error;
      let msg = '播放失败';
      if (err) {
        switch (err.code) {
          case 1: msg = '播放被中断'; break;
          case 2: msg = '网络错误'; break;
          case 3: msg = '解码失败'; break;
          case 4: msg = '该歌曲暂无法播放（版权限制）'; break;
        }
      }
      toast.error(msg);
      logger.error('Audio error:', String(err));
      // 自动跳下一首
      setTimeout(() => nextTrackInternal(), 500);
    };

    const onPlay = () => {
      setState(s => ({ ...s, isPlaying: true }));
      // iOS/Safari 防御：play 事件触发时再确保一次 AudioContext running
      // 有些机型在用户点击 play 后 AudioContext 仍可能保持 suspended
      const ctx = audioCtxRef.current;
      if (ctx && ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
    };
    const onPause = () => setState(s => ({ ...s, isPlaying: false }));
    const onWaiting = () => setState(s => ({ ...s, isLoading: true }));
    const onPlaying = () => {
      setState(s => ({ ...s, isLoading: false }));
      // 再兜底一次：真正进入 playing 状态后确保 AudioContext running
      const ctx = audioCtxRef.current;
      if (ctx && ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
    };

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('canplay', onCanPlay);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('waiting', onWaiting);
    audio.addEventListener('playing', onPlaying);

    return () => {
      audio.pause();
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('canplay', onCanPlay);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('waiting', onWaiting);
      audio.removeEventListener('playing', onPlaying);
      // 清理 blob URL
      if (audio.src && audio.src.startsWith('blob:')) {
        URL.revokeObjectURL(audio.src);
      }
      // 清理 AudioContext 及其节点，防止内存泄漏
      try {
        if (sourceNodeRef.current) {
          sourceNodeRef.current.disconnect();
          sourceNodeRef.current = null;
        }
        if (analyserRef.current) {
          analyserRef.current.disconnect();
          analyserRef.current = null;
        }
        if (audioCtxRef.current) {
          audioCtxRef.current.close().catch(() => {});
          audioCtxRef.current = null;
        }
      } catch { /* ignore */ }
      freqDataRef.current = null;
      timeDomainDataRef.current = null;
      audioContextReadyRef.current = false;
      setAnalyserConnected(false);
      setFrequencyDataSource(null);
      setTimeDomainDataSource(null);
    };
     
  }, []);

  // ===== 初始化 AudioContext（必须用户交互后）=====
  const ensureAudioContext = useCallback(() => {
    if (!audioRef.current) return;
    try {
      const AC = (window.AudioContext || (window as any).webkitAudioContext);
      if (!AC) return;

      if (!audioContextReadyRef.current) {
        const ctx = new AC();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048; // 增大 fftSize，时域数据更细腻，频域仍取前 128 段用
        // smoothingTimeConstant 从 0.55 降到 0.35：
        // 减少 AnalyserNode 内部 FFT 平滑造成的相位滞后（约 50~80ms），
        // 让鼓点瞬态能更快反映到频谱数据上，封面脉冲对齐更准。
        // 仍保留一定平滑避免画面过度闪烁。
        analyser.smoothingTimeConstant = 0.35;
        const source = ctx.createMediaElementSource(audioRef.current);
        source.connect(analyser);
        analyser.connect(ctx.destination);
        audioCtxRef.current = ctx;
        analyserRef.current = analyser;
        sourceNodeRef.current = source;
        freqDataRef.current = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
        timeDomainDataRef.current = new Uint8Array(new ArrayBuffer(analyser.fftSize));
        audioContextReadyRef.current = true;
        // 暴露给全局诊断轮询与工程菜单（保证诊断读到真实 ctx.state）
        (window as any).__playerAudioCtx = ctx;

        // ===== 注册到帧总线（音频帧数据单例，所有小工具共用）=====
        setFrequencyDataSource(() => {
          if (!analyserRef.current || !freqDataRef.current) return null;
          try {
            analyserRef.current.getByteFrequencyData(freqDataRef.current as any);
            return freqDataRef.current;
          } catch {
            return null;
          }
        });
        setTimeDomainDataSource(() => {
          if (!analyserRef.current || !timeDomainDataRef.current) return null;
          try {
            analyserRef.current.getByteTimeDomainData(timeDomainDataRef.current as any);
            return timeDomainDataRef.current;
          } catch {
            return null;
          }
        });
        setAnalyserConnected(true);
        // 写入诊断：音频源已连接
        try {
          const diag = getDiagnosticService();
          diag.setFields({
            analyserSourceConnected: true,
            audioContextState: ctx.state,
          });
          diag.addLog('info', 'audio', `AudioContext 已创建，source→analyser→destination 连接完成，state=${ctx.state}`);
        } catch { /* ignore */ }
      }

      // iOS/Safari 必须在用户交互内 resume()，否则 AudioContext 保持 suspended，analyser 输出全 0
      const ctx = audioCtxRef.current;
      if (ctx && ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
    } catch (e) {
      logger.warn('AudioContext init failed:', String(e));
    }
  }, []);

  // ===== 获取频谱数据 =====
  const getFrequencyData = useCallback((): Uint8Array | null => {
    if (!analyserRef.current || !freqDataRef.current) return null;
    try {
      analyserRef.current.getByteFrequencyData(freqDataRef.current as any);
      return freqDataRef.current;
    } catch {
      return null;
    }
  }, []);

  // ===== 获取时域波形数据（用于示波器）=====
  const getTimeDomainData = useCallback((): Uint8Array | null => {
    if (!analyserRef.current || !timeDomainDataRef.current) return null;
    try {
      analyserRef.current.getByteTimeDomainData(timeDomainDataRef.current as any);
      return timeDomainDataRef.current;
    } catch {
      return null;
    }
  }, []);

  // ===== 根据全局 index 计算滑动窗口并同步到 state =====
   const syncWindowState = useCallback((globalIndex: number) => {
     const full = fullQueueRef.current;
     const total = full.length;
     if (total === 0) {
       windowStartRef.current = 0;
       setState(s => ({ ...s, queue: [], windowStart: 0, totalCount: 0, currentIndex: -1, currentTrack: null }));
       return;
     }
     // 计算窗口起点：尽量让 globalIndex 处于窗口前 1/3 处，同时前面保留 KEEP_BEHIND 首
     let start = Math.max(0, globalIndex - KEEP_BEHIND);
     // 确保窗口不越界
     if (start + WINDOW_SIZE > total) {
       start = Math.max(0, total - WINDOW_SIZE);
     }
     const end = Math.min(start + WINDOW_SIZE, total);
     const windowTracks = full.slice(start, end);
     windowStartRef.current = start;
     setState(s => ({
       ...s,
       queue: windowTracks,
       windowStart: start,
       totalCount: total,
       currentIndex: globalIndex,
       currentTrack: full[globalIndex] || null,
     }));
   }, []);
 
   // ===== 核心播放函数：直接用入参 tracks + index 播放 =====
   // 播放用的 track 从入参取，与 React state 解耦，确保点击那一刻立即播放
   const playListAt = useCallback(async (tracks: ITrack[], index: number) => {
     if (!audioRef.current) {
       toast.error('播放器未就绪');
       return;
     }

     const track = tracks[index];
     if (!track) {
       logger.warn('playListAt: track not found at index', String(index));
       toast.error('无法播放该歌曲');
       return;
     }

     // 确保音频上下文（用户交互后才能创建）
     ensureAudioContext();

     // ===== 滑动窗口判断 =====
     // 大队列（> WINDOW_SIZE*2）走滑动窗口；小列表直接全量展示
     const useWindow = tracks.length > WINDOW_SIZE * 2;
     if (useWindow) {
       fullQueueRef.current = tracks;
       queueRef.current = tracks; // 播放逻辑还用全量 ref，不受窗口影响
       currentIndexRef.current = index;
       syncWindowState(index);
       setState(s => ({
         ...s,
         isLoading: true,
         lyric: [],
         currentLyricIndex: -1,
         currentTime: 0,
         duration: 0,
       }));
     } else {
       fullQueueRef.current = tracks;
       queueRef.current = tracks;
       currentIndexRef.current = index;
       windowStartRef.current = 0;
       setState(s => ({
         ...s,
         queue: tracks,
         windowStart: 0,
         totalCount: tracks.length,
         currentIndex: index,
         currentTrack: track,
         isLoading: true,
         lyric: [],
         currentLyricIndex: -1,
         currentTime: 0,
         duration: 0,
       }));
     }

    try {
      // 获取播放地址（直接用入参 track，不从 state 读）
      let url = track.url;
      if (track.source === 'netease' && track.neteaseId) {
        url = await getSongUrl(track.neteaseId);
        if (!url) {
          if (track.isVip) {
            toast.error('该歌曲为 VIP 专享，已自动跳过');
          } else {
            toast.error('该歌曲暂无法播放（版权限制），已自动跳过');
          }
          setState(s => ({ ...s, isLoading: false }));
          // 跳下一首（在当前 tracks 列表里）
          setTimeout(() => playNextInList(tracks, index), 500);
          return;
        }
      } else if (track.source === 'local' && track.file) {
        url = URL.createObjectURL(track.file);
      }

      if (!url) {
        toast.error('无法获取播放地址');
        setState(s => ({ ...s, isLoading: false }));
        return;
      }

      // 清理旧 blob URL
      const oldSrc = audioRef.current.src;
      if (oldSrc && oldSrc.startsWith('blob:')) {
        URL.revokeObjectURL(oldSrc);
      }

      // 直接操作 audio 元素，不等 React
      // 切歌前重置 BPM 检测（平滑收敛，避免上一首歌数据干扰）
      try {
        resetBeatDetection();
      } catch { /* ignore */ }
      audioRef.current.src = url;
      audioRef.current.load();

      // 尝试播放（用户点击上下文内通常能自动播放）
      try {
        await audioRef.current.play();
      } catch (e) {
        logger.warn('Auto play blocked:', String(e));
        // 不报错，让用户手动点播放
      }

      // 加载歌词（仅网易云）
      if (track.source === 'netease' && track.neteaseId) {
        getLyric(track.neteaseId).then(lines => {
          lyricRef.current = lines;
          setState(s => ({ ...s, lyric: lines }));
        }).catch(() => { /* ignore */ });
      }
    } catch (e) {
      logger.error('playListAt error:', String(e));
      toast.error('加载失败');
      setState(s => ({ ...s, isLoading: false }));
    }
  }, [ensureAudioContext]);

  // ===== 在指定列表里跳下一首（用于版权跳过时的自动下一首）=====
  // ===== 播放列表里的下一首（用于版权跳过时的自动下一首）=====
   // 注意：tracks 是全量 ref，不是 UI 窗口；内部会自动推进窗口
   const playNextInList = useCallback((tracks: ITrack[], currentIdx: number) => {
     if (tracks.length === 0) return;
     const mode = playModeRef.current;
     let nextIdx: number;
     if (mode === 'loop') {
       nextIdx = currentIdx;
     } else if (mode === 'shuffle') {
       if (tracks.length === 1) {
         nextIdx = 0;
       } else {
         do {
           nextIdx = Math.floor(Math.random() * tracks.length);
         } while (nextIdx === currentIdx);
       }
     } else {
       nextIdx = currentIdx + 1;
       if (nextIdx >= tracks.length) {
         nextIdx = 0;
       }
     }
     // 大队列：在切歌前检查是否需要滑动窗口（接近末尾或越过起点）
     if (tracks.length > WINDOW_SIZE * 2) {
       const winStart = windowStartRef.current;
       const winEnd = winStart + WINDOW_SIZE;
       // 距窗口末尾 <= LOOKAHEAD 首时向前滑窗
       const needForward = nextIdx >= winEnd - LOOKAHEAD;
       // 越过窗口起点时向回滑窗
       const needBackward = nextIdx < winStart + KEEP_BEHIND && nextIdx >= KEEP_BEHIND;
       if (needForward || needBackward) {
         syncWindowState(nextIdx);
       }
     }
     // 用 playListAt 递归，形成自动跳过链
     playListAt(tracks, nextIdx);
   }, [playListAt, syncWindowState]);

  // ===== 下一首（内部版本，供 ended/版权跳过时使用）=====
  const nextTrackInternal = useCallback(() => {
    const tracks = queueRef.current;
    const currentIdx = currentIndexRef.current;
    if (tracks.length === 0) return;
    playNextInList(tracks, currentIdx);
  }, [playNextInList]);

  // ===== 添加歌曲到队列 =====
   const addTracks = useCallback((tracks: ITrack[], playFirst = false) => {
      if (tracks.length === 0) return { added: 0, duplicates: 0 };
      // 去重：基于 id
      const existingIds = new Set(queueRef.current.map((t) => t.id));
      const unique: ITrack[] = [];
      let duplicates = 0;
      for (const t of tracks) {
        if (existingIds.has(t.id)) {
          duplicates++;
        } else {
          existingIds.add(t.id);
          unique.push(t);
        }
      }
      if (unique.length === 0) {
        return { added: 0, duplicates };
      }
      // 先更新全量 ref（播放逻辑始终用全量）
      const startIdx = queueRef.current.length;
      const allTracks = [...queueRef.current, ...unique];
      queueRef.current = allTracks;
      fullQueueRef.current = allTracks;

      // 大队列走滑动窗口；小队列直接全量 state
      const total = allTracks.length;
      if (total > WINDOW_SIZE * 2) {
        // 滑动窗口模式：只物化窗口内的歌曲
        let winStart = windowStartRef.current;
        // 如果新加的在当前窗口末尾附近且 playFirst，把窗口移过去
        if (playFirst) {
          winStart = Math.max(0, startIdx - KEEP_BEHIND);
        }
        const winEnd = Math.min(winStart + WINDOW_SIZE, total);
        const windowTracks = allTracks.slice(winStart, winEnd);
        windowStartRef.current = winStart;
        setState(s => ({ ...s, queue: windowTracks, windowStart: winStart, totalCount: total }));
        if (playFirst) {
          currentIndexRef.current = startIdx;
          playListAt(allTracks, startIdx);
        }
        return;
      }

      // 小队列：全量 state
      windowStartRef.current = 0;
      setState(s => ({ ...s, queue: allTracks, windowStart: 0, totalCount: total }));
       if (playFirst) {
         currentIndexRef.current = startIdx;
         playListAt(allTracks, startIdx);
       }
       return { added: unique.length, duplicates };
     }, [playListAt]);

  // ===== 替换整个队列（播放新歌单时用）=====
  const replaceQueue = useCallback((tracks: ITrack[], startIndex = 0) => {
    if (tracks.length === 0) return;
    playListAt(tracks, startIndex);
  }, [playListAt]);

  // ===== 移除歌曲（index 是全局索引） =====
   const removeTrack = useCallback((index: number) => {
     const newQueue = queueRef.current.filter((_, i) => i !== index);
     let newIndex = currentIndexRef.current;
     if (index < currentIndexRef.current) {
       newIndex = currentIndexRef.current - 1;
     } else if (index === currentIndexRef.current) {
       // 移除当前播放
       newIndex = newQueue.length > 0 ? Math.min(index, newQueue.length - 1) : -1;
       if (audioRef.current && newIndex === -1) {
         audioRef.current.pause();
       }
     }
     queueRef.current = newQueue;
     fullQueueRef.current = newQueue;
     currentIndexRef.current = newIndex;

     // 大队列走窗口更新，小队列全量
     if (newQueue.length > WINDOW_SIZE * 2 && newIndex >= 0) {
       const winStart = Math.max(0, newIndex - KEEP_BEHIND);
       const winEnd = Math.min(winStart + WINDOW_SIZE, newQueue.length);
       windowStartRef.current = winStart;
       setState(s => ({
         ...s,
         queue: newQueue.slice(winStart, winEnd),
         windowStart: winStart,
         totalCount: newQueue.length,
         currentIndex: newIndex,
         currentTrack: newQueue[newIndex] || null,
       }));
     } else {
       windowStartRef.current = 0;
       setState(s => ({
         ...s,
         queue: newQueue,
         windowStart: 0,
         totalCount: newQueue.length,
         currentIndex: newIndex,
         currentTrack: newIndex >= 0 ? newQueue[newIndex] : null,
       }));
     }
     // 如果移除了当前歌曲且还有剩余，播放新位置
     if (index === currentIndexRef.current && newIndex >= 0 && audioRef.current) {
       playListAt(newQueue, newIndex);
     }
   }, [playListAt]);

  // ===== 清空队列 =====
   const clearQueue = useCallback(() => {
     if (audioRef.current) {
       audioRef.current.pause();
     }
     queueRef.current = [];
     fullQueueRef.current = [];
     windowStartRef.current = 0;
     currentIndexRef.current = -1;
     setState(s => ({
       ...s,
       queue: [],
       windowStart: 0,
       totalCount: 0,
       currentIndex: -1,
       currentTrack: null,
       isPlaying: false,
       lyric: [],
       currentLyricIndex: -1,
     }));
  }, []);

  // ===== 播放指定索引（基于当前队列）=====
  const playTrack = useCallback((index: number) => {
    const tracks = queueRef.current;
    if (index < 0 || index >= tracks.length) return;
    playListAt(tracks, index);
  }, [playListAt]);

  // ===== 按 ID 播放 =====
  const playTrackById = useCallback((id: string) => {
    const idx = queueRef.current.findIndex(t => t.id === id);
    if (idx >= 0) {
      playTrack(idx);
    }
  }, [playTrack]);

  // ===== 播放/暂停 =====
  const togglePlay = useCallback(() => {
    if (!audioRef.current) return;
    ensureAudioContext();

    if (currentIndexRef.current === -1 || !queueRef.current[currentIndexRef.current]) {
      return;
    }

    // 如果 src 还没设置，先加载
    if (!audioRef.current.src) {
      playListAt(queueRef.current, currentIndexRef.current);
      return;
    }

    if (audioRef.current.paused) {
      audioRef.current.play().catch(e => {
        logger.error('Play failed:', String(e));
        toast.error('无法播放，请检查音频');
      });
    } else {
      audioRef.current.pause();
    }
  }, [ensureAudioContext, playListAt]);

  // ===== 下一首 =====
  const getNextTrack = useCallback((): ITrack | null => {
    const tracks = queueRef.current;
    const currentIdx = currentIndexRef.current;
    const mode = playModeRef.current;
    if (tracks.length === 0 || currentIdx < 0) return null;
    let nextIdx: number;
     if (mode === 'loop') {
       nextIdx = currentIdx;
     } else if (mode === 'shuffle') {
      if (tracks.length <= 1) return null;
      // 随机选一首不同于当前的（非真随机队列，简单给一个预览）
      let r = currentIdx;
      while (r === currentIdx) {
        r = Math.floor(Math.random() * tracks.length);
      }
      nextIdx = r;
    } else {
      nextIdx = currentIdx + 1;
      if (nextIdx >= tracks.length) {
        // shuffle 模式最后一首仍有下一首（随机选）
        if (mode === 'sequence') return null;
        nextIdx = 0;
      }
    }
     return tracks[nextIdx] ?? null;
   }, []);

  const nextTrack = useCallback(() => {
    nextTrackInternal();
  }, [nextTrackInternal]);

  // ===== 上一首 =====
  const prevTrack = useCallback(() => {
    const tracks = queueRef.current;
    if (!audioRef.current) return;
    // 超过 3 秒重播当前
    if (audioRef.current.currentTime > 3) {
      audioRef.current.currentTime = 0;
      return;
    }
    if (tracks.length === 0) return;

    let prevIdx: number;
    if (playModeRef.current === 'shuffle') {
      if (tracks.length === 1) {
        prevIdx = 0;
      } else {
        do {
          prevIdx = Math.floor(Math.random() * tracks.length);
        } while (prevIdx === currentIndexRef.current);
      }
    } else {
       prevIdx = currentIndexRef.current - 1;
       if (prevIdx < 0) {
         prevIdx = tracks.length - 1;
       }
     }
     // 大队列：上一首越过窗口起点时向回滑动窗口
     if (tracks.length > WINDOW_SIZE * 2 && prevIdx < windowStartRef.current + KEEP_BEHIND && prevIdx >= 0) {
       syncWindowState(prevIdx);
     }
     playListAt(tracks, prevIdx);
   }, [playListAt, syncWindowState]);

  // ===== seek =====
  const seek = useCallback((time: number) => {
    if (!audioRef.current) return;
    const audio = audioRef.current;
    const safeTime = Math.max(0, time);
    if (audio.readyState >= 1) {
      // HAVE_METADATA 及以上可直接 seek
      try { audio.currentTime = safeTime; } catch { /* ignore */ }
    } else {
      // 元数据尚未加载，等 loadedmetadata 后再 seek
      const onLoaded = () => {
        if (audioRef.current) {
          try { audioRef.current.currentTime = safeTime; } catch { /* ignore */ }
        }
      };
      audio.addEventListener('loadedmetadata', onLoaded, { once: true });
    }
  }, []);

  // ===== 音量 =====
  const setVolume = useCallback((v: number) => {
    const safeV = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 1));
    if (audioRef.current) {
      audioRef.current.volume = safeV;
    }
    setState(s => ({ ...s, volume: safeV }));
  }, []);

  // ===== 切换播放模式 =====
  const cyclePlayMode = useCallback(() => {
    const modes: PlayMode[] = ['sequence', 'shuffle', 'loop'];
    const current = playModeRef.current;
    const idx = modes.indexOf(current);
    const next = modes[(idx + 1) % modes.length];
    playModeRef.current = next;
    const labels: Record<PlayMode, string> = {
      sequence: '顺序播放',
      shuffle: '随机播放',
      loop: '单曲循环',
    };
    toast.success(labels[next]);
    setState(s => ({ ...s, playMode: next }));
  }, []);

  const value: PlayerContextValue = {
    ...state,
    audioElement: audioRef.current,
    analyser: analyserRef.current,
    addTracks,
    replaceQueue,
    removeTrack,
    clearQueue,
    playTrack,
    playTrackById,
    playListAt,
    togglePlay,
    nextTrack,
    getNextTrack,
    prevTrack,
    seek,
    setVolume,
     cyclePlayMode,
      getFrequencyData,
      getTimeDomainData,
    };

   // ===== 播放器状态持久化 =====
   // 保存：节流写入 localStorage
   const saveTimerRef = useRef<number | null>(null);
   const savePlayerState = useCallback((immediate = false) => {
     const doSave = () => {
       try {
         const q = fullQueueRef.current || queueRef.current || [];
         if (q.length === 0 || currentIndexRef.current < 0) return;
         const saved: ISavedPlayerState = {
           queue: q.map(t => ({
             id: t.id,
             name: t.name,
             artist: t.artist,
             album: t.album,
             coverUrl: t.coverUrl,
             duration: t.duration,
             source: t.source,
             neteaseId: t.neteaseId,
             isVip: t.isVip,
             fee: t.fee,
           })),
           currentIndex: currentIndexRef.current,
           currentTime: state.currentTime,
           playMode: playModeRef.current,
           volume: state.volume,
           isPlaying: state.isPlaying,
         };
         scopedStorage.setItem(PLAYER_STORAGE_KEY, JSON.stringify(saved));
       } catch (e) {
         logger.warn('Save player state failed:', String(e));
       }
     };
     if (immediate) {
       if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
       doSave();
     } else {
       if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
       saveTimerRef.current = window.setTimeout(doSave, 1000);
     }
   }, [state.currentTime, state.volume, state.isPlaying]);

   // 恢复：初始化时读取（audio 已创建但还没 src 时执行）
   const restoredRef = useRef(false);
   useEffect(() => {
     if (restoredRef.current) return;
     if (!audioRef.current) return;
     try {
       const raw = scopedStorage.getItem(PLAYER_STORAGE_KEY);
       if (!raw) return;
       const saved = JSON.parse(raw) as ISavedPlayerState;
       if (!saved || !saved.queue || saved.queue.length === 0) return;
       if (saved.currentIndex < 0 || saved.currentIndex >= saved.queue.length) return;

       restoredRef.current = true;

       // 恢复音量 & 播放模式
       if (typeof saved.volume === 'number') {
         audioRef.current.volume = saved.volume;
       }
       if (saved.playMode) {
         playModeRef.current = saved.playMode;
       }

       // 恢复队列（元数据）与当前曲目索引
       const tracks: ITrack[] = saved.queue.map(t => ({
         ...t,
         url: '', // url 不持久化，播放时重新获取
       }));
       fullQueueRef.current = tracks;
       queueRef.current = tracks;
       currentIndexRef.current = saved.currentIndex;

       // 加载当前曲目（仅网易云能自动恢复 url，本地文件无 file 对象无法直接播放）
       const track = tracks[saved.currentIndex];
       const restoreTime = Math.max(0, saved.currentTime || 0);

       // 先设置 UI 状态
       const useWindow = tracks.length > WINDOW_SIZE * 2;
       if (useWindow) {
         syncWindowState(saved.currentIndex);
         setState(s => ({
           ...s,
           totalCount: tracks.length,
           currentIndex: saved.currentIndex,
           currentTrack: track,
           playMode: saved.playMode,
           volume: saved.volume,
           currentTime: restoreTime,
           duration: track.duration || 0,
           isLoading: true,
           isPlaying: false, // 恢复时默认暂停，避免自动播放被拦截
         }));
       } else {
         windowStartRef.current = 0;
         setState(s => ({
           ...s,
           queue: tracks,
           windowStart: 0,
           totalCount: tracks.length,
           currentIndex: saved.currentIndex,
           currentTrack: track,
           playMode: saved.playMode,
           volume: saved.volume,
           currentTime: restoreTime,
           duration: track.duration || 0,
           isLoading: true,
           isPlaying: false,
         }));
       }

       // 异步加载播放地址并 seek
       (async () => {
         if (!audioRef.current) return;
         try {
           let url = '';
           if (track.source === 'netease' && track.neteaseId) {
             url = await getSongUrl(track.neteaseId);
           } else if (track.source === 'local') {
             // 本地文件无法恢复 file 对象，标记加载完成但不播放
             setState(s => ({ ...s, isLoading: false }));
             return;
           }
            if (!url) {
              setState(s => ({ ...s, isLoading: false }));
              return;
            }
            // 切歌重置 BPM 检测
            try {
              resetBeatDetection();
            } catch { /* ignore */ }
            audioRef.current.src = url;
           audioRef.current.load();

           // loadedmetadata 后 seek
           const onLoadedMeta = () => {
             if (!audioRef.current) return;
             try { audioRef.current.currentTime = restoreTime; } catch { /* ignore */ }
             setState(s => ({
               ...s,
               duration: audioRef.current?.duration || track.duration || 0,
               isLoading: false,
             }));
           };
           audioRef.current.addEventListener('loadedmetadata', onLoadedMeta, { once: true });

           // 加载歌词
           if (track.source === 'netease' && track.neteaseId) {
              getLyric(track.neteaseId).then(lines => {
                lyricRef.current = lines;
                setState(s => ({ ...s, lyric: lines }));
             }).catch(() => { /* ignore */ });
           }
         } catch (e) {
           logger.warn('Restore player state failed:', String(e));
           setState(s => ({ ...s, isLoading: false }));
         }
       })();
     } catch (e) {
       logger.warn('Parse saved player state failed:', String(e));
       restoredRef.current = true;
     }
      
   }, []);

   // 触发保存的时机：进度变化（节流）、切歌、播放/暂停、音量、队列变更、播放模式
   // 用多个 useEffect 分别监听不同的源，统一调 savePlayerState
   useEffect(() => {
     if (!restoredRef.current) return; // 恢复中不保存
     if (currentIndexRef.current < 0) return;
     savePlayerState();
      
   }, [state.currentTime, state.isPlaying, state.volume, state.playMode, state.currentTrack?.id]);

   // 页面隐藏/卸载时立即保存
   useEffect(() => {
     const onHide = () => savePlayerState(true);
     window.addEventListener('pagehide', onHide);
     window.addEventListener('beforeunload', onHide);
     const onVisChange = () => {
       if (document.visibilityState === 'hidden') savePlayerState(true);
     };
     document.addEventListener('visibilitychange', onVisChange);
     return () => {
       window.removeEventListener('pagehide', onHide);
       window.removeEventListener('beforeunload', onHide);
       document.removeEventListener('visibilitychange', onVisChange);
     };
      
   }, []);

   return (
     <PlayerContext.Provider value={value}>
      {children}
    </PlayerContext.Provider>
  );
}
