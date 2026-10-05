# MV Player — 音频可视化播放器

一个基于 Web 的音频可视化播放器，提供多种可视化效果、自定义配色、视频录制导出和多人一起听功能。纯前端实现，零门槛使用。

## ✨ 主要功能

- 🎵 **本地音频播放** — 支持 MP3/WAV/OGG 等常见格式，多文件批量上传，播放列表管理
- 🎨 **多种可视化模式** — 频谱柱状图、波形图、粒子星空、环形频谱、径向、镜像、3D 星系、封面粒子、音域回响等 10+ 种效果
- 🌈 **自定义配色** — 多套预设配色方案，支持自定义主色/辅色、背景样式切换
- 🎬 **视频录制导出** — 一键录制可视化画面并导出为 WebM 视频
- 👥 **一起听（多人同步听歌）**
  - 通过房间号邀请好友加入
  - 双人房：进度条可拖动、上一首/下一首直接控制、暂停各自独立、恢复后自动追上进度
  - 三人及多人房：上一首/下一首采用投票制，严格超过半数通过
  - 支持网易云搜索和我的歌单加歌，昵称和头像同步网易云，未登录显示「一起听N号」
  - 每首歌显示添加者
  - 切后台保留 30 分钟，期间房间内显示「后台中」，超时未回归自动退出
- 🌙 **深色科技感界面** — 深空黑底 + 霓虹青主色，玻璃态面板，发光边框动效

## 🚀 快速开始

### 环境要求

- Node.js >= 18
- npm >= 9

### 安装依赖

```bash
npm install
```

### 开发模式

```bash
npm run dev
```

默认在 `http://localhost:5173` 启动开发服务器。

### 生产构建

```bash
npm run build
```

构建产物输出到 `dist/` 目录。

### 代码检查

```bash
# TypeScript 类型检查
npm run typecheck

# ESLint 检查
npm run lint:eslint

# 同时运行类型检查 + ESLint
npm run lint
```

## ⚙️ 环境变量配置

复制 `.env.example` 为 `.env.local` 并按需填写：

```bash
cp .env.example .env.local
```

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `CLIENT_BASE_PATH` | 应用部署的 base path | `/` |
| `VITE_SUPABASE_URL` | Supabase 项目 URL（一起听功能需要） | 空 |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon public key（一起听功能需要） | 空 |
| `VITE_NETEASE_API_BASE` | 网易云音乐 API 地址 | 空 |

> 注意：
> - `VITE_` 前缀的变量会被注入到前端构建产物中
> - Supabase anon key 设计上是公开的，但建议自行部署 Supabase 实例
> - 网易云 API 为第三方服务，请自行部署 [NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi)

## 📁 目录结构

```
.
├── src/
│   ├── announcements/      # 公告系统（数据 + 弹窗组件）
│   ├── components/         # React 组件
│   │   ├── ui/             # shadcn/ui 基础组件
│   │   └── ...             # 业务组件
│   ├── contexts/           # React Context（一起听状态等）
│   ├── hooks/              # 自定义 Hooks
│   ├── lib/                # 工具库 / 服务层
│   │   ├── netease.ts      # 网易云 API 封装
│   │   ├── listenTogether.*.ts  # 一起听多后端实现
│   │   └── ...
│   ├── pages/              # 页面组件
│   ├── types/              # TypeScript 类型定义
│   ├── app.tsx             # 应用入口 + 路由
│   ├── index.tsx           # React 挂载入口
│   └── index.css           # 全局样式
├── public/                 # 静态资源
├── shared/                 # 共享资源（能力声明等）
├── server/                 # 后端服务（WebSocket / 网易云 API 代理）
├── scripts/                # 构建和开发脚本
├── vite.config.ts          # Vite 配置
├── tsconfig.json           # TypeScript 配置
├── tailwind.config.js      # Tailwind 配置（如使用）
└── package.json
```

## 🏗️ 技术栈

- **前端框架** — React 19 + TypeScript
- **构建工具** — Vite 8
- **样式方案** — Tailwind CSS v4 + shadcn/ui (Radix UI)
- **动画** — Framer Motion
- **可视化渲染** — Canvas 2D + Three.js
- **音频处理** — Web Audio API (AudioContext / AnalyserNode)
- **视频录制** — MediaRecorder API
- **一起听** — Supabase Realtime / PeerJS (WebRTC) / WebSocket 三选一后端
- **路由** — React Router v7
- **状态管理** — React Context + useState/useReducer

## 🎧 一起听后端选项

一起听功能支持多种后端实现，按优先级自动选择：

1. **Supabase Realtime**（推荐）— 使用 Supabase 的 Broadcast + Presence，无需自建服务器
2. **WebSocket 服务** — 自建 Node.js WebSocket 服务（见 `server/listen-together.cjs`）
3. **PeerJS P2P** — 点对点直连，1v1 场景无服务器依赖

配置方式见「环境变量配置」。

## 📝 注意事项

1. **浏览器兼容性** — 建议使用最新版 Chrome / Edge / Firefox / Safari
2. **视频录制** — 使用 MediaRecorder API，输出格式为 WebM；如需 MP4 请自行转码
3. **网易云音乐** — 使用第三方 API 服务，登录功能依赖 cookie，存在被风控风险，仅供学习交流使用
4. **音频格式** — 支持浏览器原生可播放的音频格式，具体取决于浏览器
5. **一起听功能** — 需要部署后端服务或配置 Supabase 才能使用多人同步功能
6. **数据存储** — 播放列表、设置偏好等存储在浏览器 localStorage 中，清除缓存会丢失

## ⚠️ 第三方服务说明

- **网易云音乐 API**：使用 [NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi) 或兼容服务，需自行部署。登录相关接口有 IP 风控风险，请勿用于商业用途。
- **Supabase**：一起听功能使用 Supabase Realtime 作为消息中转，需自行注册项目并配置 URL 和 anon key。
- **字体**：使用 Google Fonts（Space Grotesk + Noto Sans SC），如需离线使用请自行下载并托管。

## 📄 许可证

待选择（用户决定）

---

*Built with ❤️ for music lovers*
