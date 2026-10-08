/**
 * 访问控制与隧道访问防护
 *
 * 背景：协调服务与执行端原本运行在受信任的局域网内，接口没有鉴权。
 * 一旦通过隧道（Cloudflare Tunnel / ngrok 等）暴露到公网，必须补两层：
 *
 *  1) 手机端作业接口的共享访问口令（避免任何人拿到网址就能提交任务/下载文档）；
 *  2) 管理接口的隧道访问阻断 —— 隧道客户端跑在本机，转发请求的源地址是 127.0.0.1，
 *     原 isLocalhostRequest() 会把公网来客误判为本机管理员，导致管理后台公开可写。
 *
 * 口令来源（按优先级）：环境变量 PHONE_ACCESS_TOKEN > data/access_token.txt（自动生成并复用）。
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const TOKEN_FILE = process.env.ACCESS_TOKEN_FILE
  ? path.resolve(process.env.ACCESS_TOKEN_FILE)
  : path.resolve(__dirname, '../../data/access_token.txt');

let cachedToken = null;

function safeTokenEquals(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  try {
    return crypto.timingSafeEqual(bufA, bufB);
  } catch (e) {
    return false;
  }
}

/** 取得手机端共享访问口令；未配置时自动生成并持久化，保证重启后不变 */
function getAccessToken() {
  if (cachedToken) return cachedToken;

  const fromEnv = (process.env.PHONE_ACCESS_TOKEN || '').trim();
  if (fromEnv) {
    cachedToken = fromEnv;
    return cachedToken;
  }

  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const existing = fs.readFileSync(TOKEN_FILE, 'utf-8').trim();
      if (existing) {
        cachedToken = existing;
        return cachedToken;
      }
    }
  } catch (e) {}

  // 生成易输入的口令：24 位大写字母与数字（去掉易混字符）
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let token = '';
  const bytes = crypto.randomBytes(24);
  for (let i = 0; i < 24; i++) token += alphabet[bytes[i] % alphabet.length];

  try {
    const dir = path.dirname(TOKEN_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, token + '\n', 'utf-8');
    try { fs.chmodSync(TOKEN_FILE, 0o600); } catch (e) {}
  } catch (e) {
    console.warn('[AccessControl] 无法持久化访问口令，本次运行使用临时口令:', e.message);
  }

  cachedToken = token;
  return cachedToken;
}

/** 重新读取口令文件（用于运行期更换口令） */
function reloadAccessToken() {
  cachedToken = null;
  return getAccessToken();
}

