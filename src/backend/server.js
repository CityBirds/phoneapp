const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const { generateCertFilename, generatePackingListFilename } = require('../common/naming');
const { findFieldCandidates, inferFieldType } = require('../common/matcher');
const { extractDocumentStructure } = require('../common/doc_structure');
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

// Helper to fix Multer filename encoding
function fixMulterFilename(filename) {
  if (!filename) return '';
  try {
    const latin1Buf = Buffer.from(filename, 'latin1');
    const utf8Str = latin1Buf.toString('utf8');
    if (!utf8Str.includes('\ufffd') && utf8Str !== filename) {
      return utf8Str;
    }
  } catch (e) {}
  return filename;
}

// Security Middleware: Restrict coordinator management operations strictly to localhost IP
function isLocalhostRequest(req) {
  const remoteIp = req.socket?.remoteAddress || req.connection?.remoteAddress || req.ip || '';
  const isLoopback = remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1';
  return isLoopback;
}

function requireAdminAccess(req, res, next) {
  if (!isLocalhostRequest(req)) {
    return res.status(403).json({
      error: '权限受限：该管理功能（修改手机端名字、上传模板、发布配置等）仅限在协调服务电脑本机操作 (C01, C03)'
    });
  }
  next();
}

// Audit Logger Helper
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

// Model Alias Resolver
function resolveModelAlias(inputModel) {
  if (!inputModel) return { modelId: 'model_unknown', displayName: 'UNKNOWN' };
  const str = String(inputModel).trim();

  // Search in database models table first
  const dbModels = db.prepare('SELECT * FROM models').all();
  for (const m of dbModels) {
    const aliases = JSON.parse(m.aliases || '[]');
    if (m.display_name.toUpperCase() === str.toUpperCase() || aliases.some(a => a.toUpperCase() === str.toUpperCase())) {
      return { modelId: m.id, displayName: m.display_name };
    }
  }

  // Default hardcoded alias resolution fallback
  const upper = str.toUpperCase();
  if (upper === 'POA200' || upper.includes('POA')) {
    return { modelId: 'model_poa200', displayName: 'POA200' };
  }
  if (upper === 'DPT810' || upper.includes('810')) {
    return { modelId: 'model_dpt810', displayName: 'DPT810' };
  }
  if (upper === '990' || upper === '990-EX' || upper === 'DPT-990-EX' || upper.includes('990')) {
    return { modelId: 'model_990', displayName: '990' };
  }

  return { modelId: `model_${upper.toLowerCase()}`, displayName: upper };
}

// Three-in-One Template Validation Helper
function validateTemplateThreeInOne(tmpl) {
  if (!tmpl || !tmpl.filepath || !tmpl.file_hash) {
    return { valid: false, reason: '模板记录不存在或结构为空' };
  }
  if (!fs.existsSync(tmpl.filepath)) {
    return { valid: false, reason: `磁盘物理文件缺失: ${tmpl.filepath}` };
  }
  const currentHash = getFileSha256(tmpl.filepath);
  if (!currentHash || currentHash !== tmpl.file_hash) {
    return { valid: false, reason: `模板文件 SHA256 哈希校验不匹配 (${currentHash} vs ${tmpl.file_hash})` };
  }
  let mappings = {};
  try {
    mappings = typeof tmpl.field_mappings === 'string' ? JSON.parse(tmpl.field_mappings || '{}') : (tmpl.field_mappings || {});
  } catch (e) {
    return { valid: false, reason: 'field_mappings JSON 解析错误' };
  }

  const singleFields = Array.isArray(mappings.singleFields) ? mappings.singleFields : [];
  const unbound = singleFields.filter(f => f.status === 'unbound');
  if (unbound.length > 0) {
    return { valid: false, reason: `存在未绑定写回字段: ${unbound.map(u => u.label).join(', ')}` };
  }

  return { valid: true, mappings };
}

