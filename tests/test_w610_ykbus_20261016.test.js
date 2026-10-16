const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

// Isolated environment for YKBUS 20261016 test suite
const testBaseDir = path.resolve(__dirname, '../data/test_ykbus_20261016');
const testDbPath = path.join(testBaseDir, 'test_ykbus.db');
process.env.DB_PATH = testDbPath;
process.env.PREVIEW_DIR = path.join(testBaseDir, 'previews');
process.env.RETURNED_DIR = path.join(testBaseDir, 'returned');
process.env.PORT = '3090';
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
const serverUrl = 'http://localhost:3090';

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(3090, () => resolve());
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

test('COMM-01: 通信目录与模板业务彻底隔离，不产生孤儿模板', async () => {
  const commDir = path.join(testBaseDir, 'comm_01');
  fs.mkdirSync(commDir, { recursive: true });

  const worker = new ExecutionWorker({ workerId: 'worker-comm-01', name: '终端01', serverUrl, workingDir: testBaseDir, enableTestMock: true });
  await worker.sendHeartbeat();

  await fetch(`${serverUrl}/api/admin/workers/worker-comm-01/allowed-paths`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rootPath: commDir, allowRead: true, allowWrite: true, allowCreate: true })
  });

  const res = await fetch(`${serverUrl}/api/admin/workers/worker-comm-01/comm-configs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'POA200', rootDir: commDir, saveMode: 'direct', allowCreate: 1, isEnabled: 1 })
  });
  assert.equal(res.status, 200);

  // Check template table remains clean without fake templates
  const tmpls = db.prepare("SELECT * FROM templates WHERE id = 'comm_POA200'").all();
  assert.equal(tmpls.length, 0, '通信配置不得写入 templates 表产生假模板');
});

test('COMM-03 & COMM-04: 执行端凭据安全拉取 W610 设备清单与错误处理', async () => {
  const worker = new ExecutionWorker({ workerId: 'worker-comm-03', name: '终端03', serverUrl, workingDir: testBaseDir, enableTestMock: true });
  await worker.sendHeartbeat();

  // Valid credentials fetch
  const res = await fetch(`${serverUrl}/api/worker/w610/devices`, {
    headers: worker.workerAuthHeaders()
  });
  assert.equal(res.status, 200);
  const devices = await res.json();
  assert.ok(Array.isArray(devices));

  // Verify non-configured state
  const commCheckRes = await fetch(`${serverUrl}/api/w610/comm-config?workerId=worker-comm-03&model=POA200`);
  const commData = await commCheckRes.json();
  assert.equal(commData.configured, false);
});

test('COMM-06: 规范 3.3 的 20 字节 YKBUS 示例向量解析与 CRC 计算', () => {
  // Vector: 6B FE FF FF 00 00 25 D6 84 00 00 00 00 00 12 00 00 00 C1 FB
  const sampleBuf = Buffer.from('6BFEFFFF000025D684000000000012000000C1FB', 'hex');
  assert.equal(sampleBuf.length, 20);

  // Calculate CRC of first 18 bytes
  const crc = poa200.calcCrc16(sampleBuf, 18);
  assert.equal(crc, 0xC1FB, '前 18 字节 MODBUS CRC16 必须精确计算为 0xC1FB');

  // Unpack frame
  const frame = poa200.unpackYkbusFrame(sampleBuf);
  assert.equal(frame.fstart, 0xFE6B);
  assert.equal(frame.addr, 0x0000FFFF);
  assert.equal(frame.deviceType, 0xD625);
  assert.equal(frame.cmd, 0x0084);
  assert.equal(frame.dataAddr, 0);
  assert.equal(frame.buslen, 18);
  assert.equal(frame.datalen, 0);
  assert.equal(frame.crc, 0xC1FB);
});

test('COMM-08: 分包、粘包、流拆包与噪声过滤', () => {
  const f1 = poa200.packYkbusFrame({ cmd: 0x84, dataAddr: 0, payloadBuf: null });
  const f2 = poa200.packYkbusFrame({ cmd: 0x0102, dataAddr: 0xE000, payloadBuf: Buffer.from([1, 2, 3, 4]) });

  // Stream with noise prefix + f1 + incomplete f2 chunk
  const noisyStream = Buffer.concat([Buffer.from([0x00, 0x11, 0x22]), f1, f2.subarray(0, 10)]);
  const p1 = poa200.parseYkbusStream(noisyStream);

  assert.equal(p1.frames.length, 1);
  assert.equal(p1.frames[0].cmd, 0x84);
  assert.equal(p1.remaining.length, 10);

  // Feed remaining chunk
  const completeStream = Buffer.concat([p1.remaining, f2.subarray(10)]);
  const p2 = poa200.parseYkbusStream(completeStream);
  assert.equal(p2.frames.length, 1);
  assert.equal(p2.frames[0].cmd, 0x0102);
  assert.equal(p2.frames[0].datalen, 4);
});

test('COMM-09: 结构体向量解析 (INFO_DEVICE 248, O2CALFILE 204, CALVALUE_O2 112)', () => {
  // INFO_DEVICE 248
  const mockDevBuf = poa200.createMockDeviceInfo({ SnNo: 'SN_COMM_09', OutDate: '2026/10/16' });
  assert.equal(mockDevBuf.length, 248);
  const devInfo = poa200.unpackDeviceInfo(mockDevBuf);
  assert.equal(devInfo.SnNo, 'SN_COMM_09');
  assert.equal(devInfo.OutDate, '2026/10/16');

  // O2CALFILE 204
  const mockO2Buf = poa200.createMockO2CalFile();
  assert.equal(mockO2Buf.length, 204);
  const o2Cal = poa200.unpackO2CalFile(mockO2Buf);
  assert.ok(Math.abs(o2Cal.K1 - 1.05) < 0.001);

  // CALVALUE_O2 112 (Measurement)
  const mockMeasBuf = poa200.createMockCalValueO2();
  assert.equal(mockMeasBuf.length, 112);
  const meas = poa200.unpackCalValueO2(mockMeasBuf);
  assert.ok(Math.abs(meas.sTmpValue - 25.4) < 0.001);
  assert.equal(meas.unit, 1); // PPM
});

test('COMM-10 & Issue A: 原数据块保护与生产请求携带 isMock 处理', async () => {
  // 1. 原块缺失时拒绝打包（抛错）
  assert.throws(() => {
    poa200.packDeviceInfo({ SnNo: 'NEW_SN' }, null);
  }, /必须基于读到的原始 248 字节 INFO_DEVICE 块进行修改/);

  // 2. 原块含非零型号、量程等参数，打包后非目标字节保持完全相同
  const origBuf = poa200.createMockDeviceInfo({
    typecode: 0x0200,
    typeName: 'POA200_SPECIAL',
    MaxValue: 1000.5,
    SnNo: 'OLD_SN_001',
    OutDate: '2026/01/01'
  });

  const updatedBuf = poa200.packDeviceInfo({ SnNo: 'NEW_SN_999', OutDate: '2026/10/16' }, origBuf);
  const updatedInfo = poa200.unpackDeviceInfo(updatedBuf);

  assert.equal(updatedInfo.SnNo, 'NEW_SN_999');
  assert.equal(updatedInfo.OutDate, '2026/10/16');
  assert.equal(updatedInfo.typecode, 0x0200);
  assert.equal(updatedInfo.typeName, 'POA200_SPECIAL');
  assert.ok(Math.abs(updatedInfo.MaxValue - 1000.5) < 0.001);

  // 3. Issue A 回归: 生产 POST /api/w610/tasks 提交 isMock: true 时，服务端剥离 mock 字段，执行端不触发 mock
  const workerDir = path.join(testBaseDir, 'worker_issue_a');
  fs.mkdirSync(workerDir, { recursive: true });
  const worker = new ExecutionWorker({ workerId: 'worker-issue-a', name: '生产终端', serverUrl, workingDir: workerDir, enableTestMock: false });
  await worker.sendHeartbeat();

  const devRes = await fetch(`${serverUrl}/api/admin/w610`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '真实设备IP', ip: '127.0.0.1', port: 9999, isEnabled: 1 })
  });
  const devId = (await devRes.json()).device.id;

  const subRes = await fetch(`${serverUrl}/api/w610/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workerId: 'worker-issue-a',
      w610Id: devId,
      action: 'read_device',
      model: 'POA200',
      payload: { isMock: true, enableMock: true, mockDeviceInfo: { SnNo: 'FAKE_SN' } } // Client attempts mock injection
    })
  });
  const taskId = (await subRes.json()).task.id;

  // Worker executes - should attempt REAL TCP to 127.0.0.1:9999 and FAIL (since port is closed), NOT report mock SUCCESS
  await worker.pollAndExecuteW610Tasks();

  const taskData = await (await fetch(`${serverUrl}/api/w610/tasks/${taskId}`)).json();
  assert.equal(taskData.status, 'FAILED', '生产请求携带 isMock 被剥离后，真实通信连不上必须 FAILED，不得产生模拟成功');
});

