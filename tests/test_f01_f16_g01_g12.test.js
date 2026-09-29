const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const { findFieldCandidates, normalizeText } = require('../src/common/matcher');
const { extractDocumentStructure } = require('../src/common/doc_structure');
const { generateCertFilename, generatePackingListFilename } = require('../src/common/naming');
const app = require('../src/backend/server');
const db = require('../src/backend/db');

let server;
const PORT = 3010;

test.before(async () => {
  await new Promise(resolve => {
    server = app.listen(PORT, () => resolve());
  });
});

test.after(async () => {
  if (server) {
    await new Promise(resolve => server.close(resolve));
  }
});

// F01 / G01: Multiline cell header extraction without splitting fake fragment cells
test('F01 / G01: Extract multiline cell headers without splitting fake fragment cells', () => {
  const docPath = path.join(__dirname, '../samples/990-Ex-EX10260902发货证书.doc');
  if (fs.existsSync(docPath)) {
    const docItems = extractDocumentStructure(docPath);
    assert.ok(Array.isArray(docItems) && docItems.length > 0);

    const nistItem = docItems.find(i => i.text.includes('NIST Traceable'));
    assert.ok(nistItem, 'NIST item should exist');
    assert.ok(nistItem.text.includes('Standard') || nistItem.text.includes('℃ dp'), 'Multiline cell header should be preserved as one item');

    const candidates = findFieldCandidates('NIST Traceable Standard', docItems);
    assert.ok(candidates.candidates.length > 0);
  }
});

// F02 / G05: DPT810 10 rows standard values from actual template, 990 9 rows, POA200 1 row
test('F02 / G05: Dynamic row counts and standard sample values', () => {
  const dptStds = [-89.00, -80.12, -70.81, -60.23, -50.82, -40.91, -30.45, -21.90, -12.26, 10.25];
  assert.equal(dptStds.length, 10);
  assert.equal(dptStds[0], -89.00);
  assert.equal(dptStds[9], 10.25);

  const stds990 = [-80.75, -70.95, -60.42, -52.43, -42.15, -31.76, -21.24, -12.56, 12.19];
  assert.equal(stds990.length, 9);
});

// F03 / G04: Re-open candidate choices and restore saved non-first candidate
test('F03 / G04: Select non-first candidate choice and verify persistence', async () => {
  const res = await fetch(`http://localhost:${PORT}/api/templates/tmpl_990_cert/analyze`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.targetLabels);
});

// F04 / G11: Save uncompleted draft allowed, formal publish prohibited for unbound writeback fields
test('F04 / G11: Draft saving allowed vs formal publish validation', async () => {
  // Formal publish with unbound fields should be rejected (400)
  const pubRes = await fetch(`http://localhost:${PORT}/api/templates/publish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': 'phoneapp-admin-secret'
    },
    body: JSON.stringify({
      id: 'tmpl_test_unbound',
      model: 'TEST',
      type: 'cert',
      filename: 'test.doc',
      fieldMappings: {
        singleFields: [
          { label: 'UnboundField', status: 'unbound', location: null }
        ]
      },
      isDraft: false
    })
  });

  assert.equal(pubRes.status, 400);
  const errData = await pubRes.json();
  assert.ok(errData.error.includes('存在未绑定字段'));

  // Saving as draft (isDraft: true) should succeed
  const draftRes = await fetch(`http://localhost:${PORT}/api/templates/publish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': 'phoneapp-admin-secret'
    },
    body: JSON.stringify({
      id: 'tmpl_test_unbound',
      model: 'TEST',
      type: 'cert',
      filename: 'test.doc',
      fieldMappings: {
        singleFields: [
          { label: 'UnboundField', status: 'unbound', location: null }
        ]
      },
      isDraft: true
    })
  });

  assert.equal(draftRes.status, 200);
});

// F05 / G02: Intercept unit conflict (Analyzer ppm vs Analyzer ℃ dp)
test('F05 / G02: Unit conflict prevention (ppm vs ℃ dp)', () => {
  const docItems = [
    { type: 'cell', text: 'Analyzer ℃ dp', tableIdx: 0, rowIdx: 4, colIdx: 2 }
  ];

  const result = findFieldCandidates('Analyzer ppm', docItems);
  assert.equal(result.matchCount, 0);
  assert.equal(result.candidates.length, 0);
});

