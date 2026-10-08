/**
 * 手机免 Office 预览与打印队列整改回归测试（2026-10-07）
 *
 * 覆盖 TEST.md 第 7 节 PV01–PV10、PR01–PR15 中可自动化的部分，
 * 以及整改文档《手机免Office预览与打印队列整改_20261007.md》的 PV-B01~B03、PR-B01~B06。
 *
 * 全部使用隔离数据库/端口/预览目录；不发送真实打印、不接触实体打印机。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const zlib = require('zlib');

const testDbPath = path.resolve(__dirname, '../data/phoneapp_test_print_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + '.db');
process.env.DB_PATH = testDbPath;
process.env.PREVIEW_DIR = path.join(path.dirname(testDbPath), 'previews_print_isolated');
process.env.RETURNED_DIR = path.join(path.dirname(testDbPath), 'returned_print_isolated');

const app = require('../src/backend/server');
const db = require('../src/backend/db');
const accessControl = require('../src/backend/access_control');
const { isValidPdf } = require('../src/backend/preview');
const { getConversionCapabilities, renderPdfToPageImages } = require('../src/backend/doc_render');
const { getFileSha256 } = require('../src/common/utils');

let server;
let internalServer;
const PORT = 3082;
const INTERNAL = 3083;
process.env.INTERNAL_PORT = String(INTERNAL);

/** 执行端接口只允许内部端口访问，因此测试同时监听对外端口与内部端口（与真实部署一致） */
const workerBase = () => `http://localhost:${INTERNAL}`;

function loadFrontend(file, extraGlobals = {}) {
  const code = fs.readFileSync(path.join(__dirname, '../src/frontend', file), 'utf-8');
  const store = { ...(extraGlobals.localStorageStore || {}) };
  if (extraGlobals.accessToken) store.phoneapp_access_token = extraGlobals.accessToken;
  // Node 的 vm 沙箱没有 URLSearchParams，而 app.js 顶部取访问口令时会用到它；
  // 缺少时会被内部 catch 吞掉，导致令牌永远为空（这是测试环境差异，不是产品缺陷）。
  class SandboxURLSearchParams {
    constructor(search) {
      this.map = {};
      String(search || '').replace(/^\?/, '').split('&').filter(Boolean).forEach(pair => {
        const [k, v] = pair.split('=');
        this.map[decodeURIComponent(k)] = decodeURIComponent(v === undefined ? '' : v);
      });
    }
    get(k) { return Object.prototype.hasOwnProperty.call(this.map, k) ? this.map[k] : null; }
  }
  const sandbox = {
    window: { location: { origin: `http://localhost:${PORT}`, search: '' }, addEventListener: () => {} },
    document: {
      getElementById: () => ({ style: {}, innerHTML: '', innerText: '', value: '', checked: false, set innerHTML(v) {} }),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      cookie: ''
    },
    localStorage: {
      getItem: (k) => (store[k] === undefined ? null : store[k]),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    URLSearchParams: SandboxURLSearchParams,
    URL: globalThis.URL,
    Headers: globalThis.Headers,
    FormData: globalThis.FormData,
    console,
    alert: () => {},
    setTimeout,
    clearInterval,
    ...extraGlobals
  };
  delete sandbox.localStorageStore;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox;
}

/** 造一条“已生成回传”的任务与文件记录 */
function seedTask({ taskId, workerId, fileType, content, sn = 'TESTSN001' }) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO tasks (id, req_id, client_id, client_name, worker_id, model, device_sn, status, accepted_at, form_data)
    VALUES (?, ?, 'client-test', '测试员', ?, 'POA200', ?, 'IN_PROGRESS', ?, '{}')
    ON CONFLICT(id) DO NOTHING
  `).run(taskId, 'req_' + taskId, workerId, sn, now);

  const dir = path.join(path.dirname(testDbPath), `worker_dir_${workerId}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `task${taskId}_${fileType}.doc`);
  fs.writeFileSync(file, content || `content-of-task-${taskId}-${fileType}`);

  db.prepare(`
    INSERT INTO task_files (task_id, file_type, official_filename, worker_filepath, server_filepath, sha256, preview_images, status)
    VALUES (?, ?, ?, ?, ?, ?, '[]', 'PREVIEW_READY')
  `).run(taskId, fileType, `文件${taskId}-${fileType}.doc`, file, file, getFileSha256(file));

  return db.prepare('SELECT * FROM task_files WHERE task_id = ? AND file_type = ?').get(taskId, fileType);
}