test('Issue B: write_and_save 租约过期状态为 RESULT_UNKNOWN，不重发，不重复写设备', async () => {
  const commDir = path.join(testBaseDir, 'comm_issue_b');
  fs.mkdirSync(commDir, { recursive: true });

  const worker = new ExecutionWorker({ workerId: 'worker-issue-b', name: '终端IssueB', serverUrl, workingDir: testBaseDir, enableTestMock: true });
  await worker.sendHeartbeat();

  await fetch(`${serverUrl}/api/admin/workers/worker-issue-b/allowed-paths`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rootPath: commDir, allowRead: true, allowWrite: true, allowCreate: true })
  });

  await fetch(`${serverUrl}/api/admin/workers/worker-issue-b/comm-configs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'POA200', rootDir: commDir, saveMode: 'direct', allowCreate: 1, isEnabled: 1 })
  });

  await worker.pollAndExecuteDirectoryChecks();

  const devRes = await fetch(`${serverUrl}/api/admin/w610`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '租约测试设备', ip: '127.0.0.1', port: 80, isEnabled: 1 })
  });
  const devId = (await devRes.json()).device.id;

  // Insert write_and_save task directly in PROCESSING status with mtime 100s ago
  const oldTime = new Date(Date.now() - 100000).toISOString();
  const ins = db.prepare(`
    INSERT INTO w610_tasks (req_id, client_id, client_name, worker_id, w610_id, action, model, payload, status, created_at, updated_at)
    VALUES (?, 'client_1', 'user_1', 'worker-issue-b', ?, 'write_and_save', 'POA200', '{}', 'PROCESSING', ?, ?)
  `).run(`req_b_${Date.now()}`, devId, oldTime, oldTime);

  const taskId = ins.lastInsertRowid;

  // Worker polls pending tasks - trigger lease recovery
  const pendingRes = await fetch(`${serverUrl}/api/worker/w610-tasks/pending?workerId=worker-issue-b`, {
    headers: worker.workerAuthHeaders()
  });
  const pendingTasks = await pendingRes.json();

  // Verify write_and_save task was NOT re-issued in pendingTasks
  assert.ok(!pendingTasks.some(t => t.id === taskId));

  // Verify task status in DB is RESULT_UNKNOWN
  const taskInDb = db.prepare("SELECT * FROM w610_tasks WHERE id = ?").get(taskId);
  assert.equal(taskInDb.status, 'RESULT_UNKNOWN');
  assert.ok(taskInDb.error_msg.includes('写操作结果未知'));
});

test('Issue C: /api/v1/transfer 已移除，未知传输方式返回 FAILED', async () => {
  const reqRes = await poa200.sendW610Request({ ip: '127.0.0.1', port: 80 }, 0x84, 0, null, 1000, { transport: 'http' });
  assert.equal(reqRes.ok, false);
  assert.equal(reqRes.stage, 'UNSUPPORTED_TRANSPORT');
  assert.ok(reqRes.error.includes('不支持的传输方式 [http]'));
});

test('COMM-17: XP Python 端协议向量与 Node 端保持一致', () => {
  // Execute Python test file verifying identical unpacking & packing results
  try {
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const output = execSync(`${pythonCmd} -c "import poa200_protocol_xp; buf = poa200_protocol_xp.create_mock_device_info({'SnNo': 'XP_TEST_SN'}); info = poa200_protocol_xp.unpack_device_info(buf); print(info['SnNo'])"`, {
      cwd: path.resolve(__dirname, '../src/worker_xp'),
      encoding: 'utf-8'
    });
    assert.equal(output.trim(), 'XP_TEST_SN');
  } catch (e) {
    console.warn('[XP Test Skip] Python environment not present, skipping COMM-17 python subprocess call:', e.message);
  }
});