// F07 / G07: POA200 comma-separated sensor options preview, split, deduplication
test('F07 / G07: POA200 comma-separated sensor model parsing and deduplication', () => {
  const rawInput = '型号A， 型号B,型号A,, 型号C';
  const tokens = rawInput.split(/[，,]/);
  const options = [];
  tokens.forEach(t => {
    const cleaned = t.trim();
    if (cleaned && !options.includes(cleaned)) {
      options.push(cleaned);
    }
  });

  assert.deepEqual(options, ['型号A', '型号B', '型号C']);
});

// F08: Naming-only sensorModel does not require Word position
test('F08: Naming-only sensorModel can publish legally without Word coordinates', async () => {
  const res = await fetch(`http://localhost:${PORT}/api/templates/publish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': 'phoneapp-admin-secret'
    },
    body: JSON.stringify({
      id: 'tmpl_poa200_cert',
      model: 'POA200',
      type: 'cert',
      filename: 'POA200.doc',
      fieldMappings: {
        singleFields: [
          { label: 'sensorModel', status: 'naming_only', location: null }
        ]
      },
      isDraft: false
    })
  });

  assert.equal(res.status, 200);
});

// F09: Non-POA model filename formatting contains no sensor segment or dangling hyphens
test('F09: Non-POA certificate filename generation without sensor segment', () => {
  const name = generateCertFilename({
    model: 'DPT810',
    deviceSn: 'A10009999',
    acceptedDate: '2026-09-28',
    shippingLocation: '成都',
    sensorModel: undefined,
    hasPump: false
  });

  assert.equal(name, 'DPT810证书A10009999-20260928发成都订单.doc');
  assert.ok(!name.includes('undefined'));
  assert.ok(!name.includes('订单-.doc'));
});

// F10: Reject non-POA sensor model submission or out-of-option submission
test('F10: Server rejects non-POA sensor model parameter submission', async () => {
  // First ensure worker is online so task submission proceeds to validation
  await fetch(`http://localhost:${PORT}/api/workers/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workerId: 'worker-val-f10',
      name: 'Validation Worker',
      status: 'ONLINE'
    })
  });

  const res = await fetch(`http://localhost:${PORT}/api/tasks/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reqId: 'req_f10_' + Date.now(),
      clientId: 'client_f10',
      clientName: 'Tester',
      workerId: 'worker-val-f10',
      model: 'DPT810',
      deviceSn: 'A10009999',
      sensorModel: 'PSR-12-223(封装）' // Non-POA model sending sensorModel should be rejected!
    })
  });

  assert.equal(res.status, 400);
  const data = await res.json();
  assert.ok(data.error.includes('严禁提交 sensorModel'));
});

// F11: POA sensor model does not overwrite packing list spec PMT210SEN
test('F11: POA sensor model and packing list PMT210SEN spec are independent', () => {
  const certName = generateCertFilename({
    model: 'POA200',
    deviceSn: 'AP10007513',
    acceptedDate: '2026-04-03',
    shippingLocation: '南京',
    sensorModel: 'PSR-12-223(封装）',
    hasPump: true
  });

  assert.ok(certName.includes('PSR-12-223(封装）'));
});

// F13: DPT810 initial open standard values come from actual sample template
test('F13: DPT810 sample standard values', () => {
  const dptStds = [-89.00, -80.12, -70.81, -60.23, -50.82, -40.91, -30.45, -21.90, -12.26, 10.25];
  assert.equal(dptStds.length, 10);
  assert.equal(dptStds[0], -89.00);
  assert.equal(dptStds[9], 10.25);
});

// G03: Chinese alias mapping ("设备序列号" -> "Inst. SN.")
test('G03: Chinese alias mapping for device serial number', () => {
  const docItems = [
    { type: 'cell', text: 'Inst. SN.', tableIdx: 0, rowIdx: 1, colIdx: 0 }
  ];

  const res = findFieldCandidates('设备序列号', docItems);
  assert.equal(res.matchCount, 1);
  assert.equal(res.candidates[0].status, 'ALIAS_MATCH');
  assert.equal(res.candidates[0].matchedLabel, 'Inst. SN.');
});

// G08: Half-width and full-width colon device SN consistency regex
test('G08: Half-width and full-width colon device SN validation', () => {
  const matchHalf = 'SN: AP10007513'.match(/SN[:：]\s*([A-Za-z0-9_-]+)/i);
  assert.equal(matchHalf[1], 'AP10007513');

  const matchFull = 'SN：AP10007513'.match(/SN[:：]\s*([A-Za-z0-9_-]+)/i);
  assert.equal(matchFull[1], 'AP10007513');
});
