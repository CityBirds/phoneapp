/**
 * phoneApp Mobile & Workstation Client Logic (手机/车间作业端)
 * Rules: M01 - M15, F01-F16, G01-G12, 03-Spec Section 6-7
 */

const API_BASE = window.location.origin;

/**
 * 共享访问口令（用于公网/隧道访问时的入口控制）
 * 取用顺序：URL ?k= > localStorage > Cookie。
 * 首次用带 ?k= 的链接打开后会被记住，之后无需再输入。
 */
const PHONE_ACCESS_TOKEN = (() => {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('k') || new URLSearchParams(window.location.search).get('token');
    if (fromUrl) {
      localStorage.setItem('phoneapp_access_token', fromUrl);
      return String(fromUrl).trim();
    }
    const saved = localStorage.getItem('phoneapp_access_token');
    if (saved) return String(saved).trim();
    const m = document.cookie.match(/(?:^|;\s*)phoneapp_token=([^;]+)/);
    if (m) return decodeURIComponent(m[1]);
  } catch (e) {}
  return '';
})();

/** 给所有 API 请求附加访问口令（header + 查询参数双通道，兼容无 Cookie 的浏览器） */
(function installAccessTokenInterceptor() {
  if (typeof window.fetch !== 'function') return;
  const originalFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const isApi = /\/api\//.test(url);
      const sameOrigin = !/^https?:\/\//i.test(url) || url.startsWith(window.location.origin);
      if (PHONE_ACCESS_TOKEN && isApi && sameOrigin) {
        const opts = Object.assign({}, init);
        const headers = new Headers(opts.headers || (typeof input === 'object' && input.headers) || {});
        headers.set('x-phone-token', PHONE_ACCESS_TOKEN);
        opts.headers = headers;
        // 同时带上查询参数，规避部分内嵌浏览器不允许跨站 Cookie 的情况
        if (!/[?&](k|token)=/.test(url)) {
          const sep = url.includes('?') ? '&' : '?';
          input = url + sep + 'k=' + encodeURIComponent(PHONE_ACCESS_TOKEN);
        }
      }
    } catch (e) {}
    const p = originalFetch(input, init);
    // 口令缺失或失效时，引导到口令登录页（避免页面空白无提示）
    try {
      p.then((res) => {
        if (res && res.status === 401 && !window.__phoneappRedirecting) {
          window.__phoneappRedirecting = true;
          try { localStorage.removeItem('phoneapp_access_token'); } catch (e) {}
          window.location.replace('/frontend/login.html?expired=1');
        }
      }).catch(() => {});
    } catch (e) {}
    return p;
  };
})();

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
  packingItems: [],
  pollingSessionId: 0,
  lastQueryError: null,
  lastQueryTime: null,
  clientPollTimeout: false,
  initializedBundleKey: null
};

