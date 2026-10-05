import path from 'path'
import { createLogger } from 'vite'
import { defineConfig } from '@lark-apaas/coding-preset-vite-react'

const CLIENT_BASE_PATH = process.env.CLIENT_BASE_PATH || '/'
// 去掉末尾斜杠，便于拼接
const base = CLIENT_BASE_PATH.endsWith('/')
  ? CLIENT_BASE_PATH.slice(0, -1)
  : CLIENT_BASE_PATH

// 自定义 logger：过滤 WS 代理的噪音错误
// WS 正常生命周期（页面刷新/HMR/重连）会导致 http-proxy 产生大量
// EPIPE / ECONNRESET / write after end 错误日志，这些不影响功能
const baseLogger = createLogger('info', {
  allowClearScreen: true,
})
const filteredLogger: typeof baseLogger = {
  ...baseLogger,
  error: (msg: string, options?: any) => {
    if (msg.includes('ws proxy error') || msg.includes('ws proxy socket error')) {
      return
    }
    baseLogger.error(msg, options)
  },
  warn: baseLogger.warn,
  info: baseLogger.info,
} as any

export default defineConfig({
  customLogger: filteredLogger,
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@shared': path.resolve(__dirname, 'shared'),
    },
  },
  build: {
    // 启用代码分割（preset 默认关闭）
    rolldownOptions: {
      output: {
        codeSplitting: true,
        // 手动拆分第三方大依赖，让首屏 bundle 尽可能小
        manualChunks(id: string) {
          if (id.includes('node_modules/three/') || id.includes('node_modules/three/src')) return 'vendor-three';
          if (id.includes('@supabase/supabase-js') || id.includes('node_modules/@supabase/')) return 'vendor-supabase';
          if (id.includes('framer-motion')) return 'vendor-framer';
          if (id.includes('@radix-ui/')) return 'vendor-radix';
          if (id.includes('peerjs')) return 'vendor-peerjs';
        },
      },
    },
  },
  server: {
    proxy: {
      // 一起听 WebSocket 后端代理（开发/沙箱环境）
      // 匹配：/ws 以及 /ws/xxx 子路径
      '/ws': {
        target: 'ws://127.0.0.1:8089',
        ws: true,
        changeOrigin: true,
        configure: (proxy: any) => {
          // 彻底静默 WS 代理错误日志
          // WS 正常生命周期（客户端断连/页面刷新/重连/心跳超时）
          // 会导致 http-proxy 产生 EPIPE / ECONNRESET / write after end 等错误
          // vite 内部会监听 proxy 的 error 事件并打印 [vite] ws proxy error
          // 这些都是噪音，不影响功能，这里劫持 emit 静默 error 事件
          const origEmit = proxy.emit.bind(proxy);
          proxy.emit = (event: string, ...args: any[]) => {
            if (event === 'error') return true;
            return origEmit(event, ...args);
          };
        },
      },
      // 带 basePath 的路径（沙箱预览环境：nginx → vite）
      // 如 /app/app_xxx/ws → 转发到 ws://127.0.0.1:8089/ws
      ...(base && base !== ''
        ? {
            [`${base}/ws`]: {
              target: 'ws://127.0.0.1:8089',
              ws: true,
              changeOrigin: true,
              rewrite: (p: string) => p.replace(new RegExp(`^${base}`), ''),
              configure: (proxy: any) => {
                const origEmit = proxy.emit.bind(proxy);
                proxy.emit = (event: string, ...args: any[]) => {
                  if (event === 'error') return true;
                  return origEmit(event, ...args);
                };
              },
            },
            // 健康检查
            [`${base}/health`]: {
              target: 'http://127.0.0.1:8089',
              changeOrigin: true,
              rewrite: (p: string) => p.replace(new RegExp(`^${base}`), ''),
            },
          }
        : {}),
      // 健康检查（根路径）
      '/health': {
        target: 'http://127.0.0.1:8089',
        changeOrigin: true,
      },
      // 网易云音乐 API 代理（后端 Node 服务）
      '/api/netease': {
        target: 'http://127.0.0.1:8090',
        changeOrigin: true,
      },
    },
  },
})
