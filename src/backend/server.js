const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const { generateCertFilename, generatePackingListFilename } = require('../common/naming');
const { findFieldCandidates } = require('../common/matcher');
const { getBeijingCalendarRange, generateUUID, getFileSha256 } = require('../common/utils');
const { generateDocumentPreview } = require('./preview');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Storage directories
const uploadDir = path.join(__dirname, '../../uploads/templates');
const previewDir = path.join(__dirname, '../../data/previews');
const returnedDir = path.join(__dirname, '../../data/returned');

[uploadDir, previewDir, returnedDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.use('/previews', express.static(previewDir));
app.use('/frontend', express.static(path.join(__dirname, '../frontend')));
app.use(express.static(path.join(__dirname, '../frontend')));
app.get('/', (req, res) => res.redirect('/frontend/index.html'));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '../frontend/admin.html')));

const upload = multer({ dest: uploadDir });

// Security Middleware: Restrict coordinator management operations to localhost (Coordination PC)
function isLocalhostRequest(req) {
  const ip = req.ip || req.connection?.remoteAddress || '';
  const isLocal = ip.includes('127.0.0.1') || ip === '::1' || ip === '::ffff:127.0.0.1' || req.hostname === 'localhost';
  const hasToken = req.headers['x-admin-token'] === 'phoneapp-admin-secret';
  return isLocal || hasToken;
}

function requireAdminAccess(req, res, next) {
  if (!isLocalhostRequest(req)) {
    return res.status(403).json({
      error: '权限受限：该管理功能（修改手机端名字、上传模板、发布配置等）仅限在协调服务电脑本机操作 (C01, C03)'
    });
  }
  next();
}


