// ============================================================
//  Mineradio 风格封面粒子 —— 完整移植版
//  基于 MR v7.1+ 的 00-pointer-cover-particles.js + 15-ripples-cover-depth.js
//
//  架构：
//    - N×N 方格点云（点阵封面粒子）
//    - 三组 attribute：position / aUv / aRand
//    - 双材质双 Pass：core（NormalBlending 本体） + bloom（AdditiveBlending 发光层）
//    - 背景星河：独立 Points，跟随封面色彩
//    - 涟漪系统：已移除（封面保持平整，节拍通过整体等比例缩放响应）
//    - 封面深度/边缘纹理：CPU 端 Sobel 边缘 + 启发式深度 (R=depth G=edge B=fg-mask A=lum)
//    - 切歌颜色渐变：prevTex + mixT 线性混合
//    - 12 个 preset：SILK / TUNNEL / ORBIT / VOID / VINYL / WALLPAPER /
//                    ECLIPSE HALO / NEON DRIZZLE / PRISM FLOCK / ABYSSAL BLOOM
//    - 音频驱动：bass / mid / treble / beat / energy
//    - 鼠标交互：拖拽推开 (SILK 预设)
// ============================================================

import { getBeatState } from './beatBus';

export interface Cover3DShaderResult {
  system: any;       // THREE.Group（含 core + bloom + 背景星河）
  update: (freq: Uint8Array, delta: number, sens: number, simulated: boolean, kickEnvelope?: number) => void;
  rebuild: (url: string, track: any) => void;
  setCoverEffect: (params: Record<string, any>) => void;
  setPreset: (preset: number) => void;
  getCoverError: () => string;
  isLoaded: () => boolean;
  getAudioMetrics: () => any;
  getDebugMetrics: () => any;
  dispose: () => void;
}