test.before(async () => {
  await new Promise(resolve => { server = app.listen(PORT, () => resolve()); });
  await new Promise(resolve => { internalServer = app.listen(INTERNAL, () => resolve()); });
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (internalServer) await new Promise(resolve => internalServer.close(resolve));
});

// ==================== PR-B01：接口边界 ====================

test('PR-B01/PR02: 手机打印提交不被误判为执行端接口，执行端接口仍限内部端口', () => {
  const blockOnPublic = (p, m) => accessControl.shouldBlockWorkerPathOnPublicPort({ path: p, method: m, socket: { localPort: PORT } });

  // 手机业务接口：允许对外端口
  assert.equal(blockOnPublic('/api/print/submit', 'POST'), false, '手机打印提交必须能从对外端口访问 (PR-B01)');
  assert.equal(blockOnPublic('/api/print/12', 'GET'), false, '手机查询打印状态必须能从对外端口访问');
  assert.equal(blockOnPublic('/api/tasks/submit', 'POST'), false);

  // 执行端接口：必须限制在内部端口
  assert.equal(blockOnPublic('/api/print/pending', 'GET'), true, '执行端领取打印任务必须限内部端口');
  assert.equal(blockOnPublic('/api/print/12/status', 'POST'), true, '执行端回报打印状态必须限内部端口');
  assert.equal(blockOnPublic('/api/workers/heartbeat', 'POST'), true);
  assert.equal(blockOnPublic('/api/worker/tasks/pending', 'GET'), true);

  // 内部端口访问不拦截
  const internal = (p, m) => accessControl.shouldBlockWorkerPathOnPublicPort({ path: p, method: m, socket: { localPort: INTERNAL } });
  assert.equal(internal('/api/print/pending', 'GET'), false);
  assert.equal(internal('/api/print/12/status', 'POST'), false);
});

// ==================== PR-B03/PR05/PR-B04：打印受理必须关联真实文件 ====================

test('PR-B03/PR05: 打印受理必须携带真实 taskId/fileId，拒绝猜测文件名', async () => {
  seedTask({ taskId: 900, workerId: 'w-print', fileType: 'cert' });

  // 缺 taskId
  let res = await fetch(`http://localhost:${PORT}/api/print/submit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'c1', workerId: 'w-print', printerName: 'P1', batchItems: [{ fileType: 'cert', copies: 1 }] })
  });
  assert.equal(res.status, 400);
  assert.ok((await res.json()).error.includes('taskId'), '必须说明缺少 taskId');

  // 不存在的 fileId
  res = await fetch(`http://localhost:${PORT}/api/print/submit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'c1', workerId: 'w-print', printerName: 'P1', taskId: 900, batchItems: [{ fileId: 999999, fileType: 'cert', copies: 1 }] })
  });
  assert.equal(res.status, 404);
  assert.ok((await res.json()).error.includes('fileId'), '必须指出 fileId 不存在');

  // 非法份数
  res = await fetch(`http://localhost:${PORT}/api/print/submit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'c1', workerId: 'w-print', printerName: 'P1', taskId: 900, batchItems: [{ fileType: 'cert', copies: 0 }] })
  });
  assert.equal(res.status, 400);
  assert.ok((await res.json()).error.includes('份数'));

  // 缺打印机
  res = await fetch(`http://localhost:${PORT}/api/print/submit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'c1', workerId: 'w-print', taskId: 900, batchItems: [{ fileType: 'cert', copies: 1 }] })
  });
  assert.equal(res.status, 400);
  assert.ok((await res.json()).error.includes('打印机'));

  // 任务确实还没有产生任何打印记录
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM print_jobs').get().n, 0, '非法请求不得产生打印任务');
});

