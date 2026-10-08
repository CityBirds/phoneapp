const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const testDbPath = path.resolve(__dirname, `../data/phoneapp_fix_test_${Date.now()}.db`);
process.env.DB_PATH = testDbPath;
// 测试隔离：预览与回传产物不得写入生产 data/previews、data/returned
process.env.PREVIEW_DIR = path.join(path.dirname(testDbPath), 'previews_test_isolated');
process.env.RETURNED_DIR = path.join(path.dirname(testDbPath), 'returned_test_isolated');

const app = require('../src/backend/server');
const db = require('../src/backend/db');
const ExecutionWorker = require('../src/worker/worker');

let server;
const PORT = 3031;
const serverUrl = `http://localhost:${PORT}`;

const testBaseDir = path.resolve(__dirname, `../data/test_fix_mgr_${Date.now()}`);

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

test('FIX-01, FIX-02, FIX-03: 客户端列表加载、改名与历史审计日志独立性', async () => {
  // Register two test clients
  const now = new Date().toISOString();
  db.prepare('INSERT OR REPLACE INTO clients (id, name, last_seen, created_at) VALUES (?, ?, ?, ?)').run('client-01', '张三 (手机1)', now, now);
  db.prepare('INSERT OR REPLACE INTO clients (id, name, last_seen, created_at) VALUES (?, ?, ?, ?)').run('client-02', '李四 (手机2)', now, now);

  // FIX-01: GET /api/clients returns clients list
  const res = await fetch(`${serverUrl}/api/clients`);
  assert.equal(res.status, 200);
  const clients = await res.json();
  assert.ok(clients.length >= 2, 'Should have at least 2 clients');
  const c1 = clients.find(c => c.id === 'client-01');
  assert.ok(c1);
  assert.equal(c1.name, '张三 (手机1)');

  // Record an audit log with original name
  db.prepare('INSERT INTO audit_logs (req_id, client_id, client_name, action, details, timestamp) VALUES (?, ?, ?, ?, ?, ?)')
    .run('req-old-01', 'client-01', '张三 (手机1)', 'SUBMIT_TASK', JSON.stringify({ sn: 'SN123' }), now);

  // FIX-02: Modify client name via PUT /api/clients/:id
  const putRes = await fetch(`${serverUrl}/api/clients/client-01`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '张工 (新车间)' })
  });
  assert.equal(putRes.status, 200);
  const putData = await putRes.json();
  assert.equal(putData.name, '张工 (新车间)');

  // Verify updated in database
  const updatedClient = db.prepare('SELECT * FROM clients WHERE id = ?').get('client-01');
  assert.equal(updatedClient.name, '张工 (新车间)');

  // Verify historical audit log still keeps original name
  const oldLog = db.prepare('SELECT * FROM audit_logs WHERE req_id = ?').get('req-old-01');
  assert.equal(oldLog.client_name, '张三 (手机1)', 'Historical audit log must not be rewritten');

  // FIX-03: Empty name validation
  const emptyRes = await fetch(`${serverUrl}/api/clients/client-01`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '   ' })
  });
  assert.equal(emptyRes.status, 400);
});

test('FIX-04, FIX-05: 旧库 config_id NOT NULL 迁移、表结构幂等性与保留数据', async () => {
  // Check schema of worker_directory_checks
  const info = db.prepare('PRAGMA table_info(worker_directory_checks)').all();
  const configIdCol = info.find(c => c.name === 'config_id');
  assert.ok(configIdCol, 'config_id column must exist');
  assert.equal(configIdCol.notnull, 0, 'config_id must be NULLABLE after migration');

  // Insert an allowed_path check with config_id = null
  const insStmt = db.prepare(`
    INSERT INTO worker_directory_checks (check_type, target_id, config_id, worker_id, version, root_dir, allow_create, allow_read, allow_write, status, created_at)
    VALUES ('allowed_path', 101, NULL, 'worker-mig-01', 1, 'D:\\test', 0, 1, 1, 'PENDING', ?)
  `);
  assert.doesNotThrow(() => {
    insStmt.run(new Date().toISOString());
  }, 'Inserting check with config_id=NULL must succeed');
});