/** 从已发布模板解析主设备序列号默认值 (2.1, SN01-SN05) */
function extractDefaultDeviceSn(bundle) {
  if (!bundle) return { sn: '', conflict: false };

  let certSn = '';
  let packingSn = '';

  const certTmpl = bundle.certTemplate;
  if (certTmpl && certTmpl.field_mappings) {
    const singleFields = certTmpl.field_mappings.singleFields || [];
    const snField = singleFields.find(f =>
      f.status === 'bound' && /Inst\.?\s*SN|设备序列号|序列号|Instrument\s*SN|SN:/i.test(f.label || '')
    );
    if (snField && (snField.candidateValue || snField.defaultValue)) {
      certSn = String(snField.candidateValue || snField.defaultValue).trim();
    }
  }

  const packTmpl = bundle.packingTemplate;
  if (packTmpl && packTmpl.field_mappings) {
    const items = packTmpl.field_mappings.packingItems || [];
    const mainItem = items.find(it => it.role === 'mainDevice' || /主设备|主机/.test(it.name || ''));
    if (mainItem) {
      if (mainItem.sn) {
        packingSn = String(mainItem.sn).trim();
      } else if (mainItem.remark) {
        const match = /SN:\s*([^\s\r\n带泵]+)/i.exec(mainItem.remark);
        if (match) packingSn = match[1].trim();
      }
    }
  }

  if (certSn && packingSn && certSn !== packingSn) {
    return { sn: certSn, certSn, packingSn, conflict: true };
  }

  const sn = certSn || packingSn || '';
  return { sn, certSn, packingSn, conflict: false };
}


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
  const statusEl = document.getElementById('model-load-status');
  if (!select) return;

  if (!state.bundles || state.bundles.length === 0) {
    select.innerHTML = '<option value="">(暂无已发布模板配置)</option>';
    if (statusEl) {
      statusEl.style.display = 'block';
      statusEl.className = 'status-tip warning';
      const wName = state.selectedWorker ? state.selectedWorker.name : '当前执行端';
      statusEl.innerHTML = `ℹ️ 执行端 [${wName}] 未启用任何已发布模板。请前往协调服务管理后台在<b>终端详情页</b>配置并启用模板。`;
    }
    onModelChange();
    return;
  }

  const readyBundles = state.bundles.filter(b => b.is_ready !== false);
  const unreadyBundles = state.bundles.filter(b => b.is_ready === false);

  // 5：已发布、已启用但目录未配置或检查未通过的模板必须显示不可用原因且禁止提交，不得隐藏后静默降级
  const buildOption = (b, disabled) => {
    let comboText = ' (带清单)';
    if (b.doc_combo === 'cert_only') comboText = ' (仅证书)';
    if (b.doc_combo === 'packing_only') comboText = ' (仅清单)';

    const optName = b.option_name && b.option_name !== '通用' ? ` - ${b.option_name}` : '';
    const label = `${b.model_display}${optName}${comboText}${disabled ? '［不可提交］' : ''}`;
    return `<option value="${b.id}" ${disabled ? 'disabled' : ''}>${label}</option>`;
  };

  select.innerHTML = readyBundles.map(b => buildOption(b, false)).join('')
    + unreadyBundles.map(b => buildOption(b, true)).join('');

  if (readyBundles.length === 0 && select.options.length > 0) {
    select.selectedIndex = 0;
  }

  if (statusEl) {
    if (unreadyBundles.length > 0) {
      statusEl.style.display = 'block';
      statusEl.className = 'status-tip warning';
      const reasons = unreadyBundles.map(b => `· ${b.model_display}：${b.unready_reason || '保存目录不可用'}`).join('<br>');
      statusEl.innerHTML = `⚠️ 以下模板已启用但当前不可提交，请通知管理员在终端详情页处理：<br>${reasons}`;
    } else {
      statusEl.style.display = 'none';
    }
  }

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

  const bundleKey = bundle ? `${bundle.id}_v${bundle.version || '1'}` : '';
  if (bundleKey && state.initializedBundleKey !== bundleKey) {
    state.initializedBundleKey = bundleKey;
    const extracted = extractDefaultDeviceSn(bundle);
    const snInput = document.getElementById('device-sn');
    if (snInput) {
      snInput.value = extracted.sn || '';
    }
    const conflictEl = document.getElementById('sn-conflict-notice');
    if (conflictEl) {
      if (extracted.conflict) {
        conflictEl.style.display = 'block';
        conflictEl.innerHTML = `⚠️ 模板内置序列号存在冲突（证书: <b>${escapeHtml(extracted.certSn)}</b>，清单: <b>${escapeHtml(extracted.packingSn)}</b>），已默认采用证书序列号，请核对。`;
      } else {
        conflictEl.style.display = 'none';
      }
    }
  }

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

  // 证书测量表固定行数：以模板数据区行数为准（整改 3.3, M07/M08/M10）
  const templateRowCount = (tc && typeof tc.rowCount === 'number' && tc.rowCount > 0) ? tc.rowCount : 0;
  const configWarning = validateActiveTableConfig(tc, pts);

  // 没有有效测量表格区绑定时，不渲染任何“假表头/假行”，只显示告警（整改 3.3）
  const hasValidBinding = !!(tc && Array.isArray(tc.columns) && tc.columns.length > 0);
  if (!hasValidBinding) {
    state.testPoints = [];
    state.testPointsConfigWarning = configWarning.length > 0
      ? configWarning
      : ['已发布配置缺少测量表格区绑定 (tableConfig)'];
    renderTestPoints();
    return;
  }

  if (templateRowCount > 0 && (!pts || pts.length === 0 || pts.length !== templateRowCount)) {
    // 已保存行数与模板数据区不一致时，按模板默认值重建，避免把上个模板的行列带进来
    pts = [];
    for (let i = 0; i < templateRowCount; i++) {
      const rowItem = { point: i + 1, values: {} };
      columns.forEach(col => {
        let val = (col.defaultValues && col.defaultValues[i] !== undefined) ? col.defaultValues[i] : '';
        if (col.isSeq && (val === '' || val === undefined)) val = String(i + 1);
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
        } else if (col.defaultValues && col.defaultValues[i] !== undefined) {
          values[col.key] = col.defaultValues[i];
        } else {
          // 模板里真实存在的空格保持为空，不补造数据（整改 3.3）
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
      name: ptName || '',
      std: stdVal,
      act: actVal,
      values
    };
  });

  state.testPointsConfigWarning = configWarning;
  renderTestPoints();
}

/**
 * 手机端配置自检：把已发布配置与模板数据区对照，
 * 发现问题时提示重新绑定发布，而不是静默继续使用污染配置（整改 3.3, M11）。
 *
 * 关键：缺少测量表格区绑定（tableConfig.columns）时必须明确报警并阻止提交，
 * 不能悄悄退化成“序号/标准值/实测值”三列假表头继续生成错误文档。
 */
function validateActiveTableConfig(tc, pts) {
  const warnings = [];
  if (!tc) {
    warnings.push('已发布配置缺少测量表格区绑定 (tableConfig)，无法确定真实列名与行数');
    return warnings;
  }
  const columns = Array.isArray(tc.columns) ? tc.columns : [];
  if (columns.length === 0) {
    warnings.push('测量表格区没有列定义 (tableConfig.columns 为空)');
  }
  const tableIdxs = new Set(columns.map(c => (c.tableIdx === undefined ? tc.tableIdx : c.tableIdx)));
  if (tableIdxs.size > 1) warnings.push('测量列跨多个表格区域');

  // 旧版格式：行里只有 std/act 兼容字段、没有按列 key 保存的 values
  const legacyRows = (Array.isArray(pts) ? pts : []).filter(p => p && (!p.values || Object.keys(p.values).length === 0));
  if (legacyRows.length > 0 && columns.length > 0) {
    warnings.push(`存在 ${legacyRows.length} 行旧格式测量数据（缺少按列保存的 values），需重新发布模板`);
  }

  if (typeof tc.rowCount === 'number' && Array.isArray(pts) && pts.length > 0 && pts.length !== tc.rowCount) {
    warnings.push(`测量行数 (${pts.length}) 与模板数据区 (${tc.rowCount}) 不一致`);
  }
  return warnings;
}