// Audit Logger Helper (C13, R33)
function logAudit(reqId, clientId, clientName, action, details) {
  const stmt = db.prepare(`
    INSERT INTO audit_logs (req_id, client_id, client_name, action, details, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(reqId || null, clientId || null, clientName || null, action, JSON.stringify(details || {}), new Date().toISOString());
}

// Clean up offline mock/stale workers on startup
function cleanupStaleWorkers() {
  try {
    const cutoff = new Date(Date.now() - 15000).toISOString();
    db.prepare("DELETE FROM workers WHERE last_heartbeat < ? OR last_heartbeat IS NULL OR status = 'OFFLINE' OR id LIKE 'worker-e2e%' OR id LIKE 'worker-test%'").run(cutoff);
  } catch (e) {}
}
cleanupStaleWorkers();

// Default Seed Templates (POA200, DPT810) if empty
function seedDefaultTemplates() {
  const count = db.prepare('SELECT count(*) as cnt FROM templates').get().cnt;
  if (count === 0) {
    const samplesDir = path.join(__dirname, '../../samples');
    if (fs.existsSync(samplesDir)) {
      const poaCertPath = path.join(samplesDir, 'POA200证书AP10007513-20260403发南京订单-PSR-12-223(封装）带泵.doc');
      const poaPackPath = path.join(samplesDir, 'POA200(140)AP10007513发货清单20260403带泵.doc');
      const dptCertPath = path.join(samplesDir, 'DPT810证书(变送器-A010007031)-JM-26.8.28.doc');

      if (fs.existsSync(poaCertPath)) {
        db.prepare(`
          INSERT INTO templates (id, model, type, filename, filepath, file_hash, version, field_mappings, published_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run('tmpl_poa200_cert', 'POA200', 'cert', path.basename(poaCertPath), poaCertPath, getFileSha256(poaCertPath) || 'hash_poa_cert', 'v1.0', JSON.stringify({
          singleFields: { deviceSn: 'Inst. SN.', shippingLocation: 'Customer' },
          tableFields: { testPoints: 'Analyzer pv ppm' }
        }), new Date().toISOString());
      }

      if (fs.existsSync(poaPackPath)) {
        db.prepare(`
          INSERT INTO templates (id, model, type, filename, filepath, file_hash, version, field_mappings, published_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run('tmpl_poa200_pack', 'POA200', 'packing', path.basename(poaPackPath), poaPackPath, getFileSha256(poaPackPath) || 'hash_poa_pack', 'v1.0', JSON.stringify({
          protectedRows: [1, 2] // row 1: main device, row 2: sensor
        }), new Date().toISOString());
      }

      if (fs.existsSync(dptCertPath)) {
        db.prepare(`
          INSERT INTO templates (id, model, type, filename, filepath, file_hash, version, field_mappings, published_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run('tmpl_dpt810_cert', 'DPT810', 'cert', path.basename(dptCertPath), dptCertPath, getFileSha256(dptCertPath) || 'hash_dpt_cert', 'v1.0', JSON.stringify({
          singleFields: { deviceSn: 'Inst. SN.', shippingLocation: 'Customer' },
          tableFields: { testPoints: 'Analyzer Under Test mA' }
        }), new Date().toISOString());
      }
    }
  }
}
seedDefaultTemplates();

// ==================== C01: CLIENT MANAGEMENT (APP端名字管理) ====================
app.post('/api/clients/register', (req, res) => {
  let { clientId, name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (!clientId) clientId = generateUUID();

  const now = new Date().toISOString();
  const existing = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);

  if (existing) {
    db.prepare('UPDATE clients SET name = ?, last_seen = ? WHERE id = ?').run(name, now, clientId);
  } else {
    db.prepare('INSERT INTO clients (id, name, last_seen, created_at) VALUES (?, ?, ?, ?)').run(clientId, name, now, now);
  }

  logAudit(null, clientId, name, 'REGISTER_CLIENT', { clientId, name });
  res.json({ clientId, name });
});

app.get('/api/clients', (req, res) => {
  const clients = db.prepare('SELECT * FROM clients ORDER BY last_seen DESC').all();
  res.json(clients);
});

app.get('/api/clients/:id', (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  res.json(client);
});

app.put('/api/clients/:id', requireAdminAccess, (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  db.prepare('UPDATE clients SET name = ? WHERE id = ?').run(name, id);
  logAudit(null, id, name, 'RENAME_CLIENT', { id, newName: name });
  res.json({ success: true, id, name });
});

// ==================== C02, E03: WORKER & PRINTER MONITORING ====================
app.post('/api/workers/heartbeat', (req, res) => {
  const { workerId, name, ip, workingDir, printers, status = 'ONLINE' } = req.body;
  if (!workerId) return res.status(400).json({ error: 'workerId required' });

  const now = new Date().toISOString();
  const printersJson = JSON.stringify(printers || []);
  const existing = db.prepare('SELECT * FROM workers WHERE id = ?').get(workerId);

  if (existing) {
    db.prepare(`
      UPDATE workers SET name = ?, ip = ?, status = ?, working_dir = ?, printers = ?, last_heartbeat = ?
      WHERE id = ?
    `).run(name || existing.name, ip || existing.ip, status, workingDir || existing.working_dir, printersJson, now, workerId);
  } else {
    db.prepare(`
      INSERT INTO workers (id, name, ip, status, working_dir, printers, last_heartbeat)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(workerId, name || 'Execution Worker', ip || '127.0.0.1', status, workingDir || 'D:\\docs', printersJson, now);
  }

  res.json({ success: true, workerId, timestamp: now });
});

app.get('/api/workers', (req, res) => {
  const now = Date.now();
  const showAll = req.query.all === 'true';
  const rawWorkers = db.prepare('SELECT * FROM workers').all();

  // Analyze printer sharing across all workers
  const printerUsage = {};
  rawWorkers.forEach(w => {
    let pList = [];
    try { pList = JSON.parse(w.printers || '[]'); } catch (e) {}
    pList.forEach(p => {
      const pName = typeof p === 'string' ? p : p.name;
      printerUsage[pName] = (printerUsage[pName] || 0) + 1;
    });
  });

  const workers = rawWorkers.map(w => {
    const lastTime = w.last_heartbeat ? new Date(w.last_heartbeat).getTime() : 0;
    // Considered ONLINE if heartbeat in last 15 seconds
    const isOnline = (now - lastTime) < 15000;
    let printersList = [];
    try { printersList = JSON.parse(w.printers || '[]'); } catch (e) {}

    const printerDetails = printersList.map(p => {
      const pName = typeof p === 'string' ? p : p.name;
      const isShared = (printerUsage[pName] || 0) > 1;
      const pLower = pName.toLowerCase();
      const isVirtual = pLower.includes('pdf') || 
                        pLower.includes('onenote') || 
                        pLower.includes('fax') || 
                        pLower.includes('xps') || 
                        pName.includes('导出');
      return {
        name: pName,
        isShared,
        isVirtual,
        type: isVirtual ? 'virtual' : (isShared ? 'shared_physical' : 'local_physical')
      };
    });

    return {
      ...w,
      status: isOnline ? 'ONLINE' : 'OFFLINE',
      printers: printersList,
      printerDetails
    };
  });

  if (!showAll) {
    return res.json(workers.filter(w => w.status === 'ONLINE'));
  }

  res.json(workers);
});

app.get('/api/workers/:id', (req, res) => {
  const worker = db.prepare('SELECT * FROM workers WHERE id = ?').get(req.params.id);
  if (!worker) return res.status(404).json({ error: 'Worker not found' });
  res.json({
    ...worker,
    printers: JSON.parse(worker.printers || '[]')
  });
});

// ==================== C03, C04, C08: TEMPLATE & FIELD POSITION ASSISTANCE ====================
app.get('/api/templates', (req, res) => {
  const tmpls = db.prepare('SELECT * FROM templates ORDER BY published_at DESC').all().map(t => ({
    ...t,
    field_mappings: JSON.parse(t.field_mappings || '{}')
  }));
  res.json(tmpls);
});

// Template upload (C03)
app.post('/api/templates/upload', requireAdminAccess, upload.single('templateFile'), (req, res) => {
  const { model, type, version = 'v1.0' } = req.body;
  if (!req.file || !model || !type) {
    return res.status(400).json({ error: 'templateFile, model, and type are required' });
  }

  const originalName = req.file.originalname;
  const tmplId = `tmpl_${model.toLowerCase()}_${type}_${Date.now()}`;
  const destPath = path.join(uploadDir, `${tmplId}_${originalName}`);

  try {
    fs.renameSync(req.file.path, destPath);
    const sha256 = getFileSha256(destPath);
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO templates (id, model, type, filename, filepath, file_hash, version, field_mappings, published_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?)
    `).run(tmplId, model.toUpperCase(), type, originalName, destPath, sha256, version, now);

    logAudit(null, 'ADMIN', 'Admin', 'UPLOAD_TEMPLATE', { tmplId, model, type, originalName, sha256 });
    res.json({ success: true, tmplId, model, type, filename: originalName, sha256, version });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save template file: ' + err.message });
  }
});

// Template download
app.get('/api/templates/:id/download', (req, res) => {
  const tmpl = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
  if (!tmpl || !fs.existsSync(tmpl.filepath)) {
    return res.status(404).json({ error: 'Template file not found' });
  }
  res.download(tmpl.filepath, tmpl.filename);
});

// Template delete
app.delete('/api/templates/:id', requireAdminAccess, (req, res) => {
  const tmpl = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
  if (!tmpl) return res.status(404).json({ error: 'Template not found' });

  db.prepare('DELETE FROM templates WHERE id = ?').run(req.params.id);
  if (fs.existsSync(tmpl.filepath)) {
    try { fs.unlinkSync(tmpl.filepath); } catch (e) {}
  }
  logAudit(null, 'ADMIN', 'Admin', 'DELETE_TEMPLATE', { id: req.params.id });
  res.json({ success: true, id: req.params.id });
});

// Auto-analyze template field positions & candidate matching (C04, C05, T03)
app.get('/api/templates/:id/analyze', (req, res) => {
  const tmpl = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
  if (!tmpl) return res.status(404).json({ error: 'Template not found' });

  // Extract items from template file
  const docItems = [];
  if (fs.existsSync(tmpl.filepath)) {
    try {
      const raw = fs.readFileSync(tmpl.filepath);
      const str16 = raw.toString('utf16le');
      const tokens = str16.match(/[\u4e00-\u9fa5A-Za-z0-9_\-\.:()（）/ ]{2,}/g) || [];
      const cleaned = tokens.map(t => t.trim()).filter(t => t.length > 1);

      cleaned.slice(0, 100).forEach((t, idx) => {
        docItems.push({
          type: 'cell',
          text: t,
          tableIdx: 0,
          rowIdx: Math.floor(idx / 2),
          colIdx: idx % 2
        });
      });
    } catch (e) {
      console.warn('Doc item extraction error:', e.message);
    }
  }

  // Define target labels based on template type
  const targetLabels = tmpl.type === 'cert'
    ? ['Inst. SN.', 'Customer', 'Date:', 'Instrument', 'Analyzer pv ppm', 'Sensor']
    : ['主设备', '传感器', '序号', '名称', '规格', '数量', '备注'];

  const matchResults = {};
  targetLabels.forEach(lbl => {
    matchResults[lbl] = findFieldCandidates(lbl, docItems);
  });

  res.json({
    template: {
      ...tmpl,
      field_mappings: JSON.parse(tmpl.field_mappings || '{}')
    },
    docItemsCount: docItems.length,
    targetLabels,
    matchResults
  });
});

app.post('/api/templates/match-candidates', (req, res) => {
  const { targetLabel, docItems = [] } = req.body;
  if (!targetLabel) return res.status(400).json({ error: 'targetLabel required' });

  const result = findFieldCandidates(targetLabel, docItems);
  res.json(result);
});

app.post('/api/templates/publish', requireAdminAccess, (req, res) => {
  const { id, model, type, filename, fieldMappings, version = 'v1.0' } = req.body;
  if (!model || !type || !filename) return res.status(400).json({ error: 'Missing required parameters' });

  const tmplId = id || `tmpl_${model.toLowerCase()}_${type}`;
  const now = new Date().toISOString();
  const mappingsJson = JSON.stringify(fieldMappings || {});

  db.prepare(`
    INSERT INTO templates (id, model, type, filename, filepath, file_hash, version, field_mappings, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      filename = excluded.filename,
      version = excluded.version,
      field_mappings = excluded.field_mappings,
      published_at = excluded.published_at
  `).run(tmplId, model, type, filename, filename, 'hash_' + Date.now(), version, mappingsJson, now);

  logAudit(null, 'ADMIN', 'System', 'PUBLISH_TEMPLATE', { tmplId, model, type, version });
  res.json({ success: true, tmplId, version });
});

// ==================== C09, C10: TASK SUBMISSION & DEDUPLICATION ====================
app.post('/api/tasks/submit', (req, res) => {
  const {
    reqId,
    clientId,
    clientName,
    workerId,
    model,
    deviceSn,
    shippingLocation = '南京',
    sensorModel = 'PSR-12-223(封装）',
    sensorSn = '201N200258',
    hasPump = true,
    certDate,
    testPoints = [],
    packingItems = [],
    overwriteConfirmed = false
  } = req.body;

  if (!reqId || !clientId || !model || !deviceSn) {
    return res.status(400).json({ error: 'Missing required task submission fields' });
  }

  // R09: Check if request ID already exists for deduplication
  const existingTask = db.prepare('SELECT * FROM tasks WHERE req_id = ?').get(reqId);
  if (existingTask) {
    const files = db.prepare('SELECT * FROM task_files WHERE task_id = ?').all(existingTask.id).map(f => ({
      ...f,
      preview_images: JSON.parse(f.preview_images || '[]')
    }));
    return res.json({
      deduplicated: true,
      task: {
        ...existingTask,
        form_data: JSON.parse(existingTask.form_data || '{}'),
        files
      }
    });
  }

  // Assign worker
  let assignedWorkerId = workerId;
  if (!assignedWorkerId) {
    const onlineWorker = db.prepare("SELECT id FROM workers WHERE status = 'ONLINE' ORDER BY last_heartbeat DESC LIMIT 1").get();
    assignedWorkerId = onlineWorker ? onlineWorker.id : 'worker-local';
  }

  const acceptedAt = new Date().toISOString();
  const formData = JSON.stringify({
    shippingLocation,
    sensorModel,
    sensorSn,
    hasPump,
    certDate,
    testPoints,
    packingItems,
    overwriteConfirmed
  });

  // Insert task record
  const result = db.prepare(`
    INSERT INTO tasks (req_id, client_id, client_name, worker_id, model, device_sn, status, accepted_at, form_data)
    VALUES (?, ?, ?, ?, ?, ?, 'QUEUED', ?, ?)
  `).run(reqId, clientId, clientName, assignedWorkerId, model, deviceSn, acceptedAt, formData);

  const taskId = result.lastInsertRowid;

  // Generate official filenames using Naming Engine (C07, T07-T11)
  const certOfficialName = generateCertFilename({
    model,
    deviceSn,
    acceptedDate: acceptedAt,
    shippingLocation,
    sensorModel,
    hasPump
  });

  const packingOfficialName = generatePackingListFilename({
    model,
    deviceSn,
    acceptedDate: acceptedAt,
    hasPump
  });

  // Insert initial task files records
  db.prepare(`
    INSERT INTO task_files (task_id, file_type, official_filename, status)
    VALUES (?, 'cert', ?, 'GENERATING')
  `).run(taskId, certOfficialName);

  db.prepare(`
    INSERT INTO task_files (task_id, file_type, official_filename, status)
    VALUES (?, 'packing', ?, 'GENERATING')
  `).run(taskId, packingOfficialName);

  logAudit(reqId, clientId, clientName, 'SUBMIT_TASK', { taskId, model, deviceSn, assignedWorkerId, certOfficialName, packingOfficialName });

  const files = db.prepare('SELECT * FROM task_files WHERE task_id = ?').all(taskId).map(f => ({
    ...f,
    preview_images: JSON.parse(f.preview_images || '[]')
  }));

  const createdTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);

  res.json({
    success: true,
    task: {
      ...createdTask,
      form_data: JSON.parse(createdTask.form_data || '{}'),
      files
    }
  });
});

