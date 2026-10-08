/**
 * 终端配置页与模板启用整改 —— 验收用例（WC-01 ~ WC-26 补充覆盖）
 * 任务书：终端配置页与模板启用整改任务.md
 *
 * 覆盖现有 tests/test_worker_config_and_template_enablement_20260929.test.js 未覆盖的点：
 *  - WC-02 旧地址 / 无 workerId 详情页引导不再空白
 *  - WC-03 打印机区域不误触电脑配置
 *  - WC-06 离线终端不假报通过、配置不丢失
 *  - WC-08 目录联接（junction）/ 符号链接越界拦截
 *  - WC-09 协调电脑存在同名目录但执行端没有该目录
 *  - WC-10 允许创建关闭时不得擅自创建目录
 *  - WC-13 同型号两份文档启用、一份目录无效时不静默降级
 *  - WC-15 / WC-16 任务按 workerId 隔离，不跨终端串配置
 *  - WC-17 迟到检查结果不覆盖新版本，且 checked_at 不被刷新
 *  - WC-18 授权变更未同步不显示可用、待确认终端不默认放开
 *  - WC-21 无目标目录任务拒绝且不回退工作目录
 *  - WC-25 同一公共模板在两个终端各自保存到正确目录
 *  - WC-26 残留（模板已删除）配置不进入手机、但管理端可见可删
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const fixture = path.resolve(__dirname, '../data/test_terminal_config_remediation');
const testDbPath = path.join(fixture, 'terminal_config.db');
process.env.DB_PATH = testDbPath;
// 测试隔离：预览与回传产物不得写入生产 data/previews、data/returned
process.env.PREVIEW_DIR = path.join(path.dirname(testDbPath), 'previews_test_isolated');
process.env.RETURNED_DIR = path.join(path.dirname(testDbPath), 'returned_test_isolated');
process.env.NODE_ENV = 'test';
process.env.PORT = '3061';

if (fs.existsSync(fixture)) fs.rmSync(fixture, { recursive: true, force: true });
fs.mkdirSync(fixture, { recursive: true });

const db = require('../src/backend/db');
const app = require('../src/backend/server');
const ExecutionWorker = require('../src/worker/worker');

const PORT = 3061;
const serverUrl = `http://localhost:${PORT}`;
const ADMIN_HEADERS = { 'Content-Type': 'application/json', 'x-admin-token': 'phoneapp-admin-secret' };

let server;
let certPoaTmpl;
let packPoaTmpl;

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function api(url, options = {}) {
  const res = await fetch(`${serverUrl}${url}`, options);
  let body = null;
  try { body = await res.json(); } catch (e) {}
  return { status: res.status, body };
}

async function heartbeat(workerId, workingDir) {
  return api('/api/workers/heartbeat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workerId, name: `终端-${workerId}`, workingDir, printers: ['测试打印机'] })
  });
}

async function addAllowedPath(workerId, rootPath, opts = {}) {
  return api(`/api/admin/workers/${workerId}/allowed-paths`, {
    method: 'POST',
    headers: ADMIN_HEADERS,
    body: JSON.stringify({
      rootPath,
      allowRead: opts.allowRead !== false,
      allowWrite: opts.allowWrite !== false,
      allowCreate: Boolean(opts.allowCreate)
    })
  });
}

async function saveTemplateConfig(workerId, payload) {
  return api(`/api/admin/workers/${workerId}/template-configs`, {
    method: 'POST',
    headers: ADMIN_HEADERS,
    body: JSON.stringify(payload)
  });
}

function markConfigReady(workerId, templateId, docType, rootDir) {
  db.prepare(`
    INSERT INTO worker_save_configs (worker_id, template_id, doc_type, root_dir, save_mode, subfolder_rule,
      allow_create, is_enabled, version, check_status, check_message, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'direct', 'deviceSn', 1, 1, 1, 'PASSED', '测试预置通过', datetime('now'), datetime('now'))
    ON CONFLICT(worker_id, template_id, doc_type)
    DO UPDATE SET root_dir = excluded.root_dir, is_enabled = 1, check_status = 'PASSED', check_message = '测试预置通过', updated_at = datetime('now')
  `).run(workerId, templateId, docType, rootDir);
}

/** 模拟执行端已确认收到授权（正式链路中由执行端上报 allowed_path 检查结果完成） */
function markAllowedPathsSynced(workerId) {
  db.prepare("UPDATE worker_allowed_paths SET sync_status = 'SYNCED', check_status = 'PASSED', checked_at = datetime('now') WHERE worker_id = ?").run(workerId);
}

