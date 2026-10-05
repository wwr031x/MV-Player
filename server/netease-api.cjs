/**
 * 网易云音乐 API 代理服务
 *
 * 使用 NeteaseCloudMusicApi npm 包，在 Node 后端做网易云请求代理，
 * 避免浏览器跨域与风控问题。后端无状态，cookie 由前端每次传入。
 *
 * 端口：8090（与 /ws 的 8089 区分）
 */

const http = require('node:http');
const { URL } = require('node:url');
const {
  login_qr_key,
  login_qr_create,
  login_qr_check,
  login_status,
  recommend_songs,
} = require('NeteaseCloudMusicApi');

const PORT = Number(process.env.NETEASE_API_PORT || 8090);

// 读取请求 body（JSON）
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      if (!data) { resolve({}); return; }
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function handleOptions(res) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  });
  res.end();
}

const server = http.createServer(async (req, res) => {
  // CORS 预检
  if (req.method === 'OPTIONS') { handleOptions(res); return; }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  try {
    // ====== 健康检查 ======
    if (path === '/health' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, service: 'netease-api' });
      return;
    }

    // ====== 二维码 key ======
    if (path === '/api/netease/qr/key' && req.method === 'GET') {
      const result = await login_qr_key({ timestamp: Date.now() });
      sendJson(res, 200, {
        code: result.body?.code || 500,
        unikey: result.body?.data?.unikey || '',
        data: result.body?.data || {},
      });
      return;
    }

    // ====== 生成二维码 ======
    if (path === '/api/netease/qr/create' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const key = body.key;
      if (!key) { sendJson(res, 400, { code: 400, message: '缺少 key 参数' }); return; }
      const result = await login_qr_create({ key, qrimg: true, timestamp: Date.now() });
      sendJson(res, 200, {
        code: result.body?.code || 500,
        qrimg: result.body?.data?.qrimg || '',
        qrurl: result.body?.data?.qrurl || '',
        data: result.body?.data || {},
      });
      return;
    }

    // ====== 检查扫码状态 ======
    if (path === '/api/netease/qr/check' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const key = body.key;
      if (!key) { sendJson(res, 400, { code: 400, message: '缺少 key 参数' }); return; }
      let result;
      try {
        result = await login_qr_check({ key, timestamp: Date.now() });
      } catch (err) {
        // login_qr_check 在 800 过期时可能抛错
        sendJson(res, 200, { code: 800, message: '二维码已过期', cookie: '' });
        return;
      }
      const code = result.body?.code;
      // 803 = 登录成功，从响应中提取 cookie
      let cookie = '';
      if (code === 803) {
        // result.cookie 是 NeteaseCloudMusicApi 包装的 cookie 字符串数组
        const cookieArr = result.cookie || result.body?.cookie || [];
        if (Array.isArray(cookieArr)) {
          cookie = cookieArr.join('; ');
        } else if (typeof cookieArr === 'string') {
          cookie = cookieArr;
        }
        // 兜底：从 body 的 cookie / message 里拼
        if (!cookie && result.body?.cookie) {
          cookie = result.body.cookie;
        }
      }
      sendJson(res, 200, {
        code,
        message: result.body?.message || '',
        cookie,
        // 登录成功时返回昵称头像等（如果有）
        nickname: result.body?.nickname || '',
        avatarUrl: result.body?.avatarUrl || '',
      });
      return;
    }

    // ====== 登录状态 ======
    if (path === '/api/netease/login-status' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const cookie = body.cookie || '';
      let result;
      try {
        result = await login_status({ cookie });
      } catch (err) {
        sendJson(res, 200, { code: 301, message: '未登录或 cookie 失效', profile: null });
        return;
      }
      const profile = result.body?.data?.profile || result.body?.profile || null;
      const code = result.body?.code;
      if (!profile || code === 301 || code === -1) {
        sendJson(res, 200, { code: 301, message: '未登录或 cookie 失效', profile: null });
        return;
      }
      sendJson(res, 200, {
        code: 200,
        profile: {
          userId: profile.userId,
          nickname: profile.nickname,
          avatarUrl: profile.avatarUrl,
          vipType: profile.vipType,
          level: profile.level,
        },
      });
      return;
    }

    // ====== 每日推荐歌曲 ======
    if (path === '/api/netease/recommend/songs' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const cookie = body.cookie || '';
      if (!cookie) {
        sendJson(res, 401, { code: 301, message: '未登录，无法获取每日推荐' });
        return;
      }
      let result;
      try {
        result = await recommend_songs({ cookie });
      } catch (err) {
        sendJson(res, 200, { code: 500, message: '获取每日推荐失败', dailySongs: [] });
        return;
      }
      const dailySongs = result.body?.data?.dailySongs || result.body?.dailySongs || [];
      const orderSongs = result.body?.data?.orderSongs || result.body?.orderSongs || [];
      // 优先用 dailySongs，兜底用 orderSongs
      const songs = dailySongs.length > 0 ? dailySongs : orderSongs;
      sendJson(res, 200, {
        code: result.body?.code || 500,
        dailySongs: songs,
        total: songs.length,
      });
      return;
    }

    // 404
    sendJson(res, 404, { code: 404, message: 'Not Found' });
  } catch (err) {
    console.error('[netease-api] 处理请求出错:', path, err.message);
    sendJson(res, 500, { code: 500, message: err.message || '服务器内部错误' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[netease-api] 服务已启动: http://127.0.0.1:${PORT}`);
});