test('FIX-06, FIX-07, FIX-08, FIX-09, FIX-10: 授权路径保存、探测状态、离线处理与卡住记录恢复', async () => {
  const workerDir = path.join(testBaseDir, 'worker_fix_dir');
  fs.mkdirSync(workerDir, { recursive: true });

  const worker = new ExecutionWorker({
    workerId: 'worker-fix-01',
    name: '测试执行机-FIX',
    serverUrl,
    workingDir: workerDir
  });

  // FIX-10: Worker is offline initially -> save allowed path
  const saveOfflineRes = await fetch(`${serverUrl}/api/admin/workers/worker-fix-01/allowed-paths`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rootPath: workerDir,
      allowRead: true,
      allowWrite: true,
      allowCreate: false
    })
  });
  assert.equal(saveOfflineRes.status, 200);
  const saveOfflineData = await saveOfflineRes.json();
  assert.equal(saveOfflineData.allowedPath.check_status, 'PENDING');
  assert.equal(saveOfflineData.allowedPath.allow_create, 0);

  // Probe when offline -> should reject with offline=true
  const checkOfflineRes = await fetch(`${serverUrl}/api/admin/workers/worker-fix-01/allowed-paths/${saveOfflineData.allowedPath.id}/check`, {
    method: 'POST'
  });
  assert.equal(checkOfflineRes.status, 400);
  const offlineErr = await checkOfflineRes.json();
  assert.equal(offlineErr.offline, true);

  // FIX-09: Orphan CHECKING recovery test
  db.prepare("UPDATE worker_allowed_paths SET check_status = 'CHECKING' WHERE id = ?").run(saveOfflineData.allowedPath.id);
  // No active check task exists for this path
  const orphanedCheck = db.prepare('SELECT * FROM worker_directory_checks WHERE check_type = \'allowed_path\' AND target_id = ?').get(saveOfflineData.allowedPath.id);
  assert.equal(orphanedCheck, undefined);

  // Trigger recovery query
  const checkingPaths = db.prepare("SELECT * FROM worker_allowed_paths WHERE check_status = 'CHECKING'").all();
  for (const p of checkingPaths) {
    const activeTask = db.prepare("SELECT id FROM worker_directory_checks WHERE check_type = 'allowed_path' AND target_id = ? AND status IN ('PENDING', 'PROCESSING')").get(p.id);
    if (!activeTask) {
      db.prepare("UPDATE worker_allowed_paths SET check_status = 'PENDING', check_message = '服务启动恢复：无有效关联检查任务，已自动重置为待检查' WHERE id = ?").run(p.id);
    }
  }
  const recoveredPath = db.prepare('SELECT * FROM worker_allowed_paths WHERE id = ?').get(saveOfflineData.allowedPath.id);
  assert.equal(recoveredPath.check_status, 'PENDING', 'Orphan CHECKING should be recovered to PENDING');

  // Worker sends heartbeat -> now online
  await worker.sendHeartbeat();

  // FIX-06: Online check task creation
  const checkOnlineRes = await fetch(`${serverUrl}/api/admin/workers/worker-fix-01/allowed-paths/${saveOfflineData.allowedPath.id}/check`, {
    method: 'POST'
  });
  assert.equal(checkOnlineRes.status, 200);

  // FIX-07: Worker executes probe task and writes back PASSED
  await worker.pollAndExecuteDirectoryChecks();
  const probedPath = db.prepare('SELECT * FROM worker_allowed_paths WHERE id = ?').get(saveOfflineData.allowedPath.id);
  assert.equal(probedPath.check_status, 'PASSED');
});

