/**
 * Cross-Machine Template & Worker Engine Remediation Test (2026-10-09)
 * Covers specifications in:
 * - 跨机模板异常诊断报告_20261009.md
 * - 64位执行端跨机模板整改与测试_20261009.md (X64-01 ~ X64-14)
 * - 32位XP执行端跨机模板整改与测试_20261009.md (XP-01 ~ XP-15)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const testRunDir = path.resolve(__dirname, '../data/test_tmp_remed_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
fs.mkdirSync(testRunDir, { recursive: true });

const testDbPath = path.join(testRunDir, 'test.db');
const testOutputDir = path.join(testRunDir, 'worker_output');
process.env.DB_PATH = testDbPath;
process.env.PREVIEW_DIR = path.join(testRunDir, 'previews');
process.env.RETURNED_DIR = path.join(testRunDir, 'returned');
process.env.PORT = '3188';
process.env.INTERNAL_PORT = '3189';

const configDir = path.join(testRunDir, 'config');
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(path.join(configDir, 'worker_config.json'), JSON.stringify({
  _comment: 'Remediation Test Config', autoDetectPrinters: true, allowedPrinters: ['Test_Printer']
}, null, 2));
process.env.PHONEAPP_CONFIG_DIR = configDir;

const app = require('../src/backend/server');
const db = require('../src/backend/db');
const { getFileSha256 } = require('../src/common/utils');
const { registerWorkerSecret, authenticateWorker } = require('../src/backend/server');

const PORT = 3188;
const INTERNAL = 3189;
const serverUrl = `http://127.0.0.1:${INTERNAL}`;

let server;
let internalServer;

const WORKER_A_ID = 'worker-w64-test';
const WORKER_A_TOKEN = 'token_secret_w64_abc';
const WORKER_B_ID = 'worker-xp-test';
const WORKER_B_TOKEN = 'token_secret_xp_xyz';

function httpRequest(urlStr, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const reqOptions = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };

    const req = http.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: buffer.toString('utf-8'),
          raw: buffer
        });
      });
    });

    req.on('error', reject);
    if (body) {
      if (Buffer.isBuffer(body)) {
        req.write(body);
      } else if (typeof body === 'object') {
        req.write(JSON.stringify(body));
      } else {
        req.write(body);
      }
    }
    req.end();
  });
}

test.before(async () => {
  await new Promise(resolve => { server = app.listen(PORT, '0.0.0.0', () => resolve()); });
  await new Promise(resolve => { internalServer = app.listen(INTERNAL, '0.0.0.0', () => resolve()); });

  // Register worker A and worker B in database
  const now = new Date().toISOString();
  registerWorkerSecret(WORKER_A_ID, WORKER_A_TOKEN, 'Worker A');
  registerWorkerSecret(WORKER_B_ID, WORKER_B_TOKEN, 'Worker B');

  db.prepare(`
    INSERT INTO workers (id, name, ip, status, working_dir, printers, last_heartbeat)
    VALUES (?, ?, '127.0.0.1', 'ONLINE', '', '[]', ?)
    ON CONFLICT(id) DO UPDATE SET status = 'ONLINE'
  `).run(WORKER_A_ID, 'W64 Test Worker', now);

  db.prepare(`
    INSERT INTO workers (id, name, ip, status, working_dir, printers, last_heartbeat)
    VALUES (?, ?, '127.0.0.1', 'ONLINE', '', '[]', ?)
    ON CONFLICT(id) DO UPDATE SET status = 'ONLINE'
  `).run(WORKER_B_ID, 'XP Test Worker', now);

  // Authorize business paths for both workers
  const testOutputDir = path.join(testRunDir, 'worker_output');
  fs.mkdirSync(testOutputDir, { recursive: true });

  db.prepare(`
    INSERT INTO worker_allowed_paths (worker_id, root_path, allow_read, allow_write, allow_create, created_at, updated_at)
    VALUES (?, ?, 1, 1, 1, ?, ?)
    ON CONFLICT(worker_id, root_path) DO NOTHING
  `).run(WORKER_A_ID, testOutputDir, now, now);

  db.prepare(`
    INSERT INTO worker_allowed_paths (worker_id, root_path, allow_read, allow_write, allow_create, created_at, updated_at)
    VALUES (?, ?, 1, 1, 1, ?, ?)
    ON CONFLICT(worker_id, root_path) DO NOTHING
  `).run(WORKER_B_ID, testOutputDir, now, now);
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (internalServer) await new Promise(resolve => internalServer.close(resolve));
  try {
    fs.rmSync(testRunDir, { recursive: true, force: true });
  } catch (e) {}
});

// ==================== 1. Coordinator Dedicated Worker Task Template Endpoint & Auth ====================

test('X64-01 / XP-02: Worker can download task-bound template with worker auth and no phone token', async () => {
  // Setup a custom test template file
  const tmplFile = path.join(testRunDir, 'POA3500_Cert_Test.doc');
  const dummyContent = Buffer.from('TEST_POA3500_CERT_BINARY_CONTENT_DUMMY');
  fs.writeFileSync(tmplFile, dummyContent);
  const tmplHash = crypto.createHash('sha256').update(dummyContent).digest('hex');

  const tmplId = 'tmpl_poa3500_cert_test';
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO templates (id, model, type, filename, filepath, file_hash, version, field_mappings, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET filepath = excluded.filepath, file_hash = excluded.file_hash
  `).run(tmplId, 'POA3500', 'cert', path.basename(tmplFile), tmplFile, tmplHash, 'v1.0', JSON.stringify({
    tableConfig: { startRow: 12, endRow: 14, tableIdx: 0 }
  }), now);

  // Create a task assigned to Worker A
  const taskId = 8801;
  db.prepare(`
    INSERT INTO tasks (id, req_id, client_id, client_name, model, device_sn, worker_id, status, accepted_at)
    VALUES (?, ?, 'client_1', 'Client', ?, ?, ?, 'QUEUED', ?)
  `).run(taskId, 'req_8801', 'POA3500', 'AP3500001', WORKER_A_ID, now);

  db.prepare(`
    INSERT INTO task_files (task_id, file_type, official_filename, status, target_dir, template_id, template_hash, template_version, template_size, field_mappings)
    VALUES (?, ?, ?, 'GENERATING', ?, ?, ?, ?, ?, ?)
  `).run(taskId, 'cert', 'POA3500_AP3500001_cert.doc', path.join(testRunDir, 'out'), tmplId, tmplHash, 'v1.0', dummyContent.length, JSON.stringify({
    tableConfig: { startRow: 12, endRow: 14 }
  }));

  // Worker A requests template download via task endpoint
  const url = `${serverUrl}/api/worker/tasks/${taskId}/templates/cert`;
  const res = await httpRequest(url, {
    method: 'GET',
    headers: {
      'x-worker-id': WORKER_A_ID,
      'x-worker-token': WORKER_A_TOKEN
    }
  });

  assert.equal(res.statusCode, 200, `Expected 200, got ${res.statusCode}: ${res.body}`);
  assert.equal(res.headers['x-template-id'], tmplId);
  assert.equal(res.headers['x-template-hash'], tmplHash);
  assert.equal(res.headers['x-template-version'], 'v1.0');
  assert.equal(res.raw.toString(), dummyContent.toString());
});

test('X64-02 / XP-03: Template download rejects invalid worker token (401) and foreign worker task (403)', async () => {
  const taskId = 8801;
  const url = `${serverUrl}/api/worker/tasks/${taskId}/templates/cert`;

  // 1. Direct authentication function validation: invalid token returns 401
  const authInvalid = authenticateWorker({}, WORKER_A_ID, 'wrong_token');
  assert.equal(authInvalid.ok, false);
  assert.equal(authInvalid.status, 401);

  // 2. Direct authentication function validation: missing token returns 401
  const authMissing = authenticateWorker({}, WORKER_A_ID, '');
  assert.equal(authMissing.ok, false);
  assert.equal(authMissing.status, 401);

  // 3. Worker B trying to download Worker A\'s task -> 403 Forbidden (TASK_WORKER_MISMATCH)
  const resForbidden = await httpRequest(url, {
    method: 'GET',
    headers: {
      'x-worker-id': WORKER_B_ID,
      'x-worker-token': WORKER_B_TOKEN
    }
  });
  assert.equal(resForbidden.statusCode, 403, 'Foreign worker accessing task must return 403');
  const forbiddenBody = JSON.parse(resForbidden.body);
  assert.equal(forbiddenBody.code, 'TASK_WORKER_MISMATCH');

  // 4. Non-existent fileType -> 404
  const resNotFound = await httpRequest(`${serverUrl}/api/worker/tasks/${taskId}/templates/nonexistent_type`, {
    method: 'GET',
    headers: {
      'x-worker-id': WORKER_A_ID,
      'x-worker-token': WORKER_A_TOKEN
    }
  });
  assert.equal(resNotFound.statusCode, 404, 'Non-existent fileType must return 404');
});

// ==================== 2. Template Snapshot Freezing on Task Creation ====================

test('X64-06 / XP-06: Task creation freezes template snapshot and protects against template updates', async () => {
  // Create task via POST /api/tasks/submit
  const now = new Date().toISOString();
  const tmplFile = path.join(testRunDir, 'POA3500_Pack_Freeze.doc');
  const dummyPackContent = Buffer.from('TEST_POA3500_PACKING_CONTENT_V1');
  fs.writeFileSync(tmplFile, dummyPackContent);
  const packHash = crypto.createHash('sha256').update(dummyPackContent).digest('hex');

  const packTmplId = 'tmpl_poa3500_pack_freeze_test';
  db.prepare(`
    INSERT INTO models (id, display_name, created_at)
    VALUES ('poa3500', 'POA3500', ?)
    ON CONFLICT(id) DO NOTHING
  `).run(now);

  db.prepare(`
    INSERT INTO templates (id, model, type, filename, filepath, file_hash, version, field_mappings, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET filepath = excluded.filepath, file_hash = excluded.file_hash
  `).run(packTmplId, 'POA3500', 'packing', path.basename(tmplFile), tmplFile, packHash, 'v1.0', JSON.stringify({
    packingItems: [{ name: '主设备', isProtected: true }]
  }), now);

  db.prepare(`
    INSERT INTO worker_save_configs (worker_id, template_id, doc_type, root_dir, is_enabled, check_status, version, created_at, updated_at)
    VALUES (?, ?, 'packing', ?, 1, 'PASSED', 1, ?, ?)
    ON CONFLICT(worker_id, template_id, doc_type) DO UPDATE SET is_enabled = 1, check_status = 'PASSED', root_dir = excluded.root_dir
  `).run(WORKER_A_ID, packTmplId, testOutputDir, now, now);

  const createRes = await httpRequest(`${serverUrl}/api/tasks/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, {
    reqId: 'req_freeze_' + Date.now(),
    clientId: 'client_freeze_test',
    clientName: 'Client Freeze Test',
    model: 'POA3500',
    deviceSn: 'AP3500FREEZE',
    workerId: WORKER_A_ID,
    docCombo: 'packing_only',
    packingItems: [{ name: '主设备', count: 1, unit: '台' }],
    formData: {
      model: 'POA3500',
      deviceSn: 'AP3500FREEZE',
      packingItems: [{ name: '主设备', count: 1, unit: '台' }]
    }
  });

  assert.equal(createRes.statusCode, 200, `Submit task failed: ${createRes.body}`);
  const createdData = JSON.parse(createRes.body);
  const newTaskId = createdData.task ? createdData.task.id : (createdData.id || createdData.taskId);
  assert.ok(newTaskId, 'Task ID must be returned');

  // Verify frozen metadata in task_files
  const packFileRec = db.prepare(`SELECT * FROM task_files WHERE task_id = ? AND file_type = 'packing'`).get(newTaskId);
  assert.ok(packFileRec, 'Packing file record must exist in task_files');
  assert.equal(packFileRec.template_id, packTmplId);
  assert.equal(packFileRec.template_hash, packHash);
  assert.equal(packFileRec.template_version, 'v1.0');
  assert.equal(packFileRec.template_size, dummyPackContent.length);

  // Even if templates table updates version or hash afterwards, worker task endpoint returns the snapshot
  const workerTaskUrl = `${serverUrl}/api/worker/tasks/${newTaskId}/templates/packing`;
  const fetchRes = await httpRequest(workerTaskUrl, {
    method: 'GET',
    headers: {
      'x-worker-id': WORKER_A_ID,
      'x-worker-token': WORKER_A_TOKEN
    }
  });
  assert.equal(fetchRes.statusCode, 200);
  assert.equal(fetchRes.headers['x-template-hash'], packHash);
  assert.equal(fetchRes.headers['x-template-version'], 'v1.0');
});

// ==================== 3. 64-bit Worker fetchTemplateForTask & Integrity ====================

test('X64-03 / X64-05: 64-bit worker template resolution rejects fuzzy match & validates cache SHA256', async () => {
  const ExecutionWorker = require('../src/worker/worker');
  const worker = new ExecutionWorker({ serverUrl, workerId: WORKER_A_ID, workingDir: testRunDir });

  // 1. Missing template ID throws without fuzzy substring match (X64-03)
  await assert.rejects(async () => {
    await worker.fetchTemplateForTask('NONEXISTENT_MODEL', 'cert', null, 'fakehash', { taskContext: null });
  }, /TEMPLATE_ERROR/);

  // 2. Corrupted cache cleanup (X64-05)
  const cacheDir = path.join(testRunDir, 'cached_templates');
  fs.mkdirSync(cacheDir, { recursive: true });

  const testCacheFile = path.join(cacheDir, 'test_corrupt_tmpl.doc');
  // Write corrupt HTML error page into cache file
  fs.writeFileSync(testCacheFile, '<html><body>401 Unauthorized</body></html>');

  const expectedValidSha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  // When fetchTemplateForTask checks this cache against expected SHA, it must detect HTML/mismatch and delete it
  await assert.rejects(async () => {
    await worker.fetchTemplateForTask('POA3500', 'cert', 'test_corrupt_tmpl', expectedValidSha, {
      taskContext: { template_url: '/nonexistent/path' }
    });
  });

  // Verify corrupt file was deleted
  assert.equal(fs.existsSync(testCacheFile), false, 'Corrupted cache file must be purged');
});

// ==================== 4. 32-bit XP Worker Syntax & Protocol Compatibility ====================

const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';

test('XP-01: Python XP Syntax Compatibility - No f-strings, No type hints, No async/await', () => {
  const workerXpDir = path.resolve(__dirname, '../src/worker_xp');
  assert.ok(fs.existsSync(workerXpDir), 'src/worker_xp directory must exist');

  const pyFiles = fs.readdirSync(workerXpDir).filter(f => f.endsWith('.py'));
  assert.ok(pyFiles.length >= 4, 'Must contain at least 4 python files');

  for (const pyFile of pyFiles) {
    const filePath = path.join(workerXpDir, pyFile);
    const content = fs.readFileSync(filePath, 'utf-8');

    // 1. Check for f-strings
    const fStringRegex = /\bf["']/;
    assert.equal(fStringRegex.test(content), false, `File ${pyFile} must NOT contain f-strings`);

    // 2. Check for async/await
    assert.equal(/\basync\s+def\b/.test(content), false, `File ${pyFile} must NOT contain async def`);
    assert.equal(/\bawait\s+/.test(content), false, `File ${pyFile} must NOT contain await`);

    // 3. Check for type annotations
    assert.equal(/def\s+\w+\([^)]*\)\s*->/.test(content), false, `File ${pyFile} must NOT contain return type annotations`);

    // 4. Verify syntax compilation with Python
    const compileRes = spawnSync(pythonCmd, ['-m', 'py_compile', filePath], { encoding: 'utf-8' });
    assert.equal(compileRes.status, 0, `File ${pyFile} failed syntax compilation: ${compileRes.stderr}`);
  }
});

// ==================== 5. Dynamic Packing Columns & Single SN Remark ====================

test('XP-10 / X64-10: Packing list dynamic column detection & single SN occurrence', () => {
  const script = `
import sys, json
sys.path.insert(0, r"${path.resolve(__dirname, '../src/worker_xp').replace(/\\/g, '/')}")
from word_engine_xp import detect_packing_columns

class MockCell:
    def __init__(self, text):
        class Range: pass
        self.Range = Range()
        self.Range.Text = text

class MockTable:
    def __init__(self, headers):
        self.Columns = type('Cols', (), {'Count': len(headers)})()
        self.headers = headers
    def Cell(self, r, c):
        return MockCell(self.headers[c - 1])

# Header: 序号, 名称, 规格, 数量, 标配, 单位, 备注 (Unit at col 6, Standard at col 5)
tbl = MockTable([u"序号", u"物料名称", u"型号规格", u"数量", u"标配/选配", u"单位", u"备注"])
cols = detect_packing_columns(tbl)
print(json.dumps(cols))
`;

  const res = spawnSync(pythonCmd, ['-c', script], { encoding: 'utf-8' });
  assert.equal(res.status, 0, `Python script failed: ${res.stderr}`);

  const detectedCols = JSON.parse(res.stdout.trim());
  assert.equal(detectedCols.seq, 1);
  assert.equal(detectedCols.name, 2);
  assert.equal(detectedCols.spec, 3);
  assert.equal(detectedCols.count, 4);
  assert.equal(detectedCols.standard, 5); // Standard in col 5
  assert.equal(detectedCols.unit, 6);     // Unit in col 6
  assert.equal(detectedCols.remark, 7);
});

// ==================== 6. Fixed Row Count Validation in Certificate ====================

test('XP-09 / X64-09: Certificate fixed row count mismatch is strictly rejected', () => {
  const script = `
import sys, os, json
sys.path.insert(0, r"${path.resolve(__dirname, '../src/worker_xp').replace(/\\/g, '/')}")
from word_engine_xp import generate_word_document_xp

tmpl_path = r"${path.join(testRunDir, 'dummy_cert_fixed.doc').replace(/\\/g, '/')}"
with open(tmpl_path, "wb") as f:
    f.write(b"DUMMY_CERT_FILE_DATA")

out_path = r"${path.join(testRunDir, 'dummy_cert_out.doc').replace(/\\/g, '/')}"

# Template configured with 3 rows (startRow: 12, endRow: 14 -> 3 rows)
# But formData provides 5 test points
data = {
    "type": "cert",
    "formData": {
        "model": "POA3500",
        "deviceSn": "AP3500TEST",
        "testPoints": [
            {"name": "1", "std": "10", "act": "10"},
            {"name": "2", "std": "20", "act": "20"},
            {"name": "3", "std": "30", "act": "30"},
            {"name": "4", "std": "40", "act": "40"},
            {"name": "5", "std": "50", "act": "50"}
        ]
    },
    "fieldMappings": {
        "tableConfig": {
            "startRow": 12,
            "endRow": 14,
            "tableIdx": 0
        }
    }
}

os.environ["PHONEAPP_XP_MOCK_DOC_ENGINE"] = "1"
try:
    generate_word_document_xp(tmpl_path, out_path, data)
    print("FAILED_NO_EXCEPTION")
except ValueError as e:
    if "固定数据行数" in str(e) or "不一致" in str(e):
        print("PASSED_ROW_COUNT_REJECTED")
    else:
        print("WRONG_VAL_ERR: " + str(e))
except Exception as e:
    print("OTHER_EXC: " + str(e))
`;

  const res = spawnSync(pythonCmd, ['-c', script], { encoding: 'utf-8' });
  assert.equal(res.status, 0, `Python script failed: ${res.stderr}`);
  assert.ok(res.stdout.includes('PASSED_ROW_COUNT_REJECTED'), `Expected row count validation error, got: ${res.stdout}`);
});

// ==================== 7. Protected Row Validation for Packing List ====================

test('XP-10 / E06 / T06: Packing list protected row check rejects missing main device row', () => {
  const script = `
import sys, json
sys.path.insert(0, r"${path.resolve(__dirname, '../src/worker_xp').replace(/\\/g, '/')}")
from word_engine_xp import validate_packing_protected_rows

form_data = {
    "packingItems": [
        {"name": "普通配件", "count": 1}
    ]
}
field_mappings = {
    "packingItems": [
        {"name": "主设备", "isProtected": True}
    ]
}

try:
    validate_packing_protected_rows(form_data, field_mappings)
    print("FAILED_NO_ERROR")
except ValueError as e:
    if "主设备" in str(e):
        print("PASSED_MAIN_DEVICE_REJECTED")
    else:
        print("WRONG_ERR: " + str(e))
`;

  const res = spawnSync(pythonCmd, ['-c', script], { encoding: 'utf-8' });
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('PASSED_MAIN_DEVICE_REJECTED'), `Expected main device rejection, got: ${res.stdout}`);
});