test('PR-B03/PR-B04: 合法提交解析真实文件与内容版本，形成不可串用的快照', async () => {
  const file = seedTask({ taskId: 901, workerId: 'w-print', fileType: 'cert' });

  const res = await fetch(`http://localhost:${PORT}/api/print/submit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requestId: 'req-print-901',
      clientId: 'c1', workerId: 'w-print', printerName: '测试打印机', taskId: 901,
      batchItems: [{ fileId: file.id, fileType: 'cert', copies: 2 }]
    })
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.ok(Number.isInteger(data.printJobId), '必须返回有效的 printJobId (PR-B02)');
  assert.equal(data.status, 'QUEUED');

  const items = db.prepare('SELECT * FROM print_job_items WHERE print_job_id = ?').all(data.printJobId);
  assert.equal(items.length, 1);
  assert.equal(items[0].task_file_id, file.id, '必须关联真实 task_file 主键');
  assert.equal(items[0].sha256, file.sha256, '必须记录受理时的内容哈希');
  assert.equal(items[0].snapshot_path, file.worker_filepath, '执行端保存路径来自服务记录，不来自手机');
  assert.equal(items[0].copies, 2);
  assert.equal(items[0].status, 'QUEUED');

  // 幂等：同 requestId 重复提交返回同一任务，不重复出纸 (PR10)
  const again = await fetch(`http://localhost:${PORT}/api/print/submit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requestId: 'req-print-901', clientId: 'c1', workerId: 'w-print', printerName: '测试打印机', taskId: 901,
      batchItems: [{ fileId: file.id, fileType: 'cert', copies: 2 }]
    })
  });
  const againData = await again.json();
  assert.equal(againData.printJobId, data.printJobId, '重复请求必须复用同一打印任务');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM print_jobs WHERE request_id = 'req-print-901'").get().n, 1);
});

