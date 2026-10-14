/**
 * Windows XP (Win32) Standalone Execution Worker Protocol & Compatibility Test
 * (phoneApp-20261008-XP)
 *
 * Verifies:
 * 1. Syntax compatibility: NO Python 3.6+ f-strings, NO type annotations, NO async/await in src/worker_xp/*.py
 * 2. Protocol alignment: Heartbeat, directory checks, task claiming, template download, file return upload,
 *    protected row check failure reporting, and print job handling via worker_xp.py
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const testRunDir = path.resolve(__dirname, '../data/test_tmp_xp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
fs.mkdirSync(testRunDir, { recursive: true });

const testDbPath = path.join(testRunDir, 'test.db');
process.env.DB_PATH = testDbPath;
process.env.PREVIEW_DIR = path.join(testRunDir, 'previews');
process.env.RETURNED_DIR = path.join(testRunDir, 'returned');
process.env.INTERNAL_PORT = '3096';

const configDir = path.join(testRunDir, 'config');
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(path.join(configDir, 'worker_config.json'), JSON.stringify({
  _comment: 'XP Worker Test Config', autoDetectPrinters: true, allowedPrinters: ['XP_Test_Printer']
}, null, 2));
process.env.PHONEAPP_CONFIG_DIR = configDir;

const app = require('../src/backend/server');
const db = require('../src/backend/db');

const PORT = 3095;
const INTERNAL = 3096;
const serverUrl = `http://127.0.0.1:${INTERNAL}`;

let server;
let internalServer;

test.before(async () => {
  await new Promise(resolve => { server = app.listen(PORT, '0.0.0.0', () => resolve()); });
  await new Promise(resolve => { internalServer = app.listen(INTERNAL, '0.0.0.0', () => resolve()); });
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (internalServer) await new Promise(resolve => internalServer.close(resolve));
  try {
    fs.rmSync(testRunDir, { recursive: true, force: true });
  } catch (e) {}
});

const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';

function runPythonWorker(args, env = {}) {
  return new Promise((resolve, reject) => {
    const script = path.resolve(__dirname, '../src/worker_xp/worker_xp.py');
    const child = spawn(pythonCmd, [script, ...args], {
      env: { ...process.env, PHONEAPP_CONFIG_DIR: configDir, ...env }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.on('error', err => reject(err));
  });
}

// ==================== Step 1: Syntax Compatibility Check ====================

test('XP Worker Python Syntax Compatibility: No f-strings, No type hints, No async/await', () => {
  const workerXpDir = path.resolve(__dirname, '../src/worker_xp');
  assert.ok(fs.existsSync(workerXpDir), 'src/worker_xp directory must exist');

  const pyFiles = fs.readdirSync(workerXpDir).filter(f => f.endsWith('.py'));
  assert.ok(pyFiles.length >= 4, 'Must contain python engine files (worker_xp, word_engine_xp, printer_engine_xp, config_manager_xp)');

  for (const pyFile of pyFiles) {
    const filePath = path.join(workerXpDir, pyFile);
    const content = fs.readFileSync(filePath, 'utf-8');

    // 1. Check for f-strings: f"..." or f'...'
    const fStringRegex = /\bf["']/;
    assert.equal(fStringRegex.test(content), false, `File ${pyFile} must NOT contain f-strings (Python 3.6+ feature)`);

    // 2. Check for async/await
    assert.equal(/\basync\s+def\b/.test(content), false, `File ${pyFile} must NOT contain async def`);
    assert.equal(/\bawait\s+/.test(content), false, `File ${pyFile} must NOT contain await`);

    // 3. Check for type annotations in function signatures: def foo(...) -> ...:
    assert.equal(/def\s+\w+\([^)]*\)\s*->/.test(content), false, `File ${pyFile} must NOT contain return type annotations`);

    // 4. Verify syntax compilation with pythonCmd
    const compileRes = spawnSync(pythonCmd, ['-m', 'py_compile', filePath], { encoding: 'utf-8' });
    assert.equal(compileRes.status, 0, `File ${pyFile} failed python syntax compilation: ${compileRes.stderr}`);
  }
});

// ==================== Step 2: Protocol Integration Tests ====================

test('XP Worker Config Loading & Persistence', () => {
  const pythonScript = path.resolve(__dirname, '../src/worker_xp/config_manager_xp.py');
  const res = spawnSync(pythonCmd, [pythonScript], {
    encoding: 'utf-8',
    env: { ...process.env, PHONEAPP_CONFIG_DIR: configDir }
  });
  assert.equal(res.status, 0, `config_manager_xp.py execution failed: ${res.stderr}`);
  assert.ok(res.stdout.includes('Loaded Config:'), 'Must output Loaded Config');

  const localConfigFile = path.join(configDir, 'worker_config.local.json');
  assert.ok(fs.existsSync(localConfigFile), 'Local config file worker_config.local.json must be persisted');

  const localData = JSON.parse(fs.readFileSync(localConfigFile, 'utf-8'));
  assert.ok(localData.workerId && localData.workerId.startsWith('worker-'), 'Must contain generated workerId');
  assert.ok(localData.workerSecret, 'Must contain generated workerSecret');
});

test('XP Worker Heartbeat Protocol & Directory Check Execution', async () => {
  const workerId = 'worker-xp-test-01';

  // Seed pending directory check
  const checkDir = path.join(testRunDir, 'authorized_xp_save_dir');
  fs.mkdirSync(checkDir, { recursive: true });

  // Grant authorization for workerId
  db.prepare(`
    INSERT INTO worker_allowed_paths (worker_id, root_path, allow_read, allow_write, created_at, updated_at)
    VALUES (?, ?, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(workerId, checkDir);

  const saveCfg = db.prepare(`
    INSERT INTO worker_save_configs (worker_id, template_id, doc_type, root_dir, is_enabled, version, check_status, created_at, updated_at)
    VALUES (?, 'tmpl_poa200_cert', 'cert', ?, 1, 1, 'PENDING', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(workerId, checkDir);

  const configId = saveCfg.lastInsertRowid;

  db.prepare(`
    INSERT INTO worker_directory_checks (check_type, target_id, config_id, worker_id, version, root_dir, allow_create, allow_read, allow_write, status, created_at)
    VALUES ('save_config', ?, ?, ?, 1, ?, 1, 1, 1, 'PENDING', CURRENT_TIMESTAMP)
  `).run(configId, configId, workerId, checkDir);

  const runRes = await runPythonWorker([
    '--server', serverUrl,
    '--worker-id', workerId,
    '--name', 'XP Worker Unit Test',
    '--working-dir', testRunDir,
    '--once'
  ]);

  assert.equal(runRes.code, 0, `worker_xp.py execution failed: ${runRes.stderr}`);
  assert.ok(runRes.stdout.includes('ONLINE'), 'Output should indicate ONLINE status');

  // Verify worker record in DB
  const workerRow = db.prepare('SELECT * FROM workers WHERE id = ?').get(workerId);
  assert.ok(workerRow, 'Worker must be registered in DB via heartbeat');
  assert.equal(workerRow.status, 'ONLINE');

  // Verify directory check result
  const updatedCfg = db.prepare('SELECT * FROM worker_save_configs WHERE id = ?').get(configId);
  assert.equal(updatedCfg.check_status, 'PASSED', 'Directory check status should be updated to PASSED');
});

test('XP Worker Task Claiming, Document Generation, and File Return', async () => {
  const workerId = 'worker-xp-test-task';

  // Set up authorized directory
  const saveDir = path.join(testRunDir, 'authorized_task_save_dir');
  fs.mkdirSync(saveDir, { recursive: true });

  db.prepare(`
    INSERT INTO worker_allowed_paths (worker_id, root_path, allow_read, allow_write, created_at, updated_at)
    VALUES (?, ?, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(workerId, saveDir);

  const taskId = 8801;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO tasks (id, req_id, client_id, client_name, worker_id, model, device_sn, status, accepted_at, form_data)
    VALUES (?, ?, 'client-xp', 'XP Tester', ?, 'POA200', 'AP10007513', 'QUEUED', ?, ?)
  `).run(taskId, 'req-xp-8801', workerId, now, JSON.stringify({
    ambientTemp: '25.0',
    relativeHumidity: '45.0',
    testPoints: [{ name: 'Point 1', std: '10.0', act: '9.98' }]
  }));

  db.prepare(`
    INSERT INTO task_files (task_id, file_type, official_filename, target_dir, root_dir, status)
    VALUES (?, 'cert', 'POA200_AP10007513_Cert.doc', ?, ?, 'PENDING')
  `).run(taskId, saveDir, saveDir);

  const runRes = await runPythonWorker([
    '--server', serverUrl,
    '--worker-id', workerId,
    '--name', 'XP Task Worker Test',
    '--working-dir', testRunDir,
    '--once'
  ], { PHONEAPP_XP_MOCK_DOC_ENGINE: '1' });

  assert.equal(runRes.code, 0, `worker_xp.py task execution failed: ${runRes.stderr}`);

  // Check file in DB
  const taskFile = db.prepare('SELECT * FROM task_files WHERE task_id = ? AND file_type = ?').get(taskId, 'cert');
  assert.ok(
    ['CONVERTING_PDF', 'CONVERTING_IMAGE', 'PREVIEW_READY', 'PREVIEW_FAILED'].includes(taskFile.status),
    `Task file status must be updated upon file return (actual: ${taskFile.status})`
  );
  assert.ok(taskFile.sha256, 'Task file record must contain returned SHA-256 hash');

  const returnedFilePath = path.join(saveDir, 'POA200_AP10007513_Cert.doc');
  assert.ok(fs.existsSync(returnedFilePath), 'Generated document must exist in target directory');
});

test('XP Worker Packing Protected Row Check Failure Reporting (E06, T06)', async () => {
  const workerId = 'worker-xp-test-protected';

  const saveDir = path.join(testRunDir, 'authorized_packing_dir');
  fs.mkdirSync(saveDir, { recursive: true });

  db.prepare(`
    INSERT INTO worker_allowed_paths (worker_id, root_path, allow_read, allow_write, created_at, updated_at)
    VALUES (?, ?, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(workerId, saveDir);

  const taskId = 8802;
  const now = new Date().toISOString();

  // Invalid packing items missing main device row
  db.prepare(`
    INSERT INTO tasks (id, req_id, client_id, client_name, worker_id, model, device_sn, status, accepted_at, form_data)
    VALUES (?, ?, 'client-xp', 'XP Tester', ?, 'POA200', 'AP10007513', 'QUEUED', ?, ?)
  `).run(taskId, 'req-xp-8802', workerId, now, JSON.stringify({
    packingItems: [
      { name: '配件说明书', spec: 'A4', count: '1', unit: '本' }
    ]
  }));

  db.prepare(`
    INSERT INTO task_files (task_id, file_type, official_filename, target_dir, root_dir, status)
    VALUES (?, 'packing', 'POA200_Packing.doc', ?, ?, 'PENDING')
  `).run(taskId, saveDir, saveDir);

  const runRes = await runPythonWorker([
    '--server', serverUrl,
    '--worker-id', workerId,
    '--name', 'XP Protected Check Worker Test',
    '--working-dir', testRunDir,
    '--once'
  ]);

  assert.equal(runRes.code, 0, `worker_xp.py protected check execution failed: ${runRes.stderr}`);

  const taskFile = db.prepare('SELECT * FROM task_files WHERE task_id = ? AND file_type = ?').get(taskId, 'packing');
  assert.equal(taskFile.status, 'FAILED', 'Task file status must be FAILED when protected row check fails');
  assert.ok(taskFile.error_msg.includes('Main device row') || taskFile.error_msg.includes('protected row'), 'Error message must explain protected row failure');
});

test('XP Worker Print Job Handling Protocol', async () => {
  const workerId = 'worker-xp-test-print';

  const saveDir = path.join(testRunDir, 'authorized_print_dir');
  fs.mkdirSync(saveDir, { recursive: true });

  const dummyDoc = path.join(saveDir, 'printable_doc.doc');
  fs.writeFileSync(dummyDoc, 'Dummy Word Content For Print Test', 'utf-8');

  db.prepare(`
    INSERT INTO worker_allowed_paths (worker_id, root_path, allow_read, allow_write, created_at, updated_at)
    VALUES (?, ?, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(workerId, saveDir);

  const jobId = 9901;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO print_jobs (id, request_id, client_id, worker_id, printer_name, batch_items, status, created_at)
    VALUES (?, 'req-print-9901', 'client-xp', ?, 'XP_Test_Printer', '[]', 'QUEUED', ?)
  `).run(jobId, workerId, now);

  db.prepare(`
    INSERT INTO print_job_items (print_job_id, task_id, task_file_id, file_type, copies, snapshot_path, status, created_at)
    VALUES (?, 8801, 501, 'cert', 1, ?, 'QUEUED', ?)
  `).run(jobId, dummyDoc, now);

  const runRes = await runPythonWorker([
    '--server', serverUrl,
    '--worker-id', workerId,
    '--name', 'XP Print Worker Test',
    '--working-dir', testRunDir,
    '--once'
  ]);

  assert.equal(runRes.code, 0, `worker_xp.py print execution failed: ${runRes.stderr}`);

  const printItem = db.prepare('SELECT * FROM print_job_items WHERE print_job_id = ?').get(jobId);
  assert.notEqual(printItem.status, 'QUEUED', 'Print job item must be processed and no longer QUEUED');
  assert.ok(['SUBMITTED_TO_SPOOLER', 'RESULT_UNKNOWN', 'FAILED'].includes(printItem.status), `Print item status should be updated (actual: ${printItem.status})`);
});

// ==================== Step 3: Win32/XP Bug Fix Regressions (XP-L01 ~ XP-L07) ====================

test('XP-L01 & XP-L02: Launcher and Build Scripts CRLF & Missing Python Error Handling', () => {
  const rootDir = path.resolve(__dirname, '..');
  const launcherPath = path.join(rootDir, '启动XP执行端.bat');
  const buildBatPath = path.join(rootDir, 'src/worker_xp/build_xp.bat');

  assert.ok(fs.existsSync(launcherPath), '启动XP执行端.bat must exist');
  assert.ok(fs.existsSync(buildBatPath), 'build_xp.bat must exist');

  // Check CRLF line endings
  const launcherRaw = fs.readFileSync(launcherPath);
  const launcherCrlf = (launcherRaw.toString().match(/\r\n/g) || []).length;
  const launcherLfOnly = (launcherRaw.toString().match(/[^\r]\n/g) || []).length;
  assert.ok(launcherCrlf > 0, '启动XP执行端.bat must contain CRLF line endings');
  assert.equal(launcherLfOnly, 0, '启动XP执行端.bat must NOT contain bare LF line endings');

  const buildRaw = fs.readFileSync(buildBatPath);
  const buildCrlf = (buildRaw.toString().match(/\r\n/g) || []).length;
  const buildLfOnly = (buildRaw.toString().match(/[^\r]\n/g) || []).length;
  assert.ok(buildCrlf > 0, 'build_xp.bat must contain CRLF line endings');
  assert.equal(buildLfOnly, 0, 'build_xp.bat must NOT contain bare LF line endings');

  // Verify missing python execution simulation on Windows
  if (process.platform === 'win32') {
    const res = spawnSync('cmd.exe', ['/c', 'set PATH=C:\\Windows\\system32 & call 启动XP执行端.bat < nul'], {
      cwd: rootDir,
      encoding: 'utf-8'
    });
    assert.equal(res.status, 1, '启动XP执行端.bat must exit with code 1 when python is missing');
    assert.ok(
      res.stdout.includes('Python environment not found') || res.stdout.includes('未检测到 Python 环境'),
      'Output must clearly report missing Python environment'
    );
    assert.equal(res.stdout.includes('此时不应有'), false, 'Must not crash with syntax error (此时不应有)');

    // Also verify build_xp.bat does not crash with syntax error (XP-L01/L02)
    const buildRes = spawnSync('cmd.exe', ['/c', 'set PATH=C:\\Windows\\system32 & call src\\worker_xp\\build_xp.bat < nul'], {
      cwd: rootDir,
      encoding: 'utf-8'
    });
    assert.equal(buildRes.status, 1, 'build_xp.bat must exit with code 1 when python is missing');
    assert.ok(
      buildRes.stdout.includes('Python environment not found'),
      'Output must clearly report missing Python environment'
    );
    assert.equal(buildRes.stdout.includes('此时不应有'), false, 'build_xp.bat must not crash with syntax error (此时不应有)');
  }
});

test('XP-L03: get_base_dir consistency and unified config location', () => {
  const pyCode = `
import sys, os
sys.path.insert(0, r"${path.resolve(__dirname, '../src/worker_xp').replace(/\\/g, '\\\\')}")
import config_manager_xp

# Case 1: Source mode
base_src = config_manager_xp.get_base_dir()
print("SRC_BASE:" + base_src)

# Case 2: Simulated frozen mode inside src/worker_xp/dist
sys.frozen = True
sys.executable = r"${path.resolve(__dirname, '../src/worker_xp/dist/worker_xp.exe').replace(/\\/g, '\\\\')}"
base_frozen = config_manager_xp.get_base_dir()
print("FROZEN_BASE:" + base_frozen)
`;
  const res = spawnSync(pythonCmd, ['-c', pyCode], {
    encoding: 'utf-8',
    env: { ...process.env, PHONEAPP_CONFIG_DIR: '' }
  });
  assert.equal(res.status, 0, `Python execution failed: ${res.stderr}`);

  const lines = res.stdout.split(/\r?\n/).filter(Boolean);
  const srcBase = lines.find(l => l.startsWith('SRC_BASE:')).slice('SRC_BASE:'.length);
  const frozenBase = lines.find(l => l.startsWith('FROZEN_BASE:')).slice('FROZEN_BASE:'.length);

  const expectedRoot = path.resolve(__dirname, '..');
  assert.equal(path.resolve(srcBase), expectedRoot, 'Source mode base_dir must resolve to project root');
  assert.equal(path.resolve(frozenBase), expectedRoot, 'Frozen exe inside dist must resolve to project root, avoiding second identity');
});

test('XP-L04 & XP-L05: Python Chinese Name and String Handling without UnicodeEncodeError', async () => {
  const workerId = 'worker-xp-chinese-test';
  const chineseName = '中文XP执行端测试终端';

  const runRes = await runPythonWorker([
    '--server', serverUrl,
    '--worker-id', workerId,
    '--name', chineseName,
    '--working-dir', testRunDir,
    '--once'
  ]);

  assert.equal(runRes.code, 0, `worker_xp.py failed with Chinese name: ${runRes.stderr}`);
  assert.ok(runRes.stdout.includes('ONLINE'), 'Must successfully register and report ONLINE');

  const workerRow = db.prepare('SELECT * FROM workers WHERE id = ?').get(workerId);
  assert.ok(workerRow, 'Worker record must exist in DB');
  assert.equal(workerRow.name, chineseName, 'Worker name in DB must match Chinese name');
});

test('XP-L06: Corrupted or Read-Only worker_config.local.json error handling', () => {
  const badConfigDir = path.join(testRunDir, 'bad_config_dir');
  fs.mkdirSync(badConfigDir, { recursive: true });

  // Corrupted JSON
  const corruptedLocalCfg = path.join(badConfigDir, 'worker_config.local.json');
  fs.writeFileSync(corruptedLocalCfg, '{ bad_json: invalid syntax !!!', 'utf-8');

  const pyCheckCorrupted = `
import sys, os
sys.path.insert(0, r"${path.resolve(__dirname, '../src/worker_xp').replace(/\\/g, '\\\\')}")
from config_manager_xp import load_worker_config
try:
    cfg = load_worker_config(custom_base_dir=r"${badConfigDir.replace(/\\/g, '\\\\')}")
    print("SHOULD_HAVE_FAILED")
except RuntimeError as e:
    print("CAUGHT_CORRUPTED:" + str(e))
`;
  const res = spawnSync(pythonCmd, ['-c', pyCheckCorrupted], { encoding: 'utf-8' });
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('CAUGHT_CORRUPTED'), 'Must reject corrupted config and raise RuntimeError');
  assert.equal(res.stdout.includes('SHOULD_HAVE_FAILED'), false, 'Must NOT proceed or overwrite corrupted file');
});

test('XP-L07: Real Doc Write Verification & Rejection of Template Copy', () => {
  // When Word/WPS COM is unavailable and PHONEAPP_XP_MOCK_DOC_ENGINE is not set:
  // generate_word_document_xp must raise RuntimeError and NOT return empty template as success
  const testDocDir = path.join(testRunDir, 'doc_test_dir');
  fs.mkdirSync(testDocDir, { recursive: true });

  const dummyTemplate = path.join(testDocDir, 'template.doc');
  fs.writeFileSync(dummyTemplate, 'Original Dummy Template Content (R17)', 'utf-8');

  const outDoc = path.join(testDocDir, 'generated.doc');

  const pyVerifyDoc = `
import sys, os
sys.path.insert(0, r"${path.resolve(__dirname, '../src/worker_xp').replace(/\\/g, '\\\\')}")
from word_engine_xp import generate_word_document_xp
try:
    res = generate_word_document_xp(
        r"${dummyTemplate.replace(/\\/g, '\\\\')}",
        r"${outDoc.replace(/\\/g, '\\\\')}",
        {"type": "cert", "formData": {}}
    )
    print("FAKE_SUCCESS")
except RuntimeError as e:
    print("CORRECT_REJECTION:" + str(e))
`;
  const res = spawnSync(pythonCmd, ['-c', pyVerifyDoc], {
    encoding: 'utf-8',
    env: { ...process.env, PHONEAPP_XP_MOCK_DOC_ENGINE: '' }
  });

  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('CORRECT_REJECTION'), 'Must reject document generation when COM engine is unavailable');
  assert.equal(res.stdout.includes('FAKE_SUCCESS'), false, 'Must NOT pretend document was successfully written');
  assert.equal(fs.existsSync(outDoc), false, 'Failed output document should be deleted, not kept as blank template');
});

test('REV183 §3.1: Shared worker_config.json serverUrl is ignored', () => {
  const sharedDir = path.join(testRunDir, 'shared_cfg_dir');
  fs.mkdirSync(sharedDir, { recursive: true });

  // shared config contains serverUrl (simulating distributed package)
  fs.writeFileSync(path.join(sharedDir, 'worker_config.json'), JSON.stringify({
    serverUrl: 'http://192.168.1.99:3001'
  }, null, 2));

  const pyCheckShared = `
import sys, os
sys.path.insert(0, r"${path.resolve(__dirname, '../src/worker_xp').replace(/\\/g, '\\\\')}")
from config_manager_xp import load_worker_config
cfg = load_worker_config([], custom_base_dir=r"${sharedDir.replace(/\\/g, '\\\\')}")
print("RESOLVED_SERVER:" + str(cfg["serverUrl"]))
`;
  const res = spawnSync(pythonCmd, ['-c', pyCheckShared], {
    encoding: 'utf-8',
    env: { ...process.env, PHONEAPP_SERVER: '', COORDINATOR_SERVER: '', SERVER_URL: '', WORKER_SERVER_URL: '', WORKER_PORT: '', INTERNAL_PORT: '', PYTHONIOENCODING: 'utf-8' }
  });
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('RESOLVED_SERVER:http://127.0.0.1:3001'), 'Must ignore shared serverUrl and fall back to default');
  assert.ok(res.stderr.includes('已忽略') || res.stderr.includes('serverUrl'), 'Must print warning about ignoring shared serverUrl');
});

// ==================== Step 5: XP 20261009 Delivery Specification Tests ====================

test('XP-D01: coordinator.defaults.json priority & credential safety (方案§1, §4)', () => {
  const defaultsTestDir = path.join(testRunDir, 'defaults_cfg_test');
  fs.mkdirSync(defaultsTestDir, { recursive: true });

  // 1. Valid defaults.json with serverUrl
  fs.writeFileSync(path.join(defaultsTestDir, 'coordinator.defaults.json'), JSON.stringify({
    serverUrl: 'http://192.168.1.183:3001',
    workerSecret: 'STOLEN_SECRET_SHOULD_BE_IGNORED',
    workerId: 'worker-stolen'
  }, null, 2));

  const pyCheckDefaults = `
import sys, os
sys.path.insert(0, r"${path.resolve(__dirname, '../src/worker_xp').replace(/\\/g, '\\\\')}")
from config_manager_xp import load_worker_config
cfg = load_worker_config([], custom_base_dir=r"${defaultsTestDir.replace(/\\/g, '\\\\')}")
print("RESOLVED_SERVER:" + str(cfg["serverUrl"]))
print("SOURCE:" + str(cfg["sources"].get("server")))
print("WORKER_ID:" + str(cfg["workerId"]))
print("SECRET_LEAK:" + str("STOLEN_SECRET_SHOULD_BE_IGNORED" in cfg.get("workerSecret", "")))
`;
  const res = spawnSync(pythonCmd, ['-c', pyCheckDefaults], {
    encoding: 'utf-8',
    env: { ...process.env, PHONEAPP_SERVER: '', COORDINATOR_SERVER: '', SERVER_URL: '', WORKER_SERVER_URL: '', WORKER_PORT: '', INTERNAL_PORT: '', PYTHONIOENCODING: 'utf-8' }
  });

  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('RESOLVED_SERVER:http://192.168.1.183:3001'), 'Must resolve server from coordinator.defaults.json');
  assert.ok(res.stdout.includes('SOURCE:defaults_file'), 'Source must be defaults_file');
  assert.equal(res.stdout.includes('WORKER_ID:worker-stolen'), false, 'Must NOT inherit stolen workerId from defaults file');
  assert.ok(res.stdout.includes('SECRET_LEAK:False'), 'Must NOT inherit credentials from defaults file');
  assert.ok(res.stderr.includes('严禁携带终端身份与密钥') || res.stderr.includes('忽略'), 'Must issue security warning on stolen credential in defaults');
});

test('XP-D02: Diagnose Mode (--diagnose) Environment Self-Check & Desensitization (方案§4, §7)', () => {
  const pyDiagnose = `
import sys, os
sys.path.insert(0, r"${path.resolve(__dirname, '../src/worker_xp').replace(/\\/g, '\\\\')}")
from config_manager_xp import run_diagnose_checks
res = run_diagnose_checks(custom_base_dir=r"${configDir.replace(/\\/g, '\\\\')}")
print("DIAGNOSE_RETURN:" + str(res.get("bits")))
`;
  const res = spawnSync(pythonCmd, ['-c', pyDiagnose], {
    encoding: 'utf-8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
  });

  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('Windows XP (Win32) Worker Diagnostic Check'), 'Must output diagnostic header');
  assert.ok(res.stdout.includes('操作系统与运行环境'), 'Must check OS & runtime');
  assert.ok(res.stdout.includes('目录与读写权限'), 'Must test data directory write permissions');
  assert.ok(res.stdout.includes('办公组件与 COM 自动化'), 'Must check COM status');
  assert.ok(res.stdout.includes('系统打印机检测'), 'Must detect installed printers');
  assert.ok(res.stdout.includes('终端身份与配置 (严格脱敏)'), 'Must include desensitized config block');

  // Verify secret is NOT printed
  const localCfg = JSON.parse(fs.readFileSync(path.join(configDir, 'worker_config.local.json'), 'utf-8'));
  const secret = localCfg.workerSecret;
  if (secret) {
    assert.equal(res.stdout.includes(secret), false, 'Diagnostic output must NEVER contain raw workerSecret!');
  }
});

test('XP-D03: Configure Mode (run_interactive_configure) Updates Local Config (方案§4, §5)', () => {
  const cfgTestDir = path.join(testRunDir, 'interactive_cfg_test');
  fs.mkdirSync(cfgTestDir, { recursive: true });

  const pyConfigure = `
import sys, os
sys.path.insert(0, r"${path.resolve(__dirname, '../src/worker_xp').replace(/\\/g, '\\\\')}")
from config_manager_xp import run_interactive_configure, load_worker_config

# Test 1: invalid URL format
res_fail = run_interactive_configure(
    custom_base_dir=r"${cfgTestDir.replace(/\\/g, '\\\\')}",
    input_prompt_fn=lambda msg: "invalid_url_without_http"
)
print("INVALID_CODE:" + str(res_fail))

# Test 2: valid URL update
res_ok = run_interactive_configure(
    custom_base_dir=r"${cfgTestDir.replace(/\\/g, '\\\\')}",
    input_prompt_fn=lambda msg: "http://192.168.1.200:3001"
)
print("VALID_CODE:" + str(res_ok))

cfg_after = load_worker_config([], custom_base_dir=r"${cfgTestDir.replace(/\\/g, '\\\\')}")
print("AFTER_URL:" + str(cfg_after["serverUrl"]))
`;
  const res = spawnSync(pythonCmd, ['-c', pyConfigure], {
    encoding: 'utf-8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
  });

  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('INVALID_CODE:1'), 'Invalid URL must return error code 1');
  assert.ok(res.stdout.includes('VALID_CODE:0'), 'Valid URL must return success code 0');
  assert.ok(res.stdout.includes('AFTER_URL:http://192.168.1.200:3001'), 'Must update serverUrl in local config');
});

test('XP-D04: Release Package Scripts & Spec Packaging Artifacts (方案§4)', () => {
  const workerXpDir = path.resolve(__dirname, '../src/worker_xp');

  // Verify all required files exist
  const requiredFiles = [
    'StartWorker.cmd',
    'ConfigureWorker.cmd',
    'DiagnoseWorker.cmd',
    'coordinator.defaults.json',
    'version.json',
    'worker_xp.spec',
    'README-部署与故障排查.md',
    'build_kit/requirements-xp.txt'
  ];

  for (const relFile of requiredFiles) {
    const fullPath = path.join(workerXpDir, relFile);
    assert.ok(fs.existsSync(fullPath), `Required artifact ${relFile} must exist`);
  }

  // Verify cmd scripts are pure ASCII and use CRLF line endings
  const cmdScripts = ['StartWorker.cmd', 'ConfigureWorker.cmd', 'DiagnoseWorker.cmd'];
  for (const script of cmdScripts) {
    const buf = fs.readFileSync(path.join(workerXpDir, script));
    const str = buf.toString('binary');

    // 1. CRLF check
    assert.ok(str.includes('\r\n'), `${script} must use Windows CRLF line endings`);
    assert.equal(str.replace(/\r\n/g, '').includes('\n'), false, `${script} must NOT contain bare LF`);

    // 2. ASCII check: all byte values must be <= 127
    let isAscii = true;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] > 127) {
        isAscii = false;
        break;
      }
    }
    assert.ok(isAscii, `${script} must contain strictly ASCII characters for XP cmd.exe compatibility`);
  }

  // Verify version.json specifies x86 32-bit and XP SP3
  const versionData = JSON.parse(fs.readFileSync(path.join(workerXpDir, 'version.json'), 'utf-8'));
  assert.equal(versionData.targetOS, 'Windows XP SP3 (x86)');
  assert.equal(versionData.arch, 'x86 (32-bit)');
});

test('XP-D05: ActivePrinter switch failure halts printing (方案§2)', () => {
  // Test code verification: if ActivePrinter fails, print_document_xp returns stage 'printer-switch-failed' and success=False
  const pyActivePrinterTest = `
import sys, os
sys.path.insert(0, r"${path.resolve(__dirname, '../src/worker_xp').replace(/\\/g, '\\\\')}")
import printer_engine_xp

# Inspect function source to confirm ActivePrinter failure stops execution
import inspect
src = inspect.getsource(printer_engine_xp.print_document_xp)
assert "printer-switch-failed" in src, "Must return printer-switch-failed stage on ActivePrinter error"
assert "无法将打印机切换到指定目标" in src, "Must log specific error and halt execution"
print("ACTIVE_PRINTER_SAFETY_VERIFIED")
`;
  const res = spawnSync(pythonCmd, ['-c', pyActivePrinterTest], {
    encoding: 'utf-8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
  });
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('ACTIVE_PRINTER_SAFETY_VERIFIED'));
});

test('XP-D06: Remote Template Download and Normalized Model Resolution', async () => {
  const workerId = 'worker-xp-test-tmpl-dl';

  // 1. Create a dummy template on server side
  const serverTmplDir = path.join(testRunDir, 'server_uploads');
  fs.mkdirSync(serverTmplDir, { recursive: true });
  const dummyTmplPath = path.join(serverTmplDir, 'remote_PGA500_Cert.doc');
  fs.writeFileSync(dummyTmplPath, 'Mock Remote PGA500 Template Content', 'utf-8');

  const tmplId = 'tmpl_pga500_test_dl';
  const dummyTmplHash = crypto.createHash('sha256').update(fs.readFileSync(dummyTmplPath)).digest('hex');
  db.prepare(`
    INSERT OR REPLACE INTO templates (id, model, type, filename, filepath, file_hash, version, field_mappings, published_at)
    VALUES (?, 'PGA500-Ex', 'cert', 'PGA500_Cert.doc', ?, ?, 'v1.0', '{}', CURRENT_TIMESTAMP)
  `).run(tmplId, dummyTmplPath, dummyTmplHash);

  // 2. Set up authorized directory for worker
  const saveDir = path.join(testRunDir, 'authorized_pga_save_dir');
  fs.mkdirSync(saveDir, { recursive: true });

  db.prepare(`
    INSERT INTO worker_allowed_paths (worker_id, root_path, allow_read, allow_write, created_at, updated_at)
    VALUES (?, ?, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(workerId, saveDir);

  const taskId = 8803;
  const now = new Date().toISOString();

  // Task requesting model 'PGA500-Ex'
  db.prepare(`
    INSERT INTO tasks (id, req_id, client_id, client_name, worker_id, model, device_sn, status, accepted_at, form_data)
    VALUES (?, 'req-xp-8803', 'client-xp', 'XP Tester', ?, 'PGA500-Ex', 'EX20000608', 'QUEUED', ?, ?)
  `).run(taskId, workerId, now, JSON.stringify({}));

  db.prepare(`
    INSERT INTO task_files (task_id, file_type, official_filename, target_dir, root_dir, status)
    VALUES (?, 'cert', 'PGA500_EX20000608_Cert.doc', ?, ?, 'PENDING')
  `).run(taskId, saveDir, saveDir);

  // Worker runs in its own isolated working directory where dummyTmplPath does not exist locally
  const workerWorkDir = path.join(testRunDir, 'worker_xp_isolated_dir');
  fs.mkdirSync(workerWorkDir, { recursive: true });

  const runRes = await runPythonWorker([
    '--server', serverUrl,
    '--worker-id', workerId,
    '--name', 'XP Template DL Worker Test',
    '--working-dir', workerWorkDir,
    '--once'
  ], { PHONEAPP_XP_MOCK_DOC_ENGINE: '1' });

  assert.equal(runRes.code, 0, `worker_xp.py failed: ${runRes.stderr}`);

  // 3. Verify cached template was downloaded locally with safe ASCII name
  const cachedTmplFile = path.join(workerWorkDir, 'cached_templates', `${tmplId}.doc`);
  assert.ok(fs.existsSync(cachedTmplFile), `Template must be downloaded to cached_templates/${tmplId}.doc`);
  assert.equal(fs.readFileSync(cachedTmplFile, 'utf-8'), 'Mock Remote PGA500 Template Content');

  // 4. Verify task file was generated
  const taskFile = db.prepare('SELECT * FROM task_files WHERE task_id = ? AND file_type = ?').get(taskId, 'cert');
  assert.ok(['CONVERTING_PDF', 'CONVERTING_IMAGE', 'PREVIEW_READY', 'PREVIEW_FAILED'].includes(taskFile.status), `Task file status must be updated (actual: ${taskFile.status})`);
});