/** 预置某终端的授权 + 模板配置，使其成为 EXPLICIT（已确认）状态 */
function presetWorkerAuthAndConfigs(workerId, rootDir, docTypes = ['cert', 'packing']) {
  db.prepare(`
    INSERT INTO worker_allowed_paths (worker_id, root_path, allow_read, allow_write, allow_create, version, sync_status, check_status, created_at, updated_at)
    VALUES (?, ?, 1, 1, 1, 1, 'SYNCED', 'PASSED', datetime('now'), datetime('now'))
    ON CONFLICT(worker_id, root_path) DO UPDATE SET allow_write = 1, sync_status = 'SYNCED', check_status = 'PASSED'
  `).run(workerId, rootDir);
  db.prepare(`
    INSERT INTO worker_auth_state (worker_id, state, updated_at, note) VALUES (?, 'EXPLICIT', datetime('now'), '测试预置已确认')
    ON CONFLICT(worker_id) DO UPDATE SET state = 'EXPLICIT', updated_at = datetime('now')
  `).run(workerId);
  if (docTypes.includes('cert')) markConfigReady(workerId, certPoaTmpl.id, 'cert', rootDir);
  if (docTypes.includes('packing')) markConfigReady(workerId, packPoaTmpl.id, 'packing', rootDir);
}

test.before(async () => {
  await new Promise(resolve => { server = app.listen(PORT, () => resolve()); });
  certPoaTmpl = db.prepare("SELECT * FROM templates WHERE model = 'POA200' AND type = 'cert' AND published_at IS NOT NULL").get();
  packPoaTmpl = db.prepare("SELECT * FROM templates WHERE model = 'POA200' AND type = 'packing' AND published_at IS NOT NULL").get();
  assert.ok(certPoaTmpl, 'POA200 证书模板必须存在（测试需在生产数据副本上运行）');
  assert.ok(packPoaTmpl, 'POA200 装箱清单模板必须存在');
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  try { if (fs.existsSync(fixture)) fs.rmSync(fixture, { recursive: true, force: true }); } catch (e) {}
});

// =====================================================================================
// WC-01 / WC-02 / WC-03：入口、旧地址引导、打印机防误触
// =====================================================================================
test('WC-01/02/03: 终端详情入口存在、旧地址与缺失 workerId 均有明确引导（不空白）、打印机区域不误触', () => {
  const adminHtml = fs.readFileSync(path.resolve(__dirname, '../src/frontend/admin.html'), 'utf-8');
  const adminJs = fs.readFileSync(path.resolve(__dirname, '../src/frontend/admin.js'), 'utf-8');

  // WC-01 详情页与入口
  assert.ok(adminHtml.includes('id="sec-worker-detail"'), 'WC-01: 必须存在终端详情配置区');
  assert.ok(adminHtml.includes('id="allowed-paths-tbody"'), 'WC-01: 详情页必须有授权路径表格');
  assert.ok(adminHtml.includes('id="worker-templates-tbody"'), 'WC-01: 详情页必须有模板启用表格');
  assert.ok(adminJs.includes('async function showWorkerDetail('), 'WC-01: 必须有 showWorkerDetail');
  assert.ok(adminJs.includes('/api/workers?all=true'), 'WC-01: 详情必须按稳定 workerId 拉取终端');

  // WC-02：旧 #directories 入口不得空白 —— 必须落到执行终端列表并给出引导
  assert.ok(adminJs.includes("switchTab('directories')"), 'WC-02: 旧地址必须被显式处理');
  assert.ok(adminHtml.includes('directories-migration-banner'), 'WC-02: 旧地址必须给出引导横幅');
  assert.ok(adminJs.includes("if (isDirectories && t === 'workers')"), 'WC-02: 旧地址必须定位到终端列表');

  // WC-02：直接打开/刷新 #worker-detail（无 workerId）必须显示引导与终端卡片，而不是空白
  assert.ok(adminHtml.includes('id="worker-detail-guidance"'), 'WC-02: 必须存在无终端时的引导区');
  assert.ok(adminJs.includes('renderWorkerDetailGuidance'), 'WC-02: 必须渲染引导或详情');
  assert.ok(adminJs.includes("window.location.hash = '#worker-detail'"), 'WC-02: 缺少 workerId 时必须落到引导路由');

  // 旧保存目录入口不得再出现空白内容区（该 section 已不存在）
  assert.ok(!adminHtml.includes('id="sec-directories"'), 'E01: 不得保留无内容的 sec-directories 空白页');

  // WC-03：打印机区域点击不得进入电脑目录配置
  assert.ok(adminJs.includes('event.stopPropagation()'), 'WC-03: 打印机区域必须 stopPropagation');
  const printerBlock = adminJs.slice(adminJs.indexOf('检测到打印机外设'), adminJs.indexOf('检测到打印机外设') + 400);
  assert.ok(printerBlock.includes('event.stopPropagation()'), 'WC-03: 打印机区域必须阻止冒泡到终端配置');
});

