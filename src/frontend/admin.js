/**
 * phoneApp Coordinator Server Admin Console Logic (协调服务主机专用控制台)
 * Rules: C01, C02, C03, C04, C05, C13
 */

const API_BASE = window.location.origin;

let currentMatcherData = null;

window.addEventListener('DOMContentLoaded', () => {
  loadClients();
  loadWorkers();
  loadTemplates();
  loadAuditLogs();
});

// Tab Navigation
function switchTab(tabId) {
  ['clients', 'workers', 'templates', 'matcher', 'audit'].forEach(t => {
    const sec = document.getElementById(`sec-${t}`);
    const side = document.getElementById(`side-${t}`);
    if (sec) sec.style.display = t === tabId ? 'block' : 'none';
    if (side) {
      if (t === tabId) side.classList.add('active');
      else side.classList.remove('active');
    }
  });

  if (tabId === 'clients') loadClients();
  if (tabId === 'workers') loadWorkers();
  if (tabId === 'templates') loadTemplates();
  if (tabId === 'matcher') populateMatcherSelect();
  if (tabId === 'audit') loadAuditLogs();
}

// ==================== C01: CLIENT MANAGEMENT (集中修改手机端名字) ====================
async function loadClients() {
  const tbody = document.getElementById('clients-tbody');
  tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 20px;">加载客户端列表中...</td></tr>';

  try {
    const res = await fetch(`${API_BASE}/api/clients`);
    const clients = await res.json();

    if (clients.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #94a3b8; padding: 24px;">暂无已登记的 APP 客户端</td></tr>';
      return;
    }

    tbody.innerHTML = clients.map(c => `
      <tr>
        <td style="font-family: monospace; font-size: 12px; color: #475569;">${c.id}</td>
        <td><b style="font-size: 14px; color: #0f172a;">${c.name}</b></td>
        <td style="font-size: 12px; color: #64748b;">${new Date(c.last_seen).toLocaleString('zh-CN')}</td>
        <td><span class="badge badge-success">已注册</span></td>
        <td style="text-align: right;">
          <button type="button" class="btn btn-sm btn-outline" onclick="openRenameModal('${c.id}', '${c.name}')">
            ✏️ 修改名字
          </button>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5">加载失败: ${err.message}</td></tr>`;
  }
}

function openRenameModal(clientId, currentName) {
  document.getElementById('modal-client-id').value = clientId;
  document.getElementById('modal-client-id-disp').value = clientId;
  document.getElementById('modal-client-name').value = currentName;
  document.getElementById('rename-modal').classList.add('active');
}

function closeRenameModal() {
  document.getElementById('rename-modal').classList.remove('active');
}

async function submitRenameClient() {
  const id = document.getElementById('modal-client-id').value;
  const newName = document.getElementById('modal-client-name').value.trim();
  if (!newName) return alert('姓名不能为空');

  try {
    const res = await fetch(`${API_BASE}/api/clients/${id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': 'phoneapp-admin-secret'
      },
      body: JSON.stringify({ name: newName })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '保存失败');

    closeRenameModal();
    loadClients();
    alert(`APP 手机端姓名已成功修改为: ${newName} (手机端将在 5 秒内自动同步生效)`);
  } catch (err) {
    alert('修改失败: ' + err.message);
  }
}

// ==================== C02, R03, R04: WORKER & PRINTER MONITORING ====================
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

      const printersHtml = printerDetails.length > 0 
        ? printerDetails.map(p => `
            <span class="printer-pill ${p.isShared ? 'shared' : ''}">
              ${p.isShared ? '🖨️ [共享]' : (p.isVirtual ? '📄 [虚拟]' : '🖨️ [物理]')} ${p.name}
            </span>
          `).join('')
        : '<span style="font-size: 12px; color: #94a3b8;">未检测到打印机</span>';

      return `
        <div class="worker-stat-card">
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
            <div><b>工作目录:</b> <code>${w.working_dir || '默认目录'}</code></div>
            <div><b>最后心跳:</b> ${w.last_heartbeat ? new Date(w.last_heartbeat).toLocaleString('zh-CN') : '无'}</div>
          </div>
          <div style="margin-top: 10px;">
            <div style="font-size: 12px; font-weight: 700; color: #475569; margin-bottom: 4px;">检测到打印机外设:</div>
            <div>${printersHtml}</div>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    container.innerHTML = '加载执行终端失败: ' + err.message;
  }
}

// ==================== C03: TEMPLATES MANAGEMENT ====================
async function loadTemplates() {
  const tbody = document.getElementById('templates-tbody');
  tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 20px;">加载模板库中...</td></tr>';

  try {
    const res = await fetch(`${API_BASE}/api/templates`);
    const tmpls = await res.json();

    if (tmpls.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: #94a3b8; padding: 20px;">暂无模板文件</td></tr>';
      return;
    }

    tbody.innerHTML = tmpls.map(t => `
      <tr>
        <td><b>${t.filename}</b></td>
        <td><span class="badge badge-warning">${t.model}</span></td>
        <td>${t.type === 'cert' ? '发货证书' : '装箱清单'}</td>
        <td>${t.version}</td>
        <td style="font-family: monospace; font-size: 11px; color: #64748b;">${t.file_hash.substring(0, 18)}...</td>
        <td style="font-size: 12px; color: #64748b;">${new Date(t.published_at).toLocaleString('zh-CN')}</td>
        <td style="text-align: right;">
          <button type="button" class="btn btn-sm btn-outline" onclick="goToMatcher('${t.id}')">
            🤖 字段匹配
          </button>
          <a href="${API_BASE}/api/templates/${t.id}/download" class="btn btn-sm btn-secondary" download>
            ⬇️ 下载
          </a>
          <button type="button" class="btn btn-sm btn-danger" onclick="deleteTemplate('${t.id}')">
            🗑️ 删除
          </button>
        </td>
      </tr>
    `).join('');

    populateMatcherSelect(tmpls);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7">加载失败: ${err.message}</td></tr>`;
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

  try {
    const res = await fetch(`${API_BASE}/api/templates/upload`, {
      method: 'POST',
      headers: {
        'x-admin-token': 'phoneapp-admin-secret'
      },
      body: formData
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '上传失败');

    alert(`模板文件 [${data.filename}] 成功上传入库！`);
    fileInput.value = '';
    loadTemplates();
  } catch (err) {
    alert('上传失败: ' + err.message);
  }
}

async function deleteTemplate(tmplId) {
  if (!confirm('确定要删除该模板文件吗？')) return;
  try {
    const res = await fetch(`${API_BASE}/api/templates/${tmplId}`, {
      method: 'DELETE',
      headers: {
        'x-admin-token': 'phoneapp-admin-secret'
      }
    });
    if (!res.ok) throw new Error('删除失败');
    loadTemplates();
  } catch (err) {
    alert('删除失败: ' + err.message);
  }
}

// ==================== C04, C05: FIELD MATCHER WORKBENCH ====================
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

async function runTemplateAnalyze() {
  const select = document.getElementById('matcher-select-template');
  const tmplId = select ? select.value : '';
  if (!tmplId) return alert('请先选择模板');

  const container = document.getElementById('matcher-results-container');
  const tbody = document.getElementById('matcher-tbody');
  container.style.display = 'block';
  tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 20px;">🤖 正在深度解析 Word 结构并提取单元格与段落...</td></tr>';

  try {
    const res = await fetch(`${API_BASE}/api/templates/${tmplId}/analyze`);
    const data = await res.json();
    currentMatcherData = data;

    document.getElementById('matcher-doc-title').innerText = `模板字段位置匹配清单: ${data.template.filename}`;
    document.getElementById('matcher-doc-meta').innerText = `型号: ${data.template.model} | 提取文本结构项: ${data.docItemsCount} 项`;

    renderMatcherTable();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6">分析失败: ${err.message}</td></tr>`;
  }
}

function renderMatcherTable() {
  if (!currentMatcherData) return;
  const tbody = document.getElementById('matcher-tbody');
  const matchResults = currentMatcherData.matchResults || {};
  const targetLabels = currentMatcherData.targetLabels || Object.keys(matchResults);

  tbody.innerHTML = targetLabels.map((key, idx) => {
    const match = matchResults[key];
    const candidates = match && match.candidates ? match.candidates : [];
    const best = candidates.length > 0 ? candidates[0] : null;

    let candidateOptions = '<option value="">-- 手动绑定 / 无匹配 --</option>';
    candidates.forEach((c, cIdx) => {
      const labelStr = c.location.type === 'cell' 
        ? `[单元格 R${c.location.rowIdx + 1}C${c.location.colIdx + 1}] ${c.matchedLabel}` 
        : `[段落 #${c.location.paragraphIdx + 1}] ${c.matchedLabel}`;
      candidateOptions += `<option value="${cIdx}" ${cIdx === 0 ? 'selected' : ''}>${labelStr} (${Math.round(c.score * 100)}% 命中)</option>`;
    });

    const isBound = best !== null;

    return `
      <tr>
        <td><b style="color: #0f172a; font-size: 14px;">${key}</b></td>
        <td><span class="badge ${isBound ? 'badge-success' : 'badge-warning'}">${isBound ? Math.round(best.score * 100) + '% 命中' : '待配置'}</span></td>
        <td>
          <select class="form-control" style="font-size: 12px;" onchange="updateCandidateChoice('${key}', this.value)">
            ${candidateOptions}
          </select>
        </td>
        <td><b style="color: #0284c7;">${best && best.candidateValue ? best.candidateValue : '已绑定'}</b></td>
        <td><code>${best ? best.context : '未命中'}</code></td>
        <td style="text-align: right;">
          <button type="button" class="btn btn-sm btn-danger" onclick="deleteMatcherField('${key}')">🗑️ 删除字段</button>
        </td>
      </tr>
    `;
  }).join('') + `
    <tr>
      <td colspan="6" style="background: #f8fafc; text-align: center; padding: 12px;">
        <button type="button" class="btn btn-sm btn-outline" onclick="addMatcherField()">➕ 添加需要配置的字段</button>
      </td>
    </tr>
  `;
}

function addMatcherField() {
  const fieldName = prompt('请输入新新增要配置的字段名称:');
  if (!fieldName || !fieldName.trim()) return;

  const key = fieldName.trim();
  if (!currentMatcherData.targetLabels) currentMatcherData.targetLabels = [];
  if (!currentMatcherData.targetLabels.includes(key)) {
    currentMatcherData.targetLabels.push(key);
    currentMatcherData.matchResults[key] = { label: key, matchCount: 0, candidates: [] };
  }
  renderMatcherTable();
}

function deleteMatcherField(key) {
  if (confirm(`确定要删除配置字段 [${key}] 吗？`)) {
    currentMatcherData.targetLabels = currentMatcherData.targetLabels.filter(k => k !== key);
    delete currentMatcherData.matchResults[key];
    renderMatcherTable();
  }
}

function updateCandidateChoice(key, candidateIdx) {
  // Candidate choice update handler
}

async function saveMatchedRules(isDraft = false) {
  if (!currentMatcherData) return alert('当前没有可保存的匹配结果');

  const tmpl = currentMatcherData.template;
  const matchResults = currentMatcherData.matchResults || {};

  const singleFields = currentMatcherData.targetLabels.map(lbl => {
    const res = matchResults[lbl];
    const best = res && res.candidates && res.candidates.length > 0 ? res.candidates[0] : null;
    return {
      label: lbl,
      status: best ? 'bound' : 'unbound',
      location: best ? best.location : null
    };
  });

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
          singleFields,
          matches: matchResults
        },
        version: tmpl.version,
        isDraft
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '保存失败');
    alert(isDraft ? '已保存为草稿版本' : '字段映射规则已成功正式发布至协调服务模板库！');
  } catch (err) {
    alert(err.message);
  }
}

// ==================== C13: AUDIT LOGS ====================
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
