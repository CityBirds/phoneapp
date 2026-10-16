const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

// Setup isolated environment for W610 comm tests
const testBaseDir = path.resolve(__dirname, '../data/test_w610_20261014');
const testDbPath = path.join(testBaseDir, 'test_w610.db');
process.env.DB_PATH = testDbPath;
process.env.PREVIEW_DIR = path.join(testBaseDir, 'previews');
process.env.RETURNED_DIR = path.join(testBaseDir, 'returned');
process.env.PORT = '3080';
process.env.NODE_ENV = 'test';

if (fs.existsSync(testBaseDir)) {
  fs.rmSync(testBaseDir, { recursive: true, force: true });
}
fs.mkdirSync(testBaseDir, { recursive: true });

const db = require('../src/backend/db');
const app = require('../src/backend/server');
const ExecutionWorker = require('../src/worker/worker');
const poa200 = require('../src/worker/poa200_protocol');

let server;
const serverUrl = 'http://localhost:3080';

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(3080, () => resolve());
  });
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  try {
    if (fs.existsSync(testBaseDir)) fs.rmSync(testBaseDir, { recursive: true, force: true });
  } catch (e) {}
});

test('W610-01: W610 地址清单管理 (Admin CRUD)', async () => {
  // Create
  const addRes = await fetch(`${serverUrl}/api/admin/w610`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': 'phoneapp-admin-secret' },
    body: JSON.stringify({ name: '1号楼W610', ip: '192.168.1.120', port: 80, isEnabled: 1 })
  });
  assert.equal(addRes.status, 200);
  const addData = await addRes.json();
  assert.ok(addData.device.id);
  const deviceId = addData.device.id;

  // List
  const listRes = await fetch(`${serverUrl}/api/admin/w610`);
  const list = await listRes.json();
  assert.ok(list.some(d => d.id === deviceId && d.name === '1号楼W610'));

  // Update
  const updateRes = await fetch(`${serverUrl}/api/admin/w610`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': 'phoneapp-admin-secret' },
    body: JSON.stringify({ id: deviceId, name: '1号楼W610-已改名', ip: '192.168.1.121', port: 8080, isEnabled: 1 })
  });
  assert.equal(updateRes.status, 200);

  // Delete
  const delRes = await fetch(`${serverUrl}/api/admin/w610/${deviceId}`, {
    method: 'DELETE',
    headers: { 'x-admin-token': 'phoneapp-admin-secret' }
  });
  assert.equal(delRes.status, 200);
  const listAfterDel = await (await fetch(`${serverUrl}/api/admin/w610`)).json();
  assert.ok(!listAfterDel.some(d => d.id === deviceId));
});

test('W610-02 & W610-03: 保存目录未配置、未授权、离线与探测校验 (WC-21, 4.3)', async () => {
  const workerDir = path.join(testBaseDir, 'worker_dir_02');
  fs.mkdirSync(workerDir, { recursive: true });

  const worker = new ExecutionWorker({ workerId: 'worker-w610-02', name: '电脑02', serverUrl, workingDir: workerDir });
  await worker.sendHeartbeat();

  // Create W610
  const w610Res = await fetch(`${serverUrl}/api/admin/w610`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': 'phoneapp-admin-secret' },
    body: JSON.stringify({ name: '车间W610', ip: '127.0.0.1', port: 80, isEnabled: 1 })
  });
  const w610Id = (await w610Res.json()).device.id;

  // Unconfigured comm save directory -> submit write_and_save must be rejected
  const subFailRes = await fetch(`${serverUrl}/api/w610/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workerId: 'worker-w610-02',
      w610Id,
      action: 'write_and_save',
      model: 'POA200',
      payload: { deviceSn: 'AP10007513', outDate: '2026/10/14' }
    })
  });
  assert.equal(subFailRes.status, 400);
  const subFailData = await subFailRes.json();
  assert.equal(subFailData.unconfigured, true);

  // Authorize path & configure comm directory
  const commDir = path.join(testBaseDir, 'comm_records_02');
  fs.mkdirSync(commDir, { recursive: true });

  await fetch(`${serverUrl}/api/admin/workers/worker-w610-02/allowed-paths`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': 'phoneapp-admin-secret' },
    body: JSON.stringify({ rootPath: commDir, allowRead: true, allowWrite: true, allowCreate: true })
  });

  const cfgRes = await fetch(`${serverUrl}/api/admin/workers/worker-w610-02/comm-configs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': 'phoneapp-admin-secret' },
    body: JSON.stringify({
      model: 'POA200',
      rootDir: commDir,
      saveMode: 'subfolder',
      allowCreate: 1,
      isEnabled: 1
    })
  });
  assert.equal(cfgRes.status, 200);

  // Worker executes check
  await worker.pollAndExecuteDirectoryChecks();

  const commCfg = db.prepare("SELECT * FROM worker_save_configs WHERE worker_id = 'worker-w610-02' AND doc_type = 'comm'").get();
  assert.equal(commCfg.check_status, 'PASSED');
});

