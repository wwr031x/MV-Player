import type { ITrack, ISearchResult, IPlaylist, INeteaseUser } from '@/types';
import { logger, scopedStorage } from '@lark-apaas/client-toolkit-lite';

const API_BASE = 'https://api.2leo.top';

// ===== 多实例配置（登录相关接口专用） =====
// 顺序即优先级：宁波节点最快放首位，备用依次靠后
// 沙箱正常但用户手机可能因网络/CSP 不可达，因此登录相关接口按顺序逐个尝试
const LOGIN_API_INSTANCES = [
  'https://zm.wwoyun.cn',          // 宁波节点，~0.6s，已实测全链路通
  'https://music.mcseekeri.com',   // 备用，~2.6s
  'https://api.2leo.top',          // 沙箱正常、用户侧可能不可达，作为候选
];

// 当前登录会话选中的可用实例（内存级，刷新页面重新探测）
let _activeLoginBase: string | null = null;

function getLoginBaseList(): string[] {
  // 已有胜出实例：放到最前面，后面跟剩余实例作兜底
  if (_activeLoginBase) {
    const rest = LOGIN_API_INSTANCES.filter(b => b !== _activeLoginBase);
    return [_activeLoginBase, ...rest];
  }
  return [...LOGIN_API_INSTANCES];
}

function setActiveLoginBase(base: string): void {
  _activeLoginBase = base;
}

// 带多实例 fallback 的 fetch：逐个尝试实例，第一个成功返回的胜出
// predicate 可选：自定义"成功"判定（默认 res.ok 即成功）
async function fetchLoginApi(
  buildUrl: (base: string) => string,
  options: RequestInit = {},
  predicate?: (res: Response) => boolean,
): Promise<{ res: Response; base: string; url: string }> {
  const bases = getLoginBaseList();
  let lastErr: unknown = null;
  let lastUrl = '';
  for (const base of bases) {
    const url = buildUrl(base);
    lastUrl = url;
    try {
      // 注意：必须是"简单请求"——不设置任何自定义 header、不设 cache: 'no-store'，
      // 否则触发 CORS 预检 (OPTIONS)，而网易云 API 实例的预检响应
      // Access-Control-Allow-Headers 只允许 X-Requested-With,Content-Type，
      // 不包含 cache-control/pragma，会导致预检失败 → TypeError: Failed to fetch
      // 防缓存靠 URL 中的 timestamp 参数保证每次请求唯一
      const res = await fetchWithTimeout(url, { ...options, credentials: 'omit' });
      const ok = predicate ? predicate(res) : res.ok;
      if (ok) {
        setActiveLoginBase(base);
        return { res, base, url };
      }
      // HTTP 错误（如 403/502）：记录错误，继续下一个实例
      const httpErr = new Error(`HTTP ${res.status} ${res.statusText}`) as Error & { code?: number; base?: string; url?: string };
      httpErr.name = 'HttpError';
      httpErr.code = res.status;
      httpErr.base = base;
      httpErr.url = url;
      lastErr = httpErr;
    } catch (e) {
      const err = (e instanceof Error ? e : new Error(String(e))) as Error & { base?: string; url?: string };
      err.base = base;
      err.url = url;
      lastErr = err;
    }
  }
  // 所有实例都失败：抛出汇总错误
  const summary = bases.map(b => `· ${b}`).join('\n');
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  const err = new Error(`登录服务全部不可用\n尝试过的实例：\n${summary}\n最后错误：${msg}`) as Error & { cause?: unknown; url?: string; base?: string };
  err.name = 'LoginApiAllFailedError';
  err.cause = lastErr;
  err.url = lastUrl;
  err.base = bases[bases.length - 1];
  throw err;
}

// 仅使用当前已锁定的实例发请求（实例一致性保证）
// 用于 qr/check 轮询、qr/create 等必须与 getQrKey 用同一个实例的场景
// 若当前没有锁定的实例，回退到 fetchLoginApi 正常多实例探测
export async function fetchLoginLocked(
  buildUrl: (base: string) => string,
  options: RequestInit = {},
  predicate?: (res: Response) => boolean,
): Promise<{ res: Response; base: string; url: string }> {
  if (_activeLoginBase) {
    const base = _activeLoginBase;
    const url = buildUrl(base);
    const res = await fetchWithTimeout(url, { ...options, credentials: 'omit' });
    const ok = predicate ? predicate(res) : res.ok;
    if (ok) {
      return { res, base, url };
    }
    const httpErr = new Error(`HTTP ${res.status} ${res.statusText}`) as Error & { code?: number; base?: string; url?: string };
    httpErr.name = 'HttpError';
    httpErr.code = res.status;
    httpErr.base = base;
    httpErr.url = url;
    throw httpErr;
  }
  // 未锁定时：优先从 localStorage 读取上次使用的实例并验证，验证成功则锁定
  const savedBase = getLoginBase();
  if (savedBase) {
    try {
      const url = buildUrl(savedBase);
      const res = await fetchWithTimeout(url, { ...options, credentials: 'omit' });
      const ok = predicate ? predicate(res) : res.ok;
      if (ok) {
        _activeLoginBase = savedBase;
        return { res, base: savedBase, url };
      }
    } catch {
      // 上次保存的实例失效，清掉后走全量探测
      clearLoginBase();
    }
  }
  // 回退到正常多实例探测
  return fetchLoginApi(buildUrl, options, predicate);
}

/** 清除当前登录会话锁定的实例（用于二维码过期或整体重登场景） */
export function resetLoginBase(): void {
  _activeLoginBase = null;
  clearLoginBase();
}

// 超时与重试：登录相关 6 秒超时，失败重试 2 次
const TIMEOUT_MS = 6000;
const MAX_RETRY = 2;

// ===== 缓存配置 =====
const CACHE_TTL = {
  search: 5 * 60 * 1000,         // 搜索结果：5 分钟
  lyric: 5 * 24 * 3600 * 1000,   // 歌词：5 天（很少变，存 localStorage）
  songDetail: 24 * 3600 * 1000,  // 歌曲详情：1 天
  songUrl: 30 * 60 * 1000,       // 播放地址：30 分钟（可能过期，短缓存）
  playlistTracks: 10 * 60 * 1000,// 歌单曲目：10 分钟
  playlistDetail: 30 * 60 * 1000,// 歌单详情：30 分钟
  userPlaylists: 15 * 60 * 1000, // 用户歌单列表：15 分钟
  liked: 5 * 60 * 1000,          // 我喜欢：5 分钟
  recent: 3 * 60 * 1000,         // 最近播放：3 分钟
  loginStatus: 60 * 1000,        // 登录状态：60 秒（不频繁变，减少查状态请求）
  vipGrowth: 5 * 60 * 1000,      // VIP 成长值：5 分钟（基本不变）
};

