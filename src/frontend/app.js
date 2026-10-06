/**
 * phoneApp Mobile & Workstation Client Logic (手机/车间作业端)
 * Rules: M01 - M15, F01-F16, G01-G12, 03-Spec Section 6-7
 */

const API_BASE = window.location.origin;

// HTML Escape Helper (R01, P01)
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Safe JSON Fetch helper (Handles HTML and non-JSON responses cleanly)
async function safeFetchJson(url, options = {}) {
  let res;
  try {
    res = await fetch(url, options);
  } catch (netErr) {
    throw new Error('网络请求异常: ' + netErr.message);
  }

  const contentType = res.headers.get('content-type') || '';
  let data;
  if (contentType.includes('application/json')) {
    try {
      data = await res.json();
    } catch (parseErr) {
      throw new Error('解析服务响应失败: ' + parseErr.message);
    }
  } else {
    const text = await res.text();
    const shortText = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 150);
    throw new Error(`服务响应非 JSON 格式 (HTTP ${res.status}): ${shortText || '空内容'}`);
  }

  if (!res.ok) {
    throw new Error(data.error || `请求失败 (HTTP ${res.status})`);
  }
  return data;
}

const state = {
  clientId: localStorage.getItem('phoneapp_client_id') || '',
  clientName: localStorage.getItem('phoneapp_user_name') || '',
  selectedWorker: null,
  workers: [],
  bundles: [],
  salesPersons: [],
  sensorConfigs: [],
  sensorConfigLoadFailed: false,
  activeBundle: null,
  currentModel: 'POA200',
  hasPump: true,
  currentTask: null,
  activePreviewType: 'cert',
  historyRange: 'today',
  testPoints: [],
  packingItems: []
};


// ==================== INITIALIZATION ====================
window.addEventListener('DOMContentLoaded', async () => {
  initClientIdentity();
  initFormDefaults();
  await loadSensorConfigs();
  await loadPublishedBundles();
  await loadSalesPersons();
  await loadWorkers();
  await syncClientNameFromServer();

  const savedWorkerId = localStorage.getItem('phoneapp_selected_worker_id');
  if (savedWorkerId) {
    const found = state.workers.find(w => w.id === savedWorkerId && w.status === 'ONLINE');
    if (found) {
      selectWorker(found, false);
    }
  }

  if (!state.selectedWorker) {
    switchNavTab('workers');
  }

  setInterval(loadWorkers, 5000);
  setInterval(syncClientNameFromServer, 5000);
});

// ==================== CLIENT IDENTITY ====================
function initClientIdentity() {
  if (!state.clientId) {
    state.clientId = 'client_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
    localStorage.setItem('phoneapp_client_id', state.clientId);
  }

  if (state.clientName) {
    document.getElementById('user-name-display').innerText = state.clientName;
  } else {
    state.clientName = '操作员-' + state.clientId.slice(-4);
    document.getElementById('user-name-display').innerText = state.clientName;
    saveUserNameToServer(state.clientName);
  }
}

async function syncClientNameFromServer() {
  if (!state.clientId) return;
  try {
    const res = await fetch(`${API_BASE}/api/clients/${state.clientId}`);
    if (res.ok) {
      const client = await res.json();
      if (client && client.name && client.name !== state.clientName) {
        state.clientName = client.name;
        localStorage.setItem('phoneapp_user_name', client.name);
        document.getElementById('user-name-display').innerText = client.name;
      }
    }
  } catch (e) {}
}

function openNameModal() {
  document.getElementById('client-id-display').value = state.clientId;
  document.getElementById('user-name-input').value = state.clientName;
  document.getElementById('name-modal').classList.add('active');
}

function closeNameModal() {
  document.getElementById('name-modal').classList.remove('active');
}

async function saveInitialUserName() {
  const name = document.getElementById('user-name-input').value.trim();
  if (!name) return alert('姓名不能为空');

  state.clientName = name;
  localStorage.setItem('phoneapp_user_name', name);
  document.getElementById('user-name-display').innerText = name;
  closeNameModal();

  await saveUserNameToServer(name);
}

