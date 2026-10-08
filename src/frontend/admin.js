
// Safe JSON Fetch helper (FIX-13: Handle HTML and non-JSON responses cleanly)
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
    data = await res.json();
  } else {
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`服务响应异常 (HTTP ${res.status}): ${text.substring(0, 100)}`);
    }
    throw new Error(`预期 JSON 响应，但收到非 JSON 格式: ${text.substring(0, 100)}`);
  }

  if (!res.ok) {
    throw new Error(data && data.error ? data.error : `请求失败 (HTTP ${res.status})`);
  }
  return data;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, m => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[m]);
}

// ==================== C01, R01, FIX-01, FIX-02, FIX-03: CLIENT MANAGEMENT ====================
async function loadClients() {
  const tbody = document.getElementById('clients-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 20px; color: #64748b;">正在加载客户端列表...</td></tr>';

  try {
    const clients = await safeFetchJson(`${API_BASE}/api/clients`);
    if (!Array.isArray(clients) || clients.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 24px; color: #94a3b8;">暂无客户端登记记录</td></tr>';
      return;
    }

    const now = Date.now();
    tbody.innerHTML = clients.map(c => {
      const lastSeenTime = c.last_seen ? new Date(c.last_seen).getTime() : 0;
      const isOnline = (now - lastSeenTime) < 300000; // 5 min
      const badgeClass = isOnline ? 'badge-success' : 'badge-secondary';
      const statusText = isOnline ? '在线' : '离线';
      const formattedTime = c.last_seen ? new Date(c.last_seen).toLocaleString('zh-CN') : '-';

      return `
        <tr>
          <td style="font-family: monospace; font-size: 12px; color: #475569;">${escapeHtml(c.id)}</td>
          <td><b id="client-name-${escapeHtml(c.id)}" style="color: #0f172a; font-size: 14px;">${escapeHtml(c.name)}</b></td>
          <td style="font-size: 12px; color: #64748b;">${formattedTime}</td>
          <td><span class="badge ${badgeClass}">${statusText}</span></td>
          <td style="text-align: right;">
            <button type="button" class="btn btn-sm btn-secondary" onclick="handleRenameClient('${escapeHtml(c.id)}', '${escapeHtml(c.name)}')">
              ✏️ 修改姓名
            </button>
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 24px; color: #ef4444;">
      加载客户端失败: ${escapeHtml(err.message)}
      <button type="button" class="btn btn-secondary btn-sm" onclick="loadClients()" style="margin-left: 10px;">🔄 重试</button>
    </td></tr>`;
  }
}

async function handleRenameClient(clientId, currentName) {
  const newName = prompt(`请输入客户端 [${clientId}] 的新姓名 (由协调服务统一分配):`, currentName);
  if (!newName || !newName.trim() || newName.trim() === currentName) return;

  try {
    const data = await safeFetchJson(`${API_BASE}/api/clients/${encodeURIComponent(clientId)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': 'phoneapp-admin-secret'
      },
      body: JSON.stringify({ name: newName.trim() })
    });
    alert(`客户端姓名已成功修改为 [${data.name}]！手机端后续同步将生效。`);
    await loadClients();
  } catch (err) {
    alert('修改客户端姓名失败: ' + err.message);
  }
}

/**
 * phoneApp Coordinator Server Admin Console Logic (协调服务主机专用控制台)
 * Rules: C01, C02, C03, C04, C05, C13, F01-F16, G01-G12, Spec Sec 5
 */

const API_BASE = window.location.origin;

let currentMatcherData = null;
let currentAnalyzeToken = null;
let currentAnalyzeTmplId = null;

window.addEventListener('DOMContentLoaded', () => {
  function handleHashRoute() {
    const hash = window.location.hash || '#clients';
    if (hash === '#directories' || hash.startsWith('#directories')) {
      // WC-02/E01: 旧地址改为明确引导到终端列表，不再保留空白入口
      switchTab('directories');
    } else if (hash.startsWith('#worker-detail')) {
      const match = hash.match(/workerId=([^&]+)/);
      if (match) {
        showWorkerDetail(decodeURIComponent(match[1]));
      } else {
        // 直接打开 / 刷新 #worker-detail（缺少 workerId）也必须显示引导，不能空白 (WC-02)
        switchTab('worker-detail');
      }
    } else if (hash.startsWith('#workers')) {
      switchTab('workers');
    } else if (hash.startsWith('#templates')) {
      switchTab('templates');
    } else if (hash.startsWith('#matcher')) {
      switchTab('matcher');
    } else if (hash.startsWith('#audit')) {
      switchTab('audit');
    } else {
      switchTab('clients');
    }
  }

  window.addEventListener('hashchange', handleHashRoute);
  handleHashRoute();
});

// Tab Navigation
let currentDetailWorkerId = null;
let currentWorkerAllowedPaths = [];
let currentWorkerAuthState = 'UNCONFIRMED';
let currentWorkerAuthNote = null;
let currentWorkerTemplateConfigs = [];

// Tab Navigation
async function switchTab(tabId) {
  const isDirectories = tabId === 'directories';
  const effectiveTab = isDirectories ? 'workers' : tabId;

  ['clients', 'workers', 'worker-detail', 'templates', 'sales-persons', 'sensor-configs', 'matcher', 'audit'].forEach(t => {
    const sec = document.getElementById(`sec-${t}`);
    const side = document.getElementById(`side-${t}`);
    if (sec) sec.style.display = t === effectiveTab ? 'block' : 'none';
    if (side) {
      if (isDirectories && t === 'workers') side.classList.add('active');
      else if (t === effectiveTab || ((effectiveTab === 'sales-persons' || effectiveTab === 'sensor-configs') && t === 'templates')) side.classList.add('active');
      else side.classList.remove('active');
    }
  });

  const banner = document.getElementById('directories-migration-banner');
  if (banner) {
    banner.style.display = isDirectories ? 'block' : 'none';
  }

  // 终端详情：有 workerId 时显示配置，没有时显示明确引导页（E01, WC-02）
  if (effectiveTab === 'worker-detail') {
    renderWorkerDetailGuidance(currentDetailWorkerId);
  }

  if (effectiveTab === 'clients') await loadClients();
  if (effectiveTab === 'workers') await loadWorkers();
  if (effectiveTab === 'templates') await loadTemplates();
  if (effectiveTab === 'sales-persons') await loadSalesPersons();
  if (effectiveTab === 'sensor-configs') await loadSensorConfigs();
  if (effectiveTab === 'matcher') await populateMatcherSelect(null, true);
  if (effectiveTab === 'audit') await loadAuditLogs();
}

/**
 * 终端详情页引导：未选择终端（例如直接访问 /admin#worker-detail）时展示可选终端卡片，
 * 保证任何入口都不会出现空白内容区 (E01, WC-02)
 */
async function renderWorkerDetailGuidance(workerId) {
  const guidance = document.getElementById('worker-detail-guidance');
  const body = document.getElementById('worker-detail-body');
  if (!guidance || !body) return;

  if (workerId) {
    guidance.style.display = 'none';
    body.style.display = 'block';
    return;
  }

  guidance.style.display = 'block';
  body.style.display = 'none';

  const listEl = document.getElementById('worker-detail-guidance-list');
  if (!listEl) return;
  listEl.innerHTML = '<div style="padding: 10px; color: #64748b;">正在加载执行终端列表...</div>';

  try {
    const workers = await safeFetchJson(`${API_BASE}/api/workers?all=true`);
    const list = Array.isArray(workers) ? workers : [];
    if (list.length === 0) {
      listEl.innerHTML = '<div style="padding: 10px; color: #64748b;">当前没有已登记的执行终端。请先在执行端电脑上启动执行端程序（启动执行端.bat）。</div>';
      return;
    }
    listEl.innerHTML = list.map(w => `
      <div class="worker-stat-card" style="cursor: pointer;" onclick="showWorkerDetail('${escapeHtml(w.id)}')">
        <div class="worker-stat-card-header">
          <div>
            <b>💻 ${escapeHtml(w.name)}</b>
            <div style="font-size: 12px; color: #64748b;">终端 ID: ${escapeHtml(w.id)}</div>
          </div>
          <span class="badge ${w.status === 'ONLINE' ? 'badge-success' : 'badge-danger'}">${w.status === 'ONLINE' ? '🟢 在线' : '🔴 离线'}</span>
        </div>
        <div style="margin-top: 10px;">
          <button type="button" class="btn btn-primary btn-sm">⚙️ 进入该终端配置</button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    listEl.innerHTML = `<div style="padding: 10px; color: #ef4444;">加载执行终端失败: ${escapeHtml(err.message)}</div>`;
  }
}

async function loadWorkers() {
  const container = document.getElementById('workers-grid-container');
  container.innerHTML = '<div style="padding: 20px;">正在检测执行终端...</div>';

  try {
    const res = await fetch(`${API_BASE}/api/workers?all=true`);
    const workers = await res.json();

    if (workers.length === 0) {
      container.innerHTML = '<div style="color: #64748b; padding: 20px;">当前未检测到任何执行终端上线</div>';
      return;
    }

    container.innerHTML = workers.map(w => {
      const isOnline = w.status === 'ONLINE';
      const printerDetails = w.printerDetails || [];

      // WC-03: Printer area has event.stopPropagation() so clicks don't falsely trigger worker config
      const printersHtml = printerDetails.length > 0 
        ? printerDetails.map(p => `
            <span class="printer-pill ${p.isShared ? 'shared' : ''}">
              ${p.isShared ? '🖨️ [共享]' : (p.isVirtual ? '📄 [虚拟]' : '🖨️ [物理]')} ${p.name}
            </span>
          `).join('')
        : '<span style="font-size: 12px; color: #94a3b8;">未检测到打印机</span>';

      return `
        <div class="worker-stat-card" style="cursor: pointer; position: relative;" onclick="showWorkerDetail('${w.id}')">
          <div class="worker-stat-card-header">
            <div>
              <b style="font-size: 16px; color: #0f172a;">💻 ${w.name}</b>
              <div style="font-size: 12px; color: #64748b;">终端 ID: ${w.id}</div>
            </div>
            <span class="badge ${isOnline ? 'badge-success' : 'badge-danger'}">
              ${isOnline ? '🟢 在线就绪' : '🔴 离线'}
            </span>
          </div>
          <div style="font-size: 13px; color: #334155; margin: 8px 0; line-height: 1.6;">
            <div><b>IP 地址:</b> ${w.ip || '127.0.0.1'}</div>
            <div><b>程序工作目录:</b> <code>${w.working_dir || '默认目录'}</code> <span style="font-size: 11px; color: #94a3b8;">(程序运行工作目录，不作为业务保存目录)</span></div>
            <div><b>最后心跳:</b> ${w.last_heartbeat ? new Date(w.last_heartbeat).toLocaleString('zh-CN') : '无'}</div>
          </div>
          <div style="margin-top: 10px; background: #f8fafc; padding: 8px; border-radius: 6px;" onclick="event.stopPropagation()">
            <div style="font-size: 12px; font-weight: 700; color: #475569; margin-bottom: 4px;">检测到打印机外设 (点击外设不触发配置):</div>
            <div>${printersHtml}</div>
          </div>
          <div style="margin-top: 14px; display: flex; justify-content: flex-end;">
            <button type="button" class="btn btn-primary btn-sm btn-worker-config" onclick="event.stopPropagation(); showWorkerDetail('${w.id}')">⚙️ 终端详情与保存配置</button>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    container.innerHTML = '加载执行终端失败: ' + err.message;
  }
}

// ==================== WORKER DETAIL & SAVE CONFIGURATION (E01-E04) ====================
async function showWorkerDetail(workerId) {
  if (!workerId) {
    currentDetailWorkerId = null;
    window.location.hash = '#worker-detail';
    await switchTab('worker-detail');
    return;
  }

  currentDetailWorkerId = workerId;
  window.location.hash = `#worker-detail?workerId=${encodeURIComponent(workerId)}`;

  ['clients', 'workers', 'templates', 'matcher', 'audit'].forEach(t => {
    const sec = document.getElementById(`sec-${t}`);
    const side = document.getElementById(`side-${t}`);
    if (sec) sec.style.display = 'none';
    if (side) side.classList.remove('active');
  });

  const secDetail = document.getElementById('sec-worker-detail');
  if (secDetail) secDetail.style.display = 'block';
  await renderWorkerDetailGuidance(workerId);

  // Load Worker Info（离线终端也允许编辑配置，但状态必须如实显示）(4.1, WC-06)
  try {
    const workers = await safeFetchJson(`${API_BASE}/api/workers?all=true`);
    const worker = (Array.isArray(workers) ? workers : []).find(w => w.id === workerId) || { id: workerId, name: workerId, status: 'OFFLINE' };

    let printersText = '无';
    try {
      const printers = Array.isArray(worker.printers) ? worker.printers : JSON.parse(worker.printers || '[]');
      printersText = printers.map(p => (typeof p === 'string' ? p : p.name)).filter(Boolean).join('、') || '无';
    } catch (e) {}

    document.getElementById('detail-worker-title').innerText = `🖥️ 执行终端配置: ${worker.name}`;
    document.getElementById('detail-worker-status-badge').innerHTML = `
      <span class="badge ${worker.status === 'ONLINE' ? 'badge-success' : 'badge-danger'}" style="font-size: 14px; padding: 6px 12px;">
        ${worker.status === 'ONLINE' ? '🟢 在线就绪' : '🔴 离线（可编辑配置，远端检查保持待检查）'}
      </span>
    `;

    document.getElementById('detail-worker-info-content').innerHTML = `
      <div><b>终端名称:</b> ${escapeHtml(worker.name)}</div>
      <div><b>固定 Worker ID:</b> <code>${escapeHtml(worker.id)}</code></div>
      <div><b>在线状态:</b> ${worker.status === 'ONLINE' ? '🟢 在线' : '🔴 离线'}</div>
      <div><b>IP 地址:</b> ${escapeHtml(worker.ip || '127.0.0.1')}</div>
      <div><b>程序工作目录:</b> <code>${escapeHtml(worker.working_dir || '未上报')}</code><br><span style="font-size: 11px; color: #94a3b8;">程序运行工作目录，仅作运行信息展示，不构成业务文件访问授权</span></div>
      <div><b>最后心跳:</b> ${worker.last_heartbeat ? new Date(worker.last_heartbeat).toLocaleString('zh-CN') : '无'}</div>
      <div><b>关联打印机:</b> ${escapeHtml(printersText)}</div>
    `;
  } catch (e) {
    console.error('Load worker summary error:', e);
  }

  await loadWorkerAllowedPaths(workerId);
  await loadWorkerTemplateConfigs(workerId);
}

function backToWorkersList() {
  window.location.hash = '#workers';
  switchTab('workers');
}

function renderAuthStateBanner() {
  const banner = document.getElementById('auth-state-banner');
  if (!banner) return;

  if (currentWorkerAuthState === 'EXPLICIT') {
    banner.style.display = 'none';
    banner.innerHTML = '';
    return;
  }

  banner.style.display = 'block';
  banner.style.background = '#fef3c7';
  banner.style.border = '1px solid #fbbf24';
  banner.style.color = '#92400e';
  banner.innerHTML = `
    ⚠️ <b>该执行端授权范围尚待确认（迁移状态）</b>：本终端此前没有配置任何“允许访问的业务路径”，
    系统不会默认放开全部目录。请在此页面配置业务路径（可读/可写）后，模板保存目录才能通过校验并执行。
    ${currentWorkerAuthNote ? `<div style="font-size: 12px; margin-top: 4px;">说明：${escapeHtml(currentWorkerAuthNote)}</div>` : ''}
  `;
}

// --- 1. Allowed Paths Management ---
async function loadWorkerAllowedPaths(workerId) {
  const tbody = document.getElementById('allowed-paths-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; padding: 14px; color: #64748b;">正在加载允许访问的业务路径...</td></tr>';

  try {
    const data = await safeFetchJson(`${API_BASE}/api/admin/workers/${encodeURIComponent(workerId)}/allowed-paths`);
    // 兼容两种返回结构：{ allowedPaths, authState } 或直接的数组
    if (Array.isArray(data)) {
      currentWorkerAllowedPaths = data;
      currentWorkerAuthState = 'UNCONFIRMED';
      currentWorkerAuthNote = null;
    } else {
      currentWorkerAllowedPaths = Array.isArray(data.allowedPaths) ? data.allowedPaths : [];
      currentWorkerAuthState = data.authState || 'UNCONFIRMED';
      currentWorkerAuthNote = data.authStateNote || null;
    }
    renderAuthStateBanner();

    if (currentWorkerAllowedPaths.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; padding: 18px; color: #94a3b8;">当前执行端尚未配置任何授权业务路径，请点击上方按钮添加。</td></tr>';
      return;
    }

    tbody.innerHTML = currentWorkerAllowedPaths.map(p => {
      let badgeClass = 'badge-secondary';
      let statusText = '待检查';
      if (p.check_status === 'PASSED') {
        badgeClass = 'badge-success';
        statusText = '通过';
      } else if (p.check_status === 'FAILED') {
        badgeClass = 'badge-danger';
        statusText = '失败';
      } else if (p.check_status === 'CHECKING') {
        badgeClass = 'badge-warning';
        statusText = '检查中';
      }

      const isSynced = p.sync_status === 'SYNCED';
      const syncHtml = isSynced
        ? '<span style="font-size: 12px; color: #16a34a;">✅ 已同步</span>'
        : '<span style="font-size: 12px; color: #d97706;">⏳ 待同步<br><span style="font-size: 11px;">执行端尚未确认</span></span>';

      return `
        <tr style="border-bottom: 1px solid #f1f5f9;">
          <td style="padding: 10px; font-family: monospace; font-weight: 600;">${escapeHtml(p.root_path)}</td>
          <td style="padding: 10px; text-align: center; font-size: 12px; color: #64748b;">v${p.version || 1}</td>
          <td style="padding: 10px; text-align: center;">${p.allow_read ? '✅ 允许' : '❌ 禁止'}</td>
          <td style="padding: 10px; text-align: center;">${p.allow_write ? '✅ 允许' : '❌ 禁止'}</td>
          <td style="padding: 10px; text-align: center;">${syncHtml}</td>
          <td style="padding: 10px; text-align: center;"><span class="badge ${badgeClass}">${statusText}</span></td>
          <td style="padding: 10px; font-size: 12px; color: #64748b;">${escapeHtml(p.check_message || '-')}</td>
          <td style="padding: 10px; text-align: center;">
            <button type="button" class="btn btn-secondary btn-sm" onclick="openEditAllowedPathModal(${p.id})">✏️ 修改</button>
            <button type="button" class="btn btn-secondary btn-sm" onclick="checkAllowedPath(${p.id})">🔍 立即探测</button>
            <button type="button" class="btn btn-danger btn-sm" onclick="deleteAllowedPath(${p.id})">🗑️ 删除</button>
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" style="color: #ef4444; text-align: center; padding: 16px;">
      加载授权业务路径失败: ${escapeHtml(err.message)}
      <button type="button" class="btn btn-secondary btn-sm" onclick="loadWorkerAllowedPaths('${escapeHtml(workerId)}')" style="margin-left: 10px;">🔄 重试</button>
    </td></tr>`;
  }
}

function openAddAllowedPathModal() {
  document.getElementById('modal-allowed-path-title').innerText = '➕ 添加允许访问业务路径';
  document.getElementById('auth-path-id').value = '';
  document.getElementById('auth-path-input').value = '';
  document.getElementById('auth-read-check').checked = true;
  document.getElementById('auth-write-check').checked = true;
  document.getElementById('auth-create-check').checked = false; // 保守默认值
  document.getElementById('modal-allowed-path').style.display = 'flex';
}

function openEditAllowedPathModal(id) {
  const p = currentWorkerAllowedPaths.find(x => x.id === id);
  if (!p) return;
  document.getElementById('modal-allowed-path-title').innerText = '✏️ 修改允许访问业务路径';
  document.getElementById('auth-path-id').value = p.id;
  document.getElementById('auth-path-input').value = p.root_path;
  document.getElementById('auth-read-check').checked = Boolean(p.allow_read);
  document.getElementById('auth-write-check').checked = Boolean(p.allow_write);
  document.getElementById('auth-create-check').checked = Boolean(p.allow_create);
  document.getElementById('modal-allowed-path').style.display = 'flex';
}

function closeAllowedPathModal() {
  document.getElementById('modal-allowed-path').style.display = 'none';
}

async function handleSaveAllowedPath(e) {
  e.preventDefault();
  if (!currentDetailWorkerId) return;

  const id = document.getElementById('auth-path-id').value;
  const rootPath = document.getElementById('auth-path-input').value.trim();
  const allowRead = document.getElementById('auth-read-check').checked;
  const allowWrite = document.getElementById('auth-write-check').checked;
  const allowCreate = document.getElementById('auth-create-check').checked;

  try {
    const res = await fetch(`${API_BASE}/api/admin/workers/${encodeURIComponent(currentDetailWorkerId)}/allowed-paths`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id || undefined, rootPath, allowRead, allowWrite, allowCreate })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '保存失败');

    closeAllowedPathModal();
    await loadWorkerAllowedPaths(currentDetailWorkerId);
  } catch (err) {
    alert('保存授权路径失败: ' + err.message);
  }
}

async function checkAllowedPath(id) {
  if (!currentDetailWorkerId) return;
  try {
    await safeFetchJson(`${API_BASE}/api/admin/workers/${encodeURIComponent(currentDetailWorkerId)}/allowed-paths/${id}/check`, {
      method: 'POST',
      headers: {
        'x-admin-token': 'phoneapp-admin-secret'
      }
    });
    await loadWorkerAllowedPaths(currentDetailWorkerId);
  } catch (err) {
    alert('发起探测失败: ' + err.message);
  }
}

async function deleteAllowedPath(id) {
  if (!currentDetailWorkerId) return;
  if (!confirm('确定要删除该授权业务路径吗？关联的结果保存目录将自动失效并需重新检查。')) return;

  try {
    const res = await fetch(`${API_BASE}/api/admin/workers/${encodeURIComponent(currentDetailWorkerId)}/allowed-paths/${id}`, {
      method: 'DELETE'
    });
    if (!res.ok) throw new Error('删除失败');
    await loadWorkerAllowedPaths(currentDetailWorkerId);
    await loadWorkerTemplateConfigs(currentDetailWorkerId);
  } catch (err) {
    alert('删除失败: ' + err.message);
  }
}

// --- 2. Templates & Save Directories Management ---
async function loadWorkerTemplateConfigs(workerId) {
  const tbody = document.getElementById('worker-templates-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="10" style="text-align: center; padding: 14px; color: #64748b;">正在加载本终端模板配置...</td></tr>';

  try {
    const tmpls = await safeFetchJson(`${API_BASE}/api/admin/workers/${encodeURIComponent(workerId)}/template-configs`);
    currentWorkerTemplateConfigs = Array.isArray(tmpls) ? tmpls : [];

    if (currentWorkerTemplateConfigs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="10" style="text-align: center; padding: 18px; color: #94a3b8;">模板库暂无已上传模板</td></tr>';
      return;
    }

    tbody.innerHTML = currentWorkerTemplateConfigs.map(t => {
      let badgeClass = 'badge-secondary';
      let statusText = t.is_orphaned ? '模板缺失' : '未配置';
      if (t.check_status === 'PASSED' && !t.is_orphaned) {
        badgeClass = 'badge-success';
        statusText = '通过';
      } else if (t.check_status === 'FAILED') {
        badgeClass = 'badge-danger';
        statusText = '失败';
      } else if (t.is_orphaned) {
        badgeClass = 'badge-danger';
        statusText = '模板缺失';
      } else if (t.check_status === 'CHECKING') {
        badgeClass = 'badge-warning';
        statusText = '检查中';
      } else if (t.root_dir) {
        statusText = '待检查';
      }

      const isEnabled = Boolean(t.is_enabled);
      const docLabel = t.doc_type === 'cert' ? '📜 发货证书' : '📦 装箱清单';
      const syncTextMap = {
        SYNCED: '<span style="font-size: 12px; color: #16a34a;">✅ 已同步</span>',
        PENDING: '<span style="font-size: 12px; color: #d97706;">⏳ 待执行端确认</span>',
        DISABLED: '<span style="font-size: 12px; color: #94a3b8;">— 未启用</span>',
        NOT_CONFIGURED: '<span style="font-size: 12px; color: #94a3b8;">— 未配置</span>',
        ORPHANED: '<span style="font-size: 12px; color: #dc2626;">⚠️ 需处理</span>'
      };
      const syncHtml = syncTextMap[t.sync_status] || syncTextMap.NOT_CONFIGURED;

      return `
        <tr style="border-bottom: 1px solid #f1f5f9; ${!isEnabled ? 'opacity: 0.75;' : ''}">
          <td style="padding: 10px;">
            <b>${escapeHtml(t.model)}</b>
            <div style="font-size: 11px; color: #64748b;">${escapeHtml(t.filename)}</div>
            ${t.is_orphaned ? '<div style="font-size: 11px; color: #dc2626;">该配置对应的模板已不存在，请删除以免遗留授权</div>' : ''}
          </td>
          <td style="padding: 10px; text-align: center;">${docLabel}</td>
          <td style="padding: 10px; text-align: center;">
            <span class="badge ${isEnabled ? 'badge-success' : 'badge-secondary'}">
              ${isEnabled ? '✅ 已启用' : '⚪ 未启用'}
            </span>
          </td>
          <td style="padding: 10px; font-family: monospace; font-size: 12px;">${t.root_dir ? escapeHtml(t.root_dir) : '<span style="color:#94a3b8;">未配置</span>'}</td>
          <td style="padding: 10px; text-align: center; font-size: 12px;">${t.save_mode === 'subfolder' ? `📂 按字段(${escapeHtml(t.subfolder_rule || 'deviceSn')})归档` : '📁 根目录直接保存'}</td>
          <td style="padding: 10px; text-align: center;">${t.allow_create ? '是' : '否'}</td>
          <td style="padding: 10px; text-align: center;">${syncHtml}<div style="font-size: 11px; color: #64748b;">v${t.version || 1}</div></td>
          <td style="padding: 10px; text-align: center;"><span class="badge ${badgeClass}">${statusText}</span></td>
          <td style="padding: 10px; font-size: 12px; color: #64748b;">${escapeHtml(t.check_message || '-')}</td>
          <td style="padding: 10px; text-align: center;">
            <button type="button" class="btn btn-secondary btn-sm" onclick="openWorkerTemplateModal('${t.template_id}', '${t.doc_type}')">⚙️ 配置</button>
            ${t.config_id ? `<button type="button" class="btn btn-primary btn-sm" onclick="checkWorkerTemplate(${t.config_id})">🔍 探测</button>` : ''}
            ${t.config_id ? `<button type="button" class="btn btn-danger btn-sm" onclick="deleteWorkerTemplateConfig(${t.config_id})">🗑️ 删除</button>` : ''}
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="10" style="color: #ef4444; text-align: center; padding: 16px;">
      加载本终端模板配置失败: ${escapeHtml(err.message)}
      <button type="button" class="btn btn-secondary btn-sm" onclick="loadWorkerTemplateConfigs('${escapeHtml(workerId)}')" style="margin-left: 10px;">🔄 重试</button>
    </td></tr>`;
  }
}

/**
 * 删除某终端某模板的保存配置（含失效的残留配置），避免遗留授权 (4.3)
 */
async function deleteWorkerTemplateConfig(configId) {
  if (!currentDetailWorkerId) return;
  if (!confirm('确定要删除该终端在此模板上的保存目录配置吗？删除后该模板在此终端不可提交。')) return;
  try {
    const res = await fetch(`${API_BASE}/api/admin/workers/${encodeURIComponent(currentDetailWorkerId)}/template-configs/${configId}`, {
      method: 'DELETE'
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    await loadWorkerTemplateConfigs(currentDetailWorkerId);
  } catch (err) {
    alert('删除配置失败: ' + err.message);
  }
}

function openWorkerTemplateModal(templateId, docType) {
  const item = currentWorkerTemplateConfigs.find(t => t.template_id === templateId && t.doc_type === docType);
  if (!item) return;

  document.getElementById('cfg-tmpl-id').value = item.template_id;
  document.getElementById('cfg-doc-type').value = item.doc_type;
  document.getElementById('cfg-tmpl-model').innerText = item.model;
  document.getElementById('cfg-tmpl-filename').innerText = item.filename;
  document.getElementById('cfg-tmpl-type-label').innerText = item.doc_type === 'cert' ? '发货证书 (cert)' : '装箱清单 (packing)';

  document.getElementById('cfg-is-enabled').checked = Boolean(item.is_enabled);
  document.getElementById('cfg-root-dir').value = item.root_dir || '';
  document.getElementById('cfg-save-mode').value = item.save_mode || 'direct';
  document.getElementById('cfg-subfolder-rule').value = item.subfolder_rule || 'deviceSn';
  document.getElementById('cfg-allow-create').checked = Boolean(item.allow_create);

  onWorkerTmplSaveModeChanged();
  document.getElementById('modal-worker-template').style.display = 'flex';
}

function onWorkerTmplSaveModeChanged() {
  const mode = document.getElementById('cfg-save-mode').value;
  const grp = document.getElementById('cfg-subfolder-rule-group');
  if (grp) grp.style.display = mode === 'subfolder' ? 'block' : 'none';
  updateWorkerTmplPathPreview();
}

function updateWorkerTmplPathPreview() {
  const rootDir = (document.getElementById('cfg-root-dir').value || '').trim();
  const mode = document.getElementById('cfg-save-mode').value;
  const preview = document.getElementById('cfg-path-preview-text');
  if (!preview) return;

  if (!rootDir) {
    preview.innerText = '(请先输入保存根目录)';
    preview.style.color = '#94a3b8';
    return;
  }

  const slash = rootDir.includes('/') ? '/' : '\\';
  const cleanRoot = rootDir.replace(/[\\/]+$/, '');

  if (mode === 'direct') {
    preview.innerText = `${cleanRoot}${slash}[按规则生成的证书/清单].doc (直接保存在根目录下)`;
    preview.style.color = '#0284c7';
  } else {
    preview.innerText = `${cleanRoot}${slash}[设备序列号]${slash}[按规则生成的证书/清单].doc (例如: ${cleanRoot}${slash}EX10260902${slash}证书.doc)`;
    preview.style.color = '#059669';
  }
}

function closeWorkerTemplateModal() {
  document.getElementById('modal-worker-template').style.display = 'none';
}

async function handleSaveWorkerTemplate(e) {
  e.preventDefault();
  if (!currentDetailWorkerId) return;

  const templateId = document.getElementById('cfg-tmpl-id').value;
  const docType = document.getElementById('cfg-doc-type').value;
  const isEnabled = document.getElementById('cfg-is-enabled').checked;
  const rootDir = document.getElementById('cfg-root-dir').value.trim();
  const saveMode = document.getElementById('cfg-save-mode').value;
  const subfolderRule = document.getElementById('cfg-subfolder-rule').value.trim();
  const allowCreate = document.getElementById('cfg-allow-create').checked;

  try {
    const res = await fetch(`${API_BASE}/api/admin/workers/${encodeURIComponent(currentDetailWorkerId)}/template-configs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        templateId,
        docType,
        isEnabled,
        rootDir,
        saveMode,
        subfolderRule,
        allowCreate
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '保存失败');

    closeWorkerTemplateModal();
    await loadWorkerTemplateConfigs(currentDetailWorkerId);
  } catch (err) {
    alert('保存配置失败: ' + err.message);
  }
}

async function checkWorkerTemplate(configId) {
  if (!currentDetailWorkerId) return;
  try {
    const res = await fetch(`${API_BASE}/api/admin/workers/${encodeURIComponent(currentDetailWorkerId)}/template-configs/${configId}/check`, {
      method: 'POST'
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '探测请求失败');
    await loadWorkerTemplateConfigs(currentDetailWorkerId);
  } catch (err) {
    alert('发起探测失败: ' + err.message);
  }
}


// ==================== SENSOR CONFIGS MANAGEMENT ====================
let currentSensorConfigs = [];

async function loadSensorConfigs() {
  const tbody = document.getElementById('sensor-configs-tbody');
  if (!tbody) return;

  tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 20px; color: #64748b;">正在加载传感器配置列表...</td></tr>';

  try {
    const list = await safeFetchJson(`${API_BASE}/api/sensor-configs`);
    currentSensorConfigs = Array.isArray(list) ? list : [];

    if (currentSensorConfigs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 24px; color: #94a3b8;">暂无各设备传感器配置，请添加</td></tr>';
      return;
    }

    tbody.innerHTML = currentSensorConfigs.map(item => {
      const options = Array.isArray(item.sensor_options) ? item.sensor_options : [];
      const optionsHtml = options.map(opt => `<span class="badge badge-warning" style="margin-right: 4px;">${escapeHtml(opt)}</span>`).join('');
      const updatedTime = item.updated_at ? new Date(item.updated_at).toLocaleString('zh-CN') : '-';

      return `
        <tr>
          <td><b style="color: #0f172a; font-size: 14px;">${escapeHtml(item.model)}</b></td>
          <td>${optionsHtml || '<span style="color:#94a3b8;">无选项</span>'}</td>
          <td><b>${escapeHtml(item.default_value || '无')}</b></td>
          <td style="font-size: 12px; color: #64748b;">${updatedTime}</td>
          <td style="text-align: right;">
            <button type="button" class="btn btn-sm btn-secondary" onclick="editSensorConfig(${item.id})">✏️ 编辑</button>
            <button type="button" class="btn btn-sm btn-danger" onclick="deleteSensorConfig(${item.id}, '${escapeHtml(item.model)}')">🗑️ 删除</button>
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 24px; color: #ef4444;">
      加载传感器配置失败: ${escapeHtml(err.message)}
      <button type="button" class="btn btn-secondary btn-sm" onclick="loadSensorConfigs()" style="margin-left: 10px;">🔄 重试</button>
    </td></tr>`;
  }
}

function previewSensorConfigFormOptions() {
  const inputEl = document.getElementById('sensor-cfg-options');
  const defaultSelect = document.getElementById('sensor-cfg-default');
  const pillsBox = document.getElementById('sensor-cfg-preview-pills');

  if (!inputEl || !pillsBox) return [];

  const rawVal = inputEl.value || '';
  const tokens = rawVal.split(/[，,]/);
  const options = [];
  tokens.forEach(t => {
    const cleaned = t.trim();
    if (cleaned && !options.includes(cleaned)) {
      options.push(cleaned);
    }
  });

  pillsBox.innerHTML = options.length > 0
    ? options.map(opt => `<span class="badge badge-warning">${escapeHtml(opt)}</span>`).join('')
    : '<span style="font-size: 12px; color: #94a3b8;">未配置有效选项</span>';

  if (defaultSelect) {
    const currentDefault = defaultSelect.value;
    defaultSelect.innerHTML = '<option value="">(无默认值)</option>' + options.map(o => `
      <option value="${escapeHtml(o)}" ${o === currentDefault ? 'selected' : ''}>${escapeHtml(o)}</option>
    `).join('');
  }

  return options;
}

function resetSensorConfigForm() {
  document.getElementById('sensor-form-title').innerText = '➕ 新增 / 编辑设备传感器配置';
  document.getElementById('sensor-cfg-id').value = '';
  document.getElementById('sensor-cfg-model').value = '';
  document.getElementById('sensor-cfg-options').value = '';
  document.getElementById('sensor-cfg-default').innerHTML = '<option value="">(无默认值)</option>';
  document.getElementById('sensor-cfg-preview-pills').innerHTML = '';
}

function editSensorConfig(id) {
  const item = currentSensorConfigs.find(c => c.id === id);
  if (!item) return;

  document.getElementById('sensor-form-title').innerText = `✏️ 编辑设备传感器配置: ${item.model}`;
  document.getElementById('sensor-cfg-id').value = item.id;
  document.getElementById('sensor-cfg-model').value = item.model;
  
  const optionsArr = Array.isArray(item.sensor_options) ? item.sensor_options : [];
  document.getElementById('sensor-cfg-options').value = optionsArr.join('，');
  
  previewSensorConfigFormOptions();

  if (item.default_value) {
    document.getElementById('sensor-cfg-default').value = item.default_value;
  }
}

async function handleSaveSensorConfig(e) {
  e.preventDefault();
  const id = document.getElementById('sensor-cfg-id').value;
  const model = document.getElementById('sensor-cfg-model').value.trim();
  const sensor_options = document.getElementById('sensor-cfg-options').value.trim();
  const default_value = document.getElementById('sensor-cfg-default').value;

  if (!model) return alert('请输入设备型号');
  if (!sensor_options) return alert('请输入传感器型号选项');

  try {
    await safeFetchJson(`${API_BASE}/api/admin/sensor-configs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': 'phoneapp-admin-secret'
      },
      body: JSON.stringify({
        id: id || undefined,
        model,
        sensor_options,
        default_value
      })
    });

    resetSensorConfigForm();
    alert(`设备 [${model}] 的传感器配置保存成功！`);
    await loadSensorConfigs();
  } catch (err) {
    alert('保存传感器配置失败: ' + err.message);
  }
}

async function deleteSensorConfig(id, model) {
  if (!confirm(`确定要删除设备 [${model}] 的传感器配置吗？`)) return;

  try {
    await safeFetchJson(`${API_BASE}/api/admin/sensor-configs/${id}`, {
      method: 'DELETE',
      headers: {
        'x-admin-token': 'phoneapp-admin-secret'
      }
    });

    await loadSensorConfigs();
  } catch (err) {
    alert('删除传感器配置失败: ' + err.message);
  }
}

// ==================== SALES PERSONS MANAGEMENT ====================
async function loadSalesPersons() {
  const tbody = document.getElementById('sales-persons-tbody');
  if (!tbody) return;

  tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 20px; color: #64748b;">正在加载销售人员列表...</td></tr>';

  try {
    const list = await safeFetchJson(`${API_BASE}/api/sales-persons`);
    if (!Array.isArray(list) || list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 24px; color: #94a3b8;">暂无销售人员，请添加</td></tr>';
      return;
    }

    tbody.innerHTML = list.map(item => {
      const createdTime = item.created_at ? new Date(item.created_at).toLocaleString('zh-CN') : '-';
      return `
        <tr>
          <td><b>${item.id}</b></td>
          <td><b style="color: #0f172a; font-size: 14px;">${escapeHtml(item.name)}</b></td>
          <td style="font-size: 12px; color: #64748b;">${createdTime}</td>
          <td style="text-align: right;">
            <button type="button" class="btn btn-sm btn-danger" onclick="deleteSalesPerson(${item.id}, '${escapeHtml(item.name)}')">🗑️ 删除</button>
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; padding: 24px; color: #ef4444;">
      加载销售人员失败: ${escapeHtml(err.message)}
      <button type="button" class="btn btn-secondary btn-sm" onclick="loadSalesPersons()" style="margin-left: 10px;">🔄 重试</button>
    </td></tr>`;
  }
}

async function handleAddSalesPerson(e) {
  e.preventDefault();
  const inputEl = document.getElementById('sales-person-name-input');
  const name = inputEl ? inputEl.value.trim() : '';

  if (!name) return alert('请输入销售人员姓名');

  try {
    await safeFetchJson(`${API_BASE}/api/admin/sales-persons`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': 'phoneapp-admin-secret'
      },
      body: JSON.stringify({ name })
    });

    inputEl.value = '';
    alert(`销售人员 [${name}] 已成功添加！`);
    await loadSalesPersons();
  } catch (err) {
    alert('添加销售人员失败: ' + err.message);
  }
}

async function deleteSalesPerson(id, name) {
  if (!confirm(`确定要删除销售人员 [${name}] 吗？`)) return;

  try {
    await safeFetchJson(`${API_BASE}/api/admin/sales-persons/${id}`, {
      method: 'DELETE',
      headers: {
        'x-admin-token': 'phoneapp-admin-secret'
      }
    });

    await loadSalesPersons();
  } catch (err) {
    alert('删除销售人员失败: ' + err.message);
  }
}

// ==================== TEMPLATE LIBRARY MANAGEMENT (FIX-01) ====================
async function loadTemplates() {
  const tbody = document.getElementById('templates-tbody');
  if (!tbody) return;

  tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 20px; color: #64748b;">正在加载模板库列表...</td></tr>';

  try {
    const tmpls = await safeFetchJson(`${API_BASE}/api/templates`);
    if (Array.isArray(tmpls)) {
      cachedMatcherTmpls = tmpls;
    }
    if (!Array.isArray(tmpls) || tmpls.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 24px; color: #94a3b8;">尚未上传模板</td></tr>';
      return;
    }

    tbody.innerHTML = tmpls.map(t => {
      const docLabel = t.type === 'cert' ? '📜 发货证书' : (t.type === 'packing' ? '📦 装箱清单' : escapeHtml(t.type));
      
      let statusBadge = '<span class="badge badge-success">已发布</span>';
      if (t.is_draft) {
        statusBadge = '<span class="badge badge-warning">草稿</span>';
      } else if (!t.published_at) {
        statusBadge = '<span class="badge badge-secondary">未发布</span>';
      }

      let fileExistsBadge = '';
      if (t.file_exists === false) {
        fileExistsBadge = ' <span class="badge badge-danger" title="物理文件在磁盘缺失">⚠️ 文件缺失</span>';
      } else if (t.file_exists === true) {
        fileExistsBadge = ' <span class="badge badge-success" title="文件物理存在">✅ 存在</span>';
      }

      const publishedTime = t.published_at ? new Date(t.published_at).toLocaleString('zh-CN') : '未发布';
      const hashStr = t.file_hash ? t.file_hash.substring(0, 16) + '...' : '-';

      return `
        <tr>
          <td>
            <b style="color: #0f172a; font-size: 14px;">${escapeHtml(t.filename)}</b>
            <div style="font-size: 11px; color: #64748b; font-family: monospace;">ID: ${escapeHtml(t.id)}</div>
          </td>
          <td><b>${escapeHtml(t.model)}</b></td>
          <td>${docLabel}</td>
          <td><span class="badge badge-secondary">${escapeHtml(t.version || 'v1.0')}</span></td>
          <td style="font-size: 12px;">
            <code style="font-size: 11px; color: #475569;" title="${escapeHtml(t.file_hash || '')}">${escapeHtml(hashStr)}</code>
            <div style="margin-top: 4px;">${statusBadge}${fileExistsBadge}</div>
          </td>
          <td style="font-size: 12px; color: #64748b;">${publishedTime}</td>
          <td style="text-align: right;">
            <div style="display: flex; gap: 4px; justify-content: flex-end; flex-wrap: wrap;">
              <button type="button" class="btn btn-sm btn-primary" onclick="goToMatcher('${escapeHtml(t.id)}')">🤖 字段匹配</button>
              <a href="${API_BASE}/api/templates/${encodeURIComponent(t.id)}/download" class="btn btn-sm btn-secondary" target="_blank">⬇️ 下载</a>
              <button type="button" class="btn btn-sm btn-danger" onclick="deleteTemplate('${escapeHtml(t.id)}')">🗑️ 删除</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 24px; color: #ef4444;">
      加载模板列表失败: ${escapeHtml(err.message)}
      <button type="button" class="btn btn-secondary btn-sm" onclick="loadTemplates()" style="margin-left: 10px;">🔄 重试</button>
    </td></tr>`;
  }
}

async function handleUploadTemplate(e) {
  e.preventDefault();
  const fileInput = document.getElementById('tmpl-file');
  const modelInput = document.getElementById('tmpl-model');
  const typeSelect = document.getElementById('tmpl-type');
  const versionInput = document.getElementById('tmpl-version');

  if (!fileInput.files.length) return alert('请选择模板文件');

  const formData = new FormData();
  formData.append('templateFile', fileInput.files[0]);
  formData.append('model', modelInput.value.trim());
  formData.append('type', typeSelect.value);
  formData.append('version', versionInput.value.trim() || 'v1.0');

  let uploadSuccessData = null;
  try {
    const res = await fetch(`${API_BASE}/api/templates/upload`, {
      method: 'POST',
      headers: {
        'x-admin-token': 'phoneapp-admin-secret'
      },
      body: formData
    });
    
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      uploadSuccessData = await res.json();
    } else {
      const text = await res.text();
      throw new Error(`服务响应非 JSON (HTTP ${res.status}): ${text.substring(0, 100)}`);
    }

    if (!res.ok) {
      throw new Error(uploadSuccessData.error || `上传失败 (HTTP ${res.status})`);
    }
  } catch (err) {
    return alert('上传失败: ' + err.message);
  }

  fileInput.value = '';
  alert(`模板文件 [${uploadSuccessData.filename}] 成功上传入库！`);
  cachedMatcherTmpls = null;

  try {
    await loadTemplates();
  } catch (refreshErr) {
    alert(`上传成功，列表刷新失败: ${refreshErr.message}`);
  }
}

async function deleteTemplate(tmplId) {
  if (!confirm('确定要删除该模板文件吗？')) return;
  try {
    await safeFetchJson(`${API_BASE}/api/templates/${encodeURIComponent(tmplId)}`, {
      method: 'DELETE',
      headers: {
        'x-admin-token': 'phoneapp-admin-secret'
      }
    });
    cachedMatcherTmpls = null;
    await loadTemplates();
  } catch (err) {
    alert('删除失败: ' + err.message);
  }
}

// ==================== FIELD MATCHER WORKBENCH ====================
let cachedMatcherTmpls = null;
let isPopulatingMatcherSelect = false;

async function populateMatcherSelect(tmpls, forceRefresh = false) {
  const select = document.getElementById('matcher-select-template');
  if (!select) return;

  if (tmpls) {
    cachedMatcherTmpls = tmpls;
  } else if (!cachedMatcherTmpls || forceRefresh) {
    if (isPopulatingMatcherSelect) {
      // wait until populated by another call
      while(isPopulatingMatcherSelect) await new Promise(r => setTimeout(r, 100));
    } else {
      isPopulatingMatcherSelect = true;
      try {
        const res = await fetch(`${API_BASE}/api/templates`);
        if (!res.ok) throw new Error('加载模板列表失败');
        cachedMatcherTmpls = await res.json();
      } catch (e) {
        select.innerHTML = `<option value="">加载失败: ${e.message}</option>`;
        isPopulatingMatcherSelect = false;
        throw e;
      } finally {
        isPopulatingMatcherSelect = false;
      }
    }
  }

  if (cachedMatcherTmpls) {
    const currentVal = select.value;
    select.innerHTML = '<option value="">请选择需要分析匹配的模板...</option>' + cachedMatcherTmpls.map(t => `
      <option value="${t.id}">${escapeHtml(t.model)} - ${t.type === 'cert' ? '发货证书' : '装箱清单'} (${escapeHtml(t.filename)})</option>
    `).join('');
    if (currentVal && cachedMatcherTmpls.some(t => t.id === currentVal)) {
      select.value = currentVal;
    }
  }
}

async function goToMatcher(tmplId) {
  // 若当前本地缓存不存在该模板，先执行强制刷新拉取最新模板库
  if (!cachedMatcherTmpls || !cachedMatcherTmpls.some(t => t.id === tmplId)) {
    try {
      await populateMatcherSelect(null, true);
    } catch (e) {
      console.warn('刷新匹配器下拉框失败:', e);
    }
  }

  await switchTab('matcher');
  const select = document.getElementById('matcher-select-template');
  if (select) {
    if (!cachedMatcherTmpls || !cachedMatcherTmpls.some(t => t.id === tmplId)) {
      alert('未找到该模板，可能已被删除或列表加载失败。');
      return;
    }
    select.value = tmplId;
    if (currentAnalyzeTmplId !== tmplId) {
      runTemplateAnalyze();
    }
  }
}

function previewSensorOptions() {
  const inputEl = document.getElementById('sensor-options-input');
  const defaultSelect = document.getElementById('sensor-default-select');
  const pillsBox = document.getElementById('sensor-options-preview-pills');
  if (!inputEl || !pillsBox) return [];

  const rawVal = inputEl.value || '';
  const tokens = rawVal.split(/[，,]/);
  const options = [];
  tokens.forEach(t => {
    const cleaned = t.trim();
    if (cleaned && !options.includes(cleaned)) {
      options.push(cleaned);
    }
  });

  pillsBox.innerHTML = options.length > 0
    ? options.map(opt => `<span class="badge badge-warning">${opt}</span>`).join('')
    : '<span style="font-size: 12px; color: #94a3b8;">未配置有效选项</span>';

  if (defaultSelect) {
    const currentDefault = defaultSelect.value;
    defaultSelect.innerHTML = '<option value="">(无默认值)</option>' + options.map(o => `
      <option value="${o}" ${o === currentDefault ? 'selected' : ''}>${o}</option>
    `).join('');
  }

  return options;
}

async function runTemplateAnalyze() {
  const select = document.getElementById('matcher-select-template');
  const tmplId = select ? select.value : '';
  if (!tmplId) return alert('请先选择模板');

  currentAnalyzeTmplId = tmplId;
  const token = Date.now();
  currentAnalyzeToken = token;

  const container = document.getElementById('matcher-results-container');
  const tbody = document.getElementById('matcher-tbody');
  const sensorCard = document.getElementById('sensor-model-config-card');

  container.style.display = 'block';
  tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; padding: 20px;">🤖 正在深度解析 Word 结构并提取单元格与段落...</td></tr>';

  try {
    const res = await fetch(`${API_BASE}/api/templates/${tmplId}/analyze`);
    const data = await res.json();

    if (currentAnalyzeToken !== token) return; // Ignore stale response

    currentMatcherData = data;
    currentMatcherData.selectedChoices = {};
    // 区域识别结果与结构可靠性作为发布校验依据（整改 3.1/3.2）
    currentMatcherData.tableRegions = Array.isArray(data.tableRegions) ? data.tableRegions : [];
    currentMatcherData.structureReliability = data.structureReliability || { reliable: true, reason: '' };

    const saved = data.template.field_mappings || {};

    // 1. Configuration Echo: Restore saved targetLabels (preserve custom added/deleted fields)
    if (Array.isArray(saved.targetLabels) && saved.targetLabels.length > 0) {
      currentMatcherData.targetLabels = [...saved.targetLabels];
      for (const lbl of currentMatcherData.targetLabels) {
        if (!currentMatcherData.matchResults[lbl]) {
          try {
            const mRes = await fetch(`${API_BASE}/api/templates/match-candidates`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                targetLabel: lbl,
                docItems: data.docItems || [],
                type: data.template.type,
                regions: currentMatcherData.tableRegions
              })
            });
            if (currentAnalyzeToken !== token) return; // Exit early if stale
            currentMatcherData.matchResults[lbl] = await mRes.json();
          } catch (e) {
            if (currentAnalyzeToken !== token) return; // Exit early if stale
            currentMatcherData.matchResults[lbl] = { label: lbl, matchCount: 0, candidates: [] };
          }
        }
      }
    }

    // 2. Configuration Echo: Restore saved selectedChoices
    if (saved.selectedChoices && typeof saved.selectedChoices === 'object') {
      currentMatcherData.selectedChoices = { ...saved.selectedChoices };
    } else {
      (saved.singleFields || []).forEach(sf => {
        const match = currentMatcherData.matchResults[sf.label];
        if (match && match.candidates) {
          const idx = match.candidates.findIndex(c => {
            if (!sf.location) return false;
            return c.location.rowIdx === sf.location.rowIdx && c.location.colIdx === sf.location.colIdx;
          });
          if (idx >= 0) currentMatcherData.selectedChoices[sf.label] = idx;
        }
      });
      if (saved.tableConfig) {
        if (Array.isArray(saved.tableConfig.columns)) {
          saved.tableConfig.columns.forEach(col => {
            if (col.label && currentMatcherData.selectedChoices[col.label] === undefined) {
              const m = currentMatcherData.matchResults[col.label];
              if (m && m.candidates) {
                const idx = m.candidates.findIndex(c => c.location?.colIdx === col.colIdx || c.suggestedValueLocation?.colIdx === col.colIdx);
                if (idx >= 0) currentMatcherData.selectedChoices[col.label] = idx;
              }
            }
          });
        }
        if (saved.tableConfig.standardCol?.label && currentMatcherData.selectedChoices[saved.tableConfig.standardCol.label] === undefined) {
          const m = currentMatcherData.matchResults[saved.tableConfig.standardCol.label];
          if (m && m.candidates) {
            const idx = m.candidates.findIndex(c => c.location?.colIdx === saved.tableConfig.standardCol.colIdx);
            if (idx >= 0) currentMatcherData.selectedChoices[saved.tableConfig.standardCol.label] = idx;
          }
        }
        if (saved.tableConfig.actualCol?.label && currentMatcherData.selectedChoices[saved.tableConfig.actualCol.label] === undefined) {
          const m = currentMatcherData.matchResults[saved.tableConfig.actualCol.label];
          if (m && m.candidates) {
            const idx = m.candidates.findIndex(c => c.location?.colIdx === saved.tableConfig.actualCol.colIdx);
            if (idx >= 0) currentMatcherData.selectedChoices[saved.tableConfig.actualCol.label] = idx;
          }
        }
      }
    }

    if (saved.tableConfig) currentMatcherData.tableConfig = saved.tableConfig;
    if (saved.testPoints) currentMatcherData.testPoints = saved.testPoints;
    if (saved.packingItems) currentMatcherData.packingItems = saved.packingItems;

    // 3. 旧配置校验：污染配置必须被标记并要求重新分析发布，不得静默继续使用（整改 3.3, M11）
    currentMatcherData.configWarnings = validateLoadedTemplateConfig(data, saved);

    // 4. 清单/证书：以检测到的真实表头补齐默认选择（模板真实列优先）
    autoBindRegionColumns(data);

    document.getElementById('matcher-doc-title').innerText = `模板字段位置匹配清单: ${data.template.filename}`;
    document.getElementById('matcher-doc-meta').innerText = `型号: ${data.template.model} | 提取文本结构项: ${data.docItemsCount} 项`;

    if (data.template.model === 'POA200' && data.template.type === 'cert') {
      if (sensorCard) sensorCard.style.display = 'block';
      previewSensorOptions();
    } else {
      if (sensorCard) sensorCard.style.display = 'none';
    }

    renderMatcherWarnings();
    renderMatcherTable();
  } catch (err) {
    if (currentAnalyzeToken === token) {
      tbody.innerHTML = `<tr><td colspan="8">分析失败: ${err.message}</td></tr>`;
    }
  }
}

/** 展示结构可靠性与旧配置校验结果 */
function renderMatcherWarnings() {
  const box = document.getElementById('matcher-warnings');
  if (!box) return;
  const warnings = [];
  const reliability = currentMatcherData.structureReliability;
  if (reliability && reliability.reliable === false) {
    warnings.push(`⛔ 文档结构不可靠：${reliability.reason}。已禁止正式发布，请安装办公组件后重新分析。`);
  }
  const ambiguous = (currentMatcherData.tableRegions || []).filter(r => r.ambiguous);
  if (ambiguous.length > 0) {
    warnings.push(`⚠️ 表格区域 [${ambiguous.map(r => `表${r.tableIdx + 1}`).join(', ')}] 缺少明确的测量/物料表头特征，请人工确认区域后再发布。`);
  }
  (currentMatcherData.configWarnings || []).forEach(w => warnings.push(`⚠️ 已保存配置问题：${w}`));

  if (warnings.length === 0) {
    box.style.display = 'none';
    box.innerHTML = '';
    return;
  }
  box.style.display = 'block';
  box.innerHTML = warnings.map(w => `<div style="margin-bottom:4px;">${w}</div>`).join('');
}

/**
 * 旧配置校验：行数、列归属、单值字段与测量列冲突、默认值截断。
 * 发现问题的旧配置必须重新分析/重新绑定，不能静默继续使用。
 */
function validateLoadedTemplateConfig(data, saved) {
  const warnings = [];
  if (!saved || !saved.tableConfig) return warnings;
  const tc = saved.tableConfig;
  const tmplType = data.template.type;
  const regions = (data.tableRegions || []).filter(r => (tmplType === 'packing' ? r.kind === 'packing' : r.kind === 'measurement'));
  const region = regions[0];

  const savedRows = Array.isArray(saved.testPoints) ? saved.testPoints.length : 0;
  if (region && typeof tc.rowCount === 'number' && tc.rowCount !== region.rowCount) {
    warnings.push(`已保存测量行数 (${tc.rowCount}) 与模板真实数据区行数 (${region.rowCount}) 不一致，必须重新分析并重新发布。`);
  }
  if (region && typeof tc.tableIdx === 'number' && tc.tableIdx !== region.tableIdx) {
    warnings.push(`已保存测量表格编号 (${tc.tableIdx}) 与模板真实区域 (${region.tableIdx}) 不一致。`);
  }
  if (region && typeof tc.rowCount === 'number' && savedRows > 0 && savedRows !== tc.rowCount) {
    warnings.push(`已保存测量点数据行数 (${savedRows}) 与配置行数 (${tc.rowCount}) 不一致，默认值可能被截断。`);
  }
  if (Array.isArray(tc.columns)) {
    const tableIdxs = new Set(tc.columns.map(c => (c.tableIdx === undefined ? tc.tableIdx : c.tableIdx)));
    if (tableIdxs.size > 1) warnings.push('已保存测量列跨多个表格区域，数据区边界不可靠。');
    tc.columns.forEach(col => {
      if (col.label && isSingleValueLikeLabel(col.label)) {
        warnings.push(`单值字段 [${col.label}] 被保存成了测量列，必须重新绑定。`);
      }
    });
  }
  (saved.singleFields || []).forEach(sf => {
    if (sf && sf.valueLocation && sf.valueLocation.type === 'table_column') {
      warnings.push(`单值字段 [${sf.label}] 被保存成整列绑定，必须重新绑定。`);
    }
  });
  return warnings;
}

function isSingleValueLikeLabel(label) {
  const s = String(label || '').trim().toLowerCase();
  if (!s) return false;
  if (/date|日期|inst\.?\s*sn|serial\s*no|customer|客户|instrument$|仪器$|ambient|humidity|温度|湿度|destination|目的地|sales/.test(s)) return true;
  return false;
}

/**
 * 依据模板检测到的表头/数据区，自动补齐默认候选选择。
 * 只在管理员尚未显式选择（selectedChoices 无记录）时生效。
 */
function autoBindRegionColumns(data) {
  const regions = data.tableRegions || [];
  const isPacking = data.template.type === 'packing';
  const region = regions.find(r => (isPacking ? r.kind === 'packing' : r.kind === 'measurement'));
  if (!region) return;

  const choices = currentMatcherData.selectedChoices || {};
  const labels = (data.targetLabels || []).slice();

  region.headerColumns.forEach(hc => {
    const matchLabel = labels.find(l => normalizeLabelForCompare(l) === normalizeLabelForCompare(hc.label));
    if (!matchLabel) return;
    const match = (currentMatcherData.matchResults || {})[matchLabel];
    if (!match || !match.candidates || match.candidates.length === 0) return;
    const idx = match.candidates.findIndex(c =>
      c.suggestedValueLocation && c.suggestedValueLocation.type === 'table_column' &&
      c.suggestedValueLocation.colIdx === hc.colIdx
    );
    if (idx >= 0 && choices[matchLabel] === undefined) choices[matchLabel] = idx;
  });

  currentMatcherData.selectedChoices = choices;
}

function normalizeLabelForCompare(label) {
  return String(label || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[:：]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function renderMatcherTable() {
  if (!currentMatcherData) return;
  const tbody = document.getElementById('matcher-tbody');
  const matchResults = currentMatcherData.matchResults || {};
  const targetLabels = currentMatcherData.targetLabels || Object.keys(matchResults);
  const choices = currentMatcherData.selectedChoices || {};

  tbody.innerHTML = targetLabels.map((key) => {
    const match = matchResults[key];
    const candidates = match && match.candidates ? match.candidates : [];

    const chosenIdx = choices[key] !== undefined ? choices[key] : (candidates.length > 0 ? 0 : -1);
    const chosenCandidate = chosenIdx >= 0 && chosenIdx < candidates.length ? candidates[chosenIdx] : null;

    let candidateOptions = '<option value="-1">-- 未绑定 / 手动绑定 --</option>';
    candidates.forEach((c, cIdx) => {
      const labelStr = c.location.type === 'cell' 
        ? `[单元格 R${c.location.rowIdx + 1}C${c.location.colIdx + 1}] ${c.matchedLabel}` 
        : `[段落 #${c.location.paragraphIdx + 1}] ${c.matchedLabel}`;
      candidateOptions += `<option value="${cIdx}" ${cIdx === chosenIdx ? 'selected' : ''}>${labelStr} (${c.reason || '匹配'})</option>`;
    });

    const isBound = chosenCandidate !== null;
    const isNamingOnly = key === 'sensorModel' || key === '传感器型号';

    let fieldCategory = '单值字段';
    if (isNamingOnly) {
      fieldCategory = '命名业务参数 (无Word坐标)';
    } else if ((chosenCandidate && chosenCandidate.sampleValues && chosenCandidate.sampleValues.length > 0) || (match && match.inferredType === 'table')) {
      fieldCategory = '表格列数据区';
    }

    let statusBadge = '<span class="badge badge-danger">未绑定</span>';
    if (isNamingOnly) {
      statusBadge = '<span class="badge badge-success">仅命名参数</span>';
    } else if (isBound) {
      const scorePct = Math.round(chosenCandidate.score * 100);
      statusBadge = `<span class="badge ${chosenCandidate.score >= 0.9 ? 'badge-success' : 'badge-warning'}">${scorePct}% ${chosenCandidate.reason || '已绑定'}</span>`;
    }

    // Display original template value or sample column values
    let valueDisp = '<span style="color: #ef4444;">未绑定</span>';
    if (isNamingOnly) {
      valueDisp = '用作发货证书文件名';
    } else if (isBound) {
      if (chosenCandidate.fullValues && chosenCandidate.fullValues.length > 0) {
        const rowTotal = chosenCandidate.fullValues.length;
        const previewPart = chosenCandidate.fullValues.slice(0, 5).join(' / ');
        valueDisp = `数据区 (${rowTotal}行): [${previewPart}${rowTotal > 5 ? ' ...' : ''}]`;
      } else if (chosenCandidate.sampleValues && chosenCandidate.sampleValues.length > 0) {
        valueDisp = `样例: [${chosenCandidate.sampleValues.join(' / ')}]`;
      } else {
        valueDisp = chosenCandidate.candidateValue || '空';
      }
    }

    return `
      <tr>
        <td><b style="color: #0f172a; font-size: 14px;">${key}</b></td>
        <td><span class="badge badge-secondary" style="font-size: 11px;">${fieldCategory}</span></td>
        <td>${statusBadge}</td>
        <td>
          ${isNamingOnly ? '<span style="color: #64748b; font-size: 12px;">(不需Word单元格坐标)</span>' : `
            <select class="form-control" style="font-size: 12px;" onchange="updateCandidateChoice('${key}', this.value)">
              ${candidateOptions}
            </select>
          `}
        </td>
        <td><code>${valueDisp}</code></td>
        <td><b style="color: ${isBound ? '#0284c7' : '#94a3b8'};">${isBound ? '已确认绑定' : (isNamingOnly ? '已配置' : '未绑定')}</b></td>
        <td style="text-align: right;">
          <button type="button" class="btn btn-sm btn-danger" onclick="deleteMatcherField('${key}')">🗑️ 删除</button>
        </td>
      </tr>
    `;
  }).join('') + `
    <tr>
      <td colspan="8" style="background: #f8fafc; text-align: center; padding: 12px;">
        <button type="button" class="btn btn-sm btn-outline" onclick="addMatcherField()">➕ 添加需要配置的字段</button>
      </td>
    </tr>
  `;
}

async function addMatcherField() {
  const fieldName = prompt('请输入新增要配置的字段名称:');
  if (!fieldName || !fieldName.trim()) return;

  const key = fieldName.trim();
  if (!currentMatcherData.targetLabels) currentMatcherData.targetLabels = [];
  if (!currentMatcherData.targetLabels.includes(key)) {
    currentMatcherData.targetLabels.push(key);
  }

  try {
    const res = await fetch(`${API_BASE}/api/templates/match-candidates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetLabel: key,
        docItems: currentMatcherData.docItems || []
      })
    });
    const result = await res.json();
    currentMatcherData.matchResults[key] = result;
    if (result.candidates && result.candidates.length > 0) {
      currentMatcherData.selectedChoices[key] = 0;
    } else {
      currentMatcherData.selectedChoices[key] = -1;
    }
  } catch (e) {
    currentMatcherData.matchResults[key] = { label: key, matchCount: 0, candidates: [] };
    currentMatcherData.selectedChoices[key] = -1;
  }

  renderMatcherTable();
}

function deleteMatcherField(key) {
  if (confirm(`确定要删除配置字段 [${key}] 吗？`)) {
    currentMatcherData.targetLabels = currentMatcherData.targetLabels.filter(k => k !== key);
    delete currentMatcherData.matchResults[key];
    delete currentMatcherData.selectedChoices[key];
    renderMatcherTable();
  }
}

function updateCandidateChoice(key, choiceVal) {
  if (!currentMatcherData) return;
  if (!currentMatcherData.selectedChoices) currentMatcherData.selectedChoices = {};

  const idx = parseInt(choiceVal);
  currentMatcherData.selectedChoices[key] = idx;
  renderMatcherTable();
}

/** 按字段名解析清单表头对应的业务键（与后端一致，仅使用真实表头） */
function mapPackingHeaderToField(label) {
  const norm = normalizeLabelForCompare(label);
  if (!norm) return null;
  if (/^序号$/.test(norm) || /^序号/.test(norm) || /^no\.?$/.test(norm) || /^item$/.test(norm)) return 'index';
  if (/名称|品名|物料名称|description/.test(norm)) return 'name';
  if (/规格|型号|spec/.test(norm)) return 'spec';
  if (/数量|count|qty|quantity/.test(norm)) return 'count';
  if (/单位|unit/.test(norm)) return 'unit';
  if (/标配|标准配置|standard/.test(norm)) return 'standard';
  if (/备注|说明|remark|note/.test(norm)) return 'remark';
  return null;
}

function snFromText(text) {
  const m = String(text || '').match(/SN[:：]?\s*([A-Za-z0-9_\-]+)/i);
  return m ? m[1] : null;
}

/**
 * 依据模板真实表头与行角色生成清单物料行（整改 B02/B03, 3.4）。
 * - 只使用模板真实存在的列，不虚构“单位/标配”；
 * - “主设备/传感器”作为行角色，不加入列字段；
 * - 单位、标配、备注逐行取模板原值，无依据时不补“件”“是”；
 * - 主设备与真实存在的传感器行标记为保护行，且记录 SN 所在列。
 */
function buildPackingItemsFromTemplate(matchResults, choices, packingRegion) {
  const fields = {};
  (packingRegion ? packingRegion.headerColumns : []).forEach(hc => {
    const field = mapPackingHeaderToField(hc.label);
    if (field && !fields[field]) fields[field] = hc;
  });

  const chosenFullValues = (fieldKey) => {
    if (!fieldKey) return null;
    const col = fields[fieldKey];
    let label = col ? col.label : Object.keys(matchResults).find(l => mapPackingHeaderToField(l) === fieldKey);
    if (!label) return null;
    const match = matchResults[label];
    if (!match || !match.candidates || match.candidates.length === 0) return null;
    const chosenIdx = choices[label] !== undefined ? choices[label] : 0;
    const cand = match.candidates[chosenIdx] || match.candidates[0];
    if (!cand || !cand.suggestedValueLocation || cand.suggestedValueLocation.type !== 'table_column') return null;
    const vals = (cand.fullValues && cand.fullValues.length > 0) ? cand.fullValues : (cand.sampleValues || []);
    return { label, values: vals, colIdx: cand.suggestedValueLocation.colIdx };
  };

  const byField = {};
  ['index', 'name', 'spec', 'count', 'unit', 'standard', 'remark'].forEach(f => {
    byField[f] = chosenFullValues(f);
  });

  if (!byField.name || !byField.name.values || byField.name.values.length === 0) return [];

  const items = byField.name.values.map((name, idx) => {
    const pick = (f) => {
      const src = byField[f];
      if (!src || !src.values) return '';
      const v = src.values[idx];
      return v === undefined || v === null ? '' : String(v);
    };
    const countRaw = pick('count');
    const parsedCount = parseInt(countRaw, 10);
    return {
      index: idx + 1,
      name: String(name || '').trim(),
      spec: pick('spec'),
      count: Number.isFinite(parsedCount) ? parsedCount : (countRaw || ''),
      // 保留模板原始单位/标配，缺失就是空，不补“件”“是”
      unit: pick('unit'),
      standard: pick('standard'),
      remark: pick('remark'),
      isProtected: false,
      role: 'material',
      sn: null,
      snCol: null
    };
  });

  // 行角色识别：主设备/传感器/参考仪器来自模板真实行内容
  const headerCols = (packingRegion ? packingRegion.headerColumns : []).slice().sort((a, b) => a.colIdx - b.colIdx);
  const remarkCol = fields.remark ? fields.remark.colIdx : null;
  items.forEach(item => {
    const label = String(item.name || '');
    if (/主设备|主机/.test(label)) item.role = 'mainDevice';
    else if (/传感器|探头/.test(label)) item.role = 'sensor';
    else if (/参考仪器|标准器/.test(label)) item.role = 'reference';
  });

  // 若模板没有显式“主设备”行名，用第一个带 SN 的行作为主设备行（仍保留其原名称）
  if (!items.some(it => it.role === 'mainDevice')) {
    const idx = items.findIndex(it => it.remark && /SN[:：]/i.test(it.remark));
    if (idx >= 0) items[idx].role = 'mainDevice';
  }

  items.forEach(item => {
    if (remarkCol !== null) item.snCol = remarkCol;
    const sn = snFromText(item.remark);
    if (sn) item.sn = sn;
    if (item.role === 'mainDevice' || item.role === 'sensor' || item.role === 'reference') {
      item.isProtected = true;
    }
  });

  return items;
}

async function saveMatchedRules(isDraft = false) {
  if (!currentMatcherData) return alert('当前没有可保存的匹配结果');

  const tmpl = currentMatcherData.template;
  const matchResults = currentMatcherData.matchResults || {};
  const choices = currentMatcherData.selectedChoices || {};

  let sensorOptions = [];
  let sensorDefault = '';
  if (tmpl.model === 'POA200' && tmpl.type === 'cert') {
    sensorOptions = previewSensorOptions();
    const defaultSelect = document.getElementById('sensor-default-select');
    sensorDefault = defaultSelect ? defaultSelect.value : '';
  }

  const unboundFields = [];
  const singleFields = [];
  let tableConfig = currentMatcherData.tableConfig || null;
  let testPoints = currentMatcherData.testPoints || [];
  let packingItems = [];

  let stdCandidate = null;
  let stdLabel = '';
  let actCandidate = null;
  let actLabel = '';
  let pointCandidate = null;
  let pointLabel = '';
  const matchedTableCols = [];

  const regions = currentMatcherData.tableRegions || [];
  const measurementRegion = regions.find(r => r.kind === 'measurement');
  const packingRegion = regions.find(r => r.kind === 'packing');

  currentMatcherData.targetLabels.forEach(lbl => {
    const isNamingOnly = lbl === 'sensorModel' || lbl === '传感器型号';
    const match = matchResults[lbl];
    const candidates = match && match.candidates ? match.candidates : [];
    const chosenIdx = choices[lbl] !== undefined ? choices[lbl] : (candidates.length > 0 ? 0 : -1);
    const chosen = chosenIdx >= 0 && chosenIdx < candidates.length ? candidates[chosenIdx] : null;

    if (!isNamingOnly && !chosen) {
      unboundFields.push(lbl);
    }

    const isTableCol = chosen && chosen.suggestedValueLocation && chosen.suggestedValueLocation.type === 'table_column';
    const normLbl = normalizeLabelForCompare(lbl);

    // Separate certificate measurement table columns（只接受真实测量区域内、且语义上确实是列头的字段）
    if (tmpl.type === 'cert' && isTableCol) {
      const loc = chosen.suggestedValueLocation;
      const inMeasurementRegion = !measurementRegion
        ? !isSingleValueLikeLabel(lbl)
        : (measurementRegion.tableIdx === loc.tableIdx &&
           loc.colIdx >= measurementRegion.colStart && loc.colIdx <= measurementRegion.colEnd);

      if (!inMeasurementRegion) {
        // 单值字段即便被误判成列，也不得进入测量表；退回单值绑定（整改 3.1）
        singleFields.push({
          label: lbl,
          status: 'unbound',
          location: chosen.location || null,
          valueLocation: null,
          candidateValue: chosen.candidateValue || null
        });
        unboundFields.push(`${lbl}(原被误判为测量列，需按单值字段重新绑定)`);
        return;
      }

      const isSeq = /test\s*point|testpoint|测试点|^序号$|^序\s*号$|\bstep\b/.test(normLbl);
      const isAct = /analyzer|actual|reading|实测|指示|indication|output|输出/.test(normLbl);
      const isStd = !isSeq && !isAct && /nist|standard|\bstd\b|\bvalue\b|标准值?/.test(normLbl);

      let role = 'text';
      if (isSeq) role = 'seq';
      else if (isStd) role = 'standard';
      else if (isAct) role = 'actual';
      else if (/gas|介质/.test(normLbl)) role = 'gas';

      const fullVals = (chosen.fullValues && chosen.fullValues.length > 0)
        ? chosen.fullValues
        : (chosen.sampleValues || []);

      matchedTableCols.push({
        label: lbl,
        normLbl,
        candidate: chosen,
        loc,
        colIdx: loc.colIdx,
        tableIdx: loc.tableIdx,
        startRow: loc.startRow,
        endRow: loc.endRow,
        role,
        isSeq,
        isStd,
        isAct,
        fullValues: fullVals
      });

      if (isStd && !stdCandidate) {
        stdCandidate = chosen;
        stdLabel = lbl;
      } else if (isAct && !actCandidate) {
        actCandidate = chosen;
        actLabel = lbl;
      } else if (isSeq && !pointCandidate) {
        pointCandidate = chosen;
        pointLabel = lbl;
      }

      return; // Exclude from singleFields!
    }

    if (tmpl.type === 'packing' && isTableCol) {
      return; // Exclude from singleFields!
    }

    singleFields.push({
      label: lbl,
      status: chosen ? 'bound' : (isNamingOnly ? 'naming_only' : 'unbound'),
      location: chosen ? chosen.location : null,
      valueLocation: chosen ? chosen.suggestedValueLocation : null,
      candidateValue: chosen ? chosen.candidateValue : null
    });
  });

  // Construct complete measurement tableConfig and testPoints for cert
  if (tmpl.type === 'cert') {
    if (matchedTableCols.length > 0) {
      // Sort in ascending order of colIdx ("以在模板文件的顺序为准")
      matchedTableCols.sort((a, b) => a.colIdx - b.colIdx);

      // 行数与表格编号以模板真实数据区为准，不再用各列 startRow/endRow 的最大最小拼接（整改 3.2）
      const tableIdx = measurementRegion ? measurementRegion.tableIdx : matchedTableCols[0].tableIdx;
      const startRow = measurementRegion ? measurementRegion.dataStartRow : Math.min(...matchedTableCols.map(c => c.startRow));
      const endRow = measurementRegion ? measurementRegion.dataEndRow : Math.max(...matchedTableCols.map(c => c.endRow));
      const rowCount = Math.max(1, endRow - startRow + 1);
      const regionRowIndices = (measurementRegion && Array.isArray(measurementRegion.rowIndices))
        ? measurementRegion.rowIndices
        : Array.from({ length: rowCount }, (_, i) => startRow + i);

      // Identify standard and actual column candidates for backward compatibility
      let stdColObj = matchedTableCols.find(c => c.isStd) || matchedTableCols.find(c => c.role === 'standard');
      let actColObj = matchedTableCols.find(c => c.isAct) || matchedTableCols.find(c => c.role === 'actual');
      // 序号列只按语义识别；不得用“标准列左侧相邻”推定序号（整改 3.1，Gas 列不得被改成 seq）
      let pointColObj = matchedTableCols.find(c => c.isSeq) || matchedTableCols.find(c => c.role === 'seq') || null;

      // Deduplicate matchedTableCols by colIdx to guarantee no duplicates
      const seenColIdxs = new Set();
      const dedupedCols = [];
      for (const col of matchedTableCols) {
        if (!seenColIdxs.has(col.colIdx)) {
          seenColIdxs.add(col.colIdx);
          dedupedCols.push(col);
        }
      }
      matchedTableCols.length = 0;
      matchedTableCols.push(...dedupedCols);
      matchedTableCols.sort((a, b) => a.colIdx - b.colIdx);

      // Per-column unit detection helper (strict word boundaries to avoid false positives on Remark, Format, etc.)
      function extractColumnUnit(lbl) {
        if (!lbl) return '';
        const s = String(lbl).trim();
        const lower = s.toLowerCase();
        if (lower.includes('℃ dp') || lower.includes('℃') || lower.includes('°c')) return '℃ dp';
        if (lower.includes('ppm')) return 'ppm';
        if (/\bma\b/i.test(s) || /(?:^|[\s\(\[\{（])ma(?:$|[\s\)\]\}）])/i.test(s)) return 'mA';
        if (lower.includes('%rh') || lower.includes('rh')) return '%RH';
        return '';
      }

      // Standard column unit: only from standard column's own label!
      const stdColUnit = stdColObj ? extractColumnUnit(stdColObj.label) : '';
      const unit = stdColUnit; // Global tableConfig.unit represents standard value unit

      // Full list of columns in template file order
      const columns = matchedTableCols.map(col => {
        const colUnit = extractColumnUnit(col.label);
        return {
          key: `col_${col.colIdx}`,
          label: col.label,
          colIdx: col.colIdx,
          role: col.role,
          isSeq: col.isSeq,
          isStd: col.isStd,
          isAct: col.isAct,
          unit: colUnit,
          defaultValues: regionRowIndices.map((_, i) => (col.fullValues && col.fullValues[i] !== undefined) ? col.fullValues[i] : '')
        };
      });

      testPoints = [];
      for (let i = 0; i < rowCount; i++) {
        const rowItem = {
          point: i + 1,
          values: {}
        };
        columns.forEach(col => {
          let val = (col.defaultValues && col.defaultValues[i] !== undefined) ? col.defaultValues[i] : '';
          if (col.isSeq && !val) val = String(i + 1);
          // 保留模板原始值与真实空格；只有模板原值本身带单位时才保留单位，不补造单位（整改 3.3）
          if (col.unit && val && !String(val).toLowerCase().includes(col.unit.toLowerCase())) {
            val = `${val} ${col.unit}`;
          }
          rowItem.values[col.key] = val;
          rowItem.values[String(col.colIdx)] = val;
          rowItem.values[col.label] = val;
        });

        // Backward compatibility properties
        const stdVal = (stdColObj && stdColObj.fullValues && stdColObj.fullValues[i] !== undefined) ? stdColObj.fullValues[i] : '';
        rowItem.std = (stdVal && stdColUnit && !String(stdVal).toLowerCase().includes(stdColUnit.toLowerCase())) ? `${stdVal} ${stdColUnit}` : stdVal;
        rowItem.act = (actColObj && actColObj.fullValues && actColObj.fullValues[i] !== undefined) ? actColObj.fullValues[i] : '';
        rowItem.name = (pointColObj && pointColObj.fullValues && pointColObj.fullValues[i] !== undefined) ? pointColObj.fullValues[i] : (pointColObj ? String(i + 1) : `测试点 ${i + 1}`);

        testPoints.push(rowItem);
      }

      tableConfig = {
        tableIdx,
        headerRow: measurementRegion ? measurementRegion.headerRow : (startRow > 0 ? startRow - 1 : 0),
        headers: {
          point: pointColObj ? pointColObj.label : null,
          standard: stdColObj ? stdColObj.label : null,
          actual: actColObj ? actColObj.label : null
        },
        columns,
        startRow,
        endRow,
        rowCount,
        rowStrategy: 'fixed',
        regionId: measurementRegion ? `region_${measurementRegion.tableIdx}_measurement` : null,
        regionAmbiguous: measurementRegion ? !!measurementRegion.ambiguous : true,
        unit,
        defaultValues: stdColObj ? testPoints.map(p => p.std) : [],
        pointNames: pointColObj ? pointColObj.fullValues : [],
        pointCol: pointColObj ? { label: pointColObj.label, colIdx: pointColObj.colIdx } : null,
        standardCol: stdColObj ? { label: stdColObj.label, colIdx: stdColObj.colIdx } : null,
        actualCol: actColObj ? { label: actColObj.label, colIdx: actColObj.colIdx } : null
      };
    } else if (currentMatcherData.tableConfig) {
      tableConfig = currentMatcherData.tableConfig;
      testPoints = currentMatcherData.testPoints || [];
    }
  } else if (tmpl.type === 'packing') {
    packingItems = buildPackingItemsFromTemplate(matchResults, choices, packingRegion);
  }

  // Publication validations
  if (!isDraft) {
    if (unboundFields.length > 0) {
      return alert(`存在未绑定且需写回 Word 的字段 (${unboundFields.join(', ')})！\n严禁正式发布未绑定的模板逻辑。请先完成字段绑定或保存为草稿。`);
    }
    if (currentMatcherData.structureReliability && currentMatcherData.structureReliability.reliable === false) {
      return alert(`文档结构不可靠：${currentMatcherData.structureReliability.reason}\n禁止据此正式发布，请安装办公组件后重新分析（可先保存草稿）。`);
    }
    if (tmpl.type === 'cert') {
      if (!tableConfig || !tableConfig.standardCol || !tableConfig.actualCol || tableConfig.rowCount <= 0 || testPoints.length <= 0) {
        return alert('发货证书必须完成测量表格区（有效标准值列、实测值列及数据行范围）绑定后方可正式发布！');
      }
      if (testPoints.length !== tableConfig.rowCount) {
        return alert(`证书测量表固定行数校验失败：数据行 (${testPoints.length}) 与模板数据区行数 (${tableConfig.rowCount}) 不一致，请重新分析。`);
      }
      if (tableConfig.regionAmbiguous) {
        return alert('未能可靠定位测量表区域（缺少明确的测量表头特征），请人工确认区域后再发布，或先保存为草稿。');
      }
    }
    if (tmpl.type === 'packing' && packingItems.length === 0) {
      return alert('装箱清单未能从模板识别出物料行，请检查模板表头后重新分析，或先保存为草稿。');
    }
  }

  const packingRowRoles = (packingItems || []).map((it, idx) => ({
    rowIdx: idx,
    role: it.role || (it.isProtected ? 'mainDevice' : 'material'),
    name: it.name || '',
    sn: it.sn || null,
    snCol: (it.snCol === undefined ? null : it.snCol),
    isProtected: !!it.isProtected
  }));

  try {
    const res = await fetch(`${API_BASE}/api/templates/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': 'phoneapp-admin-secret'
      },
      body: JSON.stringify({
        id: tmpl.id,
        model: tmpl.model,
        type: tmpl.type,
        filename: tmpl.filename,
        fieldMappings: {
          analyzedAt: new Date().toISOString(),
          targetLabels: currentMatcherData.targetLabels,
          selectedChoices: choices,
          singleFields,
          tableConfig,
          testPoints,
          packingItems,
          packingRowRoles,
          tableRegions: currentMatcherData.tableRegions || [],
          structureReliability: currentMatcherData.structureReliability || null,
          protectedRows: (packingItems || []).map((it, idx) => (it.isProtected ? idx + 1 : null)).filter(v => v !== null),
          sensorModelConfig: {
            options: sensorOptions,
            defaultValue: sensorDefault
          },
          matches: matchResults,
          choices
        },
        version: tmpl.version,
        isDraft
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '保存失败');

    alert(isDraft ? '已成功保存为草稿版本 (Draft)' : '模板规则与绑定映射已成功正式发布！');
  } catch (err) {
    alert('保存失败: ' + err.message);
  }
}

// ==================== AUDIT LOGS ====================
async function loadAuditLogs() {
  const tbody = document.getElementById('audit-tbody');
  tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 20px;">加载审计日志中...</td></tr>';

  try {
    const res = await fetch(`${API_BASE}/api/audit-logs`);
    const logs = await res.json();

    if (logs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: #94a3b8; padding: 20px;">暂无日志记录</td></tr>';
      return;
    }

    tbody.innerHTML = logs.map(l => `
      <tr>
        <td style="font-size: 12px; color: #64748b; font-family: monospace;">
          ${new Date(l.timestamp).toLocaleString('zh-CN')}
        </td>
        <td><b style="color: #0052cc;">${l.action}</b></td>
        <td>${l.client_name || l.client_id || '系统'}</td>
        <td style="font-family: monospace; font-size: 11px; color: #475569;">
          ${JSON.stringify(l.details || {})}
        </td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4">加载日志失败: ${err.message}</td></tr>`;
  }
}


// ==================== DIRECTORIES CENTRALIZED MANAGEMENT ====================
let allWorkerDirectories = [];
let cachedWorkersList = [];
let cachedTemplatesList = [];

async function loadWorkerDirectories() {
  const tbody = document.getElementById('directories-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="9" class="text-muted" style="text-align:center;">正在刷新保存目录配置与检查状态...</td></tr>';

  try {
    const res = await fetch('/api/admin/worker-directories');
    allWorkerDirectories = await res.json();
    renderWorkerDirectoriesTable(allWorkerDirectories);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="9" style="color:red; text-align:center;">加载失败: ${err.message}</td></tr>`;
  }
}

function renderWorkerDirectoriesTable(list) {
  const tbody = document.getElementById('directories-tbody');
  if (!tbody) return;

  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="text-muted" style="text-align:center;">暂无任何执行端保存目录配置。请点击右上角 "+ 新建保存目录配置" 开始配置。</td></tr>';
    return;
  }

  tbody.innerHTML = list.map(item => {
    let statusBadge = '<span class="status-badge" style="background:#fffbeb; color:#92400e;">⏳ 待检查</span>';
    if (item.check_status === 'CHECKING') {
      statusBadge = '<span class="status-badge" style="background:#eff6ff; color:#1e40af;">🔄 检查中...</span>';
    } else if (item.check_status === 'PASSED') {
      statusBadge = '<span class="status-badge" style="background:#ecfdf5; color:#065f46;">✅ 检查通过</span>';
    } else if (item.check_status === 'FAILED') {
      statusBadge = '<span class="status-badge" style="background:#fef2f2; color:#991b1b;">❌ 检查失败</span>';
    }

    const docTypeBadge = item.doc_type === 'cert'
      ? '<span class="status-badge" style="background:#e0e7ff; color:#3730a3;">发货证书</span>'
      : '<span class="status-badge" style="background:#fef3c7; color:#92400e;">装箱清单</span>';

    const saveModeText = item.save_mode === 'subfolder'
      ? `<span>📁 子文件夹<br><small class="text-muted">[${item.subfolder_rule || 'deviceSn'}]</small></span>`
      : '<span>直接保存</span>';

    const allowCreateText = item.allow_create ? '<span style="color:#059669; font-weight:600;">是</span>' : '<span style="color:#6b7280;">否</span>';

    const checkDetails = item.check_message
      ? `<div style="font-size:0.85rem; max-width:240px; word-break:break-all; color:${item.check_status === 'FAILED' ? '#dc2626' : '#4b5563'};">${item.check_message}</div>`
      : '<span class="text-muted">-</span>';
    const checkedAt = item.checked_at ? `<div style="font-size:0.75rem; color:#9ca3af;">${item.checked_at.slice(0, 19).replace('T', ' ')}</div>` : '';

    return `
      <tr>
        <td>
          <strong>${item.worker_name || item.worker_id}</strong>
          <div style="font-size:0.8rem; color:#6b7280;">ID: ${item.worker_id}</div>
        </td>
        <td>
          <div>${item.template_filename || item.template_id}</div>
          <div style="font-size:0.8rem; color:#6b7280;">型号: ${item.template_model || '-'}</div>
        </td>
        <td>${docTypeBadge}</td>
        <td><code style="background:#f1f5f9; padding:2px 6px; border-radius:4px; font-size:0.85rem;">${item.root_dir}</code></td>
        <td>${saveModeText}</td>
        <td>${allowCreateText}</td>
        <td>${statusBadge}</td>
        <td>${checkDetails}${checkedAt}</td>
        <td>
          <div style="display:flex; gap:4px; flex-wrap:wrap;">
            <button class="btn btn-sm btn-outline-primary" onclick="triggerDirectoryCheck(${item.id})">🔍 立即检查</button>
            <button class="btn btn-sm btn-outline-secondary" onclick="editDirectoryConfig(${item.id})">✏️ 编辑</button>
            <button class="btn btn-sm btn-outline-danger" onclick="deleteDirectoryConfig(${item.id})">🗑️ 删除</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

async function showCreateDirectoryModal() {
  document.getElementById('directory-modal-title').textContent = '新建执行端保存目录配置';
  document.getElementById('dir-config-id').value = '';
  document.getElementById('dir-root-dir').value = '';
  document.getElementById('dir-save-mode').value = 'direct';
  document.getElementById('dir-subfolder-rule').value = 'deviceSn';
  document.getElementById('dir-allow-create').checked = false;
  document.getElementById('dir-subfolder-rule-group').style.display = 'none';

  await populateDirModalDropdowns();
  document.getElementById('directory-modal').style.display = 'flex';
}

function onDirSaveModeChanged() {
  const mode = document.getElementById('dir-save-mode').value;
  document.getElementById('dir-subfolder-rule-group').style.display = mode === 'subfolder' ? 'block' : 'none';
}

async function populateDirModalDropdowns() {
  const workerSelect = document.getElementById('dir-worker-id');
  const templateSelect = document.getElementById('dir-template-id');

  try {
    const [wRes, tRes] = await Promise.all([
      fetch('/api/workers'),
      fetch('/api/templates')
    ]);
    cachedWorkersList = await wRes.json();
    cachedTemplatesList = await tRes.json();

    workerSelect.innerHTML = '<option value="">-- 请选择执行终端 --</option>' +
      cachedWorkersList.map(w => `<option value="${w.id}">${w.name || w.id} (${w.status})</option>`).join('');

    templateSelect.innerHTML = '<option value="">-- 请选择模板 --</option>' +
      cachedTemplatesList.map(t => `<option value="${t.id}" data-type="${t.type}" data-model="${t.model}">${t.filename} [${t.model} - ${t.type}]</option>`).join('');
  } catch (e) {}
}

function onDirTemplateChanged() {
  const sel = document.getElementById('dir-template-id');
  const opt = sel.options[sel.selectedIndex];
  if (opt && opt.dataset.type) {
    document.getElementById('dir-doc-type').value = opt.dataset.type;
  }
}

function onDirWorkerChanged() {}

function closeDirectoryModal() {
  document.getElementById('directory-modal').style.display = 'none';
}

async function editDirectoryConfig(id) {
  const item = allWorkerDirectories.find(d => d.id === id);
  if (!item) return;

  await showCreateDirectoryModal();
  document.getElementById('directory-modal-title').textContent = '编辑执行端保存目录配置 (v' + (item.version || 1) + ')';
  document.getElementById('dir-config-id').value = item.id;
  document.getElementById('dir-worker-id').value = item.worker_id;
  document.getElementById('dir-template-id').value = item.template_id;
  document.getElementById('dir-doc-type').value = item.doc_type;
  document.getElementById('dir-root-dir').value = item.root_dir;
  document.getElementById('dir-save-mode').value = item.save_mode;
  document.getElementById('dir-subfolder-rule').value = item.subfolder_rule || 'deviceSn';
  document.getElementById('dir-allow-create').checked = Boolean(item.allow_create);
  onDirSaveModeChanged();
}

async function saveDirectoryConfig(e) {
  e.preventDefault();
  const id = document.getElementById('dir-config-id').value;
  const workerId = document.getElementById('dir-worker-id').value;
  const templateId = document.getElementById('dir-template-id').value;
  const docType = document.getElementById('dir-doc-type').value;
  const rootDir = document.getElementById('dir-root-dir').value.trim();
  const saveMode = document.getElementById('dir-save-mode').value;
  const subfolderRule = document.getElementById('dir-subfolder-rule').value.trim();
  const allowCreate = document.getElementById('dir-allow-create').checked;

  try {
    const res = await fetch('/api/admin/worker-directories', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': 'phoneapp-admin-secret'
      },
      body: JSON.stringify({
        id: id || undefined,
        workerId,
        templateId,
        docType,
        rootDir,
        saveMode,
        subfolderRule,
        allowCreate
      })
    });
    const data = await res.json();
    if (!res.ok) {
      alert('保存失败: ' + (data.error || '未知错误'));
      return;
    }
    closeDirectoryModal();
    await loadWorkerDirectories();
    if (confirm('配置保存成功！当前状态已自动重置为“待检查”。\n是否立即向目标执行端下发目录连通与权限检查？')) {
      await triggerDirectoryCheck(data.config.id);
    }
  } catch (err) {
    alert('网络错误: ' + err.message);
  }
}

async function triggerDirectoryCheck(id) {
  try {
    const res = await fetch(`/api/admin/worker-directories/${id}/check`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': 'phoneapp-admin-secret'
      }
    });
    const data = await res.json();
    if (!res.ok) {
      alert('检查失败: ' + (data.error || data.message || '未知错误'));
    } else {
      alert(data.message || '检查请求已下发！');
    }
    await loadWorkerDirectories();
  } catch (err) {
    alert('请求异常: ' + err.message);
  }
}

async function deleteDirectoryConfig(id) {
  if (!confirm('确定要删除此条保存目录配置吗？\n删除后该执行端将无法处理此模板的任务！')) return;
  try {
    const res = await fetch(`/api/admin/worker-directories/${id}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': 'phoneapp-admin-secret'
      }
    });
    if (res.ok) {
      await loadWorkerDirectories();
    } else {
      const data = await res.json();
      alert('删除失败: ' + (data.error || '未知错误'));
    }
  } catch (err) {
    alert('请求异常: ' + err.message);
  }
}