function renderTestPoints() {
  const tbody = document.getElementById('test-points-body');
  if (!tbody) return;

  const bundle = state.activeBundle;
  const certTmpl = bundle ? bundle.certTemplate : null;
  const snapshot = bundle ? bundle.config_snapshot : {};
  // 与 initTestPointsForModel 保持同一数据源顺序（证书模板优先，其次发布快照）
  const tc = (certTmpl && certTmpl.field_mappings && certTmpl.field_mappings.tableConfig)
    || (snapshot && snapshot.tableConfig);
  const columns = getActiveTestPointColumns(tc);
  const hasValidBinding = !!(tc && Array.isArray(tc.columns) && tc.columns.length > 0);

  // Render Table Headers <thead> in exact template order with exact template names!
  // 无有效绑定时不渲染任何假表头，避免手机出现与模板不符的列（整改 3.3）
  const thead = document.getElementById('test-points-thead');
  if (thead && hasValidBinding) {
    let thHtml = '<tr>';
    columns.forEach(col => {
      const title = col.label || '列';
      thHtml += `<th class="col-test-dyn">${escapeHtml(title)}</th>`;
    });
    // 证书测量表固定行数，不提供增删入口与操作列（整改 3.3, M07）
    thHtml += '</tr>';
    thead.innerHTML = thHtml;
  }

  const warningBox = document.getElementById('test-points-warning');
  if (warningBox) {
    if (state.testPointsConfigWarning && state.testPointsConfigWarning.length > 0) {
      warningBox.style.display = 'block';
      warningBox.innerHTML = '⚠️ 当前发布的证书测量配置存在问题：' + state.testPointsConfigWarning.join('；') +
        '。请通知管理员重新分析并发布模板后再提交。';
    } else {
      warningBox.style.display = 'none';
      warningBox.innerHTML = '';
    }
  }

  if (!hasValidBinding) {
    tbody.innerHTML = `<tr><td colspan="${columns.length || 1}" style="text-align: center; color: #b91c1c; padding: 16px;">当前发布的证书模板没有可用的测量表列绑定（tableConfig.columns 为空），已停止渲染以<b>避免生成与模板不符的测量表</b>。请通知管理员在控制台重新分析并正式发布该模板。</td></tr>`;
    return;
  }

  if (!state.testPoints || state.testPoints.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${columns.length || 1}" style="text-align: center; color: #94a3b8; padding: 16px;">当前模板未配置测量数据行，请联系管理员检查模板绑定</td></tr>`;
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

      // 每个输入框只能有一个唯一 id（此前重复拼接 tp-act/tp-std 会生成两个 id 属性，
      // 导致多个实测列回退到同一个控件，互相覆盖）(整改 C.5)
      let inputAttr = `id="tp-cell-${i}-${colKey}" data-row="${i}" data-col-key="${escapeHtml(colKey)}" data-col-idx="${col.colIdx}" data-col-role="${col.role || 'other'}"`;
      if (col.isStd) inputAttr += ` data-cell-role="std"`;
      else if (col.isAct) inputAttr += ` data-cell-role="act"`;
      if (col.isSeq) inputAttr += ' readonly style="background:#f1f5f9;"';
      cellsHtml += `
        <td>
          <input type="text" 
                 ${inputAttr}
                 class="form-control tp-dyn-input" 
                 value="${escapeHtml(val)}" 
                 placeholder="${escapeHtml(placeholder)}" 
                 onchange="updateTestPointCell(${i}, '${escapeHtml(colKey)}', ${col.colIdx}, this.value, '${col.role || 'other'}')">
        </td>
      `;
    });

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

/**
 * 证书测量表固定行数：不提供新增/删除行入口（整改 3.3, M07）。
 * 保留函数名仅为兼容旧页面按钮，调用时明确拒绝而不是静默改维度。
 */
function addTestPointRow() {
  alert('证书测量表行数由模板固定，不支持增加测量点。如需变更请通知管理员重新发布模板。');
}

function deleteTestPointRow(idx) {
  alert('证书测量表行数由模板固定，不支持删除测量点。如需变更请通知管理员重新发布模板。');
}

function getPackingRoleConfig() {
  const bundle = state.activeBundle;
  const packTmpl = bundle ? bundle.packingTemplate : null;
  const mappings = (packTmpl && packTmpl.field_mappings) || {};
  const roles = Array.isArray(mappings.packingRowRoles) ? mappings.packingRowRoles : [];
  return { roles, mappings };
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

  // 行角色优先（来自模板真实行，整改 B03）
  const roleIdx = state.packingItems.findIndex(it => it.role === 'mainDevice');
  if (roleIdx !== -1) return roleIdx;

  // Exact name heuristics
  const mainIdx = state.packingItems.findIndex(it => (it.name || '').trim() === '主设备');
  if (mainIdx !== -1) return mainIdx;

  // Fallback: the protected row that is not a sensor row
  const protectedIdx = state.packingItems.findIndex(it => it.isProtected && it.role !== 'sensor');
  if (protectedIdx !== -1) return protectedIdx;

  return -1;
}

function findSensorRowIndex() {
  if (!state.packingItems) return -1;
  return state.packingItems.findIndex(it => it.role === 'sensor');
}

function generateMainDeviceRemark(oldRemark, sn, hasPump) {
  const cleanSn = String(sn || '').trim();
  const pumpStr = hasPump ? '带泵' : '';
  const snTag = cleanSn ? `SN: ${cleanSn}${pumpStr}` : '';
  const cleanOld = String(oldRemark || '').trim();

  if (!cleanOld) {
    return snTag;
  }

  const snRegex = /SN:\s*[^\s\r\n]+/i;
  if (snRegex.test(cleanOld)) {
    if (snTag) {
      return cleanOld.replace(snRegex, snTag);
    } else {
      return cleanOld.replace(snRegex, '').replace(/\s+/g, ' ').trim();
    }
  } else {
    if (snTag) {
      return `${cleanOld} ${snTag}`.trim();
    } else {
      return cleanOld;
    }
  }
}

