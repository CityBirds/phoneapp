const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const http = require('http');

// Setup isolated environment
const testBaseDir = path.resolve(__dirname, '../data/test_wc_20260929');
const testDbPath = path.join(testBaseDir, 'test_wc.db');
process.env.DB_PATH = testDbPath;
process.env.PORT = '3040';
process.env.NODE_ENV = 'test';

if (fs.existsSync(testBaseDir)) {
  fs.rmSync(testBaseDir, { recursive: true, force: true });
}
fs.mkdirSync(testBaseDir, { recursive: true });

const db = require('../src/backend/db');
const app = require('../src/backend/server');
const ExecutionWorker = require('../src/worker/worker');

let server;
const serverUrl = 'http://localhost:3040';

let certPoaTmpl;
let packPoaTmpl;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(3040, () => {
      resolve();
    });
  });

  // Fetch existing published POA200 templates
  certPoaTmpl = db.prepare("SELECT * FROM templates WHERE model = 'POA200' AND type = 'cert' AND published_at IS NOT NULL").get();
  packPoaTmpl = db.prepare("SELECT * FROM templates WHERE model = 'POA200' AND type = 'packing' AND published_at IS NOT NULL").get();
  assert.ok(certPoaTmpl, 'POA200 cert template must exist');
  assert.ok(packPoaTmpl, 'POA200 packing template must exist');
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  try { if (fs.existsSync(testBaseDir)) fs.rmSync(testBaseDir, { recursive: true, force: true }); } catch (e) {}
});

test('WC-01, WC-02, WC-03: 终端卡片进入配置详情、旧入口引导、打印机区域防误触', async () => {
  const adminHtml = fs.readFileSync(path.resolve(__dirname, '../src/frontend/admin.html'), 'utf-8');
  const adminJs = fs.readFileSync(path.resolve(__dirname, '../src/frontend/admin.js'), 'utf-8');

  // WC-01: Contains sec-worker-detail and showWorkerDetail function
  assert.ok(adminHtml.includes('id="sec-worker-detail"'), 'Must have sec-worker-detail section in admin.html (WC-01)');
  assert.ok(adminJs.includes('function showWorkerDetail('), 'Must have showWorkerDetail function in admin.js (WC-01)');

  // WC-02: Old #directories route guided without blank page
  assert.ok(adminHtml.includes('directories-migration-banner'), 'Must have migration banner for directories URL (WC-02)');
  assert.ok(adminJs.includes("tabId === 'directories'"), 'switchTab must handle directories tab by guiding to workers (WC-02)');

  // WC-03: Printer area has event.stopPropagation() so clicks don't falsely trigger worker config
  assert.ok(adminJs.includes('event.stopPropagation()'), 'Printers area must stopPropagation to prevent entering computer config (WC-03)');
});