async function saveUserNameToServer(name) {
  try {
    await fetch(`${API_BASE}/api/clients/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: state.clientId, name })
    });
  } catch (err) {
    console.warn('Register client name error:', err);
  }
}

// ==================== WORKER SELECTION & MONITORING ====================
async function loadWorkers() {
  try {
    const res = await fetch(`${API_BASE}/api/workers`);
    const workers = await res.json();
    state.workers = workers;

    renderWorkerCards(workers);

    if (state.selectedWorker) {
      const current = workers.find(w => w.id === state.selectedWorker.id);
      if (current) {
        state.selectedWorker = current;
        updateWorkerUI(current);
      }
    }
  } catch (err) {
    console.warn('Load workers error:', err);
  }
}

function renderWorkerCards(workers) {
  const container = document.getElementById('worker-cards-list');
  if (!container) return;

  if (workers.length === 0) {
    container.innerHTML = `
      <div class="card" style="text-align: center; padding: 28px 16px;">
        <div style="font-size: 32px; margin-bottom: 8px;">⏳</div>
        <b>未检测到在线执行电脑终端</b>
        <p style="font-size: 13px; color: #64748b; margin-top: 6px;">
          请在执行电脑上双击运行 <code>启动执行端.bat</code>，执行服务启动后将自动在此呈现。
        </p>
      </div>
    `;
    return;
  }

  container.innerHTML = workers.map(w => {
    const isOnline = w.status === 'ONLINE';
    const isSelected = state.selectedWorker && state.selectedWorker.id === w.id;
    const printerDetails = w.printerDetails || [];

    const printerTagsHtml = printerDetails.length > 0 
      ? printerDetails.map(p => `
          <span class="printer-tag ${p.isShared ? 'shared' : (p.isVirtual ? '' : 'physical')}">
            ${p.isShared ? '🖨️ [共享]' : (p.isVirtual ? '📄 [虚拟]' : '🖨️ [物理]')} ${p.name}
          </span>
        `).join('')
      : '<span style="font-size: 12px; color: #94a3b8;">未连接或未配置打印机</span>';

    return `
      <div class="worker-card ${isSelected ? 'active-worker' : ''}">
        <div class="worker-card-header">
          <div class="worker-card-title">💻 ${w.name}</div>
          <span class="badge ${isOnline ? 'badge-success' : 'badge-danger'}">
            ${isOnline ? '🟢 在线就绪' : '🔴 离线'}
          </span>
        </div>
        <div class="worker-meta">
          <div><b>终端标识:</b> ${w.id} | <b>IP地址:</b> ${w.ip || '127.0.0.1'}</div>
          <div><b>工作目录:</b> ${w.working_dir || '默认目录'}</div>
          <div style="margin-top: 4px;"><b>检测到打印机:</b></div>
        </div>
        <div class="printer-tags">
          ${printerTagsHtml}
        </div>
        <div style="display: flex; justify-content: flex-end; margin-top: 8px;">
          <button type="button" class="btn ${isSelected ? 'btn-success' : 'btn-primary'}" 
                  onclick="selectWorkerById('${w.id}')">
            ${isSelected ? '✔ 当前已连接此终端' : '👉 选择此终端并前往发货'}
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function selectWorkerById(workerId) {
  const worker = state.workers.find(w => w.id === workerId);
  if (worker) {
    selectWorker(worker, true);
  }
}

async function selectWorker(worker, shouldSwitchTab = true) {
  const prevWorkerId = state.selectedWorker ? state.selectedWorker.id : null;
  state.selectedWorker = worker;
  localStorage.setItem('phoneapp_selected_worker_id', worker.id);
  updateWorkerUI(worker);

  // Clear previous template selection when switching worker (Section 5, WC-11)
  if (prevWorkerId !== worker.id) {
    state.activeBundle = null;
    state.currentModel = '';
  }

  // Reload published bundles and sensor configs for this specific worker (Section 5, WC-11, WC-12)
  await loadSensorConfigs();
  await loadPublishedBundles(worker.id);

  if (shouldSwitchTab) {
    switchNavTab('create');
  }
}

function updateWorkerUI(worker) {
  const currentWorkerEl = document.getElementById('current-worker-name');
  if (currentWorkerEl) {
    currentWorkerEl.innerText = worker ? `${worker.name} (在线)` : '未选择终端';
  }

  const assignedWorkerEl = document.getElementById('task-assigned-worker');
  if (assignedWorkerEl) {
    assignedWorkerEl.innerText = worker ? `${worker.name} (${worker.ip || '127.0.0.1'})` : '未选择执行终端';
  }

  const submitBtn = document.getElementById('btn-submit-task');
  if (submitBtn) {
    submitBtn.innerText = worker ? `确认并提交至 [${worker.name}] 排队处理` : '请先选择执行终端';
  }

  if (worker) {
    updatePrinterDropdown(worker.printers || []);
  }
}

// ==================== DYNAMIC FORM RENDERER (03 SPEC SECTION 6 & 7) ====================
async function loadPublishedBundles(workerId = null) {
  const targetWorkerId = workerId || (state.selectedWorker ? state.selectedWorker.id : null);
  const statusEl = document.getElementById('model-load-status');
  const retryBtn = document.getElementById('btn-retry-bundles');
  const select = document.getElementById('model-select');

  if (statusEl) {
    statusEl.style.display = 'block';
    statusEl.className = 'status-tip info';
    statusEl.innerHTML = '⏳ 正在加载已发布的模板配置...';
  }
  if (retryBtn) retryBtn.style.display = 'none';

  try {
    const url = targetWorkerId 
      ? `${API_BASE}/api/published-bundles?workerId=${encodeURIComponent(targetWorkerId)}`
      : `${API_BASE}/api/published-bundles`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const bundles = await res.json();
    state.bundles = Array.isArray(bundles) ? bundles : [];

    if (state.bundles.length === 0) {
      if (select) select.innerHTML = '<option value="">(暂无可用的已启用模板)</option>';
      if (statusEl) {
        statusEl.style.display = 'block';
        statusEl.className = 'status-tip warning';
        const wName = state.selectedWorker ? state.selectedWorker.name : (targetWorkerId || '当前执行端');
        statusEl.innerHTML = `ℹ️ 执行端 [${wName}] 暂未启用任何模板配置。请前往协调服务管理后台（<a href="/admin" target="_blank" style="color: #0284c7; text-decoration: underline;">/admin</a>）在终端详情页配置并启用模板。`;
      }
      if (retryBtn) retryBtn.style.display = 'none';
      onModelChange();
    } else {
      if (statusEl) statusEl.style.display = 'none';
      if (retryBtn) retryBtn.style.display = 'none';
      renderModelSelectOptions();
    }
  } catch (e) {
    console.warn('Load published bundles error:', e);
    if (select) select.innerHTML = '<option value="">(加载失败 - 协调服务未就绪或版本过旧)</option>';
    if (statusEl) {
      statusEl.style.display = 'block';
      statusEl.className = 'status-tip error';
      statusEl.innerHTML = '⚠️ 协调服务未就绪或版本过旧 (404/异常)，请确认后端协调服务已升级并已重启。';
    }
    if (retryBtn) retryBtn.style.display = 'inline-block';
    state.bundles = [];
    onModelChange();
  }
}

function renderModelSelectOptions() {
  const select = document.getElementById('model-select');
  if (!select) return;

  if (!state.bundles || state.bundles.length === 0) {
    select.innerHTML = '<option value="">(暂无已发布模板配置)</option>';
    onModelChange();
    return;
  }

  select.innerHTML = state.bundles.map(b => {
    let comboText = ' (带清单)';
    if (b.doc_combo === 'cert_only') comboText = ' (仅证书)';
    if (b.doc_combo === 'packing_only') comboText = ' (仅清单)';

    const optName = b.option_name && b.option_name !== '通用' ? ` - ${b.option_name}` : '';
    return `<option value="${b.id}">${b.model_display}${optName}${comboText}</option>`;
  }).join('');

  onModelChange();
}

function initFormDefaults() {
  const today = new Date().toISOString().slice(0, 10);
  const dateInput = document.getElementById('cert-date');
  if (dateInput) dateInput.value = today;

  if (document.getElementById('ambient-temp')) document.getElementById('ambient-temp').value = '22.1';
  if (document.getElementById('relative-humidity')) document.getElementById('relative-humidity').value = '50%RH';
}

function onModelChange() {
  const select = document.getElementById('model-select');
  if (!select) return;

  const bundleId = select.value;
  const bundle = state.bundles.find(b => b.id === bundleId) || state.bundles[0];
  state.activeBundle = bundle;

  if (!bundle) return;

  state.currentModel = bundle.model_display;

  const docCombo = bundle.doc_combo;
  const showCert = docCombo === 'cert_and_packing' || docCombo === 'cert_only';
  const showPacking = docCombo === 'cert_and_packing' || docCombo === 'packing_only';

  const currentModelStr = (bundle.model_display || bundle.model || '').trim();
  const matchedConfig = state.sensorConfigs.find(c => (c.model || '').trim().toLowerCase() === currentModelStr.toLowerCase());

  // Toggle UI sections dynamically based on Published Bundle & Sensor Config
  const pumpGroup = document.getElementById('pump-group');
  const sensorModelGroup = document.getElementById('sensor-model-group');
  const salesPersonGroup = document.getElementById('sales-person-group');
  const certFieldsGroup = document.getElementById('cert-fields-card');
  const testPointsCard = document.getElementById('test-points-card');
  const packingSection = document.getElementById('packing-section');

  // Smart pump switch logic (Requirement 3):
  // Show pump switch button ONLY if:
  // 1) doc_combo contains packing list (cert_and_packing or packing_only)
  // 2) associated template filename contains "带泵"
  const packingFilename = bundle.packingTemplate?.filename || '';
  const certFilename = bundle.certTemplate?.filename || '';
  const hasPackingDoc = docCombo === 'cert_and_packing' || docCombo === 'packing_only';
  const tmplHasPumpKeyword = packingFilename.includes('带泵') || certFilename.includes('带泵');

  const shouldShowPump = hasPackingDoc && tmplHasPumpKeyword;

  if (pumpGroup) {
    pumpGroup.style.display = shouldShowPump ? 'block' : 'none';
  }

  if (!shouldShowPump) {
    setPumpOption(false);
  } else {
    setPumpOption(true);
  }

  refreshSensorOptions();

  if (salesPersonGroup) salesPersonGroup.style.display = showCert ? 'block' : 'none';
  if (certFieldsGroup) certFieldsGroup.style.display = showCert ? 'block' : 'none';
  if (testPointsCard) testPointsCard.style.display = showCert ? 'block' : 'none';
  if (packingSection) packingSection.style.display = showPacking ? 'block' : 'none';

  if (showCert) {
    initTestPointsForModel();
  } else {
    state.testPoints = [];
    const tbody = document.getElementById('test-points-body');
    if (tbody) tbody.innerHTML = '';
  }

  if (showPacking) {
    initPackingItemsForModel();
  } else {
    state.packingItems = [];
    const tbody = document.getElementById('packing-items-body');
    if (tbody) tbody.innerHTML = '';
  }
}

async function loadSensorConfigs() {
  try {
    const list = await safeFetchJson(`${API_BASE}/api/sensor-configs`);
    state.sensorConfigs = Array.isArray(list) ? list : [];
    state.sensorConfigLoadFailed = false;
  } catch (e) {
    console.warn('Load sensor configs error:', e);
    state.sensorConfigs = [];
    state.sensorConfigLoadFailed = true;
  }
  refreshSensorOptions();
}

function refreshSensorOptions() {
  const sensorModelGroup = document.getElementById('sensor-model-group');
  const select = document.getElementById('sensor-model');
  const statusTip = document.getElementById('sensor-config-status');
  const retryBtn = document.getElementById('btn-retry-sensor-configs');
  if (!sensorModelGroup || !select) return;

  if (state.sensorConfigLoadFailed) {
    sensorModelGroup.style.display = 'block';
    if (statusTip) {
      statusTip.style.display = 'block';
      statusTip.className = 'status-tip error';
      statusTip.innerHTML = '⚠️ 传感器可选配置加载失败，请重试';
    }
    if (retryBtn) retryBtn.style.display = 'inline-block';
    return;
  }

  if (statusTip) statusTip.style.display = 'none';
  if (retryBtn) retryBtn.style.display = 'none';

  const bundle = state.activeBundle;
  const currentModelStr = (bundle ? (bundle.model_display || bundle.model || '') : state.currentModel || '').trim();
  const matchedConfig = state.sensorConfigs.find(c => (c.model || '').trim().toLowerCase() === currentModelStr.toLowerCase());

  if (matchedConfig && Array.isArray(matchedConfig.sensor_options) && matchedConfig.sensor_options.length > 0) {
    sensorModelGroup.style.display = 'block';
    const options = matchedConfig.sensor_options;
    const defaultVal = matchedConfig.default_value || options[0] || '';
    const currentVal = select.value;

    select.innerHTML = options.map(opt => `<option value="${escapeHtml(opt)}">${escapeHtml(opt)}</option>`).join('');

    if (currentVal && options.includes(currentVal)) {
      select.value = currentVal;
    } else {
      select.value = defaultVal;
      if (currentVal && !options.includes(currentVal)) {
        alert(`已选择的传感器型号 [${currentVal}] 在最新配置中已失效或被删除，已自动重置为默认值 [${defaultVal}]，请核对。`);
      }
    }
  } else {
    sensorModelGroup.style.display = 'none';
    select.innerHTML = '';
  }
}

async function loadSalesPersons() {
  const select = document.getElementById('sales-person');
  if (!select) return;

  try {
    const list = await safeFetchJson(`${API_BASE}/api/sales-persons`);
    state.salesPersons = Array.isArray(list) ? list : [];

    if (state.salesPersons.length === 0) {
      select.innerHTML = '<option value="陈文">陈文</option>';
      return;
    }

    select.innerHTML = state.salesPersons.map(sp => `<option value="${escapeHtml(sp.name)}">${escapeHtml(sp.name)}</option>`).join('');
  } catch (e) {
    console.warn('Load sales persons error:', e);
    select.innerHTML = '<option value="陈文">陈文</option>';
  }
}

function populateSensorModelOptionsByConfig(matchedConfig, bundle) {
  const select = document.getElementById('sensor-model');
  if (!select) return;

  let options = matchedConfig.sensor_options || [];
  let defaultVal = matchedConfig.default_value || options[0] || '';

  select.innerHTML = options.map(opt => `<option value="${escapeHtml(opt)}" ${opt === defaultVal ? 'selected' : ''}>${escapeHtml(opt)}</option>`).join('');
}

function populateSensorModelOptions(bundle) {
  const select = document.getElementById('sensor-model');
  if (!select) return;

  let options = ['PSR-12-223(封装）', 'PMT210SEN'];
  let defaultVal = 'PSR-12-223(封装）';

  if (bundle && bundle.certTemplate && bundle.certTemplate.field_mappings) {
    const config = bundle.certTemplate.field_mappings.sensorModelConfig;
    if (config && Array.isArray(config.options) && config.options.length > 0) {
      options = config.options;
      if (config.defaultValue) defaultVal = config.defaultValue;
    }
  }

  select.innerHTML = options.map(opt => `<option value="${escapeHtml(opt)}" ${opt === defaultVal ? 'selected' : ''}>${escapeHtml(opt)}</option>`).join('');
}

function setPumpOption(hasPump) {
  state.hasPump = hasPump;
  document.getElementById('pump-yes').className = hasPump ? 'toggle-btn active' : 'toggle-btn';
  document.getElementById('pump-no').className = !hasPump ? 'toggle-btn active' : 'toggle-btn';
  syncDeviceSnToPackingList();
}

function getActiveTestPointColumns(tc) {
  if (tc && Array.isArray(tc.columns) && tc.columns.length > 0) {
    return [...tc.columns].sort((a, b) => (a.colIdx ?? 0) - (b.colIdx ?? 0));
  }
  const cols = [];
  if (tc && tc.pointCol) {
    cols.push({
      key: 'name',
      label: tc.headers?.point || tc.pointCol.label || '序号/测试点',
      colIdx: tc.pointCol.colIdx ?? 0,
      isSeq: true,
      role: 'seq'
    });
  } else {
    cols.push({
      key: 'name',
      label: (tc && tc.headers?.point) || '序号/测试点',
      colIdx: 0,
      isSeq: true,
      role: 'seq'
    });
  }
  if (tc && tc.standardCol) {
    cols.push({
      key: 'std',
      label: tc.headers?.standard || tc.standardCol.label || '标准值',
      colIdx: tc.standardCol.colIdx ?? 1,
      isStd: true,
      role: 'standard'
    });
  } else {
    cols.push({
      key: 'std',
      label: (tc && tc.headers?.standard) || '标准值',
      colIdx: 1,
      isStd: true,
      role: 'standard'
    });
  }
  if (tc && tc.actualCol) {
    cols.push({
      key: 'act',
      label: tc.headers?.actual || tc.actualCol.label || '实测值',
      colIdx: tc.actualCol.colIdx ?? 2,
      isAct: true,
      role: 'actual'
    });
  } else {
    cols.push({
      key: 'act',
      label: (tc && tc.headers?.actual) || '实测值',
      colIdx: 2,
      isAct: true,
      role: 'actual'
    });
  }
  cols.sort((a, b) => (a.colIdx ?? 0) - (b.colIdx ?? 0));
  return cols;
}

function initTestPointsForModel() {
  const bundle = state.activeBundle;
  const certTmpl = bundle ? bundle.certTemplate : null;
  const snapshot = bundle ? bundle.config_snapshot : {};
  const tc = (certTmpl && certTmpl.field_mappings && certTmpl.field_mappings.tableConfig)
    || (snapshot && snapshot.tableConfig);
  const columns = getActiveTestPointColumns(tc);

  let pts = (certTmpl && certTmpl.field_mappings && certTmpl.field_mappings.testPoints)
    || (snapshot && snapshot.testPoints);

  if ((!pts || pts.length === 0) && tc && tc.rowCount > 0) {
    pts = [];
    for (let i = 0; i < tc.rowCount; i++) {
      const rowItem = {
        point: i + 1,
        values: {}
      };
      columns.forEach(col => {
        let val = (col.defaultValues && col.defaultValues[i]) ? col.defaultValues[i] : '';
        if (col.isSeq && !val) val = String(i + 1);
        rowItem.values[col.key] = val;
        rowItem.values[String(col.colIdx)] = val;
        rowItem.values[col.label] = val;
      });
      pts.push(rowItem);
    }
  }

  pts = pts || [];
  state.testPoints = pts.map((p, i) => {
    const values = { ...(p.values || {}) };
    columns.forEach(col => {
      if (values[col.key] === undefined) {
        if (values[String(col.colIdx)] !== undefined) {
          values[col.key] = values[String(col.colIdx)];
        } else if (values[col.label] !== undefined) {
          values[col.key] = values[col.label];
        } else if (col.isSeq) {
          values[col.key] = p.name || p.label || String(i + 1);
        } else if (col.isStd) {
          values[col.key] = p.std !== undefined ? p.std : (p.standard || '');
        } else if (col.isAct) {
          values[col.key] = p.act !== undefined ? p.act : (p.actual || '');
        } else if (col.defaultValues && col.defaultValues[i]) {
          values[col.key] = col.defaultValues[i];
        } else {
          values[col.key] = '';
        }
      }
    });

    let ptName = p.name || p.label;
    const seqCol = columns.find(c => c.isSeq);
    if (seqCol && values[seqCol.key]) {
      ptName = values[seqCol.key];
    } else if (!ptName && tc && tc.pointNames && tc.pointNames[i]) {
      ptName = tc.pointNames[i];
    }

    const stdCol = columns.find(c => c.isStd);
    let stdVal = p.std !== undefined ? p.std : (p.standard || '');
    if (stdCol && values[stdCol.key] !== undefined) {
      stdVal = values[stdCol.key];
    }

    const actCol = columns.find(c => c.isAct);
    let actVal = p.act !== undefined ? p.act : (p.actual || '');
    if (actCol && values[actCol.key] !== undefined) {
      actVal = values[actCol.key];
    }

    return {
      point: p.point || i + 1,
      name: ptName || `测试点 ${i + 1}`,
      std: stdVal,
      act: actVal,
      values
    };
  });

  renderTestPoints();
}

function renderTestPoints() {
  const tbody = document.getElementById('test-points-body');
  if (!tbody) return;

  const bundle = state.activeBundle;
  const certTmpl = bundle ? bundle.certTemplate : null;
  const tc = certTmpl && certTmpl.field_mappings ? certTmpl.field_mappings.tableConfig : null;
  const columns = getActiveTestPointColumns(tc);

  // Render Table Headers <thead> in exact template order with exact template names!
  const thead = document.getElementById('test-points-thead');
  if (thead) {
    let thHtml = '<tr>';
    columns.forEach(col => {
      let title = col.label || '列';
      thHtml += `<th class="col-test-dyn">${escapeHtml(title)}</th>`;
    });
    thHtml += '<th style="width: 70px; text-align: center;">操作</th></tr>';
    thead.innerHTML = thHtml;
  }

  const colSpan = columns.length + 1;
  if (!state.testPoints || state.testPoints.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${colSpan}" style="text-align: center; color: #94a3b8; padding: 16px;">当前证书暂无测量点，可点击右上角「+ 添加测量点」新增</td></tr>`;
    return;
  }

  tbody.innerHTML = state.testPoints.map((p, i) => {
    let cellsHtml = '';
    columns.forEach(col => {
      const colKey = col.key;
      let val = '';
      if (p.values && p.values[colKey] !== undefined) {
        val = p.values[colKey];
      } else if (p.values && p.values[String(col.colIdx)] !== undefined) {
        val = p.values[String(col.colIdx)];
      } else if (col.isSeq) {
        val = p.name || String(i + 1);
      } else if (col.isStd) {
        val = p.std !== undefined ? p.std : '';
      } else if (col.isAct) {
        val = p.act !== undefined ? p.act : '';
      }

      let placeholder = '';
      if (col.isAct) {
        placeholder = '实测值 (待填)';
      } else if (col.isStd) {
        placeholder = '标准值';
      } else if (col.isSeq) {
        placeholder = String(i + 1);
      } else {
        placeholder = col.label || '';
      }

      const inputId = col.isStd ? `id="tp-std-${i + 1}"` : (col.isAct ? `id="tp-act-${i + 1}"` : '');

      cellsHtml += `
        <td>
          <input type="text" 
                 ${inputId}
                 class="form-control" 
                 value="${escapeHtml(val)}" 
                 placeholder="${escapeHtml(placeholder)}"
                 onchange="updateTestPointCell(${i}, '${escapeHtml(colKey)}', ${col.colIdx}, this.value, '${col.role || 'other'}')">
        </td>
      `;
    });

    cellsHtml += `
      <td style="text-align: center;">
        <button type="button" class="btn btn-sm btn-danger" onclick="deleteTestPointRow(${i})">删除</button>
      </td>
    `;

    return `<tr>${cellsHtml}</tr>`;
  }).join('');
}

function updateTestPointCell(rowIdx, colKey, colIdx, val, role) {
  if (!state.testPoints || !state.testPoints[rowIdx]) return;
  const p = state.testPoints[rowIdx];
  if (!p.values) p.values = {};
  p.values[colKey] = val;
  p.values[String(colIdx)] = val;

  if (role === 'seq') {
    p.name = val;
    const num = parseInt(val, 10);
    if (!isNaN(num)) p.point = num;
  } else if (role === 'std') {
    p.std = val;
  } else if (role === 'act') {
    p.act = val;
  } else {
    p[colKey] = val;
  }
}

function updateTestPoint(idx, key, val) {
  if (state.testPoints && state.testPoints[idx]) {
    state.testPoints[idx][key] = val;
    if (!state.testPoints[idx].values) state.testPoints[idx].values = {};
    state.testPoints[idx].values[key] = val;
  }
}

function addTestPointRow() {
  if (!state.testPoints) state.testPoints = [];
  const bundle = state.activeBundle;
  const certTmpl = bundle ? bundle.certTemplate : null;
  const tc = certTmpl && certTmpl.field_mappings ? certTmpl.field_mappings.tableConfig : null;
  const columns = getActiveTestPointColumns(tc);

  const newNum = state.testPoints.length + 1;
  const newRow = {
    point: newNum,
    name: String(newNum),
    std: '',
    act: '',
    values: {}
  };

  columns.forEach(col => {
    let defVal = '';
    if (col.isSeq) {
      defVal = String(newNum);
    }
    newRow.values[col.key] = defVal;
    newRow.values[String(col.colIdx)] = defVal;
    newRow.values[col.label] = defVal;
  });

  state.testPoints.push(newRow);
  renderTestPoints();
}

function deleteTestPointRow(idx) {
  if (!state.testPoints || !state.testPoints[idx]) return;
  state.testPoints.splice(idx, 1);
  const bundle = state.activeBundle;
  const tc = bundle?.certTemplate?.field_mappings?.tableConfig;
  const columns = getActiveTestPointColumns(tc);
  const seqCol = columns.find(c => c.isSeq);

  state.testPoints.forEach((p, i) => {
    p.point = i + 1;
    if (seqCol && p.values) {
      if (!p.values[seqCol.key] || /^\d+$/.test(p.values[seqCol.key])) {
        p.values[seqCol.key] = String(i + 1);
        p.values[String(seqCol.colIdx)] = String(i + 1);
        p.values[seqCol.label] = String(i + 1);
        p.name = String(i + 1);
      }
    }
  });
  renderTestPoints();
}

function findMainDeviceRowIndex() {
  if (!state.packingItems || state.packingItems.length === 0) return -1;
  const bundle = state.activeBundle;
  const packTmpl = bundle ? bundle.packingTemplate : null;

  if (packTmpl && packTmpl.field_mappings) {
    const mappings = packTmpl.field_mappings;
    if (typeof mappings.mainDeviceRowIndex === 'number' && mappings.mainDeviceRowIndex >= 0) {
      if (state.packingItems[mappings.mainDeviceRowIndex]) return mappings.mainDeviceRowIndex;
    }
    if (typeof mappings.mainDeviceRowNumber === 'number' && mappings.mainDeviceRowNumber >= 1) {
      const idx = state.packingItems.findIndex(it => (it.index || 0) === mappings.mainDeviceRowNumber);
      if (idx !== -1) return idx;
    }
  }

  // Exact name or row heuristics
  const mainIdx = state.packingItems.findIndex(it => (it.name || '').trim() === '主设备');
  if (mainIdx !== -1) return mainIdx;

  // Fallback to row 1 if verified to be protected / standard main row
  const protectedRows = (packTmpl && packTmpl.field_mappings && packTmpl.field_mappings.protectedRows) || [1];
  if (state.packingItems[0] && (state.packingItems[0].isProtected || protectedRows.includes(1))) {
    return 0;
  }

  return -1;
}

function generateMainDeviceRemark(sn, hasPump) {
  const cleanSn = String(sn || '').trim();
  if (!cleanSn) return '';
  const pumpStr = hasPump ? '带泵' : '';
  return `SN: ${cleanSn}${pumpStr}`;
}

function initPackingItemsForModel() {
  const bundle = state.activeBundle;
  const packTmpl = bundle ? bundle.packingTemplate : null;
  const snapshot = bundle ? bundle.config_snapshot : {};

  const itemsConfig = (packTmpl && packTmpl.field_mappings && packTmpl.field_mappings.packingItems)
    || (snapshot && snapshot.packingItems)
    || [];

  state.packingItems = JSON.parse(JSON.stringify(itemsConfig));

  // 当前选中的设备型号名称（例如 DPT-990-Ex）
  const curModel = (bundle ? (bundle.model_display || bundle.model) : state.currentModel) || '';

  // 1. 若模板尚未配置物料明细，自动按当前型号生成标准物料明细
  if (!state.packingItems || state.packingItems.length === 0) {
    const isPOA = curModel.toUpperCase().includes('POA');
    state.packingItems = [
      { index: 1, name: '主设备', spec: curModel || '设备', count: 1, unit: '台', standard: '是', remark: '', isProtected: true }
    ];
    if (isPOA) {
      state.packingItems.push({ index: 2, name: '传感器', spec: 'PMT210SEN', count: 1, unit: '支', standard: '是', remark: '', isProtected: true });
      state.packingItems.push({ index: 3, name: '仪器包装箱', spec: 'ABS', count: 1, unit: '个', standard: '是', remark: '' });
      state.packingItems.push({ index: 4, name: '用户手册', spec: '中英文', count: 1, unit: '份', standard: '是', remark: '' });
    } else {
      state.packingItems.push({ index: 2, name: '包装箱', spec: 'ABS', count: 1, unit: '个', standard: '是', remark: '' });
      state.packingItems.push({ index: 3, name: '用户手册', spec: '中英文', count: 1, unit: '本', standard: '是', remark: '' });
      state.packingItems.push({ index: 4, name: '操作说明', spec: '中英文', count: 1, unit: '份', standard: '是', remark: '' });
    }
  }

  // 2. 核心修复：确保主设备行（保护行）的规格/型号严格对应当前选择的型号！
  let mainIdx = findMainDeviceRowIndex();
  if (mainIdx === -1 && state.packingItems.length > 0) {
    mainIdx = 0;
  }
  if (mainIdx !== -1 && curModel) {
    state.packingItems[mainIdx].spec = curModel;
  }

  // 3. 同步设备序列号与备注
  syncDeviceSnToPackingList(false);

  // 4. 无论备注是否变更，切换型号时必须强制重新渲染装箱清单表格！
  renderPackingTable();
}

function syncDeviceSnToPackingList(render = true) {
  if (!state.packingItems || state.packingItems.length === 0) return;
  const deviceSnEl = document.getElementById('device-sn');
  const rawSn = deviceSnEl ? deviceSnEl.value : '';
  const mainIdx = findMainDeviceRowIndex();

  if (mainIdx === -1) {
    console.warn('Unable to locate main device row in packing items');
    return;
  }

  const targetRow = state.packingItems[mainIdx];
  const newRemark = generateMainDeviceRemark(rawSn, state.hasPump);
  const changed = (targetRow.remark !== newRemark);
  targetRow.remark = newRemark;
  if (render && changed) {
    renderPackingTable();
  }
}

function renderPackingTable() {
  const tbody = document.getElementById('packing-items-body');
  if (!tbody) return;

  const bundle = state.activeBundle;
  const packTmpl = bundle ? bundle.packingTemplate : null;
  const protectedRows = (packTmpl && packTmpl.field_mappings && packTmpl.field_mappings.protectedRows) || [1];

  tbody.innerHTML = state.packingItems.map((item, idx) => {
    const rowNum = item.index || idx + 1;
    const isProtected = item.isProtected || protectedRows.includes(rowNum);
    const nameInput = isProtected
      ? `${item.name} <span class="badge badge-warning">保护行</span>`
      : `<input type="text" class="form-control" value="${item.name || ''}" placeholder="自定义物料名称" onchange="updatePackingItem(${idx}, 'name', this.value)">`;

    const mainDeviceIdx = findMainDeviceRowIndex();
    const isMainDeviceRow = (idx === mainDeviceIdx);
    const remarkCell = isMainDeviceRow
      ? `<input type="text" class="form-control" value="${escapeHtml(item.remark || '')}" readonly style="background: #f1f5f9; color: #334155;">`
      : `<input type="text" class="form-control" value="${escapeHtml(item.remark || '')}" onchange="updatePackingItem(${idx}, 'remark', this.value)">`;

    return `
      <tr>
        <td><b>${rowNum}</b></td>
        <td>${nameInput}</td>
        <td><input type="text" class="form-control" value="${escapeHtml(item.spec || '')}" onchange="updatePackingItem(${idx}, 'spec', this.value)"></td>
        <td><input type="number" class="form-control" style="width: 60px;" value="${item.count || 1}" onchange="updatePackingItem(${idx}, 'count', this.value)"></td>
        <td><input type="text" class="form-control" style="width: 60px;" value="${escapeHtml(item.unit || '件')}" onchange="updatePackingItem(${idx}, 'unit', this.value)"></td>
        <td>${isProtected 
            ? (item.standard || '是') 
            : `<select class="form-control" style="width: 65px; padding: 2px 4px; font-size: 13px;" onchange="updatePackingItem(${idx}, 'standard', this.value)">
                <option value="否" ${item.standard === '否' ? 'selected' : ''}>否</option>
                <option value="是" ${item.standard !== '否' ? 'selected' : ''}>是</option>
              </select>`
          }</td>
        <td>${remarkCell}</td>
        <td>
          ${isProtected 
            ? '<span style="color: #94a3b8; font-size: 12px;">不可删</span>' 
            : `<button type="button" class="btn btn-sm btn-danger" onclick="deletePackingRow(${idx})">删除</button>`}
        </td>
      </tr>
    `;
  }).join('');
}

function updatePackingItem(idx, key, val) {
  if (state.packingItems[idx]) {
    state.packingItems[idx][key] = val;
  }
}

function addPackingRow() {
  const newIdx = state.packingItems.length + 1;
  state.packingItems.push({
    index: newIdx,
    name: '', // Empty custom name by default
    spec: '',
    count: 1,
    unit: '件',
    standard: '否',
    remark: ''
  });
  renderPackingTable();
}

function deletePackingRow(idx) {
  const item = state.packingItems[idx];
  const bundle = state.activeBundle;
  const packTmpl = bundle ? bundle.packingTemplate : null;
  const protectedRows = (packTmpl && packTmpl.field_mappings && packTmpl.field_mappings.protectedRows) || [1];
  const rowNum = item ? (item.index || idx + 1) : idx + 1;

  if (item && (item.isProtected || protectedRows.includes(rowNum))) {
    return alert('保护行（主设备/传感器）严禁删除 (E06, T06, R07)');
  }
  state.packingItems.splice(idx, 1);
  state.packingItems.forEach((it, i) => it.index = i + 1);
  renderPackingTable();
}

// ==================== TASK SUBMISSION ====================
async function submitTaskForm() {
  if (!state.selectedWorker) {
    alert('请先选择一个在线执行终端电脑！');
    switchNavTab('workers');
    return;
  }

  const bundle = state.activeBundle;
  if (!bundle) return alert('当前未选择有效的已发布配置组合');

  const deviceSn = document.getElementById('device-sn').value.trim();
  const salesPersonEl = document.getElementById('sales-person');
  const salesPerson = salesPersonEl ? salesPersonEl.value.trim() : '陈文';
  const shippingLocation = document.getElementById('shipping-location') ? document.getElementById('shipping-location').value.trim() : '苏州';

  const ambientTempEl = document.getElementById('ambient-temp');
  const relativeHumidityEl = document.getElementById('relative-humidity');
  const certDateEl = document.getElementById('cert-date');

  const ambientTemp = ambientTempEl ? ambientTempEl.value.trim() : '22.1';
  const relativeHumidity = relativeHumidityEl ? relativeHumidityEl.value.trim() : '50%RH';
  const certDate = certDateEl ? certDateEl.value : new Date().toISOString().slice(0, 10);

  if (!deviceSn) return alert('请填写设备序列号 (Inst. SN.)');

  if (bundle && bundle.is_ready === false) {
    alert(`该模板当前不可用！\n原因: ${bundle.unready_reason || '保存目录未通过检查'}\n请联系管理员在控制台配置保存目录并探测通过后再提交。`);
    return;
  }

  // Validate execution worker directory configuration before submitting (DIR-06, DIR-07, Sec 4.1)
  try {
    const valRes = await fetch(`${API_BASE}/api/tasks/validate-directories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workerId: state.selectedWorker.id,
        model: bundle.model_display,
        bundleId: bundle.bundle_id,
        docCombo: bundle.doc_combo
      })
    });
    const valData = await valRes.json();
    if (!valData.valid) {
      alert(`无法提交发货任务！\n\n所选执行终端 [${state.selectedWorker.name || state.selectedWorker.id}] 保存目录未就绪：\n` + valData.errors.join('\n') + '\n\n请联系管理员在协调后台配置并检查通过后再提交。');
      return;
    }
  } catch (err) {
    // If validation endpoint has network error, proceed and let backend authoritative submit validate
  }

  const docCombo = bundle.doc_combo;
  const isPackingNeeded = docCombo === 'cert_and_packing' || docCombo === 'packing_only';
  const isPOA200 = bundle.model_display === 'POA200';

  let sensorModel = undefined;
  const currentModelStr = (bundle.model_display || bundle.model || '').trim();
  const matchedSensorConfig = state.sensorConfigs.find(c => (c.model || '').trim().toLowerCase() === currentModelStr.toLowerCase());

  if (matchedSensorConfig && Array.isArray(matchedSensorConfig.sensor_options) && matchedSensorConfig.sensor_options.length > 0) {
    const sensorModelEl = document.getElementById('sensor-model');
    if (sensorModelEl && sensorModelEl.value) {
      sensorModel = sensorModelEl.value;
    }
  }

  let sensorSn = '';
  if (isPOA200 && state.packingItems.length >= 2) {
    const sensorRow = state.packingItems.find(it => it.name === '传感器' || it.index === 2) || state.packingItems[1];
    if (sensorRow && sensorRow.remark) {
      const match = sensorRow.remark.match(/SN[:：]\s*([A-Za-z0-9_-]+)/i) || [null, sensorRow.remark];
      sensorSn = match[1] || sensorRow.remark;
    }
  }

  // Sync Device SN and validate custom material names in packing list
  if (isPackingNeeded) {
    syncDeviceSnToPackingList();
    const mainIdx = findMainDeviceRowIndex();
    if (mainIdx === -1) {
      alert('无法确定装箱清单中的主设备行，请检查模板配置！');
      return;
    }
    for (let i = 0; i < state.packingItems.length; i++) {
      const item = state.packingItems[i];
      if (!item.name || !item.name.trim()) {
        return alert(`第 ${i + 1} 行物料名称不能为空，请输入有效的自定义物料名称！`);
      }
    }
  }

  // Dynamic test points gathering based on state.testPoints and template columns
  const certTmpl = bundle ? bundle.certTemplate : null;
  const tc = certTmpl && certTmpl.field_mappings ? certTmpl.field_mappings.tableConfig : null;
  const columns = getActiveTestPointColumns(tc);

  const testPoints = (state.testPoints || []).map((p, i) => {
    const stdEl = document.getElementById(`tp-std-${i + 1}`);
    const actEl = document.getElementById(`tp-act-${i + 1}`);
    const values = { ...(p.values || {}) };
    columns.forEach(col => {
      if (values[col.key] === undefined) {
        if (col.isSeq) values[col.key] = p.name || String(i + 1);
        else if (col.isStd) values[col.key] = stdEl ? stdEl.value.trim() : (p.std || '');
        else if (col.isAct) values[col.key] = actEl ? actEl.value.trim() : (p.act || '');
      }
    });
    return {
      point: i + 1,
      name: p.name || `测试点 ${i + 1}`,
      std: stdEl ? stdEl.value.trim() : (p.std || ''),
      act: actEl ? actEl.value.trim() : (p.act || ''),
      values
    };
  });

  const reqId = 'req_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);

  const payload = {
    reqId,
    clientId: state.clientId,
    clientName: state.clientName,
    workerId: state.selectedWorker.id,
    model: bundle.model_display,
    bundleId: bundle.bundle_id,
    docCombo: bundle.doc_combo,
    deviceSn,
    salesPerson,
    shippingLocation,
    ambientTemp,
    relativeHumidity,
    hasPump: state.hasPump,
    certDate,
    testPoints,
    packingItems: isPackingNeeded ? state.packingItems : []
  };

  if (sensorModel) {
    payload.sensorModel = sensorModel;
  }
  if (isPOA200 && sensorSn) {
    payload.sensorSn = sensorSn;
  }

  try {
    const data = await safeFetchJson(`${API_BASE}/api/tasks/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    state.currentTask = data.task;

    switchNavTab('preview');
    renderPreviewLoading();

    pollTaskPreview(data.task.id);
  } catch (err) {
    alert('提交任务失败: ' + err.message);
  }
}

function renderPreviewLoading() {
  const container = document.getElementById('preview-container');
  container.innerHTML = `
    <div style="text-align: center; padding: 24px;">
      <div style="font-size: 36px; margin-bottom: 8px;">⚙️</div>
      <div style="font-weight: 700; font-size: 16px; color: #0284c7;">正在极速生成 Word 原件及分页高清预览...</div>
      <p style="font-size: 13px; color: #64748b; margin-top: 6px;">
        协调服务已分派至终端 <b>${state.selectedWorker ? state.selectedWorker.name : ''}</b>，毫秒级就绪...
      </p>
    </div>
  `;
}

async function pollTaskPreview(taskId) {
  let attempts = 0;
  const timer = setInterval(async () => {
    attempts++;
    try {
      const res = await fetch(`${API_BASE}/api/tasks/${taskId}`);
      const task = await res.json();
      state.currentTask = task;

      const targetFile = task.files.find(f => f.file_type === state.activePreviewType);
      const isReady = targetFile && targetFile.preview_images && targetFile.preview_images.length > 0;

      if (isReady || task.status === 'SUCCESS' || attempts >= 25) {
        clearInterval(timer);
        renderPreviewBox();
      }
    } catch (e) {
      if (attempts >= 25) clearInterval(timer);
    }
  }, 700);
}

// ==================== PREVIEW & PRINT ====================
function switchPreviewDoc(type) {
  state.activePreviewType = type;
  document.getElementById('preview-tab-cert').className = type === 'cert' ? 'toggle-btn active' : 'toggle-btn';
  document.getElementById('preview-tab-pack').className = type === 'packing' ? 'toggle-btn active' : 'toggle-btn';
  renderPreviewBox();
}

function renderPreviewBox() {
  const container = document.getElementById('preview-container');
  const btnBox = document.getElementById('preview-download-btn-box');

  if (!state.currentTask) {
    container.innerHTML = '请先在“发货任务”中提交生成证书与清单，或在“历史记录”中点击任一任务查看预览';
    if (btnBox) btnBox.innerHTML = '';
    return;
  }

  const targetFile = state.currentTask.files.find(f => f.file_type === state.activePreviewType);
  if (!targetFile) {
    container.innerHTML = '未找到对应的文件记录';
    if (btnBox) btnBox.innerHTML = '';
    return;
  }

  const downloadUrl = `${API_BASE}/api/tasks/${state.currentTask.id}/files/${state.activePreviewType}/download`;
  if (btnBox) {
    btnBox.innerHTML = `
      <a href="${downloadUrl}" class="btn btn-sm btn-outline" download="${targetFile.official_filename}">
        ⬇️ 下载 Word 原件
      </a>
    `;
  }

  const previews = targetFile.preview_images || [];
  if (previews.length > 0) {
    container.innerHTML = `
      <div style="font-weight: 700; margin-bottom: 10px; color: #1e293b; font-size: 14px;">
        ${targetFile.official_filename}
      </div>
      ${previews.map(url => `
        <div style="margin-bottom: 12px; cursor: pointer;" onclick="openPreviewModal('${url}', '${targetFile.official_filename}', '${downloadUrl}')">
          <img src="${url}" alt="Preview Page" style="border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
          <div style="font-size: 12px; color: #0284c7; margin-top: 4px;">🔍 点击可全屏放大查看</div>
        </div>
      `).join('')}
    `;
  } else {
    container.innerHTML = `
      <div style="font-weight: 600; margin-bottom: 8px;">${targetFile.official_filename}</div>
      <div class="badge badge-warning" style="margin-top: 12px; padding: 8px 16px;">
        正在后台生成 Word 原件及分页预览图片...
      </div>
    `;
  }
}

function openPreviewModal(imgUrl, title, downloadUrl) {
  document.getElementById('modal-doc-title').innerText = title || '文档高清预览';
  document.getElementById('modal-download-link').href = downloadUrl || '#';
  document.getElementById('modal-preview-body').innerHTML = `
    <img src="${imgUrl}" alt="Full Preview" style="max-width: 100%; height: auto; border-radius: 6px; box-shadow: 0 6px 16px rgba(0,0,0,0.15);">
  `;
  document.getElementById('preview-modal').classList.add('active');
}

function closePreviewModal() {
  document.getElementById('preview-modal').classList.remove('active');
}

async function submitPrintJob() {
  if (!state.currentTask) return alert('当前没有待打印的有效任务');

  const printCert = document.getElementById('print-check-cert').checked;
  const printPack = document.getElementById('print-check-pack').checked;
  const copies = parseInt(document.getElementById('print-copies').value) || 1;

  if (!printCert && !printPack) return alert('请至少勾选一个打印文件');

  const batchItems = [];
  if (printCert) batchItems.push({ fileType: 'cert', copies });
  if (printPack) batchItems.push({ fileType: 'packing', copies });

  try {
    const select = document.getElementById('printer-select');
    const chosenPrinter = select ? select.value : '';

    if (!chosenPrinter) {
      return alert('当前执行终端未连接或未配置可用打印机');
    }

    const workerId = state.selectedWorker ? state.selectedWorker.id : 'worker-local';

    const res = await fetch(`${API_BASE}/api/print/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: state.clientId,
        workerId,
        printerName: chosenPrinter,
        batchItems
      })
    });
    const data = await res.json();
    alert(`打印任务已成功发送至终端 [${workerId}] 打印队列！(Print Job #${data.printJobId})`);
  } catch (err) {
    alert('提交打印失败: ' + err.message);
  }
}

// ==================== HISTORY ====================
function setHistoryRange(range) {
  state.historyRange = range;
  ['today', 'week', 'month'].forEach(r => {
    document.getElementById(`range-${r}`).className = r === range ? 'toggle-btn active' : 'toggle-btn';
  });
  loadHistoryList();
}

async function loadHistoryList() {
  const listEl = document.getElementById('history-list');
  listEl.innerHTML = '<div style="text-align: center; padding: 20px;">加载历史记录中...</div>';

  try {
    const res = await fetch(`${API_BASE}/api/tasks?range=${state.historyRange}`);
    const tasks = await res.json();

    if (tasks.length === 0) {
      listEl.innerHTML = '<div style="text-align: center; color: #64748b; padding: 24px;">暂无历史记录</div>';
      return;
    }

    listEl.innerHTML = tasks.map(t => {
      const certFile = t.files.find(f => f.file_type === 'cert');
      const packFile = t.files.find(f => f.file_type === 'packing');

      const certPreviewUrl = certFile && certFile.preview_images && certFile.preview_images[0] ? certFile.preview_images[0] : '';
      const packPreviewUrl = packFile && packFile.preview_images && packFile.preview_images[0] ? packFile.preview_images[0] : '';

      return `
        <div class="history-item">
          <div class="history-item-header">
            <b>#${t.id} - ${t.model} (${t.device_sn})</b>
            <span class="badge ${t.status === 'SUCCESS' ? 'badge-success' : 'badge-warning'}">${t.status}</span>
          </div>
          <div style="font-size: 12px; color: #64748b; margin-top: 3px;">
            操作人: <b>${t.client_name}</b> | 执行终端: <b>${t.worker_id || 'worker-local'}</b> | 受理时间: ${new Date(t.accepted_at).toLocaleString('zh-CN')}
          </div>
          <div style="font-size: 12px; color: #0284c7; margin-top: 5px;">
            ${t.files.map(f => `
              <div style="margin-bottom: 4px;">
                📄 <strong>${f.official_filename}</strong>
                <span class="badge ${f.status === 'PREVIEW_READY' || f.status === 'PRINTED' ? 'badge-success' : (f.status === 'FAILED' ? 'badge-danger' : 'badge-warning')}" style="margin-left: 6px; font-size: 10px;">
                  ${f.status === 'PREVIEW_READY' ? '生成成功' : (f.status === 'FAILED' ? '生成失败' : f.status)}
                </span>
                ${f.worker_filepath ? `<div style="font-size: 11px; color: #64748b; margin-left: 16px;">💾 执行端位置: ${f.worker_filepath}</div>` : ''}
              </div>
            `).join('')}
          </div>

          <div class="history-actions">
            ${certPreviewUrl ? `
              <button type="button" class="btn btn-sm btn-outline" 
                      onclick="viewHistoryPreview('${t.id}', 'cert')">
                👁️ 查看发货证书预览
              </button>
            ` : ''}
            ${packPreviewUrl ? `
              <button type="button" class="btn btn-sm btn-outline" 
                      onclick="viewHistoryPreview('${t.id}', 'packing')">
                👁️ 查看装箱清单预览
              </button>
            ` : ''}
            ${certFile ? `
              <a href="${API_BASE}/api/tasks/${t.id}/files/cert/download" class="btn btn-sm btn-secondary" download="${certFile.official_filename}">
                ⬇️ 证书 .doc
              </a>
            ` : ''}
            ${packFile ? `
              <a href="${API_BASE}/api/tasks/${t.id}/files/packing/download" class="btn btn-sm btn-secondary" download="${packFile.official_filename}">
                ⬇️ 清单 .doc
              </a>
            ` : ''}
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    listEl.innerHTML = '加载历史失败: ' + err.message;
  }
}

async function viewHistoryPreview(taskId, fileType) {
  try {
    const res = await fetch(`${API_BASE}/api/tasks/${taskId}`);
    const task = await res.json();
    state.currentTask = task;
    state.activePreviewType = fileType;

    const file = task.files.find(f => f.file_type === fileType);
    if (file && file.preview_images && file.preview_images.length > 0) {
      const downloadUrl = `${API_BASE}/api/tasks/${taskId}/files/${fileType}/download`;
      openPreviewModal(file.preview_images[0], file.official_filename, downloadUrl);
    } else {
      switchNavTab('preview');
      renderPreviewBox();
    }
  } catch (err) {
    alert('打开预览失败: ' + err.message);
  }
}

// ==================== NAVIGATION TABS ====================
function switchNavTab(tabName) {
  ['workers', 'create', 'preview', 'history', 'serial'].forEach(t => {
    const viewEl = document.getElementById(`tab-${t}-view`);
    const navEl = document.getElementById(`nav-${t}`);
    if (viewEl) viewEl.style.display = t === tabName ? 'block' : 'none';
    if (navEl) navEl.className = t === tabName ? 'nav-tab active' : 'nav-tab';
  });

  if (tabName === 'history') {
    loadHistoryList();
  } else if (tabName === 'workers') {
    loadWorkers();
  } else if (tabName === 'create') {
    loadSensorConfigs();
  }
}

function updatePrinterDropdown(printers) {
  const select = document.getElementById('printer-select');
  const tip = document.getElementById('printer-status-tip');
  if (!select) return;

  const currentVal = select.value;
  select.innerHTML = '';

  if (!printers || printers.length === 0) {
    select.innerHTML = '<option value="">(当前执行电脑未检测到可用打印机)</option>';
    if (tip) tip.innerText = '⚠️ 执行电脑未连接打印机，可进行表单录入与高清预览，暂无法执行实物出纸。';
    return;
  }

  let defaultPhysicalPrinter = null;

  printers.forEach(p => {
    const pName = typeof p === 'string' ? p : p.name;
    const pLower = pName.toLowerCase();
    const isVirtual = pLower.includes('pdf') || pLower.includes('onenote') || pLower.includes('fax') || pLower.includes('xps') || pName.includes('导出');
    
    if (!isVirtual && !defaultPhysicalPrinter) {
      defaultPhysicalPrinter = pName;
    }

    const opt = document.createElement('option');
    opt.value = pName;
    opt.innerText = isVirtual ? `${pName} (虚拟打印/导出)` : `${pName} (物理/共享打印机)`;
    select.appendChild(opt);
  });

  if (currentVal && printers.some(p => (typeof p === 'string' ? p : p.name) === currentVal)) {
    select.value = currentVal;
  } else if (defaultPhysicalPrinter) {
    select.value = defaultPhysicalPrinter;
  }

  onPrinterSelectChange();
}

function onPrinterSelectChange() {
  const select = document.getElementById('printer-select');
  const tip = document.getElementById('printer-status-tip');
  if (!select || !tip) return;

  const val = select.value;
  if (!val) {
    tip.innerText = '⚠️ 当前未连接打印机。';
    return;
  }

  const pLower = val.toLowerCase();
  const isVirtual = pLower.includes('pdf') || pLower.includes('onenote') || pLower.includes('fax') || pLower.includes('xps') || val.includes('导出');
  if (isVirtual) {
    tip.innerText = 'ℹ️ 当前选择为虚拟打印机，打印操作将导出至文件/系统队列，不会实际出纸。推荐选用物理硬件打印机。';
  } else {
    tip.innerText = '✅ 当前已就绪，打印任务将发送至执行端物理打印机出纸。';
  }
}
