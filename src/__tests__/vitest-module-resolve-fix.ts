// 修复：client-toolkit-lite 在 vitest 环境下导入 crypto-js/sha1 缺少 .js 后缀导致 ESM 解析失败
// 在测试入口手动 patch 模块解析
export {};