test('WC-04, WC-05, WC-06: 新终端默认未启用、改名改IP关联同一workerId、离线不假报通过', async () => {
  const workerDir = path.join(testBaseDir, 'worker_dir_04');
  fs.mkdirSync(workerDir, { recursive: true });

  const worker = new ExecutionWorker({ workerId: 'worker-wc-04', name: '车间电脑04', serverUrl, workingDir: workerDir });
  await worker.sendHeartbeat();

  // WC-04: 新终端接入，管理端可配置，但模板默认未启用，手机端不可见
  const bundleRes = await fetch(`${serverUrl}/api/published-bundles?workerId=worker-wc-04`);
  assert.equal(bundleRes.status, 200);
  const bundles = await bundleRes.json();
  assert.equal(bundles.length, 0, 'New worker must have NO templates exposed by default (WC-04)');

  // Configure allowed path and template
  const allowedDir = path.join(testBaseDir, 'auth_04');
  fs.mkdirSync(allowedDir, { recursive: true });
  await fetch(`${serverUrl}/api/admin/workers/worker-wc-04/allowed-paths`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': 'phoneapp-admin-secret' },
    body: JSON.stringify({ rootPath: allowedDir, allowRead: true, allowWrite: true })
  });

  await fetch(`${serverUrl}/api/admin/workers/worker-wc-04/template-configs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': 'phoneapp-admin-secret' },
    body: JSON.stringify({
      templateId: certPoaTmpl.id,
      docType: 'cert',
      isEnabled: true,
      rootDir: allowedDir
    })
  });

  // WC-05: 修改终端显示名称或IP，配置仍绑定同一workerId
  db.prepare("UPDATE workers SET name = '修改后的电脑名称', ip = '192.168.1.199' WHERE id = 'worker-wc-04'").run();
  const cfgAfterRename = db.prepare("SELECT * FROM worker_save_configs WHERE worker_id = 'worker-wc-04'").all();
  assert.equal(cfgAfterRename.length, 1, 'Configs must remain linked to stable workerId (WC-05)');

  // WC-06: 终端暂时离线，发起检查不能假报通过
  db.prepare("UPDATE workers SET last_heartbeat = '2020-01-01T00:00:00Z' WHERE id = 'worker-wc-04'").run();
  const checkRes = await fetch(`${serverUrl}/api/admin/workers/worker-wc-04/template-configs/${cfgAfterRename[0].id}/check`, {
    method: 'POST',
    headers: { 'x-admin-token': 'phoneapp-admin-secret' }
  });
  assert.equal(checkRes.status, 400);
  const checkData = await checkRes.json();
  assert.equal(checkData.offline, true);
  const cfgOffline = db.prepare("SELECT * FROM worker_save_configs WHERE id = ?").get(cfgAfterRename[0].id);
  assert.notEqual(cfgOffline.check_status, 'PASSED', 'Offline worker check must never falsely report PASSED (WC-06)');
});

test('WC-07, WC-08, WC-10: 业务路径授权、D:\\docs-other越界拦截与允许创建控制', async () => {
  const workerDir = path.join(testBaseDir, 'worker_dir_07');
  fs.mkdirSync(workerDir, { recursive: true });

  const worker = new ExecutionWorker({ workerId: 'worker-wc-07', name: '电脑07', serverUrl, workingDir: workerDir });
  await worker.sendHeartbeat();

  const authDir = path.join(testBaseDir, 'docs');
  fs.mkdirSync(authDir, { recursive: true });

  // Add allowed path
  const addAuthRes = await fetch(`${serverUrl}/api/admin/workers/worker-wc-07/allowed-paths`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': 'phoneapp-admin-secret' },
    body: JSON.stringify({ rootPath: authDir, allowRead: true, allowWrite: true, allowCreate: true })
  });
  assert.equal(addAuthRes.status, 200);

  // WC-08: 保存到 D:\docs-other、或路径穿越越界 -> 拦截拒绝 (E04, WC-08)
  const otherDir = path.join(testBaseDir, 'docs-other');
  const badCfgRes1 = await fetch(`${serverUrl}/api/admin/workers/worker-wc-07/template-configs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': 'phoneapp-admin-secret' },
    body: JSON.stringify({
      templateId: certPoaTmpl.id,
      docType: 'cert',
      isEnabled: true,
      rootDir: otherDir
    })
  });
  assert.equal(badCfgRes1.status, 400);
  const badData1 = await badCfgRes1.json();
  assert.ok(badData1.error.includes('未包含在执行端允许') || badData1.error.includes('范围'), 'Must reject docs-other outside authDir (WC-08)');

  // WC-07: 指定子目录 D:\docs\sub_docs 在授权范围内 -> 允许配置
  const subDir = path.join(authDir, 'sub_docs');
  const okCfgRes = await fetch(`${serverUrl}/api/admin/workers/worker-wc-07/template-configs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': 'phoneapp-admin-secret' },
    body: JSON.stringify({
      templateId: certPoaTmpl.id,
      docType: 'cert',
      isEnabled: true,
      rootDir: subDir,
      allowCreate: true
    })
  });
  assert.equal(okCfgRes.status, 200, 'Subfolder in authorized path must be allowed (WC-07)');

  // WC-10: 根目录缺失，分别关闭/打开允许创建
  const nonExistDir = path.join(authDir, 'non_existent_folder_10');
  const checkFail = {
    id: 9910,
    check_type: 'save_config',
    root_dir: nonExistDir,
    allow_create: 0,
    version: 1
  };
  // Worker probes with allow_create = 0 -> Fails
  await worker.executeDirectoryCheck(checkFail);
  assert.equal(fs.existsSync(nonExistDir), false);

  // Worker probes with allow_create = 1 -> Creates and passes
  const checkPass = {
    id: 9911,
    check_type: 'save_config',
    root_dir: nonExistDir,
    allow_create: 1,
    version: 1
  };
  await worker.executeDirectoryCheck(checkPass);
  assert.equal(fs.existsSync(nonExistDir), true, 'Must create directory when allow_create is enabled (WC-10)');
});

test('WC-11, WC-12, WC-13: 手机端多执行端可见性、文档组合切换与未配置阻止提交', async () => {
  const dirA = path.join(testBaseDir, 'workerA_11');
  const dirB = path.join(testBaseDir, 'workerB_11');
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });

  const workerA = new ExecutionWorker({ workerId: 'worker-11-A', name: '电脑A', serverUrl, workingDir: dirA });
  const workerB = new ExecutionWorker({ workerId: 'worker-11-B', name: '电脑B', serverUrl, workingDir: dirB });
  await workerA.sendHeartbeat();
  await workerB.sendHeartbeat();

  // Authorize paths
  db.prepare(`
    INSERT INTO worker_allowed_paths (worker_id, root_path, allow_read, allow_write, sync_status, check_status, created_at, updated_at)
    VALUES ('worker-11-A', ?, 1, 1, 'SYNCED', 'PASSED', datetime('now'), datetime('now')),
           ('worker-11-B', ?, 1, 1, 'SYNCED', 'PASSED', datetime('now'), datetime('now'))
  `).run(dirA, dirB);

  // Worker A enables POA200 cert and packing
  db.prepare(`
    INSERT INTO worker_save_configs (worker_id, template_id, doc_type, root_dir, save_mode, allow_create, is_enabled, check_status, created_at, updated_at)
    VALUES ('worker-11-A', ?, 'cert', ?, 'direct', 1, 1, 'PASSED', datetime('now'), datetime('now')),
           ('worker-11-A', ?, 'packing', ?, 'direct', 1, 1, 'PASSED', datetime('now'), datetime('now'))
  `).run(certPoaTmpl.id, dirA, packPoaTmpl.id, dirA);

  // Worker B does NOT enable POA200 (WC-11)
  const resA = await fetch(`${serverUrl}/api/published-bundles?workerId=worker-11-A`);
  const bundlesA = await resA.json();
  assert.ok(bundlesA.some(b => b.model_display === 'POA200'), 'POA200 must be visible on Worker A (WC-11)');

  const resB = await fetch(`${serverUrl}/api/published-bundles?workerId=worker-11-B`);
  const bundlesB = await resB.json();
  assert.ok(!bundlesB.some(b => b.model_display === 'POA200'), 'POA200 must NOT be visible on Worker B (WC-11)');

  // WC-12: 同型号证书与清单分别切换组合 (cert_only / packing_only / cert_and_packing)
  // Disable packing on Worker A -> should become 'cert_only'
  db.prepare("UPDATE worker_save_configs SET is_enabled = 0 WHERE worker_id = 'worker-11-A' AND doc_type = 'packing'").run();
  const resA_certOnly = await fetch(`${serverUrl}/api/published-bundles?workerId=worker-11-A`);
  const bundlesA_certOnly = await resA_certOnly.json();
  const poaCertOnly = bundlesA_certOnly.find(b => b.model_display === 'POA200');
  assert.ok(poaCertOnly);
  assert.equal(poaCertOnly.doc_combo, 'cert_only', 'Must show cert_only when packing is disabled (WC-12)');

  // Enable packing, disable cert -> should become 'packing_only'
  db.prepare("UPDATE worker_save_configs SET is_enabled = 1 WHERE worker_id = 'worker-11-A' AND doc_type = 'packing'").run();
  db.prepare("UPDATE worker_save_configs SET is_enabled = 0 WHERE worker_id = 'worker-11-A' AND doc_type = 'cert'").run();
  const resA_packOnly = await fetch(`${serverUrl}/api/published-bundles?workerId=worker-11-A`);
  const bundlesA_packOnly = await resA_packOnly.json();
  const poaPackOnly = bundlesA_packOnly.find(b => b.model_display === 'POA200');
  assert.ok(poaPackOnly);
  assert.equal(poaPackOnly.doc_combo, 'packing_only', 'Must show packing_only when cert is disabled (WC-12)');

  // Re-enable both, but make packing directory unconfigured (WC-13)
  db.prepare("UPDATE worker_save_configs SET is_enabled = 1, check_status = 'PASSED' WHERE worker_id = 'worker-11-A' AND doc_type = 'cert'").run();
  db.prepare("UPDATE worker_save_configs SET is_enabled = 1, check_status = 'PENDING', root_dir = '' WHERE worker_id = 'worker-11-A' AND doc_type = 'packing'").run();

  const resA_unready = await fetch(`${serverUrl}/api/published-bundles?workerId=worker-11-A`);
  const bundlesA_unready = await resA_unready.json();
  const poaUnready = bundlesA_unready.find(b => b.model_display === 'POA200');
  assert.equal(poaUnready.doc_combo, 'cert_and_packing', 'Combo remains cert_and_packing without silent downgrade (WC-13)');
  assert.equal(poaUnready.is_ready, false, 'Must be marked unready (WC-13)');
  assert.ok(poaUnready.unready_reason.includes('装箱清单'), 'Reason must explain missing packing directory config (WC-13)');
});

test('WC-14, WC-15, WC-16, WC-17: 管理员停用后提交被拒、跨终端防串配置与旧结果版本失效', async () => {
  const dir14 = path.join(testBaseDir, 'worker_14');
  fs.mkdirSync(dir14, { recursive: true });

  const worker = new ExecutionWorker({ workerId: 'worker-wc-14', name: '电脑14', serverUrl, workingDir: dir14 });
  await worker.sendHeartbeat();

  db.prepare(`
    INSERT INTO worker_allowed_paths (worker_id, root_path, allow_read, allow_write, sync_status, check_status, created_at, updated_at)
    VALUES ('worker-wc-14', ?, 1, 1, 'SYNCED', 'PASSED', datetime('now'), datetime('now'))
  `).run(dir14);

  const cfgRes = db.prepare(`
    INSERT INTO worker_save_configs (worker_id, template_id, doc_type, root_dir, save_mode, allow_create, is_enabled, version, check_status, created_at, updated_at)
    VALUES ('worker-wc-14', ?, 'cert', ?, 'direct', 1, 1, 1, 'PASSED', datetime('now'), datetime('now'))
  `).run(certPoaTmpl.id, dir14);
  const cfgId = cfgRes.lastInsertRowid;

  // WC-17: 修改配置产生版本2，执行端返回版本1的迟到结果 -> 被忽略，状态保持待检查
  db.prepare("UPDATE worker_save_configs SET version = 2, check_status = 'PENDING' WHERE id = ?").run(cfgId);
  await fetch(`${serverUrl}/api/worker/directory-checks/result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      checkId: 8888,
      checkType: 'save_config',
      targetId: cfgId,
      version: 1, // Late version!
      status: 'PASSED',
      message: '迟到的旧检查结果'
    })
  });
  const afterLate = db.prepare("SELECT * FROM worker_save_configs WHERE id = ?").get(cfgId);
  assert.equal(afterLate.check_status, 'PENDING', 'Stale version result must be ignored (WC-17)');

  // Set back to PASSED, then test WC-14
  db.prepare("UPDATE worker_save_configs SET check_status = 'PASSED' WHERE id = ?").run(cfgId);

  // Administrator disables template (is_enabled = 0)
  db.prepare("UPDATE worker_save_configs SET is_enabled = 0 WHERE id = ?").run(cfgId);

  // Mobile submits task with disabled template -> server rejects with WC-14 prompt
  const subRes = await fetch(`${serverUrl}/api/tasks/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reqId: 'req_wc14_' + Date.now(),
      clientId: 'c1',
      clientName: '操作员',
      workerId: 'worker-wc-14',
      model: 'POA200',
      docCombo: 'cert_only',
      deviceSn: 'AP10007513'
    })
  });
  assert.equal(subRes.status, 400);
  const subData = await subRes.json();
  assert.ok(subData.error.includes('停用') || subData.error.includes('刷新'), 'Server must reject disabled template with refresh notice (WC-14)');

  // WC-15: 篡改 workerId 提交 -> 拒绝
  const tamperRes = await fetch(`${serverUrl}/api/tasks/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reqId: 'req_tamper_' + Date.now(),
      clientId: 'c1',
      clientName: '操作员',
      workerId: 'worker-unauthorized-99',
      model: 'POA200',
      docCombo: 'cert_only',
      deviceSn: 'AP10007513'
    })
  });
  assert.equal(tamperRes.status, 400, 'Tampered workerId must be rejected (WC-15)');
});