// Dynamic Document Combo Builder for Model
function syncPublishedBundlesForModel(modelName) {
  const resolved = resolveModelAlias(modelName);
  const mName = resolved.displayName;

  const allTemplates = db.prepare("SELECT * FROM templates WHERE model = ?").all(mName);
  
  const validCertTmpls = [];
  const validPackTmpls = [];

  allTemplates.forEach(tmpl => {
    const v = validateTemplateThreeInOne(tmpl);
    if (v.valid) {
      if (tmpl.type === 'cert') validCertTmpls.push({ ...tmpl, mappings: v.mappings });
      if (tmpl.type === 'packing') validPackTmpls.push({ ...tmpl, mappings: v.mappings });
    }
  });

  const now = new Date().toISOString();

  if (validCertTmpls.length === 0 && validPackTmpls.length === 0) {
    db.prepare("UPDATE published_bundles SET status = 'UNAVAILABLE' WHERE model_id = ?").run(resolved.modelId);
    return;
  }

  const generatedBundleIds = new Set();

  if (validCertTmpls.length > 0 && validPackTmpls.length > 0) {
    validCertTmpls.forEach(certTmpl => {
      validPackTmpls.forEach(packTmpl => {
        const bundleId = `bundle_${mName.toLowerCase()}_full`;
        const optionName = mName === 'POA200' ? '带泵' : '带清单';
        const configSnapshot = {
          model: mName,
          docCombo: 'cert_and_packing',
          certTemplate: { ...certTmpl, field_mappings: certTmpl.mappings },
          packingTemplate: { ...packTmpl, field_mappings: packTmpl.mappings },
          testPoints: certTmpl.mappings.testPoints || [],
          packingItems: packTmpl.mappings.packingItems || [],
          sensorModelConfig: certTmpl.mappings.sensorModelConfig || {}
        };

        db.prepare(`
          INSERT INTO published_bundles (id, bundle_id, version, model_id, model_display, option_name, doc_combo, cert_template_id, packing_template_id, status, published_at, config_snapshot)
          VALUES (?, ?, ?, ?, ?, ?, 'cert_and_packing', ?, ?, 'PUBLISHED', ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            bundle_id = excluded.bundle_id,
            version = excluded.version,
            model_id = excluded.model_id,
            model_display = excluded.model_display,
            option_name = excluded.option_name,
            doc_combo = excluded.doc_combo,
            cert_template_id = excluded.cert_template_id,
            packing_template_id = excluded.packing_template_id,
            status = 'PUBLISHED',
            published_at = excluded.published_at,
            config_snapshot = excluded.config_snapshot
        `).run(bundleId, bundleId, certTmpl.version || 'v1.0', resolved.modelId, mName, optionName, certTmpl.id, packTmpl.id, now, JSON.stringify(configSnapshot));

        generatedBundleIds.add(bundleId);
      });
    });
  } else if (validCertTmpls.length > 0) {
    validCertTmpls.forEach(certTmpl => {
      const bundleId = `bundle_${mName.toLowerCase()}_cert`;
      const optionName = '仅证书';
      const configSnapshot = {
        model: mName,
        docCombo: 'cert_only',
        certTemplate: { ...certTmpl, field_mappings: certTmpl.mappings },
        packingTemplate: null,
        testPoints: certTmpl.mappings.testPoints || [],
        packingItems: [],
        sensorModelConfig: certTmpl.mappings.sensorModelConfig || {}
      };

      db.prepare(`
        INSERT INTO published_bundles (id, bundle_id, version, model_id, model_display, option_name, doc_combo, cert_template_id, packing_template_id, status, published_at, config_snapshot)
        VALUES (?, ?, ?, ?, ?, ?, 'cert_only', ?, NULL, 'PUBLISHED', ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          bundle_id = excluded.bundle_id,
          version = excluded.version,
          model_id = excluded.model_id,
          model_display = excluded.model_display,
          option_name = excluded.option_name,
          doc_combo = excluded.doc_combo,
          cert_template_id = excluded.cert_template_id,
          packing_template_id = excluded.packing_template_id,
          status = 'PUBLISHED',
          published_at = excluded.published_at,
          config_snapshot = excluded.config_snapshot
      `).run(bundleId, bundleId, certTmpl.version || 'v1.0', resolved.modelId, mName, optionName, certTmpl.id, now, JSON.stringify(configSnapshot));

      generatedBundleIds.add(bundleId);
    });
  } else if (validPackTmpls.length > 0) {
    validPackTmpls.forEach(packTmpl => {
      const bundleId = `bundle_${mName.toLowerCase()}_pack`;
      const optionName = '仅清单';
      const configSnapshot = {
        model: mName,
        docCombo: 'packing_only',
        certTemplate: null,
        packingTemplate: { ...packTmpl, field_mappings: packTmpl.mappings },
        testPoints: [],
        packingItems: packTmpl.mappings.packingItems || [],
        sensorModelConfig: {}
      };

      db.prepare(`
        INSERT INTO published_bundles (id, bundle_id, version, model_id, model_display, option_name, doc_combo, cert_template_id, packing_template_id, status, published_at, config_snapshot)
        VALUES (?, ?, ?, ?, ?, ?, 'packing_only', NULL, ?, 'PUBLISHED', ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          bundle_id = excluded.bundle_id,
          version = excluded.version,
          model_id = excluded.model_id,
          model_display = excluded.model_display,
          option_name = excluded.option_name,
          doc_combo = excluded.doc_combo,
          cert_template_id = excluded.cert_template_id,
          packing_template_id = excluded.packing_template_id,
          status = 'PUBLISHED',
          published_at = excluded.published_at,
          config_snapshot = excluded.config_snapshot
      `).run(bundleId, bundleId, packTmpl.version || 'v1.0', resolved.modelId, mName, optionName, packTmpl.id, now, JSON.stringify(configSnapshot));

      generatedBundleIds.add(bundleId);
    });
  }

  const modelBundles = db.prepare("SELECT * FROM published_bundles WHERE model_id = ?").all(resolved.modelId);
  modelBundles.forEach(b => {
    if (!generatedBundleIds.has(b.id)) {
      db.prepare("UPDATE published_bundles SET status = 'UNAVAILABLE' WHERE id = ?").run(b.id);
    }
  });
}

function syncPublishedBundlesAll() {
  const models = db.prepare("SELECT DISTINCT model FROM templates").all().map(r => r.model);
  models.forEach(m => syncPublishedBundlesForModel(m));
}