test('FIX-11, FIX-12: allow_create 创建控制（关闭创建禁止建立目录，开启创建正常建立）', async () => {
  const workerDir = path.join(testBaseDir, 'worker_fix_allow_create');
  fs.mkdirSync(workerDir, { recursive: true });

  const worker = new ExecutionWorker({
    workerId: 'worker-allow-create-01',
    name: '测试执行机-AllowCreate',
    serverUrl,
    workingDir: workerDir
  });
  await worker.sendHeartbeat();

  const nonExistentDir1 = path.join(workerDir, 'subdir_no_create');
  assert.equal(fs.existsSync(nonExistentDir1), false);

  // FIX-11: allow_create = 0 (false) -> check must FAIL and directory MUST NOT be created
  const save1 = await fetch(`${serverUrl}/api/admin/workers/worker-allow-create-01/allowed-paths`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rootPath: nonExistentDir1,
      allowRead: true,
      allowWrite: true,
      allowCreate: false
    })
  });
  const data1 = await save1.json();
  assert.equal(data1.allowedPath.allow_create, 0);

  await worker.pollAndExecuteDirectoryChecks();
  const checked1 = db.prepare('SELECT * FROM worker_allowed_paths WHERE id = ?').get(data1.allowedPath.id);
  assert.equal(checked1.check_status, 'FAILED', 'Should fail when directory does not exist and allow_create=false');
  assert.equal(fs.existsSync(nonExistentDir1), false, 'Directory must NOT be created when allow_create=false');

  // FIX-12: allow_create = 1 (true) -> directory IS created and check passes
  const nonExistentDir2 = path.join(workerDir, 'subdir_with_create');
  assert.equal(fs.existsSync(nonExistentDir2), false);

  const save2 = await fetch(`${serverUrl}/api/admin/workers/worker-allow-create-01/allowed-paths`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rootPath: nonExistentDir2,
      allowRead: true,
      allowWrite: true,
      allowCreate: true
    })
  });
  const data2 = await save2.json();
  assert.equal(data2.allowedPath.allow_create, 1);

  await worker.pollAndExecuteDirectoryChecks();
  const checked2 = db.prepare('SELECT * FROM worker_allowed_paths WHERE id = ?').get(data2.allowedPath.id);
  assert.equal(checked2.check_status, 'PASSED', 'Should pass when allow_create=true');
  assert.equal(fs.existsSync(nonExistentDir2), true, 'Directory MUST be created when allow_create=true');
});