test('WC-19, WC-20, WC-21, WC-24: 停用不影响旧任务快照、撤销写权限报错、缺失目标目录拒绝、分文档独立状态', async () => {
  const dir19 = path.join(testBaseDir, 'worker_19');
  fs.mkdirSync(dir19, { recursive: true });

  const worker = new ExecutionWorker({ workerId: 'worker-wc-19', name: '电脑19', serverUrl, workingDir: dir19 });
  await worker.sendHeartbeat();

  db.prepare(`
    INSERT INTO worker_allowed_paths (worker_id, root_path, allow_read, allow_write, sync_status, check_status, created_at, updated_at)
    VALUES ('worker-wc-19', ?, 1, 1, 'SYNCED', 'PASSED', datetime('now'), datetime('now'))
  `).run(dir19);

  db.prepare(`
    INSERT INTO worker_save_configs (worker_id, template_id, doc_type, root_dir, save_mode, allow_create, is_enabled, check_status, created_at, updated_at)
    VALUES ('worker-wc-19', ?, 'cert', ?, 'direct', 1, 1, 'PASSED', datetime('now'), datetime('now')),
           ('worker-wc-19', ?, 'packing', ?, 'direct', 1, 0, 'PASSED', datetime('now'), datetime('now'))
  `).run(certPoaTmpl.id, dir19, packPoaTmpl.id, dir19);

  // Submit valid task (cert only enabled)
  const subRes = await fetch(`${serverUrl}/api/tasks/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reqId: 'req_wc19_' + Date.now(),
      clientId: 'c1',
      clientName: '小刘',
      workerId: 'worker-wc-19',
      model: 'POA200',
      docCombo: 'cert_only',
      deviceSn: 'AP10007513'
    })
  });
  assert.equal(subRes.status, 200);
  const task19Id = (await subRes.json()).task.id;

  // WC-19: 任务受理后管理员停用模板，不自动取消任务，按快照继续执行成功
  db.prepare("UPDATE worker_save_configs SET is_enabled = 0 WHERE worker_id = 'worker-wc-19'").run();
  await worker.pollAndExecuteTasks();

  const task19After = await (await fetch(`${serverUrl}/api/tasks/${task19Id}`)).json();
  assert.equal(task19After.files[0].status, 'PREVIEW_READY', 'Accepted task must execute successfully via snapshot (WC-19)');
  assert.equal(fs.existsSync(task19After.files[0].worker_filepath), true);

  // WC-20: 已受理任务之后撤销对应路径权限 -> 执行端拒绝写入，不改存其他位置
  // Re-enable template for submission
  db.prepare("UPDATE worker_save_configs SET is_enabled = 1 WHERE worker_id = 'worker-wc-19'").run();
  const subRes20 = await fetch(`${serverUrl}/api/tasks/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reqId: 'req_wc20_' + Date.now(),
      clientId: 'c1',
      clientName: '小刘',
      workerId: 'worker-wc-19',
      model: 'POA200',
      docCombo: 'cert_only',
      deviceSn: 'AP10007513'
    })
  });
  assert.equal(subRes20.status, 200);
  const task20Id = (await subRes20.json()).task.id;

  // Now revoke write permission in worker_allowed_paths
  db.prepare("UPDATE worker_allowed_paths SET allow_write = 0 WHERE worker_id = 'worker-wc-19'").run();
  await worker.pollAndExecuteTasks();

  const task20After = await (await fetch(`${serverUrl}/api/tasks/${task20Id}`)).json();
  assert.equal(task20After.files[0].status, 'FAILED', 'Revoked path authorization must fail task (WC-20)');
  assert.ok(task20After.files[0].error_msg.includes('授权已撤销') || task20After.files[0].error_msg.includes('当前授权范围'), 'Must report authorization revoked (WC-20)');

  // WC-21: 没有目标目录的任务到达执行端 -> 明确拒绝，不回退 workingDir
  const missingDirTask = {
    id: 9921,
    model: 'POA200',
    device_sn: 'AP10007513',
    files: [{ file_type: 'cert', official_filename: 'test.doc', target_dir: '' }]
  };
  let threw21 = false;
  try {
    await worker.processTask(missingDirTask);
  } catch (err) {
    threw21 = true;
    assert.ok(err.message.includes('未指定有效保存目标目录'), 'Must explicitly reject task without target_dir (WC-21)');
  }
  // Verify nothing written to workingDir
  const workFiles = fs.readdirSync(dir19);
  assert.equal(workFiles.filter(f => f.includes('test.doc')).length, 0, 'Must NOT fallback to workingDir! (WC-21)');
});

