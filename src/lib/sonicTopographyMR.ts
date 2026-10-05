/**
 * Sonic Topography visual preset — Mineradio 原版原样移植
 *
 * 源码来源：XxHuberrr/Mineradio-paused public/sonic-topography-preset.js
 * 视觉算法改编自 yin-yizhen/sonic-topography 1.1.1 (commit 3ff303e)
 *
 * 仅做三处环境适配：
 *   1. THREE 改为 import 传入（调用方传 THREE 构造器）
 *   2. 模块挂载方式改为 ES Module export
 *   3. 新增 analyzeFrequencyBins() 把 Web Audio AnalyserNode 的原始频域数据
 *      按频率区间聚合成 MR 期望的 8 频段（subBass/bass/lowMid/mid/highMid/
 *      presence/brilliance/air）+ energy/treble/kickEnvelope
 *
 * 其余视觉逻辑（顶点/片元着色器、网格构建、涟漪/流星/拖尾/漂浮方块、
 * 所有默认参数与颜色）一律保持 MR 原值，不做任何自创改动。
 */

import { logger } from '@lark-apaas/client-toolkit-lite';

// ========== MR 常量（全部保持原值） ==========
const INDEX = 7;
const RIPPLE_MAX = 10;
const RIPPLE_LIFETIME = 4.8;
const RIPPLE_SOFT_FADE_START = 2.1;
const METEOR_MAX = 20;
const TRAIL_MAX = 200;
const DEFAULT_FLOATING_BLOCK_COUNT = 80;
const FLOATING_BLOCK_MIN_COUNT = 0;
const FLOATING_BLOCK_MAX_COUNT = 100;
const DEFAULT_GROUND_MOTION_SPEED = 50;
const DEFAULT_GROUND_AMPLITUDE = 50;
const DEFAULT_TERRAIN_DENSITY = 46;
const DEFAULT_GROUND_RANGE = 82;
const DEFAULT_GROUND_LOWER = 68;
const DEFAULT_GROUND_DEPTH = 62;
const DEFAULT_GROUND_AUTO_ROTATE = 50;
const DEFAULT_GROUND_GLOW = 68;
const DEFAULT_GROUND_BASE_COLOR = '#05070c';
const DEFAULT_GROUND_COOL_COLOR = '#0066ff';
const DEFAULT_GROUND_WARM_COLOR = '#ff3c19';
const DEFAULT_GROUND_ACCENT_COLOR = '#33e6ff';
const TERRAIN_BASE_SIZE = 168;
const TERRAIN_MIN_GRID_SIZE = 96;
const TERRAIN_MAX_GRID_SIZE = 224;
const QUALITY_GRID_CAP: Record<string, number> = { eco: 112, balanced: 160, high: 192, ultra: 224 };
const DEFAULT_FLOATING_BLOCK_INTENSITY = 55;
const DEFAULT_FLOATING_BLOCK_MIN_SIZE = 9;
const DEFAULT_FLOATING_BLOCK_MAX_SIZE = 26;
const DEFAULT_FLOATING_BLOCK_SPEED = 77;
const MAX_SHADER_SUB_BASS = 1.2;
const MAX_SHADER_BASS = 1.15;
const MAX_KICK_DEFORM = 0.75;
const GROUND_BAND_KEYS = [
  'sonicGroundSubBass',
  'sonicGroundBass',
  'sonicGroundLowMid',
  'sonicGroundMid',
  'sonicGroundHighMid',
  'sonicGroundPresence',
  'sonicGroundBrilliance',
  'sonicGroundAir',
];
const DEFAULT_GROUND_BANDS = [90, 92, 50, 50, 50, 50, 50, 48];

// 8 频段对应的频率区间（Hz），与 MR 原始频段语义一致
const BAND_FREQ_RANGES = [
  [20, 60],       // subBass
  [60, 250],      // bass
  [250, 500],     // lowMid
  [500, 2000],    // mid
  [2000, 4000],   // highMid
  [4000, 6000],   // presence
  [6000, 16000],  // brilliance
  [16000, 20000], // air
];

// ========== 状态（保持 MR 单例结构） ==========
const state: any = {
  root: null,
  terrain: null,
  terrainMat: null,
  floatingBlocks: null,
  floatingMat: null,
  meteors: null,
  meteorMat: null,
  trails: null,
  trailMat: null,
  scene: null,
  opacity: 0,
  gridSize: 0,
  gridSpacing: 0,
  floatingCount: DEFAULT_FLOATING_BLOCK_COUNT,
  initialized: false,
  sonicTime: 0,
  autoYaw: 0,
  manualYaw: 0,
  boundRotX: 0,
  boundRotY: 0,
  lastOrbitTheta: 0,
  orbitThetaReady: false,
  ripples: [],
  rippleIdx: 0,
  meteorsData: [],
  meteorIdx: 0,
  lastMeteorAt: -999,
  trailsData: [],
  trailIdx: 0,
  floatingData: [],
  floatingPulse: 0,
  lastKickActive: false,
  lastSnareActive: false,
  smoothAudio: {
    subBass: 0,
    bass: 0,
    lowMid: 0,
    mid: 0,
    highMid: 0,
    presence: 0,
    brilliance: 0,
    air: 0,
  },
  dummyPos: null,
  dummyQuat: null,
  dummyScale: null,
  dummyMat4: null,
  dummyEuler: null,
  dummyObj: null,
};

// ========== 工具函数（MR 原样） ==========
function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}
function clamp01(v: number) {
  return clamp(Number.isFinite(v) ? v : 0, 0, 1);
}
function smoothstep01(v: number) {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
}
function blend01(value: number) {
  return clamp(Number.isFinite(value) ? value : 0, 0, 1);
}
function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}
function sonicNumber(fx: any, key: string, fallback: number, min: number, max: number) {
  const value = fx && fx[key] != null ? Number(fx[key]) : fallback;
  if (!Number.isFinite(value)) return fallback;
  return clamp(value, min, max);
}
function sonicHex(fx: any, key: string, fallback: string) {
  const value = fx && fx[key] != null ? String(fx[key]).trim() : fallback;
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) return fallback;
  return value;
}

// ========== 颜色主题：MR 自定义色模式（colorMode==='custom' 走这里） ==========
// 我们只支持 custom 模式（用户面板选的颜色），coverPalette 模式不实现
function sonicCustomGroundTheme(THREE: any, fx: any) {
  const tint = new THREE.Color((fx && fx.visualTintColor) || '#62d6ff');
  const base1 = new THREE.Color(sonicHex(fx, 'sonicGroundBaseColor', DEFAULT_GROUND_BASE_COLOR));
  return {
    base1,
    base2: base1.clone().lerp(new THREE.Color('#ffffff'), 0.12),
    coolCore: new THREE.Color(sonicHex(fx, 'sonicGroundCoolColor', DEFAULT_GROUND_COOL_COLOR)).lerp(tint, fx && fx.visualTintMode === 'custom' ? 0.08 : 0.0),
    warmCore: new THREE.Color(sonicHex(fx, 'sonicGroundWarmColor', DEFAULT_GROUND_WARM_COLOR)).lerp(tint, fx && fx.visualTintMode === 'custom' ? 0.05 : 0.0),
    ripple: new THREE.Color(sonicHex(fx, 'sonicGroundAccentColor', DEFAULT_GROUND_ACCENT_COLOR)),
  };
}

function floatingBlockCountForFx(fx: any) {
  return Math.round(sonicNumber(fx, 'sonicGroundFloatingCount', DEFAULT_FLOATING_BLOCK_COUNT, FLOATING_BLOCK_MIN_COUNT, FLOATING_BLOCK_MAX_COUNT));
}

function deriveGroundLayoutSettings(fx: any) {
  const range = sonicNumber(fx, 'sonicGroundRange', DEFAULT_GROUND_RANGE, 0, 100);
  const lower = sonicNumber(fx, 'sonicGroundLower', DEFAULT_GROUND_LOWER, 0, 100);
  const depth = sonicNumber(fx, 'sonicGroundDepth', DEFAULT_GROUND_DEPTH, 0, 100);
  return {
    scale: 0.096 + range * 0.00072,
    y: -4.05 - lower * 0.034,
    z: -4.20 - depth * 0.055,
  };
}

