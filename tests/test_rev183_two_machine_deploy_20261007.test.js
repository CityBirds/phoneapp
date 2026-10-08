/**
 * 183 协调服务 + 本机执行端 两机部署回归测试（2026-10-07）
 *
 * 依据《协调183与本机执行端部署要求_20261007.md》REV183-01~14 与 TEST.md 第 8 节。
 * 覆盖可自动化部分；真实两机、真实打印机与出纸项按文档要求在报告中标注 BLOCKED/NOT RUN。
 *
 * 角色约束（文档 §3.2）：执行端是纯客户端，不监听任何端口，
 * 全部通信由执行端主动发起，不依赖协调端反向访问执行电脑。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const testDbPath = path.resolve(__dirname, '../data/phoneapp_test_rev183_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + '.db');
process.env.DB_PATH = testDbPath;
process.env.PREVIEW_DIR = path.join(path.dirname(testDbPath), 'previews_rev183');
process.env.RETURNED_DIR = path.join(path.dirname(testDbPath), 'returned_rev183');
process.env.INTERNAL_PORT = '3091';

// 执行端本机配置隔离：测试不得读写程序根目录的真实配置文件
const configDir = path.resolve(__dirname, '../data/test_rev183_config_' + Date.now());
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(path.join(configDir, 'worker_config.json'), JSON.stringify({
  _comment: '测试隔离共享配置', autoDetectPrinters: true, allowedPrinters: []
}, null, 2));
process.env.PHONEAPP_CONFIG_DIR = configDir;

const app = require('../src/backend/server');
const db = require('../src/backend/db');
const {
  loadWorkerConfig, classifyConnectionError, firewallHint, LOCAL_CONFIG_PATH
} = require('../src/worker/worker_config');
const { authenticateWorker } = require('../src/backend/server');
const { getFileSha256 } = require('../src/common/utils');

const PORT = 3090;
const INTERNAL = 3091;
const workerBase = () => `http://localhost:${INTERNAL}`;

let server;
let internalServer;

test.before(async () => {
  await new Promise(resolve => { server = app.listen(PORT, () => resolve()); });
  await new Promise(resolve => { internalServer = app.listen(INTERNAL, () => resolve()); });
});
test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (internalServer) await new Promise(resolve => internalServer.close(resolve));
});

/** 在沙箱中加载执行端模块，返回沙箱内的 ExecutionWorker 构造器 */
function loadWorkerClass() {
  const workerCode = fs.readFileSync(path.resolve(__dirname, '../src/worker/worker.js'), 'utf-8');
  const sandbox = {
    require: (m) => require(m.startsWith('.') ? path.resolve(__dirname, '../src/worker', m) : m),
    process: { ...process, argv: ['node', 'worker.js'] },
    console,
    setTimeout,
    clearInterval,
    setInterval: () => 0,
    fetch,
    Buffer,           // 执行端下载副本时会用到 Buffer.from
    URL,
    AbortController,
    __dirname: path.resolve(__dirname, '../src/worker'),
    module: { exports: {} },
    exports: {}
  };
  sandbox.module.exports = sandbox.exports;
  vm.createContext(sandbox);
  vm.runInContext(workerCode, sandbox);
  const Klass = sandbox.module.exports.ExecutionWorker;
  assert.equal(typeof Klass, 'function', '执行端模块必须导出 ExecutionWorker 构造器');
  return Klass;
}

function resetLocalConfig() {
  try { if (fs.existsSync(LOCAL_CONFIG_PATH)) fs.unlinkSync(LOCAL_CONFIG_PATH); } catch (e) {}
}