// ===== Shader 字符串 =====
// BUILD_VERSION: flow-v2 — 2026-10-05 加入封面粒子通用慢速流动（coverParticleFlow）
// 顶点 Shader — 12 个 preset 全部在 main() 内分支
const CORE_VERTEX_SHADER = /* glsl */ `
// build: flow-v2
precision highp float;
uniform float uTime, uBass, uMid, uTreble, uBeat, uEnergy, uBurstAmt;
uniform float uPreset, uIntensity, uDepth, uPointScale, uSpeed, uTwist;
uniform float uVinylSpin;
uniform float uColorBoost, uScatter, uCoverRes, uBgFade;
uniform float uHasCover, uHasDepth, uEdgeEnabled, uAiBoost;
uniform float uMouseActive, uPixel, uColorMixT, uLoading;
uniform float uFlowAmp;     // 全局流动强度系数（默认1.0，暂停/无音乐时自动衰减）
uniform sampler2D uCoverTex, uPrevCoverTex, uEdgeTex;
uniform vec2 uMouseXY;
uniform vec3 uTintColor;
uniform float uTintStrength;
attribute vec2 aUv;
attribute float aRand;
varying vec3 vColor;
varying float vBright, vRipple, vEdgeBoost, vAlpha, vSourceLum;

#define PI 3.14159265359

vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289v(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 perm(vec4 x){return mod289v(((x*34.0)+1.0)*x);}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);
  const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy));
  vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g;
  vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;
  vec3 x2=x0-i2+C.yyy;
  vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=perm(perm(perm(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857;
  vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy;
  vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0;
  vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=inversesqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);
  m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}

float hash11(float p) {
  return fract(sin(p * 127.1) * 43758.5453123);
}

// ============================================================
//  coverParticleFlow — 封面粒子通用慢速流动
//  给以专辑封面为主体的粒子预设增加"轻微流动感"。
//  设计原则（与需求严格对齐）：
//    1. 全部基于 per-particle 随机相位，不形成全局波浪/涟漪/飘带/折叠
//    2. 流动主要发生在边缘 + 亮部 + Additive 发光层，内部暗部稳定
//    3. 粒子围绕原位小范围循环运动，不外散、无拖尾
//    4. 总位移有硬上限 safeCap，封面轮廓/贴图对应关系不变
//    5. 节拍效果（burst/z-pop/大小呼吸/twinkle）保持独立，流动是日常质感
//  输入：
//    uv          — 粒子在封面上的 uv 坐标（用于计算边缘/径向方向）
//    rand        — 粒子随机种子 aRand
//    t           — 时间 t = uTime * uSpeed
//    brightW     — 亮部权重 0~1
//    edgeW       — 边缘权重 0~1
//    midAmount   — 中频驱动（uMid），用于流动幅度的音频调制
//    flowMul     — 强度乘数（不同 preset 可传不同值，默认 1.0）
//    safeCap     — 总位移安全上限（uv 空间，默认 0.018）
//  输出：vec2 — 加到 pos.xy 上的偏移量（uv 空间）
// ============================================================
vec2 coverParticleFlow(vec2 uv, float rand, float t, float brightW, float edgeW, float midAmount, float flowMul, float safeCap) {
  // 每层独立相位，避免同步感
  float phaseA = t * 0.22 + rand * 9.0;       // 基础漂浮 ~0.035 Hz (28s 周期)
  float phaseB = t * 0.14 + rand * 6.283;     // 边缘切向 ~0.022 Hz (45s 周期)
  float phaseC = t * 0.08 + rand * 3.7;       // 纹理流场 ~0.013 Hz (77s 周期)

  // —— A. 基础原位漂浮（极慢随机游走）——
  float baseAmp = 0.006 * flowMul;
  float driftAngle = rand * 15.7;
  vec2 baseDrift = vec2(
    cos(driftAngle + sin(phaseA * 1.1) * 0.6),
    sin(driftAngle * 1.3 + cos(phaseA * 0.9) * 0.6)
  ) * baseAmp;

  // —— B. 边缘切向慢流（边缘粒子沿封面轮廓切线方向缓慢漂移）——
  //    中心为 0，越靠近边缘越强（edgeW² 平方衰减更自然）
  vec2 fromCenter = uv - 0.5 + vec2(0.0001);
  float centerDist = length(fromCenter);
  vec2 tangentDir = vec2(-fromCenter.y, fromCenter.x) / centerDist; // 单位切向量
  float edgeDir = sign(rand - 0.5) * 0.85 + 0.15;  // 每颗粒子随机顺/逆时针，避免整体旋转
  float edgeAmp = 0.008 * edgeW * edgeW * flowMul; // 边缘最大 ~0.008，中心≈0
  float edgeFlowVal = sin(phaseB) * edgeAmp * edgeDir;
  vec2 edgeDrift = tangentDir * edgeFlowVal;

  // —— C. 亮部纹理微流（亮部粒子沿 snoise 向量场轻微穿梭，暗部稳定）——
  float fieldScale = 2.5 + rand * 1.5;
  float flowNx = snoise(vec3(uv.x * fieldScale, uv.y * fieldScale * 1.3, phaseC));
  float flowNy = snoise(vec3(uv.y * fieldScale * 0.9, uv.x * fieldScale * 1.1, phaseC + 11.3));
  float brightAmp = 0.006 * brightW * flowMul;  // 亮部最大 ~0.006，暗部 ~0.0015
  vec2 brightDrift = vec2(flowNx, flowNy) * brightAmp;

  // —— D. 音频驱动微调：mid 强时流动略快（幅度微增，不超过 1.6x）——
  float audioBoost = 1.0 + midAmount * 0.6;

  vec2 total = (baseDrift + edgeDrift + brightDrift) * audioBoost * uFlowAmp;

  // —— 安全上限硬 clamp ——
  float len = length(total);
  if (len > safeCap) {
    total *= safeCap / len;
  }
  return total;
}

// 简化版：默认参数
vec2 coverParticleFlowDefault(vec2 uv, float rand, float t, float brightW, float edgeW, float midAmount) {
  return coverParticleFlow(uv, rand, t, brightW, edgeW, midAmount, 1.0, 0.018);
}

// ============================================================
//  coverParticleTwinkleFlow — 粒子明暗缓慢穿梭（慢速 twinkle 基底）
//  返回值：加到 maxRippleAmp 上的亮度偏移量（可正可负，约 ±0.06）
// ============================================================
float coverParticleTwinkleFlow(float rand, float t, float brightW, float flowMul) {
  float slowPhase = t * 0.05 + rand * 12.566;
  float noisePhase = snoise(vec3(rand * 3.0, rand * 5.0, t * 0.02));
  float val = sin(slowPhase + noisePhase * 1.5);
  return val * 0.06 * brightW * flowMul * uFlowAmp;
}

vec2 safeCoverUv(vec2 uv) {
  return clamp(uv, vec2(0.0012), vec2(0.9988));
}

vec3 sampleNewCoverColor(vec2 uv) {
  return texture2D(uCoverTex, safeCoverUv(uv)).rgb;
}

vec3 samplePrevCoverColor(vec2 uv) {
  return texture2D(uPrevCoverTex, safeCoverUv(uv)).rgb;
}

vec4 sampleEdgeColor(vec2 uv) {
  return texture2D(uEdgeTex, safeCoverUv(uv));
}

void main(){
  float t = uTime * uSpeed;
  vec3 pos;
  vec2 sampleUv = safeCoverUv(aUv);
  vec3 newCol = sampleNewCoverColor(sampleUv);
  vec3 prevCol = samplePrevCoverColor(sampleUv);
  vec3 coverColor = mix(prevCol, newCol, clamp(uColorMixT, 0.0, 1.0));
  vec4 edge = sampleEdgeColor(sampleUv);
  float depthVal = edge.r;
  float edgeVal  = edge.g;
  float fgMask   = edge.b;
  float lumVal   = edge.a;
  float maxRippleAmp = 0.0;

  vec3 defaultColor = mix(
    vec3(0.36, 0.28, 0.72),
    mix(vec3(0.85, 0.55, 0.95), vec3(0.45, 0.78, 0.95), aUv.x),
    aUv.y
  );
  vColor = mix(defaultColor, coverColor, uHasCover);
  vAlpha = 1.0;

  float K = uIntensity * 1.6;

  // ===== Preset 0: SILK — 平面封面粒子 (平整 z 平面 + AI 深度图 + 单粒子级动态) =====
  // 封面保持完整平整，节拍膨胀通过 group.scale 整体等比例缩放实现。
  // AI 深度图属于封面静态结构，保留以维持立体感，但不产生波浪/扭曲/折叠效果。
  //
  // 单粒子级动态清单（全部作用于单颗粒子，不形成全局波浪/涟漪/飘带）：
  //   1. 原位漂浮 — 每颗粒子独立方向 + 独立相位，极其细微的随机游走
  //   2. 大小呼吸 — per-particle 相位 + 音频驱动，可见但克制
  //   3. 亮度闪烁 (twinkle) — 高频驱动速度，中频驱动幅度，重拍整体提亮
  //   4. 重拍径向迸发 (beat burst) — 少量随机粒子沿径向向外冲出再快速回落
  //   5. z 轴前顶 (z-pop) — 更少比例的粒子在重拍时向前顶出，形成火花层次感
  //   6. 边缘/亮部粒子优先激活 — 边缘和高亮度粒子迸发更强，内部粒子更稳
  //   7. Additive 发光层节拍火花 — 重拍时亮粒子额外增益，带防过曝
  //
  // 安全原则：
  //   - 所有位移以粒子原始位置为中心
  //   - xy 位移上限约粒子间距的 15%（边缘粒子最大），不破坏封面轮廓
  //   - z 轴前顶仅作用于 <20% 粒子，短寿命指数回落
  //   - 亮度/大小均有 clamp 防过曝
  //   - 封面主体轮廓、长宽比、贴图对应关系保持完整
  if (uPreset < 0.5) {
    pos = position;
    float depthZ = (depthVal - 0.5) * uAiBoost * uDepth * 1.40 * uHasDepth;
    pos.z = depthZ;
    // 亮度呼吸总基调（全局低频分量）
    maxRippleAmp = uBeat * 0.35 + uBass * 0.20 + uEnergy * 0.12;

    // 粒子到封面中心的距离 [0, ~0.7] — 用于边缘粒子增强
    float distFromCenter = length(aUv - 0.5) * 2.0;
    // 边缘权重：越靠近边缘越大，0.3~1.0 范围
    float edgeWeight = 0.35 + 0.65 * smoothstep(0.25, 1.0, distFromCenter);
    // 粒子源亮度 — 用于亮部粒子优先激活
    float srcLum = dot(max(coverColor, vec3(0.0)), vec3(0.299, 0.587, 0.114));
    float brightWeight = 0.25 + 0.75 * smoothstep(0.15, 0.85, srcLum);

    // ===== 1) 慢速流动 (日常呼吸感，通用函数) =====
    // 边缘 + 亮部粒子缓慢漂移，内部暗部稳定；总位移硬上限 0.018
    vec2 flowOffset = coverParticleFlowDefault(aUv, aRand, t, brightWeight, edgeWeight, uMid);
    pos.x += flowOffset.x;
    pos.y += flowOffset.y;
    // 明暗慢流动基底
    float slowTwinkleBoost = coverParticleTwinkleFlow(aRand, t, brightWeight, 1.0);

    // ===== 2) 重拍径向迸发 (beat burst) =====
    // 机制：
    //   - 每颗粒子有独立的 burst 阈值 (基于 aRand)
    //   - 重拍时只有 aRand < burstProb 的粒子被激活
    //   - 激活粒子沿径向（从封面中心向外）冲出，指数快速回落
    //   - 边缘粒子 + 亮粒子 迸发更强，内部暗粒子几乎不动
    //   - 不形成全局波浪 — 每颗粒子独立随机是否激活
    float burstProb = 0.35 + uBeat * 0.40 + uTreble * 0.15;  // 35%~90% 粒子参与
    float burstThreshold = aRand;
    float burstActive = step(burstThreshold, burstProb);
    // 迸发强度：重拍为主要驱动力，bass 做持续底鼓推动
    float burstIntensity = uBeat * 1.6 + uBass * 0.45;
    // 快速 attack + 平滑 release：用 beat 能量的反相模拟衰减包络
    // uBeat 范围 [0,1]，beatOffPhase = 1-uBeat 用于模拟回落阶段
    float beatOffPhase = max(0.0, 1.0 - uBeat * 1.5);
    // 每颗粒子独立衰减速率，避免同步形成波浪感
    float perParticleDecay = exp(-beatOffPhase * (3.0 + aRand * 5.0));

    // 径向位移：沿远离中心的方向
    vec2 radialDir = normalize(aUv - 0.5 + vec2(0.0001));
    float radialAmp = (0.012 + uBeat * 0.035) * edgeWeight * brightWeight;
    radialAmp *= burstActive * (burstIntensity * 0.5 + perParticleDecay * 0.5);
    // 安全上限：单颗粒子径向位移不超过 0.05 (约粒子间距的 12% @ N=140)
    radialAmp = min(radialAmp, 0.05);
    pos.x += radialDir.x * radialAmp;
    pos.y += radialDir.y * radialAmp;

    // ===== 3) z 轴前顶 (z-pop) =====
    // 更少数粒子 (约 15%~30%) 在重拍时向前顶出，形成火花层次感
    // 短寿命，快速回落，不影响整体封面平整度
    float zPopProb = 0.15 + uBeat * 0.20;
    float zPopActive = step(fract(aRand * 7.3 + 0.1), zPopProb);
    float zPopAmp = (0.04 + uBeat * 0.12) * brightWeight * edgeWeight;
    zPopAmp *= zPopActive * (0.6 + 0.4 * perParticleDecay);
    // 安全上限：z 轴位移不超过 0.20 (深度图本身最大起伏约 0.7，z-pop 占其 28%)
    zPopAmp = min(zPopAmp, 0.20);
    pos.z += zPopAmp;

    // ===== 4) 粒子大小呼吸 (增强版) =====
    // 全局节拍 + per-particle 相位呼吸 + 迸发粒子额外放大
    float sizeBreath = 0.5 + 0.5 * sin(t * 2.0 + aRand * 18.0);
    float sizeDrive = uTreble * 0.45 * sizeBreath + uMid * 0.28 * (0.5 + 0.5 * sizeBreath);
    sizeDrive += uBeat * 0.35;
    // 迸发的粒子额外变大
    sizeDrive += burstActive * burstIntensity * 0.25 * brightWeight;
    maxRippleAmp += sizeDrive * 0.45;

    // ===== 5) 亮度闪烁 (twinkle，增强版) =====
    // 高频驱动闪烁速度 + 中频调制幅度 + 重拍整体提亮
    float twinkleSpeed = 3.0 + uTreble * 8.0;
    float twinkle = 0.5 + 0.5 * sin(t * twinkleSpeed + aRand * 35.0 + uMid * 4.0);
    float twinkleBoost = twinkle * (uTreble * 0.55 + uMid * 0.28) + uBeat * 0.22 + slowTwinkleBoost;
    // 亮部粒子闪烁更强
    twinkleBoost *= 0.6 + 0.8 * brightWeight;
    maxRippleAmp += twinkleBoost;

    // ===== 6) Additive 发光层节拍火花 =====
    // 重拍时，亮粒子 + 边缘粒子获得额外发光增益
    // 防过曝：vBright 最终仍由外层 clamp 兜底
    float sparkBoost = uBeat * 0.30 * brightWeight * edgeWeight * burstActive;
    maxRippleAmp += sparkBoost;

    // ===== 7) 颜色饱和度脉冲 =====
    // 重拍时轻微提亮颜色，增强节奏感；仅影响 coverColor，不过饱和
    float satPulse = 1.0 + uBeat * 0.08 + uBass * 0.04 + sparkBoost * 0.15;
    vColor *= satPulse;
  }

  // ===== Preset 1: TUNNEL — 隧道 + 自旋 =====
  else if (uPreset < 1.5) {
    float spin = t * 0.12;
    float angle = aUv.x * 2.0 * PI + spin;
    float flow = aUv.y - t * 0.08 * (1.0 + uBass * 0.55);
    flow = fract(flow);
    float zPos = (flow - 0.5) * 9.0;
    float baseR = 2.0 - uBass * 0.28 * K;
    float ripG  = sin(angle * 5.0 + zPos * 1.4 + t * 2.2) * 0.10 * (uMid + uTreble) * K;
    float r = baseR + ripG;
    pos.x = cos(angle) * r;
    pos.y = sin(angle) * r;
    pos.z = zPos;

    sampleUv = vec2(aUv.x, flow);
    sampleUv = safeCoverUv(sampleUv);
    newCol = sampleNewCoverColor(sampleUv);
    prevCol = samplePrevCoverColor(sampleUv);
    coverColor = mix(prevCol, newCol, clamp(uColorMixT, 0.0, 1.0));
    vColor = mix(defaultColor, coverColor, uHasCover);

    float depthFade = smoothstep(-4.5, 4.5, zPos);
    vColor *= 0.4 + depthFade * 0.7;

    // —— 隧道流动增强：沿 z 轴方向的微漂移 + 径向轻微呼吸 ——
    // 每颗粒子独立相位，避免形成新的规则波纹；只增加"颗粒在流动"的质感
    float tunnelFlowPhase = t * (0.3 + aRand * 0.2) + aRand * 12.0;
    float tunnelFlowZ = sin(tunnelFlowPhase) * 0.06 * uFlowAmp;
    float tunnelFlowR = sin(tunnelFlowPhase * 0.7 + aRand * 5.0) * 0.02 * uFlowAmp;
    pos.z += tunnelFlowZ;
    pos.xy *= 1.0 + tunnelFlowR;
    maxRippleAmp += sin(t * 0.1 + aRand * 8.0) * 0.04 * uFlowAmp;
  }

  // ===== Preset 2: ORBIT — 星球 (保留自转) =====
  else if (uPreset < 2.5) {
    float theta = aUv.x * 2.0 * PI;
    float phi   = (aUv.y - 0.5) * PI;
    float baseR = 2.2;
    float trebFlare = snoise(vec3(theta * 1.5, phi * 1.5, t * 0.7)) * uTreble * 0.85 * K;
    float bassExpand = uBass * 0.35 * K;
    float r = baseR * (1.0 + bassExpand) + trebFlare;

    pos.x = r * cos(phi) * cos(theta);
    pos.y = r * sin(phi);
    pos.z = r * cos(phi) * sin(theta);

    float yaw = t * 0.18;
    float cy = cos(yaw), sy = sin(yaw);
    pos.xz = mat2(cy, -sy, sy, cy) * pos.xz;

    // —— 星球流动增强：表面粒子沿球面切线方向微漂移 + 明暗慢流动 ——
    // 用 snoise 得到球面切向扰动，幅度极小，增加"大气/纹理在动"的质感
    float orbitNoiseScale = 1.8;
    float orbitNoisePhase = t * 0.05 + aRand * 4.0;
    float orbitN1 = snoise(vec3(theta * orbitNoiseScale, phi * orbitNoiseScale, orbitNoisePhase));
    float orbitN2 = snoise(vec3(phi * orbitNoiseScale * 1.2, theta * orbitNoiseScale * 0.8, orbitNoisePhase + 7.3));
    // 沿 theta 和 phi 方向的微小偏移（球面切向）
    float dTheta = orbitN1 * 0.015 * uFlowAmp;
    float dPhi = orbitN2 * 0.012 * uFlowAmp;
    float nr = r;
    float nTheta = theta + dTheta;
    float nPhi = phi + dPhi;
    pos.x = nr * cos(nPhi) * cos(nTheta);
    pos.y = nr * sin(nPhi);
    pos.z = nr * cos(nPhi) * sin(nTheta);
    pos.xz = mat2(cy, -sy, sy, cy) * pos.xz;
    maxRippleAmp += orbitN1 * 0.05 * uFlowAmp;
  }

  // ===== Preset 3: VOID — 虚空 (无粒子) =====
  else if (uPreset < 3.5) {
    pos = vec3((aUv.x - 0.5) * 0.01, (aUv.y - 0.5) * 0.01, -90.0);
    vAlpha = 0.0;
    vColor = vec3(0.0);
    maxRippleAmp = 0.0;
  }

  // ===== Preset 4: VINYL RECORD — 黑胶唱片 =====
  else if (uPreset < 4.5) {
    float bassDrive = smoothstep(0.08, 0.78, uBass + uBeat * 0.82);
    float highDrive = smoothstep(0.05, 0.46, uTreble);
    float hiResGuard = smoothstep(1.08, 1.55, uCoverRes);
    float edgeGuard = mix(1.0, 0.38, hiResGuard);
    float depthGuard = mix(1.0, 0.44, hiResGuard);
    float grooveGuard = mix(1.0, 0.48, hiResGuard);
    float beatGuard = mix(1.0, 0.36, hiResGuard);

    vec2 p = (aUv - 0.5) * 5.12;
    float spin = uVinylSpin;
    float cs = cos(spin), sn = sin(spin);
    vec2 rp = mat2(cs, -sn, sn, cs) * p;
    float d = length(p);
    float angle0 = atan(p.y, p.x);
    float recordR = 2.46;
    float coverR = 1.18;
    float recordAlpha = 1.0 - smoothstep(recordR - 0.02, recordR + 0.05, d);
    float coverMask = 1.0 - smoothstep(coverR - 0.012, coverR + 0.018, d);
    float border = exp(-pow((d - coverR) / 0.064, 2.0)) * edgeGuard;
    float outerRim = exp(-pow((d - (recordR - 0.050)) / 0.055, 2.0)) * edgeGuard;
    float vinylN = clamp((d - coverR) / max(0.001, recordR - coverR), 0.0, 1.0);

    pos = vec3(rp * (1.0 + bassDrive * 0.012 * beatGuard + uBeat * 0.026 * beatGuard), 0.0);
    vAlpha = recordAlpha;

    if (coverMask > 0.02) {
      vec2 coverUv = p / (coverR * 2.0) + 0.5;
      newCol = sampleNewCoverColor(coverUv);
      prevCol = samplePrevCoverColor(coverUv);
      coverColor = mix(prevCol, newCol, clamp(uColorMixT, 0.0, 1.0));
      if (hiResGuard > 0.001) {
        vec2 sx = vec2(0.0026, 0.0);
        vec2 sy = vec2(0.0, 0.0026);
        vec3 softNew = (sampleNewCoverColor(coverUv + sx) + sampleNewCoverColor(coverUv - sx) + sampleNewCoverColor(coverUv + sy) + sampleNewCoverColor(coverUv - sy)) * 0.25;
        vec3 softPrev = (samplePrevCoverColor(coverUv + sx) + samplePrevCoverColor(coverUv - sx) + samplePrevCoverColor(coverUv + sy) + samplePrevCoverColor(coverUv - sy)) * 0.25;
        coverColor = mix(coverColor, mix(softPrev, softNew, clamp(uColorMixT, 0.0, 1.0)), hiResGuard * 0.42);
      }
      vColor = mix(defaultColor, coverColor, uHasCover);
      float coverShade = 1.02 + 0.10 * (1.0 - smoothstep(0.0, coverR, d));
      vColor *= coverShade;
      vColor = mix(vColor, vec3(1.0), border * 0.54);
      pos.z = 0.040 + border * 0.026 * depthGuard + uBeat * 0.018 * beatGuard;
      maxRippleAmp = max(maxRippleAmp, border * 0.30 + bassDrive * 0.075 * beatGuard + uBeat * 0.075 * beatGuard);

      // —— 封面区慢速流动 ——
      // 唱片模式封面以 coverUv 为基准算流动，再转换回旋转后的世界坐标
      float vinylSrcLum = dot(max(coverColor, vec3(0.0)), vec3(0.299, 0.587, 0.114));
      float vinylBrightW = 0.25 + 0.75 * smoothstep(0.15, 0.85, vinylSrcLum);
      float vinylEdgeW = 0.4 + 0.6 * smoothstep(0.3, 1.0, d / coverR);
      vec2 vinylFlowUv = coverParticleFlow(coverUv, aRand, t, vinylBrightW, vinylEdgeW, uMid, 1.1, 0.020);
      // uv 空间偏移 → 世界空间偏移（coverR*2 是 uv→world 的缩放），再旋转到唱片朝向
      vec2 flowWorld = vinylFlowUv * (coverR * 2.0);
      vec2 flowRotated = mat2(cs, -sn, sn, cs) * flowWorld;
      pos.xy += flowRotated;
      // 明暗慢流动
      float vinylTwinkleBoost = coverParticleTwinkleFlow(aRand, t, vinylBrightW, 1.0);
      maxRippleAmp += vinylTwinkleBoost;
    } else {
      float groove = 0.5 + 0.5 * sin((d - coverR) * mix(98.0, 58.0, hiResGuard));
      float fineGroove = 0.5 + 0.5 * sin((d - coverR) * mix(170.0, 92.0, hiResGuard) + aRand * 3.0);
      float tick = smoothstep(0.82, 0.995, hash11(floor((angle0 + PI) * 38.0) + floor(d * 72.0) * 2.1));
      vec3 vinyl = vec3(0.052, 0.054, 0.058) + vec3(0.052 * grooveGuard) * groove + vec3(0.026 * grooveGuard) * fineGroove;
      vinyl = mix(vinyl, coverColor * 0.32, 0.18 * (1.0 - vinylN));
      float whiteRing = max(border * 0.92, outerRim * 0.26);
      vColor = mix(vinyl, vec3(0.92, 0.94, 0.94), whiteRing);
      vColor = mix(vColor, vec3(1.0), tick * highDrive * (0.06 + border * 0.12) * grooveGuard);
      pos.z = groove * 0.010 * grooveGuard + border * 0.024 * depthGuard + bassDrive * vinylN * 0.016 * K * beatGuard + tick * highDrive * 0.010 * grooveGuard;
      maxRippleAmp = max(maxRippleAmp, border * 0.32 + outerRim * 0.12 + bassDrive * vinylN * 0.11 * beatGuard + tick * highDrive * 0.10 * grooveGuard + uBeat * vinylN * 0.08 * beatGuard);

      // —— 黑胶纹道区极轻微流动（增加质感，不破坏唱片圆形轮廓）——
      // 只沿切线方向微移（径向不动，保证圆形完整），幅度由 edge/rim 权重控制
      float grooveFlowPhase = t * (0.10 + aRand * 0.06) + aRand * 6.283;
      float grooveFlowAmp = 0.004 * (border * 2.0 + outerRim * 1.5 + vinylN * 0.3) * uFlowAmp;
      // 切向偏移：垂直于径向，随机方向
      vec2 grooveTangent = vec2(-rp.y, rp.x) / max(d, 0.001);
      float grooveDir = sign(aRand - 0.5);
      pos.xy += grooveTangent * sin(grooveFlowPhase) * grooveFlowAmp * grooveDir;
      // 黑胶区亮度微流动（更慢更弱）
      float grooveTwinkle = coverParticleTwinkleFlow(aRand, t, 0.3 + vinylN * 0.4, 0.6);
      maxRippleAmp += grooveTwinkle;
    }
  }

  // ===== Preset 5: WALLPAPER PULSE — 极光壁纸 =====
  else if (uPreset < 8.5) {
    float bassGlow = smoothstep(0.07, 0.78, uBass) * 0.34 + uBeat * 0.014;
    float midGlow = smoothstep(0.07, 0.62, uMid) * 0.42;
    float highGlow = smoothstep(0.04, 0.46, uTreble) * 0.46;
    float lane = aUv.y;
    float transition = clamp(uBurstAmt, 0.0, 1.0);

    if (lane < 0.80) {
      float laneWarp = snoise(vec3(aUv.x * 0.42, lane * 1.7, t * 0.026)) * 0.11 + (hash11(aRand * 73.1) - 0.5) * 0.045;
      float warpedLane = clamp(lane + laneWarp, 0.0, 0.80);
      float bandCoord = warpedLane / 0.80 * 5.65 + snoise(vec3(aUv.x * 0.82, lane * 2.25, t * 0.032)) * 0.62;
      float band = floor(bandCoord);
      float local = fract(bandCoord + hash11(band * 9.13 + aRand * 2.4) * 0.18);
      float bandN = clamp((band + 0.5) / 5.65, 0.0, 1.0);
      float seed = hash11(band * 19.17 + aRand * 31.0);
      float flow = fract(aUv.x + t * (0.0034 + bandN * 0.0038 + seed * 0.0022) + seed * 0.53);
      float arc = (flow - 0.5) * PI * (1.35 + bandN * 0.72 + seed * 0.24);
      float armCurve = sin(arc + bandN * 2.2 + seed * 5.3);
      float spiralRadius = 9.2 + bandN * 11.8 + seed * 6.0 + local * 2.9;
      float x = cos(arc * 0.72 + bandN * 0.92 + seed * 1.3) * spiralRadius + (flow - 0.5) * (13.5 + bandN * 9.5);
      float ribbonPhase = flow * PI * 2.0 * (0.55 + bandN * 0.24 + seed * 0.10) + t * (0.010 + bandN * 0.007) + seed * 5.7;
      float broadWave = sin(ribbonPhase) * 0.92;
      float fineWave = sin(ribbonPhase * (1.36 + seed * 0.62) - t * 0.044 + seed * 5.0) * 0.045;
      float yBase = (bandN - 0.5) * 13.2 + armCurve * (2.3 + bandN * 1.6) + (seed - 0.5) * 1.85 + snoise(vec3(bandN * 2.0, flow * 0.62, seed)) * 0.92;
      float ridgeCenter = 0.43 + (seed - 0.5) * 0.18;
      float ridge = exp(-pow((local - ridgeCenter) / (0.25 + seed * 0.04), 2.0));
      float softMask = smoothstep(0.010, 0.12, lane) * (1.0 - smoothstep(0.72, 0.81, lane));
      float ribbonNoise = snoise(vec3(flow * 1.18 + seed, bandN * 2.0, t * 0.018)) * 0.74;
      float zLayer = mix(-23.5, 15.5, bandN) + (seed - 0.5) * 6.0;

      pos.x = x + ribbonNoise * 1.40 + sin(t * 0.012 + seed * 8.0) * 0.22;
      pos.y = yBase + broadWave + fineWave + (local - 0.5) * (0.58 + ridge * 0.14);
      pos.z = zLayer + broadWave * 1.35 + ribbonNoise * 1.85;

      float pulseLine = 0.5 + 0.5 * sin(ribbonPhase * (1.7 + seed * 0.9) - t * 0.32 + seed * 6.0);
      vec3 aurora = mix(vec3(0.52, 0.86, 1.0), vec3(0.70, 0.58, 1.0), bandN);
      aurora = mix(aurora, vec3(0.96, 0.98, 0.92), bassGlow * 0.05);
      vAlpha = (0.18 + ridge * 0.78 + pulseLine * highGlow * 0.035 + bassGlow * 0.025) * softMask * (0.96 + transition * 0.02);
      vColor = mix(coverColor, aurora, 0.62 + ridge * 0.22) * (0.76 + ridge * 0.86 + pulseLine * highGlow * 0.05 + bassGlow * 0.04);
      maxRippleAmp = max(maxRippleAmp, ridge * (0.12 + midGlow * 0.05) + pulseLine * highGlow * 0.045 + bassGlow * 0.030);
    } else {
      float q = (lane - 0.80) / 0.20;
      float seed = hash11(aRand * 917.0 + floor(q * 130.0));
      float depth = mix(-32.0, 18.0, seed);
      float drift = fract(aUv.x + t * (0.0014 + seed * 0.0048) + seed * 0.63);
      float cluster = snoise(vec3(seed * 2.0, q * 3.2, t * 0.007));
      float x = (drift - 0.5) * (45.0 + seed * 22.0) + cluster * 3.4;
      float y = (hash11(aRand * 331.0 + seed * 5.0) - 0.5) * 22.0 + sin(t * (0.018 + seed * 0.028) + seed * 7.0) * 0.86;
      float z = depth + sin(t * (0.020 + seed * 0.032) + aRand * 8.0) * 1.05;
      float twinkle = pow(0.5 + 0.5 * sin(t * (0.24 + seed * 0.42) + aRand * 17.0), 5.0);
      float dust = smoothstep(0.22, 0.98, hash11(aRand * 661.0 + floor(q * 160.0)));

      pos = vec3(x, y, z);
      vAlpha = dust * (0.16 + twinkle * 0.46 + highGlow * 0.025 + bassGlow * 0.018) * (1.0 - q * 0.06);
      vColor = mix(coverColor, vec3(0.92, 0.97, 1.0), 0.62 + twinkle * 0.14) * (0.72 + twinkle * 0.62 + bassGlow * 0.025);
      maxRippleAmp = max(maxRippleAmp, twinkle * highGlow * 0.055 + dust * bassGlow * 0.030);
    }

    if (transition > 0.001) {
      float bloom = smoothstep(0.0, 1.0, transition);
      vec2 burstVec = pos.xy + vec2(hash11(aRand * 31.0) - 0.5, hash11(aRand * 47.0) - 0.5) * 0.75;
      vec2 burstDir = burstVec / max(length(burstVec), 0.001);
      pos.xy += burstDir * bloom * 0.026;
      pos.xy += vec2(snoise(vec3(aRand, t * 0.014, 1.0)), snoise(vec3(aRand, t * 0.014, 5.0))) * bloom * 0.06;
      pos.xy *= 1.0 + bloom * 0.014;
      pos.z += (hash11(aRand * 123.0) - 0.5) * bloom * 0.18;
      vAlpha *= 0.86 + bloom * 0.22;
      maxRippleAmp = max(maxRippleAmp, bloom * 0.10);
    }
  }

  // ===== Preset 9: ECLIPSE HALO — 日食光环 =====
  else if (uPreset < 9.5) {
    float ringIndex = floor(aUv.y * 8.0);
    float ringLocal = fract(aUv.y * 8.0);
    float ringN = (ringIndex + 0.5) / 8.0;
    float ringSeed = hash11(ringIndex * 19.73 + 2.1);
    float theta = aUv.x * 2.0 * PI + ringIndex * 0.47 + t * (0.035 + ringN * 0.026);
    float eclipseDrive = smoothstep(0.06, 0.76, uBass) * 0.17 + uBeat * 0.08;
    float ridge = exp(-pow((ringLocal - 0.5) / (0.17 + ringSeed * 0.045), 2.0));
    float radius = 0.92 + ringN * 3.18 + (ringLocal - 0.5) * 0.24 + eclipseDrive * (0.18 + ringN * 0.34);
    float eccentric = 0.49 + ringN * 0.20;
    float xh = cos(theta) * radius * (1.18 + ringN * 0.10);
    float yh = sin(theta) * radius * eccentric;
    float zh = (ringN - 0.5) * 1.34 + sin(theta * 2.0 + ringSeed * 6.0) * (0.10 + ringN * 0.09);
    float tilt = -0.34 + ringN * 0.72;
    float ct = cos(tilt), st = sin(tilt);
    pos = vec3(xh, yh * ct - zh * st, yh * st + zh * ct);

    vec3 coldRim = vec3(0.48, 0.82, 1.0);
    vec3 antiqueGold = vec3(0.93, 0.72, 0.38);
    vec3 haloColor = mix(coldRim, antiqueGold, smoothstep(0.18, 0.84, ringN + sin(theta) * 0.08));
    haloColor = mix(haloColor, vec3(0.98, 0.96, 0.88), ridge * (0.28 + uTreble * 0.18));
    vColor = mix(coverColor * 0.72, haloColor, 0.62 + ridge * 0.20);
    float corona = pow(0.5 + 0.5 * sin(theta * (13.0 + ringIndex) - t * 0.52 + ringSeed * 9.0), 8.0);
    vAlpha = (0.18 + ridge * 0.74 + corona * (0.08 + uTreble * 0.18)) * smoothstep(0.02, 0.14, aUv.y) * (1.0 - smoothstep(0.93, 1.0, aUv.y));
    maxRippleAmp = max(maxRippleAmp, ridge * (0.12 + eclipseDrive * 0.20) + corona * uTreble * 0.13);
  }

  // ===== Preset 10: NEON DRIZZLE — 霓虹雨 =====
  else if (uPreset < 10.5) {
    float column = floor(aUv.x * 52.0);
    float columnN = (column + 0.5) / 52.0;
    float columnLocal = fract(aUv.x * 52.0);
    float rainSeed = hash11(column * 41.17 + floor(columnLocal * 5.0) * 7.9);
    float rainSpeed = 0.026 + rainSeed * 0.052 + smoothstep(0.08, 0.76, uBass) * 0.014;
    float fall = fract(1.0 - aUv.y + t * rainSpeed + rainSeed * 0.87);
    float xRain = (columnN - 0.5) * 11.8 + (columnLocal - 0.5) * 0.11;
    float yRain = (0.5 - fall) * 8.8;
    float cityDepth = mix(-3.8, 2.6, hash11(column * 11.3 + 0.7));
    float wind = sin(t * 0.17 + column * 0.63 + fall * 3.4) * (0.08 + rainSeed * 0.12);
    float perspective = 0.76 + smoothstep(-3.8, 2.6, cityDepth) * 0.34;
    pos = vec3((xRain + wind) * perspective, yRain, cityDepth + sin(fall * PI * 2.0 + rainSeed * 7.0) * 0.05);

    float dash = pow(0.5 + 0.5 * sin(fall * (52.0 + rainSeed * 38.0) - t * 0.32), 10.0);
    float dropHead = pow(0.5 + 0.5 * sin(fall * 17.0 + rainSeed * 12.0), 18.0);
    vec3 neonA = vec3(0.20, 0.88, 1.0);
    vec3 neonB = vec3(1.0, 0.26, 0.63);
    vec3 neonC = vec3(1.0, 0.72, 0.30);
    vec3 rainColor = mix(neonA, neonB, smoothstep(0.18, 0.78, rainSeed));
    rainColor = mix(rainColor, neonC, smoothstep(0.84, 0.99, rainSeed));
    vColor = mix(coverColor * 0.82, rainColor, 0.58 + dash * 0.18);
    vAlpha = 0.09 + dash * 0.40 + dropHead * (0.22 + uTreble * 0.30);
    vAlpha *= 0.58 + perspective * 0.42;
    pos.x += dropHead * sin(t * 0.8 + rainSeed * 8.0) * uTreble * 0.055;
    maxRippleAmp = max(maxRippleAmp, dash * uMid * 0.10 + dropHead * (0.10 + uTreble * 0.22));
  }

  // ===== Preset 11: PRISM FLOCK — 棱镜鸟群 =====
  else if (uPreset < 11.5) {
    float flockIndex = floor(aUv.y * 12.0);
    float wingY = fract(aUv.y * 12.0) * 2.0 - 1.0;
    float wingX = aUv.x * 2.0 - 1.0;
    float flockSeed = hash11(flockIndex * 23.73 + 4.0);
    float gx = mod(flockIndex, 4.0) - 1.5;
    float gy = floor(flockIndex / 4.0) - 1.0;
    float migrate = t * (0.018 + flockSeed * 0.018);
    vec2 flockCenter = vec2(gx * 2.42 + sin(migrate + flockSeed * 8.0) * 0.48,
                            gy * 2.10 + cos(migrate * 0.83 + flockSeed * 9.0) * 0.36);
    float ax = abs(wingX);
    float wingMask = 1.0 - smoothstep(0.72, 1.18, abs(wingY) + ax * 0.38);
    float bodyMask = exp(-pow(wingX / 0.075, 2.0)) * (1.0 - smoothstep(0.62, 1.0, abs(wingY)));
    float flap = sin(t * (0.72 + flockSeed * 0.35) + flockIndex * 1.7) * (0.34 + uMid * 0.42 + uBeat * 0.16);
    float lx = sign(wingX) * (0.12 + pow(ax, 0.76) * 0.88);
    float ly = wingY * (0.48 + (1.0 - ax) * 0.22);
    float lz = ax * (0.42 + flap) + (1.0 - abs(wingY)) * 0.08;
    float heading = -0.20 + (flockSeed - 0.5) * 0.70;
    float ch = cos(heading), sh = sin(heading);
    vec2 folded = mat2(ch, -sh, sh, ch) * vec2(lx, ly);
    pos = vec3(flockCenter + folded, (flockSeed - 0.5) * 3.4 + lz);

    vec3 prismLeft = vec3(0.42, 0.94, 0.82);
    vec3 prismRight = vec3(0.96, 0.62, 0.92);
    vec3 prism = mix(prismLeft, prismRight, smoothstep(-0.8, 0.8, wingX));
    prism = mix(prism, vec3(1.0, 0.91, 0.64), smoothstep(0.72, 1.0, ax));
    vColor = mix(coverColor * 0.78, prism, 0.60 + wingMask * 0.18);
    vAlpha = wingMask * (0.22 + (1.0 - ax) * 0.42 + uTreble * 0.16) + bodyMask * 0.68;
    maxRippleAmp = max(maxRippleAmp, wingMask * (0.07 + abs(flap) * 0.12) + bodyMask * uBass * 0.12);
  }

  // ===== Preset 12: ABYSSAL BLOOM — 深渊绽放 =====
  else {
    float bloomR = pow(aUv.y, 0.72);
    float bloomTheta = aUv.x * 2.0 * PI + bloomR * 0.72 + t * 0.018;
    float petalWave = 0.5 + 0.5 * cos(bloomTheta * 9.0 - bloomR * 3.8);
    float bloomDrive = smoothstep(0.06, 0.74, uBass) * 0.26 + uBeat * 0.10;
    float radiusBloom = bloomR * (3.30 + bloomDrive) * (0.78 + petalWave * 0.34);
    float petalFold = sin(bloomTheta * 9.0 - bloomR * 5.4 + t * 0.13);
    float bowl = (1.0 - bloomR) * 1.12 - bloomR * bloomR * 0.52;
    pos.x = cos(bloomTheta) * radiusBloom;
    pos.y = sin(bloomTheta) * radiusBloom * 0.82;
    pos.z = bowl + petalFold * (0.13 + bloomR * 0.47) + sin(bloomTheta * 3.0 + t * 0.07) * 0.08;
    float bloomTilt = -0.30;
    float cb = cos(bloomTilt), sb = sin(bloomTilt);
    pos.yz = mat2(cb, -sb, sb, cb) * pos.yz;

    vec3 abyss = vec3(0.12, 0.58, 0.56);
    vec3 violet = vec3(0.38, 0.32, 0.95);
    vec3 pearl = vec3(0.82, 1.0, 0.94);
    vec3 bloomColor = mix(abyss, violet, smoothstep(0.18, 0.88, bloomR + petalWave * 0.10));
    float luminousEdge = smoothstep(0.64, 0.98, bloomR) * (0.55 + petalWave * 0.45);
    bloomColor = mix(bloomColor, pearl, luminousEdge * (0.32 + uTreble * 0.22));
    vColor = mix(coverColor * 0.72, bloomColor, 0.68);
    float filament = pow(0.5 + 0.5 * sin(bloomTheta * 18.0 + bloomR * 19.0 - t * 0.26), 7.0);
    vAlpha = (0.16 + petalWave * 0.31 + filament * 0.26 + luminousEdge * 0.30) * smoothstep(0.01, 0.10, bloomR);
    maxRippleAmp = max(maxRippleAmp, petalWave * bloomDrive * 0.18 + filament * uTreble * 0.17 + luminousEdge * uMid * 0.09);
  }

  // ===== 鼠标交互 (仅 SILK) =====
  if (uMouseActive > 0.5 && uPreset < 0.5) {
    float mdx = pos.x - uMouseXY.x;
    float mdy = pos.y - uMouseXY.y;
    float md = sqrt(mdx*mdx + mdy*mdy);
    if (md < 1.0) {
      float push = (1.0 - md) * (1.0 - md);
      pos.z += push * 0.55;
    }
  }

  // ===== 通用: 离散感 / 扭曲 =====
  if (uScatter > 0.001) {
    vec2 jdir = vec2(cos(aRand * 6.2831), sin(aRand * 6.2831));
    pos.xy += jdir * uScatter * (0.05 + uTreble * 0.10);
  }
  if (uTwist > 0.001 && uPreset < 0.5) {
    float ta = uTwist * pos.z * 0.6;
    float cs = cos(ta), sn = sin(ta);
    pos.xy = mat2(cs, -sn, sn, cs) * pos.xy;
  }

  // ===== 颜色后处理 =====
  float vinylHiResGuard = smoothstep(1.08, 1.55, uCoverRes) * step(3.5, uPreset) * (1.0 - step(4.5, uPreset));
  float edgeBoost = uEdgeEnabled * edgeVal * mix(1.0, 0.42, vinylHiResGuard);
  vSourceLum = dot(max(vColor, vec3(0.0)), vec3(0.299, 0.587, 0.114));
  float blackParticleGuard = 1.0 - smoothstep(0.025, 0.115, vSourceLum);
  vEdgeBoost = edgeBoost * (uPreset > 3.5 ? 0.22 : 1.0) * (1.0 - blackParticleGuard);
  vColor = pow(max(vColor, vec3(0.0)), vec3(1.0 / max(0.35, uColorBoost)));
  float edgeColorMix = edgeBoost * (uPreset > 3.5 ? 0.20 : 0.50) * (1.0 - blackParticleGuard);
  vColor = mix(vColor, vColor + vec3(0.20), edgeColorMix);
  float tintLum = max(max(vColor.r, vColor.g), vColor.b);
  vec3 tintedColor = uTintColor * max(0.24, tintLum * 1.12);
  vColor = mix(vColor, tintedColor, clamp(uTintStrength, 0.0, 1.0) * (1.0 - blackParticleGuard));

    vBright = 0.82 + maxRippleAmp * 0.55 + uBass * 0.10 + edgeBoost * 0.30 + uEnergy * 0.05 + uBurstAmt * 0.40 + uBeat * 0.06;
  // SILK preset：增强单粒子亮度响应
  if (uPreset < 0.5) {
    vBright = 0.80 + maxRippleAmp * 0.70 + uBass * 0.12 + edgeBoost * 0.35 + uEnergy * 0.06 + uBurstAmt * 0.45 + uBeat * 0.08;
  }
  if (uPreset > 4.5) {
    vBright = 0.94 + maxRippleAmp * 0.34 + uBass * 0.020 + uEnergy * 0.026 + uBurstAmt * 0.025 + uBeat * 0.03;
    if (uPreset > 8.5) vBright = 0.86 + maxRippleAmp * 0.52 + uEnergy * 0.045 + uBeat * 0.03;
  } else if (uPreset > 3.5) {
    vBright = 0.94 + maxRippleAmp * 0.64 + uBass * 0.08 + edgeBoost * 0.12 + uEnergy * 0.05 + uBeat * 0.08 + uBurstAmt * 0.16;
  }

  vRipple = clamp(maxRippleAmp * 1.5, 0.0, 1.0);

  if (uHasDepth > 0.5 && uPreset < 0.5) {
    float bgMul = mix(1.0, 0.55, uBgFade * (1.0 - fgMask));
    vBright *= bgMul;
  }

  vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
  float depthSize = 36.0 / max(0.5, -mvPos.z);
  // 粒子大小随音频驱动：SILK 模式下 maxRippleAmp 已包含 per-particle 呼吸/闪烁/迸发，
  // 通过 audioBoost 统一反映到 gl_PointSize 上；整体封面膨胀仍由 group.scale 负责。
  float silkBoostMul = (uPreset < 0.5) ? 1.45 : 1.0;
  float audioBoost = 1.0 + maxRippleAmp * (0.7 * silkBoostMul) + edgeBoost * 0.55 + uBeat * 0.12 + uBurstAmt * 0.55;
  float sz = clamp(depthSize * audioBoost, 1.05, 5.20);
  if (uPreset > 4.5) {
    float flowDrive = uBass * 0.070 + uMid * 0.046 + uTreble * 0.060 + uBurstAmt * 0.090 + uBeat * 0.025;
    sz = clamp(depthSize * (1.05 + flowDrive), 1.00, 5.45);
    if (uPreset > 8.5) {
      float authoredDrive = uBass * 0.10 + uMid * 0.08 + uTreble * 0.12 + uBeat * 0.04;
      sz = clamp(depthSize * (0.98 + authoredDrive), 1.00, 4.85);
    }
  } else if (uPreset > 3.5) {
    float ringDrive = uBass * 0.30 + uMid * 0.18 + uTreble * 0.22 + uBeat * 0.12;
    sz = clamp(depthSize * (0.90 + ringDrive * 0.62), 1.05, 3.90);
  }
  gl_PointSize = sz * uPixel * uPointScale;
  gl_Position = projectionMatrix * mvPos;
}
`;