// =====================================================================================
// WC-06 / WC-09 / WC-10：远端检查真实性、离线不假报、不擅自创建目录
// =====================================================================================
test('WC-06/09/10: 检查结果以执行端为准、离线不假报通过、未授权不得创建目录', async () => {
  const workerId = 'worker-tp-remote';
  const workingDir = mkdirp(path.join(fixture, 'work_remote'));
  const worker = new ExecutionWorker({ workerId, name: '远端检查机', serverUrl, workingDir });

  await worker.sendHeartbeat();
  await addAllowedPath(workerId, fixture, { allowCreate: false });

  // WC-09：协调电脑本地存在同名目录，但目标执行端没有该目录 -> 必须以执行端实际结果（失败）为准
  const coordinatorOnlyDir = mkdirp(path.join(process.cwd(), 'data', 'coordinator_only_dir_9'));
  assert.equal(fs.existsSync(coordinatorOnlyDir), true, '协调电脑本地确实存在该目录');
  const workerMissingDir = path.join(fixture, 'worker_missing_dir_9');
  assert.equal(fs.existsSync(workerMissingDir), false, '执行端不存在该目录');

  const cfgRes = await saveTemplateConfig(workerId, {
    templateId: certPoaTmpl.id, docType: 'cert', isEnabled: false,
    rootDir: workerMissingDir, saveMode: 'direct', allowCreate: false
  });
  assert.equal(cfgRes.status, 200, `离线下仍可保存配置 (4.1, WC-06): ${JSON.stringify(cfgRes.body)}`);
  const configId = cfgRes.body.config.id;

  // 离线下检查必须保持待检查，不得假报通过 (WC-06)
  db.prepare("UPDATE workers SET last_heartbeat = '2020-01-01T00:00:00Z' WHERE id = ?").run(workerId);
  const offlineCheck = await api(`/api/admin/workers/${workerId}/template-configs/${configId}/check`, {
    method: 'POST', headers: { 'x-admin-token': 'phoneapp-admin-secret' }
  });
  assert.equal(offlineCheck.status, 400, 'WC-06: 离线检查必须返回失败');
  assert.equal(offlineCheck.body.offline, true, 'WC-06: 必须明确标记离线');
  const cfgAfterOffline = db.prepare('SELECT * FROM worker_save_configs WHERE id = ?').get(configId);
  assert.notEqual(cfgAfterOffline.check_status, 'PASSED', 'WC-06: 离线不得标记为通过');

  // 离线不丢配置 (WC-06)
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM worker_save_configs WHERE worker_id = ?').get(workerId).c, 1, 'WC-06: 离线不得删除已保存配置');

  // 上线后由执行端真实检查：目录不存在且未允许创建 -> FAILED，且不得创建目录 (WC-10)
  await worker.sendHeartbeat();
  const onlineCheck = await api(`/api/admin/workers/${workerId}/template-configs/${configId}/check`, {
    method: 'POST', headers: { 'x-admin-token': 'phoneapp-admin-secret' }
  });
  assert.equal(onlineCheck.status, 200, 'WC-06: 在线后应可下发检查');
  await worker.pollAndExecuteDirectoryChecks();
  const checkedCfg = db.prepare('SELECT * FROM worker_save_configs WHERE id = ?').get(configId);
  assert.equal(checkedCfg.check_status, 'FAILED', 'WC-10: 未允许创建必须检查失败');
  assert.equal(fs.existsSync(workerMissingDir), false, 'WC-10: 不得擅自创建未授权目录');

  // 执行端检查结果必须作用于执行端所在机器：协调电脑同名目录存在不能使检查通过 (WC-09)
  assert.ok(
    checkedCfg.check_message.includes('根目录不存在') || checkedCfg.check_message.includes('未勾选允许创建'),
    `WC-09: 必须以执行端实际检查结果为准，实际为: ${checkedCfg.check_message}`
  );
  fs.rmSync(coordinatorOnlyDir, { recursive: true, force: true });
});