/** 登记一个终端身份（首次心跳） */
async function registerWorker(workerId, secret, name) {
  const res = await fetch(`${workerBase()}/api/workers/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-worker-id': workerId, 'x-worker-token': secret },
    body: JSON.stringify({ workerId, name: name || workerId, status: 'ONLINE' })
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/**
 * 造一个"本机执行端"任务。
 * @param {boolean} localExists 本机原件是否存在（REV183-10 需要本机缺失）
 */
function seedTask({ taskId, workerId, fileType = 'cert', localExists = true, content = 'rev183-content' }) {
  const now = new Date().toISOString();
  const localDir = path.join(path.dirname(testDbPath), `local_dir_${workerId}`);
  fs.mkdirSync(localDir, { recursive: true });
  const localPath = path.join(localDir, `task${taskId}_${fileType}.doc`);
  if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
  if (localExists) fs.writeFileSync(localPath, content, 'utf-8');

  const serverDir = path.join(path.dirname(testDbPath), 'server_copies');
  fs.mkdirSync(serverDir, { recursive: true });
  const serverCopy = path.join(serverDir, `task${taskId}_${fileType}.doc`);
  fs.writeFileSync(serverCopy, content, 'utf-8');
  const serverHash = getFileSha256(serverCopy);

  db.prepare(`
    INSERT INTO tasks (id, req_id, client_id, client_name, worker_id, model, device_sn, status, accepted_at, form_data)
    VALUES (?, ?, 'client-1', '测试员', ?, 'POA200', 'REV183SN', 'QUEUED', ?, '{}')
    ON CONFLICT(id) DO NOTHING
  `).run(taskId, 'req-rev183-' + taskId, workerId, now);

  // 先删后插：task_files 表没有 (task_id, file_type) 唯一约束，不能用 upsert；
  // 同时保证记录里的路径与哈希同本次写入的内容一致（测试重复运行不残留旧值）
  db.prepare('DELETE FROM task_files WHERE task_id = ? AND file_type = ?').run(taskId, fileType);
  db.prepare(`
    INSERT INTO task_files (task_id, file_type, official_filename, worker_filepath, server_filepath, sha256, preview_images, status)
    VALUES (?, ?, ?, ?, ?, ?, '[]', 'PREVIEW_READY')
  `).run(taskId, fileType, `REV183-${fileType}.doc`, localPath, serverCopy, serverHash);

  return {
    localPath,
    serverCopy,
    record: db.prepare('SELECT * FROM task_files WHERE task_id = ? AND file_type = ?').get(taskId, fileType)
  };
}

// ==================== REV183-01 / 02：执行端主动接入与配置持久化 ====================

test('REV183-02: 地址一次保存后重启自动沿用，不连接 localhost，身份不漂移', () => {
  resetLocalConfig();

  const first = loadWorkerConfig(['--server', 'http://192.168.1.183:3001']);
  assert.equal(first.serverUrl, 'http://192.168.1.183:3001', '首次必须采用指定的协调端地址');
  assert.equal(first.savedOnThisMachine, false, '首次带入时本机尚未保存');

  const saved = JSON.parse(fs.readFileSync(LOCAL_CONFIG_PATH, 'utf-8'));
  assert.equal(saved.serverUrl, 'http://192.168.1.183:3001', '连接地址必须写入本机文件（工具写入处=读取处）');
  assert.ok(saved.workerId && saved.workerSecret, '身份与凭据必须与本机地址同处保存');

  // 重启（不带任何参数）
  const restarted = loadWorkerConfig([]);
  assert.equal(restarted.serverUrl, 'http://192.168.1.183:3001', '重启必须自动沿用已保存地址，不要求再次输入');
  assert.ok(restarted.sources.server.includes('本机已保存'), `来源应标明本机文件，实际: ${restarted.sources.server}`);
  assert.equal(restarted.savedOnThisMachine, true);
  assert.equal(/127\.0\.0\.1|localhost/.test(restarted.serverUrl), false, '重启后不得退回 localhost');
  assert.equal(restarted.workerId, first.workerId, '重启不得改变终端身份');
  assert.equal(restarted.workerSecret, first.workerSecret, '重启不得改变接入凭据');

  // 只设置 WORKER_PORT 不得覆盖已保存的远程主机
  process.env.WORKER_PORT = '3001';
  const withPortEnv = loadWorkerConfig([]);
  assert.equal(withPortEnv.serverUrl, 'http://192.168.1.183:3001', 'WORKER_PORT 不得覆盖已保存的远程主机');
  delete process.env.WORKER_PORT;
});

test('REV183-02: 配置工具写入位置与执行端读取位置一致，且说明执行端不监听端口', () => {
  resetLocalConfig();
  const { execFileSync } = require('child_process');
  const out = execFileSync(process.execPath, [
    path.resolve(__dirname, '../tools/worker_connect.js'),
    '--server', 'http://192.168.1.183:3001', '--yes'
  ], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf-8',
    timeout: 30000,
    env: { ...process.env, PHONEAPP_CONFIG_DIR: configDir }
  });

  assert.ok(out.includes(LOCAL_CONFIG_PATH), '工具必须显示本机配置文件路径，便于核对');
  assert.ok(/不需要开放入站端口|不监听/.test(out), '工具必须说明执行端不监听端口');
  assert.equal(loadWorkerConfig([]).serverUrl, 'http://192.168.1.183:3001', '工具写入的地址必须被执行端读到');
});

test('REV183-01: 执行端不监听任何端口，全部接口由执行端主动调用', () => {
  const workerCode = fs.readFileSync(path.resolve(__dirname, '../src/worker/worker.js'), 'utf-8');
  assert.equal(/\.listen\s*\(/.test(workerCode), false, '执行端不得监听端口（不依赖协调端反向访问 §3.2）');
  assert.equal(/createServer\s*\(/.test(workerCode), false, '执行端不得创建入站服务');
  for (const endpoint of ['/api/workers/heartbeat', '/api/worker/tasks/pending', '/api/templates', '/api/print/pending']) {
    assert.ok(workerCode.includes(endpoint), `执行端必须主动调用 ${endpoint}`);
  }
  assert.ok(/监听端口: 无/.test(workerCode), '启动日志必须明确打印“监听端口: 无”，避免被误解为未生效');
  assert.ok(workerCode.includes("inboundServices: 'none'"), '心跳应声明本机不提供入站服务');
});

test('REV183-04: 连接失败原因可区分（拒绝/超时/DNS/不可达），不退化为未知', () => {
  const mk = (code, msg) => {
    const e = new TypeError('fetch failed');
    e.cause = Object.assign(new Error(msg), { code });
    return e;
  };
  assert.equal(classifyConnectionError(mk('ECONNREFUSED', 'connect ECONNREFUSED 192.168.1.183:3001')).kind, 'refused');
  assert.equal(classifyConnectionError(mk('ETIMEDOUT', 'connect ETIMEDOUT')).kind, 'timeout');
  assert.equal(classifyConnectionError(mk('ENOTFOUND', 'getaddrinfo ENOTFOUND')).kind, 'dns');
  assert.equal(classifyConnectionError(mk('EHOSTUNREACH', 'connect EHOSTUNREACH')).kind, 'unreachable');
  assert.equal(classifyConnectionError(mk('ECONNRESET', 'socket hang up')).kind, 'reset');

  // 深层 cause 链同样要识别（Node fetch 的真实错误形态）
  const deep = new TypeError('fetch failed');
  deep.cause = Object.assign(new Error('network error'), {
    cause: Object.assign(new Error('connect ECONNREFUSED 192.168.1.183:3001'), { code: 'ECONNREFUSED' })
  });
  assert.equal(classifyConnectionError(deep).kind, 'refused', '必须遍历 cause 链，不能只看第一层');

  // 排查提示必须指向协调端放行，而不是让执行端开端口
  const hint = firewallHint('192.168.1.183', 3001);
  assert.ok(/协调电脑 192\.168\.1\.183/.test(hint), '提示必须指明协调电脑');
  assert.ok(/不需要开放任何入站端口/.test(hint), '必须说明执行端无需开端口');
  assert.ok(/INTERNAL_BIND=0\.0\.0\.0/.test(hint), '必须给出协调端监听配置要求');
});

// ==================== REV183-11：归属校验与串端拒绝 ====================

test('REV183-11: 任务归属校验——其他终端领不到本机任务，无默认 worker 兜底', async () => {
  seedTask({ taskId: 8301, workerId: 'rev183-local', fileType: 'cert' });
  assert.equal((await registerWorker('rev183-local', 'sec-local')).status, 200, '本终端心跳必须成功');
  assert.equal((await registerWorker('rev183-other', 'sec-other')).status, 200, '另一终端心跳必须成功');

  // 目标终端能领到自己的任务
  const mineRes = await fetch(`${workerBase()}/api/worker/tasks/pending?workerId=rev183-local`, {
    headers: { 'x-worker-id': 'rev183-local', 'x-worker-token': 'sec-local' }
  });
  const mineText = await mineRes.text();
  assert.equal(mineRes.status, 200, `领取接口必须 200，实际 ${mineRes.status}：${mineText.slice(0, 200)}`);
  const mineList = JSON.parse(mineText);
  assert.ok(Array.isArray(mineList), `领取接口应返回数组，实际：${mineText.slice(0, 120)}`);
  assert.ok(mineList.length >= 1 && mineList[0].id === 8301,
    `目标执行端必须领到自己的任务，实际响应：${mineText.slice(0, 200)}`);
  assert.equal(mineList[0].worker_id, 'rev183-local');

  // 其他终端（含旧默认 ID）不得抢单
  seedTask({ taskId: 8302, workerId: 'rev183-local', fileType: 'packing' });
  for (const other of ['rev183-other', 'worker-local', 'worker-e2e']) {
    const res = await fetch(`${workerBase()}/api/worker/tasks/pending?workerId=${other}`, {
      headers: { 'x-worker-id': other === 'worker-local' ? 'rev183-other' : other, 'x-worker-token': 'sec-other' }
    });
    const text = await res.text();
    assert.equal(res.status, 200, `${other} 领取必须 200，实际 ${res.status}：${text.slice(0, 200)}`);
    const list = JSON.parse(text);
    const ids = (Array.isArray(list) ? list : [list]).map(t => t && t.id);
    assert.equal(ids.includes(8302), false, `${other} 不得领取派给 rev183-local 的任务（禁止默认 worker 兜底抢单）`);
  }

  const noId = await fetch(`${workerBase()}/api/worker/tasks/pending`);
  assert.equal(noId.status, 400, '缺少 workerId 必须拒绝');
});

test('REV183-11: 打印任务归属校验——其他终端领不到、也不能回报本机任务', async () => {
  const seeded = seedTask({ taskId: 8310, workerId: 'rev183-owner', fileType: 'cert' });
  await registerWorker('rev183-owner', 'sec-owner');
  await registerWorker('rev183-thief', 'sec-thief');

  const submit = await (await fetch(`http://localhost:${PORT}/api/print/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requestId: 'rev183-print-8310', clientId: 'c1', workerId: 'rev183-owner', printerName: 'P1', taskId: 8310,
      batchItems: [{ fileId: seeded.record.id, fileType: 'cert', copies: 1 }]
    })
  })).json();
  assert.ok(submit.printJobId, '打印任务应受理成功');

  const otherClaim = await (await fetch(`${workerBase()}/api/print/pending?workerId=rev183-thief`, {
    headers: { 'x-worker-id': 'rev183-thief', 'x-worker-token': 'sec-thief' }
  })).json();
  assert.equal(Array.isArray(otherClaim) ? otherClaim.length : 0, 0, '其他终端不得领取本机打印任务');

  // 篡改回报：非目标终端更新本机打印任务必须被拒
  const hijack = await fetch(`${workerBase()}/api/print/${submit.printJobId}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-worker-id': 'rev183-thief', 'x-worker-token': 'sec-thief' },
    body: JSON.stringify({ status: 'SUBMITTED_TO_SPOOLER', fileId: seeded.record.id, windowsJobId: 'hack' })
  });
  assert.equal(hijack.status, 403, '非目标终端不得回报本机打印任务状态');
  assert.equal((await hijack.json()).code, 'PRINT_JOB_OWNERSHIP_MISMATCH');
});

// ==================== REV183-10：本机原件缺失时受控下载 ====================

test('REV183-10: 本机原件缺失时经协调端受控下载并校验哈希后才可打印', async () => {
  const seeded = seedTask({ taskId: 8320, workerId: 'rev183-dl', fileType: 'cert', localExists: false, content: 'downloaded-content' });
  assert.equal(fs.existsSync(seeded.localPath), false, '前置条件：本机原件应缺失');
  await registerWorker('rev183-dl', 'sec-dl');

  const ExecutionWorkerClass = loadWorkerClass();
  const workDir = path.join(path.dirname(testDbPath), 'worker_dl_dir');
  fs.mkdirSync(workDir, { recursive: true });
  const worker = new ExecutionWorkerClass({
    workerId: 'rev183-dl',
    workerSecret: 'sec-dl',
    serverUrl: `http://localhost:${INTERNAL}`,
    workingDir: workDir
  });
  // 捕获执行端内部的失败原因，便于断言失败时定位（不改变被测逻辑）
  const dlErrors = [];
  const origError = console.error;
  console.error = (...args) => { dlErrors.push(args.map(String).join(' ')); origError.apply(console, args); };
  // 本机授权：允许写入工作目录（模拟管理员为该终端配置授权路径）
  worker.fetchAuthorizations = async () => ({
    ok: true, authState: 'EXPLICIT', allowedPaths: [{ root_path: workDir, allow_write: 1 }]
  });

  const item = {
    id: null,
    taskId: 8320,
    taskFileId: seeded.record.id,
    fileType: 'cert',
    officialFilename: seeded.record.official_filename,
    sha256: seeded.record.sha256,
    copies: 1,
    snapshotPath: seeded.localPath
  };

  const downloaded = await worker.resolvePrintItemPath(item);
  console.error = origError;
  if (!downloaded) {
    // 失败时给出可定位的诊断，而不是只报"必须能下载"
    const targetDir = path.join(workDir, 'returned_copies');
    const files = fs.existsSync(targetDir) ? fs.readdirSync(targetDir) : [];
    const probe = await fetch(`${workerBase()}/api/worker/tasks/8320/files/cert/download`, {
      headers: { 'x-worker-id': 'rev183-dl', 'x-worker-token': 'sec-dl' }
    });
    const probeBuf = Buffer.from(await probe.arrayBuffer());
    assert.fail([
      '本机原件缺失时必须能从协调端受控下载副本，但返回了 null。诊断：',
      `本机路径存在=${fs.existsSync(seeded.localPath)}`,
      `协调端副本存在=${fs.existsSync(seeded.serverCopy)}`,
      `下载接口 HTTP=${probe.status}`,
      `下载内容长度=${probeBuf.length}`,
      `记录哈希=${String(seeded.record.sha256).slice(0, 16)}…`,
      `item.sha256=${String(item.sha256).slice(0, 16)}…`,
      `下载目录文件=${JSON.stringify(files)}`,
      `工作目录=${workDir}`,
      `执行端日志=${JSON.stringify(dlErrors.slice(-3))}`
    ].join('；'));
  }
  assert.ok(downloaded.startsWith(workDir), `下载必须落在本机目录而非协调端路径，实际: ${downloaded}`);
  assert.equal(fs.existsSync(downloaded), true, '下载后文件必须真实存在');
  assert.equal(getFileSha256(downloaded), seeded.record.sha256, '下载副本哈希必须与协调端记录一致');
  assert.equal(fs.readFileSync(downloaded, 'utf-8'), 'downloaded-content', '内容必须一致');
  assert.equal(fs.existsSync(`${downloaded}.downloading`), false, '不得残留半截临时文件');

  // 哈希不符必须拒绝，且不落正式文件
  const targetDir = path.join(workDir, 'returned_copies');
  const countReal = () => (fs.existsSync(targetDir) ? fs.readdirSync(targetDir).filter(f => !f.endsWith('.downloading')).length : 0);
  const before = countReal();
  const badResult = await worker.resolvePrintItemPath({
    ...item, sha256: 'deadbeef'.repeat(8), snapshotPath: '/nonexistent/missing.doc'
  });
  assert.equal(badResult, null, '哈希不一致时必须拒绝，不得返回可打印路径');
  assert.equal(countReal(), before, '哈希校验失败不得留下正式文件');
});

