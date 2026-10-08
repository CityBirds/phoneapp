const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const testDbPath = path.resolve(__dirname, `../data/phoneapp_dir_test_${Date.now()}.db`);
process.env.DB_PATH = testDbPath;
// 测试隔离：预览与回传产物不得写入生产 data/previews、data/returned
process.env.PREVIEW_DIR = path.join(path.dirname(testDbPath), 'previews_test_isolated');
process.env.RETURNED_DIR = path.join(path.dirname(testDbPath), 'returned_test_isolated');

const app = require('../src/backend/server');
const db = require('../src/backend/db');
const ExecutionWorker = require('../src/worker/worker');
const { getFileSha256 } = require('../src/common/utils');

let server;
const PORT = 3030;
const serverUrl = `http://localhost:${PORT}`;

const testBaseDir = path.resolve(__dirname, `../data/test_dir_mgr_${Date.now()}`);

test.before(async () => {
  if (!fs.existsSync(testBaseDir)) fs.mkdirSync(testBaseDir, { recursive: true });
  await new Promise(resolve => {
    server = app.listen(PORT, () => resolve());
  });
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  try { if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath); } catch (e) {}
  try { if (fs.existsSync(testBaseDir)) fs.rmSync(testBaseDir, { recursive: true, force: true }); } catch (e) {}
});