// =====================================================================================
// WC-08：目录联接（junction）/ 符号链接越界拦截
// =====================================================================================
test('WC-08: 允许 D:\\docs 时 D:\\docs-other 与目录联接越界均被拒绝', async (t) => {
  const docsRoot = mkdirp(path.join(fixture, 'docs'));
  const docsOther = mkdirp(path.join(fixture, 'docs-other'));
  const workerId = 'worker-tp-boundary';
  const workingDir = mkdirp(path.join(fixture, 'work_boundary'));
  const worker = new ExecutionWorker({ workerId, name: '边界机', serverUrl, workingDir });
  await worker.sendHeartbeat();
  await addAllowedPath(workerId, docsRoot, { allowCreate: true });

  // 前缀相似目录必须被拒绝（D:\docs 不代表 D:\docs-other）
  const otherCfg = await saveTemplateConfig(workerId, {
    templateId: certPoaTmpl.id, docType: 'cert', isEnabled: true, rootDir: docsOther, allowCreate: true
  });
  assert.equal(otherCfg.status, 400, 'WC-08: docs-other 必须被拒绝');
  assert.ok(/未包含在执行端允许/.test(otherCfg.body.error), `WC-08: 拒绝原因必须说明越界，实际: ${otherCfg.body.error}`);

  // 目录联接越界：在授权目录内建立指向 docs-other 的联接，保存配置必须被拒绝
  const junctionPath = path.join(docsRoot, 'link_to_other');
  let junctionCreated = false;
  try {
    fs.symlinkSync(docsOther, junctionPath, process.platform === 'win32' ? 'junction' : 'dir');
    junctionCreated = true;
  } catch (e) {
    junctionCreated = false;
  }

  if (!junctionCreated) {
    t.diagnostic('当前环境无法创建目录联接（权限不足），已跳过联接越界分支');
  } else {
    const junctionCfg = await saveTemplateConfig(workerId, {
      templateId: certPoaTmpl.id, docType: 'cert', isEnabled: true, rootDir: junctionPath, allowCreate: true
    });
    assert.equal(junctionCfg.status, 400, 'WC-08/6.7: 经目录联接解析后越界必须被拒绝');
  }

  // 合法子目录必须允许
  const subDir = path.join(docsRoot, 'sub_ok');
  const okCfg = await saveTemplateConfig(workerId, {
    templateId: certPoaTmpl.id, docType: 'cert', isEnabled: true, rootDir: subDir, allowCreate: true
  });
  assert.equal(okCfg.status, 200, 'WC-07: 授权范围内的子目录必须允许');
});