test('REV183-10/14: 两端都没有原件时明确失败，不伪造成功', async () => {
  const seeded = seedTask({ taskId: 8330, workerId: 'rev183-miss', fileType: 'cert', localExists: false });
  fs.unlinkSync(seeded.serverCopy); // 协调端副本也删除
  await registerWorker('rev183-miss', 'sec-miss');

  const ExecutionWorkerClass = loadWorkerClass();
  const workDir = path.join(path.dirname(testDbPath), 'worker_miss_dir');
  fs.mkdirSync(workDir, { recursive: true });
  const worker = new ExecutionWorkerClass({
    workerId: 'rev183-miss', workerSecret: 'sec-miss',
    serverUrl: `http://localhost:${INTERNAL}`, workingDir: workDir
  });
  worker.fetchAuthorizations = async () => ({
    ok: true, authState: 'EXPLICIT', allowedPaths: [{ root_path: workDir, allow_write: 1 }]
  });

  const result = await worker.resolvePrintItemPath({
    id: null, taskId: 8330, taskFileId: seeded.record.id, fileType: 'cert',
    officialFilename: seeded.record.official_filename, sha256: seeded.record.sha256, copies: 1,
    snapshotPath: seeded.localPath
  });
  assert.equal(result, null, '两端都没有原件时必须明确失败，返回 null 而不是伪造路径');
});