test('DIR-01, DIR-08, DIR-09, DIR-10, DIR-14: 目录集中配置、离线标记、创建控制、版本失效与执行端探测', async () => {
  const workerDir = path.join(testBaseDir, 'worker_dir_01');
  fs.mkdirSync(workerDir, { recursive: true });

  const worker = new ExecutionWorker({
    workerId: 'worker-dir-01',
    name: '测试执行机-01',
    serverUrl,
    workingDir: workerDir
  });

  // 1. Worker online heartbeat
  await worker.sendHeartbeat();

  const tmpl = db.prepare("SELECT * FROM templates WHERE model = 'POA200' AND type = 'cert'").get();
  assert.ok(tmpl, 'POA200 cert template must exist');

  // 整改 4.2：未确认授权范围的终端不再默认放开，需先由管理员配置“允许访问的业务路径”
  const bootstrapAuthRes = await fetch(`${serverUrl}/api/admin/workers/worker-dir-01/allowed-paths`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': 'phoneapp-admin-secret' },
    body: JSON.stringify({ rootPath: testBaseDir, allowRead: true, allowWrite: true, allowCreate: true })
  });
  assert.equal(bootstrapAuthRes.status, 200, 'Authorized business path must be configurable (4.2)');

  // DIR-09: 根目录不存在，选择不允许创建 -> 检查失败，目录不被创建
  const nonExistentDir = path.join(testBaseDir, 'non_existent_folder_09');
  assert.equal(fs.existsSync(nonExistentDir), false);

  const cfgRes1 = await fetch(`${serverUrl}/api/admin/worker-directories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': 'phoneapp-admin-secret' },
    body: JSON.stringify({
      workerId: 'worker-dir-01',
      templateId: tmpl.id,
      docType: 'cert',
      rootDir: nonExistentDir,
      saveMode: 'direct',
      allowCreate: false
    })
  });
  assert.equal(cfgRes1.status, 200);
  const cfgData1 = await cfgRes1.json();
  const configId = cfgData1.config.id;
  assert.equal(cfgData1.config.check_status, 'PENDING');
  assert.equal(cfgData1.config.version, 1);

  // Trigger check -> worker executes check
  await fetch(`${serverUrl}/api/admin/worker-directories/${configId}/check`, {
    method: 'POST',
    headers: { 'x-admin-token': 'phoneapp-admin-secret' }
  });

  // Worker polls checks
  await worker.pollAndExecuteDirectoryChecks();

  const checkedCfg1 = db.prepare('SELECT * FROM worker_save_configs WHERE id = ?').get(configId);
  assert.equal(checkedCfg1.check_status, 'FAILED');
  assert.ok(checkedCfg1.check_message.includes('未勾选允许创建'), 'Check message should mention allow_create is false (DIR-09)');
  assert.equal(fs.existsSync(nonExistentDir), false, 'Directory must not be created (DIR-09)');

  // DIR-10: 根目录不存在，选择允许创建 -> 在目标执行端创建并检查成功
  const cfgRes2 = await fetch(`${serverUrl}/api/admin/worker-directories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': 'phoneapp-admin-secret' },
    body: JSON.stringify({
      id: configId,
      workerId: 'worker-dir-01',
      templateId: tmpl.id,
      docType: 'cert',
      rootDir: nonExistentDir,
      saveMode: 'direct',
      allowCreate: true
    })
  });
  const cfgData2 = await cfgRes2.json();
  assert.equal(cfgData2.config.version, 2, 'Version should increment on update (DIR-14)');
  assert.equal(cfgData2.config.check_status, 'PENDING', 'Status should reset to PENDING on update (DIR-14)');

  // Trigger check and worker processes it
  await fetch(`${serverUrl}/api/admin/worker-directories/${configId}/check`, {
    method: 'POST',
    headers: { 'x-admin-token': 'phoneapp-admin-secret' }
  });
  await worker.pollAndExecuteDirectoryChecks();

  const checkedCfg2 = db.prepare('SELECT * FROM worker_save_configs WHERE id = ?').get(configId);
  assert.equal(checkedCfg2.check_status, 'PASSED', 'Check should pass when allowCreate=true (DIR-10)');
  assert.equal(fs.existsSync(nonExistentDir), true, 'Directory should have been created on worker (DIR-10)');

  // DIR-14: 更改已通过检查的配置 -> 重新变为待检查；旧版本结果不能覆盖新版本
  await fetch(`${serverUrl}/api/admin/worker-directories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': 'phoneapp-admin-secret' },
    body: JSON.stringify({
      id: configId,
      workerId: 'worker-dir-01',
      templateId: tmpl.id,
      docType: 'cert',
      rootDir: nonExistentDir,
      saveMode: 'subfolder',
      subfolderRule: 'deviceSn',
      allowCreate: true
    })
  });
  const v3Cfg = db.prepare('SELECT * FROM worker_save_configs WHERE id = ?').get(configId);
  assert.equal(v3Cfg.version, 3);
  assert.equal(v3Cfg.check_status, 'PENDING');

  // Simulate an expired check result from version 2 trying to report
  await fetch(`${serverUrl}/api/worker/directory-checks/result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      checkId: 9999,
      configId: configId,
      version: 2, // Expired version!
      status: 'PASSED',
      message: 'Old version check result'
    })
  });
  const afterExpiredReport = db.prepare('SELECT * FROM worker_save_configs WHERE id = ?').get(configId);
  assert.equal(afterExpiredReport.check_status, 'PENDING', 'Expired check result must not mark v3 config as PASSED (DIR-14)');

  // DIR-08: 执行端离线时保存配置 -> 可以保存但标记待检查，不能直接用于提交
  const offlineWorkerId = 'worker-offline-dir';
  const expiredHeartbeat = new Date(Date.now() - 60000).toISOString();
  db.prepare(`
    INSERT INTO workers (id, name, ip, status, working_dir, printers, last_heartbeat)
    VALUES (?, '离线机', '127.0.0.1', 'OFFLINE', 'D:\\docs', '[]', ?)
  `).run(offlineWorkerId, expiredHeartbeat);

  // 整改 4.2：离线终端同样必须先获得业务路径授权，否则不允许配置保存目录
  db.prepare(`
    INSERT INTO worker_allowed_paths (worker_id, root_path, allow_read, allow_write, allow_create, sync_status, check_status, created_at, updated_at)
    VALUES (?, ?, 1, 1, 1, 'SYNCED', 'PASSED', datetime('now'), datetime('now'))
  `).run(offlineWorkerId, testBaseDir);

  const offRes = await fetch(`${serverUrl}/api/admin/worker-directories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': 'phoneapp-admin-secret' },
    body: JSON.stringify({
      workerId: offlineWorkerId,
      templateId: tmpl.id,
      docType: 'cert',
      rootDir: path.join(testBaseDir, 'offline_dir'),
      allowCreate: true
    })
  });
  const offData = await offRes.json();
  assert.equal(offData.success, true);
  assert.equal(offData.config.check_status, 'PENDING', 'Offline worker config must be PENDING (DIR-08)');

  const checkOffRes = await fetch(`${serverUrl}/api/admin/worker-directories/${offData.config.id}/check`, {
    method: 'POST',
    headers: { 'x-admin-token': 'phoneapp-admin-secret' }
  });
  const checkOffData = await checkOffRes.json();
  assert.equal(checkOffData.offline, true, 'Check request should detect worker offline (DIR-08)');
});

test('DIR-06, DIR-07: 缺少目录配置或未通过检查时阻止提交，无自动兜底', async () => {
  const workerDir = path.join(testBaseDir, 'worker_dir_06');
  fs.mkdirSync(workerDir, { recursive: true });

  const worker = new ExecutionWorker({
    workerId: 'worker-dir-06',
    name: '测试执行机-06',
    serverUrl,
    workingDir: workerDir
  });
  await worker.sendHeartbeat();

  // Register client
  const cRes = await fetch(`${serverUrl}/api/clients/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '操作员小周' })
  });
  const { clientId } = await cRes.json();

  // DIR-06: 缺少所选模板的目录配置 -> 手机提示缺项，服务端拒绝提交
  const subRes1 = await fetch(`${serverUrl}/api/tasks/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reqId: 'req_dir06_' + Date.now(),
      clientId,
      clientName: '操作员小周',
      workerId: 'worker-dir-06',
      model: 'POA200',
      deviceSn: '00001234'
    })
  });
  assert.equal(subRes1.status, 400);
  const subData1 = await subRes1.json();
  // 整改后错误信息精确指出缺少哪份文档的保存目录配置（原断言要求包含“缺少执行端”字样）
  assert.ok(
    subData1.error.includes('保存目录配置') && (subData1.error.includes('证书') || subData1.error.includes('装箱清单')),
    'Must reject when directory config is missing (DIR-06)'
  );

  // Validate directories API also reports missing
  const valRes1 = await fetch(`${serverUrl}/api/tasks/validate-directories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workerId: 'worker-dir-06',
      model: 'POA200',
      docCombo: 'cert_and_packing'
    })
  });
  const valData1 = await valRes1.json();
  assert.equal(valData1.valid, false);
  assert.ok(valData1.errors.some(e => e.includes('缺少证书模板')), 'Must report missing cert config');

  // DIR-07: 终端只配置了证书目录、清单未配置 -> 请求“证书+清单”必须整组拒绝并明确指出清单缺少配置
  // （整改 5：手机端只显示已启用组合；此处显式请求未启用/未配置的清单组合，服务端必须拒绝，不得静默降级）
  const certTmpl = db.prepare("SELECT * FROM templates WHERE model = 'POA200' AND type = 'cert'").get();
  const certDir = path.join(testBaseDir, 'cert_dir_07');
  fs.mkdirSync(certDir, { recursive: true });

  db.prepare(`
    INSERT INTO worker_allowed_paths (worker_id, root_path, allow_read, allow_write, sync_status, check_status, created_at, updated_at)
    VALUES ('worker-dir-06', ?, 1, 1, 'SYNCED', 'PASSED', datetime('now'), datetime('now'))
  `).run(testBaseDir);

  db.prepare(`
    INSERT INTO worker_save_configs (worker_id, template_id, doc_type, root_dir, save_mode, allow_create, is_enabled, check_status, created_at, updated_at)
    VALUES ('worker-dir-06', ?, 'cert', ?, 'direct', 1, 1, 'PASSED', datetime('now'), datetime('now'))
  `).run(certTmpl.id, certDir);

  const subRes2 = await fetch(`${serverUrl}/api/tasks/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reqId: 'req_dir07_' + Date.now(),
      clientId,
      clientName: '操作员小周',
      workerId: 'worker-dir-06',
      model: 'POA200',
      docCombo: 'cert_and_packing',
      deviceSn: '00001234'
    })
  });
  assert.equal(subRes2.status, 400);
  const subData2 = await subRes2.json();
  assert.ok(subData2.error.includes('装箱清单') && subData2.error.includes('保存目录配置'), 'Must specifically reject missing packing list config (DIR-07): ' + subData2.error);

  // 未指定组合时按终端实际启用集合推导：仅证书启用则只生成证书，不再强制要求清单配置 (5, WC-12)
  const subRes3 = await fetch(`${serverUrl}/api/tasks/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reqId: 'req_dir07_cert_only_' + Date.now(),
      clientId,
      clientName: '操作员小周',
      workerId: 'worker-dir-06',
      model: 'POA200',
      deviceSn: '00001234'
    })
  });
  assert.equal(subRes3.status, 200, 'Certificate-only enabled set must submit as cert_only (5)');
  const subData3 = await subRes3.json();
  assert.equal(subData3.task.files.length, 1);
  assert.equal(subData3.task.files[0].file_type, 'cert');
});

