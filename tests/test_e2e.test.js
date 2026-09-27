const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const app = require('../src/backend/server');
const ExecutionWorker = require('../src/worker/worker');

let server;
const PORT = 3001;

test.before((done) => {
  server = app.listen(PORT, () => {
    console.log(`Test server running on port ${PORT}`);
  });
});

test.after(() => {
  if (server) server.close();
});

test('End-to-End Task Flow, Worker Execution, Preview & History (C01-C14, M01-M15, E01-E11)', async () => {
  const serverUrl = `http://localhost:${PORT}`;

  // 1. Register Client
  const clientRes = await fetch(`${serverUrl}/api/clients/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '测试员张三' })
  });
  const clientData = await clientRes.json();
  assert.strictEqual(clientData.name, '测试员张三');
  const clientId = clientData.clientId;

  // 2. Start Worker and Heartbeat
  const workerWorkingDir = path.resolve(__dirname, '../data/e2e_working_dir');
  if (!fs.existsSync(workerWorkingDir)) fs.mkdirSync(workerWorkingDir, { recursive: true });

  const worker = new ExecutionWorker({
    workerId: 'worker-e2e',
    name: 'E2E Worker PC',
    serverUrl,
    workingDir: workerWorkingDir
  });

  await worker.sendHeartbeat();

  // 3. Submit Task (POA200)
  const reqId = 'req_e2e_' + Date.now();
  const taskRes = await fetch(`${serverUrl}/api/tasks/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reqId,
      clientId,
      clientName: '测试员张三',
      workerId: 'worker-e2e',
      model: 'POA200',
      deviceSn: 'AP10007513',
      shippingLocation: '南京',
      sensorModel: 'PSR-12-223(封装）',
      sensorSn: '201N200258',
      hasPump: true,
      certDate: '2026-04-03',
      testPoints: [{ point: 1, std: '9.96(N2 balance)', act: '9.93' }],
      packingItems: [
        { index: 1, name: '主设备', spec: 'POA200', count: 1, unit: '台', standard: '是', remark: 'SN：AP10007513带泵', isProtectedMain: true },
        { index: 2, name: '传感器', spec: 'PMT210SEN', count: 1, unit: '只', standard: '是', remark: 'SN：201N200258', isProtectedSensor: true }
      ]
    })
  });

  const taskData = await taskRes.json();
  assert.ok(taskData.task);
  assert.strictEqual(taskData.task.device_sn, 'AP10007513');
  const taskId = taskData.task.id;

  // 4. Test Deduplication (R09): re-submitting same reqId
  const dupRes = await fetch(`${serverUrl}/api/tasks/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reqId,
      clientId,
      clientName: '测试员张三',
      model: 'POA200',
      deviceSn: 'AP10007513'
    })
  });
  const dupData = await dupRes.json();
  assert.strictEqual(dupData.deduplicated, true);
  assert.strictEqual(dupData.task.id, taskId);

  // 5. Worker processes pending task
  await worker.pollAndExecuteTasks();

  // 6. Verify task files returned & preview ready
  const checkRes = await fetch(`${serverUrl}/api/tasks/${taskId}`);
  const taskDetail = await checkRes.json();
  assert.ok(taskDetail.files.length >= 2);

  // 7. Check History API (R30)
  const historyRes = await fetch(`${serverUrl}/api/tasks?range=today`);
  const historyList = await historyRes.json();
  assert.ok(historyList.some(t => t.id === taskId));
});