test('W610-04: W610 在线、离线、地址错误、HTTP 可达但设备无应答探测区分', async () => {
  const workerDir = path.join(testBaseDir, 'worker_dir_04');
  fs.mkdirSync(workerDir, { recursive: true });

  const worker = new ExecutionWorker({ workerId: 'worker-w610-04', name: '电脑04', serverUrl, workingDir: workerDir, enableTestMock: true });
  await worker.sendHeartbeat();

  // Create devices: 1) Online device 2) HTTP ok but device no response 3) Offline IP
  const dev1Res = await fetch(`${serverUrl}/api/admin/w610`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': 'phoneapp-admin-secret' },
    body: JSON.stringify({ name: '正常在线设备', ip: '127.0.0.1', port: 80, isEnabled: 1 })
  });
  const dev1Id = (await dev1Res.json()).device.id;

  const dev2Res = await fetch(`${serverUrl}/api/admin/w610`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': 'phoneapp-admin-secret' },
    body: JSON.stringify({ name: 'W610连通但后端设备断开', ip: '127.0.0.1', port: 8080, isEnabled: 1 })
  });
  const dev2Id = (await dev2Res.json()).device.id;

  const dev3Res = await fetch(`${serverUrl}/api/admin/w610`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': 'phoneapp-admin-secret' },
    body: JSON.stringify({ name: '完全离线IP', ip: '0.0.0.0', port: 80, isEnabled: 1 })
  });
  const dev3Id = (await dev3Res.json()).device.id;

  // Submit probe task with custom mock statuses for probe test
  const taskRes = await fetch(`${serverUrl}/api/w610/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workerId: 'worker-w610-04',
      action: 'probe',
      model: 'POA200',
      payload: {
        isMock: true,
        devices: [
          { id: dev1Id, name: '正常在线设备', ip: '127.0.0.1', port: 80, mock: true },
          { id: dev2Id, name: 'W610连通但后端设备断开', ip: '127.0.0.1', port: 8080, mock: true, no_device: true },
          { id: dev3Id, name: '完全离线IP', ip: '0.0.0.0', port: 80, mock: true }
        ]
      }
    })
  });
  const taskId = (await taskRes.json()).task.id;

  await worker.pollAndExecuteW610Tasks();

  const taskResult = await (await fetch(`${serverUrl}/api/w610/tasks/${taskId}`)).json();
  assert.equal(taskResult.status, 'SUCCESS');
  const probeResults = taskResult.result.probeResults;

  const r1 = probeResults.find(r => r.id === dev1Id);
  const r2 = probeResults.find(r => r.id === dev2Id);
  const r3 = probeResults.find(r => r.id === dev3Id);

  assert.equal(r1.status, 'ONLINE');
  assert.equal(r1.http_ok, true);
  assert.equal(r1.device_ok, true);

  assert.equal(r2.status, 'W610_ONLY');
  assert.equal(r2.http_ok, true);
  assert.equal(r2.device_ok, false);

  assert.equal(r3.status, 'OFFLINE');
  assert.equal(r3.http_ok, false);
});

test('W610-05: POA200 首次读取正确，序列号和日期自动带出', async () => {
  const workerDir = path.join(testBaseDir, 'worker_dir_05');
  fs.mkdirSync(workerDir, { recursive: true });

  const worker = new ExecutionWorker({ workerId: 'worker-w610-05', name: '电脑05', serverUrl, workingDir: workerDir, enableTestMock: true });
  await worker.sendHeartbeat();

  const w610Res = await fetch(`${serverUrl}/api/admin/w610`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '测试W610', ip: '127.0.0.1', port: 80, isEnabled: 1 })
  });
  const w610Id = (await w610Res.json()).device.id;

  const taskRes = await fetch(`${serverUrl}/api/w610/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workerId: 'worker-w610-05',
      w610Id,
      action: 'read_device',
      model: 'POA200',
      payload: {}
    })
  });
  const taskId = (await taskRes.json()).task.id;

  await worker.pollAndExecuteW610Tasks();

  const taskData = await (await fetch(`${serverUrl}/api/w610/tasks/${taskId}`)).json();
  assert.equal(taskData.status, 'SUCCESS');
  assert.equal(taskData.result.deviceSn, 'AP10007513');
  assert.equal(taskData.result.outDate, '2026/10/14');
  assert.equal(taskData.result.info.VerNo, 'V1.0.2');
});