test('DIR-02, DIR-04, DIR-05, DIR-12, DIR-24: 多执行端独立目录、证书清单同目录/分立目录、子文件夹及历史核对', async () => {
  // Setup Worker A and Worker B
  const workerADir = path.join(testBaseDir, 'workerA_work');
  const workerBDir = path.join(testBaseDir, 'workerB_work');
  fs.mkdirSync(workerADir, { recursive: true });
  fs.mkdirSync(workerBDir, { recursive: true });

  const workerA = new ExecutionWorker({ workerId: 'worker-pcA', name: '电脑A', serverUrl, workingDir: workerADir });
  const workerB = new ExecutionWorker({ workerId: 'worker-pcB', name: '电脑B', serverUrl, workingDir: workerBDir });
  await workerA.sendHeartbeat();
  await workerB.sendHeartbeat();

  const certTmpl = db.prepare("SELECT * FROM templates WHERE model = 'POA200' AND type = 'cert'").get();
  const packTmpl = db.prepare("SELECT * FROM templates WHERE model = 'POA200' AND type = 'packing'").get();

  db.prepare(`
    INSERT INTO worker_allowed_paths (worker_id, root_path, allow_read, allow_write, sync_status, check_status, created_at, updated_at)
    VALUES ('worker-pcA', ?, 1, 1, 'SYNCED', 'PASSED', datetime('now'), datetime('now')),
           ('worker-pcB', ?, 1, 1, 'SYNCED', 'PASSED', datetime('now'), datetime('now'))
  `).run(testBaseDir, testBaseDir);

  // DIR-04: Worker A 配置证书与清单在同一目录, subfolder by deviceSn (DIR-12)
  const rootDirA = path.join(testBaseDir, 'docs_WorkerA');
  fs.mkdirSync(rootDirA, { recursive: true });
  db.prepare(`
    INSERT INTO worker_save_configs (worker_id, template_id, doc_type, root_dir, save_mode, subfolder_rule, allow_create, is_enabled, check_status, created_at, updated_at)
    VALUES ('worker-pcA', ?, 'cert', ?, 'subfolder', 'deviceSn', 1, 1, 'PASSED', datetime('now'), datetime('now')),
           ('worker-pcA', ?, 'packing', ?, 'subfolder', 'deviceSn', 1, 1, 'PASSED', datetime('now'), datetime('now'))
  `).run(certTmpl.id, rootDirA, packTmpl.id, rootDirA);

  // DIR-02, DIR-05: Worker B 配置证书与清单在不同目录
  const certDirB = path.join(testBaseDir, 'docs_WorkerB_cert');
  const packDirB = path.join(testBaseDir, 'docs_WorkerB_packing');
  fs.mkdirSync(certDirB, { recursive: true });
  fs.mkdirSync(packDirB, { recursive: true });
  db.prepare(`
    INSERT INTO worker_save_configs (worker_id, template_id, doc_type, root_dir, save_mode, subfolder_rule, allow_create, is_enabled, check_status, created_at, updated_at)
    VALUES ('worker-pcB', ?, 'cert', ?, 'subfolder', 'deviceSn', 1, 1, 'PASSED', datetime('now'), datetime('now')),
           ('worker-pcB', ?, 'packing', ?, 'subfolder', 'deviceSn', 1, 1, 'PASSED', datetime('now'), datetime('now'))
  `).run(certTmpl.id, certDirB, packTmpl.id, packDirB);

  // 1. Submit task to Worker A
  const snA = 'AP10007513';
  const resA = await fetch(`${serverUrl}/api/tasks/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reqId: 'req_dir_workerA_' + Date.now(),
      clientId: 'c_client',
      clientName: '李工',
      workerId: 'worker-pcA',
      model: 'POA200',
      deviceSn: snA,
      shippingLocation: '南京',
      sensorModel: 'PSR-12-223(封装）',
      hasPump: true,
      packingItems: [
        { index: 1, name: '主设备', spec: 'POA200', count: 1, unit: '台', standard: '是', remark: 'SN: ' + snA + '带泵', isProtectedMain: true },
        { index: 2, name: '传感器', spec: 'PMT210SEN', count: 1, unit: '支', standard: '是', remark: 'SN: 201N200258', isProtectedSensor: true }
      ]
    })
  });
  assert.equal(resA.status, 200);
  const dataA = await resA.json();
  const taskIdA = dataA.task.id;

  // Let Worker A execute task
  await workerA.pollAndExecuteTasks();

  // Check Worker A files on disk: both should be in rootDirA/AP10007513/ (DIR-04, DIR-12)
  const expectedSubfolderA = path.join(rootDirA, snA);
  assert.equal(fs.existsSync(expectedSubfolderA), true, 'Subfolder for deviceSn should be created on Worker A (DIR-12)');
  const filesA = fs.readdirSync(expectedSubfolderA);
  assert.equal(filesA.length, 2, 'Both cert and packing list must be in the same subfolder on Worker A (DIR-04)');
  assert.ok(filesA.some(f => f.includes('证书') && f.includes(snA)));
  assert.ok(filesA.some(f => f.includes('清单') && f.includes(snA)));

  // 2. Submit task to Worker B with same model
  await workerB.sendHeartbeat();
  const snB = 'AP20008888';
  const resB = await fetch(`${serverUrl}/api/tasks/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reqId: 'req_dir_workerB_' + Date.now(),
      clientId: 'c_client',
      clientName: '李工',
      workerId: 'worker-pcB',
      model: 'POA200',
      deviceSn: snB,
      shippingLocation: '苏州',
      sensorModel: 'PSR-12-223(封装）',
      hasPump: false,
      packingItems: [
        { index: 1, name: '主设备', spec: 'POA200', count: 1, unit: '台', standard: '是', remark: 'SN: ' + snB, isProtectedMain: true },
        { index: 2, name: '传感器', spec: 'PMT210SEN', count: 1, unit: '支', standard: '是', remark: 'SN: 201N200258', isProtectedSensor: true }
      ]
    })
  });
  assert.equal(resB.status, 200);
  const dataB = await resB.json();
  const taskIdB = dataB.task.id;

  // Let Worker B execute task
  await workerB.pollAndExecuteTasks();

  // Check Worker B files on disk: cert in certDirB/AP20008888 and packing in packDirB/AP20008888 (DIR-02, DIR-05)
  const expectedCertB = path.join(certDirB, snB);
  const expectedPackB = path.join(packDirB, snB);
  assert.equal(fs.existsSync(expectedCertB), true, 'Cert subfolder must exist on Worker B');
  assert.equal(fs.existsSync(expectedPackB), true, 'Packing subfolder must exist on Worker B');
  assert.equal(fs.readdirSync(expectedCertB).length, 1, 'Only cert in certDirB (DIR-05)');
  assert.equal(fs.readdirSync(expectedPackB).length, 1, 'Only packing list in packDirB (DIR-05)');

  // DIR-24: 完成保存后查看历史可核对实际执行端、每份文件的实际位置和执行结果
  const histResA = await fetch(`${serverUrl}/api/tasks/${taskIdA}`);
  const histA = await histResA.json();
  assert.equal(histA.worker_id, 'worker-pcA');
  assert.equal(histA.files.length, 2);
  histA.files.forEach(f => {
    assert.equal(f.status, 'PREVIEW_READY');
    assert.ok(f.worker_filepath.startsWith(expectedSubfolderA), `Actual worker_filepath must be in ${expectedSubfolderA}`);
    assert.equal(fs.existsSync(f.worker_filepath), true, 'Saved file must physically exist at worker_filepath');
  });

  const histResB = await fetch(`${serverUrl}/api/tasks/${taskIdB}`);
  const histB = await histResB.json();
  assert.equal(histB.worker_id, 'worker-pcB');
  const certRecB = histB.files.find(f => f.file_type === 'cert');
  const packRecB = histB.files.find(f => f.file_type === 'packing');
  assert.ok(certRecB.worker_filepath.startsWith(expectedCertB));
  assert.ok(packRecB.worker_filepath.startsWith(expectedPackB));
});