function initPackingItemsForModel() {
  const bundle = state.activeBundle;
  const packTmpl = bundle ? bundle.packingTemplate : null;
  const snapshot = bundle ? bundle.config_snapshot : {};

  const itemsConfig = (packTmpl && packTmpl.field_mappings && packTmpl.field_mappings.packingItems)
    || (snapshot && snapshot.packingItems)
    || [];

  state.packingItems = JSON.parse(JSON.stringify(itemsConfig));
  // 记录模板物料行数基准：必须在模板行基础上增删，不能凭空新增模板不存在的物料行（整改 3.4）
  state.packingTemplateRowCount = state.packingItems.length;

  // 当前选中的设备型号名称（例如 DPT-990-Ex）
  const curModel = (bundle ? (bundle.model_display || bundle.model) : state.currentModel) || '';

  // 模板未配置物料明细时，只能按模板真实行角色给出最小可用行，不得虚构传感器行（整改 3.4）
  if (!state.packingItems || state.packingItems.length === 0) {
    state.packingItems = [
      { index: 1, name: '主设备', spec: curModel || '', count: 1, unit: '', standard: '', remark: '', isProtected: true, role: 'mainDevice' }
    ];
    console.warn('Packing template has no configured rows; only the main device row is used. Ask admin to publish template rows.');
  }

  // 同步真实行角色与保护标记（不依赖型号名称推断）
  state.packingItems.forEach((it, idx) => {
    if (!it.role) {
      if (/主设备|主机/.test(String(it.name || ''))) it.role = 'mainDevice';
      else if (/传感器|探头/.test(String(it.name || ''))) it.role = 'sensor';
      else if (/参考仪器|标准器/.test(String(it.name || ''))) it.role = 'reference';
      else it.role = 'material';
    }
    it.isProtected = (it.role === 'mainDevice' || it.role === 'sensor' || it.role === 'reference' || !!it.isProtected);
    it.index = idx + 1;
  });

  // 核心：确保主设备行的规格/型号严格对应当前选择的型号
  const mainIdx = findMainDeviceRowIndex();
  if (mainIdx !== -1 && curModel) {
    state.packingItems[mainIdx].spec = curModel;
  }

  // 同步设备序列号与备注
  syncDeviceSnToPackingList(false);

  // 切换型号时必须强制重新渲染装箱清单表格
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
  const newRemark = generateMainDeviceRemark(targetRow.remark, rawSn, state.hasPump);
  const changed = (targetRow.remark !== newRemark);
  targetRow.remark = newRemark;
  if (render && changed) {
    renderPackingTable();
  }
}

function renderPackingTable() {
  const tbody = document.getElementById('packing-items-body');
  if (!tbody) return;

  const { mappings } = getPackingRoleConfig();
  const protectedRows = (mappings && Array.isArray(mappings.protectedRows)) ? mappings.protectedRows : [];

  tbody.innerHTML = state.packingItems.map((item, idx) => {
    const rowNum = item.index || idx + 1;
    const isProtected = item.isProtected || protectedRows.includes(rowNum);
    const nameInput = isProtected
      ? `${escapeHtml(item.name)} <span class="badge badge-warning">保护行</span>`
      : `<input type="text" class="form-control" value="${escapeHtml(item.name || '')}" placeholder="自定义物料名称" onchange="updatePackingItem(${idx}, 'name', this.value)">`;

    const mainDeviceIdx = findMainDeviceRowIndex();
    const sensorIdx = findSensorRowIndex();
    const isMainDeviceRow = (idx === mainDeviceIdx);
    const isSensorRow = (idx === sensorIdx);
    const remarkCell = isMainDeviceRow
      ? `<input type="text" class="form-control" value="${escapeHtml(item.remark || '')}" readonly style="background: #f1f5f9; color: #334155;">`
      : `<input type="text" class="form-control" value="${escapeHtml(item.remark || '')}" placeholder="${isSensorRow ? 'SN: 传感器序列号' : ''}" onchange="updatePackingItem(${idx}, 'remark', this.value)">`;

    return `
      <tr>
        <td><b>${rowNum}</b></td>
        <td>${nameInput}</td>
        <td><input type="text" class="form-control" value="${escapeHtml(item.spec || '')}" onchange="updatePackingItem(${idx}, 'spec', this.value)"></td>
        <td><input type="number" class="form-control" style="width: 60px;" value="${item.count === '' ? '' : (item.count || 1)}" onchange="updatePackingItem(${idx}, 'count', this.value)"></td>
        <td><input type="text" class="form-control" style="width: 60px;" value="${escapeHtml(item.unit || '')}" onchange="updatePackingItem(${idx}, 'unit', this.value)"></td>
        <td>${isProtected 
            ? escapeHtml(item.standard || '')
            : `<select class="form-control" style="width: 65px; padding: 2px 4px; font-size: 13px;" onchange="updatePackingItem(${idx}, 'standard', this.value)">
                <option value="" ${item.standard === '' || item.standard === undefined ? 'selected' : ''}>(空)</option>
                <option value="否" ${item.standard === '否' ? 'selected' : ''}>否</option>
                <option value="是" ${item.standard === '是' ? 'selected' : ''}>是</option>
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
    // 无依据不补“件”“是”（整改 3.4）
    unit: '',
    standard: '',
    remark: '',
    role: 'material',
    isProtected: false
  });
  renderPackingTable();
}