test('REV183-10: 下载接口做任务归属校验，其他终端不能下载本机任务副本', async () => {
  const seeded = seedTask({ taskId: 8340, workerId: 'rev183-owner2', fileType: 'cert' });
  await registerWorker('rev183-owner2', 'sec-o2');
  await registerWorker('rev183-thief2', 'sec-thief2');

  const okRes = await fetch(`${workerBase()}/api/worker/tasks/8340/files/cert/download`, {
    headers: { 'x-worker-id': 'rev183-owner2', 'x-worker-token': 'sec-o2' }
  });
  assert.equal(okRes.status, 200, '目标终端必须能下载自己任务的副本');
  assert.equal(okRes.headers.get('x-file-sha256'), seeded.record.sha256, '下载响应必须带哈希供校验');
  const buf = Buffer.from(await okRes.arrayBuffer());
  assert.equal(buf.length > 0, true, '下载内容不能为空');

  const denied = await fetch(`${workerBase()}/api/worker/tasks/8340/files/cert/download`, {
    headers: { 'x-worker-id': 'rev183-thief2', 'x-worker-token': 'sec-thief2' }
  });
  assert.equal(denied.status, 403, '其他终端不得下载本机任务副本');
  assert.equal((await denied.json()).code, 'TASK_OWNERSHIP_MISMATCH');
});

