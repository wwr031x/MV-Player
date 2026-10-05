// 全局默认配置字典（单一数据源）
// 所有可调参数的默认值、范围、步长都集中在此处定义。
// UI 初始值、localStorage 读写合并、单项重置、全局恢复默认
// 都基于这份字典，保证唯一真值源。
//
// 使用规则：
//   - 默认值取"中等/中间"值，不偏极端
//   - 数值参数必须有 min / max / default / step
//   - 新增参数时必须在此登记，并同步到 interface

import type { IVisualizerSettings, ILyricSettings } from '@/types';

// ===== 可视化设置默认值 =====
export const DEFAULT_VISUAL: IVisualizerSettings = {
  mode: 'cover2d',
  primaryColor: '#22d3ee',
  secondaryColor: '#a855f7',
  sensitivity: 100,
  targetFps: 60,
  quality: 'mid',
  vizScale: 1,
  vizOffsetX: 0,
  vizOffsetY: 0,
  coverParticleCount: 16000, // 高清档（中间值）
  coverBrightness: 1,
  coverParticleSize: 1,
  coverDensity: 1,
  coverOpacity: 0.95,
  coverTwist: 0,
  coverScatter: 0,
  coverSpeed: 1,
  coverColorBoost: 1,
  coverEdgeEnabled: true,
  coverPreset: 4,         // VINYL 唱片（MR 默认）
  coverIntensity: 0.85,   // MR 默认
  coverDepth: 0.2,        // MR 默认
  coverBloomStrength: 0.62, // MR 默认（Additive 发光层强度，UnrealBloom 已关闭）
  coverStarRiver: true,   // 背景星河默认开
  coverBgFade: 0.20,      // MR 默认
  // 封面粒子2D模式
  cover2dScale: 0.7,
  cover2dGlow: 0.6,
  coverBeatSensitivity: 0.25,  // 节拍触发阈值，0.25 偏低灵敏
  // 用户自定义背景（横屏专属）
  bgImageUrl: '',
  bgImageType: 'image' as const,
};

// ===== 歌词设置默认值 =====
export const DEFAULT_LYRIC: ILyricSettings = {
  show: true,
  fontSize: 22,            // 主歌词字号（默认更大）
  translationFontSize: 14, // 翻译字号（更小更淡）
  lineHeight: 1.4,         // 行间距
  verticalPosition: 75,
  align: 'center',
  color: '#22d3ee',        // 高亮颜色 = 主题色
  strokeColor: '#000000',
  glowIntensity: 0.35,      // 发光强度 0-1
  showTranslation: true,
};

// ===== 参数元数据字典（滑块用：范围 / 步长 / 默认值 / 单位） =====
export interface ParamMeta {
  min: number;
  max: number;
  step: number;
  default: number;
  unit?: string; // 显示用的单位后缀
}

// 可视化相关参数
export const VISUAL_PARAMS: Record<string, ParamMeta> = {
  sensitivity:   { min: 1,   max: 100, step: 1,   default: 100 },
  vizScale:      { min: 0.5, max: 2,   step: 0.05, default: 1,    unit: 'x' },
  vizOffsetX:    { min: -50, max: 50,  step: 1,    default: 0,    unit: '%' },
  vizOffsetY:    { min: -50, max: 50,  step: 1,    default: 0,    unit: '%' },
  coverBrightness:    { min: 0.3, max: 2,   step: 0.05, default: 1 },
  coverParticleSize:  { min: 0.5, max: 3,   step: 0.05, default: 1,  unit: 'x' },
  coverDensity:       { min: 0.3, max: 1.5, step: 0.05, default: 1,  unit: '%' },
  coverOpacity:       { min: 0.3, max: 1,   step: 0.05, default: 0.95, unit: '%' },
  coverTwist:         { min: 0,   max: 3,   step: 0.05, default: 0 },
  coverScatter:       { min: 0,   max: 3,   step: 0.05, default: 0 },
  coverSpeed:         { min: 0.3, max: 2,   step: 0.05, default: 1,  unit: 'x' },
  coverColorBoost:    { min: 0.5, max: 2.5, step: 0.05, default: 1 },
  coverIntensity:     { min: 0.3, max: 2,   step: 0.05, default: 0.85 },
  coverDepth:         { min: 0,   max: 1,   step: 0.05, default: 0.2 },
  coverBloomStrength: { min: 0,   max: 2,   step: 0.05, default: 0.62 },
  coverBgFade:        { min: 0,   max: 1,   step: 0.05, default: 0.20 },
  cover2dScale:       { min: 0.3, max: 2,   step: 0.05, default: 0.7, unit: 'x' },
  cover2dGlow:        { min: 0.2, max: 2,   step: 0.05, default: 0.6 },
  coverBeatSensitivity: { min: 0.05, max: 0.8, step: 0.05, default: 0.25 },
};

// 歌词相关参数
export const LYRIC_PARAMS: Record<string, ParamMeta> = {
  fontSize:          { min: 12,  max: 60, step: 1, default: 22, unit: 'px' },
  translationFontSize:{ min: 10, max: 40, step: 1, default: 14, unit: 'px' },
  lineHeight:        { min: 1,   max: 2.5, step: 0.1, default: 1.4 },
  verticalPosition:  { min: 10,  max: 90, step: 1, default: 75, unit: '%' },
  glowIntensity:     { min: 0,   max: 1,  step: 0.05, default: 0.35 },
};

// ===== 工具函数：判断是否等于默认值 =====
export function isDefaultVisual(settings: IVisualizerSettings): boolean {
  // 动态遍历所有字段，避免新增字段后遗漏
  const keys = Object.keys(DEFAULT_VISUAL) as (keyof IVisualizerSettings)[];
  return keys.every((k) => settings[k] === DEFAULT_VISUAL[k]);
}

export function isDefaultLyric(settings: ILyricSettings): boolean {
  return (
    settings.show === DEFAULT_LYRIC.show &&
    settings.fontSize === DEFAULT_LYRIC.fontSize &&
    settings.translationFontSize === DEFAULT_LYRIC.translationFontSize &&
    settings.lineHeight === DEFAULT_LYRIC.lineHeight &&
    settings.verticalPosition === DEFAULT_LYRIC.verticalPosition &&
    settings.align === DEFAULT_LYRIC.align &&
    settings.color === DEFAULT_LYRIC.color &&
    settings.strokeColor === DEFAULT_LYRIC.strokeColor &&
    settings.glowIntensity === DEFAULT_LYRIC.glowIntensity &&
    settings.showTranslation === DEFAULT_LYRIC.showTranslation
  );
}
