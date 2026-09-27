// Mobile Web (H5) Frontend Controller
const API_BASE = '';

let state = {
  clientId: localStorage.getItem('clientId') || null,
  clientName: localStorage.getItem('clientName') || '操作员',
  currentModel: 'POA200',
  hasPump: true,
  currentTask: null,
  activePreviewType: 'cert',
  historyRange: 'today',
  packingItems: [
    { index: 1, name: '主设备', spec: 'POA200', count: 1, unit: '台', standard: '是', remark: 'SN：AP10007513带泵', isProtectedMain: true },
    { index: 2, name: '传感器', spec: 'PMT210SEN', count: 1, unit: '只', standard: '是', remark: 'SN：201N200258', isProtectedSensor: true },
    { index: 3, name: '包装箱', spec: 'ABS', count: 1, unit: '个', standard: '是', remark: '' },
    { index: 4, name: '用户手册', spec: '中英文', count: 2, unit: '本', standard: '是', remark: '' },
    { index: 5, name: '计量证书', spec: '英文', count: 1, unit: '份', standard: '是', remark: '' },
    { index: 6, name: '电源适配器', spec: '902B', count: 1, unit: '个', standard: '是', remark: '' },
    { index: 7, name: 'USB数据线', spec: '/', count: 1, unit: '根', standard: '是', remark: '' },
    { index: 8, name: '标定指南', spec: '', count: 1, unit: '份', standard: '是', remark: '' },
    { index: 9, name: 'F46采样管', spec: '外径1/8英寸', count: 1, unit: '根', standard: '是', remark: '' }
  ]
};

// Initialize Application
document.addEventListener('DOMContentLoaded', async () => {
  // Register or initialize client identity
  await registerClient();
  document.getElementById('user-name-display').innerText = state.clientName;

  // Set default certificate date to today
  const todayStr = new Date().toISOString().split('T')[0];
  document.getElementById('cert-date').value = todayStr;

  // Render initial tables
  renderTestPointsTable();
  renderPackingItemsTable();

  // Poll Worker status
  checkWorkerStatus();
  setInterval(checkWorkerStatus, 5000);
});

// ==================== M01, R01: NAME REGISTRATION ====================
async function registerClient() {
  if (!state.clientId) {
    state.clientId = 'client_' + Math.random().toString(36).substring(2, 10);
    localStorage.setItem('clientId', state.clientId);
  }

  try {
    const res = await fetch(`${API_BASE}/api/clients/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: state.clientId, name: state.clientName })
    });
    const data = await res.json();
    state.clientName = data.name;
    localStorage.setItem('clientName', data.name);
  } catch (err) {
    console.warn('Register client error:', err);
  }
}

function openNameModal() {
  document.getElementById('user-name-input').value = state.clientName;
  document.getElementById('name-modal').classList.add('open');
}

function closeNameModal() {
  document.getElementById('name-modal').classList.remove('open');
}

async function saveUserName() {
  const newName = document.getElementById('user-name-input').value.trim();
  if (!newName) return alert('请输入有效姓名');

  state.clientName = newName;
  localStorage.setItem('clientName', newName);
  document.getElementById('user-name-display').innerText = newName;
  closeNameModal();

  await registerClient();
}

// ==================== M02, M03: WORKER STATUS ====================
async function checkWorkerStatus() {
  try {
    const res = await fetch(`${API_BASE}/api/workers`);
    const workers = await res.json();
    const active = workers.find(w => w.status === 'ONLINE') || workers[0];

    const badgeEl = document.getElementById('worker-status-badge');
    const detailsEl = document.getElementById('worker-details');

    if (active) {
      badgeEl.className = 'badge badge-success';
      badgeEl.innerText = '在线可连接';
      detailsEl.innerHTML = `
        <div>工作电脑: <b>${active.name}</b> (${active.ip})</div>
        <div>允许目录: <code>${active.working_dir || 'D:\\docs'}</code></div>
        <div>可用打印机: ${active.printers.join(', ') || 'Epson EcoTank L3258'}</div>
      `;
    } else {
      badgeEl.className = 'badge badge-warning';
      badgeEl.innerText = '挂起 / 本地离线';
      detailsEl.innerText = '就绪模式（等待任务下发）';
    }
  } catch (err) {
    console.warn('Check worker error:', err);
  }
}

// ==================== M04, M05, T01, T02: MODEL & PUMP ====================
function onModelChange() {
  const model = document.getElementById('model-select').value;
  state.currentModel = model;

  const pumpGroup = document.getElementById('pump-group');
  if (model === 'POA200') {
    pumpGroup.style.display = 'block';
  } else {
    pumpGroup.style.display = 'none';
  }

  renderTestPointsTable();
  renderPackingItemsTable();
}

function setPumpOption(hasPump) {
  state.hasPump = hasPump;
  document.getElementById('pump-yes').className = hasPump ? 'toggle-btn active' : 'toggle-btn';
  document.getElementById('pump-no').className = !hasPump ? 'toggle-btn active' : 'toggle-btn';

  // Update packing list row 1 remark (T10)
  const deviceSn = document.getElementById('device-sn').value || 'AP10007513';
  if (state.packingItems.length > 0) {
    state.packingItems[0].remark = `SN：${deviceSn}${hasPump ? '带泵' : ''}`;
    renderPackingItemsTable();
  }
}

// ==================== M06, T04, T05: TEST DATA TABLE ====================
function renderTestPointsTable() {
  const tbody = document.getElementById('test-points-body');
  tbody.innerHTML = '';

  if (state.currentModel === 'POA200') {
    // 1 test point row
    tbody.innerHTML = `
      <tr>
        <td>1</td>
        <td><input type="text" class="table-input" id="std-val-1" value="9.96(N2 balance)"></td>
        <td><input type="text" class="table-input" id="act-val-1" value="9.93"></td>
      </tr>
    `;
  } else {
    // DPT810: 10 test point rows
    const defaultData = [
      { point: 1, std: '-89.00', act: '6.58' },
      { point: 2, std: '-80.12', act: '7.62' },
      { point: 3, std: '-70.81', act: '8.75' },
      { point: 4, std: '-60.23', act: '10.14' },
      { point: 5, std: '-50.82', act: '11.27' },
      { point: 6, std: '-40.91', act: '12.65' },
      { point: 7, std: '-30.45', act: '13.78' },
      { point: 8, std: '-21.90', act: '14.86' },
      { point: 9, std: '-12.26', act: '16.03' },
      { point: 10, std: '10.25', act: '18.80' }
    ];

    defaultData.forEach(item => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${item.point}</td>
        <td><input type="text" class="table-input" id="std-val-${item.point}" value="${item.std}"></td>
        <td><input type="text" class="table-input" id="act-val-${item.point}" value="${item.act}"></td>
      `;
      tbody.appendChild(tr);
    });
  }
}

