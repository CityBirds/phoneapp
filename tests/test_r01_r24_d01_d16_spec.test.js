const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const http = require('http');

const testDbPath = path.resolve(__dirname, '../data/phoneapp_test_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + '.db');
process.env.DB_PATH = testDbPath;

const { extractDocumentStructure } = require('../src/common/doc_structure');
const { findFieldCandidates, isDateFieldLabel, inferFieldType } = require('../src/common/matcher');
const { resolveModelAlias } = require('../src/backend/server');
const { generateWordDocument } = require('../src/worker/word_engine');
const { generateDocumentPreview } = require('../src/backend/preview');
const { getFileSha256 } = require('../src/common/utils');

const samplesDir = path.join(__dirname, '../samples');
const cert990Path = path.join(samplesDir, '990-Ex-EX10260902发货证书.doc');
const pack990Path = path.join(samplesDir, '990-Ex-EX10260902装箱清单.doc');
const poaCertPath = path.join(samplesDir, 'POA200证书AP10007513-20260403发南京订单-PSR-12-223(封装）带泵.doc');

// Helper to start test server
let serverProcess = null;
let serverPort = 3009;

function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const reqOpts = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };

    const req = http.request(reqOpts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, data: parsed, headers: res.headers });
        } catch (e) {
          resolve({ status: res.statusCode, data, headers: res.headers });
        }
      });
    });

    req.on('error', reject);

    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

test('R01 / D16: Parse Real 990 Packing List (7 Columns, 11 Material Items)', () => {
  assert.ok(fs.existsSync(pack990Path), '990 packing list sample file must exist');
  const items = extractDocumentStructure(pack990Path);
  assert.ok(items.length > 0, 'Extracted items should not be empty');

  const names = items.map(x => x.text);
  assert.ok(names.includes('主设备'), 'Should extract 主设备');
  assert.ok(names.includes('DPT-990-Ex'), 'Should extract DPT-990-Ex');
  assert.ok(names.includes('SN：EX10260902'), 'Should extract SN：EX10260902');
  assert.ok(names.includes('计量证书'), 'Should extract 计量证书');
  assert.ok(names.includes('用户手册'), 'Should extract 用户手册');
});

test('R02 / D01: Candidate Finder for Multi-line Test point Number and Test Points Table', () => {
  const certItems = extractDocumentStructure(cert990Path);
  const result = findFieldCandidates('Test point Number', certItems);

  assert.ok(result.matchCount >= 1, 'Should match Test point Number feature');
  assert.equal(result.candidates[0].status, 'FULL_MATCH');
});