test('PR-B06/PR11: 执行端只领取本终端任务，无 worker-local 兜底，且原子领取不重复', async () => {
  const fileA = seedTask({ taskId: 910, workerId: 'w-A', fileType: 'cert' });
  const fileB = seedTask({ taskId: 911, workerId: 'w-B', fileType: 'cert' });

  const submit = (taskId, fileId, workerId, reqId) => fetch(`http://localhost:${PORT}/api/print/submit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: reqId, clientId: 'c1', workerId, printerName: 'P1', taskId, batchItems: [{ fileId, fileType: 'cert', copies: 1 }] })
  });

  const jobA = await (await submit(910, fileA.id, 'w-A', 'req-910')).json();
  await submit(911, fileB.id, 'w-B', 'req-911');

  // w-A 只能领到自己的任务
  const pendingA = await (await fetch(`${workerBase()}/api/print/pending?workerId=w-A`)).json();
  assert.equal(pendingA.length, 1);
  assert.equal(pendingA[0].id, jobA.printJobId);
  assert.equal(pendingA[0].status, 'CLAIMED', '领取后必须立即标记 CLAIMED');
  assert.ok(pendingA[0].items.length === 1 && pendingA[0].items[0].sha256, '领取内容必须带真实文件快照');

  // w-B 的任务不能被 w-A（或 worker-local）兜底领走
  const pendingLocal = await (await fetch(`${workerBase()}/api/print/pending?workerId=worker-local`)).json();
  assert.equal(pendingLocal.length, 0, '不得用 worker-local 兜底领取其他终端任务 (PR-B06)');

  // 重复轮询不得再次领到同一任务（原子领取）
  const pendingA2 = await (await fetch(`${workerBase()}/api/print/pending?workerId=w-A`)).json();
  assert.equal(pendingA2.length, 0, '同一任务不得被重复领取 (PR11)');

  // 缺 workerId 必须拒绝
  const noWorker = await fetch(`${workerBase()}/api/print/pending`);
  assert.equal(noWorker.status, 400);
});

test('PR13+PR-B05: 证书/清单状态独立，单项失败不影响已成功项，异常状态不被吞掉', async () => {
  const certFile = seedTask({ taskId: 920, workerId: 'w-C', fileType: 'cert' });
  const packFile = seedTask({ taskId: 920, workerId: 'w-C', fileType: 'packing' });

  const submit = await (await fetch(`http://localhost:${PORT}/api/print/submit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requestId: 'req-920', clientId: 'c1', workerId: 'w-C', printerName: 'P1', taskId: 920,
      batchItems: [{ fileId: certFile.id, fileType: 'cert', copies: 1 }, { fileId: packFile.id, fileType: 'packing', copies: 1 }]
    })
  })).json();

  const itemStatus = (fileId, status, extra = {}) => fetch(`${workerBase()}/api/print/${submit.printJobId}/status`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, fileId, ...extra })
  });

  // 执行端真实序列：先领取（CLAIMED），再逐项推进到 DISPATCHING
  assert.equal((await itemStatus(certFile.id, 'CLAIMED')).status, 200);
  assert.equal((await itemStatus(packFile.id, 'CLAIMED')).status, 200);
  const dispRes = await itemStatus(certFile.id, 'DISPATCHING');
  assert.equal(dispRes.status, 200, 'DISPATCHING 回报必须被受理');
  const dispBody = await dispRes.clone().json();
  assert.equal(dispBody.itemStatus, 'DISPATCHING');
  let mid = await (await fetch(`http://localhost:${PORT}/api/print/${submit.printJobId}`)).json();
  assert.equal(mid.job.status, 'DISPATCHING', `正在调用打印时必须如实报告为处理中（POST 返回 ${dispBody.status}）`);

  // 证书成功进入队列（带作业号），此时清单尚未定案 → 不得宣称整体成功，也不得让进度回退
  const spoolRes = await itemStatus(certFile.id, 'SUBMITTED_TO_SPOOLER', { windowsJobId: '77', printerName: 'P1' });
  assert.equal(spoolRes.status, 200, '进入队列的回报必须被受理');
  const spoolBody = await spoolRes.clone().json();
  assert.equal(spoolBody.itemStatus, 'SUBMITTED_TO_SPOOLER');
  mid = await (await fetch(`http://localhost:${PORT}/api/print/${submit.printJobId}`)).json();
  const rawItems = db.prepare('SELECT id, task_file_id, file_type, status FROM print_job_items WHERE print_job_id = ?').all(submit.printJobId);
  assert.equal(mid.job.status, 'SUBMITTED_TO_SPOOLER',
    `仍有文件未定案时不得判定整体成功，但进度也不得回退（POST 返回 ${spoolBody.status}；items=${JSON.stringify(rawItems)}）`);
  assert.notEqual(mid.job.status, 'PARTIAL_SUBMITTED', '还有文件在处理中时不得提前给出最终组合结论');
  const certItemMid = mid.job.items.find(i => i.fileType === 'cert');
  const packItemMid = mid.job.items.find(i => i.fileType === 'packing');
  assert.equal(certItemMid.status, 'SUBMITTED_TO_SPOOLER');
  assert.equal(packItemMid.status, 'CLAIMED', '尚未处理的文件必须如实显示为已领取/待打印');
  assert.equal(mid.job.status === 'SUBMITTED_TO_SPOOLER', true, '部分文件已进入队列时整体应如实反映该阶段，且不得回退');

  await itemStatus(packFile.id, 'FAILED', { errorMsg: '文件被占用，无法打印' });
  const done = await (await fetch(`http://localhost:${PORT}/api/print/${submit.printJobId}`)).json();
  assert.equal(done.job.status, 'PARTIAL_SUBMITTED', '一份成功一份失败必须如实记录为该组合状态');

  const certItem = done.job.items.find(i => i.fileType === 'cert');
  const packItem = done.job.items.find(i => i.fileType === 'packing');
  assert.equal(certItem.status, 'SUBMITTED_TO_SPOOLER');
  assert.equal(certItem.windowsJobId, '77', '必须记录 Windows 队列作业号');
  assert.equal(packItem.status, 'FAILED');
  assert.ok(packItem.errorMsg.includes('被占用'), '失败原因不得被吞掉 (PR-B05)');

  // 不明状态被拒绝写入
  const bad = await fetch(`${workerBase()}/api/print/${submit.printJobId}/status`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'PRINTED_BY_MAGIC', fileId: certFile.id })
  });
  assert.equal(bad.status, 400, '未定义状态必须被拒绝');
});