// Seed Default Models and Templates dynamically
function seedDefaultTemplates() {
  const now = new Date().toISOString();

  // 1. Seed Models
  db.prepare(`
    INSERT OR IGNORE INTO models (id, display_name, aliases, created_at)
    VALUES (?, ?, ?, ?)
  `).run('model_poa200', 'POA200', JSON.stringify(['POA200', 'POA-200']), now);

  db.prepare(`
    INSERT OR IGNORE INTO models (id, display_name, aliases, created_at)
    VALUES (?, ?, ?, ?)
  `).run('model_dpt810', 'DPT810', JSON.stringify(['DPT810', 'DPT-810']), now);

  db.prepare(`
    INSERT OR IGNORE INTO models (id, display_name, aliases, created_at)
    VALUES (?, ?, ?, ?)
  `).run('model_990', '990', JSON.stringify(['990', '990-Ex', 'DPT-990-EX']), now);

  // 2. Seed Templates
  const samplesDir = path.join(__dirname, '../../samples');
  if (fs.existsSync(samplesDir)) {
    const poaCertPath = path.join(samplesDir, 'POA200证书AP10007513-20260403发南京订单-PSR-12-223(封装）带泵.doc');
    const poaPackPath = path.join(samplesDir, 'POA200(140)AP10007513发货清单20260403带泵.doc');
    const dptCertPath = path.join(samplesDir, 'DPT810证书(变送器-A010007031)-JM-26.8.28.doc');
    const cert990Path = path.join(samplesDir, '990-Ex-EX10260902发货证书.doc');
    const pack990Path = path.join(samplesDir, '990-Ex-EX10260902装箱清单.doc');

    if (fs.existsSync(poaCertPath)) {
      db.prepare(`
        INSERT INTO templates (id, model, type, filename, filepath, file_hash, version, field_mappings, published_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          file_hash = excluded.file_hash,
          field_mappings = excluded.field_mappings
      `).run('tmpl_poa200_cert', 'POA200', 'cert', path.basename(poaCertPath), poaCertPath, getFileSha256(poaCertPath) || 'hash_poa_cert', 'v1.0', JSON.stringify({
        singleFields: [
          { label: 'Inst. SN.', status: 'bound' },
          { label: 'Ambient Temperature:', status: 'bound' },
          { label: 'Relative Humidity', status: 'bound' },
          { label: 'Date:', status: 'bound' }
        ],
        sensorModelConfig: { options: ['PSR-12-223(封装）', 'PMT210SEN'], defaultValue: 'PSR-12-223(封装）' },
        testPoints: [
          { point: 1, std: '9.96 ppm (N2 balance)' }
        ]
      }), now);
    }

    if (fs.existsSync(poaPackPath)) {
      db.prepare(`
        INSERT INTO templates (id, model, type, filename, filepath, file_hash, version, field_mappings, published_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          file_hash = excluded.file_hash,
          field_mappings = excluded.field_mappings
      `).run('tmpl_poa200_pack', 'POA200', 'packing', path.basename(poaPackPath), poaPackPath, getFileSha256(poaPackPath) || 'hash_poa_pack', 'v1.0', JSON.stringify({
        protectedRows: [1, 2],
        packingItems: [
          { index: 1, name: '主设备', spec: 'POA200', count: 1, unit: '台', standard: '是', remark: 'SN: AP10007513带泵', isProtected: true },
          { index: 2, name: '传感器', spec: 'PMT210SEN', count: 1, unit: '支', standard: '是', remark: 'SN: 201N200258', isProtected: true },
          { index: 3, name: '仪器包装箱', spec: 'ABS', count: 1, unit: '个', standard: '是', remark: '' },
          { index: 4, name: '用户手册', spec: '中英文', count: 1, unit: '份', standard: '是', remark: '' },
          { index: 5, name: '出厂合格证', spec: '中英文', count: 1, unit: '份', standard: '是', remark: '' },
          { index: 6, name: '电源适配器', spec: '902B', count: 1, unit: '个', standard: '是', remark: '' },
          { index: 7, name: 'USB通讯线', spec: '标准', count: 1, unit: '根', standard: '是', remark: '' },
          { index: 8, name: '标定指示卡', spec: '标准', count: 1, unit: '张', standard: '是', remark: '' },
          { index: 9, name: 'F46测试管', spec: '外径1/8英寸', count: 1, unit: '根', standard: '是', remark: '' }
        ]
      }), now);
    }

    if (fs.existsSync(dptCertPath)) {
      db.prepare(`
        INSERT INTO templates (id, model, type, filename, filepath, file_hash, version, field_mappings, published_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          file_hash = excluded.file_hash,
          field_mappings = excluded.field_mappings
      `).run('tmpl_dpt810_cert', 'DPT810', 'cert', path.basename(dptCertPath), dptCertPath, getFileSha256(dptCertPath) || 'hash_dpt_cert', 'v1.0', JSON.stringify({
        singleFields: [
          { label: 'Inst. SN.', status: 'bound' },
          { label: 'Ambient Temperature:', status: 'bound' },
          { label: 'Relative Humidity', status: 'bound' },
          { label: 'Date:', status: 'bound' }
        ],
        testPoints: [
          { point: 1, std: '-89.00 ℃ dp' },
          { point: 2, std: '-80.12 ℃ dp' },
          { point: 3, std: '-70.81 ℃ dp' },
          { point: 4, std: '-60.23 ℃ dp' },
          { point: 5, std: '-50.82 ℃ dp' },
          { point: 6, std: '-40.91 ℃ dp' },
          { point: 7, std: '-30.45 ℃ dp' },
          { point: 8, std: '-21.90 ℃ dp' },
          { point: 9, std: '-12.26 ℃ dp' },
          { point: 10, std: '10.25 ℃ dp' }
        ]
      }), now);
    }

    if (fs.existsSync(cert990Path)) {
      db.prepare(`
        INSERT INTO templates (id, model, type, filename, filepath, file_hash, version, field_mappings, published_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          file_hash = excluded.file_hash,
          field_mappings = excluded.field_mappings
      `).run('tmpl_990_cert', '990', 'cert', path.basename(cert990Path), cert990Path, getFileSha256(cert990Path) || 'hash_990_cert', 'v1.0', JSON.stringify({
        singleFields: [
          { label: 'Inst. SN.', status: 'bound' },
          { label: 'Date:', status: 'bound' },
          { label: 'Instrument', status: 'bound' },
          { label: 'Ambient Temperature:', status: 'bound' },
          { label: 'Relative Humidity', status: 'bound' }
        ],
        testPoints: [
          { point: 1, std: '-80.75 ℃ dp' },
          { point: 2, std: '-70.95 ℃ dp' },
          { point: 3, std: '-60.42 ℃ dp' },
          { point: 4, std: '-52.43 ℃ dp' },
          { point: 5, std: '-42.15 ℃ dp' },
          { point: 6, std: '-31.76 ℃ dp' },
          { point: 7, std: '-21.24 ℃ dp' },
          { point: 8, std: '-12.56 ℃ dp' },
          { point: 9, std: '12.19 ℃ dp' }
        ]
      }), now);
    }

    if (fs.existsSync(pack990Path)) {
      db.prepare(`
        INSERT INTO templates (id, model, type, filename, filepath, file_hash, version, field_mappings, published_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          file_hash = excluded.file_hash,
          field_mappings = excluded.field_mappings
      `).run('tmpl_990_pack', '990', 'packing', path.basename(pack990Path), pack990Path, getFileSha256(pack990Path) || 'hash_990_pack', 'v1.0', JSON.stringify({
        protectedRows: [1],
        packingItems: [
          { index: 1, name: '主设备', spec: 'DPT-990-Ex', count: 1, unit: '台', standard: '是', remark: 'SN: EX10260902', isProtected: true },
          { index: 2, name: '计量证书', spec: '英文', count: 1, unit: '份', standard: '是', remark: '' },
          { index: 3, name: '用户手册', spec: '中英文', count: 1, unit: '本', standard: '是', remark: '' },
          { index: 4, name: '操作说明', spec: '中英文', count: 1, unit: '份', standard: '是', remark: '' },
          { index: 5, name: '防爆证书', spec: '英文', count: 1, unit: '份', standard: '是', remark: '' },
          { index: 6, name: '安装螺钉', spec: 'M3*8', count: 4, unit: '个', standard: '是', remark: '' },
          { index: 7, name: '干燥装置', spec: 'DPT-990-Ex', count: 1, unit: '套', standard: '是', remark: '' },
          { index: 8, name: '堵头', spec: '1/8NPT', count: 1, unit: '个', standard: '是', remark: '' },
          { index: 9, name: '卡套螺母组', spec: '1/8”', count: 2, unit: '组', standard: '是', remark: '' },
          { index: 10, name: '防爆电缆接头', spec: 'M12*1.5', count: 1, unit: '个', standard: '是', remark: '' },
          { index: 11, name: '电源/信号线', spec: '2米', count: 1, unit: '根', standard: '是', remark: '' }
        ]
      }), now);
    }

    // Dynamic bundle calculation from real templates
    syncPublishedBundlesAll();
  }
}
seedDefaultTemplates();