// ==================== HISTORY & TASK DETAILS ====================
app.get('/api/tasks', (req, res) => {
  const { range = 'today', clientId, status } = req.query;
  const { start, end } = getBeijingCalendarRange(range);

  let query = 'SELECT * FROM tasks WHERE accepted_at >= ? AND accepted_at <= ?';
  const params = [start.toISOString(), end.toISOString()];

  if (clientId) {
    query += ' AND client_id = ?';
    params.push(clientId);
  }
  if (status) {
    query += ' AND status = ?';
    params.push(status);
  }

  query += ' ORDER BY id DESC';

  const tasks = db.prepare(query).all(...params).map(task => ({
    ...task,
    form_data: JSON.parse(task.form_data || '{}'),
    files: db.prepare('SELECT * FROM task_files WHERE task_id = ?').all(task.id).map(f => ({
      ...f,
      preview_images: JSON.parse(f.preview_images || '[]')
    }))
  }));

  res.json(tasks);
});

app.get('/api/tasks/:id', (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const files = db.prepare('SELECT * FROM task_files WHERE task_id = ?').all(task.id).map(f => ({
    ...f,
    preview_images: JSON.parse(f.preview_images || '[]')
  }));

  res.json({
    ...task,
    form_data: JSON.parse(task.form_data || '{}'),
    files
  });
});