function parseCookies(req) {
  const header = req.headers && req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function extractToken(req) {
  const cookies = parseCookies(req);
  const fromCookie = cookies.phoneapp_token;
  const fromHeader = req.headers['x-phone-token'];
  const fromQuery = req.query && (req.query.k || req.query.token);
  const fromAuth = (() => {
    const a = req.headers.authorization || '';
    return a.toLowerCase().startsWith('bearer ') ? a.slice(7).trim() : '';
  })();
  return String(fromHeader || fromQuery || fromAuth || fromCookie || '').trim();
}

function isTokenValid(req) {
  const expected = getAccessToken();
  if (!expected) return false;
  return safeTokenEquals(extractToken(req), expected);
}

function isStaticOrLoginPath(p) {
  if (isWorkerPath(p)) return true;
  if (p === '/' || p === '/admin' || p === '/frontend' || p.startsWith('/frontend/')) return true;
  // 口令登录页
  if (p === '/login' || p === '/login.html') return true;
  if (p.startsWith('/previews/')) return true;
  if (p === '/api/access/verify' || p === '/api/access/login' || p === '/api/access/config') return true;
  // 手机端首次连接登记（只写客户端记录，不含业务数据）
  if (p === '/api/clients/register') return true;
  return false;
}

/**
 * 执行端接口是否只允许从“内部端口”访问。
 * 背景：隧道只发布对外端口（默认 3000）。执行端接口（心跳/取任务/回传文档/打印领取与回报）
 * 没有任何鉴权，若一并暴露到公网，任何人都能注册假执行端从而接收发货任务与 Word 模板。
 * 因此这些接口只允许从内部端口（默认 3001）访问；未配置内部端口时保持原有局域网行为。
 *
 * 注意（PR-B01 整改）：必须是“逐路由精确判定”，不能整段前缀放行。
 * 手机业务接口 `POST /api/print/submit`、打印状态查询 `GET /api/print/...` 属于经手机鉴权的
 * 业务接口，允许从对外端口访问；把它们一概算作执行端接口会导致手机提交打印被 403 拒绝。
 */
const WORKER_ONLY_PATHS = new Set([
  '/api/workers/heartbeat',
  '/api/print/pending'
]);

function isWorkerOnlyPath(pathname, method) {
  if (!pathname) return false;
  if (pathname.startsWith('/api/worker/')) return true;
  if (WORKER_ONLY_PATHS.has(pathname)) return true;
  // 执行端回报打印状态：POST /api/print/:id/status（手机侧只做只读查询）
  if ((method || 'GET').toUpperCase() === 'POST' && /^\/api\/print\/[^/]+\/status$/.test(pathname)) return true;
  return false;
}

/** 兼容原有调用：仅按路径判断（无方法信息时按最严格的执行端口径） */
function isWorkerPath(p) {
  if (!p) return false;
  if (p.startsWith('/api/worker/')) return true;
  if (WORKER_ONLY_PATHS.has(p)) return true;
  return /^\/api\/print\/[^/]+\/status$/.test(p);
}

function internalPort() {
  const raw = process.env.INTERNAL_PORT || process.env.WORKER_PORT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 返回 true 表示该请求应被拒绝（执行端接口被从对外端口访问） */
function shouldBlockWorkerPathOnPublicPort(req) {
  const ip = internalPort();
  if (!ip) return false;
  const p = req.path || '';
  if (!isWorkerOnlyPath(p, req.method)) return false;
  const localPort = (req.socket && req.socket.localPort) || 0;
  return Number(localPort) !== ip;
}

function usesTunnelHeader(req) {
  return Boolean(req.headers && req.headers['cf-connecting-ip']);
}

/** 请求是否真的来自协调服务本机（排除经隧道转发进来的公网访客） */
function isDirectLocalRequest(req) {
  if (usesTunnelHeader(req)) return false;
  const remoteIp = (req.socket && req.socket.remoteAddress) || (req.connection && req.connection.remoteAddress) || req.ip || '';
  return remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1';
}

function isTestEnvironment() {
  return process.env.NODE_ENV === 'test' || !!process.env.NODE_TEST_CONTEXT;
}

/** 手机端共享访问口令中间件 */
function accessTokenMiddleware(req, res, next) {
  // 自动化测试直接放行：测试运行在隔离数据库与隔离目录上，且不对外暴露
  if (isTestEnvironment()) return next();

  // 本机直连放行：管理员坐在协调服务电脑前操作（含管理控制台内部调用的只读接口）无需口令。
  // 注意 isDirectLocalRequest 会排除携带 Cloudflare 隧源头（cf-connecting-ip）的转发请求，
  // 因此公网访客即使源地址显示为 127.0.0.1 也不会被误放行。
  if (isDirectLocalRequest(req)) return next();

  const p = req.path || '';
  if (isStaticOrLoginPath(p)) return next();
  if (isTokenValid(req)) return next();

  // 记录未授权尝试，便于排查是否有公网扫描
  try {
    console.warn(`[AccessControl] 拒绝未授权请求 ${req.method} ${p} 来源=${req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown'}`);
  } catch (e) {}

  if (p.startsWith('/api/')) {
    return res.status(401).json({
      error: '需要访问口令：请在浏览器打开协调服务提供的访问链接（含 ?k=口令），或联系管理员获取口令。',
      code: 'UNAUTHORIZED'
    });
  }
  return res.status(401).type('html').send(
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>需要访问口令</title></head>' +
    '<body style="font-family:sans-serif;padding:40px;max-width:640px;margin:0 auto;">' +
    '<h2>需要访问口令</h2>' +
    '<p>本系统需要通过带口令的链接访问，例如：<br><code>https://你的地址/frontend/index.html?k=你的口令</code></p>' +
    '<p>首次用带口令的链接打开后，浏览器会记住口令，之后可正常使用。</p>' +
    '</body></html>'
  );
}

module.exports = {
  getAccessToken,
  reloadAccessToken,
  accessTokenMiddleware,
  isTokenValid,
  isStaticOrLoginPath,
  isWorkerPath,
  isWorkerOnlyPath,
  WORKER_ONLY_PATHS,
  internalPort,
  shouldBlockWorkerPathOnPublicPort,
  isDirectLocalRequest,
  usesTunnelHeader,
  isTestEnvironment
};