// ==================== CLIENT MANAGEMENT ====================
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

// ==================== WORKER & PRINTER MONITORING ====================
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
    const isOnline = (now - lastTime) < 15000;
    let printersList = [];
    try { printersList = JSON.parse(w.printers || '[]'); } catch (e) {}

    const printerDetails = printersList.map(p => {
      const pName = typeof p === 'string' ? p : p.name;
      const isShared = (printerUsage[pName] || 0) > 1;
      const pLower = pName.toLowerCase();
      const isVirtual = pLower.includes('pdf') || pLower.includes('onenote') || pLower.includes('fax') || pLower.includes('xps') || pName.includes('导出');
      return {
        name: pName,
        isShared,
        isVirtual,
        type: isVirtual ? 'virtual' : (isShared ? 'shared_physical' : 'local_physical')
      };
    });

    return {
      ...w,
      status: isOnline ? (w.status && w.status !== 'ONLINE' ? w.status : 'ONLINE') : 'OFFLINE',
      printers: printersList,
      printerDetails
    };
  });

  if (!showAll) {
    return res.json(workers.filter(w => w.status !== 'OFFLINE'));
  }

  res.json(workers);
});

// ==================== PUBLISHED BUNDLES & MODELS ====================
app.get('/api/published-bundles', (req, res) => {
  const rawBundles = db.prepare("SELECT * FROM published_bundles WHERE status = 'PUBLISHED' ORDER BY id ASC").all();
  const validBundles = [];

  rawBundles.forEach(b => {
    const certTmpl = b.cert_template_id ? db.prepare('SELECT * FROM templates WHERE id = ?').get(b.cert_template_id) : null;
    const packTmpl = b.packing_template_id ? db.prepare('SELECT * FROM templates WHERE id = ?').get(b.packing_template_id) : null;

    let certValid = true;
    let packValid = true;

    if (b.doc_combo === 'cert_and_packing' || b.doc_combo === 'cert_only') {
      const v = validateTemplateThreeInOne(certTmpl);
      if (!v.valid) certValid = false;
    }
    if (b.doc_combo === 'cert_and_packing' || b.doc_combo === 'packing_only') {
      const v = validateTemplateThreeInOne(packTmpl);
      if (!v.valid) packValid = false;
    }

    if (!certValid || !packValid) {
      db.prepare("UPDATE published_bundles SET status = 'UNAVAILABLE' WHERE id = ?").run(b.id);
      return;
    }

    let configSnapshot = {};
    try { configSnapshot = JSON.parse(b.config_snapshot || '{}'); } catch (e) {}

    validBundles.push({
      ...b,
      config_snapshot: configSnapshot,
      certTemplate: certTmpl ? { ...certTmpl, field_mappings: JSON.parse(certTmpl.field_mappings || '{}') } : null,
      packingTemplate: packTmpl ? { ...packTmpl, field_mappings: JSON.parse(packTmpl.field_mappings || '{}') } : null
    });
  });

  res.json(validBundles);
});