// Task official Word document download (C11, R21)
app.get('/api/tasks/:id/files/:fileType/download', (req, res) => {
  const { id, fileType } = req.params;
  const taskFile = db.prepare('SELECT * FROM task_files WHERE task_id = ? AND file_type = ?').get(id, fileType);
  if (!taskFile || !taskFile.server_filepath || !fs.existsSync(taskFile.server_filepath)) {
    return res.status(404).json({ error: 'File not ready or not found' });
  }

  res.download(taskFile.server_filepath, taskFile.official_filename);
});

// ==================== M12, C12: CANCEL & RETRY ====================
app.post('/api/tasks/:id/cancel', (req, res) => {
  const { id } = req.params;
  const { cancelledBy = 'User' } = req.body;

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  db.prepare("UPDATE tasks SET status = 'CANCELLED', cancelled_by = ? WHERE id = ?").run(cancelledBy, id);
  db.prepare("UPDATE task_files SET status = 'CANCELLED' WHERE task_id = ? AND status IN ('GENERATING','GENERATED','RETURNED')").run(id);

  logAudit(task.req_id, task.client_id, task.client_name, 'CANCEL_TASK', { taskId: id, cancelledBy });
  res.json({ success: true, taskId: id, status: 'CANCELLED' });
});

app.post('/api/tasks/:id/retry', (req, res) => {
  const { id } = req.params;
  const { confirmedResolved = false, operatorName = 'User' } = req.body;

  if (!confirmedResolved) {
    return res.status(400).json({ error: 'Must confirm problem resolution before retry (R28)' });
  }

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  db.prepare("UPDATE tasks SET status = 'QUEUED', retry_count = retry_count + 1 WHERE id = ?").run(id);
  db.prepare("UPDATE task_files SET status = 'GENERATING' WHERE task_id = ? AND status = 'FAILED'").run(id);

  logAudit(task.req_id, task.client_id, operatorName, 'RETRY_TASK', { taskId: id });
  res.json({ success: true, taskId: id, status: 'QUEUED' });
});