function readBands(fx: any) {
  const bands: number[] = [];
  for (let i = 0; i < GROUND_BAND_KEYS.length; i++) {
    bands.push(sonicNumber(fx, GROUND_BAND_KEYS[i], DEFAULT_GROUND_BANDS[i], 0, 100));
  }
  return bands;
}

function applyGroundEqBandValue(value: number, bands: number[], index: number, max: number | null) {
  let eq = Number(bands[index]);
  if (!Number.isFinite(eq)) eq = 50;
  const delta = (eq - 50) / 50;
  if (delta >= 0) return clamp(value * (1 + delta * 1.8), 0, max == null ? 1 : max);
  const dullness = Math.abs(delta);
  return clamp(Math.max(0, value - dullness * 0.35) * (1 - dullness * 0.35), 0, max == null ? 1 : max);
}

function deriveTerrainGridSettings(fx: any, quality: string) {
  const density = sonicNumber(fx, 'sonicGroundDensity', DEFAULT_TERRAIN_DENSITY, 0, 100);
  const raw = TERRAIN_MIN_GRID_SIZE + ((TERRAIN_MAX_GRID_SIZE - TERRAIN_MIN_GRID_SIZE) * density) / 100;
  const cap = QUALITY_GRID_CAP[quality] || QUALITY_GRID_CAP.balanced;
  const gridSize = clamp(Math.round(raw / 4) * 4, TERRAIN_MIN_GRID_SIZE, cap);
  const spacing = TERRAIN_BASE_SIZE / gridSize;
  return {
    gridSize,
    spacing,
    boxWidth: spacing * (0.9 / 1.05),
    instanceCount: gridSize * gridSize,
    floatingCount: floatingBlockCountForFx(fx),
  };
}

// ========== 音频数据：把 AnalyserNode 的原始频域数据聚合为 MR 8 频段 ==========
// 输入：Uint8Array (getByteFrequencyData 的结果，0~255)
//       sampleRate: AudioContext 采样率
//       fftSize: analyser.fftSize（默认 2048）
// 输出：MR readMineradioAudio detailed 分支的完整对象（0~1 归一化）
export function analyzeFrequencyBins(freqData: Uint8Array | null, sampleRate: number, fftSize = 2048) {
  if (!freqData || freqData.length === 0) {
    return {
      subBass: 0, bass: 0, lowMid: 0, mid: 0, highMid: 0,
      presence: 0, brilliance: 0, air: 0,
      treble: 0, kickEnvelope: 0, energy: 0,
      sharpness: 0, smoothness: 1, density: 0.45,
    };
  }
  const binCount = freqData.length; // = fftSize / 2
  const binHz = sampleRate / fftSize;

  const bands = new Array(8).fill(0);
  for (let b = 0; b < 8; b++) {
    const [lowHz, highHz] = BAND_FREQ_RANGES[b];
    const startBin = Math.max(0, Math.floor(lowHz / binHz));
    const endBin = Math.min(binCount - 1, Math.ceil(highHz / binHz));
    if (endBin <= startBin) {
      bands[b] = 0;
      continue;
    }
    let sum = 0;
    for (let i = startBin; i < endBin; i++) {
      sum += (freqData[i] || 0) / 255;
    }
    bands[b] = sum / (endBin - startBin);
  }

  // treble = 高频（presence + brilliance + air）均值
  const treble = (bands[5] + bands[6] + bands[7]) / 3;

  // energy = 全频段加权均值（低频权重略高）
  let eSum = 0;
  let wSum = 0;
  for (let b = 0; b < 8; b++) {
    const w = 2.0 - b * 0.15;
    eSum += bands[b] * w;
    wSum += w;
  }
  const energy = eSum / wSum;

  // kickEnvelope：基于 subBass + bass 的瞬态近似（MR 原版由外部 beat 检测提供，
  // 这里用低频总量做近似，后续若有专门 beat 服务可替换）
  const kickEnvelope = clamp01(bands[0] * 0.6 + bands[1] * 0.4);

  const sharpness = clamp01(treble * 0.70 + kickEnvelope * 0.20);
  const smoothness = clamp01(1.0 - treble * 0.42 + bands[3] * 0.14);
  const density = clamp01(0.45 + treble * 0.35 + kickEnvelope * 0.10);

  return {
    subBass: clamp01(bands[0]),
    bass: clamp01(bands[1]),
    lowMid: clamp01(bands[2]),
    mid: clamp01(bands[3]),
    highMid: clamp01(bands[4]),
    presence: clamp01(bands[5]),
    brilliance: clamp01(bands[6]),
    air: clamp01(bands[7]),
    treble,
    kickEnvelope,
    energy,
    sharpness,
    smoothness,
    density,
  };
}

function deriveKickFollowLowBands(data: any, bands: number[]) {
  const safeKick = clamp(Number.isFinite(data.kickEnvelope) ? data.kickEnvelope : 0, 0, MAX_KICK_DEFORM);
  const normalizedKick = safeKick / MAX_KICK_DEFORM;
  const subBassInput = clamp01(data.subBass) * 0.22 + normalizedKick * 1.28;
  const bassInput = clamp01(data.bass) * 0.20 + normalizedKick * 1.15;
  return {
    subBass: applyGroundEqBandValue(subBassInput, bands, 0, MAX_SHADER_SUB_BASS),
    bass: applyGroundEqBandValue(bassInput, bands, 1, MAX_SHADER_BASS),
  };
}

function smoothGroundAudio(target: any, fx: any, dt: number) {
  const motionSpeed = sonicNumber(fx, 'sonicGroundMotionSpeed', DEFAULT_GROUND_MOTION_SPEED, 0, 100);
  const responseRate = lerp(2.2, 60, motionSpeed / 100);
  const responseBlend = blend01(1 - Math.exp(-responseRate * Math.max(0.001, dt || 1 / 60)));
  const s = state.smoothAudio;
  s.subBass += (target.subBass - s.subBass) * responseBlend;
  s.bass += (target.bass - s.bass) * responseBlend;
  s.lowMid += (target.lowMid - s.lowMid) * responseBlend;
  s.mid += (target.mid - s.mid) * responseBlend;
  s.highMid += (target.highMid - s.highMid) * responseBlend;
  s.presence += (target.presence - s.presence) * responseBlend;
  s.brilliance += (target.brilliance - s.brilliance) * responseBlend;
  s.air += (target.air - s.air) * responseBlend;
  return s;
}