app.get('/api/models', (req, res) => {
  const models = db.prepare('SELECT * FROM models ORDER BY id ASC').all().map(m => ({
    ...m,
    aliases: JSON.parse(m.aliases || '[]')
  }));
  res.json(models);
});

// ==================== TEMPLATES & ASSISTANCE ====================
app.get('/api/templates', (req, res) => {
  const tmpls = db.prepare('SELECT * FROM templates ORDER BY published_at DESC').all().map(t => ({
    ...t,
    field_mappings: JSON.parse(t.field_mappings || '{}')
  }));
  res.json(tmpls);
});

app.post('/api/templates/upload', requireAdminAccess, upload.single('templateFile'), (req, res) => {
  const { model, type, version = 'v1.0' } = req.body;
  if (!req.file || !model || !type) {
    return res.status(400).json({ error: 'templateFile, model, and type are required' });
  }

  const resolved = resolveModelAlias(model);
  const originalName = fixMulterFilename(req.file.originalname);
  const tmplId = `tmpl_${resolved.displayName.toLowerCase()}_${type}_${Date.now()}`;
  const destPath = path.join(uploadDir, `${tmplId}_${originalName}`);

  try {
    fs.renameSync(req.file.path, destPath);
    const sha256 = getFileSha256(destPath);
    const now = new Date().toISOString();

    db.prepare(`
      INSERT OR IGNORE INTO templates (id, model, type, filename, filepath, file_hash, version, field_mappings, published_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?)
    `).run(tmplId, resolved.displayName, type, originalName, destPath, sha256, version, now);

    logAudit(null, 'ADMIN', 'Admin', 'UPLOAD_TEMPLATE', { tmplId, model: resolved.displayName, type, originalName, sha256 });
    res.json({ success: true, tmplId, model: resolved.displayName, type, filename: originalName, sha256, version });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save template file: ' + err.message });
  }
});

app.get('/api/templates/:id/download', (req, res) => {
  const tmpl = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
  if (!tmpl || !fs.existsSync(tmpl.filepath)) {
    return res.status(404).json({ error: 'Template file not found' });
  }
  res.download(tmpl.filepath, tmpl.filename);
});

app.delete('/api/templates/:id', requireAdminAccess, (req, res) => {
  const tmpl = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
  if (!tmpl) return res.status(404).json({ error: 'Template not found' });

  db.prepare('DELETE FROM templates WHERE id = ?').run(req.params.id);
  if (fs.existsSync(tmpl.filepath)) {
    try { fs.unlinkSync(tmpl.filepath); } catch (e) {}
  }

  syncPublishedBundlesForModel(tmpl.model);

  logAudit(null, 'ADMIN', 'Admin', 'DELETE_TEMPLATE', { id: req.params.id });
  res.json({ success: true, id: req.params.id });
});