test('PR07/PR10: 结果不确定记 RESULT_UNKNOWN 且不自动重印；状态查询对手机可见', async () => {
  const file = seedTask({ taskId: 930, workerId: 'w-D', fileType: 'cert' });
  const submit = await (await fetch(`http://localhost:${PORT}/api/print/submit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: 'req-930', clientId: 'c1', workerId: 'w-D', printerName: 'P1', taskId: 930, batchItems: [{ fileId: file.id, fileType: 'cert', copies: 1 }] })
  })).json();

  await fetch(`${workerBase()}/api/print/${submit.printJobId}/status`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'RESULT_UNKNOWN', fileId: file.id, errorMsg: '打印命令超时，未能确认是否已进入队列' })
  });

  const view = await (await fetch(`http://localhost:${PORT}/api/print/${submit.printJobId}`)).json();
  assert.equal(view.job.status, 'RESULT_UNKNOWN');
  assert.ok(view.job.items[0].errorMsg.includes('未能确认'));
  assert.ok(view.job.stageNotice.includes('不等于'), '状态说明必须区分受理/入队/出纸');

  // 不确定状态下不得被再次领取造成重复出纸
  const pending = await (await fetch(`${workerBase()}/api/print/pending?workerId=w-D`)).json();
  assert.equal(pending.length, 0, 'RESULT_UNKNOWN 不得被重新领取，从而避免自动重印');
});

// ==================== PR-B02：前端不得伪造成功 ====================

test('PR-B02/PR03: 手机端解析响应，异常/缺编号时不得弹出成功提示', async () => {
  const alerts = [];
  const responses = [];
  const sandbox = loadFrontend('app.js', {
    alert: (m) => alerts.push(String(m)),
    fetch: async () => responses.shift(),
    escapeHtml: (s) => String(s === undefined || s === null ? '' : s)
  });

  const mkRes = (status, body, contentType = 'application/json') => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => contentType },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  });

  const setupState = () => {
    sandbox.task = {
      id: 555,
      files: [{ id: 11, file_type: 'cert', official_filename: 'a.doc' }, { id: 12, file_type: 'packing', official_filename: 'b.doc' }]
    };
    vm.runInContext(`
      state.currentTask = task;
      state.clientId = 'c1';
      state.selectedWorker = { id: 'w-1', name: 'W1' };
      state.lastPrintJobId = undefined;
    `, sandbox);
  };

  const mockDom = (certChecked, packChecked, copies, printer) => {
    sandbox.document.getElementById = (id) => {
      if (id === 'print-check-cert') return { checked: certChecked };
      if (id === 'print-check-pack') return { checked: packChecked };
      if (id === 'print-copies') return { value: String(copies) };
      if (id === 'printer-select') return { value: printer };
      return { style: {}, innerHTML: '', innerText: '', value: '', checked: false, set innerHTML(v) {} };
    };
  };

  // ① 400 + 错误 JSON：必须提示失败，且不得出现 undefined 编号
  setupState(); mockDom(true, false, 1, 'P1');
  responses.push(mkRes(400, { error: '缺少 taskId：打印必须关联已生成的真实任务文件' }));
  await vm.runInContext('submitPrintJob()', sandbox);
  assert.equal(alerts.length, 1);
  assert.ok(alerts[0].includes('打印提交失败'), `400 必须提示失败，实际: ${alerts[0]}`);
  assert.ok(alerts[0].includes('taskId'));
  assert.equal(/undefined/.test(alerts[0]), false, '错误提示中不得出现 undefined');

  // ② 200 但 success=false
  alerts.length = 0; setupState(); mockDom(true, false, 1, 'P1');
  responses.push(mkRes(200, { success: false, error: '打印机不在白名单' }));
  await vm.runInContext('submitPrintJob()', sandbox);
  assert.ok(alerts[0].includes('打印提交失败') && alerts[0].includes('白名单'));

  // ③ 200 但缺 printJobId → 不得报成功
  alerts.length = 0; setupState(); mockDom(true, false, 1, 'P1');
  responses.push(mkRes(200, { success: true, status: 'QUEUED' }));
  await vm.runInContext('submitPrintJob()', sandbox);
  assert.ok(alerts[0].includes('打印提交失败'), '缺 printJobId 必须视为失败，杜绝 Print Job #undefined');
  assert.equal(vm.runInContext('state.lastPrintJobId', sandbox), undefined);

  // ④ 非 JSON 响应
  alerts.length = 0; setupState(); mockDom(true, false, 1, 'P1');
  responses.push(mkRes(500, '<html>Internal Error</html>', 'text/html'));
  await vm.runInContext('submitPrintJob()', sandbox);
  assert.ok(alerts[0].includes('不是 JSON'));

  // ⑤ 非法份数 / 未选打印机 / 未选文件：本地即拦截
  alerts.length = 0; setupState(); mockDom(true, false, 0, 'P1');
  await vm.runInContext('submitPrintJob()', sandbox);
  assert.ok(alerts[0].includes('份数'));

  alerts.length = 0; setupState(); mockDom(true, false, 1, '');
  await vm.runInContext('submitPrintJob()', sandbox);
  assert.ok(alerts[0].includes('打印机'));

  alerts.length = 0; setupState(); mockDom(false, false, 1, 'P1');
  await vm.runInContext('submitPrintJob()', sandbox);
  assert.ok(alerts[0].includes('至少勾选'));

  // ⑥ 正常受理：提示中必须带真实编号，并说明受理≠出纸
  alerts.length = 0; setupState(); mockDom(true, false, 2, 'P1');
  responses.push(mkRes(200, { success: true, printJobId: 4242, status: 'QUEUED' }));
  await vm.runInContext('submitPrintJob()', sandbox);
  assert.ok(alerts[0].includes('#4242'), `必须显示真实编号，实际: ${alerts[0]}`);
  assert.ok(alerts[0].includes('不等于'), '必须说明受理不等于进入队列/出纸');
  assert.equal(vm.runInContext('state.lastPrintJobId', sandbox), 4242);

  // ⑦ 提交体必须带 taskId 与 fileId（不能只报 fileType）
  const body = JSON.parse(sandbox.__lastPrintBody || '{}');
  assert.ok(body === null || true); // 见下一个用例的显式断言
});

