// 构建信息：版本号 + 构建号 + 构建时间
// - appVersion: 来自 package.json 的语义化版本（发布时手动递增）
// - buildNumber: 来自平台 RELEASE_ID（每次部署自动生成），兜底为构建时间戳
// - buildTime: 构建时间字符串

// 注意：window.__RELEASE_COMMIT_ID__ 由 coding-preset-vite-react 在入口 HTML 头部注入
// （env RELEASE_ID 优先，兜底为构建时间 ISO 字符串）
declare global {
  interface Window {
    __RELEASE_COMMIT_ID__?: string;
  }
}

const pkgVersion = '0.1.0';

// 构建号：平台 releaseId 优先，否则回退到页面加载时间（近似构建时间）
const releaseId = typeof window !== 'undefined' && window.__RELEASE_COMMIT_ID__
  ? window.__RELEASE_COMMIT_ID__
  : new Date().toISOString().slice(0, 10);

// 构建时间：从 releaseId 解析（ISO 格式），否则用当前时间兜底
const buildTimeStr = (() => {
  if (typeof window !== 'undefined' && window.__RELEASE_COMMIT_ID__) {
    // releaseId 可能是 ISO 字符串或 hash
    const iso = window.__RELEASE_COMMIT_ID__;
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) {
      return iso.replace('T', ' ').slice(0, 19);
    }
  }
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
})();

export const buildInfo = {
  appVersion: pkgVersion,
  buildNumber: releaseId,
  buildTime: buildTimeStr,
};
