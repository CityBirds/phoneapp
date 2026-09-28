const path = require('path');
const fs = require('fs');

const testDbPath = path.resolve(__dirname, `../data/phoneapp_remediation_test_${Date.now()}.db`);
process.env.DB_PATH = testDbPath;

const test = require('node:test');
const assert = require('node:assert');
const app = require('../src/backend/server');
const { isLocalhostRequest } = require('../src/backend/server');
const ExecutionWorker = require('../src/worker/worker');
const { generateWordDocument } = require('../src/worker/word_engine');
const { findFieldCandidates } = require('../src/common/matcher');
const db = require('../src/backend/db');

let server;
const PORT = 3002;

test.before((done) => {
  server = app.listen(PORT, () => {
    console.log(`Remediation test server running on port ${PORT}`);
  });
});

test.after(() => {
  if (server) server.close();
  try { if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath); } catch (e) {}
});

test('J01 / Q01-Q03: Active Worker Filtering and Offline Task Submission Rejection', async () => {
  const serverUrl = `http://localhost:${PORT}`;

  // Insert worker with expired heartbeat (> 15 seconds ago) into DB
  const expiredTime = new Date(Date.now() - 30000).toISOString();
  db.prepare(`
    INSERT INTO workers (id, name, ip, status, working_dir, printers, last_heartbeat)
    VALUES (?, ?, ?, 'ONLINE', ?, '[]', ?)
  `).run('worker-stale', '离线终端-01', '127.0.0.1', 'D:\\docs', expiredTime);

  // Fetch online workers only
  const res = await fetch(`${serverUrl}/api/workers`);
  const onlineWorkers = await res.json();
  const foundStale = onlineWorkers.find(w => w.id === 'worker-stale');
  assert.strictEqual(foundStale, undefined, 'Expired worker must not appear in active workers list');

  // Submit task targeting offline worker must be rejected (Q03)
  const submitRes = await fetch(`${serverUrl}/api/tasks/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reqId: 'req_offline_' + Date.now(),
      clientId: 'c1',
      clientName: '李四',
      workerId: 'worker-stale',
      model: 'POA200',
      deviceSn: '00001234'
    })
  });

  assert.strictEqual(submitRes.status, 400);
  const submitData = await submitRes.json();
  assert.ok(submitData.error.includes('不在线或心跳超时'));
});

test('J05 / Q12-Q13: Conflicting Device SN Rejection & Leading Zeros Preservation', async () => {
  const serverUrl = `http://localhost:${PORT}`;

  // Register online worker
  await fetch(`${serverUrl}/api/workers/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workerId: 'worker-online-01',
      name: '在线终端-01'
    })
  });

  // Submit conflicting SN (top-level deviceSn = "00001234" vs main item remark = "SN: 999999")
  const conflictRes = await fetch(`${serverUrl}/api/tasks/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reqId: 'req_conflict_' + Date.now(),
      clientId: 'c1',
      clientName: '李四',
      workerId: 'worker-online-01',
      model: 'POA200',
      deviceSn: '00001234',
      packingItems: [
        { index: 1, name: '主设备', spec: 'POA200', count: 1, unit: '台', standard: '是', remark: 'SN: 999999带泵' }
      ]
    })
  });

  assert.strictEqual(conflictRes.status, 400);
  const conflictData = await conflictRes.json();
  assert.ok(conflictData.error.includes('序列号数据冲突'));

  // Submit consistent SN preserving leading zeros
  const validRes = await fetch(`${serverUrl}/api/tasks/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reqId: 'req_valid_sn_' + Date.now(),
      clientId: 'c1',
      clientName: '李四',
      workerId: 'worker-online-01',
      model: 'POA200',
      deviceSn: '00001234',
      packingItems: [
        { index: 1, name: '主设备', spec: 'POA200', count: 1, unit: '台', standard: '是', remark: 'SN: 00001234带泵' }
      ]
    })
  });

  assert.strictEqual(validRes.status, 200);
  const validData = await validRes.json();
  assert.strictEqual(validData.task.device_sn, '00001234');
});

test('J09 / Q20-Q23: Models Without Packing List (DPT810, 990)', async () => {
  const serverUrl = `http://localhost:${PORT}`;

  const taskRes = await fetch(`${serverUrl}/api/tasks/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reqId: 'req_dpt810_' + Date.now(),
      clientId: 'c1',
      clientName: '李四',
      workerId: 'worker-online-01',
      model: 'DPT810',
      deviceSn: 'A010007031'
    })
  });

  assert.strictEqual(taskRes.status, 200);
  const data = await taskRes.json();
  assert.strictEqual(data.task.files.length, 1);
  assert.strictEqual(data.task.files[0].file_type, 'cert');
  assert.strictEqual(data.task.files.find(f => f.file_type === 'packing'), undefined);
});

test('J11 / Q30-Q32: Matcher Empty String Interception & Unbound Fields Publish Validation', async () => {
  const serverUrl = `http://localhost:${PORT}`;

  // Q30: Empty text must not match anything
  const docItems = [
    { type: 'cell', text: '', tableIdx: 0, rowIdx: 0, colIdx: 0 },
    { type: 'cell', text: '   ', tableIdx: 0, rowIdx: 0, colIdx: 1 }
  ];
  const emptyMatch = findFieldCandidates('Inst. SN.', docItems);
  assert.strictEqual(emptyMatch.matchCount, 0);

  // Q32: Publishing template with unbound fields is blocked
  const pubRes = await fetch(`${serverUrl}/api/templates/publish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': 'phoneapp-admin-secret'
    },
    body: JSON.stringify({
      id: 'tmpl_test_unbound',
      model: 'POA200',
      type: 'cert',
      filename: 'test.doc',
      fieldMappings: {
        singleFields: [{ label: 'UnboundField', status: 'unbound' }]
      },
      isDraft: false
    })
  });

  assert.strictEqual(pubRes.status, 400);
  const pubData = await pubRes.json();
  assert.ok(pubData.error.includes('未绑定字段'));
});

test('J12 / Q33: Preview Non-Word File Interception', () => {
  const { generateDocumentPreview } = require('../src/backend/preview');
  const tempTxtFile = path.resolve(__dirname, '../data/test_file.txt');
  const tempPreviewDir = path.resolve(__dirname, '../data/test_previews');

  if (!fs.existsSync(path.dirname(tempTxtFile))) fs.mkdirSync(path.dirname(tempTxtFile), { recursive: true });
  fs.writeFileSync(tempTxtFile, 'Non word file content', 'utf-8');

  assert.throws(() => {
    generateDocumentPreview(tempTxtFile, tempPreviewDir, 'txt_file_1');
  }, /Non-Word file rejected/);
});

test('J15 / Q41: Remote Admin Access Security Enforcement', () => {
  // Simulated remote IP
  const remoteReq = {
    socket: { remoteAddress: '192.168.1.100' },
    headers: { 'x-admin-token': 'phoneapp-admin-secret' },
    hostname: 'localhost'
  };

  assert.strictEqual(isLocalhostRequest(remoteReq), false, 'Remote request must be blocked even with headers/tokens');
});