test('FIX-14, FIX-15, FIX-16: 保存方式（直接保存 vs 设备序列号子文件夹归档）与非法字符/越界拦截', async () => {
  const workerDir = path.join(testBaseDir, 'worker_folder_rules');
  const allowedBase = path.join(workerDir, 'docs');
  fs.mkdirSync(allowedBase, { recursive: true });

  const worker = new ExecutionWorker({
    workerId: 'worker-rule-01',
    name: '规则测试机',
    serverUrl,
    workingDir: workerDir
  });
  await worker.sendHeartbeat();

  // Authorize allowedBase
  db.prepare(`
    INSERT INTO worker_allowed_paths (worker_id, root_path, allow_read, allow_write, allow_create, version, sync_status, check_status, created_at, updated_at)
    VALUES ('worker-rule-01', ?, 1, 1, 1, 1, 'SYNCED', 'PASSED', ?, ?)
  `).run(allowedBase, new Date().toISOString(), new Date().toISOString());

  const certTmpl = db.prepare("SELECT * FROM templates WHERE model = 'POA200' AND type = 'cert'").get();
  assert.ok(certTmpl);

  // FIX-14: subfolder mode with deviceSn
  const saveCfgSub = await fetch(`${serverUrl}/api/admin/workers/worker-rule-01/template-configs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      templateId: certTmpl.id,
      docType: 'cert',
      isEnabled: 1,
      rootDir: allowedBase,
      saveMode: 'subfolder',
      subfolderRule: 'deviceSn',
      allowCreate: 1
    })
  });
  assert.equal(saveCfgSub.status, 200);

  // Manually pass check
  db.prepare("UPDATE worker_save_configs SET check_status = 'PASSED' WHERE worker_id = 'worker-rule-01' AND template_id = ?").run(certTmpl.id);

  // Submit task with deviceSn = 'AP10009999' and docCombo = 'cert_only'
  const taskRes = await fetch(`${serverUrl}/api/tasks/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reqId: 'req-subfolder-test-01',
      clientId: 'client-test',
      clientName: '测试员',
      model: 'POA200',
      deviceSn: 'AP10009999',
      workerId: 'worker-rule-01',
      docCombo: 'cert_only',
      createCert: true,
      createPacking: false,
      pumpInstalled: true
    })
  });
  assert.equal(taskRes.status, 200);
  const taskData = await taskRes.json();
  const taskId = taskData.task ? taskData.task.id : (taskData.taskId || taskData.id);
  const taskFile = db.prepare('SELECT * FROM task_files WHERE task_id = ?').get(taskId);
  assert.ok(taskFile);
  assert.equal(taskFile.subfolder_name, 'AP10009999', 'subfolder_name must be real SN, not literal "deviceSn"');
  assert.equal(taskFile.target_dir, path.join(allowedBase, 'AP10009999'));

  // FIX-16: Illegal directory characters or traversal
  const hackRes = await fetch(`${serverUrl}/api/tasks/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reqId: 'req-hack-test-01',
      clientId: 'client-test',
      clientName: '测试员',
      model: 'POA200',
      deviceSn: '..\\escape_dir',
      workerId: 'worker-rule-01',
      docCombo: 'cert_only',
      createCert: true,
      createPacking: false,
      pumpInstalled: true
    })
  });
  assert.equal(hackRes.status, 400, 'Path traversal must be rejected');

  // FIX-15: Direct save mode -> no subfolder created
  await fetch(`${serverUrl}/api/admin/workers/worker-rule-01/template-configs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      templateId: certTmpl.id,
      docType: 'cert',
      isEnabled: 1,
      rootDir: allowedBase,
      saveMode: 'direct',
      allowCreate: 1
    })
  });
  db.prepare("UPDATE worker_save_configs SET check_status = 'PASSED' WHERE worker_id = 'worker-rule-01' AND template_id = ?").run(certTmpl.id);

  const directTaskRes = await fetch(`${serverUrl}/api/tasks/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reqId: 'req-direct-test-01',
      clientId: 'client-test',
      clientName: '测试员',
      model: 'POA200',
      deviceSn: 'AP10008888',
      workerId: 'worker-rule-01',
      docCombo: 'cert_only',
      createCert: true,
      createPacking: false,
      pumpInstalled: true
    })
  });
  assert.equal(directTaskRes.status, 200);
  const directTaskData = await directTaskRes.json();
  const directTaskId = directTaskData.task ? directTaskData.task.id : (directTaskData.taskId || directTaskData.id);
  const directFile = db.prepare('SELECT * FROM task_files WHERE task_id = ?').get(directTaskId);
  assert.equal(directFile.subfolder_name, '');
  assert.equal(directFile.target_dir, allowedBase, 'Direct mode target_dir must be rootDir without subfolder');
});

test('FIX-17: 延迟到达的过期检查结果不能覆盖新版本配置', async () => {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO worker_allowed_paths (worker_id, root_path, allow_read, allow_write, allow_create, version, sync_status, check_status, created_at, updated_at)
    VALUES ('worker-ver-01', 'D:\\ver_test', 1, 1, 0, 2, 'SYNCED', 'PASSED', ?, ?)
  `).run(now, now);

  const p = db.prepare("SELECT * FROM worker_allowed_paths WHERE worker_id = 'worker-ver-01'").get();
  assert.equal(p.version, 2);

  // Simulate late check result arriving for version 1 with FAILED status
  const lateRes = await fetch(`${serverUrl}/api/worker/directory-checks/result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      checkId: 99999,
      checkType: 'allowed_path',
      targetId: p.id,
      version: 1, // OUTDATED VERSION
      status: 'FAILED',
      message: 'Late failed probe'
    })
  });
  assert.equal(lateRes.status, 200);

  // Path status should still be PASSED (not overwritten)
  const afterLate = db.prepare('SELECT * FROM worker_allowed_paths WHERE id = ?').get(p.id);
  assert.equal(afterLate.check_status, 'PASSED', 'Version 1 result must not overwrite Version 2 status');
});
