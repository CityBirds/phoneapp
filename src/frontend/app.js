/**
 * phoneApp Mobile & Workstation Client Logic (手机/车间作业端)
 * Rules: M01 - M15
 */

const API_BASE = window.location.origin;

const state = {
  clientId: localStorage.getItem('phoneapp_client_id') || '',
  clientName: localStorage.getItem('phoneapp_user_name') || '',
  selectedWorker: null,
  workers: [],
  currentModel: 'POA200',
  hasPump: true,
  currentTask: null,
  activePreviewType: 'cert',
  historyRange: 'today',
  packingItems: [
    { index: 1, name: '主设备', spec: 'POA200', count: 1, unit: '台', standard: '是', remark: 'SN: AP10007513带泵', isProtectedMain: true },
    { index: 2, name: '传感器', spec: 'PMT210SEN', count: 1, unit: '支', standard: '是', remark: 'SN: 201N200258', isProtectedSensor: true },
    { index: 3, name: '仪器包装箱', spec: 'ABS', count: 1, unit: '个', standard: '是', remark: '' },
    { index: 4, name: '用户手册', spec: '中英文', count: 1, unit: '份', standard: '是', remark: '' },
    { index: 5, name: '出厂合格证', spec: '中英文', count: 1, unit: '份', standard: '是', remark: '' },
    { index: 6, name: '电源适配器', spec: '902B', count: 1, unit: '个', standard: '是', remark: '' },
    { index: 7, name: 'USB通讯线', spec: '标准', count: 1, unit: '根', standard: '是', remark: '' },
    { index: 8, name: '标定指示卡', spec: '标准', count: 1, unit: '张', standard: '是', remark: '' },
    { index: 9, name: 'F46测试管', spec: '外径1/8英寸', count: 1, unit: '根', standard: '是', remark: '' }
  ]
};

// ==================== INITIALIZATION ====================
window.addEventListener('DOMContentLoaded', async () => {
  initClientIdentity();
  initFormDefaults();
  renderTestPoints();
  renderPackingTable();
  
  await loadWorkers();
  await syncClientNameFromServer();

  // If user previously selected a worker that is online, select it
  const savedWorkerId = localStorage.getItem('phoneapp_selected_worker_id');
  if (savedWorkerId) {
    const found = state.workers.find(w => w.id === savedWorkerId && w.status === 'ONLINE');
    if (found) {
      selectWorker(found, false);
    }
  }

  // If still no worker selected, open workers tab first
  if (!state.selectedWorker) {
    switchNavTab('workers');
  }

  // Periodic poll for workers and client name updates from coordination server
  setInterval(loadWorkers, 5000);
  setInterval(syncClientNameFromServer, 5000);
});

// ==================== C01, M01: CLIENT IDENTITY ====================
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

    // Update active worker indicator if currently selected
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
          <div style="margin-top: 4px;"><b>检测到打印机 (支持局域网多终端共享):</b></div>
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

function selectWorker(worker, shouldSwitchTab = true) {
  state.selectedWorker = worker;
  localStorage.setItem('phoneapp_selected_worker_id', worker.id);
  updateWorkerUI(worker);

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

  // Update printer select in Preview & Print Tab
  if (worker) {
    updatePrinterDropdown(worker.printers || []);
  }
}

// ==================== FORM SETUP ====================
function initFormDefaults() {
  const today = new Date().toISOString().slice(0, 10);
  document.getElementById('cert-date').value = today;
}

function onModelChange() {
  const model = document.getElementById('model-select').value;
  state.currentModel = model;

  const pumpGroup = document.getElementById('pump-group');
  if (model === 'DPT810') {
    pumpGroup.style.display = 'none';
    state.hasPump = false;
  } else {
    pumpGroup.style.display = 'block';
  }

  renderTestPoints();
}

function setPumpOption(hasPump) {
  state.hasPump = hasPump;
  document.getElementById('pump-yes').className = hasPump ? 'toggle-btn active' : 'toggle-btn';
  document.getElementById('pump-no').className = !hasPump ? 'toggle-btn active' : 'toggle-btn';
}

function renderTestPoints() {
  const tbody = document.getElementById('test-points-body');
  if (state.currentModel === 'POA200') {
    tbody.innerHTML = `
      <tr>
        <td>点 1 (ppm)</td>
        <td><input type="text" id="tp-std-1" value="9.96(N2 balance)"></td>
        <td><input type="text" id="tp-act-1" value="9.93"></td>
      </tr>
    `;
  } else {
    tbody.innerHTML = `
      <tr>
        <td>点 1 (-60℃)</td>
        <td><input type="text" id="tp-std-1" value="4.00 mA"></td>
        <td><input type="text" id="tp-act-1" value="3.99 mA"></td>
      </tr>
      <tr>
        <td>点 2 (+20℃)</td>
        <td><input type="text" id="tp-std-2" value="20.00 mA"></td>
        <td><input type="text" id="tp-act-2" value="19.98 mA"></td>
      </tr>
    `;
  }
}