test('PR-B03: 手机提交体包含 taskId 与真实 fileId，并带 requestId 以供幂等', async () => {
  let captured = null;
  const sandbox = loadFrontend('app.js', {
    alert: () => {},
    fetch: async (url, options) => {
      captured = { url, body: JSON.parse(options.body) };
      return {
        ok: true, status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ success: true, printJobId: 1, status: 'QUEUED' })
      };
    },
    escapeHtml: (s) => String(s === undefined || s === null ? '' : s)
  });

  sandbox.task = { id: 777, files: [{ id: 21, file_type: 'cert', official_filename: 'a.doc' }, { id: 22, file_type: 'packing', official_filename: 'b.doc' }] };
  vm.runInContext("state.currentTask = task; state.clientId = 'c1'; state.selectedWorker = { id: 'w-9', name: 'W9' };", sandbox);
  sandbox.document.getElementById = (id) => {
    if (id === 'print-check-cert') return { checked: true };
    if (id === 'print-check-pack') return { checked: true };
    if (id === 'print-copies') return { value: '3' };
    if (id === 'printer-select') return { value: '共享打印机A' };
    return { style: {}, innerHTML: '', innerText: '', value: '', checked: false, set innerHTML(v) {} };
  };

  await vm.runInContext('submitPrintJob()', sandbox);

  assert.ok(captured, '必须发起打印提交请求');
  assert.ok(captured.url.includes('/api/print/submit'));
  assert.equal(captured.body.taskId, 777, '必须携带 taskId');
  assert.equal(captured.body.workerId, 'w-9');
  assert.equal(captured.body.printerName, '共享打印机A');
  assert.ok(captured.body.requestId, '必须携带 requestId 以支持幂等');
  assert.deepEqual(
    captured.body.batchItems.map(b => ({ fileId: b.fileId, fileType: b.fileType, copies: b.copies })),
    [{ fileId: 21, fileType: 'cert', copies: 3 }, { fileId: 22, fileType: 'packing', copies: 3 }],
    '必须按真实 fileId 提交证书与清单，而不是只给 fileType'
  );
});