// 片元 Shader — 核心粒子层 (NormalBlending)
const CORE_FRAGMENT_SHADER = /* glsl */ `
precision highp float;
uniform sampler2D uDotTex;
uniform float uAlpha, uPreset, uParticleDim, uBackdropAdapt;
varying vec3 vColor;
varying float vBright, vRipple, vEdgeBoost, vAlpha, vSourceLum;

void main(){
  vec4 tex = texture2D(uDotTex, gl_PointCoord);
  if (tex.a < 0.02) discard;
  vec3 col = vColor * vBright;
  col = mix(col, col * 1.3 + vec3(0.05), vEdgeBoost * 0.35);
  col = mix(col, col * 1.2, vRipple * 0.4);
  float keepBlack = 1.0 - smoothstep(0.025, 0.115, vSourceLum);
  float nonBlack = 1.0 - keepBlack;
  float dotDist = length(gl_PointCoord - vec2(0.5)) * 2.0;
  float readableRim = smoothstep(0.44, 0.94, dotDist) * (1.0 - smoothstep(0.94, 1.08, dotDist)) * tex.a;
  float outLum = dot(col, vec3(0.299, 0.587, 0.114));
  float lightParticle = smoothstep(0.50, 0.82, outLum) * nonBlack;
  float darkParticle = (1.0 - smoothstep(0.20, 0.50, outLum)) * nonBlack;
  float backdropAdapt = clamp(uBackdropAdapt, 0.0, 1.0);
  if (backdropAdapt > 0.001) {
    col = mix(col, vec3(0.0), readableRim * lightParticle * (0.38 + backdropAdapt * 0.30));
    col = mix(col, vec3(1.0), readableRim * darkParticle * (0.20 + backdropAdapt * 0.12));
  }
  col = clamp(col, vec3(0.0), vec3(1.6));
  gl_FragColor = vec4(col, tex.a * uAlpha * uParticleDim * vAlpha);
}
`;