function renderPackingTable() {
  const tbody = document.getElementById('packing-items-body');
  tbody.innerHTML = state.packingItems.map((item, idx) => {
    const isProtected = idx < 2;
    return `
      <tr>
        <td>${item.index}</td>
        <td>${item.name} ${isProtected ? '<span class="badge badge-warning">保护行</span>' : ''}</td>
        <td><input type="text" value="${item.spec}" onchange="updatePackingItem(${idx}, 'spec', this.value)"></td>
        <td><input type="number" style="width: 50px;" value="${item.count}" onchange="updatePackingItem(${idx}, 'count', this.value)"></td>
        <td><input type="text" style="width: 50px;" value="${item.unit}" onchange="updatePackingItem(${idx}, 'unit', this.value)"></td>
        <td>${item.standard}</td>
        <td><input type="text" value="${item.remark}" onchange="updatePackingItem(${idx}, 'remark', this.value)"></td>
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
  state.packingItems[idx][key] = val;
}

function addPackingRow() {
  const newIdx = state.packingItems.length + 1;
  state.packingItems.push({
    index: newIdx,
    name: '自选辅料',
    spec: '标准配件',
    count: 1,
    unit: '件',
    standard: '否',
    remark: ''
  });
  renderPackingTable();
}

function deletePackingRow(idx) {
  if (idx < 2) return alert('保护行（主设备与传感器）严禁删除 (E06, T06)');
  state.packingItems.splice(idx, 1);
  state.packingItems.forEach((item, i) => item.index = i + 1);
  renderPackingTable();
}

// ==================== TASK SUBMISSION & FAST PREVIEW POLLING ====================
async function submitTaskForm() {
  if (!state.selectedWorker) {
    alert('请先选择一个在线执行终端电脑！');
    switchNavTab('workers');
    return;
  }

  const model = document.getElementById('model-select').value;
  const deviceSn = document.getElementById('device-sn').value.trim();
  const shippingLocation = document.getElementById('shipping-location').value.trim();
  const sensorModel = document.getElementById('sensor-model').value;
  const sensorSn = document.getElementById('sensor-sn').value.trim();
  const certDate = document.getElementById('cert-date').value;

  if (!deviceSn) return alert('请填写设备序列号 (Inst. SN.)');
  if (!shippingLocation) return alert('请填写发货目的地 (Customer)');

  const testPoints = [];
  const tpStd1 = document.getElementById('tp-std-1');
  const tpAct1 = document.getElementById('tp-act-1');
  if (tpStd1 && tpAct1) testPoints.push({ point: 1, std: tpStd1.value, act: tpAct1.value });

  const tpStd2 = document.getElementById('tp-std-2');
  const tpAct2 = document.getElementById('tp-act-2');
  if (tpStd2 && tpAct2) testPoints.push({ point: 2, std: tpStd2.value, act: tpAct2.value });

  const reqId = 'req_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);

  const payload = {
    reqId,
    clientId: state.clientId,
    clientName: state.clientName,
    workerId: state.selectedWorker.id,
    model,
    deviceSn,
    shippingLocation,
    sensorModel,
    sensorSn,
    hasPump: state.hasPump,
    certDate,
    testPoints,
    packingItems: state.packingItems
  };

  try {
    const res = await fetch(`${API_BASE}/api/tasks/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    state.currentTask = data.task;

    // Switch to preview tab immediately
    switchNavTab('preview');
    renderPreviewLoading();

    // Start smart fast polling (700ms) until previews are ready
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

// ==================== M10, R17, R21, R22: PREVIEW & PRINT ====================
async function loadTaskPreview(taskId) {
  try {
    const res = await fetch(`${API_BASE}/api/tasks/${taskId}`);
    const task = await res.json();
    state.currentTask = task;
    renderPreviewBox();
  } catch (err) {
    console.warn('Load preview error:', err);
  }
}

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

  // Update download button
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

// ==================== M13, R30: HISTORY & INSTANT PREVIEW VIEW ====================
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
            ${t.files.map(f => `<div>📄 ${f.official_filename}</div>`).join('')}
          </div>

          <!-- History Action Buttons for Previews and Downloads -->
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
  }
}

// Printer Helper
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

  printers.forEach(p => {
    const pName = typeof p === 'string' ? p : p.name;
    const isVirtual = pName.toLowerCase().includes('pdf') || pName.toLowerCase().includes('onenote') || pName.includes('导出');
    const opt = document.createElement('option');
    opt.value = pName;
    opt.innerText = isVirtual ? `${pName} (虚拟打印/导出)` : `${pName} (物理/共享打印机)`;
    select.appendChild(opt);
  });

  if (currentVal && printers.some(p => (typeof p === 'string' ? p : p.name) === currentVal)) {
    select.value = currentVal;
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

  const isVirtual = val.toLowerCase().includes('pdf') || val.toLowerCase().includes('onenote') || val.includes('导出');
  if (isVirtual) {
    tip.innerText = 'ℹ️ 当前选择为虚拟打印机，打印操作将导出至文件/系统队列，不会实际出纸。';
  } else {
    tip.innerText = '✅ 当前已就绪，打印任务将发送至执行端物理打印机出纸。';
  }
}