// ==================== REV183-14：错误场景不假在线、不假成功 ====================

test('REV183-14: 未启动/凭据错误/非法参数分别给出明确错误，不回退本地执行', async () => {
  // ① 协调端未启动 → 归类明确（真实连接被拒）
  const offline = classifyConnectionError(Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('connect ECONNREFUSED 192.168.1.183:3001'), { code: 'ECONNREFUSED' })
  }));
  assert.equal(offline.kind, 'refused');
  assert.ok(/协调服务未启动|端口|防火墙/.test(offline.text));

  // ② 凭据错误 → 拒绝
  //    说明：真实 HTTP 心跳在回环连接下按设计豁免凭据（协调机本机执行端免配置），
  //    因此这里直接驱动生产鉴权函数，验证远程电脑接入时的真实验证路径。
  const { registerWorkerSecret } = require('../src/backend/server');
  registerWorkerSecret('rev183-badsec', 'right-secret', 'badsec');
  const wrongAuth = authenticateWorker({}, 'rev183-badsec', 'wrong-secret');
  assert.equal(wrongAuth.ok, false, '凭据错误必须拒绝');
  assert.equal(wrongAuth.status, 401);
  assert.equal(wrongAuth.code, 'WORKER_TOKEN_MISMATCH');
  const missingAuth = authenticateWorker({}, 'rev183-badsec', '');
  assert.equal(missingAuth.ok, false);
  assert.equal(missingAuth.status, 401);
  assert.equal(missingAuth.code, 'WORKER_TOKEN_REQUIRED');

  // ③ 伪造身份：用别人的 workerId 配自己的凭据
  const impersonate = authenticateWorker({}, 'rev183-badsec', 'another-secret');
  assert.equal(impersonate.ok, false, '冒用他人身份必须拒绝');

  // ④ 非法份数 → 400，且不产生打印任务
  const before = db.prepare('SELECT COUNT(*) AS n FROM print_jobs').get().n;
  const badCopies = await fetch(`http://localhost:${PORT}/api/print/submit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: 'c1', workerId: 'rev183-badsec', printerName: 'P1', taskId: 8340,
      batchItems: [{ fileType: 'cert', copies: 999 }]
    })
  });
  assert.equal(badCopies.status, 400, '非法份数必须拒绝');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM print_jobs').get().n, before, '非法请求不得产生打印任务');

  // ⑤ 不存在的任务 → 明确 404/400，不得回退到协调端本地生成
  const badTask = await fetch(`http://localhost:${PORT}/api/print/submit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: 'c1', workerId: 'rev183-badsec', printerName: 'P1', taskId: 999999,
      batchItems: [{ fileType: 'cert', copies: 1 }]
    })
  });
  assert.equal([400, 404].includes(badTask.status), true, `不存在的任务必须拒绝，实际 ${badTask.status}`);
});

