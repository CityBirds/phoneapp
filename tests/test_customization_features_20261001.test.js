const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const testDbPath = path.resolve(__dirname, `../data/phoneapp_customization_test_${Date.now()}.db`);
process.env.DB_PATH = testDbPath;
// 测试隔离：预览与回传产物不得写入生产 data/previews、data/returned
process.env.PREVIEW_DIR = path.join(path.dirname(testDbPath), 'previews_test_isolated');
process.env.RETURNED_DIR = path.join(path.dirname(testDbPath), 'returned_test_isolated');

const app = require('../src/backend/server');
const db = require('../src/backend/db');
const { generateCertFilename, generatePackingListFilename } = require('../src/common/naming');

let server;
const PORT = 3099;

test.before(async () => {
  await new Promise(resolve => {
    server = app.listen(PORT, () => resolve());
  });
});

test.after(async () => {
  if (server) {
    await new Promise(resolve => server.close(resolve));
  }
  try { if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath); } catch (e) {}
});

test('1. Sales Persons Management CRUD & Initial Seed', async () => {
  // 1. GET /api/sales-persons (Check initial seeded "陈文")
  const getRes = await fetch(`http://localhost:${PORT}/api/sales-persons`);
  assert.equal(getRes.status, 200);
  const initialList = await getRes.json();
  assert.ok(Array.isArray(initialList));
  assert.ok(initialList.some(sp => sp.name === '陈文'), 'Initial seed must contain 陈文');

  // 2. POST /api/admin/sales-persons (Add new sales person)
  const addRes = await fetch(`http://localhost:${PORT}/api/admin/sales-persons`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': 'phoneapp-admin-secret'
    },
    body: JSON.stringify({ name: '张三' })
  });
  assert.equal(addRes.status, 200);
  const addData = await addRes.json();
  assert.equal(addData.name, '张三');

  // Duplicate name should be rejected
  const dupRes = await fetch(`http://localhost:${PORT}/api/admin/sales-persons`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': 'phoneapp-admin-secret'
    },
    body: JSON.stringify({ name: '张三' })
  });
  assert.equal(dupRes.status, 400);

  // 3. DELETE /api/admin/sales-persons/:id
  const delRes = await fetch(`http://localhost:${PORT}/api/admin/sales-persons/${addData.id}`, {
    method: 'DELETE',
    headers: {
      'x-admin-token': 'phoneapp-admin-secret'
    }
  });
  assert.equal(delRes.status, 200);

  const getRes2 = await fetch(`http://localhost:${PORT}/api/sales-persons`);
  const list2 = await getRes2.json();
  assert.equal(list2.some(sp => sp.name === '张三'), false);
});

test('2. Sensor Configs Management CRUD, Comma Parsing & Deduplication', async () => {
  // 1. GET /api/sensor-configs (Check seeded POA200 and PGA500-EX)
  const getRes = await fetch(`http://localhost:${PORT}/api/sensor-configs`);
  assert.equal(getRes.status, 200);
  const list = await getRes.json();
  assert.ok(Array.isArray(list));
  assert.ok(list.some(c => c.model === 'POA200'));

  // 2. POST /api/admin/sensor-configs with Chinese & English commas + deduplication
  const saveRes = await fetch(`http://localhost:${PORT}/api/admin/sensor-configs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': 'phoneapp-admin-secret'
    },
    body: JSON.stringify({
      model: 'DPT810-NEW',
      sensor_options: ' SENSOR-A ， SENSOR-B, SENSOR-A, , SENSOR-C ',
      default_value: 'SENSOR-B'
    })
  });
  assert.equal(saveRes.status, 200);
  const saveData = await saveRes.json();
  assert.equal(saveData.config.model, 'DPT810-NEW');
  assert.deepEqual(saveData.config.sensor_options, ['SENSOR-A', 'SENSOR-B', 'SENSOR-C']);
  assert.equal(saveData.config.default_value, 'SENSOR-B');

  // 3. DELETE /api/admin/sensor-configs/:id
  const delRes = await fetch(`http://localhost:${PORT}/api/admin/sensor-configs/${saveData.config.id}`, {
    method: 'DELETE',
    headers: {
      'x-admin-token': 'phoneapp-admin-secret'
    }
  });
  assert.equal(delRes.status, 200);
});

test('3. Updated File Naming Conventions Verification', () => {
  // Certificate: PGA500-EX证书EX0000608-20260717-发陈文-PSR-12-223.doc
  const certNameWithSensor = generateCertFilename({
    model: 'PGA500-EX',
    deviceSn: 'EX0000608',
    acceptedDate: '2026-07-17',
    salesPerson: '陈文',
    sensorModel: 'PSR-12-223'
  });
  assert.equal(certNameWithSensor, 'PGA500-EX证书EX0000608-20260717-发陈文-PSR-12-223.doc');

  // Certificate without sensor model: PGA500-EX证书EX0000608-20260717-发陈文.doc
  const certNameNoSensor = generateCertFilename({
    model: 'PGA500-EX',
    deviceSn: 'EX0000608',
    acceptedDate: '2026-07-17',
    salesPerson: '陈文',
    sensorModel: ''
  });
  assert.equal(certNameNoSensor, 'PGA500-EX证书EX0000608-20260717-发陈文.doc');

  // Packing list with pump: PGA500-EX发货清单EX0000608带泵-发南京20260717.doc
  const packNameWithPump = generatePackingListFilename({
    model: 'PGA500-EX',
    deviceSn: 'EX0000608',
    acceptedDate: '2026-07-17',
    shippingLocation: '南京',
    hasPump: true
  });
  assert.equal(packNameWithPump, 'PGA500-EX发货清单EX0000608带泵-发南京20260717.doc');

  // Packing list without pump: PGA500-EX发货清单EX0000608-发南京20260717.doc
  const packNameNoPump = generatePackingListFilename({
    model: 'PGA500-EX',
    deviceSn: 'EX0000608',
    acceptedDate: '2026-07-17',
    shippingLocation: '南京',
    hasPump: false
  });
  assert.equal(packNameNoPump, 'PGA500-EX发货清单EX0000608-发南京20260717.doc');
});
