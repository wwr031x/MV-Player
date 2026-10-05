#!/bin/bash
# 启动网易云音乐 API 代理服务
PORT=${NETEASE_API_PORT:-8090}
echo "[netease-api] 启动服务，端口: $PORT"
exec node server/netease-api.cjs
