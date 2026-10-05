const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const testDbPath = path.resolve(__dirname, `../data/test_s01_s26_${Date.now()}.db`);
process.env.DB_PATH = testDbPath;
process.env.PORT = '3055';
process.env.NODE_ENV = 'test';

const app = require('../src/backend/server');
const db = require('../src/backend/db');
const ExecutionWorker = require('../src/worker/worker');

let server;
const serverUrl = 'http://localhost:3055';
const testBaseDir = path.resolve(__dirname, `../data/test_s01_s26_dir_${Date.now()}`);

test.before(async () => {
  if (!fs.existsSync(testBaseDir)) fs.mkdirSync(testBaseDir, { recursive: true });
  await new Promise(resolve => {
    server = app.listen(3055, () => resolve());
  });
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  try { if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath); } catch (e) {}
  try { if (fs.existsSync(testBaseDir)) fs.rmSync(testBaseDir, { recursive: true, force: true }); } catch (e) {}
});

test('S01 - S10: 传感器配置、HTML转义、非POA200参数与文案整改', async () => {
  const appJs = fs.readFileSync(path.resolve(__dirname, '../src/frontend/app.js'), 'utf-8');
  const indexHtml = fs.readFileSync(path.resolve(__dirname, '../src/frontend/index.html'), 'utf-8');

  // S01 & S08: escapeHtml function presence and usage
  assert.ok(appJs.includes('function escapeHtml('), 'app.js must define escapeHtml (S01, S08)');
  assert.ok(appJs.includes('escapeHtml(opt)'), 'Sensor options rendering must use escapeHtml (S01, S08)');

  // S10: Check labels in index.html
  assert.ok(indexHtml.includes('<label>传感器型号</label>'), 'Sensor model label must be "传感器型号" without bracket note (S10)');
  assert.ok(indexHtml.includes('<label>发货目的地</label>'), 'Shipping location label must be "发货目的地" without bracket note (S10)');
  assert.equal(indexHtml.includes('仅适用 POA200'), false, 'Must not contain old bracket note for sensor model (S10)');
  assert.equal(indexHtml.includes('仅用于文件命名'), false, 'Must not contain old bracket note for shipping location (S10)');

  // Setup worker and allowed path
  const worker = new ExecutionWorker({ workerId: 'worker-s01', name: 'S01终端', serverUrl, workingDir: testBaseDir });
  await worker.sendHeartbeat();

  db.prepare(`
    INSERT INTO worker_allowed_paths (worker_id, root_path, allow_read, allow_write, sync_status, check_status, created_at, updated_at)
    VALUES ('worker-s01', ?, 1, 1, 'SYNCED', 'PASSED', datetime('now'), datetime('now'))
  `).run(testBaseDir);

  const cert990 = db.prepare("SELECT * FROM templates WHERE model = '990' AND type = 'cert'").get();
  assert.ok(cert990);

  db.prepare(`
    INSERT INTO worker_save_configs (worker_id, template_id, doc_type, root_dir, save_mode, allow_create, is_enabled, check_status, created_at, updated_at)
    VALUES ('worker-s01', ?, 'cert', ?, 'direct', 1, 1, 'PASSED', datetime('now'), datetime('now'))
  `).run(cert990.id, testBaseDir);

  // Configure sensor options for PGA500-EX / 990
  await fetch(`${serverUrl}/api/admin/sensor-configs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: '990',
      sensor_options: 'PSR-12-223, XLT, 1X',
      default_value: 'PSR-12-223'
    })
  });

  // S03: Submit PGA500-EX / 990 with XLT
  const subRes = await fetch(`${serverUrl}/api/tasks/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reqId: 'req_s03_' + Date.now(),
      clientId: 'c1',
      clientName: '操作员',
      workerId: 'worker-s01',
      model: '990',
      docCombo: 'cert_only',
      deviceSn: 'EX10260999',
      sensorModel: 'XLT'
    })
  });
  assert.equal(subRes.status, 200, 'Submitting 990 with valid sensorModel XLT must succeed (S03)');
  const taskData = await subRes.json();
  assert.equal(taskData.task.form_data.sensorModel, 'XLT');
  assert.ok(taskData.task.files[0].official_filename.includes('-XLT'), 'Generated cert filename must contain sensorModel -XLT (S03)');

  // S23: Submitting invalid sensor model option must be rejected by backend
  const invalidRes = await fetch(`${serverUrl}/api/tasks/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reqId: 'req_s23_' + Date.now(),
      clientId: 'c1',
      clientName: '操作员',
      workerId: 'worker-s01',
      model: '990',
      docCombo: 'cert_only',
      deviceSn: 'EX10260999',
      sensorModel: 'INVALID_SENSOR'
    })
  });
  assert.equal(invalidRes.status, 400, 'Submitting unconfigured sensor model option must be rejected (S23)');
});

test('S11 - S22: 装箱清单主设备备注同步与模板规则', async () => {
  const certPoa = db.prepare("SELECT * FROM templates WHERE model = 'POA200' AND type = 'cert'").get();
  const packPoa = db.prepare("SELECT * FROM templates WHERE model = 'POA200' AND type = 'packing'").get();

  const worker = new ExecutionWorker({ workerId: 'worker-s11', name: 'S11终端', serverUrl, workingDir: testBaseDir });
  await worker.sendHeartbeat();

  db.prepare(`
    INSERT INTO worker_allowed_paths (worker_id, root_path, allow_read, allow_write, sync_status, check_status, created_at, updated_at)
    VALUES ('worker-s11', ?, 1, 1, 'SYNCED', 'PASSED', datetime('now'), datetime('now'))
  `).run(testBaseDir);

  db.prepare(`
    INSERT INTO worker_save_configs (worker_id, template_id, doc_type, root_dir, save_mode, allow_create, is_enabled, check_status, created_at, updated_at)
    VALUES ('worker-s11', ?, 'cert', ?, 'direct', 1, 1, 'PASSED', datetime('now'), datetime('now')),
           ('worker-s11', ?, 'packing', ?, 'direct', 1, 1, 'PASSED', datetime('now'), datetime('now'))
  `).run(certPoa.id, testBaseDir, packPoa.id, testBaseDir);

  // S11 & S12 & S15: Task submission with packing list and device SN
  const subResNoPump = await fetch(`${serverUrl}/api/tasks/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reqId: 'req_s11_' + Date.now(),
      clientId: 'c1',
      clientName: '操作员',
      workerId: 'worker-s11',
      model: 'POA200',
      docCombo: 'cert_and_packing',
      deviceSn: 'AP10007513',
      hasPump: false,
      packingItems: [
        { index: 1, name: '主设备', spec: 'POA200', count: 1, unit: '台', standard: '是', remark: 'SN: AP10007513', isProtected: true },
        { index: 2, name: '传感器', spec: 'PMT210SEN', count: 1, unit: '支', standard: '是', remark: 'SN: 201N200258', isProtected: true }
      ]
    })
  });
  assert.equal(subResNoPump.status, 200);
  const taskNoPump = (await subResNoPump.json()).task;
  assert.equal(taskNoPump.form_data.packingItems[0].remark, 'SN: AP10007513', 'Main device remark without pump must be SN: AP10007513 (S11)');

  const subResPump = await fetch(`${serverUrl}/api/tasks/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reqId: 'req_s12_' + Date.now(),
      clientId: 'c1',
      clientName: '操作员',
      workerId: 'worker-s11',
      model: 'POA200',
      docCombo: 'cert_and_packing',
      deviceSn: 'AP10007513',
      hasPump: true,
      packingItems: [
        { index: 1, name: '主设备', spec: 'POA200', count: 1, unit: '台', standard: '是', remark: 'SN: AP10007513带泵', isProtected: true },
        { index: 2, name: '传感器', spec: 'PMT210SEN', count: 1, unit: '支', standard: '是', remark: 'SN: 201N200258', isProtected: true }
      ]
    })
  });
  assert.equal(subResPump.status, 200);
  const taskPump = (await subResPump.json()).task;
  assert.equal(taskPump.form_data.packingItems[0].remark, 'SN: AP10007513带泵', 'Main device remark with pump must be SN: AP10007513带泵 (S12)');
});
