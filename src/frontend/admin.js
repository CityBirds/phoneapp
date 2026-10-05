
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

window.addEventListener('DOMContentLoaded', () => {
  function handleHashRoute() {
    const hash = window.location.hash || '#clients';
    if (hash === '#directories' || hash.startsWith('#directories')) {
      switchTab('directories');
    } else if (hash.startsWith('#worker-detail')) {
      const match = hash.match(/workerId=([^&]+)/);
      if (match) {
        showWorkerDetail(decodeURIComponent(match[1]));
      } else {
        switchTab('workers');
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
let currentWorkerTemplateConfigs = [];

// Tab Navigation
function switchTab(tabId) {
  const isDirectories = tabId === 'directories';
  const effectiveTab = isDirectories ? 'workers' : tabId;

  ['clients', 'workers', 'worker-detail', 'templates', 'sales-persons', 'sensor-configs', 'matcher', 'audit'].forEach(t => {
    const sec = document.getElementById(`sec-${t}`);
    const side = document.getElementById(`side-${t}`);
    if (sec) sec.style.display = t === effectiveTab ? 'block' : 'none';
    if (side) {
      if (t === effectiveTab || ((effectiveTab === 'sales-persons' || effectiveTab === 'sensor-configs') && t === 'templates')) side.classList.add('active');
      else side.classList.remove('active');
    }
  });

  const banner = document.getElementById('directories-migration-banner');
  if (banner) {
    banner.style.display = isDirectories ? 'block' : 'none';
  }

  if (effectiveTab === 'clients') loadClients();
  if (effectiveTab === 'workers') loadWorkers();
  if (effectiveTab === 'templates') loadTemplates();
  if (effectiveTab === 'sales-persons') loadSalesPersons();
  if (effectiveTab === 'sensor-configs') loadSensorConfigs();
  if (effectiveTab === 'matcher') populateMatcherSelect();
  if (effectiveTab === 'audit') loadAuditLogs();
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
  if (!workerId) return;
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

  // Load Worker Info
  try {
    const res = await fetch(`${API_BASE}/api/workers?all=true`);
    const workers = await res.json();
    const worker = workers.find(w => w.id === workerId) || { id: workerId, name: workerId, status: 'OFFLINE' };

    document.getElementById('detail-worker-title').innerText = `🖥️ 执行终端配置: ${worker.name}`;
    document.getElementById('detail-worker-status-badge').innerHTML = `
      <span class="badge ${worker.status === 'ONLINE' ? 'badge-success' : 'badge-danger'}" style="font-size: 14px; padding: 6px 12px;">
        ${worker.status === 'ONLINE' ? '🟢 在线就绪' : '🔴 离线'}
      </span>
    `;

    document.getElementById('detail-worker-info-content').innerHTML = `
      <div><b>终端名称:</b> ${worker.name}</div>
      <div><b>固定 Worker ID:</b> <code>${worker.id}</code></div>
      <div><b>IP 地址:</b> ${worker.ip || '127.0.0.1'}</div>
      <div><b>程序工作目录:</b> <code>${worker.working_dir || '未上报'}</code> <span style="font-size: 11px; color: #94a3b8;">(程序运行工作目录，不作为业务保存目录)</span></div>
      <div><b>关联打印机:</b> ${(worker.printers && JSON.parse(worker.printers || '[]').join(', ')) || '无'}</div>
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

// --- 1. Allowed Paths Management ---
async function loadWorkerAllowedPaths(workerId) {
  const tbody = document.getElementById('allowed-paths-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; padding: 14px; color: #64748b;">正在加载允许访问的业务路径...</td></tr>';

  try {
    const paths = await safeFetchJson(`${API_BASE}/api/admin/workers/${encodeURIComponent(workerId)}/allowed-paths`);
    currentWorkerAllowedPaths = Array.isArray(paths) ? paths : [];

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

      return `
        <tr style="border-bottom: 1px solid #f1f5f9;">
          <td style="padding: 10px; font-family: monospace; font-weight: 600;">${p.root_path}</td>
          <td style="padding: 10px; text-align: center;">${p.allow_read ? '✅ 允许' : '❌ 禁止'}</td>
          <td style="padding: 10px; text-align: center;">${p.allow_write ? '✅ 允许' : '❌ 禁止'}</td>
          <td style="padding: 10px; text-align: center;"><span style="font-size: 12px; color: #64748b;">${p.sync_status === 'SYNCED' ? '已同步' : '待同步'}</span></td>
          <td style="padding: 10px; text-align: center;"><span class="badge ${badgeClass}">${statusText}</span></td>
          <td style="padding: 10px; font-size: 12px; color: #64748b;">${p.check_message || '-'}</td>
          <td style="padding: 10px; text-align: center;">
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
  tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; padding: 14px; color: #64748b;">正在加载本终端模板配置...</td></tr>';

  try {
    const tmpls = await safeFetchJson(`${API_BASE}/api/admin/workers/${encodeURIComponent(workerId)}/template-configs`);
    currentWorkerTemplateConfigs = Array.isArray(tmpls) ? tmpls : [];

    if (currentWorkerTemplateConfigs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; padding: 18px; color: #94a3b8;">模板库暂无已上传模板</td></tr>';
      return;
    }

    tbody.innerHTML = currentWorkerTemplateConfigs.map(t => {
      let badgeClass = 'badge-secondary';
      let statusText = '未配置';
      if (t.check_status === 'PASSED') {
        badgeClass = 'badge-success';
        statusText = '通过';
      } else if (t.check_status === 'FAILED') {
        badgeClass = 'badge-danger';
        statusText = '失败';
      } else if (t.check_status === 'CHECKING') {
        badgeClass = 'badge-warning';
        statusText = '检查中';
      } else if (t.root_dir) {
        statusText = '待检查';
      }

      const isEnabled = Boolean(t.is_enabled);
      const docLabel = t.doc_type === 'cert' ? '📜 发货证书' : '📦 装箱清单';

      return `
        <tr style="border-bottom: 1px solid #f1f5f9; ${!isEnabled ? 'opacity: 0.75;' : ''}">
          <td style="padding: 10px;">
            <b>${t.model}</b>
            <div style="font-size: 11px; color: #64748b;">${t.filename}</div>
          </td>
          <td style="padding: 10px; text-align: center;">${docLabel}</td>
          <td style="padding: 10px; text-align: center;">
            <span class="badge ${isEnabled ? 'badge-success' : 'badge-secondary'}">
              ${isEnabled ? '✅ 已启用' : '⚪ 未启用'}
            </span>
          </td>
          <td style="padding: 10px; font-family: monospace; font-size: 12px;">${t.root_dir || '<span style="color:#94a3b8;">未配置</span>'}</td>
          <td style="padding: 10px; text-align: center; font-size: 12px;">${t.save_mode === 'subfolder' ? '📂 按序列号归档' : '📁 根目录直接保存'}</td>
          <td style="padding: 10px; text-align: center;">${t.allow_create ? '是' : '否'}</td>
          <td style="padding: 10px; text-align: center;"><span class="badge ${badgeClass}">${statusText}</span></td>
          <td style="padding: 10px; font-size: 12px; color: #64748b;">${t.check_message || '-'}</td>
          <td style="padding: 10px; text-align: center;">
            <button type="button" class="btn btn-secondary btn-sm" onclick="openWorkerTemplateModal('${t.template_id}', '${t.doc_type}')">⚙️ 配置</button>
            ${t.config_id ? `<button type="button" class="btn btn-primary btn-sm" onclick="checkWorkerTemplate(${t.config_id})">🔍 探测</button>` : ''}
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="9" style="color: #ef4444; text-align: center; padding: 16px;">
      加载本终端模板配置失败: ${escapeHtml(err.message)}
      <button type="button" class="btn btn-secondary btn-sm" onclick="loadWorkerTemplateConfigs('${escapeHtml(workerId)}')" style="margin-left: 10px;">🔄 重试</button>
    </td></tr>`;
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
    await loadTemplates();
  } catch (err) {
    alert('删除失败: ' + err.message);
  }
}

// ==================== FIELD MATCHER WORKBENCH ====================
async function populateMatcherSelect(tmpls) {
  const select = document.getElementById('matcher-select-template');
  if (!select) return;

  if (!tmpls) {
    const res = await fetch(`${API_BASE}/api/templates`);
    tmpls = await res.json();
  }

  select.innerHTML = '<option value="">请选择需要分析匹配的模板...</option>' + tmpls.map(t => `
    <option value="${t.id}">${t.model} - ${t.type === 'cert' ? '发货证书' : '装箱清单'} (${t.filename})</option>
  `).join('');
}

function goToMatcher(tmplId) {
  switchTab('matcher');
  const select = document.getElementById('matcher-select-template');
  if (select) {
    select.value = tmplId;
    runTemplateAnalyze();
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

  const container = document.getElementById('matcher-results-container');
  const tbody = document.getElementById('matcher-tbody');
  const sensorCard = document.getElementById('sensor-model-config-card');

  container.style.display = 'block';
  tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; padding: 20px;">🤖 正在深度解析 Word 结构并提取单元格与段落...</td></tr>';

  try {
    const res = await fetch(`${API_BASE}/api/templates/${tmplId}/analyze`);
    const data = await res.json();
    currentMatcherData = data;
    currentMatcherData.selectedChoices = {};

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
              body: JSON.stringify({ targetLabel: lbl, docItems: data.docItems || [] })
            });
            currentMatcherData.matchResults[lbl] = await mRes.json();
          } catch (e) {
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

    document.getElementById('matcher-doc-title').innerText = `模板字段位置匹配清单: ${data.template.filename}`;
    document.getElementById('matcher-doc-meta').innerText = `型号: ${data.template.model} | 提取文本结构项: ${data.docItemsCount} 项`;

    if (data.template.model === 'POA200' && data.template.type === 'cert') {
      if (sensorCard) sensorCard.style.display = 'block';
      previewSensorOptions();
    } else {
      if (sensorCard) sensorCard.style.display = 'none';
    }

    renderMatcherTable();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8">分析失败: ${err.message}</td></tr>`;
  }
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
  let packingItems = currentMatcherData.packingItems || [];

  let stdCandidate = null;
  let stdLabel = '';
  let actCandidate = null;
  let actLabel = '';

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
    const normLbl = (lbl || '').toLowerCase();

    // Separate certificate measurement table columns
    if (tmpl.type === 'cert' && isTableCol) {
      if (normLbl.includes('standard') || normLbl.includes('nist') || normLbl.includes('标准')) {
        stdCandidate = chosen;
        stdLabel = lbl;
        return; // Exclude from singleFields!
      } else if (normLbl.includes('analyzer') || normLbl.includes('actual') || normLbl.includes('实测') || normLbl.includes('指示') || normLbl.includes('indication')) {
        actCandidate = chosen;
        actLabel = lbl;
        return; // Exclude from singleFields!
      }
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
    if (stdCandidate && stdCandidate.suggestedValueLocation) {
      const loc = stdCandidate.suggestedValueLocation;
      const rowCount = loc.endRow - loc.startRow + 1;
      const fullVals = stdCandidate.fullValues && stdCandidate.fullValues.length >= rowCount
        ? stdCandidate.fullValues
        : (stdCandidate.sampleValues || []);

      let unit = '';
      if (stdLabel.includes('℃ dp') || stdLabel.includes('℃')) unit = '℃ dp';
      else if (stdLabel.includes('ppm')) unit = 'ppm';
      else if (stdLabel.includes('mA') || stdLabel.includes('ma')) unit = 'mA';

      const defaultValues = [];
      testPoints = [];
      for (let i = 0; i < rowCount; i++) {
        let val = fullVals[i] || '';
        if (val && unit && !val.includes(unit)) {
          val = `${val} ${unit}`;
        }
        defaultValues.push(val);
        testPoints.push({
          point: i + 1,
          std: val,
          act: ''
        });
      }

      tableConfig = {
        tableIdx: loc.tableIdx,
        headerRow: loc.startRow > 0 ? loc.startRow - 1 : 0,
        headers: {
          standard: stdLabel,
          actual: actLabel
        },
        startRow: loc.startRow,
        endRow: loc.endRow,
        rowCount,
        unit,
        defaultValues,
        standardCol: {
          label: stdLabel,
          colIdx: loc.colIdx
        },
        actualCol: actCandidate && actCandidate.suggestedValueLocation ? {
          label: actLabel,
          colIdx: actCandidate.suggestedValueLocation.colIdx
        } : null
      };
    } else if (currentMatcherData.tableConfig) {
      tableConfig = currentMatcherData.tableConfig;
      testPoints = currentMatcherData.testPoints || [];
    }
  } else if (tmpl.type === 'packing') {
    const nameMatch = matchResults['名称'];
    const nameCand = nameMatch && nameMatch.candidates && nameMatch.candidates[0];
    if (nameCand && nameCand.fullValues && nameCand.fullValues.length > 0) {
      const specCand = matchResults['规格']?.candidates?.[0];
      const countCand = matchResults['数量']?.candidates?.[0];
      const unitCand = matchResults['单位']?.candidates?.[0];
      const remarkCand = matchResults['备注']?.candidates?.[0];

      packingItems = nameCand.fullValues.map((name, idx) => ({
        index: idx + 1,
        name,
        spec: specCand?.fullValues?.[idx] || '',
        count: parseInt(countCand?.fullValues?.[idx] || '1', 10) || 1,
        unit: unitCand?.fullValues?.[idx] || '件',
        standard: '是',
        remark: remarkCand?.fullValues?.[idx] || '',
        isProtected: idx === 0
      }));
    }
  }

  // Publication validations
  if (!isDraft) {
    if (unboundFields.length > 0) {
      return alert(`存在未绑定且需写回 Word 的字段 (${unboundFields.join(', ')})！\n严禁正式发布未绑定的模板逻辑。请先完成字段绑定或保存为草稿。`);
    }
    if (tmpl.type === 'cert' && (!tableConfig || !tableConfig.standardCol || !tableConfig.actualCol || tableConfig.rowCount <= 0 || testPoints.length <= 0)) {
      return alert('发货证书必须完成测量表格区（有效标准值列、实测值列及数据行范围）绑定后方可正式发布！');
    }
  }

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
          protectedRows: [1],
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