// 内存缓存（LRU 式，按 key 存 {value, expireAt}）
const memCache = new Map<string, { value: any; expireAt: number }>();
const MAX_MEM_CACHE = 200; // 最多 200 条，避免无限膨胀

function memGet(key: string): any | undefined {
  const item = memCache.get(key);
  if (!item) return undefined;
  if (item.expireAt < Date.now()) {
    memCache.delete(key);
    return undefined;
  }
  // 命中时刷新 LRU（删了重塞到末尾）
  memCache.delete(key);
  memCache.set(key, item);
  return item.value;
}

function memSet(key: string, value: any, ttl: number) {
  if (memCache.size >= MAX_MEM_CACHE) {
    // 淘汰最老的（Map 迭代按插入顺序，第一个就是最老的）
    const firstKey = memCache.keys().next().value;
    if (firstKey !== undefined) memCache.delete(firstKey);
  }
  memCache.set(key, { value, expireAt: Date.now() + ttl });
}

// localStorage 持久化缓存（仅用于歌词这类基本不变的数据）
const STORAGE_CACHE_KEY = 'mvp_netease_cache_v1';

interface StorageCache {
  [key: string]: { value: any; expireAt: number };
}

function loadStorageCache(): StorageCache {
  try {
    const raw = scopedStorage.getItem(STORAGE_CACHE_KEY);
    return raw ? (JSON.parse(raw) as StorageCache) : {};
  } catch {
    return {};
  }
}