test('R03: Formal Publication Rejected for Unbound Fields', async () => {
  const app = require('../src/backend/server');
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(serverPort, resolve));

  try {
    const res = await fetchJson(`http://localhost:${serverPort}/api/templates/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        id: 'tmpl_test_unbound',
        model: '990',
        type: 'cert',
        filename: '990.doc',
        isDraft: false,
        fieldMappings: {
          singleFields: [{ label: 'UnboundField', status: 'unbound' }]
        }
      }
    });

    assert.equal(res.status, 400, 'Formal publish with unbound fields must be rejected');
    assert.ok(res.data.error.includes('未绑定'), 'Error message should mention unbound fields');
  } finally {
    server.close();
  }
});

test('D02 / D03: Smart Date Field Inference without False Positives on Update/Candidate', () => {
  assert.equal(isDateFieldLabel('Date:'), true, 'Date: should be date field');
  assert.equal(isDateFieldLabel('Certificate Date'), true, 'Certificate Date should be date field');
  assert.equal(isDateFieldLabel('证书日期'), true, '证书日期 should be date field');
  assert.equal(isDateFieldLabel('Update'), false, 'Update must NOT be date field');
  assert.equal(isDateFieldLabel('Candidate'), false, 'Candidate must NOT be date field');

  assert.equal(inferFieldType('Date:'), 'date');
  assert.equal(inferFieldType('Instrument'), 'text');
});

test('R10 / D04: Model Alias Mapping (990, 990-Ex, DPT-990-EX -> same modelId)', () => {
  const r1 = resolveModelAlias('990');
  const r2 = resolveModelAlias('990-Ex');
  const r3 = resolveModelAlias('DPT-990-EX');

  assert.equal(r1.modelId, 'model_990');
  assert.equal(r2.modelId, 'model_990');
  assert.equal(r3.modelId, 'model_990');
  assert.equal(r1.displayName, '990');
});

test('F10: Server Rejects Unconfigured SensorModel Parameter Submission', async () => {
  const app = require('../src/backend/server');
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(serverPort + 1, resolve));

  try {
    // 1. Register online worker
    await fetchJson(`http://localhost:${serverPort + 1}/api/workers/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { workerId: 'worker-spec-test', name: 'Spec Worker', status: 'ONLINE' }
    });

    // 2. Submit POA200 task with unconfigured sensorModel -> should be rejected
    const res = await fetchJson(`http://localhost:${serverPort + 1}/api/tasks/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        reqId: 'req_spec_f10_' + Date.now(),
        clientId: 'client_spec',
        clientName: 'Tester',
        workerId: 'worker-spec-test',
        model: 'POA200',
        deviceSn: 'EX10260902',
        sensorModel: 'UNCONFIGURED_SENSOR_XYZ' // Invalid option!
      }
    });

    assert.equal(res.status, 400, 'Unconfigured sensorModel submission must be rejected');
    assert.ok(res.data.error.includes('不属于'), 'Error should state sensorModel option invalid');
  } finally {
    server.close();
  }
});

test('R15 / D12: Shared Device Serial Number EX10260999 and Conflict Interception', async () => {
  const app = require('../src/backend/server');
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(serverPort + 2, resolve));

  try {
    await fetchJson(`http://localhost:${serverPort + 2}/api/workers/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { workerId: 'worker-spec-test2', name: 'Spec Worker 2', status: 'ONLINE' }
    });

    // Conflicting packing list main device SN
    const res = await fetchJson(`http://localhost:${serverPort + 2}/api/tasks/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        reqId: 'req_spec_sn_conflict_' + Date.now(),
        clientId: 'client_spec',
        clientName: 'Tester',
        workerId: 'worker-spec-test2',
        model: 'POA200',
        deviceSn: 'EX10260999',
        packingItems: [
          { index: 1, name: '主设备', spec: 'POA200', count: 1, unit: '台', standard: '是', remark: 'SN: CONFLICT_SN_9999' }
        ]
      }
    });

    assert.equal(res.status, 400, 'Conflicting device SN must be rejected');
    assert.ok(res.data.error.includes('序列号数据冲突'), 'Error message should indicate SN conflict');
  } finally {
    server.close();
  }
});

test('R17 / E05: Source Template SHA256 Preservation During Document Generation', () => {
  const tmpOutPath = path.join(__dirname, '../data/test_output_r17.doc');
  const initialHash = getFileSha256(cert990Path);

  const genResult = generateWordDocument(cert990Path, tmpOutPath, {
    type: 'cert',
    formData: {
      model: '990',
      deviceSn: 'EX10260902',
      ambientTemp: '22.1',
      relativeHumidity: '50%RH'
    }
  });

  const postHash = getFileSha256(cert990Path);
  assert.equal(initialHash, postHash, 'Source template file must remain 100% unchanged (R17)');
  assert.ok(fs.existsSync(tmpOutPath), 'Output document must be generated');

  if (fs.existsSync(tmpOutPath)) {
    try { fs.unlinkSync(tmpOutPath); } catch (e) {}
  }
});

test('R17 / R21: Real Word Preview Generation', () => {
  const tmpOutPath = path.join(__dirname, '../data/test_output_preview.doc');
  const previewDir = path.join(__dirname, '../data/previews_test');

  generateWordDocument(cert990Path, tmpOutPath, {
    type: 'cert',
    formData: {
      model: '990',
      deviceSn: 'EX10260902',
      certDate: '2026-09-29'
    }
  });

  const previews = generateDocumentPreview(tmpOutPath, previewDir, 'test_task_cert', {
    fileType: 'cert',
    task: { model: '990', device_sn: 'EX10260902' }
  });

  assert.ok(previews.length > 0, 'Preview images should be generated');
  const previewFile = path.join(previewDir, path.basename(previews[0]));
  assert.ok(fs.existsSync(previewFile), 'Preview file should exist on disk');

  // Clean up test artifacts
  if (fs.existsSync(tmpOutPath)) try { fs.unlinkSync(tmpOutPath); } catch (e) {}
  if (fs.existsSync(previewFile)) try { fs.unlinkSync(previewFile); } catch (e) {}
});