test('DIR-13: 序列号缺失或包含跳目录、非法名称内容时拦截', async () => {
  const workerDir = path.join(testBaseDir, 'worker_dir_13');
  fs.mkdirSync(workerDir, { recursive: true });

  const worker = new ExecutionWorker({ workerId: 'worker-dir-13', name: '电脑13', serverUrl, workingDir: workerDir });
  await worker.sendHeartbeat();

  const certTmpl = db.prepare("SELECT * FROM templates WHERE model = 'POA200' AND type = 'cert'").get();
  db.prepare(`
    INSERT INTO worker_allowed_paths (worker_id, root_path, allow_read, allow_write, sync_status, check_status, created_at, updated_at)
    VALUES ('worker-dir-13', ?, 1, 1, 'SYNCED', 'PASSED', datetime('now'), datetime('now'))
  `).run(testBaseDir);

  db.prepare(`
    INSERT INTO worker_save_configs (worker_id, template_id, doc_type, root_dir, save_mode, subfolder_rule, allow_create, is_enabled, check_status, created_at, updated_at)
    VALUES ('worker-dir-13', ?, 'cert', ?, 'subfolder', 'deviceSn', 1, 1, 'PASSED', datetime('now'), datetime('now'))
  `).run(certTmpl.id, path.join(testBaseDir, 'docs_13'));

  // Attempt traversal: deviceSn = "../../system32"
  const badRes1 = await fetch(`${serverUrl}/api/tasks/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reqId: 'req_dir13_trav_' + Date.now(),
      clientId: 'c1',
      clientName: '测试员',
      workerId: 'worker-dir-13',
      model: 'POA200',
      docCombo: 'cert_only',
      deviceSn: '../../system32'
    })
  });
  assert.equal(badRes1.status, 400);
  const badData1 = await badRes1.json();
  assert.ok(badData1.error.includes('非法字符') || badData1.error.includes('跳出根目录'), 'Must reject path traversal in deviceSn (DIR-13)');

  // Attempt illegal characters: deviceSn = "SN<bad:val>"
  const badRes2 = await fetch(`${serverUrl}/api/tasks/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reqId: 'req_dir13_chars_' + Date.now(),
      clientId: 'c1',
      clientName: '测试员',
      workerId: 'worker-dir-13',
      model: 'POA200',
      docCombo: 'cert_only',
      deviceSn: 'SN<bad:val>'
    })
  });
  assert.equal(badRes2.status, 400);
  const badData2 = await badRes2.json();
  assert.ok(badData2.error.includes('非法字符') || badData2.error.includes('跳出根目录'), 'Must reject illegal characters in deviceSn (DIR-13)');
});