// ========== 着色器（MR 原样，字符串拼接保留） ==========
function buildTerrainVertexShader() {
  return [
    'precision highp float;',
    '// === 手动声明 uv / normal（ShaderMaterial 默认不注入） ===',
    'attribute vec2 uv;',
    'attribute vec3 normal;',
    '// =====================================================',
    'uniform float uTime;',
    'uniform float uSubBass;',
    'uniform float uBass;',
    'uniform float uLowMid;',
    'uniform float uMid;',
    'uniform float uHighMid;',
    'uniform float uSmoothness;',
    'uniform float uDensity;',
    'uniform float uEnergy;',
    'uniform float uAmplitude;',
    'uniform vec4 uRipples[' + RIPPLE_MAX + '];',
    'varying vec2 vUv;',
    'varying float vElevation;',
    'varying float vDistance;',
    'varying vec2 vRippleAnim;',
    'varying vec3 vNormal;',
    'varying float vRelativeY;',
    'varying vec2 vInstancePos;',
    'vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}',
    'vec2 mod289(vec2 x){return x-floor(x*(1.0/289.0))*289.0;}',
    'vec3 permute(vec3 x){return mod289(((x*34.0)+1.0)*x);}',
    'float snoise(vec2 v){',
    '  const vec4 C=vec4(0.211324865405187,0.366025403784439,-0.577350269189626,0.024390243902439);',
    '  vec2 i=floor(v+dot(v,C.yy));',
    '  vec2 x0=v-i+dot(i,C.xx);',
    '  vec2 i1=(x0.x>x0.y)?vec2(1.0,0.0):vec2(0.0,1.0);',
    '  vec4 x12=x0.xyxy+C.xxzz; x12.xy-=i1;',
    '  i=mod289(i);',
    '  vec3 p=permute(permute(i.y+vec3(0.0,i1.y,1.0))+i.x+vec3(0.0,i1.x,1.0));',
    '  vec3 m=max(0.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.0);',
    '  m=m*m; m=m*m;',
    '  vec3 x=2.0*fract(p*C.www)-1.0;',
    '  vec3 h=abs(x)-0.5;',
    '  vec3 ox=floor(x+0.5);',
    '  vec3 a0=x-ox;',
    '  m*=1.79284291400159-0.85373472095314*(a0*a0+h*h);',
    '  vec3 g; g.x=a0.x*x0.x+h.x*x0.y; g.yz=a0.yz*x12.xz+h.yz*x12.yw;',
    '  return 130.0*dot(m,g);',
    '}',
    'float random(vec2 st){return fract(sin(dot(st.xy,vec2(12.9898,78.233)))*43758.5453123);}',
    'void main(){',
    '  vUv=uv;',
    '  vNormal=normal;',
    '  vec4 instancePos=instanceMatrix*vec4(0.0,0.0,0.0,1.0);',
    '  vec2 pos2D=instancePos.xz;',
    '  vInstancePos=pos2D;',
    '  float centerDist=length(pos2D);',
    '  vDistance=centerDist;',
    '  float rnd=random(pos2D);',
    '  vec2 movingPos=pos2D*0.05+vec2(uTime*0.1,uTime*0.05);',
    '  float baseNoise=(snoise(movingPos)+1.0)*0.5;',
    '  float wave=sin(pos2D.x*0.15+pos2D.y*0.1-uTime*0.6)*0.5+0.5;',
    '  float globalFalloff=smoothstep(60.0,30.0,centerDist);',
    '  float idleElevation=mix(baseNoise,wave,uSmoothness*0.5+0.2)*0.8*globalFalloff;',
    '  float subRegion=smoothstep(25.0,0.0,centerDist);',
    '  float subLift=uSubBass*subRegion*7.5;',
    '  float bassNoise=snoise(pos2D*0.1-vec2(0.0,uTime*0.2));',
    '  float bassRegion=smoothstep(35.0,5.0,centerDist+bassNoise*5.0);',
    '  float bassLift=uBass*bassRegion*(smoothstep(0.0,1.0,rnd+uDensity*0.5))*6.0;',
    '  float lowMidNoise=snoise(pos2D*0.05+vec2(uTime*0.1,0.0));',
    '  float lowMidLift=uLowMid*(lowMidNoise*0.5+0.5)*3.5;',
    '  float riverFlow=sin(pos2D.x*0.2+pos2D.y*0.2+snoise(pos2D*0.1)*2.0-uTime*2.0);',
    '  float midLift=uMid*max(0.0,riverFlow)*4.2;',
    '  float highMidRegion=smoothstep(10.0,45.0,centerDist);',
    '  float highMidLift=0.0;',
    '  if(fract(rnd*13.3)>0.8){highMidLift=uHighMid*highMidRegion*fract(rnd*7.7)*3.5;}',
    '  float audioElevation=subLift+bassLift+lowMidLift+midLift+highMidLift;',
    '  if(rnd>0.99){audioElevation+=uEnergy*7.5;}',
    '  audioElevation*=globalFalloff;',
    '  audioElevation=max(0.0,audioElevation-0.2);',
    '  audioElevation*=uAmplitude;',
    '  float elevation=idleElevation+audioElevation;',
    // rippleElevation 由下方循环累加，此处仅声明
    '  float rippleElevation=0.0;',
    '  float rippleIntensityNormal=0.0;',
    '  float rippleIntensityWhite=0.0;',
    '  for(int i=0;i<' + RIPPLE_MAX + ';i++){',
    '    vec4 rd=uRipples[i];',
    '    if(rd.w!=0.0){',
    '      float strength=abs(rd.w);',
    '      bool whiteRipple=rd.w<0.0;',
    '      float dist=length(pos2D-rd.xy);',
    '      float timeSince=uTime-rd.z;',
    '      float curSpeed=whiteRipple?18.0:13.0;',
    '      float curWidth=whiteRipple?1.35:5.5;',
    '      float curFadeDist=whiteRipple?12.0:26.0;',
    '      float elevationScale=whiteRipple?1.15:3.35;',
    '      float waveRadius=timeSince*curSpeed;',
    '      float d=dist-waveRadius;',
    '      float rippleWave=exp(-d*d/curWidth);',
    '      float fade=exp(-waveRadius/curFadeDist);',
    '      float lifeFade=1.0-smoothstep(2.10,4.80,timeSince);',
    '      float rPulse=rippleWave*fade*lifeFade*strength;',
    '      rippleElevation+=rPulse*elevationScale*1.6;',
    '      if(whiteRipple){rippleIntensityWhite+=rPulse;}else{rippleIntensityNormal+=rPulse;}',
    '    }',
    '  }',
    '  elevation+=rippleElevation;',
    '  vRippleAnim=vec2(clamp(rippleIntensityNormal,0.0,1.0),clamp(rippleIntensityWhite,0.0,1.0));',
    '  vElevation=elevation;',
    '  float yPos=position.y+0.5;',
    '  vRelativeY=yPos;',
    '  float totalHeight=1.0+elevation;',
    '  vec3 pos=position;',
    '  pos.y=-0.5+yPos*totalHeight;',
    '  vec4 worldPosition=modelMatrix*instanceMatrix*vec4(pos,1.0);',
    '  gl_Position=projectionMatrix*viewMatrix*worldPosition;',
    '}',
  ].join('\n');
}