// Bloom 层顶点 Shader（基于核心，尺寸放大 uBloomSize 倍）
const BLOOM_VERTEX_SHADER = CORE_VERTEX_SHADER
  .replace('uniform float uMouseActive, uPixel, uColorMixT, uLoading;', 'uniform float uMouseActive, uPixel, uColorMixT, uLoading, uBloomSize;')
  .replace('gl_PointSize = sz * uPixel * uPointScale;', 'gl_PointSize = sz * uPixel * uPointScale * uBloomSize;');

// Bloom 层片元 Shader (AdditiveBlending)
const BLOOM_FRAGMENT_SHADER = /* glsl */ `
precision highp float;
uniform sampler2D uDotTex;
uniform float uAlpha, uBloomStrength, uPreset, uParticleDim, uBackdropAdapt;
varying vec3 vColor;
varying float vBright, vRipple, vEdgeBoost, vAlpha, vSourceLum;

void main(){
  vec4 tex = texture2D(uDotTex, gl_PointCoord);
  if (tex.a < 0.01) discard;
  float soft = tex.a * tex.a;
  vec3 col = vColor * (0.42 + vBright * 0.50);
  col = mix(col, col + vec3(0.22, 0.18, 0.10), vEdgeBoost * 0.35);
  col = clamp(col, vec3(0.0), vec3(1.8));
  float pulse = 1.0 + vRipple * 0.65;
  float keepBlack = 1.0 - smoothstep(0.025, 0.115, vSourceLum);
  float bloomKeep = 1.0 - keepBlack * 0.92;
  float outLum = dot(col, vec3(0.299, 0.587, 0.114));
  float backdropAdapt = clamp(uBackdropAdapt, 0.0, 1.0);
  if (backdropAdapt > 0.001) {
    float brightAvoid = smoothstep(0.48, 0.84, outLum) * backdropAdapt;
    bloomKeep *= 1.0 - brightAvoid * 0.34;
  }
  gl_FragColor = vec4(col, soft * uAlpha * uBloomStrength * uParticleDim * pulse * 0.42 * vAlpha * bloomKeep);
}
`;