// =====================================================================================
// WC-18：授权变更未同步 / 授权范围待确认时不得默认放开
// =====================================================================================
test('WC-18: 授权变更未同步前不显示可用并拒绝写入；待确认终端不默认放开', async () => {
  // --- 场景 1：已确认终端改权限后 sync_status=PENDING，手机不可提交 (WC-18)
  const workerId = 'worker-tp-sync';
  const rootDirA = mkdirp(path.join(fixture, 'sync_root_a'));
  const rootDirB = mkdirp(path.join(fixture, 'sync_root_b'));
  const workingDir = mkdirp(path.join(fixture, 'work_sync'));
  const worker = new ExecutionWorker({ workerId, name: '同步机', serverUrl, workingDir });
  await worker.sendHeartbeat();

  await addAllowedPath(workerId, rootDirA, { allowCreate: true });
  markAllowedPathsSynced(workerId);
  markConfigReady(workerId, certPoaTmpl.id, 'cert', rootDirA);

  const before = await api(`/api/published-bundles?workerId=${workerId}`);
  const beforePoa = before.body.find(b => b.model_display === 'POA200');
  assert.ok(beforePoa, '启用且检查通过后手机应能看到模板');
  assert.equal(beforePoa.is_ready, true, 'WC-18: 同步完成时应显示可用');

  // 管理员修改为另一授权路径（版本+1，sync_status=PENDING，执行端尚未确认）
  const updated = await addAllowedPath(workerId, rootDirA, { allowCreate: true, allowWrite: false });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.allowedPath.sync_status, 'PENDING', 'WC-18: 权限变更必须重新进入待同步');

  const pending = await api(`/api/published-bundles?workerId=${workerId}`);
  const pendingPoa = pending.body.find(b => b.model_display === 'POA200');
  assert.ok(pendingPoa, '模板仍应展示，但必须标记不可用');
  assert.equal(pendingPoa.is_ready, false, 'WC-18: 未同步前不得宣称可用');
  assert.ok(
    pendingPoa.unready_reason.includes('尚未被执行端确认') || pendingPoa.unready_reason.includes('未包含在执行端允许'),
    `WC-18: 必须说明同步或授权原因，实际: ${pendingPoa.unready_reason}`
  );

  // 执行端在撤销写权限后必须拒绝写入（授权已撤销） (WC-18, WC-20)
  const task = {
    id: 8801,
    model: 'POA200',
    device_sn: 'AP10007513',
    files: [{ file_type: 'cert', official_filename: 'sync_reject.doc', target_dir: rootDirA, root_dir: rootDirA }]
  };
  await worker.processTask(task);
  assert.equal(fs.existsSync(path.join(rootDirA, 'sync_reject.doc')), false, 'WC-18/20: 撤销写权限后不得写入文件');

  // --- 场景 2：从未配置授权路径的终端（迁移状态）不默认放开 (7.2)
  const unconfirmedId = 'worker-tp-unconfirmed';
  const unconfirmedDir = mkdirp(path.join(fixture, 'unconfirmed_root'));
  await heartbeat(unconfirmedId, mkdirp(path.join(fixture, 'work_unconfirmed')));
  // 直接写入历史式配置（模拟旧版本升级前的数据）
  db.prepare(`
    INSERT INTO worker_save_configs (worker_id, template_id, doc_type, root_dir, save_mode, allow_create, is_enabled, version, check_status, created_at, updated_at)
    VALUES (?, ?, 'cert', ?, 'direct', 1, 1, 1, 'PASSED', datetime('now'), datetime('now'))
  `).run(unconfirmedId, certPoaTmpl.id, unconfirmedDir);
  db.prepare("DELETE FROM worker_auth_state WHERE worker_id = ?").run(unconfirmedId);

  const unconfirmedBundles = await api(`/api/published-bundles?workerId=${unconfirmedId}`);
  const unconfirmedPoa = unconfirmedBundles.body.find(b => b.model_display === 'POA200');
  assert.ok(unconfirmedPoa, '待确认终端的已启用模板仍应展示（提示管理者处理）');
  assert.equal(unconfirmedPoa.is_ready, false, '7.2: 授权范围未确认时不得默认放开');
  assert.ok(unconfirmedPoa.unready_reason.includes('尚未确认'), `7.2: 必须说明授权范围待确认，实际: ${unconfirmedPoa.unready_reason}`);

  // 执行端同样必须拒绝写入
  const unconfirmedWorker = new ExecutionWorker({ workerId: unconfirmedId, name: '待确认机', serverUrl, workingDir: mkdirp(path.join(fixture, 'work_unconfirmed2')) });
  await unconfirmedWorker.processTask({
    id: 8802, model: 'POA200', device_sn: 'AP10007513',
    files: [{ file_type: 'cert', official_filename: 'unconfirmed.doc', target_dir: unconfirmedDir, root_dir: unconfirmedDir }]
  });
  assert.equal(fs.existsSync(path.join(unconfirmedDir, 'unconfirmed.doc')), false, '7.2: 待确认终端不得写入业务目录');

  // 管理员显式配置路径后进入严格校验并允许写入 (4.2)
  const confirmRes = await addAllowedPath(unconfirmedId, unconfirmedDir, { allowCreate: true });
  assert.equal(confirmRes.status, 200);
  assert.equal(confirmRes.body.authState, 'EXPLICIT', '4.2: 配置业务路径后必须进入已确认状态');
});

// =====================================================================================
// WC-13：两份文档启用、其中一份目录无效 -> 整组不可提交且不静默降级
// =====================================================================================
test('WC-13: 证书与清单均启用但清单目录授权失效时整组不可提交且不降级', async () => {
  const workerId = 'worker-tp-combo';
  const certDir = mkdirp(path.join(fixture, 'combo_cert'));
  const packDir = mkdirp(path.join(fixture, 'combo_pack'));
  const workingDir = mkdirp(path.join(fixture, 'work_combo'));
  await heartbeat(workerId, workingDir);

  // 授权仅覆盖证书目录（清单目录不在授权范围）
  db.prepare(`
    INSERT INTO worker_allowed_paths (worker_id, root_path, allow_read, allow_write, allow_create, version, sync_status, check_status, created_at, updated_at)
    VALUES (?, ?, 1, 1, 1, 1, 'SYNCED', 'PASSED', datetime('now'), datetime('now'))
  `).run(workerId, certDir);
  markConfigReady(workerId, certPoaTmpl.id, 'cert', certDir);
  markConfigReady(workerId, packPoaTmpl.id, 'packing', packDir);

  const bundleRes = await api(`/api/published-bundles?workerId=${workerId}`);
  const poa = bundleRes.body.find(b => b.model_display === 'POA200');
  assert.ok(poa, '整组仍应展示');
  assert.equal(poa.doc_combo, 'cert_and_packing', 'WC-13: 不得静默降级为仅证书');
  assert.equal(poa.is_ready, false, 'WC-13: 一份目录无效则整组不可提交');
  assert.ok(poa.unready_reason.includes('清单'), `WC-13: 必须指出是清单侧问题，实际: ${poa.unready_reason}`);

  // 服务端必须拒绝整组提交
  const submit = await api('/api/tasks/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reqId: `req_combo_${Date.now()}`, clientId: 'c13', clientName: '操作员',
      workerId, model: 'POA200', docCombo: 'cert_and_packing', deviceSn: 'AP10007513'
    })
  });
  assert.equal(submit.status, 400, 'WC-13: 整组必须被拒绝');
  assert.ok(submit.body.error.includes('装箱清单') || submit.body.error.includes('清单'), `WC-13: 必须指出缺失文档，实际: ${submit.body.error}`);
});

