/**
 * 终端配置页与模板启用整改 —— 前端渲染验收（轻量 DOM 沙箱，无需浏览器）
 *
 * 目的：验证 E01/WC-02（终端详情与查询页不再空白）、4.2（同步/待确认状态如实展示）、
 * 5（手机端不可提交模板必须显示原因且禁止提交）这些只能从渲染结果看到的结论。
 *
 * 实现：在 Node 沙箱中真实加载 src/frontend/admin.js 与 src/frontend/app.js，
 * 提供最小 DOM/浏览器桩，断言实际写入到元素中的 HTML。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const fixture = path.resolve(__dirname, '../data/test_frontend_remediation');
const testDbPath = path.join(fixture, 'frontend.db');
process.env.DB_PATH = testDbPath;
// 测试隔离：预览与回传产物不得写入生产 data/previews、data/returned
process.env.PREVIEW_DIR = path.join(path.dirname(testDbPath), 'previews_test_isolated');
process.env.RETURNED_DIR = path.join(path.dirname(testDbPath), 'returned_test_isolated');
process.env.NODE_ENV = 'test';

if (fs.existsSync(fixture)) fs.rmSync(fixture, { recursive: true, force: true });
fs.mkdirSync(fixture, { recursive: true });

const db = require('../src/backend/db');
const app = require('../src/backend/server');

let server;
let port;
let serverUrl;

// ---------------------------------------------------------------------------
// 最小 DOM 桩
// ---------------------------------------------------------------------------
function createStyle() {
  return {
    _props: {},
    setProperty(k, v) { this._props[k] = v; },
    get display() { return this._props.display || ''; },
    set display(v) { this._props.display = v; },
    get color() { return this._props.color || ''; },
    set color(v) { this._props.color = v; },
    get background() { return this._props.background || ''; },
    set background(v) { this._props.background = v; },
    get border() { return this._props.border || ''; },
    set border(v) { this._props.border = v; }
  };
}

function createElement(id) {
  const classes = new Set();
  return {
    id,
    innerHTML: '',
    innerText: '',
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    selectedIndex: 0,
    style: createStyle(),
    children: [],
    options: [],
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c) => (classes.has(c) ? classes.delete(c) : classes.add(c))
    },
    setAttribute() {},
    getAttribute() { return null; },
    appendChild(child) { this.children.push(child); this.options.push(child); return child; },
    removeChild() {},
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    click() {}
  };
}

function createSandbox(extraGlobals = {}) {
  const elements = new Map();
  const alerts = [];
  const confirms = [];

  const documentStub = {
    _elements: elements,
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, createElement(id));
      return elements.get(id);
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement(tag) { return createElement(`created-${tag}`); },
    addEventListener() {}
  };

  const sandbox = {
    document: documentStub,
    console,
    fetch,
    FormData,
    URLSearchParams,
    Blob: globalThis.Blob,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    Date,
    Math,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    Promise,
    Map,
    Set,
    parseInt,
    parseFloat,
    isNaN,
    encodeURIComponent,
    decodeURIComponent,
    alert: (msg) => alerts.push(String(msg)),
    confirm: (msg) => { confirms.push(String(msg)); return true; },
    localStorage: {
      _store: {},
      getItem(k) { return Object.prototype.hasOwnProperty.call(this._store, k) ? this._store[k] : null; },
      setItem(k, v) { this._store[k] = String(v); },
      removeItem(k) { delete this._store[k]; }
    },
    location: { origin: serverUrl, hash: '', href: serverUrl },
    ...extraGlobals
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.addEventListener = () => {};
  sandbox.window.location = sandbox.location;

  return { sandbox, elements, alerts, confirms, documentStub };
}

function loadScript(filePath, sandbox) {
  const code = fs.readFileSync(filePath, 'utf-8');
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: filePath });
}

// ---------------------------------------------------------------------------
// 测试数据准备
// ---------------------------------------------------------------------------
let certTmpl;
let packTmpl;
const workerWithConfigId = 'worker-ui-01';
const workerUnconfirmedId = 'worker-ui-02';
const authDir = path.join(fixture, 'ui_docs');

test.before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, () => {
      port = server.address().port;
      serverUrl = `http://localhost:${port}`;
      resolve();
    });
  });

  fs.mkdirSync(authDir, { recursive: true });
  certTmpl = db.prepare("SELECT * FROM templates WHERE model = 'POA200' AND type = 'cert' AND published_at IS NOT NULL").get();
  packTmpl = db.prepare("SELECT * FROM templates WHERE model = 'POA200' AND type = 'packing' AND published_at IS NOT NULL").get();
  assert.ok(certTmpl && packTmpl, '需要已发布的 POA200 证书与清单模板');

  const heartbeat = (id, name) => fetch(`${serverUrl}/api/workers/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workerId: id, name, workingDir: path.join(fixture, `work_${id}`), printers: ['UI测试打印机'] })
  });

  await heartbeat(workerWithConfigId, 'UI测试终端一');
  await heartbeat(workerUnconfirmedId, 'UI测试终端二');

  // 终端一：已确认授权 + 一个未启用但已预配置目录的模板（按需检查） + 一个未同步的授权路径
  db.prepare(`
    INSERT INTO worker_allowed_paths (worker_id, root_path, allow_read, allow_write, allow_create, version, sync_status, check_status, check_message, created_at, updated_at)
    VALUES (?, ?, 1, 1, 0, 1, 'SYNCED', 'PASSED', '检查通过，目录可写', datetime('now'), datetime('now'))
  `).run(workerWithConfigId, authDir);
  db.prepare(`
    INSERT INTO worker_allowed_paths (worker_id, root_path, allow_read, allow_write, allow_create, version, sync_status, check_status, check_message, created_at, updated_at)
    VALUES (?, ?, 1, 1, 0, 3, 'PENDING', 'CHECKING', '正在请求执行端检查...', datetime('now'), datetime('now'))
  `).run(workerWithConfigId, path.join(fixture, 'ui_docs_second'));
  db.prepare(`
    INSERT INTO worker_auth_state (worker_id, state, updated_at, note) VALUES (?, 'EXPLICIT', datetime('now'), '管理员已配置业务路径授权')
  `).run(workerWithConfigId);
  db.prepare(`
    INSERT INTO worker_save_configs (worker_id, template_id, doc_type, root_dir, save_mode, subfolder_rule, allow_create, is_enabled, version, check_status, check_message, created_at, updated_at)
    VALUES (?, ?, 'cert', ?, 'subfolder', 'deviceSn', 0, 0, 2, 'PENDING', '待检查', datetime('now'), datetime('now'))
  `).run(workerWithConfigId, certTmpl.id, authDir);
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  try { if (fs.existsSync(fixture)) fs.rmSync(fixture, { recursive: true, force: true }); } catch (e) {}
});

// =====================================================================================
// E01 / WC-01：终端详情页真实渲染
// =====================================================================================
test('E01/WC-01: 终端详情页渲染终端信息、授权路径表与模板配置表（非空白）', async () => {
  const { sandbox, elements } = createSandbox();
  loadScript(path.resolve(__dirname, '../src/frontend/admin.js'), sandbox);

  await sandbox.showWorkerDetail(workerWithConfigId);

  const title = elements.get('detail-worker-title');
  assert.ok(title && title.innerText.includes('UI测试终端一'), 'E01: 详情页必须显示终端名称');
  const infoHtml = elements.get('detail-worker-info-content').innerHTML;
  assert.ok(infoHtml.includes(workerWithConfigId), 'WC-01: 详情必须显示稳定 workerId');
  assert.ok(infoHtml.includes('程序工作目录'), 'E02: 必须展示程序工作目录且注明非业务授权');
  assert.ok(infoHtml.includes('不构成业务文件访问授权'), 'E02: 工作目录不得被解释为访问白名单');

  const pathHtml = elements.get('allowed-paths-tbody').innerHTML;
  assert.ok(pathHtml.includes(authDir.replace(/\\/g, '\\')), '4.2: 必须渲染授权路径');
  assert.ok(pathHtml.includes('已同步'), '4.2: 已同步授权必须显示已同步');
  assert.ok(pathHtml.includes('待同步'), 'WC-18: 变更未确认的授权必须显示待同步');
  assert.ok(pathHtml.includes('v3'), '4.2: 授权路径必须显示版本');

  const tmplHtml = elements.get('worker-templates-tbody').innerHTML;
  assert.ok(tmplHtml.includes('POA200'), '4.3: 必须列出公共模板');
  assert.ok(tmplHtml.includes('未启用'), '4.3: 新模板默认未启用必须如实显示');
  assert.ok(tmplHtml.includes('deviceSn'), '4.3: 必须显示子文件夹规则');
  assert.ok(tmplHtml.includes('待执行端确认') || tmplHtml.includes('待检查'), '4.3: 配置与检查状态必须显示');
});

// =====================================================================================
// WC-02：旧地址与缺少 workerId 时必须给引导（不空白）
// =====================================================================================
test('WC-02: #directories 与缺少 workerId 的详情地址必须显示引导而非空白', async () => {
  const { sandbox, elements } = createSandbox();

  // 桩：switchTab 由 admin.js 自身提供，这里直接调用并断言显示状态
  loadScript(path.resolve(__dirname, '../src/frontend/admin.js'), sandbox);

  // 场景 1：旧 #directories 入口 -> 终端列表 + 引导横幅
  await sandbox.switchTab('directories');
  const banner = elements.get('directories-migration-banner');
  assert.equal(banner.style.display, 'block', 'WC-02: 旧地址必须显示引导横幅');
  assert.ok(banner.innerHTML === '' || banner.innerHTML.includes('模板启用'), 'WC-02: 引导横幅必须有内容');
  assert.equal(elements.get('sec-workers').style.display, 'block', 'WC-02: 旧地址必须显示终端列表');
  assert.notEqual(elements.get('sec-worker-detail').style.display, 'block', 'WC-02: 旧地址不得落到空白的详情页');

  // 场景 2：缺少 workerId 的详情地址 -> 引导页 + 可选终端卡片
  await sandbox.switchTab('worker-detail');
  assert.equal(elements.get('worker-detail-guidance').style.display, 'block', 'WC-02: 必须显示终端选择引导');
  assert.equal(elements.get('worker-detail-body').style.display, 'none', 'WC-02: 无终端时不得显示空配置区');
  await new Promise(r => setTimeout(r, 200));
  const listHtml = elements.get('worker-detail-guidance-list').innerHTML;
  assert.ok(listHtml.includes(workerWithConfigId), 'WC-02: 引导必须列出可选择的终端');
  assert.ok(listHtml.includes('进入该终端配置'), 'WC-02: 引导必须提供进入配置的操作');

  // 场景 3：带 workerId 的详情地址 -> 隐藏引导、显示配置区
  await sandbox.showWorkerDetail(workerWithConfigId);
  assert.equal(elements.get('worker-detail-guidance').style.display, 'none', 'WC-02: 选定终端后必须隐藏引导');
  assert.equal(elements.get('worker-detail-body').style.display, 'block', 'WC-02: 选定终端后必须显示配置区');
});

// =====================================================================================
// 4.2 / 7.2：待确认终端必须显著提示，不默认放开
// =====================================================================================
test('4.2/7.2: 未确认授权范围的终端必须显示“待确认”提示横幅', async () => {
  const { sandbox, elements } = createSandbox();
  loadScript(path.resolve(__dirname, '../src/frontend/admin.js'), sandbox);

  await sandbox.showWorkerDetail(workerUnconfirmedId);
  const banner = elements.get('auth-state-banner');
  assert.equal(banner.style.display, 'block', '7.2: 待确认终端必须显示提示横幅');
  assert.ok(banner.innerHTML.includes('授权范围尚待确认'), '7.2: 必须明确说明待确认');
  assert.ok(banner.innerHTML.includes('不会默认放开'), '7.2: 必须说明不会默认放开目录');

  const pathHtml = elements.get('allowed-paths-tbody').innerHTML;
  assert.ok(pathHtml.includes('尚未配置任何授权业务路径'), '7.2: 必须提示尚未配置授权路径');
});

// =====================================================================================
// 5：手机端不可提交模板必须显示原因且禁止提交
// =====================================================================================
test('5: 手机端已启用但目录无效的模板必须标记不可提交并阻止提交', async () => {
  const { sandbox, elements, alerts } = createSandbox();

  // 直接加载 app.js，并在沙箱内追加一段测试桥接代码，
  // 用于访问脚本顶层的 const 状态（同一脚本作用域内可见，外部沙箱访问不到）
  const appCode = fs.readFileSync(path.resolve(__dirname, '../src/frontend/app.js'), 'utf-8');
  const bridgeCode = `
    globalThis.__phoneTest = {
      state,
      renderModelSelectOptions,
      submitTaskForm,
      setBundles: (b) => { state.bundles = b; },
      setActiveBundle: (b) => { state.activeBundle = b; },
      setSelectedWorker: (w) => { state.selectedWorker = w; },
      setFetch: (fn) => { globalThis.fetch = fn; }
    };
  `;
  vm.createContext(sandbox);
  vm.runInContext(appCode, sandbox, { filename: 'app.js' });
  vm.runInContext(bridgeCode, sandbox, { filename: 'app-test-bridge.js' });

  const phone = sandbox.__phoneTest;
  assert.ok(phone, '测试桥接必须成功暴露 app.js 内部状态');

  // 构造“已启用但目录未就绪”的组合
  phone.setSelectedWorker({ id: 'worker-ui-01', name: 'UI测试终端一' });
  phone.setBundles([
    {
      id: 'bundle_ready', model_display: 'POA200', option_name: '带泵', doc_combo: 'cert_only',
      is_ready: true, unready_reason: ''
    },
    {
      id: 'bundle_unready', model_display: 'POA300', option_name: '通用', doc_combo: 'cert_and_packing',
      is_ready: false, unready_reason: '装箱清单保存目录检查未通过(PENDING: 待检查)'
    }
  ]);

  phone.renderModelSelectOptions();

  const selectHtml = elements.get('model-select').innerHTML;
  assert.ok(selectHtml.includes('bundle_ready'), '5: 就绪模板必须显示');
  assert.ok(!/value="bundle_ready"[^>]*disabled/.test(selectHtml), '5: 就绪模板不得禁用');
  assert.ok(/value="bundle_unready"[^>]*disabled/.test(selectHtml), '5: 未就绪模板必须禁止选择');
  assert.ok(selectHtml.includes('不可提交'), '5: 未就绪模板必须显示不可提交标记');

  const statusHtml = elements.get('model-load-status').innerHTML;
  assert.ok(statusHtml.includes('装箱清单保存目录检查未通过'), '5: 必须显示不可用原因');
  assert.equal(elements.get('model-load-status').style.display, 'block', '5: 必须提示用户');

  // 提交被拒：即使前端被绕过，也不得发起提交请求
  phone.setActiveBundle({
    id: 'bundle_unready', model_display: 'POA300', doc_combo: 'cert_and_packing',
    is_ready: false, unready_reason: '装箱清单保存目录检查未通过(PENDING: 待检查)'
  });
  const deviceSnEl = elements.get('device-sn') || sandbox.document.getElementById('device-sn');
  deviceSnEl.value = 'AP10007513';

  let submitCalled = false;
  const originalFetch = sandbox.fetch;
  phone.setFetch((...args) => {
    if (String(args[0]).includes('/api/tasks/submit')) submitCalled = true;
    return originalFetch(...args);
  });

  await phone.submitTaskForm();
  assert.equal(submitCalled, false, '5: 未就绪模板必须在前端被拦截，不得提交');
  assert.ok(alerts.some(a => a.includes('不可用') && a.includes('装箱清单')), `5: 必须提示不可用原因，实际弹窗: ${JSON.stringify(alerts)}`);
});
