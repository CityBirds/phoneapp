const path = require('path');
const fs = require('fs');

// Set isolated test database path before loading backend (J15, Q04)
const testDbPath = path.resolve(__dirname, `../data/phoneapp_e2e_test_${Date.now()}.db`);
process.env.DB_PATH = testDbPath;

const test = require('node:test');
const assert = require('node:assert');
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
  try { if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath); } catch (e) {}
});

test('End-to-End Task Flow, Worker Execution, Preview & History (C01-C14, M01-M15, E01-E11)', async () => {
  const serverUrl = `http://localhost:${PORT}`;

  // 1. Register Client (C01, M01)
  const clientRes = await fetch(`${serverUrl}/api/clients/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '测试员张三' })
  });
  const clientData = await clientRes.json();
  assert.strictEqual(clientData.name, '测试员张三');
  const clientId = clientData.clientId;

  // Test Renaming Client by Coordinator Admin (C01, R01)
  const renameRes = await fetch(`${serverUrl}/api/clients/${clientId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '产线1号-李四' })
  });
  const renameData = await renameRes.json();
  assert.strictEqual(renameData.success, true);
  assert.strictEqual(renameData.name, '产线1号-李四');

  // Verify Single Client GET API
  const getClientRes = await fetch(`${serverUrl}/api/clients/${clientId}`);
  const getClientData = await getClientRes.json();
  assert.strictEqual(getClientData.name, '产线1号-李四');

  // 2. Start Multiple Workers and Verify Heartbeat & Printer Detection (C02, R03, R04)
  const worker1Dir = path.resolve(__dirname, '../data/e2e_worker_1');
  const worker2Dir = path.resolve(__dirname, '../data/e2e_worker_2');
  [worker1Dir, worker2Dir].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

  const worker1 = new ExecutionWorker({
    workerId: 'worker-pc01',
    name: '车间装配电脑-01',
    serverUrl,
    workingDir: worker1Dir,
    allowedPrinters: ['EPSON L3258', 'Microsoft Print to PDF']
  });

  const worker2 = new ExecutionWorker({
    workerId: 'worker-pc02',
    name: '检验台电脑-02',
    serverUrl,
    workingDir: worker2Dir,
    allowedPrinters: ['EPSON L3258', 'WPS PDF'] // Shares 'EPSON L3258'
  });

  await worker1.sendHeartbeat();
  await worker2.sendHeartbeat();

  // Verify Worker Monitoring & Printer Sharing Detection
  const workersRes = await fetch(`${serverUrl}/api/workers`);
  const workersList = await workersRes.json();
  assert.ok(workersList.length >= 2);
  const pc01 = workersList.find(w => w.id === 'worker-pc01');
  assert.ok(pc01);
  assert.strictEqual(pc01.status, 'ONLINE');
  
  // Verify EPSON L3258 is detected as shared across multiple workers (R04)
  const epsonDetail = pc01.printerDetails.find(p => p.name === 'EPSON L3258');
  assert.ok(epsonDetail);
  assert.strictEqual(epsonDetail.isShared, true);

  // 3. User selects worker-pc01 and submits Task (POA200)
  const reqId = 'req_e2e_' + Date.now();
  const taskRes = await fetch(`${serverUrl}/api/tasks/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reqId,
      clientId,
      clientName: '产线1号-李四',
      workerId: 'worker-pc01',
      model: 'POA200',
      deviceSn: 'AP10007513',
      shippingLocation: '南京',
      sensorModel: 'PSR-12-223(封装）',
      sensorSn: '201N200258',
      hasPump: true,
      certDate: '2026-04-03',
      testPoints: [{ point: 1, std: '9.96(N2 balance)', act: '9.93' }],
      packingItems: [
        { index: 1, name: '主设备', spec: 'POA200', count: 1, unit: '台', standard: '是', remark: 'SN: AP10007513带泵', isProtectedMain: true },
        { index: 2, name: '传感器', spec: 'PMT210SEN', count: 1, unit: '支', standard: '是', remark: 'SN: 201N200258', isProtectedSensor: true }
      ]
    })
  });

  const taskData = await taskRes.json();
  assert.ok(taskData.task);
  assert.strictEqual(taskData.task.device_sn, 'AP10007513');
  assert.strictEqual(taskData.task.worker_id, 'worker-pc01');
  const taskId = taskData.task.id;

  // 4. Test Deduplication (R09)
  const dupRes = await fetch(`${serverUrl}/api/tasks/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reqId,
      clientId,
      clientName: '产线1号-李四',
      workerId: 'worker-pc01',
      model: 'POA200',
      deviceSn: 'AP10007513'
    })
  });
  const dupData = await dupRes.json();
  assert.strictEqual(dupData.deduplicated, true);
  assert.strictEqual(dupData.task.id, taskId);

  // 5. Worker-pc01 processes pending task
  await worker1.pollAndExecuteTasks();

  // 6. Verify task files returned & instant preview ready
  const checkRes = await fetch(`${serverUrl}/api/tasks/${taskId}`);
  const taskDetail = await checkRes.json();
  assert.ok(taskDetail.files.length >= 2);
  const certFile = taskDetail.files.find(f => f.file_type === 'cert');
  assert.ok(certFile);
  assert.strictEqual(certFile.status, 'PREVIEW_READY');
  assert.ok(certFile.preview_images.length > 0);
  assert.ok(certFile.preview_images[0].endsWith('.svg'));

  // 7. Verify Official Word Document Download Endpoint
  const downloadRes = await fetch(`${serverUrl}/api/tasks/${taskId}/files/cert/download`);
  assert.strictEqual(downloadRes.status, 200);

  // 8. Check History API (R30) - ensure preview images are present and retrievable after refresh
  const historyRes = await fetch(`${serverUrl}/api/tasks?range=today`);
  const historyList = await historyRes.json();
  const histItem = historyList.find(t => t.id === taskId);
  assert.ok(histItem);
  assert.ok(histItem.files.every(f => f.preview_images && f.preview_images.length > 0));

  // 9. Verify Template Analyze & Field Matching Assistance API (C04, C05, T03)
  const analyzeRes = await fetch(`${serverUrl}/api/templates/tmpl_poa200_cert/analyze`);
  assert.strictEqual(analyzeRes.status, 200);
  const analyzeData = await analyzeRes.json();
  assert.ok(analyzeData.template);
  assert.ok(analyzeData.matchResults);
  assert.ok(analyzeData.matchResults['Inst. SN.']);
});