// ==================== PV-B03 / 3.1：预览元数据与分页图片 ====================

test('PV-B03/PV01: 预览改为分页图片，不再把 PDF 地址交给 iframe；图片 URL 带访问口令', async () => {
  let rendered = '';
  const sandbox = loadFrontend('app.js', {
    accessToken: 'PREVIEWTOKEN',
    alert: () => {},
    fetch: async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({}) }),
    escapeHtml: (s) => String(s === undefined || s === null ? '' : s)
  });
  // 必须返回“同一个”容器对象，否则内部写入与断言读取不是同一实例
  const container = { style: {}, innerHTML: '' };
  const btnBox = { style: {}, innerHTML: '' };
  sandbox.document.getElementById = (id) => {
    if (id === 'preview-container') return container;
    if (id === 'preview-download-btn-box') return btnBox;
    return { style: {}, innerHTML: '', innerText: '', value: '', checked: false };
  };

  sandbox.task = {
    id: 888,
    files: [{
      id: 31, file_type: 'cert', official_filename: '证书.doc', status: 'PREVIEW_READY',
      preview_images: ['/previews/task_888_cert_pages/page_001.png?v=1', '/previews/task_888_cert_pages/page_002.png?v=2']
    }]
  };
  vm.runInContext("state.currentTask = task; state.activePreviewType = 'cert'; renderPreviewBox();", sandbox);
  rendered = container.innerHTML;

  assert.ok(rendered.length > 0, '预览必须被渲染');
  assert.equal(rendered.includes('<iframe'), false, '不得再用 iframe 内嵌 PDF (PV-B03/PV02)');
  assert.ok(rendered.includes('/previews/task_888_cert_pages/page_001.png'), '必须渲染页图 1');
  assert.ok(rendered.includes('/previews/task_888_cert_pages/page_002.png'), '必须渲染页图 2');
  assert.ok(rendered.includes('第 1 / 2 页') && rendered.includes('第 2 / 2 页'), '必须显示页码');
  assert.ok(rendered.includes('下载 Word 原件'), '必须保留 Word 下载入口');
  assert.ok(rendered.includes('查看/下载 PDF'), '必须保留 PDF 下载入口（独立入口，不当图片用）');
  assert.ok(rendered.includes('k=PREVIEWTOKEN'), '页图 URL 必须带访问口令 (PV10)');
});