// =====================================================================================
// WC-15 / WC-16 / WC-21：任务隔离、跨终端不串配置、无目录拒绝
// =====================================================================================
test('WC-15/16/21: 任务按 workerId 隔离、两终端同模板各自保存到正确目录、缺目标目录拒绝', async () => {
  const workerAId = 'worker-tp-iso-a';
  const workerBId = 'worker-tp-iso-b';
  const dirA = mkdirp(path.join(fixture, 'iso_a'));
  const dirB = mkdirp(path.join(fixture, 'iso_b'));
  const workA = mkdirp(path.join(fixture, 'work_iso_a'));
  const workB = mkdirp(path.join(fixture, 'work_iso_b'));
  const workerA = new ExecutionWorker({ workerId: workerAId, name: '电脑A', serverUrl, workingDir: workA });
  const workerB = new ExecutionWorker({ workerId: workerBId, name: '电脑B', serverUrl, workingDir: workB });

  await workerA.sendHeartbeat();
  await workerB.sendHeartbeat();
  presetWorkerAuthAndConfigs(workerAId, dirA, ['cert']);
  presetWorkerAuthAndConfigs(workerBId, dirB, ['cert']);

  // WC-15/16：两个终端使用同一公共模板但保存目录不同，各自保存到正确目录
  const filenameA = 'WC16_隔离证书_A.doc';
  const filenameB = 'WC16_隔离证书_B.doc';
  await workerA.processTask({
    id: 9101, model: 'POA200', device_sn: 'AP10007513',
    files: [{ file_type: 'cert', official_filename: filenameA, target_dir: dirA, root_dir: dirA }]
  });
  await workerB.processTask({
    id: 9102, model: 'POA200', device_sn: 'AP10007513',
    files: [{ file_type: 'cert', official_filename: filenameB, target_dir: dirB, root_dir: dirB }]
  });
  assert.equal(fs.existsSync(path.join(dirA, filenameA)), true, 'WC-16: 电脑A必须保存到自己的目录');
  assert.equal(fs.existsSync(path.join(dirB, filenameB)), true, 'WC-16: 电脑B必须保存到自己的目录');
  assert.equal(fs.existsSync(path.join(dirA, filenameB)), false, 'WC-16: 不得串写到另一终端目录');
  assert.equal(fs.existsSync(path.join(dirB, filenameA)), false, 'WC-16: 不得串写到另一终端目录');

  // WC-15：任务只分派给目标终端，其他终端领取不到（防篡改 workerId 的跨终端执行）
  const reqIdA = `req_iso_a_${Date.now()}`;
  db.prepare(`
    INSERT INTO tasks (req_id, client_id, client_name, worker_id, model, model_id, bundle_id, device_sn, status, accepted_at, form_data)
    VALUES (?, 'c16', '操作员', ?, 'POA200', 'model_poa200', 'bundle_poa200_full', 'AP10007513', 'QUEUED', datetime('now'), '{}')
  `).run(reqIdA, workerAId);
  const taskRow = db.prepare('SELECT * FROM tasks WHERE req_id = ?').get(reqIdA);
  db.prepare(`
    INSERT INTO task_files (task_id, file_type, official_filename, status, target_dir, root_dir, subfolder_name, dir_config_id, dir_config_version)
    VALUES (?, 'cert', '隔离任务.doc', 'GENERATING', ?, ?, '', 0, 1)
  `).run(taskRow.id, dirA, dirA);

  const pendingB = await api(`/api/worker/tasks/pending?workerId=${workerBId}`);
  assert.equal(pendingB.body.length, 0, 'WC-15: 电脑B不得领取发给电脑A的任务');
  const taskAfterB = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskRow.id);
  assert.equal(taskAfterB.status, 'QUEUED', 'WC-15: 电脑B轮询不得改变任务状态');
  assert.equal(taskAfterB.worker_id, workerAId, 'WC-15: 任务归属不得被其他终端改写');

  const pendingA = await api(`/api/worker/tasks/pending?workerId=${workerAId}`);
  assert.equal(pendingA.body.length, 1, 'WC-15: 目标终端必须能领取自己的任务');
  assert.equal(pendingA.body[0].id, taskRow.id);
  assert.equal(pendingA.body[0].files[0].template_id, certPoaTmpl.id, 'WC-16: 必须解析出正确的模板标识（此前的 ReferenceError 会导致任务永远派发不出去）');

  // WC-21：没有目标目录的任务必须明确拒绝且不回退 workingDir
  await workerA.processTask({
    id: 9103, model: 'POA200', device_sn: 'AP10007513',
    files: [{ file_type: 'cert', official_filename: 'no_target_dir.doc', target_dir: '', root_dir: '' }]
  });
  assert.equal(fs.existsSync(path.join(workA, 'no_target_dir.doc')), false, 'WC-21: 严禁回退到程序工作目录');
  assert.equal(fs.existsSync(path.join(dirA, 'no_target_dir.doc')), false, 'WC-21: 未指定目录不得写入任何业务目录');
});