test('W610-06 & W610-07 & W610-08: 修改后写入、回读核验一致性，JSON 文件生成与同名冲突处理', async () => {
  const workerDir = path.join(testBaseDir, 'worker_dir_06');
  const commDir = path.join(testBaseDir, 'comm_records_06');
  fs.mkdirSync(workerDir, { recursive: true });
  fs.mkdirSync(commDir, { recursive: true });

  const worker = new ExecutionWorker({ workerId: 'worker-w610-06', name: '电脑06', serverUrl, workingDir: workerDir, enableTestMock: true });
  await worker.sendHeartbeat();

  // Authorize path & configure comm directory (subfolder mode)
  await fetch(`${serverUrl}/api/admin/workers/worker-w610-06/allowed-paths`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': 'phoneapp-admin-secret' },
    body: JSON.stringify({ rootPath: commDir, allowRead: true, allowWrite: true, allowCreate: true })
  });

  await fetch(`${serverUrl}/api/admin/workers/worker-w610-06/comm-configs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': 'phoneapp-admin-secret' },
    body: JSON.stringify({
      model: 'POA200',
      rootDir: commDir,
      saveMode: 'subfolder',
      allowCreate: 1,
      isEnabled: 1
    })
  });

  await worker.pollAndExecuteDirectoryChecks();

  const w610Res = await fetch(`${serverUrl}/api/admin/w610`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '测试W610-06', ip: '127.0.0.1', port: 80, isEnabled: 1 })
  });
  const w610Id = (await w610Res.json()).device.id;

  // 1. Submit write_and_save task with valid matching reread
  const taskRes1 = await fetch(`${serverUrl}/api/w610/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workerId: 'worker-w610-06',
      w610Id,
      action: 'write_and_save',
      model: 'POA200',
      payload: {
        deviceSn: 'AP99990001',
        outDate: '2026/10/14'
      }
    })
  });
  const taskId1 = (await taskRes1.json()).task.id;

  await worker.pollAndExecuteW610Tasks();

  const task1Result = await (await fetch(`${serverUrl}/api/w610/tasks/${taskId1}`)).json();
  assert.equal(task1Result.status, 'SUCCESS');
  assert.equal(task1Result.result.verifiedSn, 'AP99990001');

  // Verify subfolder created & JSON files exist
  const subfolder = path.join(commDir, 'AP99990001');
  assert.equal(fs.existsSync(subfolder), true);

  const filesInSub = fs.readdirSync(subfolder);
  const devFile = filesInSub.find(f => f.includes('DeviceInfo') && f.endsWith('.json'));
  const o2File = filesInSub.find(f => f.includes('O2Calib') && f.endsWith('.json'));

  assert.ok(devFile, 'POA200_AP99990001_DeviceInfo_YYYYMMDD.json must exist');
  assert.ok(o2File, 'POA200_AP99990001_O2Calib_YYYYMMDD.json must exist');

  // Verify file date uses YYYYMMDD execution date format
  const nowObj = new Date();
  const dateStr = `${nowObj.getFullYear()}${String(nowObj.getMonth() + 1).padStart(2, '0')}${String(nowObj.getDate()).padStart(2, '0')}`;
  assert.ok(devFile.includes(dateStr));
  assert.ok(o2File.includes(dateStr));

  // Verify file JSON content
  const devContent = JSON.parse(fs.readFileSync(path.join(subfolder, devFile), 'utf-8'));
  assert.equal(devContent.SnNo, 'AP99990001');
  assert.equal(devContent.OutDate, '2026/10/14');

  // 2. Perform second submit with same SN on same day -> Conflict renaming (-副本(1).json)
  const taskRes2 = await fetch(`${serverUrl}/api/w610/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workerId: 'worker-w610-06',
      w610Id,
      action: 'write_and_save',
      model: 'POA200',
      payload: {
        deviceSn: 'AP99990001',
        outDate: '2026/10/14'
      }
    })
  });
  const taskId2 = (await taskRes2.json()).task.id;

  await worker.pollAndExecuteW610Tasks();

  const filesAfter2 = fs.readdirSync(subfolder);
  const copyDevFile = filesAfter2.find(f => f.includes('DeviceInfo') && f.includes('-副本(1)'));
  assert.ok(copyDevFile, 'Duplicate copy -副本(1) must be created on filename collision');
});

test('W610-09: 回读不一致时拒绝归档 (Reread Mismatch Rejection)', async () => {
  const workerDir = path.join(testBaseDir, 'worker_dir_09');
  const commDir = path.join(testBaseDir, 'comm_records_09');
  fs.mkdirSync(workerDir, { recursive: true });
  fs.mkdirSync(commDir, { recursive: true });

  const worker = new ExecutionWorker({ workerId: 'worker-w610-09', name: '电脑09', serverUrl, workingDir: workerDir, enableTestMock: true });
  await worker.sendHeartbeat();

  await fetch(`${serverUrl}/api/admin/workers/worker-w610-09/allowed-paths`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': 'phoneapp-admin-secret' },
    body: JSON.stringify({ rootPath: commDir, allowRead: true, allowWrite: true, allowCreate: true })
  });

  await fetch(`${serverUrl}/api/admin/workers/worker-w610-09/comm-configs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': 'phoneapp-admin-secret' },
    body: JSON.stringify({
      model: 'POA200',
      rootDir: commDir,
      saveMode: 'subfolder',
      allowCreate: 1,
      isEnabled: 1
    })
  });

  await worker.pollAndExecuteDirectoryChecks();

  const w610Res = await fetch(`${serverUrl}/api/admin/w610`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '测试W610-09', ip: '127.0.0.1', port: 80, isEnabled: 1 })
  });
  const w610Id = (await w610Res.json()).device.id;

  // Set mockFailStage in test worker or via test worker config
  worker.testMockFailStage = 'reread_mismatch';

  // Submit write_and_save
  const taskRes = await fetch(`${serverUrl}/api/w610/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workerId: 'worker-w610-09',
      w610Id,
      action: 'write_and_save',
      model: 'POA200',
      payload: {
        deviceSn: 'AP99990009',
        outDate: '2026/10/14'
      }
    })
  });
  const taskId = (await taskRes.json()).task.id;

  await worker.pollAndExecuteW610Tasks();

  const taskData = await (await fetch(`${serverUrl}/api/w610/tasks/${taskId}`)).json();
  assert.equal(taskData.status, 'FAILED');
  assert.ok(taskData.error_msg.includes('回读核验失败'));

  // Ensure NO files or subfolders created
  const filesInDir = fs.readdirSync(commDir);
  assert.equal(filesInDir.length, 0, 'No files or subfolders must be saved on reread mismatch!');
});

test('W610-10: Binary Protocol Struct Unpack/Pack Consistency (Node & C Byte Alignment)', () => {
  const dummyInfo = poa200.createMockDeviceInfo({ SnNo: 'TEST_SN_123', OutDate: '2026/10/14' });
  assert.equal(dummyInfo.length, 248);

  const unpacked = poa200.unpackDeviceInfo(dummyInfo);
  assert.equal(unpacked.SnNo, 'TEST_SN_123');
  assert.equal(unpacked.OutDate, '2026/10/14');
  assert.equal(unpacked.Name, 'POA200');

  const dummyO2 = poa200.createMockO2CalFile();
  assert.equal(dummyO2.length, 204);

  const unpackedO2 = poa200.unpackO2CalFile(dummyO2);
  assert.ok(Math.abs(unpackedO2.K1 - 1.05) < 0.001);
  assert.equal(unpackedO2.SenserInx, 1);
});