// 背景星河 顶点 Shader
const STAR_VERTEX_SHADER = /* glsl */ `
precision highp float;
attribute float aSeed, aLane, aDepthSeed;
uniform float uTime, uBass, uTreble, uBeat, uEnergy, uPixel, uPointScale, uAlpha, uParticleDim;
uniform vec3 uTintColor;
varying vec3 vColor;
varying float vAlpha, vTwinkle;

float hash11(float p){ return fract(sin(p * 127.1) * 43758.5453123); }

void main(){
  float band = floor(aLane * 6.0);
  float local = fract(aLane * 6.0);
  float bandN = (band + 0.5) / 6.0;
  float seed = aSeed + band * 19.17;
  float flow = fract(hash11(seed * 2.13) + uTime * (0.0022 + bandN * 0.0028 + hash11(seed * 5.1) * 0.0034));
  float arc = (flow - 0.5) * 6.2831853 * (0.68 + bandN * 0.46) + bandN * 2.4 + hash11(seed) * 6.2831853;
  float wave = sin(arc * (1.18 + bandN * 0.28) + uTime * (0.014 + bandN * 0.012) + seed * 0.07);
  float radius = 7.2 + bandN * 15.8 + hash11(seed * 3.7) * 6.2 + local * 1.8;
  vec3 pos;
  pos.x = cos(arc * 0.76 + bandN * 0.84) * radius + (flow - 0.5) * (18.0 + bandN * 14.0);
  pos.y = (bandN - 0.5) * 13.2 + wave * (1.5 + bandN * 1.4) + (local - 0.5) * 1.2;
  pos.z = mix(-31.0, -4.8, aDepthSeed) + wave * 1.2 + sin(uTime * (0.018 + hash11(seed) * 0.032) + seed) * 1.0;

  float twinkle = pow(0.5 + 0.5 * sin(uTime * (0.22 + hash11(seed * 4.0) * 0.44) + seed * 9.0), 5.0);
  float ridge = exp(-pow((local - (0.42 + hash11(seed * 6.0) * 0.16)) / (0.22 + hash11(seed * 7.0) * 0.10), 2.0));
  float dust = smoothstep(0.20, 0.98, hash11(seed * 8.0 + band));
  vec3 cool = mix(vec3(0.34, 0.76, 1.0), vec3(0.60, 0.44, 1.0), bandN);
  vec3 warm = vec3(1.0, 0.78, 0.58);
  vec3 tint = max(uTintColor, vec3(0.08));
  vColor = mix(cool, warm, ridge * 0.35 + uBass * 0.06);
  vColor = mix(vColor, tint, 0.22);
  vTwinkle = twinkle;
  vAlpha = uAlpha * uParticleDim * dust * (0.10 + ridge * 0.52 + twinkle * 0.32 + uBeat * 0.05) * (0.88 + uEnergy * 0.18);

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  float depthSize = 30.0 / max(0.65, -mv.z);
  float size = 1.10 + ridge * 2.40 + twinkle * 2.80 + uTreble * 0.80 + uBeat * 0.50;
  gl_PointSize = clamp(size * depthSize * uPixel * uPointScale, 0.75, 5.60);
  gl_Position = projectionMatrix * mv;
}
`;