// =====================================================================================
// WC-17：迟到检查结果不覆盖新版本
// =====================================================================================
test('WC-17: 旧版本迟到检查结果被忽略且不刷新已通过配置的检查时间', async () => {
  const workerId = 'worker-tp-stale';
  const rootDir = mkdirp(path.join(fixture, 'stale_root'));
  await heartbeat(workerId, mkdirp(path.join(fixture, 'work_stale')));

  // 先确认授权范围（管理员配置业务路径 -> EXPLICIT），并模拟执行端已确认同步
  const authRes = await addAllowedPath(workerId, rootDir, { allowCreate: true });
  assert.equal(authRes.status, 200, 'WC-17: 需先确认业务路径授权');
  markAllowedPathsSynced(workerId);

  const cfgRes = await saveTemplateConfig(workerId, {
    templateId: certPoaTmpl.id, docType: 'cert', isEnabled: false, rootDir, saveMode: 'direct', allowCreate: true
  });
  assert.equal(cfgRes.status, 200, `WC-17: 保存目录配置失败: ${JSON.stringify(cfgRes.body)}`);
  const configId = cfgRes.body.config.id;

  // 版本提升到 2 并置为待检查
  db.prepare("UPDATE worker_save_configs SET version = 2, check_status = 'PENDING', check_message = '待重新检查', checked_at = NULL WHERE id = ?").run(configId);

  // 迟到结果（版本 1）必须被忽略
  const staleResult = await api('/api/worker/directory-checks/result', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ checkId: 77001, workerId, checkType: 'save_config', targetId: configId, version: 1, status: 'PASSED', message: '迟到旧结果' })
  });
  assert.equal(staleResult.body.applied, false, 'WC-17: 旧版本结果不得应用');
  const afterStale = db.prepare('SELECT * FROM worker_save_configs WHERE id = ?').get(configId);
  assert.equal(afterStale.check_status, 'PENDING', 'WC-17: 旧结果不得把新配置改为通过');
  assert.equal(afterStale.checked_at, null, 'WC-17: 旧结果不得刷新检查时间');

  // 检查任务不得因过期结果被误标为完成
  const checkRow = db.prepare("SELECT * FROM worker_directory_checks WHERE check_type = 'save_config' AND target_id = ? ORDER BY id DESC").get(configId);
  if (checkRow) {
    assert.notEqual(checkRow.status, 'DONE', 'WC-17: 过期结果不得把检查任务标记为完成');
  }

  // 正确版本结果应用成功
  const freshResult = await api('/api/worker/directory-checks/result', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ checkId: 77002, workerId, checkType: 'save_config', targetId: configId, version: 2, status: 'PASSED', message: '新版本结果' })
  });
  assert.equal(freshResult.body.applied, true, 'WC-17: 当前版本结果必须应用');
  const afterFresh = db.prepare('SELECT * FROM worker_save_configs WHERE id = ?').get(configId);
  assert.equal(afterFresh.check_status, 'PASSED');
  assert.ok(afterFresh.checked_at, 'WC-17: 当前版本结果必须记录检查时间');
});