function buildTerrainFragmentShader() {
  return [
    'precision highp float;',
    'uniform float uTime;',
    'uniform float uPresence;',
    'uniform float uBrilliance;',
    'uniform float uAir;',
    'uniform float uWarmth;',
    'uniform float uBrightness;',
    'uniform float uSharpness;',
    'uniform vec3 uBaseColor1;',
    'uniform vec3 uBaseColor2;',
    'uniform vec3 uFogColor;',
    'uniform vec3 uCoolCore;',
    'uniform vec3 uCoolEdge;',
    'uniform vec3 uWarmCore;',
    'uniform vec3 uWarmEdge;',
    'uniform vec3 uRippleColor;',
    'uniform float uGlowIntensity;',
    'varying vec2 vUv;',
    'varying float vElevation;',
    'varying float vDistance;',
    'varying vec2 vRippleAnim;',
    'varying vec3 vNormal;',
    'varying float vRelativeY;',
    'varying vec2 vInstancePos;',
    'float random(vec2 st){return fract(sin(dot(st.xy,vec2(12.9898,78.233)))*43758.5453123);}',
    'void main(){',
    '  bool isTop=vNormal.y>0.5;',
    '  float distFromTop=1.0-vRelativeY;',
    '  float rnd=random(vInstancePos);',
    '  float centerDist=length(vInstancePos);',
    '  float normElevation=clamp(vElevation/8.0,0.0,1.0);',
    '  vec3 cBase1=uBaseColor1;',
    '  vec3 cBase2=uBaseColor2;',
    '  float warmBlend=smoothstep(0.0,1.0,uWarmth*1.5+(0.5-centerDist/80.0));',
    '  vec3 zoneCore=mix(uCoolCore,uWarmCore,warmBlend);',
    '  vec3 zoneEdge=mix(uCoolEdge,uWarmEdge,warmBlend);',
    '  vec3 targetGlow=mix(zoneCore,zoneEdge,fract(rnd*11.0));',
    '  float distFade=1.0-smoothstep(40.0,75.0,centerDist);',
    '  vec3 brightCool=mix(uCoolCore,vec3(1.0),0.24);',
    '  targetGlow=mix(targetGlow,brightCool,uBrightness*0.6);',
    '  vec3 currentGlow=mix(cBase2,targetGlow,normElevation)*uGlowIntensity*distFade;',
    '  currentGlow=mix(currentGlow,uRippleColor,clamp(vRippleAnim.x*0.82,0.0,0.72));',
    '  currentGlow=mix(currentGlow,vec3(1.0),vRippleAnim.y);',
    '  vec3 bodyColor=mix(cBase1,cBase2,vRelativeY*distFade);',
    '  // 保底可见性：即使音频全0也能看到地形轮廓（不依赖normElevation）',
    '  vec3 baseSilhouette = mix(cBase2, zoneCore, 0.4) * (0.8 + distFade * 0.6);',
    '  bodyColor = bodyColor + baseSilhouette * 0.8;',
    '  vec3 finalColor;',
    '  if(isTop){',
    '    float topIntensity=smoothstep(0.0,0.4,normElevation);',
    '    // 顶面保底：始终有一层发光底，保证静止时可见',
    '    topIntensity = max(topIntensity, 0.45 * distFade);',
    '    float twinkleDistFalloff=smoothstep(60.0,30.0,centerDist);',
    '    float twinkleMultiplier=mix(twinkleDistFalloff,1.0,smoothstep(0.01,0.1,normElevation));',
    '    if(fract(rnd*31.0)>0.95&&normElevation<0.1){topIntensity+=uAir*2.0*twinkleMultiplier;}',
    '    finalColor=mix(cBase2,currentGlow,topIntensity);',
    '    float edgeX=smoothstep(0.05,0.01,vUv.x)+smoothstep(0.95,0.99,vUv.x);',
    '    float edgeY=smoothstep(0.05,0.01,vUv.y)+smoothstep(0.95,0.99,vUv.y);',
    '    float edge=min(edgeX+edgeY,1.0);',
    '    finalColor+=currentGlow*edge*1.2*(topIntensity+0.5);',
    '    // 保底轮廓光：即使音频全0，顶面边缘也有一层发光，保证能看到网格形状',
    '    vec3 edgeOutlineColor = zoneCore * 1.2 * distFade;',
    '    float outlineEdgeX = smoothstep(0.06, 0.0, vUv.x) + smoothstep(0.94, 1.0, vUv.x);',
    '    float outlineEdgeY = smoothstep(0.06, 0.0, vUv.y) + smoothstep(0.94, 1.0, vUv.y);',
    '    float outlineEdge = min(outlineEdgeX + outlineEdgeY, 1.0);',
    '    finalColor += edgeOutlineColor * outlineEdge * 2.0;',
    '    float flashChance=smoothstep(0.3,1.0,uPresence);',
    '    if(fract(rnd*53.0)>0.98-flashChance*0.1){',
    '      float flashSync=sin(uTime*40.0+rnd*100.0)*0.5+0.5;',
    '      finalColor+=mix(vec3(1.0),vec3(0.5,1.0,1.0),rnd)*flashSync*uPresence*(1.0+uSharpness*2.0)*twinkleMultiplier;',
    '    }',
    '    if(edge>0.5&&fract(rnd*89.0+uTime*2.0)>0.98){finalColor+=vec3(1.0)*uBrilliance*3.0*twinkleMultiplier;}',
    '  }else{',
    '    float verticalFalloff=mix(1.0,3.0,uSharpness);',
    '    float sideGlow=smoothstep(0.5/verticalFalloff,0.0,distFromTop)*max(normElevation, 0.08);',
    '    finalColor=mix(bodyColor,currentGlow,sideGlow*1.5);',
    '    float rimGlow=smoothstep(0.03,0.0,distFromTop)*max(normElevation, 0.12);',
    '    finalColor+=currentGlow*rimGlow*0.6;',
    '    // 保底侧面轮廓光：柱子顶部边缘一圈常亮光，静止时勾勒网格轮廓',
    '    vec3 sideOutlineColor = zoneCore * 0.9 * distFade;',
    '    float sideOutlineTop = smoothstep(0.08, 0.0, distFromTop);',
    '    finalColor += sideOutlineColor * sideOutlineTop * 1.5;',
    '    // 侧面水平边缘（柱子的上下横线）也加微光',
    '    float sideEdgeX = smoothstep(0.05, 0.0, vUv.x) + smoothstep(0.95, 1.0, vUv.x);',
    '    finalColor += sideOutlineColor * sideEdgeX * 0.7;',
    '  }',
    '  finalColor+=uRippleColor*vRippleAnim.x*0.86;',
    '  finalColor+=vec3(1.0)*vRippleAnim.y*1.2;',
    '  float aerialFog=smoothstep(30.0,65.0,vDistance);',
    '  vec3 atmosphericColor=mix(cBase1,cBase2,0.4);',
    '  finalColor=mix(finalColor,atmosphericColor,aerialFog*0.35);',
    '  float alphaFade=1.0-smoothstep(55.0,78.0,vDistance);',
    '  float alphaBlend=1.0-alphaFade;',
    '  finalColor=mix(finalColor,uFogColor,alphaBlend*0.45);',
    '  gl_FragColor=vec4(finalColor,alphaFade);',
    '}',
  ].join('\n');
}

function buildFloatingVertexShader() {
  return [
    'precision highp float;',
    '// === 手动声明 uv / normal（ShaderMaterial 默认不注入） ===',
    'attribute vec2 uv;',
    'attribute vec3 normal;',
    '// =====================================================',
    'uniform float uPulse;',
    'varying vec2 vUv;',
    'varying float vElevation;',
    'varying float vDistance;',
    'varying vec2 vRippleAnim;',
    'varying vec3 vNormal;',
    'varying float vRelativeY;',
    'varying vec2 vInstancePos;',
    'void main(){',
    '  vUv=uv;',
    '  vNormal=normal;',
    '  vec4 instancePos=instanceMatrix*vec4(0.0,0.0,0.0,1.0);',
    '  vec2 pos2D=instancePos.xz;',
    '  vInstancePos=pos2D;',
    '  vDistance=length(pos2D);',
    '  vRippleAnim=vec2(uPulse*0.8,uPulse*0.3);',
    '  vElevation=uPulse*20.0;',
    '  vRelativeY=position.y+0.5;',
    '  vec4 worldPosition=modelMatrix*instanceMatrix*vec4(position,1.0);',
    '  gl_Position=projectionMatrix*viewMatrix*worldPosition;',
    '}',
  ].join('\n');
}

function buildFloatingFragmentShader() {
  return buildTerrainFragmentShader();
}

function makeRippleUniforms(THREE: any) {
  const arr: any[] = [];
  for (let i = 0; i < RIPPLE_MAX; i++) arr.push(new THREE.Vector4(0, 0, -100, 0));
  return arr;
}

function makeTerrainUniforms(THREE: any) {
  return {
    uTime: { value: 0 },
    uSubBass: { value: 0 },
    uBass: { value: 0 },
    uLowMid: { value: 0 },
    uMid: { value: 0 },
    uHighMid: { value: 0 },
    uPresence: { value: 0 },
    uBrilliance: { value: 0 },
    uAir: { value: 0 },
    uWarmth: { value: 0 },
    uBrightness: { value: 0 },
    uSharpness: { value: 0 },
    uSmoothness: { value: 0 },
    uDensity: { value: 0 },
    uEnergy: { value: 0 },
    uAmplitude: { value: 1 },
    uRipples: { value: makeRippleUniforms(THREE) },
    uBaseColor1: { value: new THREE.Color(0.01, 0.02, 0.04) },
    uBaseColor2: { value: new THREE.Color(0.03, 0.05, 0.09) },
    uFogColor: { value: new THREE.Color(0.01, 0.02, 0.04) },
    uCoolCore: { value: new THREE.Color(0.0, 0.3, 1.0) },
    uCoolEdge: { value: new THREE.Color(0.6, 0.2, 1.0) },
    uWarmCore: { value: new THREE.Color(1.0, 0.2, 0.1) },
    uWarmEdge: { value: new THREE.Color(1.0, 0.6, 0.0) },
    uRippleColor: { value: new THREE.Color(0.2, 0.9, 1.0) },
    uGlowIntensity: { value: 1 },
  };
}

function makeFloatingUniforms(THREE: any) {
  const uniforms = makeTerrainUniforms(THREE);
  (uniforms as any).uPulse = { value: 0 };
  return uniforms;
}