// 背景星河 片元 Shader
const STAR_FRAGMENT_SHADER = /* glsl */ `
precision highp float;
uniform sampler2D uDotTex;
varying vec3 vColor;
varying float vAlpha, vTwinkle;

void main(){
  vec4 tex = texture2D(uDotTex, gl_PointCoord);
  if (tex.a < 0.02) discard;
  vec3 col = clamp(vColor * (0.66 + vTwinkle * 0.72), vec3(0.0), vec3(1.45));
  gl_FragColor = vec4(col, tex.a * vAlpha);
}
`;

// ===== 常量 =====
const PLANE_SIZE = 4.8;
const BG_STAR_COUNT = 1400;

// ===== 工具函数 =====
function makeDotTexture(THREE: any) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const ctx = cv.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 31);
  g.addColorStop(0.00, 'rgba(255,255,255,0.96)');
  g.addColorStop(0.42, 'rgba(255,255,255,0.78)');
  g.addColorStop(0.72, 'rgba(255,255,255,0.22)');
  g.addColorStop(1.00, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(cv);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

// 封面深度/边缘纹理: R=depth G=edge B=fg-mask A=lum
function buildEdgeAndDepth(srcCanvas: HTMLCanvasElement): HTMLCanvasElement {
  const W = 256, H = 256, N = W * H;
  const normalized = document.createElement('canvas');
  normalized.width = W;
  normalized.height = H;
  const sctx = normalized.getContext('2d')!;
  sctx.drawImage(srcCanvas, 0, 0, W, H);
  const src = sctx.getImageData(0, 0, W, H).data;
  const lum = new Float32Array(N);
  const blur = new Float32Array(N);
  const tmp = new Float32Array(N);

  // 1) Luminance
  for (let i = 0; i < N; i++) {
    const di = i * 4;
    lum[i] = (src[di] * 0.299 + src[di + 1] * 0.587 + src[di + 2] * 0.114) / 255;
  }

  // 2) Box blur 2 次
  function blurH(s: Float32Array, d: Float32Array, r: number) {
    for (let y = 0; y < H; y++) {
      let sum = 0;
      for (let x = -r; x <= r; x++) sum += s[y * W + Math.max(0, Math.min(W - 1, x))];
      for (let x = 0; x < W; x++) {
        d[y * W + x] = sum / (2 * r + 1);
        const xR = Math.min(W - 1, x + r + 1), xL = Math.max(0, x - r);
        sum += s[y * W + xR] - s[y * W + xL];
      }
    }
  }
  function blurV(s: Float32Array, d: Float32Array, r: number) {
    for (let x = 0; x < W; x++) {
      let sum = 0;
      for (let y = -r; y <= r; y++) sum += s[Math.max(0, Math.min(H - 1, y)) * W + x];
      for (let y = 0; y < H; y++) {
        d[y * W + x] = sum / (2 * r + 1);
        const yD = Math.min(H - 1, y + r + 1), yU = Math.max(0, y - r);
        sum += s[yD * W + x] - s[yU * W + x];
      }
    }
  }
  blurH(lum, tmp, 4);
  blurV(tmp, blur, 4);

  // 3) Sobel 边缘
  const edge = new Float32Array(N);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const gx = -blur[(y - 1) * W + (x - 1)] - 2 * blur[y * W + (x - 1)] - blur[(y + 1) * W + (x - 1)]
        + blur[(y - 1) * W + (x + 1)] + 2 * blur[y * W + (x + 1)] + blur[(y + 1) * W + (x + 1)];
      const gy = -blur[(y - 1) * W + (x - 1)] - 2 * blur[(y - 1) * W + x] - blur[(y - 1) * W + (x + 1)]
        + blur[(y + 1) * W + (x - 1)] + 2 * blur[(y + 1) * W + x] + blur[(y + 1) * W + (x + 1)];
      edge[y * W + x] = Math.min(1.0, Math.sqrt(gx * gx + gy * gy) * 1.4);
    }
  }

  // 4) 启发式深度
  const depth = new Float32Array(N);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const cx = (x / (W - 1) - 0.5) * 2.0;
      const cy = (y / (H - 1) - 0.5) * 2.0;
      const rr = Math.sqrt(cx * cx + cy * cy);
      const centerBias = 1.0 - Math.min(1, rr * 0.75);
      const bright = blur[i];
      depth[i] = Math.min(1.0, bright * 0.45 + centerBias * 0.55);
    }
  }

  // 5) fg-mask
  const fg = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    fg[i] = Math.min(1.0, depth[i] * 0.6 + edge[i] * 0.5);
  }

  // 输出 256×256 RGBA
  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const octx = out.getContext('2d')!;
  const imgOut = octx.createImageData(W, H);
  for (let i = 0; i < N; i++) {
    const di = i * 4;
    imgOut.data[di] = Math.round(depth[i] * 255);
    imgOut.data[di + 1] = Math.round(edge[i] * 255);
    imgOut.data[di + 2] = Math.round(fg[i] * 255);
    imgOut.data[di + 3] = Math.round(lum[i] * 255);
  }
  octx.putImageData(imgOut, 0, 0);
  return out;
}

function easeInOutCubic(t: number): number {
  return t * t * (3 - 2 * t);
}