function deletePackingRow(idx) {
  const item = state.packingItems[idx];
  const { mappings } = getPackingRoleConfig();
  const protectedRows = (mappings && Array.isArray(mappings.protectedRows)) ? mappings.protectedRows : [];
  const rowNum = item ? (item.index || idx + 1) : idx + 1;

  if (item && (item.isProtected || item.role === 'mainDevice' || item.role === 'sensor' || item.role === 'reference' || protectedRows.includes(rowNum))) {
    return alert('保护行（主设备/传感器/参考仪器）严禁删除 (E06, T06, R07)');
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
  const snapshot = bundle.config_snapshot || {};

  // 证书测量表固定行数：维度/绑定不一致时最先拒绝提交，绝不绕过后端生成错误文档
  // （整改 3.3, M12；必须先于清单校验，避免报出与真实原因无关的错误）
  const submitShowCert = docCombo === 'cert_and_packing' || docCombo === 'cert_only';
  const certTmplForSubmit = bundle.certTemplate;
  const tcForSubmit = (certTmplForSubmit && certTmplForSubmit.field_mappings && certTmplForSubmit.field_mappings.tableConfig)
    || snapshot.tableConfig;
  const certColumnsForSubmit = getActiveTestPointColumns(tcForSubmit);
  if (submitShowCert) {
    if (!tcForSubmit || !Array.isArray(tcForSubmit.columns) || tcForSubmit.columns.length === 0) {
      alert('当前发布的证书模板缺少测量表格区绑定 (tableConfig.columns 为空)，已阻止提交以避免生成与模板不符的测量表。\n请联系管理员在控制台重新分析并正式发布该模板。');
      return;
    }
    const expectedRows = (typeof tcForSubmit.rowCount === 'number' && tcForSubmit.rowCount > 0) ? tcForSubmit.rowCount : 0;
    if (expectedRows > 0 && state.testPoints.length !== expectedRows) {
      alert(`测量数据行数 (${state.testPoints.length}) 与模板固定行数 (${expectedRows}) 不一致，已阻止提交。请刷新页面重新加载当前发布配置。`);
      return;
    }
    if (state.testPointsConfigWarning && state.testPointsConfigWarning.length > 0) {
      alert('当前发布的证书测量配置存在问题：' + state.testPointsConfigWarning.join('；') + '。已阻止提交，请联系管理员重新分析并发布模板。');
      return;
    }
  }

  let sensorModel = undefined;
  const currentModelStr = (bundle.model_display || bundle.model || '').trim();
  const matchedSensorConfig = state.sensorConfigs.find(c => (c.model || '').trim().toLowerCase() === currentModelStr.toLowerCase());

  if (matchedSensorConfig && Array.isArray(matchedSensorConfig.sensor_options) && matchedSensorConfig.sensor_options.length > 0) {
    const sensorModelEl = document.getElementById('sensor-model');
    if (sensorModelEl && sensorModelEl.value) {
      sensorModel = sensorModelEl.value;
    }
  }

  // 传感器序号只从模板中真实存在的传感器行读取；没有传感器行则不采集、不强制（整改 3.4, P05）
  let sensorSn = '';
  const sensorRowIdx = isPackingNeeded ? findSensorRowIndex() : -1;
  if (sensorRowIdx !== -1) {
    const sensorRow = state.packingItems[sensorRowIdx];
    if (sensorRow && sensorRow.remark) {
      const match = sensorRow.remark.match(/SN[:：]\s*([A-Za-z0-9_-]+)/i);
      sensorSn = match ? match[1] : '';
    }
    if (!sensorSn && sensorRow && typeof sensorRow.sn === 'string' && sensorRow.sn) {
      sensorSn = sensorRow.sn;
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
    // 模板没有传感器行时不得凭空新增传感器行（整改 3.4, P05）
    if (findSensorRowIndex() === -1 && state.packingItems.some(it => /传感器|探头/.test(String(it.name || '')))) {
      return alert('当前模板没有传感器行，不能新增传感器行，请删除该行或通知管理员重新发布模板。');
    }
  }

  // Dynamic test points gathering based on state.testPoints and template columns
  // （证书绑定与行数校验已在上方证书段落先行执行）
  const certTmpl = bundle ? bundle.certTemplate : null;
  const tc = tcForSubmit;
  const columns = certColumnsForSubmit;

  // 以稳定列 key 的 values 作为多列表格权威数据源 (整改 C.1/C.2)
  // - 每个列只读取自己的列 key 控件（tp-cell-row-colKey），不再回退到共享的 tp-act/tp-std 控件；
  // - 兼容字段 std/act 仅在“该列没有列值且只有一个同角色列”时作为回退，避免多列互相覆盖；
  const roleColumnCounts = { seq: 0, std: 0, act: 0 };
  (columns || []).forEach(c => {
    if (c.isSeq) roleColumnCounts.seq++;
    if (c.isStd) roleColumnCounts.std++;
    if (c.isAct) roleColumnCounts.act++;
  });

  const testPoints = (state.testPoints || []).map((p, i) => {
    const values = { ...(p.values || {}) };
    let liveStd = p.std || '';
    let liveAct = p.act || '';
    let liveName = p.name || `测试点 ${i + 1}`;

    columns.forEach(col => {
      const el = document.getElementById(`tp-cell-${i}-${col.key}`)
        || (document.querySelector ? document.querySelector(`[data-row="${i}"][data-col-key="${col.key}"]`) : null);

      let liveVal = el ? String(el.value).trim() : '';
      if (liveVal === '') {
        if (values[col.key] !== undefined && values[col.key] !== null) liveVal = String(values[col.key]);
        else if (values[String(col.colIdx)] !== undefined && values[String(col.colIdx)] !== null) liveVal = String(values[String(col.colIdx)]);
      }

      // 仅在“没有列值 + 该角色只有一列”时使用兼容字段，且区分空字符串/零值/字段缺失
      if (liveVal === '' && col.isSeq && roleColumnCounts.seq === 1) liveVal = liveName;
      if (liveVal === '' && col.isStd && roleColumnCounts.std === 1) liveVal = liveStd;
      if (liveVal === '' && col.isAct && roleColumnCounts.act === 1) liveVal = liveAct;

      // 多列表格以列 key 为权威，不把某一列的值写进其他列的 key
      values[col.key] = liveVal;
      values[String(col.colIdx)] = liveVal;
      values[col.label] = liveVal;

      if (col.isSeq && liveVal) {
        liveName = liveVal;
        const num = parseInt(liveVal, 10);
        if (!isNaN(num)) p.point = num;
      } else if (col.isStd && liveVal) {
        liveStd = liveVal;
      } else if (col.isAct && liveVal) {
        // 只有单一实测列时才更新兼容字段 act，多实测列不得互相覆盖 (整改 C.1/C.2)
        if (roleColumnCounts.act === 1) liveAct = liveVal;
      }
    });

    return {
      point: p.point || (i + 1),
      name: liveName,
      std: liveStd,
      act: liveAct,
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
      <div style="font-weight: 700; font-size: 16px; color: #0284c7;">正在生成 Word 原件并转换分页高清预览...</div>
      <p style="font-size: 13px; color: #64748b; margin-top: 6px;">
        任务已分派至终端 <b>${state.selectedWorker ? escapeHtml(state.selectedWorker.name) : ''}</b>，后台正顺序处理中...
      </p>
    </div>
  `;
}

async function pollTaskPreview(taskId) {
  state.pollingSessionId++;
  const currentSessionId = state.pollingSessionId;
  const pollStartTime = Date.now();

  async function doPoll() {
    if (state.pollingSessionId !== currentSessionId) return;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(`${API_BASE}/api/tasks/${taskId}`, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (state.pollingSessionId !== currentSessionId) return;

      if (!res.ok) {
        state.lastQueryError = `HTTP ${res.status}`;
        renderPreviewBox();
        setTimeout(doPoll, 2000);
        return;
      }

      const task = await res.json();
      if (state.pollingSessionId !== currentSessionId) return;

      state.currentTask = task;
      state.lastQueryError = null;
      state.lastQueryTime = new Date().toLocaleTimeString();

      renderPreviewBox();

      const allFinished = (task.files || []).length > 0 && (task.files || []).every(f =>
        ['PREVIEW_READY', 'PREVIEW_FAILED', 'PREVIEW_TIMEOUT', 'PRINTED', 'FAILED'].includes(f.status)
      );

      const elapsedSec = (Date.now() - pollStartTime) / 1000;

      if (!allFinished) {
        if (elapsedSec < 120) {
          setTimeout(doPoll, 1200);
        } else {
          state.clientPollTimeout = true;
          renderPreviewBox();
        }
      } else {
        state.clientPollTimeout = false;
      }
    } catch (e) {
      if (state.pollingSessionId !== currentSessionId) return;
      state.lastQueryError = '网络连接异常，正在持续尝试重新探测...';
      renderPreviewBox();
      setTimeout(doPoll, 2500);
    }
  }

  state.clientPollTimeout = false;
  state.lastQueryError = null;
  doPoll();
}

/**
 * 预览/下载资源 URL 附加访问口令。
 * 图片由 <img> 加载，不会走 window.fetch 拦截器，因此必须显式带上口令，
 * 否则经隧道访问时会被访问控制中间件拒绝 (PV10)。
 */
function withAccessToken(url) {
  if (!url) return '';
  if (!PHONE_ACCESS_TOKEN) return url;
  if (/[?&](k|token)=/.test(url)) return url;
  return url + (url.includes('?') ? '&' : '?') + 'k=' + encodeURIComponent(PHONE_ACCESS_TOKEN);
}

/** 渲染分页图片预览（手机不装 Office、也不依赖浏览器内嵌 PDF）(PV01/PV02/PV07) */
function renderPagedPreview(pageUrls, title) {
  if (!pageUrls || pageUrls.length === 0) return '';
  const pages = pageUrls.map((u, i) => `
    <div class="preview-page-wrap" style="margin-bottom: 14px;">
      <div style="font-size: 12px; color: #64748b; margin-bottom: 4px;">第 ${i + 1} / ${pageUrls.length} 页</div>
      <img src="${withAccessToken(u)}" alt="第 ${i + 1} 页"
           loading="${i === 0 ? 'eager' : 'lazy'}"
           style="width: 100%; height: auto; border: 1px solid #e2e8f0; border-radius: 8px; background: #fff;">
    </div>
  `).join('');
  return `<div class="paged-preview" data-title="${escapeHtml(title || '')}">${pages}</div>`;
}

// ==================== PREVIEW & PRINT ====================
function switchPreviewDoc(type) {
  state.activePreviewType = type;
  document.getElementById('preview-tab-cert').className = type === 'cert' ? 'toggle-btn active' : 'toggle-btn';
  document.getElementById('preview-tab-pack').className = type === 'packing' ? 'toggle-btn active' : 'toggle-btn';
  renderPreviewBox();
  if (state.currentTask) {
    refreshCurrentTask();
  }
}

function renderPreviewBox() {
  const container = document.getElementById('preview-container');
  const btnBox = document.getElementById('preview-download-btn-box');

  if (!state.currentTask) {
    container.innerHTML = '请先在“发货任务”中提交生成证书与清单，或在“历史记录”中点击任一任务查看预览';
    if (btnBox) btnBox.innerHTML = '';
    return;
  }

  const targetFile = state.currentTask.files ? state.currentTask.files.find(f => f.file_type === state.activePreviewType) : null;
  if (!targetFile) {
    container.innerHTML = `
      <div style="padding: 12px 0;">
        <div style="color: #64748b; font-size: 13px;">未包含 ${state.activePreviewType === 'cert' ? '证书' : '发货清单'} 文档</div>
        <button type="button" class="btn btn-sm btn-secondary" style="margin-top: 8px;" onclick="refreshCurrentTask()">🔄 刷新状态</button>
      </div>
    `;
    if (btnBox) btnBox.innerHTML = '';
    return;
  }

  const downloadUrl = `${API_BASE}/api/tasks/${state.currentTask.id}/files/${state.activePreviewType}/download`;
  const pdfUrl = `${API_BASE}/previews/task_${state.currentTask.id}_${state.activePreviewType}.pdf`;

  const refreshBtnHtml = `<button type="button" class="btn btn-sm btn-secondary" onclick="refreshCurrentTask()">🔄 刷新状态</button>`;
  const downloadBtnHtml = `<a href="${withAccessToken(downloadUrl)}" class="btn btn-sm btn-outline" download="${escapeHtml(targetFile.official_filename)}">⬇️ 下载 Word 原件</a>`;

  if (btnBox) {
    btnBox.innerHTML = `${refreshBtnHtml} ${downloadBtnHtml}`;
  }

  const queryNoticeHtml = state.lastQueryError
    ? `<div class="badge badge-warning" style="margin-bottom: 10px; display: block; text-align: left; background: #fff3cd; color: #856404;">⚠️ 状态查询异常：${escapeHtml(state.lastQueryError)}</div>`
    : '';

  const previews = targetFile.preview_images || [];
  const isPreviewFailed = targetFile.status === 'PREVIEW_FAILED' || targetFile.status === 'PREVIEW_TIMEOUT' ||
    (targetFile.status === 'FAILED' && !previews.length);

  if (targetFile.status === 'PREVIEW_READY' && previews.length > 0) {
    container.innerHTML = `
      ${queryNoticeHtml}
      <div style="font-weight: 700; margin-bottom: 6px; color: #1e293b; font-size: 14px;">
        ${escapeHtml(targetFile.official_filename)}
      </div>
      <div style="font-size: 12px; color: #64748b; margin-bottom: 10px;">
        以下为本任务实际生成的 Word 原件转换后的真实分页预览，共 <b>${previews.length}</b> 页（无需在手机上安装 Office）。
      </div>
      ${renderPagedPreview(previews, targetFile.official_filename)}
      <div style="margin-top: 10px; display: flex; gap: 8px; flex-wrap: wrap;">
        ${refreshBtnHtml}
        ${downloadBtnHtml}
        <a href="${withAccessToken(pdfUrl)}" target="_blank" rel="noopener" class="btn btn-sm btn-outline">🔍 查看/下载 PDF</a>
        <button type="button" class="btn btn-sm btn-secondary" onclick="retryPreview('${state.activePreviewType}')">🔄 仅重试预览转换</button>
      </div>
    `;
  } else if (isPreviewFailed) {
    container.innerHTML = `
      ${queryNoticeHtml}
      <div style="font-weight: 600; margin-bottom: 8px;">${escapeHtml(targetFile.official_filename)}</div>
      <div class="badge badge-danger" style="margin-top: 8px; padding: 8px 16px; display: block; text-align: left;">
        ❌ 预览转换未就绪（原 Word 文档已生成并保存，可正常下载）
      </div>
      <div style="margin-top: 10px; font-size: 13px; color: #b91c1c; word-break: break-all;">
        失败阶段与原因：${escapeHtml(targetFile.error_msg || '未能把 Word 转换为页图预览')}
      </div>
      <div style="margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap;">
        <button type="button" class="btn btn-sm btn-primary" onclick="retryPreview('${state.activePreviewType}')">🔄 仅重试预览转换（不重新生成 Word 原件）</button>
        ${downloadBtnHtml}
        ${refreshBtnHtml}
      </div>
    `;
  } else {
    let stageText = '原件已生成，正在后台转换真实预览...';
    if (targetFile.status === 'QUEUED') stageText = '原件已生成，正在排队转换 PDF...';
    if (targetFile.status === 'CONVERTING_PDF') stageText = '原件已生成，正在转换 PDF...';
    if (targetFile.status === 'CONVERTING_IMAGE') stageText = 'PDF 已生成，正在渲染高清页图...';
    if (targetFile.status === 'GENERATING') stageText = '执行端正在生成 Word 原件...';

    if (state.clientPollTimeout) {
      stageText = `暂未取得最终结果（后台处理中，最近更新时间: ${state.lastQueryTime || '刚才'}）`;
    }

    container.innerHTML = `
      ${queryNoticeHtml}
      <div style="font-weight: 600; margin-bottom: 8px;">${escapeHtml(targetFile.official_filename)}</div>
      <div class="badge badge-warning" style="margin-top: 8px; padding: 10px 16px; display: block; text-align: left;">
        ⏳ ${escapeHtml(stageText)}
      </div>
      <div style="margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap;">
        ${refreshBtnHtml}
        ${downloadBtnHtml}
      </div>
    `;
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.currentTask) {
    refreshCurrentTask();
  }
});

/**
 * 仅重试预览：不重新生成原文档、不再次打印 (整改 A.4)
 */
async function retryPreview(fileType) {
  if (!state.currentTask) return;
  try {
    const res = await fetch(`${API_BASE}/api/tasks/${state.currentTask.id}/files/${fileType}/retry-preview`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
    await refreshCurrentTask();
    renderPreviewBox();
  } catch (err) {
    alert('重试预览失败：' + err.message);
  }
}

/** 重新拉取当前任务详情，保证预览地址带最新版本号（避免读到旧缓存） */
async function refreshCurrentTask() {
  if (!state.currentTask) return;
  try {
    const res = await fetch(`${API_BASE}/api/tasks/${state.currentTask.id}`);
    if (res.ok) state.currentTask = await res.json();
  } catch (e) {}
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
  const copiesRaw = document.getElementById('print-copies').value;
  const copies = parseInt(copiesRaw, 10);

  if (!printCert && !printPack) return alert('请至少勾选一个打印文件');
  if (!Number.isInteger(copies) || copies < 1 || copies > 99) {
    return alert('打印份数必须是 1-99 的整数');
  }

  const select = document.getElementById('printer-select');
  const chosenPrinter = select ? select.value : '';
  if (!chosenPrinter) {
    return alert('当前执行终端未连接或未配置可用打印机');
  }

  const workerId = state.selectedWorker ? state.selectedWorker.id : '';
  if (!workerId) return alert('请先选择执行终端');

  const taskId = state.currentTask.id;
  const files = state.currentTask.files || [];

  // 必须携带 taskId + fileId，后端据此解析真实文件与内容版本；不允许按文件名/路径猜测 (PR-B03/PR-B04)
  const batchItems = [];
  const wantCert = printCert;
  const wantPack = printPack;
  for (const f of files) {
    if (wantCert && f.file_type === 'cert') batchItems.push({ fileId: f.id, fileType: 'cert', copies });
    if (wantPack && f.file_type === 'packing') batchItems.push({ fileId: f.id, fileType: 'packing', copies });
  }
  if (batchItems.length === 0) {
    return alert('当前任务中没有可打印的已生成文件，请先生成文档后再打印');
  }

  const requestId = 'print_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);

  let res;
  try {
    res = await fetch(`${API_BASE}/api/print/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId,
        clientId: state.clientId,
        workerId,
        taskId,
        printerName: chosenPrinter,
        batchItems
      })
    });
  } catch (netErr) {
    // 网络不确定：不盲目重复提交，提示用同一 requestId 查询/重试 (PR10)
    return alert(`提交打印结果不确定（网络异常）：${netErr.message}\n请稍后在“打印状态”中查询，不要重复点击打印，避免重复出纸。`);
  }

  const contentType = res.headers.get('content-type') || '';
  let data = null;
  if (contentType.includes('application/json')) {
    try { data = await res.json(); } catch (e) { data = null; }
  } else {
    const text = await res.text().catch(() => '');
    return alert(`打印提交失败：服务响应不是 JSON（HTTP ${res.status}）。${String(text).replace(/<[^>]*>/g, ' ').slice(0, 120)}`);
  }

  // 必须同时满足 HTTP 成功、success 为真、且有有效 printJobId，才显示受理成功 (PR-B02)
  if (!res.ok || !data || data.success !== true || !data.printJobId) {
    const reason = (data && data.error) ? data.error : `HTTP ${res.status}，响应异常`;
    return alert(`打印提交失败：${reason}`);
  }

  const jobId = data.printJobId;
  state.lastPrintJobId = jobId;
  alert(
    `系统已受理打印请求（编号 #${jobId}）。\n` +
    `当前阶段：${data.status || 'QUEUED'}（已排队，等待执行端领取）\n` +
    `注意：受理不等于已进入打印机队列，更不等于已出纸；请稍后在“打印状态”中确认。`
  );
  pollPrintJobStatus(jobId);
}