// ==================== C10, C11, E08: WORKER TASK DISTRIBUTION & RETURN ====================
app.get('/api/worker/tasks/pending', (req, res) => {
  const { workerId } = req.query;
  let query = "SELECT * FROM tasks WHERE status = 'QUEUED'";
  const params = [];
  if (workerId) {
    query += " AND (worker_id = ? OR worker_id IS NULL OR worker_id = 'worker-local' OR worker_id = 'worker-e2e')";
    params.push(workerId);
  }
  query += ' ORDER BY id ASC LIMIT 5';

  const pendingTasks = db.prepare(query).all(...params).map(task => ({
    ...task,
    form_data: JSON.parse(task.form_data || '{}'),
    files: db.prepare('SELECT * FROM task_files WHERE task_id = ?').all(task.id)
  }));

  res.json(pendingTasks);
});

app.post('/api/worker/tasks/:id/file-returned', upload.single('wordFile'), (req, res) => {
  const taskId = req.params.id;
  const { fileType, officialFilename, sha256 } = req.body;

  if (!req.file) return res.status(400).json({ error: 'No wordFile uploaded' });

  const destPath = path.join(returnedDir, `${taskId}_${fileType}_${req.file.originalname}`);
  fs.renameSync(req.file.path, destPath);

  // Load Task Details for Preview Generation (C11, R21, R22)
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  let previews = [];
  try {
    previews = generateDocumentPreview(destPath, previewDir, `${taskId}_${fileType}`, {
      task,
      fileType,
      officialFilename
    });
  } catch (err) {
    console.error('Preview error:', err);
  }

  // Update task file record
  db.prepare(`
    UPDATE task_files
    SET server_filepath = ?, sha256 = ?, preview_images = ?, status = 'PREVIEW_READY'
    WHERE task_id = ? AND file_type = ?
  `).run(destPath, sha256 || getFileSha256(destPath), JSON.stringify(previews), taskId, fileType);

  // Check if all sub-files for task are ready
  const files = db.prepare('SELECT * FROM task_files WHERE task_id = ?').all(taskId);
  const allReady = files.every(f => f.status === 'PREVIEW_READY' || f.status === 'PRINTED');

  if (allReady) {
    db.prepare("UPDATE tasks SET status = 'SUCCESS', completed_at = ? WHERE id = ?").run(new Date().toISOString(), taskId);
  } else {
    db.prepare("UPDATE tasks SET status = 'IN_PROGRESS' WHERE id = ?").run(taskId);
  }

  logAudit(null, 'WORKER', 'WorkerService', 'FILE_RETURNED', { taskId, fileType, officialFilename, previews });
  res.json({ success: true, taskId, fileType, previews });
});