// ===== 主创建函数 =====
export function createCover3DShader(
  THREE: any,
  targetCount: number,
  _primary: string,
  _secondary: string,
  initialCoverUrl: string,
): Cover3DShaderResult {
  // ---- 网格计算 ----
  const rawN = Math.floor(Math.sqrt(targetCount));
  let N = Math.max(64, Math.min(200, rawN));
  if (N % 2 === 0) N -= 1;
  const particleCount = N * N;

  const group = new THREE.Group();
  group.name = 'CoverParticles';

  // ---- 点纹理 ----
  const dotTex = makeDotTexture(THREE);

  // ---- Geometry 构建 ----
  function buildGeometry(grid: number) {
    const count = grid * grid;
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const uvs = new Float32Array(count * 2);
    const rands = new Float32Array(count);
    const texelStep = 1 / grid;
    for (let i = 0; i < count; i++) {
      const gx = i % grid, gy = Math.floor(i / grid);
      const u = (gx + 0.5) * texelStep, v = (gy + 0.5) * texelStep;
      const px = gx / (grid - 1), py = gy / (grid - 1);
      positions[i * 3] = (px - 0.5) * PLANE_SIZE;
      positions[i * 3 + 1] = (py - 0.5) * PLANE_SIZE;
      positions[i * 3 + 2] = 0;
      uvs[i * 2] = u;
      uvs[i * 2 + 1] = v;
      rands[i] = Math.random();
    }
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aUv', new THREE.BufferAttribute(uvs, 2));
    geo.setAttribute('aRand', new THREE.BufferAttribute(rands, 1));
    return geo;
  }

  let geometry = buildGeometry(N);

  // ---- 封面纹理 ----
  const coverTex = new THREE.Texture();
  coverTex.minFilter = THREE.LinearFilter;
  coverTex.magFilter = THREE.LinearFilter;
  coverTex.wrapS = THREE.ClampToEdgeWrapping;
  coverTex.wrapT = THREE.ClampToEdgeWrapping;

  const coverEdgeTex = new THREE.Texture();
  coverEdgeTex.minFilter = THREE.LinearFilter;
  coverEdgeTex.magFilter = THREE.LinearFilter;

  // 初始 4x4 占位
  (function initCoverTex() {
    const c = document.createElement('canvas'); c.width = c.height = 4;
    const x = c.getContext('2d')!; x.fillStyle = '#1c1c28'; x.fillRect(0, 0, 4, 4);
    coverTex.image = c; coverTex.needsUpdate = true;
    const d = document.createElement('canvas'); d.width = d.height = 4;
    const dx = d.getContext('2d')!; dx.fillStyle = 'rgba(128,0,0,255)'; dx.fillRect(0, 0, 4, 4);
    coverEdgeTex.image = d; coverEdgeTex.needsUpdate = true;
  })();

  // 前一首封面纹理（切歌渐变）
  const prevCoverTex = new THREE.Texture();
  prevCoverTex.minFilter = THREE.LinearFilter;
  prevCoverTex.magFilter = THREE.LinearFilter;
  (function initPrevCoverTex() {
    const c = document.createElement('canvas'); c.width = c.height = 4;
    const x = c.getContext('2d')!; x.fillStyle = '#1c1c28'; x.fillRect(0, 0, 4, 4);
    prevCoverTex.image = c; prevCoverTex.needsUpdate = true;
  })();

  // ---- Uniforms ----
  const uniforms: Record<string, any> = {
    uTime: { value: 0 },
    uBass: { value: 0 },
    uMid: { value: 0 },
    uTreble: { value: 0 },
    uBeat: { value: 0 },
    uEnergy: { value: 0 },
    uBurstAmt: { value: 0 },
    uVinylSpin: { value: 0 },
    uPreset: { value: 0 },
    uIntensity: { value: 0.85 },
    uDepth: { value: 0.2 },
    uPointScale: { value: 1.0 },
    uSpeed: { value: 1.0 },
    uTwist: { value: 0 },
    uColorBoost: { value: 1.0 },
    uScatter: { value: 0 },
    uCoverRes: { value: 1.0 },
    uBgFade: { value: 0.20 },
    uBloomStrength: { value: 0.62 },
    uBloomSize: { value: 2.65 },
    uFlowAmp: { value: 1.0 },
    uTintColor: { value: new THREE.Color('#9db8cf') },
    uTintStrength: { value: 0 },
    uCoverTex: { value: coverTex },
    uPrevCoverTex: { value: prevCoverTex },
    uColorMixT: { value: 1.0 },
    uEdgeTex: { value: coverEdgeTex },
    uDotTex: { value: dotTex },
    uHasCover: { value: 0 },
    uHasDepth: { value: 0 },
    uEdgeEnabled: { value: 1 },
    uAiBoost: { value: 0 },
    uMouseXY: { value: new THREE.Vector2(-999, -999) },
    uMouseActive: { value: 0 },
    uPixel: { value: 1 },
    uAlpha: { value: 1 },
    uParticleDim: { value: 1 },
    uBackdropAdapt: { value: 0 },
    uLoading: { value: 0 },
  };

  // ---- 核心粒子材质 + bloom 材质 ----
  const coreMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: CORE_VERTEX_SHADER,
    fragmentShader: CORE_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
  });

  const bloomMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: BLOOM_VERTEX_SHADER,
    fragmentShader: BLOOM_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });

  const corePoints = new THREE.Points(geometry, coreMat);
  corePoints.frustumCulled = false;
  corePoints.renderOrder = 1;

  const bloomPoints = new THREE.Points(geometry, bloomMat);
  bloomPoints.frustumCulled = false;
  bloomPoints.renderOrder = 0;

  group.add(bloomPoints);
  group.add(corePoints);

  // ---- 背景星河 ----
  let starPoints: any = null;
  let starUniforms: Record<string, any> | null = null;
  let starRiverEnabled = true;

  function buildStarRiver() {
    const bgGeo = new THREE.BufferGeometry();
    const seeds = new Float32Array(BG_STAR_COUNT);
    const lanes = new Float32Array(BG_STAR_COUNT);
    const depths = new Float32Array(BG_STAR_COUNT);
    for (let i = 0; i < BG_STAR_COUNT; i++) {
      seeds[i] = Math.random() * 1000 + i * 0.37;
      lanes[i] = Math.random();
      depths[i] = Math.random();
    }
    bgGeo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    bgGeo.setAttribute('aLane', new THREE.BufferAttribute(lanes, 1));
    bgGeo.setAttribute('aDepthSeed', new THREE.BufferAttribute(depths, 1));

    starUniforms = {
      uDotTex: { value: dotTex },
      uTime: { value: 0 },
      uBass: { value: 0 },
      uTreble: { value: 0 },
      uBeat: { value: 0 },
      uEnergy: { value: 0 },
      uPixel: { value: 1 },
      uPointScale: { value: 1 },
      uParticleDim: { value: 1 },
      uTintColor: { value: new THREE.Color('#9db8cf') },
      uAlpha: { value: 0.6 },
    };

    const starMat = new THREE.ShaderMaterial({
      uniforms: starUniforms,
      vertexShader: STAR_VERTEX_SHADER,
      fragmentShader: STAR_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    starPoints = new THREE.Points(bgGeo, starMat);
    starPoints.frustumCulled = false;
    starPoints.renderOrder = -1;
    group.add(starPoints);
  }

  buildStarRiver();

  // ---- 封面加载状态 ----
  let loaded = false;
  let errorMsg = '';
  let colorMixTweenRaf = 0;
  let vinylSpinAngle = 0;

  function startColorMixTween(durationMs: number) {
    if (colorMixTweenRaf) cancelAnimationFrame(colorMixTweenRaf);
    const duration = Math.max(1, durationMs || 1);
    const start = performance.now();
    uniforms.uColorMixT.value = 0;
    function step(now: number) {
      const t = Math.min(1, (now - start) / duration);
      const eased = easeInOutCubic(t);
      uniforms.uColorMixT.value = eased;
      if (t < 1) colorMixTweenRaf = requestAnimationFrame(step);
      else colorMixTweenRaf = 0;
    }
    colorMixTweenRaf = requestAnimationFrame(step);
  }

  // 加载封面图片
  function loadCover(url: string) {
    if (!url) {
      loaded = true;
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        // 切歌渐变：把当前 coverTex 当作 prevCoverTex
        if (uniforms.uHasCover.value > 0.5 && coverTex.image && coverTex.image.width > 4) {
          const prevW = coverTex.image.width || 256;
          const prevH = coverTex.image.height || 256;
          const prevScale = Math.min(1, 256 / Math.max(prevW, prevH, 1));
          const prevCv = document.createElement('canvas');
          prevCv.width = Math.max(1, Math.round(prevW * prevScale));
          prevCv.height = Math.max(1, Math.round(prevH * prevScale));
          try {
            prevCv.getContext('2d')!.drawImage(coverTex.image, 0, 0, prevCv.width, prevCv.height);
            prevCoverTex.image = prevCv;
            prevCoverTex.needsUpdate = true;
          } catch { /* ignore */ }
        }

        // 缩放到合适尺寸
        const maxSize = 512;
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const ctx = cv.getContext('2d')!;
        ctx.drawImage(img, 0, 0, w, h);

        coverTex.image = cv;
        coverTex.needsUpdate = true;
        uniforms.uHasCover.value = 1;

        // 生成边缘/深度纹理
        try {
          const edgeCv = buildEdgeAndDepth(cv);
          coverEdgeTex.image = edgeCv;
          coverEdgeTex.needsUpdate = true;
          uniforms.uHasDepth.value = 1;
          uniforms.uAiBoost.value = 0.55;
        } catch (edgeErr) {
          uniforms.uHasDepth.value = 0;
        }

        // 切歌渐变
        startColorMixTween(520);

        // 更新星河 tint（取封面平均色）
        if (starUniforms) {
          try {
            const sampleCv = document.createElement('canvas');
            sampleCv.width = sampleCv.height = 1;
            const sctx = sampleCv.getContext('2d')!;
            sctx.drawImage(img, 0, 0, 1, 1);
            const d = sctx.getImageData(0, 0, 1, 1).data;
            starUniforms.uTintColor.value.setRGB(d[0] / 255, d[1] / 255, d[2] / 255);
            uniforms.uTintColor.value.setRGB(d[0] / 255, d[1] / 255, d[2] / 255);
          } catch { /* ignore */ }
        }

        loaded = true;
        errorMsg = '';
      } catch (e: any) {
        errorMsg = String(e);
      }
    };
    img.onerror = () => {
      errorMsg = `封面加载失败: ${url}`;
      loaded = true;
    };
    img.src = url;
  }

  // ---- 音频分析（输出 0-255 原始值域，与 MR 原版一致；shader 内部按对应比例解读） ----
  // 注意：beat 通道不再用硬阈值归零，而是“基线 + 超阈值增益”双通道，
  // 密集鼓点下即使每帧都超阈也保留连续、可见的微幅跳动；
  // 最终 beat 还会与 beatBus.kickEnvelope 混合，确保与呼吸灯同源同步。
  function analyzeAudio(freq: Uint8Array, sens: number): { bass: number; mid: number; treble: number; energy: number; beatRaw: number; bassNorm: number } {
    const len = freq.length;
    if (!len) return { bass: 0, mid: 0, treble: 0, energy: 0, beatRaw: 0, bassNorm: 0 };
    const bassBin = Math.max(1, Math.floor(len * 0.08));
    const midBin = Math.max(bassBin + 1, Math.floor(len * 0.35));
    const trebleBin = Math.max(midBin + 1, Math.floor(len * 0.7));

    let bassSum = 0, midSum = 0, trebleSum = 0, energySum = 0;
    for (let i = 0; i < bassBin; i++) bassSum += freq[i];
    for (let i = bassBin; i < midBin; i++) midSum += freq[i];
    for (let i = midBin; i < trebleBin; i++) trebleSum += freq[i];
    for (let i = 0; i < len; i++) energySum += freq[i];

    const sensFactor = (sens || 1) * 1.0;
    const bass = Math.min(255, (bassSum / bassBin) * sensFactor);
    const mid = Math.min(255, (midSum / (midBin - bassBin)) * sensFactor);
    const treble = Math.min(255, (trebleSum / (trebleBin - midBin)) * sensFactor);
    const energy = Math.min(255, (energySum / len) * sensFactor);

    const bassNorm = bass / 255; // 0-1

    // beatRaw = 基线能量分量（密集鼓点兜底，保证不停止微动）
    //          + 超阈值脉冲分量（重鼓点突出放大）
    // 基线：bass 能量的 0.4 倍作为微动底，密集鼓点时持续可见
    const baselineBeat = bass * 0.40;
    // 超阈值增益：超过 110 后的部分放大，用于突出重拍（稀疏鼓点依然有力度）
    const aboveThreshold = Math.max(0, bass - 110);
    const thresholdGain = aboveThreshold * 2.0;
    const beatRaw = Math.min(255, baselineBeat + thresholdGain);

    return { bass, mid, treble, energy, beatRaw, bassNorm };
  }

  // ---- 平滑值 ----
  let smoothBass = 0, smoothMid = 0, smoothTreble = 0, smoothEnergy = 0, smoothBeat = 0;
  // 封面整体缩放脉冲（beatBus + 本地 beat 融合后的最终值，用于 group.scale）
  let coverPulseSmooth = 0;
  let flowAmpSmooth = 1.0;

  // ---- 更新函数 ----
  let elapsed = 0;
  function update(freq: Uint8Array, delta: number, sens: number, _simulated: boolean) {
    const dt = Math.min(delta, 0.05);
    elapsed += dt;

    // 音频分析
    const { bass, mid, treble, energy, beatRaw, bassNorm } = analyzeAudio(freq, sens);
    // 平滑（attack / release 分开，更有律动）
    const attack = 0.35;
    const release = 0.12;
    smoothBass   += (bass   - smoothBass)   * (bass   > smoothBass   ? Math.min(1, dt / attack)  : Math.min(1, dt / release));
    smoothMid    += (mid    - smoothMid)    * (mid    > smoothMid    ? Math.min(1, dt / attack)  : Math.min(1, dt / release));
    smoothTreble += (treble - smoothTreble) * (treble > smoothTreble ? Math.min(1, dt / attack)  : Math.min(1, dt / release));
    smoothEnergy += (energy - smoothEnergy) * (energy > smoothEnergy ? Math.min(1, dt / attack)  : Math.min(1, dt / release));
    smoothBeat   += (beatRaw - smoothBeat) * (beatRaw > smoothBeat ? Math.min(1, dt / 0.025) : Math.min(1, dt / 0.18));

    // ===== 封面跳动 ↔ 呼吸灯幅度绑定 =====
    // 从 beatBus 读取与呼吸灯同源的节拍包络，确保封面和呼吸灯完全同步：
    // 呼吸灯跳多少，封面就按自身强度参数同步响应；
    // 呼吸灯只是微动时，封面也持续微动，不会被阈值/冷却压到 0。
    //
    // 设计原则：节拍膨胀 = 整张封面等比例缩放（group.scale），
    // 小幅、均匀、完整 —— 重拍轻轻顶出、平滑回落，类似 MR 的效果。
    // shader 内的环境波浪/粒子运动与节拍膨胀解耦，各自独立。
    const beatState = getBeatState();
    const kickEnv = beatState.kickEnvelope; // 0-3+，指数衰减脉冲
    // kickEnvelope 归一化到 0-1 范围（3 以上饱和）
    const kickNorm = Math.min(1, kickEnv / 1.8);

    // 本地 beat（基于频谱能量，连续不跳变） + beatBus kick（与呼吸灯同源，拍感明确）
    // 取较大值 → 密集鼓点时本地能量兜底保证微动，稀疏重拍时 kick 突出力度
    const localBeatNorm = smoothBeat / 255;
    const combinedBeatNorm = Math.max(localBeatNorm * 0.55, kickNorm);

    // coverIntensity 读取（uniform 中存的是用户设置值 0.3~2.0）
    // 注意：uIntensity 已经有用户设置值，直接用它做乘数
    const intensity = Math.max(0.1, uniforms.uIntensity.value || 1.0);

    // ===== 封面整体脉冲缩放（等比例，整张封面一起放大/缩小）=====
    // - 基准微动 ~0.8%（呼吸灯微动时封面只做非常轻微的膨胀）
    // - 重拍最大 ~4.2%（intensity=1 时；intensity=0.85 默认约 4.25%）
    // - 安全上限 8%（即使灵敏度拉满/intensity=2，也不会过度膨胀）
    // - 与环境波浪解耦：这里只做整体缩放，shader 内局部形变走 uBass/uMid/uTreble
    const BASE_PULSE = 0.008;        // 基准微动 0.8%
    const BEAT_PULSE_MAX = 0.042;    // 节拍最大 4.2%
    const PULSE_CAP = 0.08;          // 安全上限 8%
    const rawPulse = (BASE_PULSE + combinedBeatNorm * BEAT_PULSE_MAX) * intensity;
    const targetPulse = Math.min(PULSE_CAP, rawPulse);
    // 平滑：attack 稍慢（更柔和地顶出），release 更慢（自然回落，MR 风格）
    const pulseAttack = 0.040;
    const pulseRelease = 0.28;
    coverPulseSmooth += (targetPulse - coverPulseSmooth) *
      (targetPulse > coverPulseSmooth ? Math.min(1, dt / pulseAttack) : Math.min(1, dt / pulseRelease));
    const beatPulse = 1.0 + coverPulseSmooth;
    group.scale.setScalar(beatPulse);

    // ===== 流动强度动态控制 =====
    // 有音乐能量时流动强度 = 1.0（默认可见）
    // 暂停/无音乐时平滑衰减到 0.25（仍有极微弱呼吸，不会完全静止）
    // 过渡时间 ~1.5s，切换自然不跳变
    const energyNorm = smoothEnergy / 255;
    const targetFlowAmp = 0.25 + Math.min(0.75, energyNorm * 1.5);
    flowAmpSmooth += (targetFlowAmp - flowAmpSmooth) * Math.min(1, dt / 1.5);
    uniforms.uFlowAmp.value = flowAmpSmooth;

    // 写入 shader 的 uBeat：同样用 combinedBeatNorm（0-1），保证 shader 内部跳动与封面整体缩放同源
    uniforms.uTime.value = elapsed;
    uniforms.uBass.value = smoothBass / 255;
    uniforms.uMid.value = smoothMid / 255;
    uniforms.uTreble.value = smoothTreble / 255;
    uniforms.uEnergy.value = smoothEnergy / 255;
    uniforms.uBeat.value = combinedBeatNorm;
    // 额外把 bassNorm 也喂给 uBeat 的 baseline 分量（通过 uBass 已经够了）

    // burst 衰减
    if (uniforms.uBurstAmt.value > 0.001) {
      uniforms.uBurstAmt.value = Math.max(0, uniforms.uBurstAmt.value - dt * 1.5);
    }

    // 黑胶旋转
    vinylSpinAngle += dt * 0.8;
    uniforms.uVinylSpin.value = vinylSpinAngle;

    // 星河同步
    if (starUniforms && starRiverEnabled) {
      starUniforms.uTime.value = elapsed;
      starUniforms.uBass.value = smoothBass / 255;
      starUniforms.uTreble.value = smoothTreble / 255;
      starUniforms.uBeat.value = smoothBeat / 255;
      starUniforms.uEnergy.value = smoothEnergy / 255;
      starUniforms.uPixel.value = uniforms.uPixel.value;
      starUniforms.uPointScale.value = uniforms.uPointScale.value;
    }
  }

  // ---- 重建（改变粒子密度）----
  function rebuildWithDensity(density: number) {
    const newRawN = Math.floor(Math.sqrt(targetCount * Math.max(0.3, density)));
    let newN = Math.max(48, Math.min(220, newRawN));
    if (newN % 2 === 0) newN -= 1;
    if (newN === N) return;
    N = newN;
    const newGeo = buildGeometry(N);
    const oldGeo = geometry;
    geometry = newGeo;
    corePoints.geometry = newGeo;
    bloomPoints.geometry = newGeo;
    if (oldGeo && oldGeo !== newGeo) oldGeo.dispose();
    uniforms.uBurstAmt.value = Math.max(uniforms.uBurstAmt.value, 0.18);
  }

  // ---- 设置参数 ----
  function setCoverEffect(params: Record<string, any>) {
    if (params.preset !== undefined) uniforms.uPreset.value = params.preset;
    if (params.intensity !== undefined) uniforms.uIntensity.value = params.intensity;
    if (params.depth !== undefined) uniforms.uDepth.value = params.depth;
    if (params.particleSize !== undefined) uniforms.uPointScale.value = params.particleSize;
    if (params.speed !== undefined) uniforms.uSpeed.value = params.speed;
    if (params.twist !== undefined) uniforms.uTwist.value = params.twist;
    if (params.colorBoost !== undefined) uniforms.uColorBoost.value = params.colorBoost;
    if (params.scatter !== undefined) uniforms.uScatter.value = params.scatter;
    if (params.bgFade !== undefined) uniforms.uBgFade.value = params.bgFade;
    if (params.bloomStrength !== undefined) uniforms.uBloomStrength.value = params.bloomStrength;
    if (params.edgeEnabled !== undefined) uniforms.uEdgeEnabled.value = params.edgeEnabled ? 1 : 0;
    if (params.opacity !== undefined) uniforms.uAlpha.value = params.opacity;
    if (params.brightness !== undefined) uniforms.uParticleDim.value = params.brightness;
    if (params.starRiver !== undefined) {
      starRiverEnabled = params.starRiver;
      if (starPoints) {
        starPoints.visible = starRiverEnabled;
      }
    }
    if (params.pixelRatio !== undefined) uniforms.uPixel.value = params.pixelRatio;
  }

  function setPreset(preset: number) {
    uniforms.uPreset.value = preset;
    uniforms.uBurstAmt.value = 1.0;
  }

  // ---- 鼠标交互 ----
  function handlePointerMove(x: number, y: number) {
    // x,y 是 -PLANE_SIZE/2 到 PLANE_SIZE/2 的坐标
    uniforms.uMouseXY.value.set(x, y);
    uniforms.uMouseActive.value = 1;
  }
  function handlePointerLeave() {
    uniforms.uMouseActive.value = 0;
    uniforms.uMouseXY.value.set(-999, -999);
  }
  function handleClick(_x: number, _y: number) {
    // 点击涟漪已移除：封面保持平整，仅通过整体缩放响应节拍
  }

  // ---- 暴露给外部 ----
  (group as any).handlePointerMove = handlePointerMove;
  (group as any).handlePointerLeave = handlePointerLeave;
  (group as any).handleClick = handleClick;
  (group as any).setPreset = setPreset;
  (group as any).rebuildWithDensity = rebuildWithDensity;

  // ---- 初始加载 ----
  loadCover(initialCoverUrl || '');

  // ---- 启动淡入 ----
  uniforms.uAlpha.value = 0;
  let fadeStart = performance.now();
  function fadeInStep() {
    const t = Math.min(1, (performance.now() - fadeStart) / 800);
    uniforms.uAlpha.value = easeInOutCubic(t);
    if (starUniforms) starUniforms.uAlpha.value = 0.6 * easeInOutCubic(t);
    if (t < 1) requestAnimationFrame(fadeInStep);
  }
  requestAnimationFrame(fadeInStep);

  return {
    system: group,
    update,
    rebuild: loadCover,
    setCoverEffect,
    setPreset,
    getCoverError: () => errorMsg,
    isLoaded: () => loaded,
    getAudioMetrics: () => ({
      bass: smoothBass,
      mid: smoothMid,
      treble: smoothTreble,
      energy: smoothEnergy,
      beat: smoothBeat,
    }),
    getDebugMetrics: () => ({
      particleCount: N * N,
      gridN: N,
      preset: uniforms.uPreset.value,
      hasCover: uniforms.uHasCover.value,
      hasDepth: uniforms.uHasDepth.value,
    }),
    dispose: () => {
      if (colorMixTweenRaf) cancelAnimationFrame(colorMixTweenRaf);
      geometry.dispose();
      coreMat.dispose();
      bloomMat.dispose();
      dotTex.dispose();
      coverTex.dispose();
      prevCoverTex.dispose();
      coverEdgeTex.dispose();
      if (starPoints) {
        starPoints.geometry.dispose();
        starPoints.material.dispose();
      }
    },
  };
}
