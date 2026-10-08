/**
 * 执行端本地配置与身份（多执行端局域网接入整改 2026-10-07 / 183部署要求 §3.1）
 *
 * 角色定位（183 部署文档 §3.2）：执行端是**纯客户端**，只主动连接协调服务，
 * **不监听任何端口**；因此执行电脑无需开放入站端口，也不依赖协调端反向回调。
 * 协调端的执行端接入口是否对局域网开放，由协调端自己的监听配置决定。
 *
 * 配置存储（本机文件优先，保证「配置工具写入位置 = 执行端读取位置」）：
 *  - worker_config.local.json 本机文件（**禁止分发/禁止复制到其他电脑**）：
 *    连接地址、workerId、接入密钥；一次配置后重启自动沿用。
 *  - worker_config.json       共享配置（可随程序分发）：打印机白名单等。
 *  - 命令行参数/环境变量作为一次性覆盖。
 *
 * 优先级：命令行参数 > 本机文件 > 共享配置 > 环境变量 > 默认值
 * 特别地：只设置 WORKER_PORT/INTERNAL_PORT 不得覆盖已经指定的远程主机。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT_DIR = path.resolve(__dirname, '../..');
// 配置目录可注入（PHONEAPP_CONFIG_DIR），便于测试隔离；生产默认使用程序根目录。
const CONFIG_DIR = process.env.PHONEAPP_CONFIG_DIR
  ? path.resolve(process.env.PHONEAPP_CONFIG_DIR)
  : ROOT_DIR;
const SHARED_CONFIG_PATH = path.join(CONFIG_DIR, 'worker_config.json');
const LOCAL_CONFIG_PATH = path.join(CONFIG_DIR, 'worker_config.local.json');

const DEFAULT_PUBLIC_PORT = 3000;
const DEFAULT_WORKER_PORT = 3001;

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return {};
  }
}

function writeJsonFile(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  try { fs.chmodSync(filePath, 0o600); } catch (e) {}
}

/** 生成稳定的默认终端 ID：计算机名 + 短随机，避免多机默认同名互相覆盖 */
function defaultWorkerId() {
  const host = String(os.hostname() || 'pc').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  return `worker-${host || 'pc'}-${crypto.randomBytes(2).toString('hex')}`;
}

function generateSecret() {
  return crypto.randomBytes(24).toString('hex');
}

/** 解析命令行参数（与 worker.js 共用同一份解析，避免两处漂移） */
function parseCliArgs(argv) {
  const args = argv || [];
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const next = () => args[i + 1];
    if (args[i] === '--id' && next()) { options.workerId = next(); i++; }
    else if (args[i] === '--name' && next()) { options.name = next(); i++; }
    else if (args[i] === '--server' && next()) { options.serverUrl = next(); i++; }
    else if (args[i] === '--port' && next()) { options.serverPort = next(); i++; }
    else if (args[i] === '--dir' && next()) { options.workingDir = next(); i++; }
    else if (args[i] === '--secret' && next()) { options.workerSecret = next(); i++; }
  }
  return options;
}

/** 把用户输入整理成 http(s)://host:port 形式（兼容只给 IP、只给 host、带协议等写法） */
function normalizeServerUrl(raw, fallbackPort) {
  if (!raw) return '';
  let value = String(raw).trim();
  if (!value) return '';
  let hasScheme = /^https?:\/\//i.test(value);
  if (!hasScheme) value = 'http://' + value;
  try {
    const u = new URL(value);
    if (!u.port) {
      u.port = String(fallbackPort || defaultWorkerBasePort());
    }
    return `${u.protocol}//${u.hostname}:${u.port}`;
  } catch (e) {
    return '';
  }
}

function defaultWorkerBasePort() {
  const p = Number(process.env.WORKER_PORT || process.env.INTERNAL_PORT || 0);
  return Number.isFinite(p) && p > 0 ? p : DEFAULT_WORKER_PORT;
}

/**
 * 装载执行端最终配置。
 * @param {string[]} [argv] 命令行参数（默认取 process.argv.slice(2)）
 * @returns {object} 同时包含来源标记，便于启动日志核对
 */