// ==================== C10, M11, E09: PRINT JOBS ====================
app.post('/api/print/submit', (req, res) => {
  const { clientId, workerId = 'worker-local', printerName = '', batchItems = [] } = req.body;
  if (!clientId || !batchItems.length) {
    return res.status(400).json({ error: 'clientId and batchItems required' });
  }

  const createdAt = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO print_jobs (client_id, worker_id, printer_name, batch_items, status, created_at)
    VALUES (?, ?, ?, ?, 'QUEUED', ?)
  `).run(clientId, workerId, printerName, JSON.stringify(batchItems), createdAt);

  logAudit(null, clientId, 'User', 'SUBMIT_PRINT_JOB', { printJobId: result.lastInsertRowid, printerName, batchItems });
  res.json({ success: true, printJobId: result.lastInsertRowid, status: 'QUEUED' });
});

app.get('/api/print/pending', (req, res) => {
  const { workerId } = req.query;
  let query = "SELECT * FROM print_jobs WHERE status = 'QUEUED'";
  const params = [];
  if (workerId) {
    query += " AND (worker_id = ? OR worker_id = 'worker-local' OR worker_id = 'worker-e2e')";
    params.push(workerId);
  }
  query += ' ORDER BY id ASC LIMIT 5';

  const jobs = db.prepare(query).all(...params).map(j => ({
    ...j,
    batch_items: JSON.parse(j.batch_items || '[]')
  }));

  res.json(jobs);
});

app.post('/api/print/:id/status', (req, res) => {
  const { id } = req.params;
  const { status, errorMsg } = req.body; // status: 'SUBMITTED_TO_QUEUE' or 'PRINTED' or 'FAILED'

  db.prepare('UPDATE print_jobs SET status = ? WHERE id = ?').run(status, id);
  logAudit(null, 'WORKER', 'PrintWorker', 'UPDATE_PRINT_STATUS', { printJobId: id, status, errorMsg });
  res.json({ success: true, printJobId: id, status });
});

// ==================== C13, R33: AUDIT LOGS ====================
app.get('/api/audit-logs', (req, res) => {
  const logs = db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 100').all().map(l => ({
    ...l,
    details: JSON.parse(l.details || '{}')
  }));
  res.json(logs);
});

// Start Server if run directly
if (require.main === module) {
  app.listen(PORT, () => {
    console.log('====================================================');
    console.log('协调服务 (Coordination Service) 启动成功！');
    console.log('====================================================');
    console.log(`- 服务端口: ${PORT}`);
    console.log(`- 协调管理控制台 (仅限协调服务电脑本机): http://localhost:${PORT}/admin`);
    console.log(`- 手机端发货作业地址 (车间局域网操作): http://<你的局域网IP>:${PORT}/frontend`);
    console.log(`- 数据存储目录: ${path.join(__dirname, '../../data')}`);
    console.log('====================================================');
    console.log('等待手机端/前端连接，以及执行端 (worker.js) 上线...');
  });
}

module.exports = app;