app.get('/api/templates/:id/analyze', (req, res) => {
  const tmpl = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
  if (!tmpl) return res.status(404).json({ error: 'Template not found' });

  let docItems = [];
  if (fs.existsSync(tmpl.filepath)) {
    try {
      docItems = extractDocumentStructure(tmpl.filepath);
    } catch (e) {
      console.warn('Doc item extraction error:', e.message);
    }
  }

  let targetLabels = [];
  if (tmpl.type === 'cert') {
    if (tmpl.model === '990') {
      targetLabels = ['Inst. SN.', 'Instrument', 'Date:', 'Ambient Temperature:', 'Relative Humidity', 'Test point Number', 'NIST Traceable Standard ℃ dp', 'Analyzer ℃ dp'];
    } else if (tmpl.model === 'DPT810') {
      targetLabels = ['Inst. SN.', 'Instrument', 'Date:', 'Ambient Temperature:', 'Relative Humidity', 'Analyzer Under Test mA'];
    } else {
      targetLabels = ['Inst. SN.', 'Instrument', 'Date:', 'Ambient Temperature:', 'Relative Humidity', 'Analyzer pv ppm'];
    }
  } else {
    targetLabels = ['主设备', '传感器', '序号', '名称', '规格', '数量', '备注'];
  }

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
    matchResults,
    docItems
  });
});

app.post('/api/templates/match-candidates', (req, res) => {
  const { targetLabel, docItems = [] } = req.body;
  if (!targetLabel) return res.status(400).json({ error: 'targetLabel required' });

  const result = findFieldCandidates(targetLabel, docItems);
  res.json(result);
});

app.post('/api/templates/publish', requireAdminAccess, (req, res) => {
  const { id, model, type, filename, fieldMappings, version = 'v1.0', isDraft = false } = req.body;
  if (!model || !type || !filename) return res.status(400).json({ error: 'Missing required parameters' });

  let existingTmpl = id ? db.prepare('SELECT * FROM templates WHERE id = ?').get(id) : null;
  if (!existingTmpl) {
    existingTmpl = db.prepare('SELECT * FROM templates WHERE model = ? AND type = ?').get(model, type);
  }

  const filePath = existingTmpl ? existingTmpl.filepath : path.join(uploadDir, filename);

  if (!isDraft) {
    const mappings = fieldMappings || {};
    const singleFields = Array.isArray(mappings.singleFields) ? mappings.singleFields : [];
    const unbound = singleFields.filter(f => f.status === 'unbound');
    if (unbound.length > 0) {
      return res.status(400).json({
        error: `存在未绑定字段 (${unbound.map(u => u.label).join(', ')})，不能正式发布！请先完成字段绑定或保存为草稿。`
      });
    }

    // Three-in-One Check
    if (!fs.existsSync(filePath) && !existingTmpl) {
      return res.status(400).json({ error: `无法发布：物理文件在磁盘上不存在 (${filePath})` });
    }
    if (fs.existsSync(filePath) && existingTmpl && existingTmpl.file_hash) {
      const currentHash = getFileSha256(filePath);
      if (currentHash !== existingTmpl.file_hash) {
        return res.status(400).json({ error: `无法发布：模板文件 SHA256 哈希校验失败 (磁盘 ${currentHash} vs 数据库 ${existingTmpl.file_hash})` });
      }
    }
  }

  const tmplId = id || (existingTmpl ? existingTmpl.id : `tmpl_${model.toLowerCase()}_${type}`);
  const now = new Date().toISOString();
  const fileHash = getFileSha256(filePath) || (existingTmpl ? existingTmpl.file_hash : 'hash_' + Date.now());

  const mergedMappings = { ...(existingTmpl && existingTmpl.field_mappings ? JSON.parse(existingTmpl.field_mappings) : {}), ...fieldMappings };

  db.prepare(`
    INSERT INTO templates (id, model, type, filename, filepath, file_hash, version, field_mappings, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      filename = excluded.filename,
      filepath = excluded.filepath,
      file_hash = excluded.file_hash,
      version = excluded.version,
      field_mappings = excluded.field_mappings,
      published_at = excluded.published_at
  `).run(tmplId, model, type, filename, filePath, fileHash, version, JSON.stringify(mergedMappings), now);

  syncPublishedBundlesForModel(model);

  logAudit(null, 'ADMIN', 'System', 'PUBLISH_TEMPLATE', { tmplId, model, type, version, isDraft });
  res.json({ success: true, tmplId, version });
});