/** 查询打印任务阶段与每个文件的独立状态，并如实区分“已入队列 / 结果不明” (4.1/4.3) */
async function pollPrintJobStatus(jobId, attempts = 8) {
  for (let i = 0; i < attempts; i++) {
    await new Promise(r => setTimeout(r, i === 0 ? 800 : 2000));
    let job = null;
    try {
      const res = await fetch(`${API_BASE}/api/print/${jobId}`);
      if (!res.ok) break;
      const data = await res.json();
      job = data && data.job;
    } catch (e) {
      break;
    }
    if (!job) break;
    const items = job.items || [];
    const finished = ['SUBMITTED_TO_SPOOLER', 'FAILED', 'RESULT_UNKNOWN', 'PARTIAL_SUBMITTED'].includes(job.status);
    if (finished) {
      reportPrintJobResult(job);
      return;
    }
    if (i === attempts - 1) reportPrintJobResult(job, true);
  }
}

function reportPrintJobResult(job, stillPending = false) {
  const items = job.items || [];
  const lines = items.map(it => {
    const fileLabel = it.fileType === 'cert' ? '发货证书' : '装箱清单';
    const stage = {
      QUEUED: '已排队（等待执行端领取）',
      CLAIMED: '执行端已领取',
      DISPATCHING: '正在调用打印',
      SUBMITTED_TO_SPOOLER: it.windowsJobId ? `已进入 Windows 打印队列（作业号 ${it.windowsJobId}）` : '已提交打印队列（未取得队列作业号，无法确认）',
      FAILED: `失败：${it.errorMsg || '未知原因'}`,
      RESULT_UNKNOWN: `结果无法确认：${it.errorMsg || '已调用打印但未能确认，请勿自动重印'}`
    }[it.status] || it.status;
    return `· ${fileLabel}（${it.copies || 1} 份）：${stage}`;
  }).join('\n');

  const head = stillPending
    ? `打印任务 #${job.id} 仍在处理中（当前状态：${job.status}）`
    : `打印任务 #${job.id} 状态：${job.status}`;
  alert(`${head}\n${lines}\n\n${job.stageNotice || ''}`);
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