// ==================== REV183-05 / 06：探测与模板由目标终端完成 ====================

test('REV183-05: 路径探测命令下发到目标终端，携带路径与配置版本', async () => {
  await registerWorker('rev183-probe', 'sec-probe');
  const endpointOnlyDir = path.join(path.dirname(testDbPath), 'endpoint_only_dir');
  fs.mkdirSync(endpointOnlyDir, { recursive: true });

  db.prepare(`
    INSERT INTO worker_directory_checks (check_type, target_id, worker_id, version, root_dir, allow_create, allow_read, allow_write, status, created_at)
    VALUES ('save_config', 9901, 'rev183-probe', 3, ?, 1, 1, 1, 'PENDING', ?)
  `).run(endpointOnlyDir, new Date().toISOString());

  const pending = await (await fetch(`${workerBase()}/api/worker/directory-checks/pending?workerId=rev183-probe`, {
    headers: { 'x-worker-id': 'rev183-probe', 'x-worker-token': 'sec-probe' }
  })).json();
  assert.ok(Array.isArray(pending) && pending.length >= 1, '目标终端必须能领到探测任务');
  assert.equal(pending[0].root_dir, endpointOnlyDir, '探测命令必须携带该终端的真实路径');
  assert.equal(pending[0].version, 3, '探测必须携带配置版本，便于拒绝迟到旧结果');
});

