import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PlayerProvider, usePlayer } from '@/contexts/PlayerContext';
import { ListenTogetherProvider } from '@/contexts/ListenTogetherContext';
import PlayerMain from '@/components/PlayerMain';
import DanmakuOverlay from '@/components/listenTogether/DanmakuOverlay';
import { useListenTogether } from '@/contexts/ListenTogetherContext';
import { toast } from 'sonner';
import { logger } from '@lark-apaas/client-toolkit-lite';
import { usePersistentState } from '@/hooks/usePersistentState';
import { DEFAULT_VISUAL, DEFAULT_LYRIC } from '@/lib/defaultSettings';
import type { IVisualizerSettings, ILyricSettings } from '@/types';
import { Mp4Recorder, probeRecorderSupport, type Mp4RecorderStats } from '@/lib/mp4-recorder';

const DEFAULT_VISUAL_SETTINGS: IVisualizerSettings = DEFAULT_VISUAL;
const DEFAULT_LYRIC_SETTINGS: ILyricSettings = DEFAULT_LYRIC;

  function PlayerApp() {
    const [searchParams] = useSearchParams();
    // 同时解析 URL search 和 hash 中的 mode 参数（兼容 HashRouter 和直链）
    const getUrlParam = (name: string): string | null => {
      // 1. 优先从 react-router 的 searchParams 读（BrowserRouter 或 HashRouter 带 ?query）
      const fromSearch = searchParams.get(name);
      if (fromSearch) return fromSearch;
      // 2. HashRouter 下 search 可能在 hash 里，例如 #/?mode=sonic
      try {
        const hash = window.location.hash || '';
        const qIdx = hash.indexOf('?');
        if (qIdx >= 0) {
          const params = new URLSearchParams(hash.slice(qIdx + 1));
          const fromHash = params.get(name);
          if (fromHash) return fromHash;
        }
      } catch { /* ignore */ }
      // 3. 兜底：从 window.location.search 读
      try {
        const fromWin = new URLSearchParams(window.location.search).get(name);
        if (fromWin) return fromWin;
      } catch { /* ignore */ }
      return null;
    };
    const urlMode = getUrlParam('mode');
    const urlNoAnnounce = getUrlParam('announce') === '0';
   // URL mode 参数优先（用于调试与分享链接），覆盖 localStorage 中的 mode
   const initialSettings = urlMode && ['cover2d','galaxy3d','sphere3d','ring3d','cover3d'].includes(urlMode)
     ? { ...DEFAULT_VISUAL_SETTINGS, mode: urlMode as IVisualizerSettings['mode'] }
     : DEFAULT_VISUAL_SETTINGS;
   const [settings, setSettings] = usePersistentState<IVisualizerSettings>(
     'audioviz_settings',
     initialSettings,
     300,
   );
   const [lyricSettings, setLyricSettings] = usePersistentState<ILyricSettings>(
     'audioviz_lyric',
     DEFAULT_LYRIC_SETTINGS,
     300,
   );
   // P0 兜底：任何场景下 settings/lyricSettings 都不应为 null，读取时统一合并默认值
    const safeSettings = { ...DEFAULT_VISUAL_SETTINGS, ...(settings || {}) };
    const safeLyricSettings = { ...DEFAULT_LYRIC_SETTINGS, ...(lyricSettings || {}) };

    // URL mode 参数强制覆盖（用于调试与分享），优先级高于 localStorage
    useEffect(() => {
      if (!urlMode) return;
      const validModes: IVisualizerSettings['mode'][] = ['cover2d','galaxy3d','sphere3d','ring3d','cover3d','bars','particles','circular','wave','customBg'];
      if (validModes.includes(urlMode as any) && safeSettings.mode !== urlMode) {
        logger.info(`[PlayerPage] URL mode override: ${safeSettings.mode} -> ${urlMode}`);
        setSettings(s => ({ ...s, mode: urlMode as IVisualizerSettings['mode'] }));
      }
    }, [urlMode, safeSettings.mode, setSettings]);
    const {
      mode, primaryColor, secondaryColor, sensitivity, targetFps, quality,
      vizScale, vizOffsetX, vizOffsetY, coverParticleCount,
       coverBrightness, coverParticleSize, coverDensity, coverOpacity,
         coverTwist, coverScatter, coverSpeed, coverColorBoost, coverEdgeEnabled,
         coverPreset, coverIntensity, coverDepth, coverBloomStrength, coverStarRiver, coverBgFade,
          cover2dScale, cover2dGlow, coverBeatSensitivity,
         bgImageUrl, bgImageType,
     } = safeSettings;

   const setMode = (m: IVisualizerSettings['mode']) => setSettings(s => ({ ...s, mode: m }));
   const setPrimaryColor = (c: string) => setSettings(s => ({ ...s, primaryColor: c }));
   const setSecondaryColor = (c: string) => setSettings(s => ({ ...s, secondaryColor: c }));
   const setSensitivity = (n: number) => setSettings(s => ({ ...s, sensitivity: n }));
   const setTargetFps = (n: number) => setSettings(s => ({ ...s, targetFps: n }));
   const setQuality = (q: IVisualizerSettings['quality']) => setSettings(s => ({ ...s, quality: q }));
   const setVizScale = (n: number) => setSettings(s => ({ ...s, vizScale: n }));
   const setVizOffsetX = (n: number) => setSettings(s => ({ ...s, vizOffsetX: n }));
   const setVizOffsetY = (n: number) => setSettings(s => ({ ...s, vizOffsetY: n }));
   const setCoverParticleCount = (n: number) => setSettings(s => ({ ...s, coverParticleCount: n }));
   const setCoverBrightness = (n: number) => setSettings(s => ({ ...s, coverBrightness: n }));
   const setCoverParticleSize = (n: number) => setSettings(s => ({ ...s, coverParticleSize: n }));
   const setCoverDensity = (n: number) => setSettings(s => ({ ...s, coverDensity: n }));
   const setCoverOpacity = (n: number) => setSettings(s => ({ ...s, coverOpacity: n }));
     const setCoverTwist = (n: number) => setSettings(s => ({ ...s, coverTwist: n }));
    const setCoverScatter = (n: number) => setSettings(s => ({ ...s, coverScatter: n }));
    const setCoverSpeed = (n: number) => setSettings(s => ({ ...s, coverSpeed: n }));
    const setCoverColorBoost = (n: number) => setSettings(s => ({ ...s, coverColorBoost: n }));
     const setCoverEdgeEnabled = (v: boolean) => setSettings(s => ({ ...s, coverEdgeEnabled: v }));
     const setCoverPreset = (n: number) => setSettings(s => ({ ...s, coverPreset: n }));
     const setCoverIntensity = (n: number) => setSettings(s => ({ ...s, coverIntensity: n }));
     const setCoverDepth = (n: number) => setSettings(s => ({ ...s, coverDepth: n }));
     const setCoverBloomStrength = (n: number) => setSettings(s => ({ ...s, coverBloomStrength: n }));
     const setCoverStarRiver = (v: boolean) => setSettings(s => ({ ...s, coverStarRiver: v }));
     const setCoverBgFade = (n: number) => setSettings(s => ({ ...s, coverBgFade: n }));
     const setCover2dScale = (n: number) => setSettings(s => ({ ...s, cover2dScale: n }));
     const setCover2dGlow = (n: number) => setSettings(s => ({ ...s, cover2dGlow: n }));
      const setCoverBeatSensitivity = (n: number) => setSettings(s => ({ ...s, coverBeatSensitivity: n }));
      const setBgImageUrl = (url: string) => setSettings(s => ({ ...s, bgImageUrl: url }));
     const setBgImageType = (t: 'image' | 'video') => setSettings(s => ({ ...s, bgImageType: t }));

  // 全局恢复默认设置
  const resetAllSettings = () => {
    setSettings(DEFAULT_VISUAL);
    setLyricSettings(DEFAULT_LYRIC);
    toast.success('已恢复默认设置');
  };

    const [isRecording, setIsRecording] = useState(false);
    const [recordTime, setRecordTime] = useState(0);
    const [isStoppingRecord, setIsStoppingRecord] = useState(false);
    const [openTour, setOpenTour] = useState(false);

    // 打开新手教程（设置面板入口）
    const handleOpenTour = useCallback(() => {
      setOpenTour(true);
    }, []);
    const handleCloseTour = useCallback(() => {
      setOpenTour(false);
    }, []);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mp4RecorderRef = useRef<Mp4Recorder | null>(null);
  const recordModeRef = useRef<'webcodecs' | 'mediarecorder' | 'webm'>('webm');
  const recordChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<number | null>(null);
  const recordRafRef = useRef<number>(0);
  const startingRef = useRef(false);
  const stoppingLockRef = useRef(false);     // 防重入锁：stopRecording 正在进行中
  const userStopPendingRef = useRef(false);  // 用户主动停止标记：为 true 时 onstop/finalize 才允许触发下载
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { audioElement } = usePlayer();

  // 找到 canvas 元素（通过 document 查询，优先 WebGL canvas）
  const getCanvas = useCallback((): HTMLCanvasElement | null => {
    // 优先找 WebGL canvas（3D 模式）
    const allCanvases = document.querySelectorAll('canvas');
    let glCanvas: HTMLCanvasElement | null = null;
    let canvas2d: HTMLCanvasElement | null = null;
    allCanvases.forEach(c => {
      const gl = c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl');
      if (gl) glCanvas = c;
      else canvas2d = c;
    });
    // 3D 模式优先用 WebGL，2D 模式用 2D canvas
    const is3D = mode === 'galaxy3d' || mode === 'sphere3d' || mode === 'ring3d' || mode === 'cover3d';
    if (is3D && glCanvas) return glCanvas;
    return glCanvas || canvas2d || null;
  }, [mode]);

  const downloadRecording = useCallback((blob: Blob, ext: string, actualType: string) => {
    if (!blob || blob.size === 0) {
      toast.error('录制文件为空，未生成下载');
      return;
    }
    const url = URL.createObjectURL(blob);
    const now = new Date();
    const timestamp = `${now.getFullYear()}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}_${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}`;
    const filename = `M V Player_录制_${timestamp}.${ext}`;
    const sizeMB = (blob.size / 1024 / 1024).toFixed(2);

    // 方式一：直接触发下载
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    // 延迟清理
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);

    // 方式二：同时弹 toast 带下载按钮，用户也能点这里下载（双重保障）
    if (ext === 'mp4') {
      toast.success(`录制完成（${sizeMB} MB）`, {
        description: `文件：${filename}`,
        action: {
          label: '重新下载',
          onClick: () => {
            const a2 = document.createElement('a');
            a2.href = url;
            a2.download = filename;
            document.body.appendChild(a2);
            a2.click();
            setTimeout(() => document.body.removeChild(a2), 1000);
          },
        },
        duration: 8000,
      });
    } else {
      toast.info(`录制完成（${sizeMB} MB，.${ext} 格式）`, {
        description: `当前浏览器导出为 ${ext} 格式`,
        action: {
          label: '下载',
          onClick: () => {
            const a2 = document.createElement('a');
            a2.href = url;
            a2.download = filename;
            document.body.appendChild(a2);
            a2.click();
            setTimeout(() => document.body.removeChild(a2), 1000);
          },
        },
        duration: 8000,
      });
    }
  }, []);

  const onToggleRecord = useCallback(async () => {
    if (startingRef.current || stoppingLockRef.current) return;
    if (isRecording) {
      stopRecording();
      return;
    }

    const canvas = getCanvas();
    if (!canvas) {
      toast.error('未找到可视化画布');
      return;
    }

    startingRef.current = true;

    try {
      const support = await probeRecorderSupport();
      const fps = targetFps || 30;

      // 获取音频轨
      let audioTrack: MediaStreamTrack | null = null;
      if (audioElement) {
        try {
          const audioStream = (audioElement as any).captureStream();
          const tracks = audioStream.getAudioTracks();
          if (tracks.length > 0) audioTrack = tracks[0];
        } catch { /* 忽略 */ }
      }

      if (!audioTrack) {
        toast.info('提示：跨域音频可能无法包含在录制中，仅录制画面');
      }

      // 方案选择：
      // 1) WebCodecs VideoEncoder avc1 → 手写 mp4 muxer（主方案，不依赖 MediaRecorder mp4 支持）
      // 2) MediaRecorder + video/mp4
      // 3) MediaRecorder + webm（兜底）
      let started = false;

      if (support.videoAvc1) {
        // ===== 方案一：WebCodecs MP4 =====
        try {
          recordModeRef.current = 'webcodecs';
          const recorder = new Mp4Recorder({
            canvas,
            audioTrack: audioTrack ?? undefined,
            fps,
            videoBitrate: 2_500_000,
            audioBitrate: 128_000,
          });
          await recorder.start();
          mp4RecorderRef.current = recorder;

          // 自动抓帧 loop（与可视化 rAF 并行）
          let lastFrameTime = performance.now();
          const frameInterval = 1000 / fps;
          const startTime = performance.now();

          const frameLoop = (now: number) => {
            if (recordModeRef.current !== 'webcodecs' || !mp4RecorderRef.current) return;
            if (now - lastFrameTime >= frameInterval) {
              mp4RecorderRef.current.recordFrame((now - startTime) * 1000);
              lastFrameTime = now;
            }
            recordRafRef.current = requestAnimationFrame(frameLoop);
          };
          recordRafRef.current = requestAnimationFrame(frameLoop);

          setIsRecording(true);
          setRecordTime(0);
          recordTimerRef.current = window.setInterval(() => {
            setRecordTime(t => t + 1);
          }, 1000);
          toast.success('开始录制（MP4）');
          started = true;
        } catch (webcodecsErr) {
          logger.warn('WebCodecs 录制启动失败，回退 MediaRecorder:', String(webcodecsErr));
          // 清理 WebCodecs 半成品
          if (recordRafRef.current) {
            cancelAnimationFrame(recordRafRef.current);
            recordRafRef.current = 0;
          }
          mp4RecorderRef.current = null;
          recordModeRef.current = 'webm';
        }
      }

      // ===== 方案二/三：MediaRecorder（WebCodecs 失败或不支持时走这里）=====
      if (!started) {
        const streams: MediaStream[] = [];
        const canvasStream = (canvas as any).captureStream(fps);
        streams.push(canvasStream);

        if (audioTrack) {
          const s = new MediaStream([audioTrack]);
          streams.push(s);
        }

        const combined = new MediaStream();
        for (const s of streams) {
          for (const track of s.getTracks()) {
            combined.addTrack(track);
          }
        }

        const mimeCandidates = [
          'video/mp4;codecs=avc1.4D401E,mp4a.40.2',
          'video/mp4;codecs=avc1,mp4a.40.2',
          'video/mp4;codecs=avc1',
          'video/mp4',
          'video/webm;codecs=vp9,opus',
          'video/webm;codecs=vp8,opus',
          'video/webm',
        ];
        let selectedMime = '';
        for (const m of mimeCandidates) {
          try {
            if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) {
              selectedMime = m;
              break;
            }
          } catch { /* 忽略 */ }
        }

        const isMp4 = selectedMime.toLowerCase().includes('mp4');
        recordModeRef.current = isMp4 ? 'mediarecorder' : 'webm';

        const recorderOptions: MediaRecorderOptions = {
          videoBitsPerSecond: 2_500_000,
        };
        if (selectedMime) recorderOptions.mimeType = selectedMime;

        const recorder = new MediaRecorder(combined, recorderOptions);
        recordChunksRef.current = [];
        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) recordChunksRef.current.push(e.data);
        };
        recorder.onstop = () => {
          // 仅用户主动停止时才触发保存（防止 start 异常 / 浏览器自动停止等场景提前下载）
          if (!userStopPendingRef.current) return;
          try {
            const actualType = recorder.mimeType || selectedMime || '';
            let ext = 'webm';
            if (actualType.toLowerCase().includes('mp4')) ext = 'mp4';
            const blobType = actualType || `video/${ext}`;
            const blob = new Blob(recordChunksRef.current, { type: blobType });
            if (blob.size > 0) {
              downloadRecording(blob, ext, actualType);
            } else {
              toast.error('录制文件为空，未生成下载');
            }
          } catch (e) {
            logger.error('Recording onstop save failed:', String(e));
            toast.error('录制保存失败：' + (e as Error).message);
          } finally {
            userStopPendingRef.current = false;
            stoppingLockRef.current = false;
          }
        };

        recorder.start(1000);
        mediaRecorderRef.current = recorder;

        setRecordTime(0);
        recordTimerRef.current = window.setInterval(() => setRecordTime(t => t + 1), 1000);
        setIsRecording(true);
        toast.success(isMp4 ? '开始录制（MP4）' : '开始录制');
        started = true;
      }
    } catch (e) {
      logger.error('Recording start failed:', String(e));
      toast.error('录制失败：' + (e as Error).message);
      // 失败时确保状态清零
      setIsRecording(false);
      recordModeRef.current = 'webm';
    } finally {
      startingRef.current = false;
    }
  }, [isRecording, getCanvas, audioElement, mode, targetFps, downloadRecording]);

  const stopRecording = useCallback(async () => {
    if (stoppingLockRef.current) return;
    stoppingLockRef.current = true;
    userStopPendingRef.current = true;  // 标记为用户主动停止，允许 onstop/finalize 触发下载
    setIsStoppingRecord(true);
    toast.loading('正在生成视频文件…', { id: 'record-stop' });

    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }

    const mode = recordModeRef.current;

    if (mode === 'webcodecs' && mp4RecorderRef.current) {
      if (recordRafRef.current) {
        cancelAnimationFrame(recordRafRef.current);
        recordRafRef.current = 0;
      }
      const recorder = mp4RecorderRef.current;
      mp4RecorderRef.current = null;
      recordModeRef.current = 'webm';
      setIsRecording(false);

      try {
        const { blob, stats } = await recorder.stop();
        logger.info(`MP4 录制完成: ${stats.videoFrames} 帧, ${stats.audioFrames} 音频帧, ${(stats.totalBytes / 1024 / 1024).toFixed(2)}MB`);
        toast.dismiss('record-stop');
        if (userStopPendingRef.current && blob.size > 0) {
          downloadRecording(blob, 'mp4', 'video/mp4 (WebCodecs H.264+AAC)');
        } else if (blob.size === 0) {
          toast.error('录制文件为空，未生成视频');
        }
      } catch (e) {
        logger.error('MP4 录制停止失败:', String(e));
        toast.dismiss('record-stop');
        toast.error('录制保存失败：' + (e as Error).message);
      } finally {
        userStopPendingRef.current = false;
        stoppingLockRef.current = false;
        setIsStoppingRecord(false);
      }
      return;
    }

    // MediaRecorder 方案
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        // 给 onstop 回调加超时保护：8 秒还没触发 onstop 就强制复位
        const timeoutId = window.setTimeout(() => {
          if (stoppingLockRef.current) {
            logger.warn('MediaRecorder onstop 超时，强制复位');
            toast.dismiss('record-stop');
            toast.error('录制结束超时，请检查浏览器权限');
            userStopPendingRef.current = false;
            stoppingLockRef.current = false;
            setIsStoppingRecord(false);
            setIsRecording(false);
            recordModeRef.current = 'webm';
          }
        }, 8000);

        const originalOnStop = mediaRecorderRef.current.onstop;
        mediaRecorderRef.current.onstop = function (ev: Event) {
          window.clearTimeout(timeoutId);
          toast.dismiss('record-stop');
          setIsStoppingRecord(false);
          if (originalOnStop) (originalOnStop as (ev: Event) => void).call(mediaRecorderRef.current, ev);
        };

        mediaRecorderRef.current.stop();
      } catch (e) {
        logger.error('MediaRecorder stop failed:', String(e));
        toast.dismiss('record-stop');
        toast.error('录制停止失败：' + (e as Error).message);
        // stop 抛错时直接复位，避免卡在录制中
        userStopPendingRef.current = false;
        stoppingLockRef.current = false;
        setIsStoppingRecord(false);
      }
    } else {
      // 没有活动的 recorder，直接复位
      toast.dismiss('record-stop');
      userStopPendingRef.current = false;
      stoppingLockRef.current = false;
      setIsStoppingRecord(false);
    }
    recordModeRef.current = 'webm';
    setIsRecording(false);
  }, [downloadRecording]);

  // 组件卸载时清理录制资源（强制释放，不受 stoppingLock 影响）
  useEffect(() => {
    return () => {
      // 定时器直接清
      if (recordTimerRef.current) {
        clearInterval(recordTimerRef.current);
        recordTimerRef.current = null;
      }
      // 抓帧 RAF 直接取消
      if (recordRafRef.current) {
        cancelAnimationFrame(recordRafRef.current);
        recordRafRef.current = 0;
      }
      // MediaRecorder 尝试停止
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try { mediaRecorderRef.current.stop(); } catch { /* ignore */ }
      }
      // WebCodecs recorder 尝试停止（不 await，卸载时不关心结果）
      if (mp4RecorderRef.current) {
        try { mp4RecorderRef.current.stop().catch(() => {}); } catch { /* ignore */ }
        mp4RecorderRef.current = null;
      }
    };
  }, []);

  // ====== 封面模式端到端验证（URL 参数 ?coverdemo=1 时触发） ======
  const { addTracks, playTrack } = usePlayer();
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('coverdemo') !== '1') return;

    const demoTrack: import('@/types').ITrack = {
      id: 'cover-demo-1',
      name: '封面模式测试曲',
      artist: 'Adele',
      album: '25',
      coverUrl: 'https://p3.music.126.net/7mQyb-YnNd6CqCjQq4ryjQ==/109951168981824640.jpg',
      duration: 0,
      source: 'netease',
      neteaseId: 0,
      url: '',
    };

    addTracks([demoTrack], true);
    // 只有 URL 没指定 mode 时，才自动切到封面 3D 作为默认展示模式
    // URL 指定了 mode（如 ?mode=sonic）时保持用户选择，不强制覆盖
    if (!urlMode) {
      const t = window.setTimeout(() => {
        setMode('cover3d');
      }, 100);
      return () => clearTimeout(t);
    }
    return undefined;
   
  }, []);

  return (
    <div className="w-full h-[100dvh] bg-[#050a14]">
      <PlayerMain
        mode={mode}
        setMode={setMode}
        primaryColor={primaryColor}
        setPrimaryColor={setPrimaryColor}
        secondaryColor={secondaryColor}
        setSecondaryColor={setSecondaryColor}
        sensitivity={sensitivity}
        setSensitivity={setSensitivity}
        targetFps={targetFps}
        setTargetFps={setTargetFps}
        quality={quality}
        setQuality={setQuality}
        vizScale={vizScale}
        setVizScale={setVizScale}
        vizOffsetX={vizOffsetX}
        setVizOffsetX={setVizOffsetX}
         vizOffsetY={vizOffsetY}
         setVizOffsetY={setVizOffsetY}
         coverParticleCount={coverParticleCount}
         setCoverParticleCount={setCoverParticleCount}
         coverBrightness={coverBrightness}
         setCoverBrightness={setCoverBrightness}
         coverParticleSize={coverParticleSize}
         setCoverParticleSize={setCoverParticleSize}
         coverDensity={coverDensity}
         setCoverDensity={setCoverDensity}
         coverOpacity={coverOpacity}
         setCoverOpacity={setCoverOpacity}
         coverTwist={coverTwist}
         setCoverTwist={setCoverTwist}
         coverScatter={coverScatter}
         setCoverScatter={setCoverScatter}
         coverSpeed={coverSpeed}
         setCoverSpeed={setCoverSpeed}
         coverColorBoost={coverColorBoost}
         setCoverColorBoost={setCoverColorBoost}
           coverEdgeEnabled={coverEdgeEnabled}
           setCoverEdgeEnabled={setCoverEdgeEnabled}
           coverPreset={coverPreset}
           setCoverPreset={setCoverPreset}
           coverIntensity={coverIntensity}
           setCoverIntensity={setCoverIntensity}
           coverDepth={coverDepth}
           setCoverDepth={setCoverDepth}
           coverBloomStrength={coverBloomStrength}
           setCoverBloomStrength={setCoverBloomStrength}
           coverStarRiver={coverStarRiver}
           setCoverStarRiver={setCoverStarRiver}
           coverBgFade={coverBgFade}
           setCoverBgFade={setCoverBgFade}
           cover2dScale={cover2dScale}
          setCover2dScale={setCover2dScale}
           cover2dGlow={cover2dGlow}
           setCover2dGlow={setCover2dGlow}
            coverBeatSensitivity={coverBeatSensitivity}
            setCoverBeatSensitivity={setCoverBeatSensitivity}
           bgImageUrl={bgImageUrl}
          bgImageType={bgImageType}
          setBgImageUrl={setBgImageUrl}
          setBgImageType={setBgImageType}
         lyricSettings={safeLyricSettings}
         setLyricSettings={setLyricSettings}
         onResetAll={resetAllSettings}
         isRecording={isRecording}
         onToggleRecord={onToggleRecord}
         recordTime={recordTime}
         isStoppingRecord={isStoppingRecord}
         openTour={openTour}
         onOpenTour={handleOpenTour}
         onCloseTour={handleCloseTour}
        />
      <DanmakuOverlayProvider />
    </div>
  );
}

// 弹幕覆盖层（需要在 ListenTogetherProvider 内）
function DanmakuOverlayProvider() {
  const { inRoom } = useListenTogether();
  const containerRef = useRef<HTMLDivElement>(null);

  if (!inRoom) return null;
  
  return (
    <div
      ref={containerRef}
      className="pointer-events-none fixed inset-0 z-20"
      style={{ bottom: '120px' }} // 避开底部控制栏
    >
      <DanmakuOverlay enabled={inRoom} containerRef={containerRef} />
    </div>
  );
}

export default function PlayerPage() {
  return (
    <PlayerProvider>
      <ListenTogetherProvider>
        <PlayerApp />
      </ListenTogetherProvider>
    </PlayerProvider>
  );
}