test('PV10: 预览资源 URL 必须带访问口令（img 不走 fetch 拦截器）', () => {
  const sandbox = loadFrontend('app.js', {
    accessToken: 'TESTTOKEN123',
    alert: () => {},
    fetch: async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({}) }),
    escapeHtml: (s) => String(s || '')
  });
  const token = vm.runInContext('PHONE_ACCESS_TOKEN', sandbox);
  assert.equal(token, 'TESTTOKEN123', '测试夹具应能注入访问口令');
  const withToken = vm.runInContext("withAccessToken('/previews/task_1_cert_pages/page_001.png?v=5')", sandbox);
  assert.ok(withToken.includes('k=TESTTOKEN123'), `预览图片 URL 必须带口令，实际: ${withToken}`);
  const already = vm.runInContext("withAccessToken('/previews/a.png?k=X')", sandbox);
  assert.equal(already, '/previews/a.png?k=X', '已带口令时不得重复追加');
});

test('PV06/3.2: 0 字节或非 PDF 内容不被当作有效 PDF', () => {
  const dir = path.join(path.dirname(testDbPath), 'pdf-check');
  fs.mkdirSync(dir, { recursive: true });
  const empty = path.join(dir, 'empty.pdf');
  const garbage = path.join(dir, 'garbage.pdf');
  const good = path.join(dir, 'good.pdf');
  fs.writeFileSync(empty, '');
  fs.writeFileSync(garbage, 'this is not a pdf at all');
  fs.writeFileSync(good, '%PDF-1.4\n% fake but header-valid\n');

  assert.equal(isValidPdf(empty), false, '0 字节 PDF 不算有效 (PV06)');
  assert.equal(isValidPdf(garbage), false, '非 PDF 内容不算有效');
  assert.equal(isValidPdf(good), true, '带 %PDF- 头的文件应通过基础校验');
  assert.equal(isValidPdf(path.join(dir, 'not-exist.pdf')), false);
});

test('3.2: 转换能力自检如实报告组件（不把“检测到”当成“可用”）', () => {
  const caps = getConversionCapabilities();
  assert.ok(Array.isArray(caps.wordToPdf.engines));
  assert.ok(Array.isArray(caps.pdfToImage.engines));
  assert.ok(typeof caps.wordToPdf.detail === 'string');
  if (process.platform === 'win32') {
    assert.ok(caps.pdfToImage.engines.some(e => e.id === 'windows-data-pdf'),
      'Windows 上应检测到 Windows.Data.Pdf 页图渲染组件');
  }
});

test('PV07: PDF 逐页渲染真实产出页图（页数与文件数一致、非空）', async (t) => {
  const samplePdf = path.join(__dirname, '../data/test_poa3500_remediation/previews/task_poa3500_e2e_cert.pdf');
  if (!fs.existsSync(samplePdf)) {
    t.skip('缺少可用样张 PDF，跳过页图渲染');
    return;
  }
  const outDir = path.join(path.dirname(testDbPath), 'pages-render');
  let result;
  try {
    result = renderPdfToPageImages(samplePdf, outDir, { scale: 1 });
  } catch (e) {
    assert.fail(`页图渲染必须可用（本机已验证 Windows.Data.Pdf 可用）: ${e.message}`);
  }
  assert.equal(result.pages, result.files.length, '页图数量必须与页数一致');
  assert.ok(result.pages >= 1);
  for (const f of result.files) {
    assert.ok(fs.existsSync(f) && fs.statSync(f).size > 0, `页图必须非空: ${f}`);
    const head = Buffer.alloc(8);
    const fd = fs.openSync(f, 'r');
    fs.readSync(fd, head, 0, 8, 0);
    fs.closeSync(fd);
    assert.equal(head.toString('hex').startsWith('89504e47'), true, '页图必须是真实 PNG');
  }
  // 空 PDF 必须明确失败，而不是产出“成功但空白”的预览
  const emptyPdf = path.join(outDir, 'empty.pdf');
  fs.writeFileSync(emptyPdf, '');
  assert.throws(() => renderPdfToPageImages(emptyPdf, path.join(outDir, 'empty-pages')), /PDF 为空文件/);
});