function loadWorkerConfig(argv) {
  const cli = parseCliArgs(argv !== undefined ? argv : process.argv.slice(2));
  const shared = readJsonFile(SHARED_CONFIG_PATH);
  const local = readJsonFile(LOCAL_CONFIG_PATH);
  const envServer = process.env.PHONEAPP_SERVER || process.env.COORDINATOR_SERVER || '';
  const envPortRaw = process.env.WORKER_PORT || process.env.INTERNAL_PORT || '';
  const envPort = Number(envPortRaw) > 0 ? Number(envPortRaw) : 0;

  // ---- 连接地址（按优先级；本机文件优先，保证配置工具写入处即读取处 §3.1）----
  // 刻意不从共享配置读取 serverUrl：共享配置会随安装包分发到多台电脑，
  // 一旦里面写了地址，所有机器都会被指向同一台机器（REV183 §3.1）。
  let serverRaw = '';
  let serverSource = '';
  if (cli.serverUrl) { serverRaw = cli.serverUrl; serverSource = '命令行 --server'; }
  else if (local.serverUrl) { serverRaw = local.serverUrl; serverSource = 'worker_config.local.json（本机已保存）'; }
  else if (envServer) { serverRaw = envServer; serverSource = '环境变量 PHONEAPP_SERVER'; }
  else if (cli.serverPort) { serverRaw = `http://127.0.0.1:${cli.serverPort}`; serverSource = '命令行 --port（本机回环）'; }
  else if (envPort) { serverRaw = `http://127.0.0.1:${envPort}`; serverSource = '环境变量 WORKER_PORT（本机回环）'; }
  else { serverRaw = `http://127.0.0.1:${DEFAULT_WORKER_PORT}`; serverSource = '默认值（本机回环，仅适用协调机本机执行端）'; }

  // 只给了 host 或 http://host 时，用执行端基端口补全
  const serverUrl = normalizeServerUrl(serverRaw, envPort || DEFAULT_WORKER_PORT);

  const explicitRemote = !!(cli.serverUrl || local.serverUrl || envServer);
  const savedOnThisMachine = !!local.serverUrl;

  // 共享配置若仍残留 serverUrl，明确警告而不是静默生效（避免分发后多机连错）
  if (shared.serverUrl && !local.serverUrl && !cli.serverUrl && !envServer) {
    console.warn(`[配置] 共享配置 ${SHARED_CONFIG_PATH} 里存在 serverUrl，但该文件会随安装包分发到多台电脑，`
      + '已忽略；请改用 配置执行端接入.bat 在本机保存连接地址（REV183 §3.1）。');
  }

  // ---- 身份（本机持久化）----
  let workerId = cli.workerId || local.workerId || shared.workerId || '';
  const workerIdSource = cli.workerId ? '命令行 --id'
    : local.workerId ? 'worker_config.local.json（本机持久化）'
      : shared.workerId ? 'worker_config.json' : '首次生成';
  let identityGenerated = false;
  if (!workerId) {
    workerId = defaultWorkerId();
    identityGenerated = true;
  }

  let workerSecret = cli.workerSecret || local.workerSecret || shared.workerSecret || process.env.PHONEAPP_WORKER_SECRET || '';
  let secretSource = cli.workerSecret ? '命令行 --secret'
    : local.workerSecret ? 'worker_config.local.json（本机持久化）'
      : shared.workerSecret ? 'worker_config.json'
        : process.env.PHONEAPP_WORKER_SECRET ? '环境变量 PHONEAPP_WORKER_SECRET' : '首次生成';
  if (!workerSecret) {
    workerSecret = generateSecret();
    secretSource = '首次生成';
  }

  // 把连接地址与身份一起写回本机文件（不写入共享配置，避免随安装包分发导致多机同地址/同身份）
  const needPersist = !local.workerId || !local.workerSecret
    || (cli.workerId && local.workerId !== cli.workerId)
    || (cli.workerSecret && local.workerSecret !== cli.workerSecret)
    || (cli.serverUrl && local.serverUrl !== serverUrl);
  if (needPersist) {
    try {
      writeJsonFile(LOCAL_CONFIG_PATH, {
        ...local,
        workerId,
        workerSecret,
        // 持久化最终生效的连接地址：下次启动自动沿用，不要求每次输入 (REV183-02)
        serverUrl,
        updatedAt: new Date().toISOString(),
        note: '本文件是本机执行端的连接地址与身份凭据，请勿复制到其他电脑或随安装包分发（多执行端整改 §4）'
      });
    } catch (e) {
      console.warn(`[配置] 无法写入本机配置文件 ${LOCAL_CONFIG_PATH}: ${e.message}（本次运行使用内存中的配置）`);
    }
  }

  // ---- 其他 ----
  const workingDir = cli.workingDir || local.workingDir || shared.workingDir
    || path.join(ROOT_DIR, 'data', `working_dir_${workerId}`);
  const name = cli.name || local.name || shared.name || '';
  const allowedPrinters = Array.isArray(shared.allowedPrinters) ? shared.allowedPrinters : [];

  return {
    workerId,
    workerSecret,
    serverUrl,
    name,
    workingDir,
    allowedPrinters,
    envPort,
    sources: {
      server: serverSource,
      workerId: workerIdSource,
      workerSecret: secretSource
    },
    explicitRemote,
    savedOnThisMachine,
    identityGenerated,
    configPaths: { shared: SHARED_CONFIG_PATH, local: LOCAL_CONFIG_PATH }
  };
}