test('REV183-06: 模板字节与映射经接口传到执行端，缓存到本机而非使用协调端路径', () => {
  const workerCode = fs.readFileSync(path.resolve(__dirname, '../src/worker/worker.js'), 'utf-8');
  const start = workerCode.indexOf('async fetchTemplateForTask');
  const end = workerCode.indexOf('async processTask');
  assert.ok(start > 0 && end > start, '应能定位模板获取逻辑');
  const fetchFn = workerCode.slice(start, end);
  assert.ok(fetchFn.includes('/api/templates'), '必须通过接口获取模板列表');
  assert.ok(fetchFn.includes('/download'), '必须通过下载接口取模板字节');
  assert.ok(fetchFn.includes('cached_templates'), '下载的模板必须缓存到本机目录');
  assert.ok(fetchFn.includes('workerAuthHeaders'), '模板下载必须携带本机身份凭据');
});

test('REV183-01: 业务代码不写死本次部署 IP', () => {
  // 剥离块注释与行注释（含行首注释行），只检查真实代码
  const stripComments = (code) => code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map(line => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
  const workerCode = stripComments(fs.readFileSync(path.resolve(__dirname, '../src/worker/worker.js'), 'utf-8'));
  // 允许出现 <协调电脑IP> 这类占位符，但不得出现本次部署的具体地址
  assert.equal(/192\.168\.1\.183/.test(workerCode), false, '执行端代码（含日志提示）不得写死本次部署的 183');
  assert.equal(/192\.168\.\d+\.\d+/.test(workerCode), false, '执行端代码不得写死任何具体局域网 IP');
  const configCode = stripComments(fs.readFileSync(path.resolve(__dirname, '../src/worker/worker_config.js'), 'utf-8'));
  assert.equal(/192\.168\.\d+\.\d+/.test(configCode), false, '配置模块不得把具体 IP 写成业务规则');
  const connectCode = stripComments(fs.readFileSync(path.resolve(__dirname, '../tools/worker_connect.js'), 'utf-8'));
  assert.equal(/192\.168\.1\.183/.test(connectCode), false, '接入工具不得写死 183（示例只能出现在注释中）');
});