// ========== 数据初始化 ==========
function initData(floatingCount: number) {
  let i: number;
  state.ripples = [];
  for (i = 0; i < RIPPLE_MAX; i++) state.ripples.push({ x: 0, z: 0, start: -100, strength: 0, white: false });
  // 歌词涟漪全局开关（shader 编译失败兜底时关闭）
  state.lyricRippleDisabled = false;
  state.meteorsData = [];
  for (i = 0; i < METEOR_MAX; i++) state.meteorsData.push({ active: false, x: 0, y: -1000, z: 0, speed: 0, strength: 0 });
  state.trailsData = [];
  for (i = 0; i < TRAIL_MAX; i++) {
    state.trailsData.push({ active: false, x: 0, y: -1000, z: 0, vx: 0, vy: 0, vz: 0, life: 0, maxLife: 1, scale: 1 });
  }
  state.floatingData = [];
  floatingCount = Math.max(0, Math.round(Number(floatingCount) || 0));
  for (i = 0; i < floatingCount; i++) {
    const ring = i / Math.max(1, floatingCount);
    const angle = ring * Math.PI * 2 * 5.0 + Math.sin(i * 12.9898) * 0.7;
    const radius = 14 + ((i * 37) % 62);
    const height = 6 + ((i * 17) % 19);
    state.floatingData.push({
      x: Math.cos(angle) * radius,
      z: Math.sin(angle) * radius,
      y: height,
      baseScale: 0.75 + ((i * 11) % 9) * 0.05,
      phase: i * 0.73,
      rotationSpeed: 0.18 + ((i * 7) % 10) * 0.035,
    });
  }
}