// =====================================================================================
// WC-14 / WC-26：停用即时生效、残留配置不进入手机
// =====================================================================================
test('WC-14/26: 未启用不因上传自动开放、停用即时拒绝、残留配置不进入手机但管理端可见可删', async () => {
  const workerId = 'worker-tp-enable';
  const rootDir = mkdirp(path.join(fixture, 'enable_root'));
  await heartbeat(workerId, mkdirp(path.join(fixture, 'work_enable')));
  await addAllowedPath(workerId, rootDir, { allowCreate: true });
  markAllowedPathsSynced(workerId);

  // WC-26：新终端 + 未启用模板 -> 手机完全看不到
  const emptyBundles = await api(`/api/published-bundles?workerId=${workerId}`);
  assert.equal(emptyBundles.body.filter(b => b.model_display === 'POA200').length, 0, 'WC-26/WC-04: 未启用不得对手机开放');

  // 管理员显式请求未启用的模板组合必须被拒绝，不得因“上传就开放” (WC-26, WC-14)
  const disabledSubmit = await api('/api/tasks/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reqId: `req_disabled_${Date.now()}`, clientId: 'c26', clientName: '操作员',
      workerId, model: 'POA200', docCombo: 'cert_only', deviceSn: 'AP10007513'
    })
  });
  assert.equal(disabledSubmit.status, 400, 'WC-14: 未启用模板必须拒绝提交');

  // 启用并检查通过后可提交
  const cfgRes = await saveTemplateConfig(workerId, {
    templateId: certPoaTmpl.id, docType: 'cert', isEnabled: true, rootDir, saveMode: 'direct', allowCreate: true
  });
  assert.equal(cfgRes.status, 200);
  db.prepare("UPDATE worker_save_configs SET check_status = 'PASSED', check_message = '测试通过' WHERE id = ?").run(cfgRes.body.config.id);

  const readyBundles = await api(`/api/published-bundles?workerId=${workerId}`);
  const readyPoa = readyBundles.body.find(b => b.model_display === 'POA200');
  assert.ok(readyPoa && readyPoa.is_ready === true, '启用且检查通过后应可提交');

  // WC-14：管理员停用后，服务端必须拒绝新提交（即使手机页面未刷新）
  db.prepare("UPDATE worker_save_configs SET is_enabled = 0 WHERE id = ?").run(cfgRes.body.config.id);
  const afterDisable = await api('/api/tasks/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reqId: `req_after_disable_${Date.now()}`, clientId: 'c26', clientName: '操作员',
      workerId, model: 'POA200', docCombo: 'cert_only', deviceSn: 'AP10007513'
    })
  });
  assert.equal(afterDisable.status, 400, 'WC-14: 停用后必须拒绝新提交');
  assert.ok(/停用|刷新/.test(afterDisable.body.error), `WC-14: 必须提示已停用并刷新，实际: ${afterDisable.body.error}`);

  // WC-26：残留配置（模板记录已删除）不得进入手机，但管理端必须可见并提示处理
  db.prepare(`
    INSERT INTO worker_save_configs (worker_id, template_id, doc_type, root_dir, save_mode, allow_create, is_enabled, version, check_status, created_at, updated_at)
    VALUES (?, 'tmpl_deleted_残留', 'packing', ?, 'direct', 1, 1, 1, 'PASSED', datetime('now'), datetime('now'))
  `).run(workerId, rootDir);

  const orphanBundles = await api(`/api/published-bundles?workerId=${workerId}`);
  assert.equal(orphanBundles.body.filter(b => b.packingTemplate && b.packingTemplate.id === 'tmpl_deleted_残留').length, 0, 'WC-26: 残留配置不得进入手机端');

  const adminConfigs = await api(`/api/admin/workers/${workerId}/template-configs`);
  const orphanEntry = adminConfigs.body.find(c => c.is_orphaned);
  assert.ok(orphanEntry, 'WC-26: 管理端必须显示残留配置以便清理');
  assert.equal(orphanEntry.sync_status, 'ORPHANED');

  const delRes = await api(`/api/admin/workers/${workerId}/template-configs/${orphanEntry.config_id}`, {
    method: 'DELETE', headers: { 'x-admin-token': 'phoneapp-admin-secret' }
  });
  assert.equal(delRes.status, 200, 'WC-26: 必须可以删除残留配置');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM worker_save_configs WHERE id = ?').get(orphanEntry.config_id).c, 0);
});