function saveStorageCache(cache: StorageCache) {
  try {
    // 控制大小：最多存 100 条歌词，约 100-200KB
    const keys = Object.keys(cache);
    if (keys.length > 100) {
      const sorted = keys.sort((a, b) => cache[a].expireAt - cache[b].expireAt);
      for (let i = 0; i < sorted.length - 100; i++) {
        delete cache[sorted[i]];
      }
    }
    scopedStorage.setItem(STORAGE_CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* storage 满或异常时忽略 */
  }
}

function storageGet(key: string): any | undefined {
  try {
    const cache = loadStorageCache();
    const item = cache[key];
    if (!item) return undefined;
    if (item.expireAt < Date.now()) {
      delete cache[key];
      saveStorageCache(cache);
      return undefined;
    }
    return item.value;
  } catch {
    return undefined;
  }
}

function storageSet(key: string, value: any, ttl: number) {
  try {
    const cache = loadStorageCache();
    cache[key] = { value, expireAt: Date.now() + ttl };
    saveStorageCache(cache);
  } catch {
    /* ignore */
  }
}

// 进行中的请求（用于去重，同 key 并发请求共享同一个 Promise）
const inflight = new Map<string, Promise<any>>();

function withCache<T>(
  key: string,
  ttl: number,
  fetcher: () => Promise<T>,
  options: { persist?: boolean } = {}
): Promise<T> {
  // 1. 内存缓存
  const cached = memGet(key);
  if (cached !== undefined) return Promise.resolve(cached);

  // 2. 持久化缓存（仅歌词等开启）
  if (options.persist) {
    const persisted = storageGet(key);
    if (persisted !== undefined) {
      memSet(key, persisted, ttl); // 回填到内存
      return Promise.resolve(persisted);
    }
  }

  // 3. 正在请求中 → 共享同一个 Promise，避免重复发请求
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  // 4. 真正发请求
  const promise = fetcher()
    .then((result) => {
      memSet(key, result, ttl);
      if (options.persist) storageSet(key, result, ttl);
      return result;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, promise);
  return promise;
}

// ===== 工具：带超时的 fetch =====
async function fetchWithTimeout(url: string, options: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ===== 工具：给 URL 追加无缓存参数（纯整数时间戳） =====
function noCacheUrl(url: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}timestamp=${Date.now()}`;
}

// 登录相关接口专用 fetch：匿名请求（ACAO=* 接口不允许带凭证）
// 注意：故意不设置 Cache-Control/Pragma 头，也不设 cache: 'no-store'，
// 避免触发 CORS 预检。防缓存通过 URL 中的 timestamp 参数保证。
async function fetchNoCache(url: string, options: RequestInit = {}): Promise<Response> {
  return fetchWithTimeout(noCacheUrl(url), {
    ...options,
    credentials: 'omit',
  });
}

// 带重试的 fetch：失败自动重试指定次数
async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  maxRetry = MAX_RETRY
): Promise<Response> {
  let lastError: unknown = null;
  for (let i = 0; i <= maxRetry; i++) {
    try {
      return await fetchNoCache(url, options);
    } catch (e) {
      lastError = e;
      if (i < maxRetry) {
        // 简单退避：200ms * 2^i
        await new Promise((r) => setTimeout(r, 200 * Math.pow(2, i)));
      }
    }
  }
  throw lastError;
}

// ===== 工具：获取/保存 cookie =====
const COOKIE_KEY = 'mvp_netease_cookie_v2';
const LOGIN_BASE_KEY = 'mvp_netease_base_v1';

function getCookie(): string {
  try {
    return localStorage.getItem(COOKIE_KEY) || '';
  } catch {
    return '';
  }
}

function saveCookie(cookie: string): void {
  try {
    localStorage.setItem(COOKIE_KEY, cookie);
  } catch {
    /* ignore */
  }
}

function clearCookie(): void {
  try {
    localStorage.removeItem(COOKIE_KEY);
  } catch {
    /* ignore */
  }
}

// 读取上次登录使用的实例（刷新后恢复，避免 /login/status 走不通的实例导致假未登录）
function getLoginBase(): string {
  try {
    return localStorage.getItem(LOGIN_BASE_KEY) || '';
  } catch {
    return '';
  }
}

function saveLoginBase(base: string): void {
  try {
    localStorage.setItem(LOGIN_BASE_KEY, base);
  } catch {
    /* ignore */
  }
}

function clearLoginBase(): void {
  try {
    localStorage.removeItem(LOGIN_BASE_KEY);
  } catch {
    /* ignore */
  }
}

// ===== 工具：把 cookie 拼成 query string =====
function cookieParams(): string {
  const c = getCookie();
  return c ? `&cookie=${encodeURIComponent(c)}` : '';
}

// ===== 工具：http 转 https =====
function toHttps(url: string): string {
  if (!url) return '';
  if (url.startsWith('http://')) {
    return 'https://' + url.substring(7);
  }
  return url;
}

// ===== 工具：统一封面 URL 提取 =====
// 唯一真相源：所有需要显示/采样封面的地方（缩略图、cover3d、歌单卡片等）必须调用本函数，
// 严禁各取各的字段，避免出现「缩略图有图、封面模式没图」的不一致问题。
export function getCoverUrl(song: any): string {
  if (!song) return '';
  const raw = song.coverUrl
    || song.picUrl
    || song.cover
    || song.album?.picUrl
    || song.album?.coverUrl
    || song.al?.picUrl
    || song.al?.coverUrl
    || song.albumPicUrl
    || song.pic
    || song.img
    || '';
  return toHttps(raw);
}

/**
 * 按尺寸生成网易云封面 URL（利用网易云图片服务的 ?param 裁剪能力）
 * - 列表/缩略图用小尺寸，减少带宽和加载时间
 * - 封面大图用大尺寸，保证清晰
 */
export function getCoverUrlSized(song: any, size: number): string {
  const url = getCoverUrl(song);
  if (!url) return '';
  // 网易云图片服务：p1.music.126.net / p2.music.126.net 等支持 ?param=200y200 裁剪
  // 只对 music.126.net 域名的图片加参数，其他域名不动
  if (!url.includes('music.126.net') && !url.includes('p1.music') && !url.includes('p2.music')) {
    // 兜底：netease 的各种子域名都尝试
    if (!url.includes('music.126')) return url;
  }
  // 已经有 param 参数就不改
  if (url.includes('?param=')) return url;
  const finalSize = Math.max(50, Math.min(2000, size));
  return `${url}?param=${finalSize}y${finalSize}`;
}

// ===== 工具：ms 转 秒 =====
function msToSec(ms: number): number {
  return Math.floor(ms / 1000);
}

// ===== 搜索 =====
export async function searchSongs(keywords: string, limit = 50, offset = 0): Promise<ISearchResult> {
  const kw = keywords.trim().toLowerCase();
  if (!kw) return { songs: [], total: 0, hasMore: false };
  const cacheKey = `search:${kw}:${limit}:${offset}`;
  return withCache(cacheKey, CACHE_TTL.search, async () => {
    const res = await fetchWithTimeout(
      `${API_BASE}/cloudsearch?keywords=${encodeURIComponent(kw)}&limit=${limit}&offset=${offset}${cookieParams()}`
    );
    const data = await res.json();
    const result = data.result || {};
    const songs = (result.songs || []).map(mapNeteaseSong);
    return {
      songs,
      total: result.songCount || 0,
      hasMore: result.hasMore || false,
    };
  });
}

// ===== 网易云歌曲映射成 ITrack =====
function mapNeteaseSong(s: any): ITrack {
  const fee = s.fee ?? s.privilege?.fee ?? 0;
  return {
    id: `netease_${s.id}`,
    name: s.name,
    artist: (s.ar || s.artists || []).map((a: any) => a.name).join(' / '),
    album: s.al?.name || s.album?.name || '',
    coverUrl: getCoverUrl(s),
    duration: msToSec(s.dt || s.duration || 0),
    neteaseId: s.id,
    source: 'netease',
    fee,
    isVip: fee === 1 || fee === 4 || fee === 10 || fee === 13,
  };
}

// ===== 获取播放地址 =====
export async function getSongUrl(id: number): Promise<string> {
  const cacheKey = `songUrl:${id}`;
  return withCache(cacheKey, CACHE_TTL.songUrl, async () => {
    // 并发尝试所有质量档 + 老接口，取第一个返回有效 URL 的结果
    // 高质量优先的同时避免串行等待
    const urls = [
      `${API_BASE}/song/url/v1?id=${id}&level=exhigh${cookieParams()}`,
      `${API_BASE}/song/url/v1?id=${id}&level=higher${cookieParams()}`,
      `${API_BASE}/song/url/v1?id=${id}&level=standard${cookieParams()}`,
      `${API_BASE}/song/url?id=${id}${cookieParams()}`,
    ];

    // 并发发起所有请求，逐个检查结果，返回第一个有效的 URL
    const promises = urls.map((url) =>
      fetchWithTimeout(url)
        .then((res) => res.json())
        .then((data) => data?.data?.[0]?.url || '')
        .catch(() => '')
    );

    // 按优先级顺序等：exhigh 先返回就用 exhigh，其次 higher，以此类推
    // Promise.any 不行——它只看最快的，不管质量
    // 用 for-await 实现：按顺序检查，哪个先解析出有效值就返回哪个
    // 但为了保证高质量优先，我们用 Promise.allSettled 然后从高质量往下找第一个有值的
    const results = await Promise.allSettled(promises);
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        return toHttps(r.value);
      }
    }
    return '';
  });
}

// ===== 获取歌词 =====
export interface ILyricLine {
  time: number; // 秒
  text: string;
  translation?: string; // 翻译
}

export async function getLyric(id: number): Promise<ILyricLine[]> {
  const cacheKey = `lyric:${id}`;
  return withCache(
    cacheKey,
    CACHE_TTL.lyric,
    async () => {
      try {
        const res = await fetchWithTimeout(`${API_BASE}/lyric?id=${id}${cookieParams()}`);
        const data = await res.json();
        const lrc = data?.lrc?.lyric || '';
        const tlyric = data?.tlyric?.lyric || '';
        const mainLines = parseLrc(lrc);
        if (tlyric) {
          const transLines = parseLrc(tlyric);
          // 按时间合并翻译
          const transMap = new Map<number, string>();
          for (const tl of transLines) {
            transMap.set(Math.round(tl.time * 10) / 10, tl.text);
          }
          for (const ml of mainLines) {
            const key = Math.round(ml.time * 10) / 10;
            // 允许 ±0.1s 误差匹配
            const trans = transMap.get(key) || transMap.get(Math.round((ml.time + 0.1) * 10) / 10) || transMap.get(Math.round((ml.time - 0.1) * 10) / 10);
            if (trans) ml.translation = trans;
          }
        }
        return mainLines;
      } catch {
        return [];
      }
    },
    { persist: true }
  );
}

function parseLrc(lrc: string): ILyricLine[] {
  const lines = lrc.split('\n');
  const result: ILyricLine[] = [];
  const timeReg = /\[(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]/g;

  for (const line of lines) {
    const text = line.replace(timeReg, '').trim();
    if (!text) continue;

    let match;
    timeReg.lastIndex = 0;
    while ((match = timeReg.exec(line)) !== null) {
      const min = parseInt(match[1], 10);
      const sec = parseInt(match[2], 10);
      const ms = match[3] ? parseInt(match[3].padEnd(3, '0'), 10) : 0;
      const time = min * 60 + sec + ms / 1000;
      result.push({ time, text });
    }
  }

  // 过滤 credit/元数据行：作词/作曲/编曲/演唱等信息不进入歌词舞台
  const creditPattern = /^(作词|作曲|编曲|演唱|歌手|原唱|翻唱|混音|母带|录音|后期|制作|出品|监制|吉他|贝斯|鼓|架子鼓|钢琴|键盘|弦乐|和声|合声|和声编写|人声|人声录制|吉他录制|贝斯录制|鼓录制|弦乐编写|弦乐监制|配唱|制作人|企划|统筹|宣传|发行|OP|SP|版权|鸣谢|特别感谢|by|By|BY)[:：]/i;
  const filtered = result.filter(line => !creditPattern.test(line.text));
  const source = filtered.length > 0 ? filtered : result;
  // 必须按时间升序排序（LRC 允许多时间戳同行、行顺序不按时间排列）
  return source.sort((a, b) => a.time - b.time);
}

// ===== 歌曲详情（批量）=====
export async function getSongDetail(ids: number[]): Promise<ITrack[]> {
  if (ids.length === 0) return [];

  // 1. 先从缓存里捞已有的
  const cached: ITrack[] = [];
  const missing: number[] = [];
  for (const id of ids) {
    const c = memGet(`song:${id}`) as ITrack | undefined;
    if (c) cached.push(c);
    else missing.push(id);
  }

  // 2. 全部命中直接返回（保持原顺序）
  if (missing.length === 0) {
    const map = new Map(cached.map((s) => [s.neteaseId, s]));
    return ids.map((id) => map.get(id)!).filter(Boolean);
  }

  // 3. 只请求未命中的
  const cacheKey = `songDetail:${missing.sort((a, b) => a - b).join(',')}`;
  const fetched = await withCache(cacheKey, CACHE_TTL.songDetail, async () => {
    const res = await fetchWithTimeout(
      `${API_BASE}/song/detail?ids=${missing.join(',')}${cookieParams()}`
    );
    const data = await res.json();
    return (data.songs || []).map(mapNeteaseSong);
  });

  // 4. 逐首写入单首级缓存（后续单首查询可命中）
  for (const song of fetched) {
    if (song.neteaseId) {
      memSet(`song:${song.neteaseId}`, song, CACHE_TTL.songDetail);
    }
  }

  // 5. 合并缓存 + 新请求，保持 ids 顺序
  const allMap = new Map([...cached, ...fetched].map((s) => [s.neteaseId, s]));
  return ids.map((id) => allMap.get(id)).filter(Boolean) as ITrack[];
}

// ===== 扫码登录 =====
// 当前生成二维码的 key（登录流程内缓存，减少前后端调用次数）
let _qrKeyCache = '';

export async function getQrKey(): Promise<string> {
  try {
    const { res, url } = await fetchLoginApi(
      (base) => `${base}/login/qr/key?timestamp=${Date.now()}`,
    );
    const json = await res.json();
    // 返回结构 {code,data:{code,unikey}}
    const data = json?.data || json;
    const key = data?.unikey || '';
    if (key) _qrKeyCache = key;
    if (!key) {
      const err = new Error(`getQrKey 返回为空 (code=${json?.code ?? 'unknown'})`) as Error & { code?: number; url?: string };
      err.name = 'QrKeyEmptyError';
      err.code = json?.code;
      err.url = url;
      throw err;
    }
    return key;
  } catch (e) {
    // 给错误附加 URL 信息，便于前端定位
    const err = (e instanceof Error ? e : new Error(String(e))) as Error & { url?: string };
    if (!err.url) err.url = '[unknown]';
    throw err;
  }
}

export async function getQrImage(key: string): Promise<string> {
  try {
    // 用锁定的实例：qr/create 必须跟 qr/key 在同一实例上生成
    const { res, url } = await fetchLoginLocked(
      (base) => `${base}/login/qr/create?key=${encodeURIComponent(key)}&qrimg=true&timestamp=${Date.now()}`,
    );
    const json = await res.json();
    const data = json?.data || json;
    const qrimg = data?.qrimg || '';
    if (!qrimg) {
      const err = new Error(`getQrImage 返回为空 (code=${json?.code ?? 'unknown'})`) as Error & { code?: number; url?: string };
      err.name = 'QrImageEmptyError';
      err.code = json?.code;
      err.url = url;
      throw err;
    }
    return qrimg;
  } catch (e) {
    const err = (e instanceof Error ? e : new Error(String(e))) as Error & { url?: string };
    if (!err.url) err.url = '[unknown]';
    throw err;
  }
}

export type QrStatus = 'waiting' | 'scanned' | 'success' | 'expired' | 'error';

export async function checkQrStatus(key: string): Promise<{ status: QrStatus; message: string; cookie?: string; base?: string; url?: string; rawCode?: number }> {
  try {
    // 用锁定的实例：轮询 check 必须跟 qr/key 在同一实例上
    // 不同实例的 key 不通用，跨实例会永远返回 801/等待扫码
    const { res, base, url } = await fetchLoginLocked(
      (b) => `${b}/login/qr/check?key=${encodeURIComponent(key)}&timestamp=${Date.now()}`,
      {},
      // qr/check 接口所有状态都返回 200，res.ok 永远为 true
      // 这里不做额外判定，直接让上层解析 body.code
    );
    const data = await res.json();
    const code = data.code;
    // 800 二维码过期 801 等待扫码 802 扫码成功等待确认 803 登录成功
    switch (code) {
      case 803: {
        // cookie 可能是字符串或字符串数组，做兼容拼接
        let cookie = '';
        if (Array.isArray(data.cookie)) {
          cookie = data.cookie.join('; ');
        } else if (typeof data.cookie === 'string') {
          cookie = data.cookie;
        }
        // 803 必须包含 MUSIC_U 才算真正授权成功；没有 MUSIC_U 只是 NMTID 等非核心 cookie
        // 此时视为登录未完成，继续轮询（后续 check 可能拿到带 MUSIC_U 的完整 cookie）
        if (!cookie || !/MUSIC_U=/.test(cookie)) {
          return {
            status: 'waiting',
            message: '授权确认中...',
            base,
            url,
            rawCode: code,
          };
        }
        saveCookie(cookie);
        return { status: 'success', message: '登录成功', cookie, base, url, rawCode: code };
      }
      case 802:
        return { status: 'scanned', message: data.message || '已扫码，请在手机上确认', base, url, rawCode: code };
      case 801:
        return { status: 'waiting', message: data.message || '等待扫码', base, url, rawCode: code };
      case 800:
        return { status: 'expired', message: data.message || '二维码已过期', base, url, rawCode: code };
      default:
        return { status: 'error', message: data.message || '登录服务返回异常', base, url, rawCode: code };
    }
  } catch (e) {
    const err = (e instanceof Error ? e : new Error(String(e))) as Error & { url?: string; base?: string };
    return {
      status: 'error',
      message: `登录服务请求失败：${err.message || String(e)}`,
      base: err.base,
      url: err.url,
    };
  }
}

// ===== 登录状态 / 用户信息（走 api.2leo.top）=====
// 注意：跨域下 fetch 不能通过 Cookie header 发送第三方 cookie（ACAO=* 不允许 credentials）
// 改用 NeteaseCloudMusicApi 支持的 ?cookie= query 参数传递登录态
export async function getLoginStatus(forceRefresh = false): Promise<INeteaseUser | null> {
  if (forceRefresh) {
    memCache.delete('login:status');
  }
  const cookie = getCookie();
  // 没有 cookie 直接返回 null（明确未登录）
  if (!cookie) return null;
  return withCache('login:status', CACHE_TTL.loginStatus, async () => {
    try {
      // cookie 放 query 里，兼容跨域
      const cookieQ = `&cookie=${encodeURIComponent(cookie)}`;
      // 登录状态查询走 fetchLoginLocked：优先用 localStorage 中保存的实例，
      // 失败时再全量探测（MUSIC_U 是网易云账号级，所有实例都能校验通过）
      const { res, base } = await fetchLoginLocked(
        (base) => `${base}/login/status?timestamp=${Date.now()}${cookieQ}`,
      );
      const json = await res.json();
      // api 返回 {data: {code, account, profile}} 结构
      const data = json?.data || json;
      const profile = data?.profile;
      if (!profile || !profile.userId) {
        // 明确返回未登录（如 cookie 真的失效）：清除缓存，但不清 cookie 和 base，
        // 留待下一次重试或用户手动重新登录（避免网络抖动误清）
        memCache.delete('login:status');
        return null;
      }

      // 登录有效 → 持久化当前实例，下次刷新直接用
      saveLoginBase(base);

      const account = data?.account;
      const vipInfo = parseNeteaseVipInfo(profile, account, data);

      const user: INeteaseUser = {
        userId: profile.userId,
        nickname: profile.nickname,
        avatarUrl: toHttps(profile.avatarUrl),
        cookie: getCookie(),
        level: profile.level || data.level || 0,
        vipType: vipInfo.vipType,
        vipLabel: vipInfo.vipLabel || undefined,
        vipColor: vipInfo.vipColor || undefined,
        vipIconType: vipInfo.vipIconType || undefined,
      };

      return user;
    } catch {
      // 网络异常/请求失败：不清 cookie，不清 base，保留凭证等待重试
      // （withCache 会返回 null，但不会删除已有缓存值——失败不走缓存写入逻辑）
      memCache.delete('login:status');
      return null;
    }
  });
}

/**
 * 本地是否有 cookie（快速判断，用于 UI 展示"恢复登录中"状态）
 * 有 cookie 但 getLoginStatus 还在请求中时，UI 不应直接展示为未登录
 */
export function hasLocalCookie(): boolean {
  const c = getCookie();
  return !!c && /MUSIC_U=/.test(c);
}

/**
 * 解析网易云 VIP 等级信息
 *
 * 字段说明（基于网易云音乐公开 API 实际返回）：
 * - account.vipType: 会员类型（旧字段）
 *   0=非会员, 1=音乐包, 10=黑胶VIP, 11=SVIP(豪华黑胶), 21=SVIP(老版), 3=黑胶月卡, 30=黑胶年卡
 * - profile.vipType: 同 account.vipType（profile 里也有一份）
 * - profile.redVipType: 红 V 类型，黑胶 VIP 的另一个标识字段
 *   0=非会员, 1=普通黑胶, 11=SVIP/豪华黑胶
 * - profile.vipRights: 会员权益对象
 *   - associator: 音乐包权益 {rights: number} (存在且 rights>0 = 有音乐包)
 *   - musicPackage: 音乐包（新字段，部分接口返回）
 *   - redVipLevel / redplusVipLevel: 黑胶等级 / 豪华黑胶等级
 *
 * 优先级：vipRights > redVipType > vipType（字段越具体越可信）
 */
function parseNeteaseVipInfo(
  profile: any,
  account: any,
  rootData: any,
): { vipType: number; vipLabel: string; vipColor: string; vipIconType: INeteaseUser['vipIconType'] } {
  // 读取各字段
  const vipType = account?.vipType ?? profile?.vipType ?? rootData?.vipType ?? 0;
  const redVipType = profile?.redVipType ?? 0;
  const vipRights = profile?.vipRights || {};
  const redVipLevel = vipRights?.redVipLevel ?? 0;
  const redplusVipLevel = vipRights?.redplusVipLevel ?? 0;

  // 音乐包权益：associator.rights > 0 或 musicPackage 存在
  const hasMusicPackage = 
    (vipRights?.associator && vipRights.associator.rights > 0) ||
    (vipRights?.musicPackage && vipRights.musicPackage.rights > 0);

  // 黑胶 VIP（红 V）
  const hasRedVip = 
    redVipType === 1 ||
    redVipType === 10 ||
    vipType === 10 ||
    vipType === 3 ||
    vipType === 30 ||
    redVipLevel > 0;

  // SVIP / 豪华黑胶
  const isSVIP = 
    redVipType === 11 ||
    vipType === 11 ||
    vipType === 21 ||
    vipType === 100 ||
    redplusVipLevel > 0;

  // 分级判断（从高到低）
  if (isSVIP) {
    return {
      vipType: 11,
      vipLabel: 'SVIP',
      vipColor: '#f59e0b', // 金色
      vipIconType: 'svip',
    };
  }
  if (hasRedVip) {
    return {
      vipType: 10,
      vipLabel: '黑胶VIP',
      vipColor: '#a855f7', // 紫色
      vipIconType: 'black',
    };
  }
  if (hasMusicPackage || vipType === 1 || vipType === 2) {
    return {
      vipType: 1,
      vipLabel: '音乐包',
      vipColor: '#22d3ee', // 青色
      vipIconType: 'package',
    };
  }
  // 普通用户
  return {
    vipType: 0,
    vipLabel: '',
    vipColor: '',
    vipIconType: 'none',
  };
}

// ===== 获取用户详情（等级/会员等）=====
export async function getUserDetail(uid: number): Promise<INeteaseUser | null> {
  try {
    const res = await fetchWithTimeout(
      `${API_BASE}/user/detail?uid=${uid}${cookieParams()}`
    );
    const data = await res.json();
    const profile = data.profile;
    if (!profile) return null;

    const vipInfo = parseNeteaseVipInfo(profile, null, data);

    const user: INeteaseUser = {
      userId: profile.userId,
      nickname: profile.nickname,
      avatarUrl: toHttps(profile.avatarUrl),
      cookie: getCookie(),
      level: profile.level || data.level || 0,
      vipType: vipInfo.vipType,
      vipLabel: vipInfo.vipLabel || undefined,
      vipColor: vipInfo.vipColor || undefined,
      vipIconType: vipInfo.vipIconType || undefined,
    };

    // 并行拉成长值（不阻塞）
    getVipGrowthPoint().then((growth) => {
      if (growth) {
        user.growthLevel = growth.level;
        user.growthValue = growth.growthValue;
        user.growthNextLevel = growth.nextLevelValue;
        user.growthProgress = growth.progress;
      }
    }).catch(() => { /* ignore */ });

    return user;
  } catch {
    return null;
  }
}

export async function logout(): Promise<{ ok: boolean; message?: string }> {
  try {
    const cookie = getCookie();
    if (!cookie) {
      clearCookie();
      return { ok: true };
    }
    // 调用网易云 API 登出接口，清除服务端会话
    // 走锁定实例，与登录态所在实例一致
    const { res } = await fetchLoginLocked(
      (base) => `${base}/logout?timestamp=${Date.now()}&cookie=${encodeURIComponent(cookie)}`,
      { method: 'POST' },
    );
    const data = await res.json();
    // 无论服务端是否成功，都清除本地 cookie（否则会出现"登出按钮点了没反应"）
    clearCookie();
    // 清除内存中的登录状态缓存，避免下一次登录命中旧缓存
    memCache.delete('login:status');
    // 登出后重置实例锁定，下一次登录重新探测最优实例
    resetLoginBase();
    if (data.code === 200) {
      return { ok: true };
    }
    return { ok: true, message: '已清除本地登录信息' };
  } catch (e) {
    // 网络异常也要清本地，保证用户能回到未登录状态
    clearCookie();
    memCache.delete('login:status');
    resetLoginBase();
    return { ok: true, message: '网络异常，已清除本地登录信息' };
  }
}

// ===== 黑胶会员成长值 =====
// 网易云黑胶各等级所需成长值（官方阈值，基于接口实际返回校准）
const GROWTH_LEVEL_THRESHOLDS = [
  0,      // V0 (占位，不用)
  0,      // V1
  800,    // V2
  2800,   // V3
  6800,   // V4
  12800,  // V5
  16000,  // V6
  24000,  // V7
  40000,  // V8
  64000,  // V9
  100000, // V10
];

function getGrowthLevelInfo(growthValue: number): {
  level: number;
  nextLevelValue: number;
  progress: number;
} {
  if (growthValue == null || growthValue < 0) growthValue = 0;
  let level = 1;
  for (let i = GROWTH_LEVEL_THRESHOLDS.length - 1; i >= 1; i--) {
    if (growthValue >= GROWTH_LEVEL_THRESHOLDS[i]) {
      level = i;
      break;
    }
  }
  const curThreshold = GROWTH_LEVEL_THRESHOLDS[level] ?? 0;
  const nextThreshold = GROWTH_LEVEL_THRESHOLDS[level + 1] ?? curThreshold + 100000;
  const range = nextThreshold - curThreshold;
  const progress = range > 0 ? (growthValue - curThreshold) / range : 1;
  return {
    level,
    nextLevelValue: nextThreshold,
    progress: Math.max(0, Math.min(1, progress)),
  };
}

export async function getVipGrowthPoint(): Promise<{
  growthValue: number;
  level: number;
  nextLevelValue: number;
  progress: number;
  levelName?: string;
  vipType?: number;
} | null> {
  return withCache('vip:growth', CACHE_TTL.vipGrowth, async () => {
    try {
    const res = await fetchWithTimeout(
      `${API_BASE}/vip/growthpoint?timestamp=${Date.now()}${cookieParams()}`
    );
    const data = await res.json();

    // 真实接口路径：data.userLevel.level / data.userLevel.growthPoint / data.userLevel.levelName
    const userLevel = data?.data?.userLevel;
    if (!userLevel) return null;

    const growthValue = typeof userLevel.growthPoint === 'number' ? userLevel.growthPoint : 0;
    let level = typeof userLevel.level === 'number' ? userLevel.level : 0;
    const levelName = typeof userLevel.levelName === 'string' ? userLevel.levelName : undefined;
    const vipType = typeof userLevel.vipType === 'number' ? userLevel.vipType : undefined;

    // 如果接口没返回 level 但有成长值，用本地阈值表推导
    if ((!level || level <= 0) && growthValue > 0) {
      level = getGrowthLevelInfo(growthValue).level;
    }

    // 有 level 就视为有效（包括 V1=0 成长值的情况），用阈值表算进度
    const calcLevel = level && level > 0 ? level : getGrowthLevelInfo(growthValue).level;
    const info = getGrowthLevelInfo(growthValue);
    // 以接口返回的等级为准，但进度用阈值表计算（保证显示一致）
    const finalLevel = calcLevel;
    const curThreshold = GROWTH_LEVEL_THRESHOLDS[finalLevel] ?? 0;
    const nextThreshold = GROWTH_LEVEL_THRESHOLDS[finalLevel + 1] ?? curThreshold + 100000;
    const range = nextThreshold - curThreshold;
    const progress = range > 0 ? (growthValue - curThreshold) / range : 1;

      return {
        growthValue,
        level: finalLevel,
        nextLevelValue: nextThreshold,
        progress: Math.max(0, Math.min(1, progress)),
        levelName,
        vipType,
      };
    } catch (e) {
      logger.warn('getVipGrowthPoint failed:', String(e));
      return null;
    }
  });
}

// ===== 用户歌单 =====
export async function getUserPlaylists(uid: number): Promise<IPlaylist[]> {
  const cacheKey = `userPlaylists:${uid}`;
  return withCache(cacheKey, CACHE_TTL.userPlaylists, async () => {
    try {
      const res = await fetchWithTimeout(
        `${API_BASE}/user/playlist?uid=${uid}${cookieParams()}`
      );
      const data = await res.json();
      return (data.playlist || []).map((p: any) => ({
        id: p.id,
        name: p.name,
        coverUrl: toHttps(p.coverImgUrl),
        trackCount: p.trackCount,
      }));
    } catch {
      return [];
    }
  });
}

// ===== 歌单详情 =====
// ===== 全量拉取歌单所有曲目（用于「播放全部」先拿全量元数据，不一次性物化音频） =====
export async function getAllPlaylistTracks(id: number): Promise<{ tracks: ITrack[]; total: number }> {
  const PAGE_SIZE = 100; // 该接口一次最多 100
  const first = await getPlaylistTracks(id, PAGE_SIZE, 0);
  const total = first.total;
  const all: ITrack[] = [...first.tracks];
  if (all.length >= total || total === 0) return { tracks: all, total };

  // 并发分批拉取剩余页
  const pageCount = Math.ceil(total / PAGE_SIZE);
  const pages: Promise<ITrack[]>[] = [];
  for (let p = 1; p < pageCount; p++) {
    pages.push(
      getPlaylistTracks(id, PAGE_SIZE, p * PAGE_SIZE).then(r => r.tracks)
    );
  }
  const results = await Promise.all(pages);
  for (const batch of results) {
    all.push(...batch);
  }
  return { tracks: all.slice(0, total), total };
}

export async function getPlaylistTracks(id: number, limit = 30, offset = 0): Promise<{ tracks: ITrack[]; total: number }> {
  const cacheKey = `playlistTracks:${id}:${limit}:${offset}`;
  return withCache(cacheKey, CACHE_TTL.playlistTracks, async () => {
    try {
      // 曲目列表 + 歌单详情 并行请求（原来串行，节省一次 RTT）
      const [tracksRes, detailRes] = await Promise.all([
        fetchWithTimeout(
          `${API_BASE}/playlist/track/all?id=${id}&limit=${limit}&offset=${offset}${cookieParams()}`
        ),
        fetchWithTimeout(
          `${API_BASE}/playlist/detail?id=${id}${cookieParams()}`
        ),
      ]);
      const [tracksData, detailData] = await Promise.all([
        tracksRes.json(),
        detailRes.json(),
      ]);
      const songs = (tracksData.songs || []).map(mapNeteaseSong);
      const total = detailData.playlist?.trackCount || songs.length;
      // 把每首歌的详情也写入单曲缓存（后续切歌、搜索结果展示等能直接命中）
      for (const s of songs) {
        if (s.neteaseId) memSet(`song:${s.neteaseId}`, s, CACHE_TTL.songDetail);
      }
      return { tracks: songs, total };
    } catch {
      return { tracks: [], total: 0 };
    }
  });
}

// ===== 我喜欢的音乐 =====
// 走登录锁定实例，带 cookie query 参数
// 返回该用户收藏的所有歌曲 id 数组
export async function getLikedSongs(uid: number): Promise<{ ids: number[]; authRequired: boolean }> {
  const cookie = getCookie();
  if (!cookie) {
    return { ids: [], authRequired: true };
  }
  const cacheKey = `liked:${uid}`;
  const cached = memGet(cacheKey);
  if (cached !== undefined) {
    return { ids: cached as number[], authRequired: false };
  }
  try {
    const cookieQ = `&cookie=${encodeURIComponent(cookie)}`;
    const { res } = await fetchLoginLocked(
      (base) => `${base}/likelist?uid=${uid}&timestamp=${Date.now()}${cookieQ}`,
    );
    const data = await res.json();
    if (data?.code !== 200 || data?.code === 301) {
      return { ids: [], authRequired: true };
    }
    const ids = data.ids || [];
    memSet(cacheKey, ids, CACHE_TTL.liked);
    return { ids, authRequired: false };
  } catch {
    return { ids: [], authRequired: true };
  }
}

// 手动更新本地收藏缓存（红心切换时调用，避免整表重拉）
export function updateLikedCache(uid: number, songId: number, liked: boolean): void {
  const cacheKey = `liked:${uid}`;
  const cached = memGet(cacheKey) as number[] | undefined;
  if (!cached) return;
  const set = new Set(cached);
  if (liked) set.add(songId);
  else set.delete(songId);
  memSet(cacheKey, Array.from(set), CACHE_TTL.liked);
}

// ===== 切换收藏（红心）=====
// like=true 收藏 / like=false 取消收藏
// 走登录锁定实例，带 cookie
export async function toggleLike(songId: number, like: boolean): Promise<{ success: boolean; authRequired: boolean }> {
  const cookie = getCookie();
  if (!cookie) {
    return { success: false, authRequired: true };
  }
  try {
    const cookieQ = `&cookie=${encodeURIComponent(cookie)}`;
    const { res } = await fetchLoginLocked(
      (base) => `${base}/like?id=${songId}&like=${like}&timestamp=${Date.now()}${cookieQ}`,
    );
    const data = await res.json();
    if (data?.code === 301) {
      return { success: false, authRequired: true };
    }
    return { success: data?.code === 200, authRequired: false };
  } catch {
    return { success: false, authRequired: false };
  }
}

// ===== 最近播放 =====
export async function getRecentSongs(limit = 30): Promise<ITrack[]> {
  const cacheKey = `recent:${limit}`;
  return withCache(cacheKey, CACHE_TTL.recent, async () => {
    try {
      const res = await fetchWithTimeout(
        `${API_BASE}/record/recent/song?limit=${limit}${cookieParams()}`
      );
      const data = await res.json();
      const list = data.data?.list || [];
      const songs = list.map((item: any) => mapNeteaseSong(item.song || item));
      // 写入单曲缓存
      for (const s of songs) {
        if (s.neteaseId) memSet(`song:${s.neteaseId}`, s, CACHE_TTL.songDetail);
      }
      return songs;
    } catch {
      return [];
    }
  });
}

// ===== 每日推荐歌曲（需登录）=====
// 走已锁定的登录实例，cookie 作为 query 参数传递（简单 GET，不触发 CORS 预检）
// api 返回结构：{code:200, data: {dailySongs:[...]}}
export async function getDailyRecommend(): Promise<{ tracks: ITrack[]; total: number; authRequired: boolean }> {
  // 不缓存，每天内容不同
  const cookie = getCookie();
  if (!cookie) {
    return { tracks: [], total: 0, authRequired: true };
  }
  const cookieQ = `&cookie=${encodeURIComponent(cookie)}`;
  try {
    const { res } = await fetchLoginLocked(
      (base) => `${base}/recommend/songs?timestamp=${Date.now()}${cookieQ}`,
    );
    const json = await res.json();
    const data = json?.data || json;
    // 如果返回 code 非 200、或没有 dailySongs、或 data.code 为 301（未登录），视为凭证失效
    if (json?.code !== 200 || !data?.dailySongs || data?.code === 301) {
      return { tracks: [], total: 0, authRequired: true };
    }
    const list = data.dailySongs || [];
    const songs = list.map((s: any) => mapNeteaseSong(s));
    for (const s of songs) {
      if (s.neteaseId) memSet(`song:${s.neteaseId}`, s, CACHE_TTL.songDetail);
    }
    return { tracks: songs, total: songs.length, authRequired: false };
  } catch {
    return { tracks: [], total: 0, authRequired: true };
  }
}

// ===== 推荐新歌（免登录）=====
// 网易云 /personalized/newsong 接口，无需登录即可调用
// 返回结构：result[]，每项含 song 字段（完整歌曲信息）以及平铺的 id/name/picUrl 等
export async function getNewSongsRecommend(limit = 30): Promise<{ tracks: ITrack[]; total: number }> {
  const cacheKey = `newSongs:${limit}`;
  return withCache(cacheKey, CACHE_TTL.search, async () => {
    try {
      const res = await fetchWithTimeout(
        `${API_BASE}/personalized/newsong?limit=${limit}`
      );
      const data = await res.json();
      const list = data.result || [];
      // 兼容两种字段布局：歌曲信息可能在 .song 字段里，也可能平铺在 result 项上
      const songs = list.map((item: any) => {
        const songData = item.song || item;
        return mapNeteaseSong(songData);
      });
      // 写入单曲缓存
      for (const s of songs) {
        if (s.neteaseId) memSet(`song:${s.neteaseId}`, s, CACHE_TTL.songDetail);
      }
      return { tracks: songs, total: songs.length };
    } catch {
      return { tracks: [], total: 0 };
    }
  });
}

// ===== 推荐歌单（免登录）=====
// 网易云 /personalized 接口，无需登录即可调用，返回官方推荐歌单列表
export async function getPersonalizedPlaylists(limit = 12): Promise<IPlaylist[]> {
  const cacheKey = `personalized:${limit}`;
  return withCache(cacheKey, CACHE_TTL.userPlaylists, async () => {
    try {
      const res = await fetchWithTimeout(
        `${API_BASE}/personalized?limit=${limit}`
      );
      const data = await res.json();
      const list = data.result || [];
      return list.map((p: any) => ({
        id: p.id,
        name: p.name,
        coverUrl: toHttps(p.picUrl || p.coverImgUrl || ''),
        trackCount: p.trackCount || 0,
      }));
    } catch {
      return [];
    }
  });
}

// ===== 漫游 / 智能推荐 =====
// 网易云 /playmode/intelligence/list 接口，基于指定歌曲生成相似歌曲列表
// 需要登录（带 cookie），走登录锁定实例
// 每次获取 size 首（默认 30），用于「漫游」功能，歌曲快放完时追加下一批
export async function getIntelligenceList(
  songId: number | 0,
  size = 30
): Promise<{ tracks: ITrack[]; total: number; authRequired: boolean }> {
  // 不缓存，每次推荐结果不同
  const cookie = getCookie();
  if (!cookie) {
    return { tracks: [], total: 0, authRequired: true };
  }
  try {
    const cookieQ = `&cookie=${encodeURIComponent(cookie)}`;
    const sidParam = songId ? `&sid=${songId}` : '';
    const { res } = await fetchLoginLocked(
      (base) => `${base}/playmode/intelligence/list?count=${size}${sidParam}&timestamp=${Date.now()}${cookieQ}`,
    );
    const data = await res.json();
    if (data?.code === 301) {
      return { tracks: [], total: 0, authRequired: true };
    }
    const list = data.data || [];
    const songs = list
      .map((item: any) => mapNeteaseSong(item.songInfo || item))
      .filter((t: ITrack) => t.neteaseId && (songId ? t.neteaseId !== songId : true));
    for (const s of songs) {
      if (s.neteaseId) memSet(`song:${s.neteaseId}`, s, CACHE_TTL.songDetail);
    }
    return { tracks: songs, total: songs.length, authRequired: false };
  } catch {
    return { tracks: [], total: 0, authRequired: false };
  }
}

// ===== 相似歌曲漫游 =====
// 网易云 /simi/song 接口，基于指定歌曲 id 获取相似歌曲列表，无需登录
// 用于「相似歌曲漫游」功能，每次拉取 limit 首，支持自动续推
export async function getSimilarSongs(
  songId: number,
  limit = 50
): Promise<{ tracks: ITrack[]; total: number }> {
  try {
    const res = await fetchWithTimeout(
      `${API_BASE}/simi/song?id=${songId}&limit=${limit}`
    );
    const data = await res.json();
    const list = data.songs || [];
    const songs = list
      .map((s: any) => mapNeteaseSong(s))
      .filter((t: ITrack) => t.neteaseId && t.neteaseId !== songId);
    for (const s of songs) {
      if (s.neteaseId) memSet(`song:${s.neteaseId}`, s, CACHE_TTL.songDetail);
    }
    return { tracks: songs, total: songs.length };
  } catch {
    return { tracks: [], total: 0 };
  }
}
