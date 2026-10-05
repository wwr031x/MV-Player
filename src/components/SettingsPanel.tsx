import React, { useState, useEffect, useRef, useCallback } from 'react';
import { RotateCcw, Monitor, Sparkles, Activity, Globe, Orbit, Waves, ImageIcon, AlertTriangle, HelpCircle, BarChart3, Disc, Upload, Wrench } from 'lucide-react';
import SectionErrorBoundary from '@/components/SectionErrorBoundary';
import { toast } from 'sonner';
import { Slider } from '@/components/ui/slider';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import type { IVisualizerSettings, ILyricSettings } from '@/types';
import { VISUAL_PARAMS, LYRIC_PARAMS, DEFAULT_VISUAL, DEFAULT_LYRIC } from '@/lib/defaultSettings';

import { Image } from '@/components/ui/image';

type VisualizerMode = IVisualizerSettings['mode'];

interface SettingsPanelProps {
  mode: VisualizerMode;
  setMode: (m: VisualizerMode) => void;
  primaryColor: string;
  setPrimaryColor: (c: string) => void;
  secondaryColor: string;
  setSecondaryColor: (c: string) => void;
  sensitivity: number;
  setSensitivity: (n: number) => void;
  isRecording: boolean;
  onToggleRecord: () => void;
  recordTime: number;
  targetFps: number;
  setTargetFps: (n: number) => void;
  quality: IVisualizerSettings['quality'];
  setQuality: (q: IVisualizerSettings['quality']) => void;
  onRequestClose?: () => void;
  vizScale: number;
  setVizScale: (n: number) => void;
  vizOffsetX: number;
  setVizOffsetX: (n: number) => void;
  vizOffsetY: number;
  setVizOffsetY: (n: number) => void;
  lyricSettings: ILyricSettings;
  setLyricSettings: (s: ILyricSettings) => void;
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
  /** 背景类型 */
  bgImageType: 'image' | 'video';
  setBgImageUrl: (url: string) => void;
  setBgImageType: (t: 'image' | 'video') => void;
  webglSupported: boolean;
  webglError: string;
  onForce3D: () => void;
  onResetAll: () => void;
  /** 工程菜单开关状态 */
  onOpenEngineering?: () => void;

  /** 打开新手教程 */
  onOpenTour?: () => void;
  /** 重置新手引导（清除所有引导标记，下次从欢迎页开始） */
  onResetTour?: () => void;
}

// ===== 选项常量 =====
const modes2D = [
  { key: 'customBg' as const, label: '自定义背景', icon: ImageIcon },
  { key: 'bars' as const, label: '频谱柱', icon: Monitor },
  { key: 'wave' as const, label: '波形曲线', icon: Waves },
  { key: 'particles' as const, label: '粒子星河', icon: Sparkles },
  { key: 'circular' as const, label: '环形频谱', icon: Activity },
];

const modes3D = () => [
  { key: 'galaxy3d' as const, label: '3D星河', icon: Globe },
  { key: 'sphere3d' as const, label: '3D粒子球', icon: Orbit },
  { key: 'ring3d' as const, label: '3D频谱环', icon: Waves },
  { key: 'cover3d' as const, label: '专辑封面', icon: ImageIcon },
];

const presetColors = [
  { primary: '#22d3ee', secondary: '#a855f7', name: '霓虹青' },
  { primary: '#f472b6', secondary: '#22d3ee', name: '霓虹粉' },
  { primary: '#facc15', secondary: '#f97316', name: '暖黄' },
  { primary: '#34d399', secondary: '#22d3ee', name: '翠绿' },
  { primary: '#f87171', secondary: '#facc15', name: '烈火' },
];

const fpsOptions = [
  { value: 30, label: '30帧' },
  { value: 45, label: '45帧' },
  { value: 60, label: '60帧' },
  { value: 0, label: '不限' },
];

const qualityOptions = [
  { value: 'low', label: '低画质' },
  { value: 'mid', label: '中画质' },
  { value: 'high', label: '高画质' },
  { value: 'native', label: '原画' },
] as const;

const formatTime = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
};

// ===== 二级导航定义 =====
const navTabs = [
  { id: 'settings-section-visual', label: '可视化' },
  { id: 'settings-section-performance', label: '性能' },
  { id: 'settings-section-display', label: '画面' },
  { id: 'settings-section-lyric', label: '歌词' },
  { id: 'settings-section-record', label: '录制' },
];

// ===== SettingSlider：带标注 + 单项重置的滑块行 =====
function SettingSlider({
  label, value, min, max, step, unit = '', defaultValue, onChange, formatValue,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  defaultValue: number;
  onChange: (v: number) => void;
  formatValue?: (v: number) => string;
}) {
  const isDefault = Math.abs(value - defaultValue) < step / 2;
  const displayValue = formatValue ? formatValue(value) : `${value}${unit}`;
  const displayDefault = formatValue ? formatValue(defaultValue) : `${defaultValue}${unit}`;
  return (
    <div className="mb-3 pr-0.5">
      <div className="flex items-center justify-between gap-2 mb-1.5 min-w-0">
        <label className="text-xs text-white/70 shrink-0 truncate">{label}</label>
        <div className="flex items-center gap-1.5 min-w-0 flex-1 justify-end">
          <span className="text-[11px] text-white/50 tabular-nums shrink-0 text-right">{displayValue}</span>
          <span className="text-[10px] text-white/35 tabular-nums whitespace-nowrap truncate min-w-0">
            {min}{unit}–{max}{unit} · 默认 {displayDefault}
          </span>
          <button
            onClick={() => onChange(defaultValue)}
            disabled={isDefault}
            className={`h-5 w-5 shrink-0 rounded-full flex items-center justify-center transition-all ${
              isDefault
                ? 'bg-transparent text-white/15 cursor-default'
                : 'bg-white/10 text-white/60 hover:bg-white/20 hover:text-white active:scale-95'
            }`}
            title="恢复默认"
            aria-label="恢复默认"
          >
            <RotateCcw className="w-3 h-3" />
          </button>
        </div>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={([v]) => onChange(v)}
      />
    </div>
  );
}