// ==================== M07, T06: DYNAMIC PACKING LIST ====================
function renderPackingItemsTable() {
  const tbody = document.getElementById('packing-items-body');
  tbody.innerHTML = '';

  // Continuous auto-renumbering
  state.packingItems.forEach((item, idx) => {
    item.index = idx + 1;
    const isProtected = item.isProtectedMain || item.isProtectedSensor || idx < 2;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${item.index}</td>
      <td><input type="text" class="table-input" value="${item.name}" onchange="updatePackingItem(${idx}, 'name', this.value)" ${isProtected ? 'readonly' : ''}></td>
      <td><input type="text" class="table-input" value="${item.spec || ''}" onchange="updatePackingItem(${idx}, 'spec', this.value)"></td>
      <td><input type="number" class="table-input" value="${item.count}" onchange="updatePackingItem(${idx}, 'count', this.value)"></td>
      <td><input type="text" class="table-input" value="${item.unit}" onchange="updatePackingItem(${idx}, 'unit', this.value)"></td>
      <td><input type="text" class="table-input" value="${item.standard}" onchange="updatePackingItem(${idx}, 'standard', this.value)"></td>
      <td><input type="text" class="table-input" value="${item.remark || ''}" onchange="updatePackingItem(${idx}, 'remark', this.value)"></td>
      <td>
        ${isProtected 
          ? '<span class="badge badge-disabled" title="受保护行不可删除">锁</span>' 
          : `<button type="button" class="btn btn-danger btn-sm" onclick="removePackingRow(${idx})">删除</button>`
        }
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function updatePackingItem(index, field, value) {
  if (state.packingItems[index]) {
    state.packingItems[index][field] = value;
  }
}

function addPackingRow() {
  const newIdx = state.packingItems.length + 1;
  state.packingItems.push({
    index: newIdx,
    name: '新增物料',
    spec: '通用',
    count: 1,
    unit: '件',
    standard: '是',
    remark: ''
  });
  renderPackingItemsTable();
}

function removePackingRow(index) {
  if (index < 2 || state.packingItems[index].isProtectedMain || state.packingItems[index].isProtectedSensor) {
    alert('主设备与传感器属于受保护行，不允许删除！(T06)');
    return;
  }
  state.packingItems.splice(index, 1);
  renderPackingItemsTable();
}

// ==================== M08, R07-R10: SUBMIT TASK ====================
async function submitTaskForm() {
  const deviceSn = document.getElementById('device-sn').value.trim();
  const shippingLocation = document.getElementById('shipping-location').value.trim();
  const sensorModel = document.getElementById('sensor-model').value;
  const sensorSn = document.getElementById('sensor-sn').value.trim();
  const certDate = document.getElementById('cert-date').value;

  if (!deviceSn) return alert('请输入设备序列号');

  // Gather test points
  const testPoints = [];
  const rowsCount = state.currentModel === 'POA200' ? 1 : 10;
  for (let i = 1; i <= rowsCount; i++) {
    const stdVal = document.getElementById(`std-val-${i}`).value;
    const actVal = document.getElementById(`act-val-${i}`).value;
    testPoints.push({ point: i, std: stdVal, act: actVal });
  }

  // Generate unique request ID for deduplication (R09)
  const reqId = 'req_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);

  const payload = {
    reqId,
    clientId: state.clientId,
    clientName: state.clientName,
    model: state.currentModel,
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

    alert(`任务已提交排队受理！ (Task ID: #${data.task.id})\n官方生成文件名:\n1. ${data.task.files[0]?.official_filename}\n2. ${data.task.files[1]?.official_filename}`);

    // Switch to preview tab
    switchNavTab('preview');
    loadTaskPreview(data.task.id);
  } catch (err) {
    alert('提交失败: ' + err.message);
  }
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
  if (!state.currentTask) {
    container.innerHTML = '请先在“发货任务”中提交生成证书与清单';
    return;
  }

  const targetFile = state.currentTask.files.find(f => f.file_type === state.activePreviewType);
  if (!targetFile) {
    container.innerHTML = '未找到对应的文件记录';
    return;
  }

  const previews = targetFile.preview_images || [];
  if (previews.length > 0) {
    container.innerHTML = `
      <div style="font-weight: 600; margin-bottom: 8px;">${targetFile.official_filename}</div>
      ${previews.map(url => `<div style="margin-bottom: 8px;"><img src="${url}" alt="Preview Page"></div>`).join('')}
    `;
  } else {
    container.innerHTML = `
      <div style="font-weight: 600; margin-bottom: 8px;">${targetFile.official_filename}</div>
      <div class="badge badge-warning" style="margin-top: 12px; padding: 8px 16px;">正在后台生成 Word 原件及分页预览图片...</div>
    `;
  }
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
    const res = await fetch(`${API_BASE}/api/print/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: state.clientId,
        printerName: 'Epson EcoTank L3258',
        batchItems
      })
    });
    const data = await res.json();
    alert(`打印任务已成功发往局域网共享打印队列！(Print Job #${data.printJobId})`);
  } catch (err) {
    alert('提交打印失败: ' + err.message);
  }
}

// ==================== M13, R30: HISTORY ====================
function setHistoryRange(range) {
  state.historyRange = range;
  ['today', 'week', 'month'].forEach(r => {
    document.getElementById(`range-${r}`).className = r === range ? 'toggle-btn active' : 'toggle-btn';
  });
  loadHistoryList();
}

async function loadHistoryList() {
  const listEl = document.getElementById('history-list');
  listEl.innerHTML = '加载中...';

  try {
    const res = await fetch(`${API_BASE}/api/tasks?range=${state.historyRange}`);
    const tasks = await res.json();

    if (tasks.length === 0) {
      listEl.innerHTML = '<div style="text-align: center; color: #666; padding: 16px;">暂无历史记录</div>';
      return;
    }

    listEl.innerHTML = tasks.map(t => `
      <div style="border-bottom: 1px solid #eee; padding: 10px 0;">
        <div style="display: flex; justify-content: space-between;">
          <b>#${t.id} - ${t.model} (${t.device_sn})</b>
          <span class="badge ${t.status === 'SUCCESS' ? 'badge-success' : 'badge-warning'}">${t.status}</span>
        </div>
        <div style="font-size: 12px; color: #666; margin-top: 4px;">
          操作人: ${t.client_name} | 受理时间: ${new Date(t.accepted_at).toLocaleString('zh-CN')}
        </div>
        <div style="font-size: 12px; color: #0052cc; margin-top: 4px;">
          ${t.files.map(f => f.official_filename).join('<br>')}
        </div>
      </div>
    `).join('');
  } catch (err) {
    listEl.innerHTML = '加载历史失败: ' + err.message;
  }
}

// ==================== NAVIGATION TABS ====================
function switchNavTab(tabName) {
  ['create', 'preview', 'history', 'serial'].forEach(t => {
    document.getElementById(`tab-${t}-view`).style.display = t === tabName ? 'block' : 'none';
    document.getElementById(`nav-${t}`).className = t === tabName ? 'nav-tab active' : 'nav-tab';
  });

  if (tabName === 'history') {
    loadHistoryList();
  }
}