test('DIR-15, DIR-23: 任务受理后修改目录配置不影响旧任务快照，重试保持既定路径', async () => {
  const workerDir = path.join(testBaseDir, 'worker_dir_15');
  fs.mkdirSync(workerDir, { recursive: true });

  const worker = new ExecutionWorker({ workerId: 'worker-dir-15', name: '电脑15', serverUrl, workingDir: workerDir });
  await worker.sendHeartbeat();

  const certTmpl = db.prepare("SELECT * FROM templates WHERE model = 'POA200' AND type = 'cert'").get();
  const initialDir = path.join(testBaseDir, 'initial_dir_15');
  fs.mkdirSync(initialDir, { recursive: true });

  db.prepare(`
    INSERT INTO worker_allowed_paths (worker_id, root_path, allow_read, allow_write, sync_status, check_status, created_at, updated_at)
    VALUES ('worker-dir-15', ?, 1, 1, 'SYNCED', 'PASSED', datetime('now'), datetime('now'))
  `).run(testBaseDir);

  const cfgResult = db.prepare(`
    INSERT INTO worker_save_configs (worker_id, template_id, doc_type, root_dir, save_mode, allow_create, is_enabled, check_status, created_at, updated_at)
    VALUES ('worker-dir-15', ?, 'cert', ?, 'direct', 1, 1, 'PASSED', datetime('now'), datetime('now'))
  `).run(certTmpl.id, initialDir);
  const cfgId = cfgResult.lastInsertRowid;

  // Submit task -> snapshots initialDir
  const subRes = await fetch(`${serverUrl}/api/tasks/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reqId: 'req_dir15_' + Date.now(),
      clientId: 'c1',
      clientName: '李工',
      workerId: 'worker-dir-15',
      model: 'POA200',
      docCombo: 'cert_only',
      deviceSn: 'AP10009999'
    })
  });
  assert.equal(subRes.status, 200);
  const taskData = await subRes.json();
  const taskId = taskData.task.id;

  // Now modify config to a brand new directory
  const newDir = path.join(testBaseDir, 'new_dir_15_updated');
  fs.mkdirSync(newDir, { recursive: true });
  db.prepare(`
    UPDATE worker_save_configs SET root_dir = ?, version = version + 1, check_status = 'PASSED' WHERE id = ?
  `).run(newDir, cfgId);

  // Worker executes the old task
  await worker.pollAndExecuteTasks();

  // Verify file was saved to initialDir (from task snapshot), NOT newDir! (DIR-15)
  const initialFiles = fs.readdirSync(initialDir);
  assert.equal(initialFiles.length, 1, 'Old task must use snapshotted target_dir (DIR-15)');
  assert.equal(fs.readdirSync(newDir).length, 0, 'New directory must not be affected by old accepted task (DIR-15)');

  // DIR-23: 重试任务保持原既定文件名与保存位置
  const retryRes = await fetch(`${serverUrl}/api/tasks/${taskId}/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmedResolved: true, operatorName: '李工' })
  });
  assert.equal(retryRes.status, 200);

  const retryTask = db.prepare('SELECT * FROM task_files WHERE task_id = ?').get(taskId);
  assert.equal(retryTask.target_dir, initialDir, 'Retried task must retain snapshotted target_dir (DIR-23)');
});