// ========== 网格构建 ==========
function buildTerrainMesh(THREE: any, settings: any) {
  const geo = new THREE.BoxGeometry(settings.boxWidth, 1, settings.boxWidth);
  const mat = new THREE.ShaderMaterial({
    uniforms: makeTerrainUniforms(THREE),
    vertexShader: buildTerrainVertexShader(),
    fragmentShader: buildTerrainFragmentShader(),
    transparent: true,
    depthWrite: true,
    depthTest: true,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, settings.instanceCount);
  mesh.frustumCulled = false;
  const offset = (settings.gridSize * settings.spacing) / 2;
  let n = 0;
  for (let x = 0; x < settings.gridSize; x++) {
    for (let z = 0; z < settings.gridSize; z++) {
      state.dummyMat4.makeTranslation(x * settings.spacing - offset, 0.5, z * settings.spacing - offset);
      mesh.setMatrixAt(n++, state.dummyMat4);
    }
  }
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

function buildFloatingBlocksMesh(THREE: any, count: number) {
  count = Math.max(0, Math.round(Number(count) || 0));
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.ShaderMaterial({
    uniforms: makeFloatingUniforms(THREE),
    vertexShader: buildFloatingVertexShader(),
    fragmentShader: buildFloatingFragmentShader(),
    transparent: true,
    depthWrite: false,
    depthTest: true,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  mesh.frustumCulled = false;
  return mesh;
}

function buildSimpleInstanced(THREE: any, count: number, size: number[], color: number, opacity: number | null) {
  const geo = new THREE.BoxGeometry(size[0], size[1], size[2]);
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: opacity == null ? 1 : opacity,
    depthWrite: false,
    toneMapped: false,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  mesh.frustumCulled = false;
  for (let i = 0; i < count; i++) {
    state.dummyScale.set(0, 0, 0);
    state.dummyMat4.compose(state.dummyPos.set(0, -1000, 0), state.dummyQuat, state.dummyScale);
    mesh.setMatrixAt(i, state.dummyMat4);
  }
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

function applyLayout(fx: any) {
  if (!state.root) return;
  const layout = deriveGroundLayoutSettings(fx || {});
  // root 负责整体平移 + 缩放，不参与自转
  state.root.rotation.x = state.boundRotX;
  state.root.rotation.z = 0;
  state.root.position.set(0, layout.y, layout.z);
  state.root.scale.setScalar(layout.scale);
  // 自转由 rotationGroup 承担，绕地形自身几何中心（x=0, z=0）的竖直轴旋转
  // 这样地形原地平稳旋转，不会绕世界原点画弧产生偏心摆动
  if (state.rotationGroup) {
    state.rotationGroup.rotation.y = state.boundRotY + state.autoYaw;
  }
}

function updateSonicRotation(fx: any, dt: number) {
  const autoRotate = sonicNumber(fx, 'sonicGroundAutoRotate', DEFAULT_GROUND_AUTO_ROTATE, 0, 100);
  const speed = lerp(0, 0.30, autoRotate / 100) * clamp(fx?.speed || 1, 0.35, 1.8);
  state.manualYaw *= Math.pow(0.001, Math.max(0.001, dt || 1 / 60));
  state.autoYaw += dt * speed;
}

function ensureLayer(THREE: any, scene: any, fx: any, quality: string) {
  const settings = deriveTerrainGridSettings(fx, quality);
  if (state.initialized && state.gridSize === settings.gridSize && state.floatingCount === settings.floatingCount) return;
  clearLayer();
  state.scene = scene;
  state.gridSize = settings.gridSize;
  state.gridSpacing = settings.spacing;
  state.floatingCount = settings.floatingCount;
  state.dummyObj = new THREE.Object3D();
  state.dummyPos = new THREE.Vector3();
  state.dummyQuat = new THREE.Quaternion();
  state.dummyScale = new THREE.Vector3();
  state.dummyMat4 = new THREE.Matrix4();
  state.dummyEuler = new THREE.Euler();
  initData(settings.floatingCount);
  state.root = new THREE.Group();
  state.root.name = 'sonic-topography-root';
  // 旋转轴心组：原点对齐地形网格几何中心（x=0, z=0，y 在地面基准面上方 0.5）
  // 自转绕自身中心竖直轴进行，保证地形原地平稳旋转、不画弧偏心
  state.rotationGroup = new THREE.Group();
  state.rotationGroup.name = 'sonic-rotation-group';
  state.root.add(state.rotationGroup);
  state.terrain = buildTerrainMesh(THREE, settings);
  state.terrainMat = state.terrain.material;
  state.rotationGroup.add(state.terrain);
  state.floatingBlocks = buildFloatingBlocksMesh(THREE, settings.floatingCount);
  state.floatingMat = state.floatingBlocks.material;
  state.rotationGroup.add(state.floatingBlocks);
  state.meteors = buildSimpleInstanced(THREE, METEOR_MAX, [0.4, 1.2, 0.4], 0xffffff, 1);
  state.meteorMat = state.meteors.material;
  state.rotationGroup.add(state.meteors);
  state.trails = buildSimpleInstanced(THREE, TRAIL_MAX, [0.8, 0.8, 0.8], 0xa8ecff, 0.6);
  state.trailMat = state.trails.material;
  state.rotationGroup.add(state.trails);
  state.root.visible = true;
  applyLayout(fx);
  scene.add(state.root);
  state.initialized = true;
}

function colorUniformLerp(uniform: any, target: any, alpha: number) {
  if (!uniform || !uniform.value) return;
  uniform.value.lerp(target, alpha);
}

function syncTheme(THREE: any, mat: any, fx: any, audio: any, dt: number) {
  if (!mat) return;
  const u = mat.uniforms;
  const lerpSpeed = blend01(3.0 * Math.max(0.001, dt || 1 / 60));
  // 只使用 custom 颜色模式（与设置面板用户选择的颜色对应）
  const theme = sonicCustomGroundTheme(THREE, fx);
  const base1 = theme.base1;
  const base2 = theme.base2;
  const coolCore = theme.coolCore;
  const coolEdge = coolCore.clone().lerp(base1, 0.34);
  const warmCore = theme.warmCore;
  const warmEdge = warmCore.clone().lerp(base1, 0.26);
  const ripple = theme.ripple;
  colorUniformLerp(u.uBaseColor1, base1, lerpSpeed);
  colorUniformLerp(u.uBaseColor2, base2, lerpSpeed);
  colorUniformLerp(u.uFogColor, base1, lerpSpeed);
  colorUniformLerp(u.uCoolCore, coolCore, lerpSpeed);
  colorUniformLerp(u.uCoolEdge, coolEdge, lerpSpeed);
  colorUniformLerp(u.uWarmCore, warmCore, lerpSpeed);
  colorUniformLerp(u.uWarmEdge, warmEdge, lerpSpeed);
  colorUniformLerp(u.uRippleColor, ripple, lerpSpeed);
  const glow = sonicNumber(fx, 'sonicGroundGlow', DEFAULT_GROUND_GLOW, 0, 100);
  u.uGlowIntensity.value = lerp(u.uGlowIntensity.value, clamp(0.55 + glow * 0.014 + ((fx && fx.bloomStrength) || 0) * 0.22, 0.45, 2.2), lerpSpeed);
  const low = audio.subBass + audio.bass + audio.lowMid + audio.mid;
  const high = audio.presence + audio.brilliance + audio.air;
  const sum = Math.max(0.001, low + high);
  u.uWarmth.value = clamp(low / sum, 0, 1);
  u.uBrightness.value = clamp(high / sum, 0, 1);
  u.uSharpness.value = audio.sharpness;
  u.uSmoothness.value = audio.smoothness;
  u.uDensity.value = audio.density;
  if (state.meteorMat) state.meteorMat.color.copy(warmCore).lerp(new THREE.Color(0xffffff), 0.7);
  if (state.trailMat) state.trailMat.color.copy(ripple);
}

function syncTerrainUniforms(THREE: any, fx: any, audio: any, dt: number, time: number) {
  if (!state.terrainMat) return;
  const bands = readBands(fx);
  const kickLow = deriveKickFollowLowBands(audio, bands);
  const target = {
    subBass: kickLow.subBass,
    bass: kickLow.bass,
    lowMid: applyGroundEqBandValue(audio.lowMid, bands, 2, 1),
    mid: applyGroundEqBandValue(audio.mid, bands, 3, 1),
    highMid: applyGroundEqBandValue(audio.highMid, bands, 4, 1),
    presence: applyGroundEqBandValue(audio.presence, bands, 5, 1),
    brilliance: applyGroundEqBandValue(audio.brilliance, bands, 6, 1),
    air: applyGroundEqBandValue(audio.air, bands, 7, 1),
  };
  const smoothed = smoothGroundAudio(target, fx, dt);
  const u = state.terrainMat.uniforms;
  const eqAverage = bands.reduce((sum: number, value: number) => sum + value, 0) / Math.max(1, bands.length);
  const eqEnergy = clamp(audio.energy * (0.25 + (eqAverage / 50) * 0.75), 0, 1);
  const amplitude = sonicNumber(fx, 'sonicGroundAmplitude', DEFAULT_GROUND_AMPLITUDE, 0, 100);
  // 提升可视幅度：基准放大 1.6 倍，高音区适度加强，确保鼓点弹跳肉眼可见
  // 算法结构保持 MR 原版（分段二次曲线），仅整体增益与上抬系数微调
  const baseGain = 1.6;
  const ampMul = amplitude <= 50
    ? (amplitude / 50) * baseGain
    : baseGain + Math.pow((amplitude - 50) / 50, 2) * 18;
  u.uTime.value = time;
  u.uSubBass.value = smoothed.subBass;
  u.uBass.value = smoothed.bass;
  u.uLowMid.value = smoothed.lowMid;
  u.uMid.value = smoothed.mid;
  u.uHighMid.value = smoothed.highMid;
  u.uPresence.value = smoothed.presence;
  u.uBrilliance.value = smoothed.brilliance;
  u.uAir.value = smoothed.air;
  u.uEnergy.value = eqEnergy;
  u.uAmplitude.value = ampMul;
  syncTheme(THREE, state.terrainMat, fx, {
    subBass: smoothed.subBass,
    bass: smoothed.bass,
    lowMid: smoothed.lowMid,
    mid: smoothed.mid,
    presence: smoothed.presence,
    brilliance: smoothed.brilliance,
    air: smoothed.air,
    sharpness: audio.sharpness,
    smoothness: audio.smoothness,
    density: audio.density,
  }, dt);
  syncRippleUniforms(time);
  if (state.floatingMat) {
    syncTheme(THREE, state.floatingMat, fx, {
      subBass: smoothed.subBass,
      bass: smoothed.bass,
      lowMid: smoothed.lowMid,
      mid: smoothed.mid,
      presence: smoothed.presence,
      brilliance: smoothed.brilliance,
      air: smoothed.air,
      sharpness: audio.sharpness,
      smoothness: audio.smoothness,
      density: audio.density,
    }, dt);
    state.floatingMat.uniforms.uTime.value = time;
    state.floatingMat.uniforms.uPulse.value = state.floatingPulse;
  }
}

function syncRippleUniforms(time: number) {
  if (!state.terrainMat) return;
  const arr = state.terrainMat.uniforms.uRipples.value;
  for (let i = 0; i < RIPPLE_MAX; i++) {
    const r = state.ripples[i];
    const age = time - r.start;
    const active = r.strength > 0.001 && age >= 0 && age < RIPPLE_LIFETIME;
    if (!active) {
      arr[i].set(0, 0, -100, 0);
      if (r.strength > 0) r.strength = 0;
      continue;
    }
    const fade = 1 - smoothstep01((age - RIPPLE_SOFT_FADE_START) / (RIPPLE_LIFETIME - RIPPLE_SOFT_FADE_START));
    const strength = r.strength * fade;
    arr[i].set(r.x, r.z, r.start, r.white ? -strength : strength);
  }
}

function addRipple(x: number, z: number, strength: number, white: boolean) {
  const idx = state.rippleIdx;
  const r = state.ripples[idx];
  r.x = x;
  r.z = z;
  r.start = state.sonicTime;
  r.strength = clamp(strength, 0.1, 3.0);
  r.white = !!white;
  state.rippleIdx = (idx + 1) % RIPPLE_MAX;
}

function addMeteor(strength: number) {
  const now = state.sonicTime;
  if (now - state.lastMeteorAt < 0.55) return;
  state.lastMeteorAt = now;
  const idx = state.meteorIdx;
  const angle = Math.random() * Math.PI * 2;
  const dist = Math.random() * 25;
  const m = state.meteorsData[idx];
  m.active = true;
  m.x = Math.cos(angle) * dist;
  m.z = Math.sin(angle) * dist;
  m.y = 30 + Math.random() * 10;
  m.speed = 1.0 + Math.random() * 0.5 + strength * 1.5;
  m.strength = strength;
  state.meteorIdx = (idx + 1) % METEOR_MAX;
}

function spawnTrail(x: number, y: number, z: number, speedMul: number) {
  const idx = state.trailIdx;
  const p = state.trailsData[idx];
  p.active = true;
  p.x = x + (Math.random() - 0.5) * 1.5;
  p.y = y + (Math.random() - 0.5) * 1.5;
  p.z = z + (Math.random() - 0.5) * 1.5;
  p.vx = (Math.random() - 0.5) * 2.0;
  p.vy = Math.random() * 2.0 + speedMul * 10.0;
  p.vz = (Math.random() - 0.5) * 2.0;
  p.life = 0;
  p.maxLife = 0.5 + Math.random() * 0.5;
  p.scale = Math.random() * 0.6 + 0.2;
  state.trailIdx = (idx + 1) % TRAIL_MAX;
}

function updateAudioTriggers(audio: any) {
  const kickActive = audio.kickEnvelope > 0.58;
  if (kickActive && !state.lastKickActive) {
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.random() * 20;
    addRipple(Math.cos(angle) * dist, Math.sin(angle) * dist, Math.min(audio.kickEnvelope * 2.0, 3.0), false);
  }
  state.lastKickActive = audio.kickEnvelope > 0.32;
  const snareActive = audio.presence > 0.52 || audio.brilliance > 0.56;
  if (snareActive && !state.lastSnareActive && Math.random() < 0.55) {
    const angle2 = Math.random() * Math.PI * 2;
    const dist2 = 10 + Math.random() * 35;
    addRipple(Math.cos(angle2) * dist2, Math.sin(angle2) * dist2, Math.min((audio.presence + audio.brilliance) * 1.2, 3.0), true);
  }
  state.lastSnareActive = audio.presence > 0.38 || audio.brilliance > 0.42;
  if (audio.kickEnvelope > 0.62 && Math.random() < 0.045) addMeteor(clamp(audio.kickEnvelope, 0.28, 0.9));
}

function updateFloatingBlocks(fx: any, audio: any, dt: number, time: number) {
  if (!state.floatingBlocks) return;
  const enabledScale = fx && fx.sonicGroundFloatingEnabled === false ? 0 : 1;
  const intensity = sonicNumber(fx, 'sonicGroundFloatingIntensity', DEFAULT_FLOATING_BLOCK_INTENSITY, 0, 100) / 100;
  const minSize = sonicNumber(fx, 'sonicGroundFloatingMinSize', DEFAULT_FLOATING_BLOCK_MIN_SIZE, 0, 100);
  const maxSize = Math.max(minSize, sonicNumber(fx, 'sonicGroundFloatingMaxSize', DEFAULT_FLOATING_BLOCK_MAX_SIZE, 0, 100));
  const speed = sonicNumber(fx, 'sonicGroundFloatingSpeed', DEFAULT_FLOATING_BLOCK_SPEED, 0, 100);
  const speedRate = lerp(3.0, 36.0, speed / 100);
  const pulseBlend = blend01(1 - Math.exp(-speedRate * Math.max(0.001, dt || 1 / 60)));
  state.floatingPulse += (clamp01(audio.kickEnvelope) - state.floatingPulse) * pulseBlend;
  const pulse = state.floatingPulse;
  const minVisualScale = lerp(0.12, 0.75, minSize / 100);
  const maxVisualScale = Math.max(minVisualScale + 0.05, lerp(0.45, 3.2, maxSize / 100));
  const sizeMix = clamp(pulse * (0.5 + intensity * 1.7), 0, 1);
  const pulseScale = lerp(minVisualScale, maxVisualScale, sizeMix);
  for (let i = 0; i < state.floatingData.length; i++) {
    const b = state.floatingData[i];
    const bob = Math.sin(time * (0.55 + b.rotationSpeed) + b.phase) * 0.45;
    state.dummyPos.set(b.x, b.y + bob + pulse * intensity * 1.4, b.z);
    state.dummyEuler.set(
      time * b.rotationSpeed + b.phase,
      time * b.rotationSpeed * 0.7 + b.phase,
      time * b.rotationSpeed * 0.45,
    );
    state.dummyQuat.setFromEuler(state.dummyEuler);
    const scale = b.baseScale * pulseScale * enabledScale;
    state.dummyScale.set(scale, scale, scale);
    state.dummyMat4.compose(state.dummyPos, state.dummyQuat, state.dummyScale);
    state.floatingBlocks.setMatrixAt(i, state.dummyMat4);
  }
  state.floatingBlocks.instanceMatrix.needsUpdate = true;
}

function updateMeteorsAndTrails(dt: number) {
  if (!state.meteors || !state.trails) return;
  let i: number;
  for (i = 0; i < METEOR_MAX; i++) {
    const m = state.meteorsData[i];
    if (!m.active) {
      state.dummyPos.set(0, -1000, 0);
      state.dummyScale.set(0, 0, 0);
    } else {
      m.y -= m.speed * 60 * dt;
      if (m.y <= 0) {
        m.active = false;
        addRipple(m.x, m.z, Math.min(m.strength, 1.2), true);
        for (let t = 0; t < 10; t++) spawnTrail(m.x, 0.5, m.z, m.speed * 1.5);
        state.dummyPos.set(0, -1000, 0);
        state.dummyScale.set(0, 0, 0);
      } else {
        if (Math.random() > 0.3) spawnTrail(m.x, m.y, m.z, m.speed * 0.2);
        state.dummyPos.set(m.x, Math.max(0, m.y), m.z);
        state.dummyScale.set(1.5, 1.5, 1.5);
      }
    }
    state.dummyQuat.identity();
    state.dummyMat4.compose(state.dummyPos, state.dummyQuat, state.dummyScale);
    state.meteors.setMatrixAt(i, state.dummyMat4);
  }
  state.meteors.instanceMatrix.needsUpdate = true;
  for (i = 0; i < TRAIL_MAX; i++) {
    const p = state.trailsData[i];
    if (!p.active) {
      state.dummyPos.set(0, -1000, 0);
      state.dummyScale.set(0, 0, 0);
    } else {
      p.life += dt;
      if (p.life >= p.maxLife) {
        p.active = false;
        state.dummyScale.set(0, 0, 0);
      } else {
        p.x += p.vx * dt * 10;
        p.y += p.vy * dt * 10;
        p.z += p.vz * dt * 10;
        const s = p.scale * (1.0 - p.life / p.maxLife);
        state.dummyPos.set(p.x, p.y, p.z);
        state.dummyScale.set(s, s, s);
      }
    }
    state.dummyQuat.identity();
    state.dummyMat4.compose(state.dummyPos, state.dummyQuat, state.dummyScale);
    state.trails.setMatrixAt(i, state.dummyMat4);
  }
  state.trails.instanceMatrix.needsUpdate = true;
}

function disposeMesh(mesh: any) {
  if (!mesh) return;
  if (mesh.geometry) mesh.geometry.dispose?.();
  // InstancedMesh 的 instanceMatrix 是独立的 GPU BufferAttribute，
  // 不会随 geometry.dispose() 释放，必须手动 dispose 防止显存泄漏
  if (mesh.instanceMatrix) mesh.instanceMatrix.dispose?.();
  if (mesh.instanceColor) mesh.instanceColor.dispose?.();
  if (mesh.material) {
    if (Array.isArray(mesh.material)) {
      mesh.material.forEach((m: any) => m.dispose?.());
    } else {
      mesh.material.dispose?.();
    }
  }
}

function clearLayer() {
  if (state.root && state.scene) state.scene.remove(state.root);
  disposeMesh(state.terrain);
  disposeMesh(state.floatingBlocks);
  disposeMesh(state.meteors);
  disposeMesh(state.trails);
  state.root = null;
  state.rotationGroup = null;
  state.terrain = null;
  state.terrainMat = null;
  state.floatingBlocks = null;
  state.floatingMat = null;
  state.meteors = null;
  state.meteorMat = null;
  state.trails = null;
  state.trailMat = null;
  state.initialized = false;
  state.orbitThetaReady = false;
  state.opacity = 0;
  state.floatingCount = DEFAULT_FLOATING_BLOCK_COUNT;
}

// ========== 对外接口 ==========
export interface SonicTopographyMR {
  root: any;
  update: (freq: Uint8Array | null, dt: number, sampleRate: number, fftSize?: number) => void;
  dispose: () => void;
  updateParams: (fx: any) => void;
  rebuild: (fx: any, quality?: string) => void;
  triggerLyricRipple: (intensity?: number, whiteRipple?: boolean, count?: number) => void;
  setLyricRippleParams: (params: { colorMode?: 'accent' | 'lyric' | 'warm'; rippleColor?: string }) => void;
  /** 启用/禁用歌词涟漪（shader 编译失败兜底用） */
  setLyricRippleEnabled: (enabled: boolean) => void;
}

export function createSonicTopographyMR(THREE: any, params: any, quality = 'balanced'): SonicTopographyMR {
  // 把外部参数转成 MR 的 fx 格式（key 对应 MR 的 sonicGroundXxx）
  const buildFx = (p: any): any => ({
    sonicGroundAmplitude: p.amplitude ?? DEFAULT_GROUND_AMPLITUDE,
    sonicGroundMotionSpeed: p.motionSpeed ?? DEFAULT_GROUND_MOTION_SPEED,
    sonicGroundDensity: p.density ?? DEFAULT_TERRAIN_DENSITY,
    sonicGroundRange: p.range ?? DEFAULT_GROUND_RANGE,
    sonicGroundLower: p.lower ?? DEFAULT_GROUND_LOWER,
    sonicGroundDepth: p.depth ?? DEFAULT_GROUND_DEPTH,
    sonicGroundAutoRotate: p.autoRotate ?? DEFAULT_GROUND_AUTO_ROTATE,
    sonicGroundGlow: p.glow ?? DEFAULT_GROUND_GLOW,
    sonicGroundBaseColor: p.baseColor ?? DEFAULT_GROUND_BASE_COLOR,
    sonicGroundCoolColor: p.coolColor ?? DEFAULT_GROUND_COOL_COLOR,
    sonicGroundWarmColor: p.warmColor ?? DEFAULT_GROUND_WARM_COLOR,
    sonicGroundAccentColor: p.accentColor ?? DEFAULT_GROUND_ACCENT_COLOR,
    sonicGroundColorMode: 'custom',
    sonicGroundFloatingEnabled: p.floatingEnabled !== false,
    sonicGroundFloatingIntensity: p.floatingIntensity ?? DEFAULT_FLOATING_BLOCK_INTENSITY,
    sonicGroundFloatingMinSize: p.floatingMinSize ?? DEFAULT_FLOATING_BLOCK_MIN_SIZE,
    sonicGroundFloatingMaxSize: p.floatingMaxSize ?? DEFAULT_FLOATING_BLOCK_MAX_SIZE,
    sonicGroundFloatingSpeed: p.floatingSpeed ?? DEFAULT_FLOATING_BLOCK_SPEED,
    sonicGroundFloatingCount: p.floatingCount ?? DEFAULT_FLOATING_BLOCK_COUNT,
    sonicGroundSubBass: p.eq?.[0] ?? DEFAULT_GROUND_BANDS[0],
    sonicGroundBass: p.eq?.[1] ?? DEFAULT_GROUND_BANDS[1],
    sonicGroundLowMid: p.eq?.[2] ?? DEFAULT_GROUND_BANDS[2],
    sonicGroundMid: p.eq?.[3] ?? DEFAULT_GROUND_BANDS[3],
    sonicGroundHighMid: p.eq?.[4] ?? DEFAULT_GROUND_BANDS[4],
    sonicGroundPresence: p.eq?.[5] ?? DEFAULT_GROUND_BANDS[5],
    sonicGroundBrilliance: p.eq?.[6] ?? DEFAULT_GROUND_BANDS[6],
    sonicGroundAir: p.eq?.[7] ?? DEFAULT_GROUND_BANDS[7],
    performanceQuality: quality,
    bloomStrength: 0,
    visualTintColor: p.accentColor ?? DEFAULT_GROUND_ACCENT_COLOR,
    visualTintMode: 'off',
    speed: 1,
  });

  let currentFx = buildFx(params);

  // 延迟初始化：第一次 update 且有 scene 时才创建
  let sceneRef: any = null;

  const api: SonicTopographyMR = {
    get root() {
      // 外部需要引用 root 时触发初始化
      if (!state.initialized && sceneRef) {
        ensureLayer(THREE, sceneRef, currentFx, quality);
      }
      return state.root;
    },
    update(freq, dt, sampleRate, fftSize = 2048) {
      state.sonicTime += dt * (0.45 + sonicNumber(currentFx, 'sonicGroundMotionSpeed', DEFAULT_GROUND_MOTION_SPEED, 0, 100) * 0.017);
      const time = state.sonicTime;
      const audio = analyzeFrequencyBins(freq, sampleRate, fftSize);
      if (state.initialized) {
        updateSonicRotation(currentFx, dt);
        applyLayout(currentFx);
        state.root.visible = true;
        syncTerrainUniforms(THREE, currentFx, audio, dt, time);
        updateAudioTriggers(audio);
        updateFloatingBlocks(currentFx, audio, dt, time);
        updateMeteorsAndTrails(dt);
      }
    },
    dispose() {
      clearLayer();
    },
    updateParams(newParams: any) {
      currentFx = buildFx(newParams);
      // 颜色、发光等不影响几何的参数，直接在下一帧同步
    },
    rebuild(newParams: any, newQuality?: string) {
      if (newQuality) quality = newQuality;
      currentFx = buildFx(newParams);
      // 强制重建：先清再建
      const prevScene = state.scene;
      clearLayer();
      if (prevScene) {
        ensureLayer(THREE, prevScene, currentFx, quality);
      }
    },
    /**
     * 歌词触发涟漪：在地形随机位置产生一圈扩散涟漪
     * @param intensity 强度系数 0-2（乘到 strength 上）
     * @param whiteRipple 是否白色高光涟漪（false 用彩色）
     * @param count 涟漪数量，默认 1-2 个
     */
    triggerLyricRipple(intensity = 1.0, whiteRipple = false, count = 1) {
      if (!state.initialized || state.lyricRippleDisabled) return;
      const settings = deriveTerrainGridSettings(currentFx, quality);
      const halfW = (settings.gridSize * settings.spacing) / 2;
      const safeCount = Math.max(1, Math.min(count, 3));
      for (let i = 0; i < safeCount; i++) {
        // 随机在 60% 半径区域内分布，避免边缘太偏
        const angle = Math.random() * Math.PI * 2;
        const r = Math.random() * halfW * 0.6;
        const x = Math.cos(angle) * r;
        const z = Math.sin(angle) * r;
        const strength = clamp(0.6 + intensity * 1.2, 0.3, 3.0);
        addRipple(x, z, strength, !!whiteRipple);
      }
    },
    /**
     * 更新歌词涟漪参数（颜色模式等）
     */
    setLyricRippleParams(params: { colorMode?: 'accent' | 'lyric' | 'warm'; rippleColor?: string }) {
      if (params.colorMode === 'lyric' && params.rippleColor) {
        // 用歌词颜色作为涟漪色
        if (state.terrainMat?.uniforms?.uRippleColor) {
          // 仅通过 updateParams 走颜色链路更稳定，这里直接设 uniform 做即时生效
          try {
            const c = new THREE.Color(params.rippleColor);
            state.terrainMat.uniforms.uRippleColor.value.copy(c);
            if (state.floatingMat?.uniforms?.uRippleColor) {
              state.floatingMat.uniforms.uRippleColor.value.copy(c);
            }
            if (state.trailMat) state.trailMat.color.copy(c);
          } catch { /* ignore */ }
        }
      }
      // accent / warm 模式走 updateParams 里的 accentColor 链路
    },
    /**
     * 启用/禁用歌词涟漪
     * shader 编译失败时调用，清空所有涟漪并禁用后续涟漪触发，保证地形仍能正常渲染
     */
    setLyricRippleEnabled(enabled: boolean) {
      try {
        state.lyricRippleDisabled = !enabled;
        if (!enabled) {
          // 立即清空所有涟漪
          for (let i = 0; i < state.ripples.length; i++) {
            state.ripples[i].start = -100000;
            state.ripples[i].strength = 0;
          }
          // 同步到 shader uniforms
          if (state.terrainMat?.uniforms?.uRipples?.value) {
            const arr = state.terrainMat.uniforms.uRipples.value;
            for (let i = 0; i < arr.length; i++) {
              arr[i].set(0, 0, 0, 0);
            }
          }
          // 关闭浮动方块和流星
          if (state.floatingBlocks) state.floatingBlocks.visible = false;
          if (state.meteors) state.meteors.visible = false;
        } else {
          // 重新启用时恢复显示（浮砖/流星由 update 内部逻辑驱动）
          if (state.floatingBlocks) state.floatingBlocks.visible = true;
        }
      } catch { /* ignore */ }
    },
  };

  // 暴露 setScene（外部 initScene 传入 scene 后首次激活）
  (api as any)._setScene = (scene: any) => {
    sceneRef = scene;
    if (!state.initialized) {
      ensureLayer(THREE, scene, currentFx, quality);
    }
  };

  return api;
}

// 导出默认参数，供外部引用
export const DEFAULT_SONIC_MR_PARAMS = {
  amplitude: DEFAULT_GROUND_AMPLITUDE,
  motionSpeed: DEFAULT_GROUND_MOTION_SPEED,
  density: DEFAULT_TERRAIN_DENSITY,
  range: DEFAULT_GROUND_RANGE,
  lower: DEFAULT_GROUND_LOWER,
  depth: DEFAULT_GROUND_DEPTH,
  autoRotate: DEFAULT_GROUND_AUTO_ROTATE,
  glow: DEFAULT_GROUND_GLOW,
  baseColor: DEFAULT_GROUND_BASE_COLOR,
  coolColor: DEFAULT_GROUND_COOL_COLOR,
  warmColor: DEFAULT_GROUND_WARM_COLOR,
  accentColor: DEFAULT_GROUND_ACCENT_COLOR,
  floatingEnabled: true,
  floatingIntensity: DEFAULT_FLOATING_BLOCK_INTENSITY,
  floatingMinSize: DEFAULT_FLOATING_BLOCK_MIN_SIZE,
  floatingMaxSize: DEFAULT_FLOATING_BLOCK_MAX_SIZE,
  floatingSpeed: DEFAULT_FLOATING_BLOCK_SPEED,
  floatingCount: DEFAULT_FLOATING_BLOCK_COUNT,
  eq: [...DEFAULT_GROUND_BANDS] as [number, number, number, number, number, number, number, number],
};