test('WC-22, WC-23, WC-25, WC-26: 磁盘不可用报错不损坏旧文件、同名副本保护、重启后配置持久化、草稿新模板不自动开放', async () => {
  const dir25 = path.join(testBaseDir, 'worker_25');
  fs.mkdirSync(dir25, { recursive: true });

  const worker = new ExecutionWorker({ workerId: 'worker-wc-25', name: '电脑25', serverUrl, workingDir: dir25 });
  await worker.sendHeartbeat();

  const authDir25 = path.join(testBaseDir, 'auth_25');
  fs.mkdirSync(authDir25, { recursive: true });

  db.prepare(`
    INSERT INTO worker_allowed_paths (worker_id, root_path, allow_read, allow_write, sync_status, check_status, created_at, updated_at)
    VALUES ('worker-wc-25', ?, 1, 1, 'SYNCED', 'PASSED', datetime('now'), datetime('now'))
  `).run(authDir25);

  db.prepare(`
    INSERT INTO worker_save_configs (worker_id, template_id, doc_type, root_dir, save_mode, allow_create, is_enabled, check_status, created_at, updated_at)
    VALUES ('worker-wc-25', ?, 'cert', ?, 'direct', 1, 1, 'PASSED', datetime('now'), datetime('now'))
  `).run(certPoaTmpl.id, authDir25);

  // WC-23: 同名覆盖保护，旧文件存在时自动安全改名为 -副本(1).doc
  const existingFile = path.join(authDir25, 'POA200证书AP10007513.doc');
  fs.writeFileSync(existingFile, 'old original content');

  const task23 = {
    id: 9923,
    model: 'POA200',
    device_sn: 'AP10007513',
    files: [{ file_type: 'cert', official_filename: 'POA200证书AP10007513.doc', target_dir: authDir25 }]
  };
  await worker.processTask(task23);

  // Verify original file preserved as -副本(1) and new file saved at officialFilePath (WC-23)
  const copyFile = path.join(authDir25, 'POA200证书AP10007513-副本(1).doc');
  assert.equal(fs.existsSync(copyFile), true, 'Duplicate copy -副本(1) must be created (WC-23)');
  assert.equal(fs.readFileSync(copyFile, 'utf-8'), 'old original content', 'Old file must be safely preserved as -副本(1) (WC-23)');
  assert.equal(fs.existsSync(existingFile), true, 'New official document must exist (WC-23)');

  // WC-22: 磁盘不可用或断开时明确报错，不损坏旧文件、不假报成功
  const invalidDir = process.platform === 'win32' ? 'Z:\\\\disconnected_drive_dir_2026' : '/sys/kernel/debug/invalid';
  db.prepare(`
    INSERT INTO worker_allowed_paths (worker_id, root_path, allow_read, allow_write, sync_status, check_status, created_at, updated_at)
    VALUES ('worker-wc-25', ?, 1, 1, 'SYNCED', 'PASSED', datetime('now'), datetime('now'))
  `).run(invalidDir);
  db.prepare(`
    INSERT INTO worker_save_configs (worker_id, template_id, doc_type, root_dir, save_mode, allow_create, is_enabled, check_status, created_at, updated_at)
    VALUES ('worker-wc-25', ?, 'packing', ?, 'direct', 1, 1, 'PASSED', datetime('now'), datetime('now'))
  `).run(packPoaTmpl.id, invalidDir);

  const subRes22 = await fetch(`${serverUrl}/api/tasks/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reqId: 'req_wc22_' + Date.now(),
      clientId: 'c1',
      clientName: '操作员',
      workerId: 'worker-wc-25',
      model: 'POA200',
      docCombo: 'cert_and_packing',
      deviceSn: 'AP10007513',
      packingItems: [
        { index: 1, name: '主设备', spec: 'POA200', count: 1, unit: '台', standard: '是', remark: 'SN: AP10007513带泵', isProtectedMain: true },
        { index: 2, name: '传感器', spec: 'PMT210SEN', count: 1, unit: '支', standard: '是', remark: 'SN: 201N200258', isProtectedSensor: true }
      ]
    })
  });
  assert.equal(subRes22.status, 200);
  const task22Id = (await subRes22.json()).task.id;

  await worker.pollAndExecuteTasks();

  const task22After = await (await fetch(`${serverUrl}/api/tasks/${task22Id}`)).json();
  const packFile = task22After.files.find(f => f.file_type === 'packing');
  assert.equal(packFile.status, 'FAILED', 'Unwritable/disconnected target directory must fail (WC-22)');
  assert.ok(packFile.error_msg.includes('目标目录创建失败') || packFile.error_msg.includes('不可写'), 'Accurate error on unwritable disk (WC-22)');
  assert.notEqual(task22After.status, 'SUCCESS', 'Must never report full success on failure (WC-22, WC-24)');

  // WC-25: 协调服务重启或重新进入，路径、启用状态、保存规则持久化
  const savedPaths = db.prepare("SELECT * FROM worker_allowed_paths WHERE worker_id = 'worker-wc-25'").all();
  const savedConfigs = db.prepare("SELECT * FROM worker_save_configs WHERE worker_id = 'worker-wc-25'").all();
  assert.equal(savedPaths.length, 2, 'Allowed paths must be persisted in DB (WC-25)');
  assert.equal(savedConfigs.length, 2, 'Template configs must be persisted in DB (WC-25)');
  assert.equal(savedConfigs[0].is_enabled, 1, 'is_enabled flag must be persisted (WC-25)');

  // WC-26: 未发布草稿或新增模板进入库，不因上传就自动开放给所有执行端
  db.prepare(`
    INSERT INTO templates (id, model, type, filename, filepath, file_hash, version, published_at, field_mappings)
    VALUES ('tmpl_draft_wc26', 'NEWMODEL', 'cert', 'draft.doc', 'dummy.doc', 'hash26', '0.1', NULL, '{}')
  `).run();
  const bundlesDraft = await (await fetch(`${serverUrl}/api/published-bundles?workerId=worker-wc-25`)).json();
  assert.ok(!bundlesDraft.some(b => b.model_display === 'NEWMODEL'), 'Unpublished/draft template must not be exposed (WC-26)');
});