test('DIR-16, DIR-20: 目标目录断开或不可写时报错且不改存，证书成功清单失败显示部分成功', async () => {
  const workerDir = path.join(testBaseDir, 'worker_dir_16');
  fs.mkdirSync(workerDir, { recursive: true });

  const worker = new ExecutionWorker({ workerId: 'worker-dir-16', name: '电脑16', serverUrl, workingDir: workerDir });
  await worker.sendHeartbeat();

  const certTmpl = db.prepare("SELECT * FROM templates WHERE model = 'POA200' AND type = 'cert'").get();
  const packTmpl = db.prepare("SELECT * FROM templates WHERE model = 'POA200' AND type = 'packing'").get();

  const certOkDir = path.join(testBaseDir, 'cert_ok_dir_16');
  fs.mkdirSync(certOkDir, { recursive: true });

  // Packing list target directory pointing to an invalid/unwritable location (DIR-16)
  const invalidPackingDir = process.platform === 'win32' ? 'Z:\\disconnected_drive_dir_2026' : '/sys/kernel/debug/invalid';

  db.prepare(`
    INSERT INTO worker_allowed_paths (worker_id, root_path, allow_read, allow_write, sync_status, check_status, created_at, updated_at)
    VALUES ('worker-dir-16', ?, 1, 1, 'SYNCED', 'PASSED', datetime('now'), datetime('now')),
           ('worker-dir-16', ?, 1, 1, 'SYNCED', 'PASSED', datetime('now'), datetime('now'))
  `).run(testBaseDir, invalidPackingDir);

  db.prepare(`
    INSERT INTO worker_save_configs (worker_id, template_id, doc_type, root_dir, save_mode, allow_create, is_enabled, check_status, created_at, updated_at)
    VALUES ('worker-dir-16', ?, 'cert', ?, 'direct', 1, 1, 'PASSED', datetime('now'), datetime('now')),
           ('worker-dir-16', ?, 'packing', ?, 'direct', 1, 1, 'PASSED', datetime('now'), datetime('now'))
  `).run(certTmpl.id, certOkDir, packTmpl.id, invalidPackingDir);

  const subRes = await fetch(`${serverUrl}/api/tasks/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reqId: 'req_dir16_' + Date.now(),
      clientId: 'c1',
      clientName: '测试员',
      workerId: 'worker-dir-16',
      model: 'POA200',
      deviceSn: '00001234',
      packingItems: [
        { index: 1, name: '主设备', spec: 'POA200', count: 1, unit: '台', standard: '是', remark: 'SN: 00001234带泵', isProtectedMain: true },
        { index: 2, name: '传感器', spec: 'PMT210SEN', count: 1, unit: '支', standard: '是', remark: 'SN: 201N200258', isProtectedSensor: true }
      ]
    })
  });
  assert.equal(subRes.status, 200);
  const taskId = (await subRes.json()).task.id;

  // Worker executes task: cert should succeed, packing list should fail on invalidPackingDir
  await worker.pollAndExecuteTasks();

  const histRes = await fetch(`${serverUrl}/api/tasks/${taskId}`);
  const task = await histRes.json();

  // DIR-20: 证书保存成功，清单保存失败，分别显示成功和失败，不显示全部成功 (PARTIAL_SUCCESS)
  const certFile = task.files.find(f => f.file_type === 'cert');
  const packFile = task.files.find(f => f.file_type === 'packing');

  assert.equal(certFile.status, 'PREVIEW_READY', 'Cert must succeed');
  assert.equal(packFile.status, 'FAILED', 'Packing list must fail on disconnected/unwritable target directory');
  assert.ok(packFile.error_msg.includes('目标目录') || packFile.error_msg.includes('创建失败') || packFile.error_msg.includes('不可写'), 'Error msg must clearly indicate target dir failure (DIR-16)');
  assert.equal(task.status, 'PARTIAL_SUCCESS', 'Overall task status must be PARTIAL_SUCCESS, never SUCCESS (DIR-20)');

  // Verify worker did NOT fall back to saving the failed packing list into workingDir! (DIR-16)
  const workingFiles = fs.readdirSync(workerDir);
  assert.equal(workingFiles.filter(f => f.includes('清单')).length, 0, 'Must NOT fallback to saving into workingDir! (DIR-16)');
});

test('DIR-22: 更改执行端显示名称不影响已有关联目录配置', async () => {
  const workerDir = path.join(testBaseDir, 'worker_dir_22');
  fs.mkdirSync(workerDir, { recursive: true });

  const worker = new ExecutionWorker({ workerId: 'worker-stable-22', name: '原电脑名', serverUrl, workingDir: workerDir });
  await worker.sendHeartbeat();

  const certTmpl = db.prepare("SELECT * FROM templates WHERE model = 'POA200' AND type = 'cert'").get();
  const dir22 = path.join(testBaseDir, 'dir_22');
  fs.mkdirSync(dir22, { recursive: true });

  db.prepare(`
    INSERT INTO worker_allowed_paths (worker_id, root_path, allow_read, allow_write, sync_status, check_status, created_at, updated_at)
    VALUES ('worker-stable-22', ?, 1, 1, 'SYNCED', 'PASSED', datetime('now'), datetime('now'))
  `).run(testBaseDir);

  db.prepare(`
    INSERT INTO worker_save_configs (worker_id, template_id, doc_type, root_dir, save_mode, allow_create, is_enabled, check_status, created_at, updated_at)
    VALUES ('worker-stable-22', ?, 'cert', ?, 'direct', 1, 1, 'PASSED', datetime('now'), datetime('now'))
  `).run(certTmpl.id, dir22);

  // Rename worker
  db.prepare("UPDATE workers SET name = '新车间电脑名称' WHERE id = 'worker-stable-22'").run();

  // Validate directory config is still linked and valid via workerId
  const valRes = await fetch(`${serverUrl}/api/tasks/validate-directories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workerId: 'worker-stable-22',
      model: 'POA200',
      docCombo: 'cert_only'
    })
  });
  const valData = await valRes.json();
  assert.equal(valData.valid, true, 'Directory config must remain valid after worker display name change (DIR-22)');
});