// ==================== TASK SUBMISSION & DEDUPLICATION ====================
app.post('/api/tasks/submit', (req, res) => {
  const {
    reqId,
    clientId,
    clientName,
    workerId,
    model,
    bundleId,
    docCombo,
    deviceSn,
    shippingLocation = '南京',
    sensorModel,
    sensorSn,
    hasPump = true,
    certDate,
    testPoints = [],
    packingItems = [],
    overwriteConfirmed = false
  } = req.body;

  if (!reqId || !clientId || !model || !deviceSn) {
    return res.status(400).json({ error: 'Missing required task submission fields' });
  }

  // Check deduplication
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

  // Resolve Model Alias
  const resolvedModel = resolveModelAlias(model);

  // Validate Worker is ONLINE
  if (!workerId) {
    return res.status(400).json({ error: '请指定调度的执行终端 (workerId)' });
  }

  const targetWorker = db.prepare("SELECT * FROM workers WHERE id = ?").get(workerId);
  const nowMs = Date.now();
  const lastTimeMs = targetWorker && targetWorker.last_heartbeat ? new Date(targetWorker.last_heartbeat).getTime() : 0;
  const isWorkerOnline = targetWorker && (nowMs - lastTimeMs) < 15000;

  if (!isWorkerOnline) {
    return res.status(400).json({
      error: `执行终端 [${workerId}] 当前不在线或心跳超时，拒绝受理任务！(J01, Q03)`
    });
  }

  // F10: Sensor Model validation for non-POA200 models
  if (resolvedModel.displayName !== 'POA200') {
    if (sensorModel && String(sensorModel).trim() !== '') {
      return res.status(400).json({
        error: `非 POA200 型号 (${resolvedModel.displayName}) 严禁提交 sensorModel 传感器参数！(F10)`
      });
    }
  } else {
    try {
      const tmpl = db.prepare("SELECT * FROM templates WHERE model = 'POA200' AND type = 'cert'").get();
      if (tmpl && tmpl.field_mappings) {
        const mappings = JSON.parse(tmpl.field_mappings);
        const options = mappings.sensorModelConfig?.options || [];
        if (options.length > 0 && sensorModel) {
          if (!options.includes(sensorModel)) {
            return res.status(400).json({
              error: `传感器型号 [${sensorModel}] 不属于已发布的有效选项列表 (${options.join(', ')})！(F10)`
            });
          }
        }
      }
    } catch (e) {}
  }

  // J05: Validate Device Serial Number consistency across packing list if present
  if (Array.isArray(packingItems) && packingItems.length > 0) {
    const mainRemark = packingItems[0].remark || '';
    const match = mainRemark.match(/SN[:：]\s*([A-Za-z0-9_-]+)/i);
    if (match && match[1] && match[1] !== deviceSn) {
      return res.status(400).json({
        error: `设备序列号数据冲突：顶层序列号 (${deviceSn}) 与清单主设备序列号 (${match[1]}) 不一致！(J05, Q13)`
      });
    }
  }

  // Find Published Bundle Configuration
  let bundle = null;
  if (bundleId) {
    bundle = db.prepare('SELECT * FROM published_bundles WHERE bundle_id = ? AND status = \'PUBLISHED\'').get(bundleId);
  }
  if (!bundle) {
    bundle = db.prepare('SELECT * FROM published_bundles WHERE model_id = ? AND status = \'PUBLISHED\'').get(resolvedModel.modelId);
  }

  // Determine doc combo (cert_and_packing, cert_only, packing_only)
  const effectiveCombo = docCombo || (bundle ? bundle.doc_combo : (resolvedModel.displayName === 'POA200' ? 'cert_and_packing' : 'cert_only'));
  const createCert = effectiveCombo === 'cert_and_packing' || effectiveCombo === 'cert_only';
  const createPacking = effectiveCombo === 'cert_and_packing' || effectiveCombo === 'packing_only';

  const ambientTemp = (req.body.ambientTemp !== undefined && req.body.ambientTemp !== null && req.body.ambientTemp !== '') ? String(req.body.ambientTemp) : '22.1';
  const relativeHumidity = (req.body.relativeHumidity !== undefined && req.body.relativeHumidity !== null && req.body.relativeHumidity !== '') ? String(req.body.relativeHumidity) : '50%RH';

  const acceptedAt = new Date().toISOString();
  const formData = JSON.stringify({
    shippingLocation,
    sensorModel: resolvedModel.displayName === 'POA200' ? sensorModel : undefined,
    sensorSn: resolvedModel.displayName === 'POA200' ? sensorSn : undefined,
    ambientTemp,
    relativeHumidity,
    hasPump: resolvedModel.displayName === 'POA200' ? hasPump : false,
    certDate,
    testPoints,
    packingItems: createPacking ? packingItems : [],
    overwriteConfirmed
  });

  const result = db.prepare(`
    INSERT INTO tasks (req_id, client_id, client_name, worker_id, model, model_id, bundle_id, device_sn, status, accepted_at, form_data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?, ?)
  `).run(reqId, clientId, clientName, workerId, resolvedModel.displayName, resolvedModel.modelId, bundleId || (bundle ? bundle.bundle_id : null), String(deviceSn), acceptedAt, formData);

  const taskId = result.lastInsertRowid;

  // Create Task Files
  if (createCert) {
    const certOfficialName = generateCertFilename({
      model: resolvedModel.displayName,
      deviceSn: String(deviceSn),
      acceptedDate: acceptedAt,
      shippingLocation,
      sensorModel: resolvedModel.displayName === 'POA200' ? sensorModel : undefined,
      hasPump: resolvedModel.displayName === 'POA200' ? hasPump : false
    });

    db.prepare(`
      INSERT INTO task_files (task_id, file_type, official_filename, status)
      VALUES (?, 'cert', ?, 'GENERATING')
    `).run(taskId, certOfficialName);
  }

  if (createPacking) {
    const packingOfficialName = generatePackingListFilename({
      model: resolvedModel.displayName,
      deviceSn: String(deviceSn),
      acceptedDate: acceptedAt,
      hasPump: resolvedModel.displayName === 'POA200' ? hasPump : false
    });

    db.prepare(`
      INSERT INTO task_files (task_id, file_type, official_filename, status)
      VALUES (?, 'packing', ?, 'GENERATING')
    `).run(taskId, packingOfficialName);
  }

  logAudit(reqId, clientId, clientName, 'SUBMIT_TASK', { taskId, model: resolvedModel.displayName, deviceSn, workerId });

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

app.get('/api/tasks/:id/files/:fileType/download', (req, res) => {
  const { id, fileType } = req.params;
  const taskFile = db.prepare('SELECT * FROM task_files WHERE task_id = ? AND file_type = ?').get(id, fileType);
  if (!taskFile || !taskFile.server_filepath || !fs.existsSync(taskFile.server_filepath)) {
    return res.status(404).json({ error: 'File not ready or not found' });
  }

  res.download(taskFile.server_filepath, taskFile.official_filename);
});

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

// ==================== WORKER TASK DISTRIBUTION & RETURN ====================
app.get('/api/worker/tasks/pending', (req, res) => {
  const { workerId = 'worker-local' } = req.query;

  db.exec('BEGIN IMMEDIATE');
  try {
    const task = db.prepare(`
      SELECT * FROM tasks
      WHERE status = 'QUEUED' AND (worker_id = ? OR worker_id IS NULL OR worker_id = 'worker-local' OR worker_id = 'worker-e2e')
      ORDER BY id ASC LIMIT 1
    `).get(workerId);

    if (task) {
      db.prepare("UPDATE tasks SET status = 'IN_PROGRESS', worker_id = ? WHERE id = ?").run(workerId, task.id);
      db.exec('COMMIT');

      const files = db.prepare('SELECT * FROM task_files WHERE task_id = ?').all(task.id);
      return res.json([{
        ...task,
        form_data: JSON.parse(task.form_data || '{}'),
        files
      }]);
    }
    db.exec('COMMIT');
    res.json([]);
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (e) {}
    res.json([]);
  }
});

app.post('/api/worker/tasks/:id/file-failed', (req, res) => {
  const taskId = req.params.id;
  const { fileType, errorMsg } = req.body;

  db.prepare(`
    UPDATE task_files SET status = 'FAILED', error_msg = ? WHERE task_id = ? AND file_type = ?
  `).run(errorMsg || 'Generation failed', taskId, fileType);

  db.prepare("UPDATE tasks SET status = 'FAILED', error_msg = ? WHERE id = ?").run(errorMsg || 'Generation failed', taskId);

  logAudit(null, 'WORKER', 'WorkerService', 'FILE_FAILED', { taskId, fileType, errorMsg });
  res.json({ success: true, taskId, fileType });
});

app.post('/api/worker/tasks/:id/file-returned', upload.single('wordFile'), (req, res) => {
  const taskId = req.params.id;
  const { fileType, officialFilename, sha256 } = req.body;

  if (!req.file) return res.status(400).json({ error: 'No wordFile uploaded' });

  const destPath = path.join(returnedDir, `${taskId}_${fileType}_${req.file.originalname}`);
  fs.renameSync(req.file.path, destPath);

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

  db.prepare(`
    UPDATE task_files
    SET server_filepath = ?, sha256 = ?, preview_images = ?, status = 'PREVIEW_READY'
    WHERE task_id = ? AND file_type = ?
  `).run(destPath, sha256 || getFileSha256(destPath), JSON.stringify(previews), taskId, fileType);

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

// ==================== PRINT JOBS ====================
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
  const { status, errorMsg } = req.body;

  db.prepare('UPDATE print_jobs SET status = ? WHERE id = ?').run(status, id);
  logAudit(null, 'WORKER', 'PrintWorker', 'UPDATE_PRINT_STATUS', { printJobId: id, status, errorMsg });
  res.json({ success: true, printJobId: id, status });
});

// ==================== AUDIT LOGS ====================
app.get('/api/audit-logs', (req, res) => {
  const logs = db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 100').all().map(l => ({
    ...l,
    details: JSON.parse(l.details || '{}')
  }));
  res.json(logs);
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log('====================================================');
    console.log('协调服务 (Coordination Service) 启动成功！');
    console.log('====================================================');
    console.log(`- 服务端口: ${PORT}`);
    console.log(`- 关键 API 路由已就绪:`);
    console.log(`  * GET  /api/published-bundles (获取已发布型号与文档组合配置)`);
    console.log(`  * POST /api/tasks/submit       (任务提交与重复校验)`);
    console.log(`  * GET  /api/workers            (执行终端心跳与状态列表)`);
    console.log(`  * POST /api/templates/publish  (模板三合一严格校验与动态组合生成)`);
    console.log(`- 协调管理控制台 (仅限协调服务电脑本机): http://localhost:${PORT}/admin`);
    console.log(`- 手机端发货作业地址 (车间局域网操作): http://<局域网IP>:${PORT}/frontend`);
    console.log(`- 数据存储目录: ${path.join(__dirname, '../../data')}`);
    console.log('====================================================');
    console.log('等待手机端/前端连接，以及执行端 (worker.js) 上线...');
  });
}

module.exports = app;
module.exports.isLocalhostRequest = isLocalhostRequest;
module.exports.resolveModelAlias = resolveModelAlias;
