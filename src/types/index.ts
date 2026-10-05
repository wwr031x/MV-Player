// ===== 类型定义 =====

export interface ITrack {
  id: string;
  name: string;
  artist: string;
  album: string;
  coverUrl: string;
  duration: number; // 秒
  /** 本地文件对象（本地导入时有，网易云没有） */
  file?: File;
  /** 网易云歌曲ID（网易云来源时有） */
  neteaseId?: number;
  /** 播放地址（本地是blob URL，网易云是http URL） */
  url?: string;
  /** 来源 */
  source: 'local' | 'netease';
  /** 是否 VIP/付费专享（fee===1 等） */
  isVip?: boolean;
  /** 原始 fee 字段（0=免费, 1=VIP, 4=付费专辑, 等） */
  fee?: number;
  /** 一起听共享队列中：添加者信息（快照，防止成员离开后丢失） */
  addedBy?: {
    /** 添加者 uid */
    uid: string;
    /** 添加时的昵称快照 */
    nickname: string;
    /** 添加时的头像 seed 快照 */
    avatarSeed?: string;
    /** 添加时的网易云头像 URL 快照（登录态才有） */
    avatarUrl?: string;
    /** 添加时的网易云用户 ID（登录态才有） */
    neteaseUserId?: number;
  };
}

/** 一起听弹幕消息 */
export interface IDanmakuMessage {
   /** 消息唯一ID */
   id: string;
   /** 发送者 uid */
   fromUid: string;
   /** 发送者昵称 */
   fromNickname: string;
   /** 发送者头像 seed（默认头像生成用） */
   fromAvatarSeed: string;
   /** 发送者网易云头像 URL（登录后有值，优先使用） */
   fromAvatarUrl?: string;
   /** 发送者网易云用户 ID（登录后有值，用于标识网易云身份） */
   fromNeteaseUserId?: number;
   /** 消息内容 */
   content: string;
   /** 发送时间戳（ms） */
   timestamp: number;
   /** 所在房间ID */
   roomId: string;
 }

export interface IVisualizerSettings {
  mode: 'bars' | 'particles' | 'circular' | 'cover2d' | 'galaxy3d' | 'sphere3d' | 'ring3d' | 'cover3d' | 'wave' | 'customBg';
  primaryColor: string;
  secondaryColor: string;
  sensitivity: number; // 0-100
  /** 目标帧率（0=不限） */
  targetFps: number;
  /** 画质档位 */
  quality: 'low' | 'mid' | 'high' | 'native';
  /** 可视化缩放（0.5-2） */
  vizScale: number;
  /** 可视化水平偏移（-50~50，百分比） */
  vizOffsetX: number;
   /** 可视化垂直偏移（-50~50，百分比） */
   vizOffsetY: number;
    /** 封面模式粒子数（清晰度，cover3d 专用） */
    coverParticleCount: number;
    /** 封面粒子亮度（0-2，1 为原图亮度） */
    coverBrightness: number;
    /** 封面粒子大小倍率（0.5-3） */
    coverParticleSize: number;
    /** 封面粒子密度（0.3-1.5，1=按清晰度满密度） */
    coverDensity: number;
    /** 封面粒子不透明度（0.3-1） */
    coverOpacity: number;
    /** 封面波浪强度（0-2） */
    coverWaveIntensity: number;
    /** 封面粒子扭曲强度（0-3） */
    coverTwist: number;
    /** 封面粒子散布强度（0-3） */
    coverScatter: number;
    /** 封面动画速度倍率（0.3-2.0） */
    coverSpeed: number;
    /** 封面颜色饱和度增强（0.5-2.5） */
    coverColorBoost: number;
    /** 封面边缘提亮开关 */
    coverEdgeEnabled: boolean;
    // ===== Mineradio 封面粒子新增参数 =====
    /** 封面粒子预设（0=SILK 1=TUNNEL 2=ORBIT 3=VOID 4=VINYL 5=WALLPAPER 9=ECLIPSE 10=NEON 11=PRISM 12=ABYSSAL） */
    coverPreset: number;
    /** 封面律动强度（0.3-2，默认 0.85） */
    coverIntensity: number;
    /** 封面深度强度（0-1，默认 0.2） */
    coverDepth: number;
    /** 封面 bloom 发光强度（0-2，默认 0.62） */
    coverBloomStrength: number;
    /** 背景星河开关 */
    coverStarRiver: boolean;
    /** 背景淡出强度（0-1，默认 0.20，背景深的地方变暗） */
    coverBgFade: number;
    // ===== 封面粒子2D模式参数 =====
    /** 封面大小缩放（0.3-2，1=默认） */
    cover2dScale: number;
    /** 封面光晕亮度（0.2-2，1=默认） */
    cover2dGlow: number;
    /** 封面节拍触发灵敏度（0.1-1，值越低越容易触发波纹） */
    coverBeatSensitivity: number;
    // ===== 用户自定义背景（仅限横屏）=====
    /** 用户导入的背景图/视频 DataURL，空串表示未设置 */
    bgImageUrl: string;
    /** 背景类型：image=图片 / video=视频 */
    bgImageType: 'image' | 'video';
  }

export interface ILyricSettings {
  show: boolean;
  fontSize: number;           // 主歌词字号 px
  translationFontSize: number; // 翻译字号 px
  lineHeight: number;         // 行间距倍数（1-2.5）
  verticalPosition: number;   // 0-100 百分比（从顶部计算）
  align: 'left' | 'center' | 'right';
  color: string;              // 高亮/主歌词颜色
  strokeColor: string;        // 描边颜色
  glowIntensity: number;      // 发光强度 0-1
  showTranslation: boolean;
}

export interface INeteaseUser {
  userId: number;
  nickname: string;
  avatarUrl: string;
  cookie: string;
  level?: number;
  vipType?: number; // 0=非会员, 1=音乐包, 10=黑胶, 11=SVIP, 3=黑胶月卡 等
  vipLabel?: string; // 显示文本
  vipColor?: string; // 角标颜色
  vipIconType?: 'none' | 'package' | 'black' | 'svip'; // VIP 图标类型
  // 黑胶成长等级（来自 /vip/growthpoint 接口）
  growthLevel?: number; // 成长等级，如 5 表示 V5
  growthValue?: number; // 当前成长值，如 14330
  growthNextLevel?: number; // 下一级所需成长值，如 16000
  growthProgress?: number; // 当前等级进度 0-1
}

export interface ISearchResult {
  songs: ITrack[];
  total: number;
  hasMore: boolean;
}

export interface IPlaylist {
  id: number;
  name: string;
  coverUrl: string;
  trackCount: number;
}

export type PlayMode = 'sequence' | 'shuffle' | 'loop';