/**
 * 人类可读的连接问题分类（§5：区分连接拒绝/超时/DNS/鉴权/服务端错误/格式错误）
 *
 * 注意：Node 的 fetch 失败时只抛 `TypeError: fetch failed`，真实原因在 err.cause 链上
 * （可能有 network-error → ECONNREFUSED / ETIMEDOUT / ENOTFOUND 等多层嵌套），
 * 因此必须遍历整条 cause 链提取错误码，否则所有失败都会退化成“未知原因”。
 */
function collectErrorChain(err) {
  const chain = [];
  let cur = err;
  let depth = 0;
  while (cur && depth < 8) {
    chain.push({
      message: String(cur.message || ''),
      code: String(cur.code || (cur.cause && cur.cause.code) || '')
    });
    cur = cur.cause;
    depth++;
  }
  return chain;
}

function classifyConnectionError(err) {
  const chain = collectErrorChain(err);
  const codes = chain.map(c => c.code).filter(Boolean);
  const messages = chain.map(c => c.message).join(' | ');
  const has = (code) => codes.includes(code) || new RegExp(code).test(messages);

  if (has('ECONNREFUSED')) {
    return { kind: 'refused', text: '目标主机拒绝连接（协调服务未启动、端口不对，或防火墙拦截）' };
  }
  if (has('ETIMEDOUT') || has('UND_ERR_CONNECT_TIMEOUT') || /timed? ?out|timeout/i.test(messages)) {
    return { kind: 'timeout', text: '连接超时（地址不可达或被防火墙丢弃）' };
  }
  if (has('ENOTFOUND') || has('EAI_AGAIN') || /getaddrinfo|ENOTFOUND|EAI_AGAIN/i.test(messages)) {
    return { kind: 'dns', text: '地址解析失败（主机名/IP 写错，或 DNS 不可用）' };
  }
  if (has('EHOSTUNREACH') || has('ENETUNREACH') || has('ENETDOWN')) {
    return { kind: 'unreachable', text: '网络不可达（不在同一局域网/网段，或路由缺失）' };
  }
  if (has('ECONNRESET') || /socket hang up|ECONNRESET|UND_ERR_SOCKET/i.test(messages)) {
    return { kind: 'reset', text: '连接被重置（对方中断或中间设备拦截）' };
  }
  if (has('CERT') || /certificate|self signed|SSL|TLS/i.test(messages)) {
    return { kind: 'tls', text: 'TLS/证书校验失败（地址协议或证书不被信任）' };
  }
  if (/abort/i.test(messages)) {
    return { kind: 'timeout', text: '请求超时（超过等待时间）' };
  }
  const detail = chain.map(c => c.message).filter(Boolean).slice(0, 2).join(' → ');
  return { kind: 'unknown', text: `连接失败：${detail || '未知原因'}` };
}

/**
 * 连接不通时的排查提示（183 部署文档 §3.2/§3.3）。
 * 执行端是纯客户端：它**不监听任何端口**，所以本机不需要放行入站；
 * 需要放行的是**协调端**的执行端接入口。
 */
function firewallHint(coordinatorHost, port) {
  const p = port || DEFAULT_WORKER_PORT;
  const target = coordinatorHost || '协调电脑';
  return `执行端不需要开放任何入站端口（它只主动连接协调端）。请在【协调电脑 ${target}】上确认：`
    + `(1) 协调服务以 INTERNAL_BIND=0.0.0.0 启动，执行端接入口监听 ${p} 而非仅 127.0.0.1；`
    + `(2) 仅在需要时放行可信局域网访问 TCP ${p}（例如：`
    + `New-NetFirewallRule -DisplayName "phoneApp Worker" -Direction Inbound -Protocol TCP -LocalPort ${p} -Action Allow -Profile Private -RemoteAddress LocalSubnet`
    + `），不要关闭整机防火墙，也不要把该端口发布到公网隧道。`;
}

module.exports = {
  loadWorkerConfig,
  parseCliArgs,
  normalizeServerUrl,
  classifyConnectionError,
  firewallHint,
  defaultWorkerId,
  generateSecret,
  SHARED_CONFIG_PATH,
  LOCAL_CONFIG_PATH,
  DEFAULT_PUBLIC_PORT,
  DEFAULT_WORKER_PORT
};
