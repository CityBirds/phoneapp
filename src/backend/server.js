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

  if (tmpl.type === 'cert') {
    const tc = mappings.tableConfig;
    const tps = Array.isArray(mappings.testPoints) ? mappings.testPoints : [];
    const hasValidTableConfig = tc &&
      ((typeof tc.standardCol === 'number') || (tc.standardCol && typeof tc.standardCol.colIdx === 'number')) &&
      ((typeof tc.actualCol === 'number') || (tc.actualCol && typeof tc.actualCol.colIdx === 'number')) &&
      typeof tc.startRow === 'number' &&
      typeof tc.endRow === 'number' &&
      tc.endRow >= tc.startRow;
    const hasValidTestPoints = tps.length > 0;
    if (!hasValidTableConfig && !hasValidTestPoints) {
      return { valid: false, reason: '证书模板缺少有效测量点表格区（标准值列/实测值列/数据范围）' };
    }
  }

  return { valid: true, mappings };
}

// Dynamic Document Combo Builder for Model
function syncPublishedBundlesForModel(modelName) {
  const resolved = resolveModelAlias(modelName);
  const mName = resolved.displayName;

  const allTemplates = db.prepare("SELECT * FROM templates WHERE model = ? AND published_at IS NOT NULL").all(mName);
  
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
  try {
    const { id } = req.params;
    const { name } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: '客户端姓名不能为空' });
    }
    const cleanName = name.trim();
    const existing = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: '客户端不存在' });

    db.prepare('UPDATE clients SET name = ? WHERE id = ?').run(cleanName, id);
    logAudit(null, id, cleanName, 'RENAME_CLIENT', { id, oldName: existing.name, newName: cleanName });
    res.json({ success: true, id, name: cleanName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
// Helper: Check path containment strictly without prefix bug (DIR-13, WC-08)
function isSubpath(parent, child) {
  if (!parent || !child) return false;
  const normParent = path.resolve(parent);
  const normChild = path.resolve(child);
  const pLower = process.platform === 'win32' ? normParent.toLowerCase() : normParent;
  const cLower = process.platform === 'win32' ? normChild.toLowerCase() : normChild;
  if (pLower === cLower) return true;
  const rel = path.relative(normParent, normChild);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Helper: Check whether targetPath is within worker's authorized paths (E04, WC-07, WC-08)
function isPathInWorkerAllowedPaths(workerId, targetPath, requireWrite = true, strict = false) {
  const allowed = db.prepare('SELECT * FROM worker_allowed_paths WHERE worker_id = ?').all(workerId);
  if (allowed.length === 0) {
    if (strict) {
      return { allowed: false, reason: `执行端尚未配置任何允许访问的业务路径 (E04)` };
    }
    return { allowed: true, isLegacy: true };
  }
  for (const ap of allowed) {
    if (requireWrite && !ap.allow_write) continue;
    if (isSubpath(ap.root_path, targetPath)) {
      return { allowed: true, allowedPath: ap.root_path };
    }
  }
  return { allowed: false, reason: `保存根目录 [${targetPath}] 未包含在执行端允许${requireWrite ? '写入' : '访问'}的业务路径范围内 (E04, WC-08)` };
}

app.get('/api/published-bundles', (req, res) => {
  const { workerId } = req.query;
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

    // When workerId is specified, filter by worker enablement and determine effective docCombo (Section 5, WC-11, WC-12)
    if (workerId) {
      const certCfg = certTmpl ? db.prepare('SELECT * FROM worker_save_configs WHERE worker_id = ? AND template_id = ? AND doc_type = ?').get(workerId, certTmpl.id, 'cert') : null;
      const packCfg = packTmpl ? db.prepare('SELECT * FROM worker_save_configs WHERE worker_id = ? AND template_id = ? AND doc_type = ?').get(workerId, packTmpl.id, 'packing') : null;

      const certEnabled = certCfg && Boolean(certCfg.is_enabled);
      const packEnabled = packCfg && Boolean(packCfg.is_enabled);

      let effectiveCombo = null;
      if (certEnabled && packEnabled) effectiveCombo = 'cert_and_packing';
      else if (certEnabled) effectiveCombo = 'cert_only';
      else if (packEnabled) effectiveCombo = 'packing_only';
      else {
        // Neither enabled -> Model not visible on this worker (WC-11, Section 5)
        return;
      }

      // Check readiness of enabled templates (WC-13, Section 5)
      let isReady = true;
      const unreadyReasons = [];

      if (effectiveCombo === 'cert_and_packing' || effectiveCombo === 'cert_only') {
        if (!certCfg || !certCfg.root_dir) {
          isReady = false;
          unreadyReasons.push('缺少证书模板保存目录配置');
        } else if (certCfg.check_status !== 'PASSED') {
          isReady = false;
          unreadyReasons.push(`证书保存目录检查未通过(${certCfg.check_status}: ${certCfg.check_message || '待检查'})`);
        } else {
          const authCheck = isPathInWorkerAllowedPaths(workerId, certCfg.root_dir, true);
          if (!authCheck.allowed) {
            isReady = false;
            unreadyReasons.push(authCheck.reason);
          }
        }
      }

      if (effectiveCombo === 'cert_and_packing' || effectiveCombo === 'packing_only') {
        if (!packCfg || !packCfg.root_dir) {
          isReady = false;
          unreadyReasons.push('缺少装箱清单模板保存目录配置');
        } else if (packCfg.check_status !== 'PASSED') {
          isReady = false;
          unreadyReasons.push(`清单保存目录检查未通过(${packCfg.check_status}: ${packCfg.check_message || '待检查'})`);
        } else {
          const authCheck = isPathInWorkerAllowedPaths(workerId, packCfg.root_dir, true);
          if (!authCheck.allowed) {
            isReady = false;
            unreadyReasons.push(authCheck.reason);
          }
        }
      }

      validBundles.push({
        ...b,
        doc_combo: effectiveCombo,
        is_ready: isReady,
        unready_reason: unreadyReasons.join('; '),
        config_snapshot: configSnapshot,
        certTemplate: configSnapshot.certTemplate || (certTmpl ? { ...certTmpl, field_mappings: JSON.parse(certTmpl.field_mappings || '{}') } : null),
        packingTemplate: configSnapshot.packingTemplate || (packTmpl ? { ...packTmpl, field_mappings: JSON.parse(packTmpl.field_mappings || '{}') } : null)
      });
    } else {
      validBundles.push({
        ...b,
        is_ready: true,
        config_snapshot: configSnapshot,
        certTemplate: configSnapshot.certTemplate || (certTmpl ? { ...certTmpl, field_mappings: JSON.parse(certTmpl.field_mappings || '{}') } : null),
        packingTemplate: configSnapshot.packingTemplate || (packTmpl ? { ...packTmpl, field_mappings: JSON.parse(packTmpl.field_mappings || '{}') } : null)
      });
    }
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
    field_mappings: JSON.parse(t.draft_mappings || t.field_mappings || '{}'),
    is_draft: !!t.draft_mappings
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
      targetLabels = ['Inst. SN.', 'Instrument', 'Date:', 'Ambient Temperature:', 'Relative Humidity', 'NIST Traceable Standard ℃ dp', 'Analyzer ℃ dp'];
    } else if (tmpl.model === 'DPT810') {
      targetLabels = ['Inst. SN.', 'Instrument', 'Date:', 'Ambient Temperature:', 'Relative Humidity', 'Analyzer Under Test mA'];
    } else {
      targetLabels = ['Inst. SN.', 'Instrument', 'Date:', 'Ambient Temperature:', 'Relative Humidity', 'Analyzer pv ppm'];
    }
  } else {
    targetLabels = ['主设备', '传感器', '名称', '规格', '数量', '备注'];
  }

  const matchResults = {};
  targetLabels.forEach(lbl => {
    matchResults[lbl] = findFieldCandidates(lbl, docItems);
  });

  res.json({
    template: {
      ...tmpl,
      field_mappings: JSON.parse(tmpl.draft_mappings || tmpl.field_mappings || '{}'),
      is_draft: !!tmpl.draft_mappings
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
  const existingMappings = existingTmpl && existingTmpl.field_mappings ? JSON.parse(existingTmpl.field_mappings) : {};
  const existingDraft = existingTmpl && existingTmpl.draft_mappings ? JSON.parse(existingTmpl.draft_mappings) : {};
  const baseMappings = isDraft ? { ...existingMappings, ...existingDraft } : existingMappings;
  const mergedMappings = { ...baseMappings, ...(fieldMappings || {}) };

  const tmplId = id || (existingTmpl ? existingTmpl.id : `tmpl_${model.toLowerCase()}_${type}`);
  const now = new Date().toISOString();
  const fileHash = getFileSha256(filePath) || (existingTmpl ? existingTmpl.file_hash : 'hash_' + Date.now());

  if (isDraft) {
    // Draft save: update draft_mappings only, isolate from field_mappings, published_at, and published_bundles
    const publishedAt = existingTmpl ? existingTmpl.published_at : null;
    const fieldMappingsJson = existingTmpl ? existingTmpl.field_mappings : '{}';

    db.prepare(`
      INSERT INTO templates (id, model, type, filename, filepath, file_hash, version, field_mappings, draft_mappings, published_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        filename = excluded.filename,
        filepath = excluded.filepath,
        file_hash = excluded.file_hash,
        version = excluded.version,
        draft_mappings = excluded.draft_mappings
    `).run(tmplId, model, type, filename, filePath, fileHash, version, fieldMappingsJson, JSON.stringify(mergedMappings), publishedAt);

    logAudit(null, 'ADMIN', 'System', 'SAVE_DRAFT_TEMPLATE', { tmplId, model, type, version, isDraft: true });
    return res.json({ success: true, tmplId, version, isDraft: true });
  }

  // Formal Publication Validations
  const singleFields = Array.isArray(mergedMappings.singleFields) ? mergedMappings.singleFields : [];
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

  // Measurement Table Check for formal publish of certificates
  if (type === 'cert') {
    const tc = mergedMappings.tableConfig;
    const tps = Array.isArray(mergedMappings.testPoints) ? mergedMappings.testPoints : [];
    const hasValidTableConfig = tc &&
      ((typeof tc.standardCol === 'number') || (tc.standardCol && typeof tc.standardCol.colIdx === 'number')) &&
      ((typeof tc.actualCol === 'number') || (tc.actualCol && typeof tc.actualCol.colIdx === 'number')) &&
      typeof tc.startRow === 'number' &&
      typeof tc.endRow === 'number' &&
      tc.endRow >= tc.startRow;
    const hasValidTestPoints = tps.length > 0;
    if (!hasValidTableConfig && !hasValidTestPoints) {
      return res.status(400).json({
        error: '无法发布：证书模板缺少有效测量点表格区（标准值列、实测值列或数据行范围），请完成表格绑定或保存为草稿。'
      });
    }
  }

  // Formal publish: update field_mappings, clear draft_mappings, set published_at
  db.prepare(`
    INSERT INTO templates (id, model, type, filename, filepath, file_hash, version, field_mappings, draft_mappings, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(id) DO UPDATE SET
      filename = excluded.filename,
      filepath = excluded.filepath,
      file_hash = excluded.file_hash,
      version = excluded.version,
      field_mappings = excluded.field_mappings,
      draft_mappings = NULL,
      published_at = excluded.published_at
  `).run(tmplId, model, type, filename, filePath, fileHash, version, JSON.stringify(mergedMappings), now);

  syncPublishedBundlesForModel(model);

  logAudit(null, 'ADMIN', 'System', 'PUBLISH_TEMPLATE', { tmplId, model, type, version, isDraft: false });
  res.json({ success: true, tmplId, version, isDraft: false });
});


// ==================== WORKER SAVE DIRECTORY CENTRALIZED MANAGEMENT ====================

// --- 1. Allowed Business Paths APIs (E02, E04, 4.2) ---
app.get('/api/admin/workers/:workerId/allowed-paths', (req, res) => {
  const { workerId } = req.params;
  const paths = db.prepare('SELECT * FROM worker_allowed_paths WHERE worker_id = ? ORDER BY id ASC').all(workerId);
  res.json(paths);
});

app.post('/api/admin/workers/:workerId/allowed-paths', requireAdminAccess, (req, res) => {
  try {
    const { workerId } = req.params;
    const { id, rootPath, allowRead = true, allowWrite = true, allowCreate = false } = req.body;
    if (!rootPath || typeof rootPath !== 'string' || !rootPath.trim()) {
      return res.status(400).json({ error: '业务路径不能为空' });
    }
    const cleanPath = rootPath.trim();
    const isAbs = path.isAbsolute(cleanPath) || /^[a-zA-Z]:[\\/]/.test(cleanPath);
    if (!isAbs) {
      return res.status(400).json({ error: `必须是合法的绝对路径: ${cleanPath}` });
    }
    if (/[<>"|?*]/.test(cleanPath.replace(/^[a-zA-Z]:/, ''))) {
      return res.status(400).json({ error: `路径包含系统非法字符: ${cleanPath}` });
    }

    const now = new Date().toISOString();
    const allowReadInt = allowRead ? 1 : 0;
    const allowWriteInt = allowWrite ? 1 : 0;
    const allowCreateInt = allowCreate ? 1 : 0;

    let pathId = id;
    let version = 1;
    let existing = id ? db.prepare('SELECT * FROM worker_allowed_paths WHERE id = ?').get(id) :
                        db.prepare('SELECT * FROM worker_allowed_paths WHERE worker_id = ? AND root_path = ?').get(workerId, cleanPath);

    if (existing) {
      pathId = existing.id;
      version = (existing.version || 1) + 1;
      db.prepare(`
        UPDATE worker_allowed_paths
        SET root_path = ?, allow_read = ?, allow_write = ?, allow_create = ?, version = ?,
            sync_status = 'PENDING', check_status = 'PENDING',
            check_message = '配置已更新，待同步并检查', checked_at = NULL, updated_at = ?
        WHERE id = ?
      `).run(cleanPath, allowReadInt, allowWriteInt, allowCreateInt, version, now, existing.id);
    } else {
      const ins = db.prepare(`
        INSERT INTO worker_allowed_paths (
          worker_id, root_path, allow_read, allow_write, allow_create, version,
          sync_status, check_status, check_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, 'PENDING', 'PENDING', '待检查', ?, ?)
      `).run(workerId, cleanPath, allowReadInt, allowWriteInt, allowCreateInt, now, now);
      pathId = ins.lastInsertRowid;
    }

    // Queue check if worker is online
    const worker = db.prepare('SELECT * FROM workers WHERE id = ?').get(workerId);
    const isOnline = worker && worker.last_heartbeat && (Date.now() - new Date(worker.last_heartbeat).getTime() < 15000);
    if (isOnline) {
      try {
        db.prepare(`
          INSERT INTO worker_directory_checks (check_type, target_id, worker_id, version, root_dir, allow_create, allow_read, allow_write, status, created_at)
          VALUES ('allowed_path', ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)
        `).run(pathId, workerId, version, cleanPath, allowCreateInt, allowReadInt, allowWriteInt, now);
        db.prepare("UPDATE worker_allowed_paths SET check_status = 'CHECKING', check_message = '正在请求执行端检查...' WHERE id = ?").run(pathId);
      } catch (chkErr) {
        console.error('Failed to queue directory check task:', chkErr);
        db.prepare("UPDATE worker_allowed_paths SET check_status = 'FAILED', check_message = ? WHERE id = ?").run(`检查任务创建失败: ${chkErr.message}`, pathId);
      }
    }

    const saved = db.prepare('SELECT * FROM worker_allowed_paths WHERE id = ?').get(pathId);
    res.json({ success: true, allowedPath: saved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/workers/:workerId/allowed-paths/:id', requireAdminAccess, (req, res) => {
  const { workerId, id } = req.params;
  const ap = db.prepare('SELECT * FROM worker_allowed_paths WHERE id = ? AND worker_id = ?').get(id, workerId);
  if (!ap) return res.status(404).json({ error: '业务路径不存在' });

  db.prepare('DELETE FROM worker_allowed_paths WHERE id = ?').run(id);
  db.prepare("DELETE FROM worker_directory_checks WHERE check_type = 'allowed_path' AND target_id = ?").run(id);

  // Invalidate affected save configs (Section 4.2)
  const configs = db.prepare('SELECT * FROM worker_save_configs WHERE worker_id = ?').all(workerId);
  for (const c of configs) {
    if (isSubpath(ap.root_path, c.root_dir)) {
      db.prepare(`
        UPDATE worker_save_configs
        SET check_status = 'PENDING', check_message = '关联的授权业务路径已删除，需重新配置或检查',
            version = version + 1, updated_at = ?
        WHERE id = ?
      `).run(new Date().toISOString(), c.id);
    }
  }
  res.json({ success: true });
});

app.post('/api/admin/workers/:workerId/allowed-paths/:id/check', requireAdminAccess, (req, res) => {
  try {
    const { workerId, id } = req.params;
    const ap = db.prepare('SELECT * FROM worker_allowed_paths WHERE id = ? AND worker_id = ?').get(id, workerId);
    if (!ap) return res.status(404).json({ error: '业务路径不存在' });

    const worker = db.prepare('SELECT * FROM workers WHERE id = ?').get(workerId);
    const isOnline = worker && worker.last_heartbeat && (Date.now() - new Date(worker.last_heartbeat).getTime() < 15000);

    if (!isOnline) {
      db.prepare(`
        UPDATE worker_allowed_paths
        SET check_status = 'PENDING', check_message = '执行端当前离线，待上线后检查 (DIR-08)'
        WHERE id = ?
      `).run(id);
      return res.status(400).json({ success: false, offline: true, error: `执行端 [${worker ? worker.name : workerId}] 当前离线，无法进行探测 (DIR-08)` });
    }

    try {
      db.prepare(`
        INSERT INTO worker_directory_checks (check_type, target_id, worker_id, version, root_dir, allow_create, allow_read, allow_write, status, created_at)
        VALUES ('allowed_path', ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)
      `).run(ap.id, workerId, ap.version, ap.root_path, ap.allow_create || 0, ap.allow_read || 1, ap.allow_write || 1, new Date().toISOString());

      db.prepare("UPDATE worker_allowed_paths SET check_status = 'CHECKING', check_message = '正在请求执行端检查...' WHERE id = ?").run(id);
      res.json({ success: true, message: '检查请求已下发' });
    } catch (chkErr) {
      console.error('Failed to create directory check task:', chkErr);
      db.prepare("UPDATE worker_allowed_paths SET check_status = 'FAILED', check_message = ? WHERE id = ?").run(`检查任务创建失败: ${chkErr.message}`, id);
      return res.status(500).json({ success: false, error: `检查任务创建失败: ${chkErr.message}` });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- 2. Template Configs & Enablement per Worker (E03, 4.3) ---
app.get('/api/admin/workers/:workerId/template-configs', (req, res) => {
  const { workerId } = req.params;
  const tmpls = db.prepare("SELECT * FROM templates ORDER BY model ASC, type ASC").all();
  const configs = db.prepare("SELECT * FROM worker_save_configs WHERE worker_id = ?").all(workerId);
  const map = new Map();
  configs.forEach(c => map.set(`${c.template_id}_${c.doc_type}`, c));

  const result = tmpls.map(t => {
    const cfg = map.get(`${t.id}_${t.type}`);
    return {
      template_id: t.id,
      model: t.model,
      doc_type: t.type,
      filename: t.filename,
      config_id: cfg ? cfg.id : null,
      is_enabled: cfg ? (cfg.is_enabled || 0) : 0,
      root_dir: cfg ? (cfg.root_dir || '') : '',
      save_mode: cfg ? (cfg.save_mode || 'direct') : 'direct',
      subfolder_rule: cfg ? (cfg.subfolder_rule || 'deviceSn') : 'deviceSn',
      allow_create: cfg ? (cfg.allow_create || 0) : 0,
      version: cfg ? cfg.version : 1,
      check_status: cfg ? cfg.check_status : 'PENDING',
      check_message: cfg ? (cfg.check_message || '未配置') : '未配置',
      checked_at: cfg ? cfg.checked_at : null
    };
  });
  res.json(result);
});

app.post('/api/admin/workers/:workerId/template-configs', requireAdminAccess, (req, res) => {
  const { workerId } = req.params;
  const {
    id,
    templateId,
    docType,
    isEnabled = 0,
    rootDir = '',
    saveMode = 'direct',
    subfolderRule = 'deviceSn',
    allowCreate = 0
  } = req.body;

  if (!templateId || !docType) {
    return res.status(400).json({ error: 'templateId 与 docType 为必填项' });
  }

  const cleanRootDir = (rootDir || '').trim();
  if (cleanRootDir) {
    const isAbs = path.isAbsolute(cleanRootDir) || /^[a-zA-Z]:[\\/]/.test(cleanRootDir);
    if (!isAbs) return res.status(400).json({ error: `保存根目录必须是合法的绝对路径: ${cleanRootDir}` });

    // Validate authorized write path boundary (E04, WC-08)
    const authCheck = isPathInWorkerAllowedPaths(workerId, cleanRootDir, true, true);
    if (!authCheck.allowed) {
      return res.status(400).json({ error: authCheck.reason });
    }
  }

  const now = new Date().toISOString();
  const isEnabledInt = isEnabled ? 1 : 0;
  const allowCreateInt = allowCreate ? 1 : 0;

  let existing = id ? db.prepare('SELECT * FROM worker_save_configs WHERE id = ?').get(id) :
                      db.prepare('SELECT * FROM worker_save_configs WHERE worker_id = ? AND template_id = ? AND doc_type = ?').get(workerId, templateId, docType);
  let configId;
  let version = 1;

  if (existing) {
    version = (existing.version || 1) + 1;
    db.prepare(`
      UPDATE worker_save_configs
      SET root_dir = ?, save_mode = ?, subfolder_rule = ?, allow_create = ?,
          is_enabled = ?, version = ?, check_status = 'PENDING',
          check_message = '配置已更新，待重新检查', checked_at = NULL, updated_at = ?
      WHERE id = ?
    `).run(cleanRootDir, saveMode, subfolderRule, allowCreateInt, isEnabledInt, version, now, existing.id);
    configId = existing.id;
  } else {
    const ins = db.prepare(`
      INSERT INTO worker_save_configs (
        worker_id, template_id, doc_type, root_dir, save_mode, subfolder_rule,
        allow_create, is_enabled, version, check_status, check_message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'PENDING', '待检查', ?, ?)
    `).run(workerId, templateId, docType, cleanRootDir, saveMode, subfolderRule, allowCreateInt, isEnabledInt, now, now);
    configId = ins.lastInsertRowid;
  }

  const worker = db.prepare('SELECT * FROM workers WHERE id = ?').get(workerId);
  const isOnline = worker && worker.last_heartbeat && (Date.now() - new Date(worker.last_heartbeat).getTime() < 15000);
  if (isOnline && cleanRootDir) {
    db.prepare(`
      INSERT INTO worker_directory_checks (check_type, target_id, config_id, worker_id, version, root_dir, allow_create, status, created_at)
      VALUES ('save_config', ?, ?, ?, ?, ?, ?, 'PENDING', ?)
    `).run(configId, configId, workerId, version, cleanRootDir, allowCreateInt, now);
  }

  const saved = db.prepare('SELECT * FROM worker_save_configs WHERE id = ?').get(configId);
  res.json({ success: true, config: saved });
});

app.post('/api/admin/workers/:workerId/template-configs/:id/check', requireAdminAccess, (req, res) => {
  const { workerId, id } = req.params;
  const config = db.prepare('SELECT * FROM worker_save_configs WHERE id = ? AND worker_id = ?').get(id, workerId);
  if (!config) return res.status(404).json({ error: '目录配置不存在' });

  const targetWorker = db.prepare('SELECT * FROM workers WHERE id = ?').get(workerId);
  const isOnline = targetWorker && targetWorker.last_heartbeat && (Date.now() - new Date(targetWorker.last_heartbeat).getTime() < 15000);

  if (!isOnline) {
    db.prepare(`
      UPDATE worker_save_configs
      SET check_status = 'PENDING', check_message = '执行端当前离线，待上线后检查 (DIR-08)'
      WHERE id = ?
    `).run(id);
    return res.status(400).json({
      success: false,
      offline: true,
      error: `执行端 [${targetWorker ? targetWorker.name : workerId}] 当前离线，无法进行探测 (DIR-08)`
    });
  }

  db.prepare("UPDATE worker_save_configs SET check_status = 'CHECKING', check_message = '正在请求执行端检查...' WHERE id = ?").run(id);
  db.prepare(`
    INSERT INTO worker_directory_checks (check_type, target_id, config_id, worker_id, version, root_dir, allow_create, status, created_at)
    VALUES ('save_config', ?, ?, ?, ?, ?, ?, 'PENDING', ?)
  `).run(config.id, config.id, workerId, config.version, config.root_dir, config.allow_create, new Date().toISOString());

  res.json({ success: true, message: '检查请求已下发至执行端' });
});

// --- 3. Backward Compatibility Endpoints for /api/admin/worker-directories ---
app.get('/api/admin/worker-directories', (req, res) => {
  const { workerId, templateId } = req.query;
  let query = `
    SELECT c.*,
           w.name as worker_name, w.status as worker_status,
           t.filename as template_filename, t.model as template_model
    FROM worker_save_configs c
    LEFT JOIN workers w ON c.worker_id = w.id
    LEFT JOIN templates t ON c.template_id = t.id
    WHERE 1=1
  `;
  const params = [];
  if (workerId) {
    query += ' AND c.worker_id = ?';
    params.push(workerId);
  }
  if (templateId) {
    query += ' AND c.template_id = ?';
    params.push(templateId);
  }
  query += ' ORDER BY c.id DESC';
  const list = db.prepare(query).all(...params);
  res.json(list);
});

app.post('/api/admin/worker-directories', requireAdminAccess, (req, res) => {
  const {
    id,
    workerId,
    templateId,
    docType,
    rootDir,
    saveMode = 'direct',
    subfolderRule = 'deviceSn',
    allowCreate = false,
    isEnabled = 1
  } = req.body;

  if (!workerId || !templateId || !docType || !rootDir) {
    return res.status(400).json({ error: '执行端 (workerId)、模板 (templateId)、文档类型 (docType) 和保存根目录 (rootDir) 为必填项！' });
  }

  const isAbs = path.isAbsolute(rootDir) || /^[a-zA-Z]:[\\/]/.test(rootDir);
  if (!isAbs) {
    return res.status(400).json({ error: `保存根目录必须是合法的绝对路径: ${rootDir}` });
  }

  // Validate allowed paths if configured
  const authCheck = isPathInWorkerAllowedPaths(workerId, rootDir, true);
  if (!authCheck.allowed) {
    return res.status(400).json({ error: authCheck.reason });
  }

  const now = new Date().toISOString();
  const allowCreateInt = allowCreate ? 1 : 0;
  const isEnabledInt = isEnabled ? 1 : 0;

  let existing = id ? db.prepare('SELECT * FROM worker_save_configs WHERE id = ?').get(id) :
                      db.prepare('SELECT * FROM worker_save_configs WHERE worker_id = ? AND template_id = ? AND doc_type = ?').get(workerId, templateId, docType);

  let configId;
  if (existing) {
    const newVersion = (existing.version || 1) + 1;
    db.prepare(`
      UPDATE worker_save_configs
      SET worker_id = ?, template_id = ?, doc_type = ?, root_dir = ?, save_mode = ?,
          subfolder_rule = ?, allow_create = ?, is_enabled = ?, version = ?, check_status = 'PENDING',
          check_message = '配置已更新，待重新检查', checked_at = NULL, updated_at = ?
      WHERE id = ?
    `).run(workerId, templateId, docType, rootDir, saveMode, subfolderRule, allowCreateInt, isEnabledInt, newVersion, now, existing.id);
    configId = existing.id;
  } else {
    const result = db.prepare(`
      INSERT INTO worker_save_configs (
        worker_id, template_id, doc_type, root_dir, save_mode, subfolder_rule,
        allow_create, is_enabled, version, check_status, check_message, checked_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'PENDING', '待检查', NULL, ?, ?)
    `).run(workerId, templateId, docType, rootDir, saveMode, subfolderRule, allowCreateInt, isEnabledInt, now, now);
    configId = result.lastInsertRowid;
  }

  const saved = db.prepare('SELECT * FROM worker_save_configs WHERE id = ?').get(configId);
  logAudit(null, 'ADMIN', 'System', 'SAVE_WORKER_DIRECTORY_CONFIG', { configId, workerId, templateId, docType, rootDir });
  res.json({ success: true, config: saved });
});

app.delete('/api/admin/worker-directories/:id', requireAdminAccess, (req, res) => {
  const { id } = req.params;
  db.prepare('DELETE FROM worker_save_configs WHERE id = ?').run(id);
  db.prepare('DELETE FROM worker_directory_checks WHERE config_id = ?').run(id);
  res.json({ success: true, id });
});

app.post('/api/admin/worker-directories/:id/check', requireAdminAccess, (req, res) => {
  const { id } = req.params;
  const config = db.prepare('SELECT * FROM worker_save_configs WHERE id = ?').get(id);
  if (!config) return res.status(404).json({ error: '目录配置不存在' });

  const targetWorker = db.prepare('SELECT * FROM workers WHERE id = ?').get(config.worker_id);
  const nowMs = Date.now();
  const lastTimeMs = targetWorker && targetWorker.last_heartbeat ? new Date(targetWorker.last_heartbeat).getTime() : 0;
  const isOnline = targetWorker && (nowMs - lastTimeMs) < 15000;

  if (!isOnline) {
    db.prepare(`
      UPDATE worker_save_configs
      SET check_status = 'PENDING', check_message = '执行端当前离线，待上线后检查 (DIR-08)'
      WHERE id = ?
    `).run(id);
    return res.status(400).json({
      success: false,
      offline: true,
      error: `执行端 [${targetWorker ? targetWorker.name : config.worker_id}] 当前离线，无法进行探测 (DIR-08)`
    });
  }

  db.prepare("UPDATE worker_save_configs SET check_status = 'CHECKING', check_message = '正在请求执行端检查...' WHERE id = ?").run(id);
  db.prepare(`
    INSERT INTO worker_directory_checks (check_type, target_id, config_id, worker_id, version, root_dir, allow_create, status, created_at)
    VALUES ('save_config', ?, ?, ?, ?, ?, ?, 'PENDING', ?)
  `).run(config.id, config.id, config.worker_id, config.version, config.root_dir, config.allow_create, new Date().toISOString());

  res.json({ success: true, message: '目录检查请求已下发至执行端' });
});

// --- 4. Worker Check Queue & Authorizations Sync ---
app.get('/api/worker/directory-checks/pending', (req, res) => {
  const { workerId = 'worker-local' } = req.query;
  const checks = db.prepare(`
    SELECT * FROM worker_directory_checks
    WHERE (worker_id = ? OR worker_id = 'worker-local') AND status = 'PENDING'
    ORDER BY id ASC
  `).all(workerId);
  res.json(checks);
});

app.post('/api/worker/directory-checks/result', (req, res) => {
  const { checkId, checkType = 'save_config', targetId, configId, version, status, message } = req.body;
  const finalId = targetId || configId;

  if (checkType === 'allowed_path') {
    const ap = db.prepare('SELECT * FROM worker_allowed_paths WHERE id = ?').get(finalId);
    if (ap && ap.version === version) {
      db.prepare(`
        UPDATE worker_allowed_paths
        SET check_status = ?, check_message = ?, sync_status = 'SYNCED', checked_at = ?
        WHERE id = ?
      `).run(status, message || '', new Date().toISOString(), finalId);
    }
  } else {
    const config = db.prepare('SELECT * FROM worker_save_configs WHERE id = ?').get(finalId);
    if (config && config.version === version) {
      db.prepare(`
        UPDATE worker_save_configs
        SET check_status = ?, check_message = ?, checked_at = ?
        WHERE id = ?
      `).run(status, message || '', new Date().toISOString(), finalId);
    }
  }

  if (checkId) {
    db.prepare("UPDATE worker_directory_checks SET status = 'DONE' WHERE id = ?").run(checkId);
  }
  res.json({ success: true });
});

app.get('/api/worker/authorizations', (req, res) => {
  const { workerId } = req.query;
  if (!workerId) return res.status(400).json({ error: '缺少 workerId' });
  const paths = db.prepare('SELECT id, root_path, allow_read, allow_write, version FROM worker_allowed_paths WHERE worker_id = ?').all(workerId);
  res.json({ workerId, allowedPaths: paths });
});

app.post('/api/worker/authorizations/sync', (req, res) => {
  const { workerId, version } = req.body;
  if (workerId) {
    db.prepare("UPDATE worker_allowed_paths SET sync_status = 'SYNCED' WHERE worker_id = ?").run(workerId);
  }
  res.json({ success: true });
});

// --- 5. Validate Directories for Tasks (DIR-06, DIR-07, E03, E04) ---
app.post('/api/tasks/validate-directories', (req, res) => {
  const { workerId, model, bundleId, docCombo } = req.body;
  if (!workerId || !model) {
    return res.status(400).json({ valid: false, errors: ['缺少 workerId 或 model'] });
  }
  const resolvedModel = resolveModelAlias(model);
  let bundle = null;
  if (bundleId) bundle = db.prepare('SELECT * FROM published_bundles WHERE bundle_id = ?').get(bundleId);
  if (!bundle) bundle = db.prepare('SELECT * FROM published_bundles WHERE model_id = ?').get(resolvedModel.modelId);

  const effectiveCombo = docCombo || (bundle ? bundle.doc_combo : (resolvedModel.displayName === 'POA200' ? 'cert_and_packing' : 'cert_only'));
  const needCert = effectiveCombo === 'cert_and_packing' || effectiveCombo === 'cert_only';
  const needPacking = effectiveCombo === 'cert_and_packing' || effectiveCombo === 'packing_only';

  const errors = [];
  const details = [];

  const targetWorker = db.prepare('SELECT * FROM workers WHERE id = ?').get(workerId);
  const workerName = targetWorker ? targetWorker.name : workerId;

  if (needCert) {
    let certTmpl = null;
    if (bundle && bundle.cert_template_id) {
      certTmpl = db.prepare('SELECT * FROM templates WHERE id = ?').get(bundle.cert_template_id);
    }
    if (!certTmpl) {
      certTmpl = db.prepare("SELECT * FROM templates WHERE (model = ? OR model = ?) AND type = 'cert' AND published_at IS NOT NULL").get(model, resolvedModel.displayName);
    }
    if (!certTmpl) {
      certTmpl = db.prepare("SELECT * FROM templates WHERE (model = ? OR model = ?) AND type = 'cert'").get(model, resolvedModel.displayName);
    }

    if (!certTmpl) {
      errors.push(`未找到 ${resolvedModel.displayName} 对应的发货证书模板`);
    } else {
      const certCfg = db.prepare('SELECT * FROM worker_save_configs WHERE worker_id = ? AND template_id = ? AND doc_type = \'cert\'').get(workerId, certTmpl.id);
      if (!certCfg) {
        errors.push(`执行端 [${workerName}] 缺少证书模板 [${certTmpl.filename}] 的保存目录配置！(DIR-06)`);
      } else if (!certCfg.is_enabled) {
        errors.push(`执行端 [${workerName}] 未启用发货证书模板 [${certTmpl.filename}] (E03, WC-14)`);
      } else if (certCfg.check_status !== 'PASSED') {
        errors.push(`执行端 [${workerName}] 证书模板保存目录尚未检查通过（当前状态: ${certCfg.check_status}，原因: ${certCfg.check_message || '待检查'}）！(DIR-06)`);
      } else {
        const authCheck = isPathInWorkerAllowedPaths(workerId, certCfg.root_dir, true);
        if (!authCheck.allowed) {
          errors.push(authCheck.reason);
        } else {
          details.push({ type: 'cert', rootDir: certCfg.root_dir, saveMode: certCfg.save_mode, status: 'PASSED' });
        }
      }
    }
  }

  if (needPacking) {
    let packTmpl = null;
    if (bundle && bundle.packing_template_id) {
      packTmpl = db.prepare('SELECT * FROM templates WHERE id = ?').get(bundle.packing_template_id);
    }
    if (!packTmpl) {
      packTmpl = db.prepare("SELECT * FROM templates WHERE (model = ? OR model = ?) AND type = 'packing' AND published_at IS NOT NULL").get(model, resolvedModel.displayName);
    }
    if (!packTmpl) {
      packTmpl = db.prepare("SELECT * FROM templates WHERE (model = ? OR model = ?) AND type = 'packing'").get(model, resolvedModel.displayName);
    }

    if (!packTmpl) {
      errors.push(`未找到 ${resolvedModel.displayName} 对应的装箱清单模板`);
    } else {
      const packCfg = db.prepare('SELECT * FROM worker_save_configs WHERE worker_id = ? AND template_id = ? AND doc_type = \'packing\'').get(workerId, packTmpl.id);
      if (!packCfg) {
        errors.push(`执行端 [${workerName}] 缺少装箱清单模板 [${packTmpl.filename}] 的保存目录配置！(DIR-07)`);
      } else if (!packCfg.is_enabled) {
        errors.push(`执行端 [${workerName}] 未启用装箱清单模板 [${packTmpl.filename}] (E03, WC-14)`);
      } else if (packCfg.check_status !== 'PASSED') {
        errors.push(`执行端 [${workerName}] 装箱清单保存目录尚未检查通过（当前状态: ${packCfg.check_status}，原因: ${packCfg.check_message || '待检查'}）！(DIR-07)`);
      } else {
        const authCheck = isPathInWorkerAllowedPaths(workerId, packCfg.root_dir, true);
        if (!authCheck.allowed) {
          errors.push(authCheck.reason);
        } else {
          details.push({ type: 'packing', rootDir: packCfg.root_dir, saveMode: packCfg.save_mode, status: 'PASSED' });
        }
      }
    }
  }

  res.json({
    valid: errors.length === 0,
    errors,
    details
  });
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

  // Directory Configuration & Snapshotting (DIR-06, DIR-07, DIR-13, DIR-15)
  let certDirSnapshot = null;
  let packingDirSnapshot = null;

  if (createCert) {
    let certTmpl = null;
    if (bundle && bundle.cert_template_id) {
      certTmpl = db.prepare('SELECT * FROM templates WHERE id = ?').get(bundle.cert_template_id);
    }
    if (!certTmpl) {
      certTmpl = db.prepare("SELECT * FROM templates WHERE (model = ? OR model = ?) AND type = 'cert' AND published_at IS NOT NULL").get(model, resolvedModel.displayName);
    }
    if (!certTmpl) {
      certTmpl = db.prepare("SELECT * FROM templates WHERE (model = ? OR model = ?) AND type = 'cert'").get(model, resolvedModel.displayName);
    }

    if (!certTmpl) {
      return res.status(400).json({ error: `未找到 ${resolvedModel.displayName} 对应的发货证书模板` });
    }

    const certCfg = db.prepare('SELECT * FROM worker_save_configs WHERE worker_id = ? AND template_id = ? AND doc_type = \'cert\'').get(workerId, certTmpl.id);
    if (!certCfg) {
      return res.status(400).json({
        error: `缺少执行端 [${targetWorker.name || workerId}] 的证书模板 [${certTmpl.filename}] 的保存目录配置！(DIR-06)`
      });
    }
    if (!certCfg.is_enabled) {
      return res.status(400).json({
        error: `该模板已被管理员在执行端停用，请刷新页面重新获取可用模板 (WC-14)`
      });
    }
    if (certCfg.check_status !== 'PASSED') {
      return res.status(400).json({
        error: `执行端 [${targetWorker.name || workerId}] 的证书模板 [${certTmpl.filename}] 的保存目录尚未检查通过（当前状态: ${certCfg.check_status}，原因: ${certCfg.check_message || '待检查'}）！(DIR-06)`
      });
    }
    const certAuth = isPathInWorkerAllowedPaths(workerId, certCfg.root_dir, true);
    if (!certAuth.allowed) {
      return res.status(400).json({ error: certAuth.reason });
    }
    let targetDir = certCfg.root_dir;
    let subfolderName = '';
    if (certCfg.save_mode === 'subfolder') {
      const ruleKey = certCfg.subfolder_rule || 'deviceSn';
      const ruleVal = ruleKey === 'deviceSn' ? String(deviceSn).trim() : String(req.body[ruleKey] || '').trim();
      if (!ruleVal) {
        return res.status(400).json({ error: `子文件夹规则字段 [${ruleKey}] 缺失或为空，无法建立子文件夹！(DIR-13)` });
      }
      if (ruleVal.includes('..') || ruleVal.includes('/') || ruleVal.includes('\\') || /[<>:"|?*]/.test(ruleVal)) {
        return res.status(400).json({ error: `子文件夹名称包含非法字符或试图跳出根目录 [${ruleVal}]！(DIR-13)` });
      }
      subfolderName = ruleVal;
      targetDir = path.join(certCfg.root_dir, subfolderName);
      const rel = path.relative(certCfg.root_dir, targetDir);
      if (rel.startsWith('..') || (path.isAbsolute(rel) && !rel.startsWith(certCfg.root_dir))) {
        return res.status(400).json({ error: `安全拦截：子文件夹路径试图跳出根目录范围！(DIR-13)` });
      }
    }

    certDirSnapshot = {
      targetDir,
      rootDir: certCfg.root_dir,
      subfolderName,
      configId: certCfg.id,
      version: certCfg.version
    };
  }

  if (createPacking) {
    let packTmpl = null;
    if (bundle && bundle.packing_template_id) {
      packTmpl = db.prepare('SELECT * FROM templates WHERE id = ?').get(bundle.packing_template_id);
    }
    if (!packTmpl) {
      packTmpl = db.prepare("SELECT * FROM templates WHERE (model = ? OR model = ?) AND type = 'packing' AND published_at IS NOT NULL").get(model, resolvedModel.displayName);
    }
    if (!packTmpl) {
      packTmpl = db.prepare("SELECT * FROM templates WHERE (model = ? OR model = ?) AND type = 'packing'").get(model, resolvedModel.displayName);
    }

    if (!packTmpl) {
      return res.status(400).json({ error: `未找到 ${resolvedModel.displayName} 对应的装箱清单模板` });
    }

    const packCfg = db.prepare('SELECT * FROM worker_save_configs WHERE worker_id = ? AND template_id = ? AND doc_type = \'packing\'').get(workerId, packTmpl.id);
    if (!packCfg) {
      return res.status(400).json({
        error: `缺少执行端 [${targetWorker.name || workerId}] 的装箱清单模板 [${packTmpl.filename}] 的保存目录配置！(DIR-07)`
      });
    }
    if (!packCfg.is_enabled) {
      return res.status(400).json({
        error: `该模板已被管理员在执行端停用，请刷新页面重新获取可用模板 (WC-14)`
      });
    }
    if (packCfg.check_status !== 'PASSED') {
      return res.status(400).json({
        error: `执行端 [${targetWorker.name || workerId}] 的装箱清单模板 [${packTmpl.filename}] 的保存目录尚未检查通过（当前状态: ${packCfg.check_status}，原因: ${packCfg.check_message || '待检查'}）！(DIR-07)`
      });
    }
    const packAuth = isPathInWorkerAllowedPaths(workerId, packCfg.root_dir, true);
    if (!packAuth.allowed) {
      return res.status(400).json({ error: packAuth.reason });
    }
    let targetDir = packCfg.root_dir;
    let subfolderName = '';
    if (packCfg.save_mode === 'subfolder') {
      const ruleKey = packCfg.subfolder_rule || 'deviceSn';
      const ruleVal = ruleKey === 'deviceSn' ? String(deviceSn).trim() : String(req.body[ruleKey] || '').trim();
      if (!ruleVal) {
        return res.status(400).json({ error: `子文件夹规则字段 [${ruleKey}] 缺失或为空，无法建立子文件夹！(DIR-13)` });
      }
      if (ruleVal.includes('..') || ruleVal.includes('/') || ruleVal.includes('\\') || /[<>:"|?*]/.test(ruleVal)) {
        return res.status(400).json({ error: `子文件夹名称包含非法字符或试图跳出根目录 [${ruleVal}]！(DIR-13)` });
      }
      subfolderName = ruleVal;
      targetDir = path.join(packCfg.root_dir, subfolderName);
      const rel = path.relative(packCfg.root_dir, targetDir);
      if (rel.startsWith('..') || (path.isAbsolute(rel) && !rel.startsWith(packCfg.root_dir))) {
        return res.status(400).json({ error: `安全拦截：子文件夹路径试图跳出根目录范围！(DIR-13)` });
      }
    }

    packingDirSnapshot = {
      targetDir,
      rootDir: packCfg.root_dir,
      subfolderName,
      configId: packCfg.id,
      version: packCfg.version
    };
  }

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

  // Create Task Files with Target Directory Snapshot (DIR-15)
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
      INSERT INTO task_files (task_id, file_type, official_filename, status, target_dir, root_dir, subfolder_name, dir_config_id, dir_config_version)
      VALUES (?, 'cert', ?, 'GENERATING', ?, ?, ?, ?, ?)
    `).run(taskId, certOfficialName, certDirSnapshot.targetDir, certDirSnapshot.rootDir, certDirSnapshot.subfolderName, certDirSnapshot.configId, certDirSnapshot.version);
  }

  if (createPacking) {
    const packingOfficialName = generatePackingListFilename({
      model: resolvedModel.displayName,
      deviceSn: String(deviceSn),
      acceptedDate: acceptedAt,
      hasPump: resolvedModel.displayName === 'POA200' ? hasPump : false
    });

    db.prepare(`
      INSERT INTO task_files (task_id, file_type, official_filename, status, target_dir, root_dir, subfolder_name, dir_config_id, dir_config_version)
      VALUES (?, 'packing', ?, 'GENERATING', ?, ?, ?, ?, ?)
    `).run(taskId, packingOfficialName, packingDirSnapshot.targetDir, packingDirSnapshot.rootDir, packingDirSnapshot.subfolderName, packingDirSnapshot.configId, packingDirSnapshot.version);
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

  const files = db.prepare('SELECT * FROM task_files WHERE task_id = ?').all(taskId);
  const anySuccess = files.some(f => f.status === 'PREVIEW_READY' || f.status === 'PRINTED');
  const allFinished = files.every(f => f.status === 'PREVIEW_READY' || f.status === 'PRINTED' || f.status === 'FAILED');

  if (allFinished && anySuccess) {
    // DIR-20: 证书与清单分别记录状态；其中一份失败时，不得将整个任务显示为全部成功。
    db.prepare("UPDATE tasks SET status = 'PARTIAL_SUCCESS', completed_at = ?, error_msg = ? WHERE id = ?").run(new Date().toISOString(), errorMsg || 'Partially failed', taskId);
  } else {
    db.prepare("UPDATE tasks SET status = 'FAILED', error_msg = ? WHERE id = ?").run(errorMsg || 'Generation failed', taskId);
  }

  logAudit(null, 'WORKER', 'WorkerService', 'FILE_FAILED', { taskId, fileType, errorMsg });
  res.json({ success: true, taskId, fileType });
});

app.post('/api/worker/tasks/:id/file-returned', upload.single('wordFile'), (req, res) => {
  const taskId = req.params.id;
  const { fileType, officialFilename, sha256, workerFilePath } = req.body;

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
    SET server_filepath = ?, sha256 = ?, preview_images = ?, status = 'PREVIEW_READY', worker_filepath = ?
    WHERE task_id = ? AND file_type = ?
  `).run(destPath, sha256 || getFileSha256(destPath), JSON.stringify(previews), workerFilePath || null, taskId, fileType);

  const files = db.prepare('SELECT * FROM task_files WHERE task_id = ?').all(taskId);
  const anyFailed = files.some(f => f.status === 'FAILED');
  const allFinished = files.every(f => f.status === 'PREVIEW_READY' || f.status === 'PRINTED' || f.status === 'FAILED');

  if (allFinished) {
    if (anyFailed) {
      // DIR-20: 证书与清单分别记录状态；其中一份失败时，不得将整个任务显示为全部成功。
      db.prepare("UPDATE tasks SET status = 'PARTIAL_SUCCESS', completed_at = ? WHERE id = ?").run(new Date().toISOString(), taskId);
    } else {
      db.prepare("UPDATE tasks SET status = 'SUCCESS', completed_at = ? WHERE id = ?").run(new Date().toISOString(), taskId);
    }
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