export default function SettingsPanel(props: SettingsPanelProps) {
  const {
    mode, setMode,
    primaryColor, setPrimaryColor,
    secondaryColor, setSecondaryColor,
    sensitivity, setSensitivity,
    isRecording, onToggleRecord, recordTime,
    targetFps, setTargetFps,
    quality, setQuality,
    vizScale, setVizScale,
    vizOffsetX, setVizOffsetX,
    vizOffsetY, setVizOffsetY,
    lyricSettings, setLyricSettings,
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
    webglSupported,
    webglError,
    onForce3D,
    onResetAll,

    onOpenTour,
    onResetTour,
    onOpenEngineering,
    onRequestClose,
  } = props;

  const [activeTab, setActiveTab] = useState(navTabs[0].id);
  const [isLandscape, setIsLandscape] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth > window.innerHeight : false
  );

  useEffect(() => {
    const onResize = () => {
      setIsLandscape(window.innerWidth > window.innerHeight);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // P0 兜底：lyricSettings 合并默认值，防止上游为 null 或字段缺失导致整页崩溃
  const safeLyric = { ...DEFAULT_LYRIC, ...(lyricSettings || {}) };
  const s_lyric = safeLyric;

  // P0 兜底：可视化参数内联查表 + 非空兜底，防止非法 presetId / 字段 null 导致整页崩溃
  const safeQuality = (qualityOptions.find(o => o.value === quality) || qualityOptions[1]).value as typeof qualityOptions[number]['value'];
  const safeTargetFps = typeof targetFps === 'number' && !Number.isNaN(targetFps) ? targetFps : DEFAULT_VISUAL.targetFps;
  const safeVizScale = typeof vizScale === 'number' && !Number.isNaN(vizScale) ? vizScale : DEFAULT_VISUAL.vizScale;

  // 工程菜单连击/长按隐藏入口
  const clickCountRef = useRef(0);
  const clickTimerRef = useRef<number | null>(null);
  const longPressTimerRef = useRef<number | null>(null);

  const clearClickTimer = () => {
    if (clickTimerRef.current) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
  };

  const onWebglCardClick = () => {
    clickCountRef.current += 1;
    if (clickTimerRef.current) window.clearTimeout(clickTimerRef.current);
    clickTimerRef.current = window.setTimeout(() => {
      clickCountRef.current = 0;
    }, 2000);

    if (clickCountRef.current >= 10) {
      clickCountRef.current = 0;
      clearClickTimer();
      toast.success('工程菜单入口：设置卡片连击/长按已移至全局快捷入口');
    }
  };

  const startLongPress = () => {
    if (longPressTimerRef.current) window.clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = window.setTimeout(() => {
      toast.info('工程菜单入口已迁移');
    }, 2000);
  };

  const cancelLongPress = () => {
    if (longPressTimerRef.current) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const trySet3DMode = (m: 'galaxy3d' | 'sphere3d' | 'ring3d' | 'cover3d') => {
    if (!webglSupported) {
      toast.warning('WebGL 不可用，将尝试强制启动 3D');
    }
    if (mode !== m) {
      setMode(m);
      // 切换 3D 模式后自动关闭设置面板，让用户直接看到效果
      onRequestClose?.();
    }
  };

  // 切换 2D 模式：customBg 模式保留面板以便导入素材，其他模式切换后自动关闭
  const handleSet2DMode = (m: VisualizerMode) => {
    if (mode !== m) {
      setMode(m);
      if (m !== 'customBg') {
        onRequestClose?.();
      }
    }
  };

  // 吸顶标签栏高度偏移（scroll-margin-top 预留值）
  const TABBAR_OFFSET = 64;

  // 点击标签：原生 scrollIntoView 定位
  // 真正的滚动容器是外层 ScrollArea 的 viewport（Radix ScrollArea），
  // scrollIntoView 会自动找到最近的可滚动祖先，offset 通过 CSS scroll-margin-top 实现。
  const scrollToSection = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    // 直接调用 scrollIntoView，CSS scroll-margin-top 会自动预留吸顶栏高度
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // scrollspy：监听标签点击 + 滚动时更新激活态
  // 使用 IntersectionObserver 观察每个分区是否进入视口（自动适配任意滚动容器）
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});

  useEffect(() => {
    // 收集分区元素
    const elements: Element[] = [];
    for (const tab of navTabs) {
      const el = document.getElementById(tab.id);
      if (el) {
        sectionRefs.current[tab.id] = el;
        elements.push(el);
      }
    }
    if (elements.length === 0) return;

    // 找到最近的可滚动祖先（ScrollArea viewport）
    const findScrollParent = (el: Element): Element | null => {
      let parent: Element | null = el.parentElement;
      while (parent) {
        const overflowY = window.getComputedStyle(parent).overflowY;
        if (overflowY === 'auto' || overflowY === 'scroll') return parent;
        parent = parent.parentElement;
      }
      return null;
    };
    const scrollParent = findScrollParent(elements[0]);
    if (!scrollParent) return;

    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(() => {
        ticking = false;
        const parentRect = scrollParent.getBoundingClientRect();
        let current = navTabs[0].id;
        for (const tab of navTabs) {
          const el = sectionRefs.current[tab.id];
          if (!el) continue;
          const rect = el.getBoundingClientRect();
          // 分区顶部相对滚动容器顶部的距离
          const relativeTop = rect.top - parentRect.top;
          // 当分区顶部已滚过吸顶栏下方阈值时，激活该标签
          if (relativeTop - TABBAR_OFFSET <= 0) {
            current = tab.id;
          }
        }
        setActiveTab(current);
      });
    };

    scrollParent.addEventListener('scroll', onScroll, { passive: true });
    // 初始同步
    const t = window.setTimeout(onScroll, 100);
    return () => {
      scrollParent.removeEventListener('scroll', onScroll);
      window.clearTimeout(t);
    };
  }, []);

  const vp = VISUAL_PARAMS;
  const lp = LYRIC_PARAMS;

  return (
    <div className="h-full flex flex-col">
      {/* 吸顶二级导航 */}
      <div
        className="sticky top-0 z-20 px-4 py-2 border-b border-white/10 bg-[#0a0f1a]/90 backdrop-blur-md shrink-0"
        style={{ scrollMarginTop: `${TABBAR_OFFSET}px` }}
      >
        <div className="flex items-center gap-1 overflow-x-auto scrollbar-none">
          {navTabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => scrollToSection(tab.id)}
              className={`shrink-0 px-3 py-1.5 rounded-md text-xs transition-all ${
                activeTab === tab.id
                  ? 'bg-cyan-400/20 text-cyan-400 border border-cyan-400/40'
                  : 'text-white/60 hover:text-white hover:bg-white/5 border border-transparent'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* 可滚动内容区：内容随外层 ScrollArea 滚动，自身不滚动 */}
      <div className="flex-1">
        <div className="p-4 space-y-6" style={{ scrollBehavior: 'smooth' }}>

            {/* ===== 可视化 ===== */}
            <SectionErrorBoundary sectionName="可视化模块">
            <div id="settings-section-visual" className="space-y-5" style={{ scrollMarginTop: `${TABBAR_OFFSET}px` }}>
            {/* 2D 模式 */}
            <div>
              <h3 className="text-sm font-medium text-white/80 mb-3">可视化模式 · 2D</h3>
              <div className="space-y-2">
                {/* 自定义背景 - 独立大卡片 */}
                {(() => {
                  const m = modes2D[0];
                  return (
                    <button
                      key={m.key}
                      onClick={() => handleSet2DMode(m.key)}
                      className={`relative w-full flex items-center gap-3 p-4 rounded-lg border transition-all ${
                        mode === m.key
                          ? 'border-fuchsia-400/60 bg-fuchsia-400/15 text-fuchsia-200 shadow-[0_0_20px_rgba(232_121_249_0.25)]'
                          : 'border-fuchsia-400/30 bg-gradient-to-br from-fuchsia-400/10 via-fuchsia-400/5 to-cyan-400/10 text-fuchsia-200 hover:from-fuchsia-400/20 hover:to-cyan-400/15 hover:border-fuchsia-400/50'
                      }`}
                    >
                      {mode !== m.key && (
                        <span className="absolute -top-2 -right-2 px-2 py-0.5 text-[10px] font-bold bg-gradient-to-r from-fuchsia-400 to-cyan-400 text-[#0a0f1a] rounded-full shadow-lg">NEW</span>
                      )}
                      <div className={`p-2 rounded-md ${mode === m.key ? 'bg-fuchsia-400/30' : 'bg-fuchsia-400/20'}`}>
                        <m.icon className={`w-6 h-6 ${mode === m.key ? 'drop-shadow-[0_0_8px_rgba(232_121_249_0.8)]' : 'drop-shadow-[0_0_4px_rgba(232_121_249_0.5)]'}`} />
                      </div>
                      <div className="flex-1 text-left">
                        <div className="text-sm font-semibold">{m.label}</div>
                        <div className="text-xs text-fuchsia-200/60 mt-0.5">导入图片或视频作背景，感光玻璃填充</div>
                      </div>
                      <div className={`w-2 h-2 rounded-full transition-all ${mode === m.key ? 'bg-fuchsia-400 shadow-[0_0_8px_rgba(232_121_249_0.8)]' : 'bg-fuchsia-400/40'}`} />
                    </button>
                  );
                })()}
                {/* 其他 2D 模式 */}
                <div className="grid grid-cols-2 gap-2 pt-1">
                  {modes2D.slice(1).map(m => (
                    <button
                      key={m.key}
                      onClick={() => handleSet2DMode(m.key)}
                      className={`flex flex-col items-center gap-2 p-3 rounded-lg border transition-all ${
                        mode === m.key
                          ? 'border-cyan-400/50 bg-cyan-400/10 text-cyan-400'
                          : 'border-white/10 bg-white/5 text-white/70 hover:bg-white/10'
                      }`}
                    >
                      <m.icon className="w-5 h-5" />
                      <span className="text-xs">{m.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* 3D 模式 */}
            <div>
              <h3 className="text-sm font-medium text-white/80 mb-3">
                可视化模式 · 3D
                {!webglSupported && <span className="ml-2 text-xs text-yellow-400">（WebGL 不可用）</span>}
              </h3>
              <div className="grid grid-cols-2 gap-2">
                {modes3D().map(m => (
                  <button
                    key={m.key}
                     onClick={() => trySet3DMode(m.key)}
                    className={`flex flex-col items-center gap-2 p-3 rounded-lg border transition-all ${
                      mode === m.key
                        ? 'border-cyan-400/50 bg-cyan-400/10 text-cyan-400'
                        : 'border-white/10 bg-white/5 text-white/70 hover:bg-white/10'
                    }`}
                  >
                    <m.icon className="w-5 h-5" />
                    <span className="text-xs">{m.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* 颜色预设 */}
            <div>
              <h3 className="text-sm font-medium text-white/80 mb-3">颜色预设</h3>
              <div className="grid grid-cols-5 gap-2">
                {presetColors.map(p => (
                  <button
                    key={p.name}
                    onClick={() => {
                      setPrimaryColor(p.primary);
                      setSecondaryColor(p.secondary);
                       setLyricSettings({ ...s_lyric, color: p.primary });
                    }}
                    className="flex flex-col items-center gap-1 p-2 rounded-lg border border-white/10 hover:border-white/30 transition-colors"
                    title={p.name}
                  >
                    <div
                      className="w-6 h-6 rounded-full"
                      style={{
                        background: `linear-gradient(135deg, ${p.primary}, ${p.secondary})`,
                        boxShadow: `0 0 8px ${p.primary}80`,
                      }}
                    />
                    <span className="text-[10px] text-white/50">{p.name}</span>
                  </button>
                ))}
              </div>
            </div>

              {/* 灵敏度 */}
            <SettingSlider
              label="灵敏度"
              value={sensitivity}
              min={vp.sensitivity.min}
              max={vp.sensitivity.max}
              step={vp.sensitivity.step}
              defaultValue={vp.sensitivity.default}
              onChange={setSensitivity}
              formatValue={v => Math.round(v).toString()}
            />

              {/* 自定义背景导入（仅 customBg 模式显示） */}
              {mode === 'customBg' && (
                <div className="space-y-4 pt-3 border-t border-white/10">
                  <div className="text-xs text-fuchsia-400/80 font-medium flex items-center gap-2">
                    <ImageIcon className="w-3.5 h-3.5" />
                    背景素材
                  </div>
                  <p className="text-[11px] text-white/50 leading-relaxed -mt-2">
                    导入你的图片或视频作为背景，推荐比例 <span className="text-white/70 font-mono">16:9</span>。
                    内容不会被拉伸，四周用感光玻璃模糊补全。
                  </p>

                  {/* 类型切换 */}
                  <div className="flex items-center gap-1 bg-white/5 rounded-md p-0.5">
                    {[
                      { v: 'image', label: '图片' },
                      { v: 'video', label: '视频' },
                    ].map(opt => (
                      <button
                        key={opt.v}
                        onClick={() => {
                          setBgImageType(opt.v as 'image' | 'video');
                          setBgImageUrl('');
                        }}
                        className={`flex-1 py-1.5 text-xs rounded transition-all ${
                          bgImageType === opt.v
                            ? 'bg-fuchsia-400/20 text-fuchsia-300 border border-fuchsia-400/40'
                            : 'text-white/60 hover:text-white/80'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>

                  {/* 导入按钮 */}
                  <label className="block w-full py-3 rounded-lg border border-dashed border-fuchsia-400/30 bg-fuchsia-400/5 hover:bg-fuchsia-400/10 hover:border-fuchsia-400/50 text-center text-xs text-fuchsia-200/70 hover:text-fuchsia-200 cursor-pointer transition-all">
                    <Upload className="w-5 h-5 mx-auto mb-1 opacity-70" />
                    {bgImageUrl ? '重新导入' : `导入${bgImageType === 'image' ? '图片' : '视频'}`}
                    <input
                      type="file"
                      accept={bgImageType === 'image' ? 'image/*' : 'video/*'}
                      className="hidden"
                      onChange={e => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        const maxSize = bgImageType === 'image' ? 10 * 1024 * 1024 : 100 * 1024 * 1024;
                        if (file.size > maxSize) {
                          toast.error(`文件过大，最大支持 ${bgImageType === 'image' ? '10MB' : '100MB'}`);
                          return;
                        }
                        const reader = new FileReader();
                        reader.onload = () => {
                          setBgImageUrl(reader.result as string);
                          toast.success('已设置为背景');
                        };
                        reader.onerror = () => toast.error('读取文件失败');
                        reader.readAsDataURL(file);
                      }}
                    />
                  </label>

                  {/* 已导入预览 + 清除 */}
                  {bgImageUrl && (
                    <div className="flex items-center gap-2 p-2 rounded-md bg-white/5 border border-white/10">
                      <div className="w-14 h-14 rounded overflow-hidden bg-black/40 flex-shrink-0">
                        {bgImageType === 'image' ? (
                          <Image src={bgImageUrl} alt="bg-preview" className="w-full h-full object-cover" />
                        ) : (
                          <video src={bgImageUrl} className="w-full h-full object-cover" muted playsInline autoPlay loop />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-white/70">已导入素材</div>
                        <div className="text-[10px] text-white/40 mt-0.5">推荐比例 16:9，四周感光玻璃填充</div>
                      </div>
                      <button
                        onClick={() => { setBgImageUrl(''); toast.info('已清除背景'); }}
                        className="text-[11px] text-white/50 hover:text-red-400 transition-colors px-2 py-1"
                      >
                        清除
                      </button>
                    </div>
                  )}
                </div>
              )}


            </div>
            </SectionErrorBoundary>

            <Separator className="bg-white/10" />

            {/* ===== 性能 ===== */}
            <SectionErrorBoundary sectionName="性能模块">
            <div id="settings-section-performance" className="space-y-5" style={{ scrollMarginTop: `${TABBAR_OFFSET}px` }}>
              {/* 当前生效参数（内联兜底，绝不直接读 null） */}
              <div className="rounded-lg bg-white/[0.03] border border-white/10 p-3 space-y-1.5">
                <div className="text-[11px] text-cyan-400/70 uppercase tracking-widest mb-1">当前生效参数</div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-white/50">画质档位</span>
                  <span className="text-white/80 font-medium">
                    {(qualityOptions.find(o => o.value === safeQuality) || qualityOptions[1]).label}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-white/50">目标帧率</span>
                  <span className="text-white/80 font-medium tabular-nums">
                    {safeTargetFps === 0 ? '不限' : `${safeTargetFps}fps`}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-white/50">可视化缩放</span>
                  <span className="text-white/80 font-medium tabular-nums">{safeVizScale.toFixed(2)}x</span>
                </div>
              </div>
            {/* 目标帧率 */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-white/80">目标帧率</h3>
                <button
                  onClick={() => setTargetFps(DEFAULT_VISUAL.targetFps)}
                  className={`h-5 w-5 rounded-full flex items-center justify-center transition-all ${
                    safeTargetFps === DEFAULT_VISUAL.targetFps
                      ? 'bg-transparent text-white/15 cursor-default'
                      : 'bg-white/10 text-white/60 hover:bg-white/20 hover:text-white active:scale-95'
                  }`}
                  title="恢复默认"
                >
                  <RotateCcw className="w-3 h-3" />
                </button>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {fpsOptions.map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => setTargetFps(opt.value)}
                    className={`py-2 px-2 rounded-lg text-xs transition-all ${
                      safeTargetFps === opt.value
                        ? 'bg-cyan-400/20 text-cyan-400 border border-cyan-400/40'
                        : 'bg-white/5 text-white/70 border border-white/10 hover:bg-white/10'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 画质档位 */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-white/80">画质档位</h3>
                <button
                  onClick={() => setQuality(DEFAULT_VISUAL.quality)}
                  className={`h-5 w-5 rounded-full flex items-center justify-center transition-all ${
                    safeQuality === DEFAULT_VISUAL.quality
                      ? 'bg-transparent text-white/15 cursor-default'
                      : 'bg-white/10 text-white/60 hover:bg-white/20 hover:text-white active:scale-95'
                  }`}
                  title="恢复默认"
                >
                  <RotateCcw className="w-3 h-3" />
                </button>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {qualityOptions.map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => setQuality(opt.value)}
                    className={`py-2 px-2 rounded-lg text-xs transition-all ${
                       safeQuality === opt.value
                        ? 'bg-cyan-400/20 text-cyan-400 border border-cyan-400/40'
                        : 'bg-white/5 text-white/70 border border-white/10 hover:bg-white/10'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 封面粒子数（仅 cover3d） */}
            {mode === 'cover3d' && (
              <div className="pt-2">
                <div className="flex justify-between items-center mb-3">
                  <h3 className="text-sm font-medium text-white/80">封面粒子数 · 清晰度</h3>
                  <span className="text-xs text-white/50 tabular-nums">
                    {coverParticleCount >= 10000 ? `${(coverParticleCount / 10000).toFixed(1)}万` : `${coverParticleCount}`}
                  </span>
                </div>
                <div className="grid grid-cols-4 gap-2 mb-2">
                  {[
                    { label: '标准', value: 8000 },
                    { label: '高清', value: 16000 },
                    { label: '超清', value: 30000 },
                    { label: '极致', value: 60000 },
                  ].map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => setCoverParticleCount(opt.value)}
                      className={`py-2 px-2 rounded-lg text-xs transition-all ${
                        coverParticleCount === opt.value
                          ? 'bg-cyan-400/20 text-cyan-400 border border-cyan-400/40'
                          : 'bg-white/5 text-white/70 border border-white/10 hover:bg-white/10'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-white/40 leading-relaxed">
                  粒子越多封面越清晰，但对性能要求越高。
                </p>
              </div>
            )}
            </div>
            </SectionErrorBoundary>

            <Separator className="bg-white/10" />

            {/* ===== 画面 ===== */}
            <SectionErrorBoundary sectionName="画面模块">
          <div id="settings-section-display" className="space-y-5" style={{ scrollMarginTop: `${TABBAR_OFFSET}px` }}>
            {/* 可视化位置 / 大小 */}
            <div>
              <h3 className="text-sm font-medium text-white/80 mb-3">可视化位置 / 大小</h3>
              <SettingSlider
                label="整体缩放"
                value={vizScale}
                min={vp.vizScale.min}
                max={vp.vizScale.max}
                step={vp.vizScale.step}
                unit="x"
                defaultValue={vp.vizScale.default}
                onChange={setVizScale}
                formatValue={v => v.toFixed(2) + 'x'}
              />
              <SettingSlider
                label="水平偏移"
                value={vizOffsetX}
                min={vp.vizOffsetX.min}
                max={vp.vizOffsetX.max}
                step={vp.vizOffsetX.step}
                unit="%"
                defaultValue={vp.vizOffsetX.default}
                onChange={setVizOffsetX}
              />
              <SettingSlider
                label="垂直偏移"
                value={vizOffsetY}
                min={vp.vizOffsetY.min}
                max={vp.vizOffsetY.max}
                step={vp.vizOffsetY.step}
                unit="%"
                defaultValue={vp.vizOffsetY.default}
                onChange={setVizOffsetY}
              />
            </div>

            {/* cover3d 参数 */}
            {mode === 'cover3d' && (
              <div className="pt-2">
                <h3 className="text-sm font-medium text-white/80 mb-3">封面粒子参数</h3>
                {/* 预设选择 */}
                <div className="mb-3">
                  <span className="text-xs text-white/70 mb-1.5 block">粒子预设</span>
                  <div className="grid grid-cols-2 gap-1.5">
                    {[
                       { v: 0,  label: '经典' },
                       { v: 1,  label: '隧道' },
                       { v: 2,  label: '星球' },
                       { v: 4,  label: '唱片' },
                     ].map(opt => (
                      <button
                        key={opt.v}
                        onClick={() => setCoverPreset(opt.v)}
                        className={`text-xs py-1.5 rounded-md transition-all ${coverPreset === opt.v ? 'bg-cyan-400/20 text-cyan-300 border border-cyan-400/40' : 'bg-white/5 text-white/60 border border-white/10 hover:bg-white/10'}`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
                <SettingSlider
                  label="律动强度"
                  value={coverIntensity}
                  min={vp.coverIntensity.min}
                  max={vp.coverIntensity.max}
                  step={vp.coverIntensity.step}
                  defaultValue={vp.coverIntensity.default}
                  onChange={setCoverIntensity}
                  formatValue={v => v.toFixed(2)}
                />
                <SettingSlider
                  label="深度 Depth"
                  value={coverDepth}
                  min={vp.coverDepth.min}
                  max={vp.coverDepth.max}
                  step={vp.coverDepth.step}
                  defaultValue={vp.coverDepth.default}
                  onChange={setCoverDepth}
                  formatValue={v => v.toFixed(2)}
                />
                <SettingSlider
                  label="Bloom 发光"
                  value={coverBloomStrength}
                  min={vp.coverBloomStrength.min}
                  max={vp.coverBloomStrength.max}
                  step={vp.coverBloomStrength.step}
                  defaultValue={vp.coverBloomStrength.default}
                  onChange={setCoverBloomStrength}
                  formatValue={v => v.toFixed(2)}
                />
                <SettingSlider
                  label="背景淡出"
                  value={coverBgFade}
                  min={vp.coverBgFade.min}
                  max={vp.coverBgFade.max}
                  step={vp.coverBgFade.step}
                  defaultValue={vp.coverBgFade.default}
                  onChange={setCoverBgFade}
                  formatValue={v => v.toFixed(2)}
                />
                {/* 星河开关 */}
                <div className="flex items-center justify-between py-1">
                  <span className="text-xs text-white/70">背景星河</span>
                  <button
                    role="switch"
                    aria-checked={coverStarRiver}
                    onClick={() => setCoverStarRiver(!coverStarRiver)}
                    className={`relative w-11 h-6 shrink-0 rounded-full transition-colors duration-200 active:scale-95 ${coverStarRiver ? 'bg-cyan-400' : 'bg-white/20'}`}
                  >
                    <span
                      className={`absolute top-0.5 left-0 size-5 rounded-full bg-white shadow-md transition-transform duration-200 ${coverStarRiver ? 'translate-x-[22px]' : 'translate-x-0.5'}`}
                    />
                  </button>
                </div>
                <SettingSlider
                  label="粒子大小"
                  value={coverParticleSize}
                  min={vp.coverParticleSize.min}
                  max={vp.coverParticleSize.max}
                  step={vp.coverParticleSize.step}
                  unit="x"
                  defaultValue={vp.coverParticleSize.default}
                  onChange={setCoverParticleSize}
                  formatValue={v => v.toFixed(2) + 'x'}
                />
                <SettingSlider
                   label="动画速度"
                   value={coverSpeed}
                   min={vp.coverSpeed.min}
                   max={vp.coverSpeed.max}
                   step={vp.coverSpeed.step}
                   defaultValue={vp.coverSpeed.default}
                   onChange={setCoverSpeed}
                   formatValue={v => v.toFixed(2) + 'x'}
                 />

                </div>
              )}

             {/* cover2d 封面粒子参数 */}
             {mode === 'cover2d' && (
               <div className="pt-2">
                 <h3 className="text-sm font-medium text-white/80 mb-3">封面粒子参数</h3>
                 <SettingSlider
                   label="封面大小"
                   value={cover2dScale}
                   min={vp.cover2dScale.min}
                   max={vp.cover2dScale.max}
                   step={vp.cover2dScale.step}
                   unit="x"
                   defaultValue={vp.cover2dScale.default}
                   onChange={setCover2dScale}
                   formatValue={v => v.toFixed(2) + 'x'}
                 />
                  <SettingSlider
                    label="光晕亮度"
                    value={cover2dGlow}
                    min={vp.cover2dGlow.min}
                    max={vp.cover2dGlow.max}
                    step={vp.cover2dGlow.step}
                    defaultValue={vp.cover2dGlow.default}
                    onChange={setCover2dGlow}
                    formatValue={v => v.toFixed(2)}
                  />
                  <SettingSlider
                     label="节拍触发灵敏度"
                     value={coverBeatSensitivity}
                     min={vp.coverBeatSensitivity.min}
                     max={vp.coverBeatSensitivity.max}
                     step={vp.coverBeatSensitivity.step}
                     defaultValue={vp.coverBeatSensitivity.default}
                     onChange={setCoverBeatSensitivity}
                     formatValue={v => v.toFixed(2)}
                   />

                   {/* 用户自定义背景（仅限横屏） */}
                   <div className="mt-4 pt-4 border-t border-white/10">
                     <div className="flex items-center justify-between mb-3">
                       <h4 className="text-sm font-medium text-white/80">用户自定义背景</h4>
                       <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                         仅限横屏
                       </span>
                     </div>
                     <p className="text-[11px] text-white/50 mb-3 leading-relaxed">
                       导入你的图片或视频作为背景，推荐比例 <span className="text-white/70 font-mono">16:9</span>。
                       内容不会被拉伸，四周用感光玻璃模糊补全。
                     </p>

                     {/* 类型切换 */}
                     <div className="flex items-center gap-1 mb-3 bg-white/5 rounded-md p-0.5">
                       {[
                         { v: 'image', label: '图片' },
                         { v: 'video', label: '视频' },
                       ].map(opt => (
                         <button
                           key={opt.v}
                           onClick={() => {
                             setBgImageType(opt.v as 'image' | 'video');
                             setBgImageUrl('');
                           }}
                           className={`flex-1 py-1 text-xs rounded transition-all ${
                             bgImageType === opt.v
                               ? 'bg-cyan-400/20 text-cyan-300 border border-cyan-400/40'
                               : 'text-white/60 hover:text-white/80'
                           }`}
                         >
                           {opt.label}
                         </button>
                       ))}
                     </div>

                     {/* 导入按钮 */}
                     <label className="block w-full py-2.5 rounded-lg border border-dashed border-white/20 bg-white/5 hover:bg-white/10 hover:border-cyan-400/40 text-center text-xs text-white/60 hover:text-cyan-300 cursor-pointer transition-all">
                       <Upload className="w-4 h-4 mx-auto mb-1 opacity-70" />
                       {bgImageUrl ? '重新导入' : `导入${bgImageType === 'image' ? '图片' : '视频'}`}
                       <input
                         type="file"
                         accept={bgImageType === 'image' ? 'image/*' : 'video/*'}
                         className="hidden"
                         onChange={e => {
                           const file = e.target.files?.[0];
                           if (!file) return;
                           // 限制大小：图片 10MB / 视频 100MB
                           const maxSize = bgImageType === 'image' ? 10 * 1024 * 1024 : 100 * 1024 * 1024;
                           if (file.size > maxSize) {
                             toast.error(`文件过大，最大支持 ${bgImageType === 'image' ? '10MB' : '100MB'}`);
                             return;
                           }
                           const reader = new FileReader();
                           reader.onload = () => {
                             setBgImageUrl(reader.result as string);
                             toast.success('已设置为背景');
                           };
                           reader.onerror = () => toast.error('读取文件失败');
                           reader.readAsDataURL(file);
                         }}
                       />
                     </label>

                     {/* 已导入预览 + 清除 */}
                     {bgImageUrl && (
                       <div className="mt-3 flex items-center gap-2">
                         <div className="w-12 h-12 rounded-md overflow-hidden border border-white/10 bg-black/40 flex-shrink-0">
                           {bgImageType === 'image' ? (
                             <Image src={bgImageUrl} alt="bg-preview" className="w-full h-full object-cover" />
                           ) : (
                             <video src={bgImageUrl} className="w-full h-full object-cover" muted playsInline />
                           )}
                         </div>
                         <div className="flex-1 min-w-0">
                           <div className="text-xs text-white/70 truncate">已导入</div>
                           <div className="text-[10px] text-white/40">推荐比例 16:9</div>
                         </div>
                         <button
                           onClick={() => { setBgImageUrl(''); toast.info('已清除背景'); }}
                           className="h-7 px-2 rounded text-xs text-white/60 hover:text-white hover:bg-white/10 transition-colors flex-shrink-0"
                         >
                           清除
                         </button>
                       </div>
                     )}
                   </div>
                 </div>
               )}
            </div>
            </SectionErrorBoundary>

            <Separator className="bg-white/10" />

            {/* ===== 歌词 ===== */}
            <SectionErrorBoundary sectionName="歌词模块">
          <div id="settings-section-lyric" className="space-y-4" style={{ scrollMarginTop: `${TABBAR_OFFSET}px` }}>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-white/80">歌词设置</h3>
              <button
                onClick={() => setLyricSettings(DEFAULT_LYRIC)}
                className="h-6 px-2 rounded-md bg-white/10 text-white/60 hover:bg-white/20 hover:text-white text-xs flex items-center gap-1 transition-all active:scale-95"
              >
                <RotateCcw className="w-3 h-3" />
                恢复歌词默认
              </button>
            </div>

            {/* 显示歌词总开关 */}
            <div className="flex items-center justify-between py-1">
              <span className="text-xs text-white/70">显示歌词</span>
              <button
                role="switch"
                aria-checked={s_lyric.show}
                onClick={() => setLyricSettings({ ...s_lyric, show: !s_lyric.show })}
                className={`relative w-11 h-6 shrink-0 rounded-full transition-colors duration-200 active:scale-95 ${
                  s_lyric.show ? 'bg-cyan-400' : 'bg-white/20'
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0 size-5 rounded-full bg-white shadow-md transition-transform duration-200 ${
                    s_lyric.show ? 'translate-x-[22px]' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>

            {/* 显示翻译开关 */}
            <div className="flex items-center justify-between py-1">
              <span className="text-xs text-white/70">显示翻译</span>
              <button
                role="switch"
                aria-checked={s_lyric.showTranslation}
                onClick={() => setLyricSettings({ ...s_lyric, showTranslation: !s_lyric.showTranslation })}
                className={`relative w-11 h-6 shrink-0 rounded-full transition-colors duration-200 active:scale-95 ${
                  s_lyric.showTranslation ? 'bg-cyan-400' : 'bg-white/20'
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0 size-5 rounded-full bg-white shadow-md transition-transform duration-200 ${
                    s_lyric.showTranslation ? 'translate-x-[22px]' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>

            <Separator className="bg-white/10" />

            {/* 主歌词字号 */}
            <SettingSlider
              label="主歌词字号"
              value={s_lyric.fontSize}
              min={lp.fontSize.min}
              max={lp.fontSize.max}
              step={lp.fontSize.step}
              unit={lp.fontSize.unit}
              defaultValue={lp.fontSize.default}
              onChange={v => setLyricSettings({ ...s_lyric, fontSize: v })}
            />

            {/* 翻译字号 */}
            {s_lyric.showTranslation && (
              <SettingSlider
                label="翻译字号"
                value={s_lyric.translationFontSize}
                min={lp.translationFontSize.min}
                max={lp.translationFontSize.max}
                step={lp.translationFontSize.step}
                unit={lp.translationFontSize.unit}
                defaultValue={lp.translationFontSize.default}
                onChange={v => setLyricSettings({ ...s_lyric, translationFontSize: v })}
              />
            )}

            {/* 行间距 */}
            <SettingSlider
              label="行高"
              value={s_lyric.lineHeight}
              min={lp.lineHeight.min}
              max={lp.lineHeight.max}
              step={lp.lineHeight.step}
              defaultValue={lp.lineHeight.default}
              onChange={v => setLyricSettings({ ...s_lyric, lineHeight: v })}
              formatValue={v => v.toFixed(1)}
            />

            {/* 垂直位置 */}
            <SettingSlider
              label="垂直位置"
              value={s_lyric.verticalPosition}
              min={lp.verticalPosition.min}
              max={lp.verticalPosition.max}
              step={lp.verticalPosition.step}
              unit={lp.verticalPosition.unit}
              defaultValue={lp.verticalPosition.default}
              onChange={v => setLyricSettings({ ...s_lyric, verticalPosition: v })}
            />

            {/* 发光强度 */}
            <SettingSlider
              label="发光强度"
              value={s_lyric.glowIntensity}
              min={lp.glowIntensity.min}
              max={lp.glowIntensity.max}
              step={lp.glowIntensity.step}
              defaultValue={lp.glowIntensity.default}
              onChange={v => setLyricSettings({ ...s_lyric, glowIntensity: v })}
              formatValue={v => v.toFixed(2)}
            />

            <Separator className="bg-white/10" />

            {/* 音域回响涟漪 */}
            <div className="space-y-3">
             </div>

            {/* 高亮颜色 */}
             <div className="pt-1">
               <div className="flex items-center justify-between mb-2">
                 <label className="text-xs text-white/70">高亮颜色</label>
                 <span className="text-[11px] text-white/50 tabular-nums">默认 {DEFAULT_LYRIC.color}</span>
               </div>
               <LyricColorPicker
                 value={s_lyric.color}
                 onChange={v => setLyricSettings({ ...s_lyric, color: v })}
                 onReset={() => setLyricSettings({ ...s_lyric, color: DEFAULT_LYRIC.color })}
                 defaultValue={DEFAULT_LYRIC.color}
               />
             </div>
            </div>
            </SectionErrorBoundary>

            <Separator className="bg-white/10" />

            {/* ===== 录制 ===== */}
            <SectionErrorBoundary sectionName="录制模块">
          <div id="settings-section-record" className="space-y-5" style={{ scrollMarginTop: `${TABBAR_OFFSET}px` }}>
            <div>
              <h3 className="text-sm font-medium text-white/80 mb-3">视频录制</h3>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-white/70">录制状态</span>
                  <span className={`text-xs ${isRecording ? 'text-red-400' : 'text-white/50'}`}>
                    {isRecording ? `录制中 ${formatTime(recordTime)}` : '空闲'}
                  </span>
                </div>
                <Button
                  onClick={onToggleRecord}
                  className={`w-full ${
                    isRecording
                      ? 'bg-red-500 hover:bg-red-600 text-white'
                      : 'bg-cyan-400 hover:bg-cyan-500 text-black'
                  }`}
                >
                  {isRecording ? '停止录制' : '开始录制'}
                </Button>
                <p className="text-[11px] text-white/40 leading-relaxed">
                  录制当前可视化画面与音频，导出为 MP4 格式（浏览器不支持时自动回退为 WebM）。
                </p>
              </div>
            </div>

            {/* 3D 可视化状态（WebGL 卡片为工程菜单隐藏入口：连击10次/长按2秒） */}
            <div>
              <h3 className="text-sm font-medium text-white/80 mb-3">3D 可视化</h3>
              <div className="space-y-2">
                <div
                  onClick={onWebglCardClick}
                  onMouseDown={startLongPress}
                  onMouseUp={cancelLongPress}
                  onMouseLeave={cancelLongPress}
                  onTouchStart={startLongPress}
                  onTouchEnd={cancelLongPress}
                  onTouchCancel={cancelLongPress}
                  onContextMenu={(e) => e.preventDefault()}
                  className="flex items-center justify-between cursor-default select-none px-3 py-2.5 rounded-xl bg-white/5 border border-white/10 hover:border-white/20 active:bg-white/10 transition-colors touch-none"
                >
                  <span className="text-xs text-white/70">WebGL 支持</span>
                  <span className={`text-xs ${webglSupported ? 'text-emerald-400' : 'text-red-400'} flex items-center gap-1.5`}>
                    <span className={`w-2 h-2 rounded-full ${webglSupported ? 'bg-emerald-400' : 'bg-red-400'} ${webglSupported ? 'animate-pulse' : ''}`} />
                    {webglSupported ? '可用' : '不可用'}
                  </span>
                </div>
                {webglError && (
                  <p className="text-[11px] text-red-400/80 leading-relaxed">{webglError}</p>
                )}
                {!webglSupported && (
                  <Button onClick={onForce3D} variant="secondary" className="w-full">
                    强制尝试 3D
                  </Button>
                )}
              </div>
            </div>
            </div>
            </SectionErrorBoundary>

          <Separator className="bg-white/10" />

          {/* 新手教程入口 */}
          {onOpenTour && (
            <div className="pt-2 pb-1">
              <Button
                variant="outline"
                onClick={onOpenTour}
                data-testid="settings-open-tour-btn"
                className="w-full border-cyan-400/30 text-cyan-300 hover:text-cyan-200 hover:bg-cyan-400/10"
              >
                <HelpCircle className="w-4 h-4 mr-2" />
                新手教程
              </Button>
            </div>
          )}

          {/* 工程菜单入口 */}
          {onOpenEngineering && (
            <div className="pt-2 pb-1">
              <Button
                variant="outline"
                onClick={onOpenEngineering}
                className="w-full border-amber-400/30 text-amber-300 hover:text-amber-200 hover:bg-amber-400/10"
              >
                <Wrench className="w-4 h-4 mr-2" />
                工程菜单
              </Button>
            </div>
          )}

          {/* 全局恢复默认 */}
          <div className="pt-2 pb-4">
            <Button
              variant="outline"
              onClick={onResetAll}
              className="w-full border-white/15 text-white/60 hover:text-white hover:bg-white/10"
            >
              <RotateCcw className="w-4 h-4 mr-2" />
              恢复默认设置
            </Button>
          </div>

           {/* GPL-3.0 署名 */}
           <div className="pt-1 pb-4 text-center">
             <p className="text-[10px] text-white/30 leading-relaxed">
               部分视觉改编自 XxHuberrr/Mineradio (GPL-3.0)
             </p>
           </div>

        </div>
      </div>
    </div>
  );
}

// ===== 歌词颜色选择器（拖动跟手优化版） =====
// 高频取色时：本地 ref 实时更新 DOM 颜色（不触发 React 重渲染），
// 并通过 rAF 节流调用 onChange，保证歌词树不会每像素都重建。
function LyricColorPicker({
  value,
  onChange,
  onReset,
  defaultValue,
}: {
  value: string;
  onChange: (v: string) => void;
  onReset: () => void;
  defaultValue: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLInputElement>(null);
  const swatchRef = useRef<HTMLButtonElement>(null);
  const rafRef = useRef<number | null>(null);
  const pendingRef = useRef<string | null>(null);
  const localValueRef = useRef(value);

  // 外部 value 变化（非拖动场景）时同步本地引用
  useEffect(() => {
    localValueRef.current = value;
    if (textRef.current && document.activeElement !== textRef.current) {
      textRef.current.value = value;
    }
  }, [value]);

  // rAF 节流提交：拖动过程中每帧最多提交一次
  const scheduleCommit = useCallback((v: string) => {
    pendingRef.current = v;
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const v = pendingRef.current;
      if (v !== null) {
        pendingRef.current = null;
        localValueRef.current = v;
        onChange(v);
      }
    });
  }, [onChange]);

  // 拖动中即时更新 swatch / 文本输入框视觉，不触发 React 重渲染
  const onColorInput = useCallback((e: React.FormEvent<HTMLInputElement>) => {
    const v = (e.target as HTMLInputElement).value;
    localValueRef.current = v;
    // 立即同步视觉（DOM 直写，绕开 React）
    if (swatchRef.current) swatchRef.current.style.backgroundColor = v;
    if (textRef.current && document.activeElement !== textRef.current) {
      textRef.current.value = v;
    }
    scheduleCommit(v);
  }, [scheduleCommit]);

  const onTextChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    if (/^#[0-9a-fA-F]{6}$/.test(v)) {
      localValueRef.current = v;
      if (swatchRef.current) swatchRef.current.style.backgroundColor = v;
      if (inputRef.current) inputRef.current.value = v;
      scheduleCommit(v);
    }
  }, [scheduleCommit]);

  const onResetClick = useCallback(() => {
    onReset();
  }, [onReset]);

  return (
    <div className="flex items-center gap-2">
      <input
        ref={inputRef}
        type="color"
        defaultValue={value}
        onInput={onColorInput}
        className="w-8 h-8 rounded cursor-pointer bg-transparent border border-white/20"
      />
      <input
        ref={textRef}
        type="text"
        defaultValue={value}
        onChange={onTextChange}
        className="flex-1 bg-white/5 border border-white/10 rounded px-2 py-1 text-xs text-white/80 font-mono"
      />
      <button
        ref={swatchRef}
        onClick={onResetClick}
        className={`h-6 w-6 rounded-full border border-white/20 transition-all ${
          value === defaultValue ? 'opacity-40 cursor-default' : 'hover:scale-110 active:scale-95'
        }`}
        style={{ backgroundColor: value }}
        title="恢复默认"
      />
    </div>
  );
}