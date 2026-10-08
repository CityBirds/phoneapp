const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('./db');
const { generateCertFilename, generatePackingListFilename } = require('../common/naming');
const {
  findFieldCandidates, inferFieldType, normalizeText,
  detectTableRegions, resolvePackingHeaderFields, assignPackingRowRoles
} = require('../common/matcher');
const { extractDocumentStructure } = require('../common/doc_structure');
const { getBeijingCalendarRange, generateUUID, getFileSha256 } = require('../common/utils');
const { generateDocumentPreview, getPreviewPdfPath, getPreviewPageDir, isValidPdf, getConversionCapabilities } = require('./preview');
const accessControl = require('./access_control');
const {
  getAccessToken,
  accessTokenMiddleware,
  isTokenValid,
  isWorkerPath,
  internalPort,
  shouldBlockWorkerPathOnPublicPort,
  isDirectLocalRequest,
  usesTunnelHeader
} = accessControl;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Storage directories
// 说明：支持通过环境变量覆盖，便于测试使用隔离目录，避免测试产物写入生产预览/回传目录
const uploadDir = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(__dirname, '../../uploads/templates');
const previewDir = process.env.PREVIEW_DIR
  ? path.resolve(process.env.PREVIEW_DIR)
  : path.join(__dirname, '../../data/previews');
const returnedDir = process.env.RETURNED_DIR
  ? path.resolve(process.env.RETURNED_DIR)
  : path.join(__dirname, '../../data/returned');

[uploadDir, previewDir, returnedDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.use('/previews', express.static(previewDir, {
  // 预览按“内容版本”命名（?v=修改时间），因此必须允许缓存但禁止用旧内容顶替新产物 (整改 A.5)
  // 页图放在 task_<id>_<type>_pages/ 子目录下（PV06：同名不同内容不串页）
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (/\.pdf$/i.test(filePath)) {
      res.setHeader('Content-Type', 'application/pdf');
      // 允许手机端内嵌 PDF 查看器直接展示
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    } else if (/\.png$/i.test(filePath)) {
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    }
  }
}));

// 访问口令：若 URL 携带 ?k=口令，则写入 Cookie，方便后续请求与刷新（须在路由/静态之前）
app.use((req, res, next) => {
  const k = req.query && (req.query.k || req.query.token);
  if (k && String(k).trim()) {
    res.cookie('phoneapp_token', String(k).trim(), {
      httpOnly: false,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 180
    });
  }
  next();
});

app.get('/', (req, res) => res.redirect('/frontend/index.html'));

// 口令登录页（无需口令即可访问）
app.get(['/login', '/login.html'], (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/login.html'));
});

// 手机端页面（须在静态中间件之前声明，否则会被静态目录抢先处理而无法设置 Cookie）
app.get(['/frontend', '/frontend/', '/frontend/index.html'], (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// 管理页：注入运行期访问信息（隧道告警），并说明口令；管理接口本身另有限制
app.get('/admin', (req, res) => {
  let html = fs.readFileSync(path.join(__dirname, '../frontend/admin.html'), 'utf-8');
  html = html.replace('</head>', `${adminRuntimeNoticeScript()}</head>`);
  res.type('html').send(html);
});

// 其余静态资源（styles.css / app.js / admin.js 等）
app.use('/frontend', express.static(path.join(__dirname, '../frontend')));
app.use(express.static(path.join(__dirname, '../frontend')));

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

// Security Middleware: 协调管理功能仅限本机直连。
// 注意：隧道客户端（cloudflared/ngrok 等）运行在本机，转发请求的源地址是 127.0.0.1，
// 若只看源地址，公网访客会被误判为本机管理员，导致管理后台公开可写。
// 因此这里额外排除携带 Cloudflare 隧源头（cf-connecting-ip）的转发请求。
function isLocalhostRequest(req) {
  return isDirectLocalRequest(req);
}

function requireAdminAccess(req, res, next) {
  if (!isLocalhostRequest(req)) {
    return res.status(403).json({
      error: '权限受限：该管理功能（修改手机端名字、上传模板、发布配置等）仅限在协调服务电脑本机操作 (C01, C03)。' +
        (usesTunnelHeader(req) ? '检测到请求来自外部隧道，已拒绝。请在协调服务电脑上直接打开 http://localhost:3000/admin 操作。' : '')
    });
  }
  next();
}

/** 管理页运行期提示脚本：说明隧道状态与访问口令，避免把管理入口暴露给公网 */
function adminRuntimeNoticeScript() {
  const payload = {
    token: getAccessToken(),
    port: process.env.PORT || 3000
  };
  return `<script id="dsh-runtime-notice">
  window.__PHONEAPP_RUNTIME__ = ${JSON.stringify(payload)};
  (function () {
    var t = window.__PHONEAPP_RUNTIME__.token || '';
    var isTunnel = !!document.referrer || window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1';
    function banner(kind, text) {
      var box = document.createElement('div');
      box.style.cssText = 'padding:12px 16px;margin:12px 16px;border-radius:8px;font-size:13px;line-height:1.7;' +
        (kind === 'warn'
          ? 'background:#fef3c7;border:1px solid #fbbf24;color:#92400e;'
          : 'background:#e0f2fe;border:1px solid #7dd3fc;color:#075985;');
      box.innerHTML = text;
      document.body.insertBefore(box, document.body.firstChild);
    }
    try {
      if (isTunnel) {
        banner('warn', '⚠️ <b>你正在通过非本机地址打开管理控制台</b>：本页面的管理接口已被服务端限制为“仅协调服务电脑本机可写”，' +
          '因此这里的修改操作会被拒绝（403）。请在协调服务电脑上直接打开 <code>http://localhost:' +
          window.__PHONEAPP_RUNTIME__.port + '/admin</code> 进行配置。');
      } else if (t) {
        banner('info', '🔑 <b>车间手机访问方式</b><br>' +
          '① 网址：<code>/frontend/login.html</code>（公网地址请用隧道地址，例如 https://xxx.trycloudflare.com/frontend/login.html）<br>' +
          '② 访问口令：<code style="font-size:15px;font-weight:700;">' + t + '</code><br>' +
          '车间手机打开网址后输入口令即可，只需输入一次。也可直接打开带口令的链接：' +
          '<code>/frontend/index.html?k=' + t + '</code>');
      }
    } catch (e) {}
  })();
  </script>`;
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

  // Default hardcoded alias resolution fallback (strict matching to avoid cross-model collision)
  const upper = str.toUpperCase();
  if (upper === 'POA200' || upper === 'POA-200' || upper === 'POA 200') {
    return { modelId: 'model_poa200', displayName: 'POA200' };
  }
  if (upper === 'POA3500' || upper === 'POA-3500' || upper === 'POA 3500' || upper === '3500') {
    return { modelId: 'model_poa3500', displayName: 'POA3500' };
  }
  if (upper === 'DPT810' || upper === 'DPT-810' || upper === 'DPT 810') {
    return { modelId: 'model_dpt810', displayName: 'DPT810' };
  }
  if (upper === '990' || upper === '990-EX' || upper === 'DPT-990-EX' || upper === 'DPT-990-Ex') {
    return { modelId: 'model_990', displayName: '990' };
  }

  const cleanKey = upper.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return { modelId: `model_${cleanKey || 'unknown'}`, displayName: upper };
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
function ensureMainDeviceSpec(items, modelName) {
  if (!Array.isArray(items) || items.length === 0) return items;
  const cloned = JSON.parse(JSON.stringify(items));
  let mainIdx = cloned.findIndex(it => (it.name || '').trim() === '主设备');
  if (mainIdx === -1) mainIdx = 0;
  if (cloned[mainIdx] && modelName) {
    if (!cloned[mainIdx].spec || cloned[mainIdx].spec.trim() === '' || (cloned[mainIdx].spec === 'POA200' && !modelName.toUpperCase().includes('POA'))) {
      cloned[mainIdx].spec = modelName;
    }
  }
  return cloned;
}

function syncPublishedBundlesForModel(modelName) {
  const resolved = resolveModelAlias(modelName);
  const mName = modelName;

  const dbModels = db.prepare('SELECT * FROM models WHERE id = ?').all(resolved.modelId);
  const validModelNames = new Set([modelName, resolved.displayName]);
  if (dbModels[0]) {
    validModelNames.add(dbModels[0].display_name);
    try {
      JSON.parse(dbModels[0].aliases || '[]').forEach(a => validModelNames.add(a));
    } catch (e) {}
  }

  const allTemplates = db.prepare("SELECT * FROM templates WHERE published_at IS NOT NULL").all()
    .filter(t => validModelNames.has(t.model) || resolveModelAlias(t.model).modelId === resolved.modelId);
  
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
          tableConfig: certTmpl.mappings.tableConfig || null,
          testPoints: certTmpl.mappings.testPoints || [],
          packingItems: ensureMainDeviceSpec(packTmpl.mappings.packingItems || [], mName),
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
    let fallbackPackTmpl = null;
    if (validPackTmpls.length === 0 && (mName.toUpperCase().includes('POA') || mName === '3500')) {
      const poaPack = db.prepare("SELECT * FROM templates WHERE model = 'POA200' AND type = 'packing' AND published_at IS NOT NULL").get();
      if (poaPack) {
        const v = validateTemplateThreeInOne(poaPack);
        if (v.valid) {
          fallbackPackTmpl = { ...poaPack, mappings: v.mappings };
        }
      }
    }

    if (fallbackPackTmpl) {
      validCertTmpls.forEach(certTmpl => {
        const fullBundleId = `bundle_${mName.toLowerCase()}_full`;
        const fullOptionName = '带清单';
        const fullSnapshot = {
          model: mName,
          docCombo: 'cert_and_packing',
          certTemplate: { ...certTmpl, field_mappings: certTmpl.mappings },
          packingTemplate: { ...fallbackPackTmpl, field_mappings: fallbackPackTmpl.mappings },
          tableConfig: certTmpl.mappings.tableConfig || null,
          testPoints: certTmpl.mappings.testPoints || [],
          packingItems: ensureMainDeviceSpec(fallbackPackTmpl.mappings.packingItems || [], mName),
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
        `).run(fullBundleId, fullBundleId, certTmpl.version || 'v1.0', resolved.modelId, mName, fullOptionName, certTmpl.id, fallbackPackTmpl.id, now, JSON.stringify(fullSnapshot));
        generatedBundleIds.add(fullBundleId);
      });
    }

    validCertTmpls.forEach(certTmpl => {
      const bundleId = `bundle_${mName.toLowerCase()}_cert`;
      const optionName = '仅证书';
      const configSnapshot = {
        model: mName,
        docCombo: 'cert_only',
        certTemplate: { ...certTmpl, field_mappings: certTmpl.mappings },
        packingTemplate: null,
        tableConfig: certTmpl.mappings.tableConfig || null,
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
        packingItems: ensureMainDeviceSpec(packTmpl.mappings.packingItems || [], mName),
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

function cleanupAndDeduplicateTemplates() {
  try {
    db.prepare("DELETE FROM published_bundles WHERE bundle_id LIKE 'bundle_990_%' AND NOT EXISTS (SELECT 1 FROM templates WHERE id = cert_template_id OR id = packing_template_id)").run();
  } catch(e) {}
  try {
    // 1. Delete orphan test residue records without business tasks
    const testResidues = db.prepare(`
      SELECT id FROM templates 
      WHERE id LIKE 'tmpl_dummy_%' OR id LIKE 'tmpl_test_%' OR id LIKE 'dummy_%'
    `).all();

    for (const row of testResidues) {
      const inTask = db.prepare("SELECT id FROM tasks WHERE form_data LIKE ?").get(`%${row.id}%`);
      if (!inTask) {
        db.prepare("DELETE FROM worker_save_configs WHERE template_id = ?").run(row.id);
        db.prepare("DELETE FROM published_bundles WHERE cert_template_id = ? OR packing_template_id = ?").run(row.id, row.id);
        db.prepare("DELETE FROM templates WHERE id = ?").run(row.id);
      }
    }

    // 2. Deduplicate template records sharing same model, type, and file_hash
    const duplicates = db.prepare(`
      SELECT model, type, file_hash, COUNT(*) as cnt 
      FROM templates 
      GROUP BY model, type, file_hash 
      HAVING cnt > 1
    `).all();

    for (const dup of duplicates) {
      const records = db.prepare(`
        SELECT * FROM templates 
        WHERE model = ? AND type = ? AND file_hash = ?
        ORDER BY published_at DESC, id ASC
      `).all(dup.model, dup.type, dup.file_hash);

      if (records.length <= 1) continue;

      let canonical = records.find(r => r.id === `tmpl_${r.model.toLowerCase()}_${r.type}`) || records[0];
      const dupIds = records.filter(r => r.id !== canonical.id).map(r => r.id);

      for (const dupId of dupIds) {
        const cfgs = db.prepare("SELECT * FROM worker_save_configs WHERE template_id = ?").all(dupId);
        for (const cfg of cfgs) {
          const existing = db.prepare("SELECT id FROM worker_save_configs WHERE worker_id = ? AND template_id = ? AND doc_type = ?").get(cfg.worker_id, canonical.id, cfg.doc_type);
          if (existing) {
            db.prepare("DELETE FROM worker_save_configs WHERE id = ?").run(cfg.id);
          } else {
            db.prepare("UPDATE worker_save_configs SET template_id = ? WHERE id = ?").run(canonical.id, cfg.id);
          }
        }

        db.prepare("UPDATE published_bundles SET cert_template_id = ? WHERE cert_template_id = ?").run(canonical.id, dupId);
        db.prepare("UPDATE published_bundles SET packing_template_id = ? WHERE packing_template_id = ?").run(canonical.id, dupId);
        db.prepare("DELETE FROM templates WHERE id = ?").run(dupId);
      }
    }
  } catch (err) {
    console.warn('[Cleanup Error]', err.message);
  }
}

// Seed Default Models and Templates dynamically
function seedDefaultTemplates() {
  // 允许跳过内置种子：正式环境想“清空后自己重新上传模板”时，
  // 若不禁用本函数，每次启动都会从 samples/ 重新种入 5 条内置模板，导致清空失效。
  // 设置 SKIP_SEED_TEMPLATES=1 可跳过（启动脚本已默认带上该开关）。
  // 注意：批处理里 `set VAR=1 && ...` 会把 "&&" 前的空格并入变量值（得到 "1 "），
  // 因此这里先 trim 再判断，不能用严格相等。
  const seedFlag = String(process.env.SKIP_SEED_TEMPLATES || '').trim().toLowerCase();
  if (seedFlag && seedFlag !== '0' && seedFlag !== 'false' && seedFlag !== 'no') {
    console.log(`[Seed] 已跳过内置模板种子（SKIP_SEED_TEMPLATES="${String(process.env.SKIP_SEED_TEMPLATES)}"），模板库保持数据库现状`);
    return;
  }
  cleanupAndDeduplicateTemplates();
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
  `).run('model_990', '990', JSON.stringify(['990', '990-Ex', 'DPT-990-EX', 'DPT-990-Ex']), now);
  db.prepare(`
    INSERT OR IGNORE INTO models (id, display_name, aliases, created_at)
    VALUES (?, ?, ?, ?)
  `).run('model_poa3500', 'POA3500', JSON.stringify(['POA3500', 'POA-3500', 'POA 3500', '3500']), now);

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
          { index: 6, name: '安装螺钉', spec: '', count: 1, unit: '包', standard: '是', remark: '' },
          { index: 7, name: '干燥装置', spec: '', count: 1, unit: '个', standard: '否', remark: '' },
          { index: 8, name: '堵头', spec: '', count: 1, unit: '个', standard: '否', remark: '' },
          { index: 9, name: '卡套螺母组', spec: '1/4', count: 2, unit: '套', standard: '否', remark: '' },
          { index: 10, name: '防爆电缆接头', spec: '', count: 2, unit: '个', standard: '否', remark: '' },
          { index: 11, name: '电源/信号线', spec: '', count: 2, unit: '根', standard: '否', remark: '' }
        ]
      }), now);
    }

    // Dynamic bundle calculation from real templates
    syncPublishedBundlesAll();
  }
}
seedDefaultTemplates();

// Helper to parse comma-separated string (Chinese and English commas) into unique trimmed array
function parseCommaSeparatedOptions(str) {
  if (!str) return [];
  const rawStr = typeof str === 'string' ? str : (Array.isArray(str) ? str.join(',') : String(str));
  const tokens = rawStr.split(/[，,]/);
  const options = [];
  tokens.forEach(t => {
    const cleaned = t.trim();
    if (cleaned && !options.includes(cleaned)) {
      options.push(cleaned);
    }
  });
  return options;
}

// ==================== 访问控制（共享口令） ====================
// 手机端作业接口需携带共享访问口令；静态资源、页面、执行端接口与登录相关接口除外。
app.get('/api/access/verify', (req, res) => {
  res.json({ ok: isTokenValid(req), source: usesTunnelHeader(req) ? 'tunnel' : 'local' });
});

app.get('/api/access/config', (req, res) => {
  // 只回传最小信息用于前端提示，不回传口令本身
  res.json({
    authRequired: true,
    source: usesTunnelHeader(req) ? 'tunnel' : 'local',
    workerPort: internalPort() || null
  });
});

// 执行端接口只允许从内部端口访问，避免隧道把“注册假执行端/接收任务”暴露到公网
app.use((req, res, next) => {
  if (shouldBlockWorkerPathOnPublicPort(req)) {
    return res.status(403).json({
      error: `执行端接口 [${req.path}] 不允许从对外端口访问，请使用内部端口 ${internalPort()}（INTERNAL_PORT）(E02, 4.2)`
    });
  }
  next();
});

app.use(accessTokenMiddleware);

// ==================== SENSOR CONFIGS MANAGEMENT ====================
app.get('/api/sensor-configs', (req, res) => {
  try {
    const configs = db.prepare('SELECT * FROM sensor_configs ORDER BY model ASC').all().map(c => ({
      ...c,
      sensor_options: JSON.parse(c.sensor_options || '[]')
    }));
    res.json(configs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/sensor-configs', requireAdminAccess, (req, res) => {
  try {
    const { id, model, sensor_options, default_value } = req.body;
    if (!model || typeof model !== 'string' || !model.trim()) {
      return res.status(400).json({ error: '设备型号 (model) 不能为空' });
    }
    const cleanModel = model.trim();
    const parsedOptions = parseCommaSeparatedOptions(sensor_options);
    if (parsedOptions.length === 0) {
      return res.status(400).json({ error: '传感器型号选项不能为空' });
    }

    let cleanDefault = default_value ? String(default_value).trim() : null;
    if (cleanDefault && !parsedOptions.includes(cleanDefault)) {
      cleanDefault = parsedOptions[0];
    } else if (!cleanDefault && parsedOptions.length > 0) {
      cleanDefault = parsedOptions[0];
    }

    const now = new Date().toISOString();
    const optionsJson = JSON.stringify(parsedOptions);

    let existing = id ? db.prepare('SELECT * FROM sensor_configs WHERE id = ?').get(id) : null;
    if (!existing) {
      existing = db.prepare('SELECT * FROM sensor_configs WHERE LOWER(TRIM(model)) = LOWER(?)').get(cleanModel);
    }

    let configId;
    if (existing) {
      configId = existing.id;
      db.prepare(`
        UPDATE sensor_configs
        SET model = ?, sensor_options = ?, default_value = ?, updated_at = ?
        WHERE id = ?
      `).run(cleanModel, optionsJson, cleanDefault, now, existing.id);
    } else {
      const ins = db.prepare(`
        INSERT INTO sensor_configs (model, sensor_options, default_value, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(cleanModel, optionsJson, cleanDefault, now, now);
      configId = ins.lastInsertRowid;
    }

    logAudit(null, 'ADMIN', 'Admin', 'SAVE_SENSOR_CONFIG', { id: configId, model: cleanModel, options: parsedOptions, default_value: cleanDefault });
    const saved = db.prepare('SELECT * FROM sensor_configs WHERE id = ?').get(configId);
    res.json({
      success: true,
      config: {
        ...saved,
        sensor_options: JSON.parse(saved.sensor_options || '[]')
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/sensor-configs/:id', requireAdminAccess, (req, res) => {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM sensor_configs WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: '传感器配置不存在' });
    }

    db.prepare('DELETE FROM sensor_configs WHERE id = ?').run(id);
    logAudit(null, 'ADMIN', 'Admin', 'DELETE_SENSOR_CONFIG', { id, model: existing.model });
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== SALES PERSONS MANAGEMENT ====================
app.get('/api/sales-persons', (req, res) => {
  try {
    const list = db.prepare('SELECT * FROM sales_persons ORDER BY id ASC').all();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/sales-persons', requireAdminAccess, (req, res) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: '销售人员姓名不能为空' });
    }
    const cleanName = name.trim();
    const now = new Date().toISOString();

    const existing = db.prepare('SELECT * FROM sales_persons WHERE name = ?').get(cleanName);
    if (existing) {
      return res.status(400).json({ error: `销售人员 [${cleanName}] 已存在，请勿重复添加` });
    }

    const ins = db.prepare('INSERT INTO sales_persons (name, created_at) VALUES (?, ?)').run(cleanName, now);
    logAudit(null, 'ADMIN', 'Admin', 'ADD_SALES_PERSON', { id: ins.lastInsertRowid, name: cleanName });
    res.json({ success: true, id: ins.lastInsertRowid, name: cleanName, created_at: now });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/sales-persons/:id', requireAdminAccess, (req, res) => {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM sales_persons WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: '销售人员不存在' });
    }

    db.prepare('DELETE FROM sales_persons WHERE id = ?').run(id);
    logAudit(null, 'ADMIN', 'Admin', 'DELETE_SALES_PERSON', { id, name: existing.name });
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

// ==================== WORKER IDENTITY & ACCESS AUTH (多执行端整改 §3.2/§4/§5) ====================
/** 列出本机可供远程执行端接入的局域网 IPv4 地址（用于启动日志打印实际接入地址 §3.1） */
function listLanIPv4() {
  const out = [];
  try {
    const nets = require('os').networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        const family = typeof net.family === 'string' ? net.family : (net.family === 4 ? 'IPv4' : '');
        if (family !== 'IPv4' || net.internal) continue;
        out.push(net.address);
      }
    }
  } catch (e) {}
  return out;
}

const WORKER_REGISTRATION_MODE = String(process.env.WORKER_REGISTRATION || 'first-time').toLowerCase();
const WORKER_IDENTITY_CONFLICT_WINDOW_MS = Number(process.env.WORKER_CONFLICT_WINDOW_MS) > 0
  ? Number(process.env.WORKER_CONFLICT_WINDOW_MS) : 120000;

function hashWorkerSecret(secret) {
  return crypto.createHash('sha256').update(String(secret || '')).digest('hex');
}

function timingSafeEqualHex(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  try { return crypto.timingSafeEqual(bufA, bufB); } catch (e) { return false; }
}

/** 规范化来源地址显示：IPv4-mapped IPv6 还原为 IPv4，回环统一可辨 (MW18) */
function normalizeClientIp(raw) {
  let ip = String(raw || '').trim();
  if (!ip) return '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') return '127.0.0.1 (IPv6回环)';
  return ip;
}

/** 取直连来源地址：只认 socket，不信任任何转发头（MW18） */
function getDirectClientIp(req) {
  return normalizeClientIp((req.socket && req.socket.remoteAddress) || (req.connection && req.connection.remoteAddress) || '');
}

/**
 * 执行端接入凭据校验。
 * 规则（§3.2）：身份绑定 workerId，不能只信任请求体里的 workerId，也不能只凭“来自 3001 端口”。
 *  - 首次登记：worker_id 不存在时按注册模式决定是否放行（默认允许首次登记，可配置为关闭）；
 *  - 已登记：必须提供匹配的 x-worker-token；
 *  - W2 冒用 W1 的 workerId：凭据不匹配 → 401，且不覆盖 W1 的记录。
 */
function authenticateWorker(req, workerId, secret) {
  const id = String(workerId || '').trim();
  if (!id) return { ok: false, status: 400, error: '缺少 workerId' };
  const provided = String(secret || '').trim();
  const record = db.prepare('SELECT * FROM worker_access_auth WHERE worker_id = ?').get(id);

  if (!record) {
    if (WORKER_REGISTRATION_MODE === 'closed') {
      return { ok: false, status: 403, error: '协调服务已关闭自动登记，请由管理员先在管理端登记该终端' };
    }
    if (!provided) {
      return { ok: false, status: 401, error: '首次登记必须提供接入凭据（x-worker-token）' };
    }
    return { ok: true, firstTime: true, workerId: id };
  }

  if (!provided) {
    return { ok: false, status: 401, error: '缺少接入凭据（x-worker-token），已拒绝', code: 'WORKER_TOKEN_REQUIRED' };
  }
  if (!timingSafeEqualHex(hashWorkerSecret(provided), record.secret_hash)) {
    return {
      ok: false,
      status: 401,
      error: `接入凭据与终端 [${id}] 已登记凭据不匹配，已拒绝（如为本机身份文件被复制，请删除 worker_config.local.json 后以新终端注册）`,
      code: 'WORKER_TOKEN_MISMATCH'
    };
  }
  return { ok: true, firstTime: false, workerId: id, record };
}

/** 首次登记写入凭据（只存哈希，不落明文，日志与手机返回值都不含凭据 §3.2） */
function registerWorkerSecret(workerId, secret, name) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO worker_access_auth (worker_id, secret_hash, secret_hint, registered_at, name_source)
    VALUES (?, ?, ?, ?, 'report')
    ON CONFLICT(worker_id) DO NOTHING
  `).run(workerId, hashWorkerSecret(secret), String(secret).slice(-4), now);
}

/**
 * 执行端接口统一鉴权中间件：把认证身份绑定到 workerId。
 * 请求体/查询参数里的 workerId 必须与凭据所属身份一致，否则 403（防 W2 冒用 W1）。
 *
 * 落地策略（协调机本机回环豁免）：
 *  - 直连来源为回环地址（协调服务本机执行端）时豁免凭据：此时物理边界已在协调机内部，
 *    本机执行端无需额外配置，也让既有 worker-local 实例平滑迁移；
 *  - 非回环（远程电脑）一律强制凭据：缺失 → 401，冒用他人 workerId → 401/403。
 *    因此「请求来自 3001 端口」本身不再构成放行依据，远程接入必须持有该身份的凭据。
 */
function requireWorkerAuth(req, res, next) {
  const headerId = String(req.headers['x-worker-id'] || '').trim();
  const headerToken = String(req.headers['x-worker-token'] || '').trim();
  const claimedId = String((req.body && req.body.workerId) || req.query.workerId || '').trim();
  const workerId = headerId || claimedId;
  const directIp = getDirectClientIp(req);
  const isLoopback = directIp === '127.0.0.1' || directIp === '127.0.0.1 (IPv6回环)' || !directIp;

  if (isLoopback) {
    req.workerIdentity = { workerId, firstTime: false, ip: directIp, loopbackExempt: true };
    return next();
  }

  const auth = authenticateWorker(req, workerId, headerToken);
  if (!auth.ok) {
    return res.status(auth.status).json({ success: false, error: auth.error, code: auth.code || 'WORKER_AUTH_FAILED' });
  }
  if (claimedId && headerId && claimedId !== headerId) {
    return res.status(403).json({
      success: false,
      error: `请求声明的 workerId (${claimedId}) 与认证身份 (${headerId}) 不一致，已拒绝`,
      code: 'WORKER_IDENTITY_MISMATCH'
    });
  }
  req.workerIdentity = { workerId: auth.workerId, firstTime: auth.firstTime, ip: directIp };
  next();
}

// ==================== WORKER & PRINTER MONITORING ====================
app.post('/api/workers/heartbeat', (req, res) => {
  const { workerId, name, ip, workingDir, printers, status = 'ONLINE', selfReportedIp } = req.body || {};
  if (!workerId) return res.status(400).json({ error: 'workerId required' });

  const secret = String(req.headers['x-worker-token'] || '').trim();
  const directIpForAuth = getDirectClientIp(req);
  const isLoopbackHeartbeat = directIpForAuth === '127.0.0.1' || directIpForAuth === '127.0.0.1 (IPv6回环)' || !directIpForAuth;
  // 回环豁免与 requireWorkerAuth 保持一致：协调机本机执行端不需要额外配置凭据，
  // 远程电脑接入必须携带该身份的凭据（§3.2）。这样本机既有实例升级后无需重新配置。
  const auth = isLoopbackHeartbeat
    ? { ok: true, firstTime: false, workerId }
    : authenticateWorker(req, workerId, secret);
  if (!auth.ok) {
    logAudit(null, 'WORKER', 'WorkerService', 'WORKER_AUTH_REJECTED', {
      workerId: String(workerId).slice(0, 64), ip: directIpForAuth, reason: auth.code || auth.error
    });
    return res.status(auth.status).json({ success: false, error: auth.error, code: auth.code || 'WORKER_AUTH_FAILED' });
  }
  if (auth.firstTime) {
    registerWorkerSecret(workerId, secret, name);
  }

  const now = new Date().toISOString();
  const directIp = getDirectClientIp(req);
  const reportedIp = normalizeClientIp(ip) || normalizeClientIp(selfReportedIp) || '';
  const printersJson = JSON.stringify(printers || []);
  const existing = db.prepare('SELECT * FROM workers WHERE id = ?').get(workerId);

  // 身份冲突检测（§4）：同一 workerId 短时间内从不同来源地址出现，
  // 说明身份文件被复制到另一台电脑，必须明确提示而不是静默轮流覆盖。
  const authRec = db.prepare('SELECT * FROM worker_access_auth WHERE worker_id = ?').get(workerId);
  let conflict = null;
  if (authRec && authRec.last_seen_ip && directIp && authRec.last_seen_ip !== directIp) {
    const lastSeenMs = authRec.last_seen_at ? new Date(authRec.last_seen_at).getTime() : 0;
    if (Date.now() - lastSeenMs < WORKER_IDENTITY_CONFLICT_WINDOW_MS) {
      conflict = {
        identityConflict: true,
        workerId,
        previousIp: authRec.last_seen_ip,
        currentIp: directIp,
        error: `终端身份冲突：ID [${workerId}] 在 ${Math.round((Date.now() - lastSeenMs) / 1000)} 秒内先后从 ${authRec.last_seen_ip} 与 ${directIp} 上报。`
          + '该身份文件可能被复制到了另一台电脑。请在其中一台删除 worker_config.local.json 后重启，以“注册为新终端”的方式获得独立身份。'
      };
      db.prepare('UPDATE worker_access_auth SET conflict_flag = 1, conflict_note = ? WHERE worker_id = ?')
        .run(conflict.error, workerId);
    }
  }

  // 名称保留：管理员在协调端改过的名字，不能被心跳里的旧默认名覆盖（§4 / MW04）
  let nextName = existing ? existing.name : (name || 'Execution Worker');
  if (authRec && authRec.name_source === 'admin') {
    nextName = existing ? existing.name : nextName;
  } else if (name) {
    nextName = name;
  }

  if (existing) {
    db.prepare(`
      UPDATE workers SET name = ?, ip = ?, status = ?, working_dir = ?, printers = ?, last_heartbeat = ?
      WHERE id = ?
    `).run(nextName, directIp || reportedIp || existing.ip, status, workingDir || existing.working_dir, printersJson, now, workerId);
  } else {
    db.prepare(`
      INSERT INTO workers (id, name, ip, status, working_dir, printers, last_heartbeat)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(workerId, nextName, directIp || reportedIp || '', status, workingDir || '', printersJson, now);
  }

  db.prepare(`
    UPDATE worker_access_auth
    SET last_seen_at = ?, last_seen_ip = ?, last_seen_ua = ?, conflict_flag = CASE WHEN ? IS NULL THEN conflict_flag ELSE 1 END
    WHERE worker_id = ?
  `).run(now, directIp, String(req.headers['user-agent'] || '').slice(0, 200), conflict ? 1 : null, workerId);

  if (conflict) {
    logAudit(null, 'WORKER', 'WorkerService', 'WORKER_IDENTITY_CONFLICT', {
      workerId, previousIp: conflict.previousIp, currentIp: conflict.currentIp
    });
    return res.status(409).json({
      success: false,
      identityConflict: true,
      workerId,
      previousIp: conflict.previousIp,
      currentIp: conflict.currentIp,
      error: conflict.error
    });
  }

  res.json({
    success: true,
    workerId,
    registered: !!auth.firstTime,
    // 实际直连来源与终端自报地址分列，不默认填 127.0.0.1（§5 / MW-B05 / MW18）
    sourceIp: directIp,
    selfReportedIp: reportedIp || null,
    name: nextName,
    nameSource: authRec && authRec.name_source === 'admin' ? 'admin' : 'report',
    timestamp: now
  });
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
      // 直连来源地址（规范化显示）与终端自报地址分列，便于区分「显示成本机」与「真的连不上」(MW-B05/MW18)
      sourceIp: w.ip || '',
      nameSource: (() => {
        const rec = db.prepare('SELECT name_source, conflict_flag, conflict_note, registered_at FROM worker_access_auth WHERE worker_id = ?').get(w.id);
        return rec ? rec.name_source : 'report';
      })(),
      identityConflict: (() => {
        const rec = db.prepare('SELECT conflict_flag, conflict_note FROM worker_access_auth WHERE worker_id = ?').get(w.id);
        return rec && rec.conflict_flag ? { flagged: true, note: rec.conflict_note } : null;
      })(),
      printers: printersList,
      printerDetails
    };
  });

  if (!showAll) {
    return res.json(workers.filter(w => w.status !== 'OFFLINE'));
  }

  res.json(workers);
});

/**
 * 管理员修改执行端显示名称（§4：协调端改名后，心跳里的旧默认名不得覆盖）。
 * 改名后把 name_source 标记为 admin，心跳据此保留管理员名称（MW04）。
 */
app.post('/api/workers/:id/name', requireAdminAccess, (req, res) => {
  const workerId = req.params.id;
  const cleanName = String((req.body && req.body.name) || '').trim();
  if (!cleanName) return res.status(400).json({ error: '名称不能为空' });
  if (cleanName.length > 64) return res.status(400).json({ error: '名称过长（最多 64 字符）' });

  const existing = db.prepare('SELECT * FROM workers WHERE id = ?').get(workerId);
  if (!existing) return res.status(404).json({ error: `未找到已登记终端 ${workerId}` });

  db.prepare('UPDATE workers SET name = ? WHERE id = ?').run(cleanName, workerId);
  db.prepare(`
    INSERT INTO worker_access_auth (worker_id, secret_hash, registered_at, name_source)
    VALUES (?, '', ?, 'admin')
    ON CONFLICT(worker_id) DO UPDATE SET name_source = 'admin'
  `).run(workerId, new Date().toISOString());

  logAudit(null, 'ADMIN', 'Admin', 'RENAME_WORKER', { workerId, name: cleanName });
  res.json({ success: true, workerId, name: cleanName, nameSource: 'admin' });
});

/** 管理员清除身份冲突标记（在另一台电脑完成「注册为新终端」后使用，§4 / MW12） */
app.post('/api/workers/:id/clear-conflict', requireAdminAccess, (req, res) => {
  const workerId = req.params.id;
  const info = db.prepare(`
    UPDATE worker_access_auth SET conflict_flag = 0, conflict_note = NULL WHERE worker_id = ?
  `).run(workerId);
  if (info.changes === 0) return res.status(404).json({ error: `未找到终端接入记录 ${workerId}` });
  logAudit(null, 'ADMIN', 'Admin', 'CLEAR_WORKER_CONFLICT', { workerId });
  res.json({ success: true, workerId, identityConflict: null });
});

// ==================== PUBLISHED BUNDLES & MODELS ====================
// Helper: 目录边界按真实路径 + 相对路径判断，避免前缀误判与联接越界 (DIR-13, WC-08, 6.7)
const { isSubpath, safeRealPath, isSafePathSegment } = require('../worker/security');

// Helper: 读取执行端授权范围确认状态 (4.2 / 7.2)
// - EXPLICIT   : 管理员已显式配置业务路径，执行端必须严格校验，不得回退
// - UNCONFIRMED: 迁移自旧版本且从未配置业务路径，处于“待确认”，不默认放开
function getWorkerAuthState(workerId) {
  const row = db.prepare('SELECT * FROM worker_auth_state WHERE worker_id = ?').get(workerId);
  return row ? row.state : 'UNCONFIRMED';
}

function markWorkerAuthState(workerId, state, note) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO worker_auth_state (worker_id, state, updated_at, note)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(worker_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at, note = excluded.note
  `).run(workerId, state, now, note || null);
}

// Helper: 管理员配置业务路径后即进入严格校验状态（授权范围得到确认）
function confirmWorkerAuthScope(workerId, note) {
  markWorkerAuthState(workerId, 'EXPLICIT', note || '管理员已配置业务路径授权');
}

// Helper: 校验业务根路径是否位于某执行端当前授权范围（严格模式不做 legacy 回退）
function isPathInWorkerAllowedPathsDetailed(workerId, targetPath, opts = {}) {
  const requireWrite = opts.requireWrite !== false;
  const authState = getWorkerAuthState(workerId);

  const allowed = db.prepare('SELECT * FROM worker_allowed_paths WHERE worker_id = ? ORDER BY id ASC').all(workerId);
  if (allowed.length === 0) {
    if (authState !== 'EXPLICIT') {
      return {
        allowed: false,
        isLegacy: true,
        authState,
        reason: `执行端 [${workerId}] 尚未确认“允许访问的业务路径”授权范围，已按待确认状态暂停写入。请在终端详情页配置业务路径 (E04, 4.2, WC-04)`
      };
    }
    return {
      allowed: false,
      authState,
      reason: `执行端 [${workerId}] 已确认授权范围但当前没有任何“允许访问的业务路径”，拒绝写入 (E04, WC-08)`
    };
  }

  const writable = requireWrite ? allowed.filter(ap => ap.allow_write) : allowed;
  for (const ap of writable) {
    if (isSubpath(ap.root_path, targetPath)) {
      return { allowed: true, allowedPath: ap, authState };
    }
  }
  return {
    allowed: false,
    authState,
    reason: `保存根目录 [${targetPath}] 未包含在执行端允许${requireWrite ? '写入' : '访问'}的业务路径范围内 (E04, WC-08)`
  };
}

// 说明：所有调用点一律使用 isPathInWorkerAllowedPathsDetailed（严格模式，无 legacy 回退），
// 不再提供“无业务路径配置即视为放行”的兼容出口 (E04, 4.2, 7.2)。

app.get('/api/published-bundles', (req, res) => {
  const { workerId } = req.query;

  // Auto-heal / sync published bundles for any models that have valid published templates but no active bundle
  try {
    const publishedTmplModels = db.prepare("SELECT DISTINCT model FROM templates WHERE published_at IS NOT NULL").all();
    for (const row of publishedTmplModels) {
      const resolved = resolveModelAlias(row.model);
      const hasActive = db.prepare("SELECT 1 FROM published_bundles WHERE (model_id = ? OR model_display = ?) AND status = 'PUBLISHED'").get(resolved.modelId, row.model);
      if (!hasActive) {
        syncPublishedBundlesForModel(row.model);
      }
    }
  } catch (e) {
    console.warn('[SyncBundles Auto-Heal Warning]', e.message);
  }

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
      // 严格按模板稳定逻辑标识匹配配置：不得按型号模糊回退，避免跨终端/跨版本串配置 (4.3, WC-15, WC-16)
      let certCfg = certTmpl ? db.prepare('SELECT * FROM worker_save_configs WHERE worker_id = ? AND template_id = ? AND doc_type = ?').get(workerId, certTmpl.id, 'cert') : null;
      let packCfg = packTmpl ? db.prepare('SELECT * FROM worker_save_configs WHERE worker_id = ? AND template_id = ? AND doc_type = ?').get(workerId, packTmpl.id, 'packing') : null;

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
          const authCheck = isPathInWorkerAllowedPathsDetailed(workerId, certCfg.root_dir, { requireWrite: true });
          if (!authCheck.allowed) {
            isReady = false;
            unreadyReasons.push(`证书保存根目录未获写入授权：${authCheck.reason}`);
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
          const authCheck = isPathInWorkerAllowedPathsDetailed(workerId, packCfg.root_dir, { requireWrite: true });
          if (!authCheck.allowed) {
            isReady = false;
            unreadyReasons.push(`装箱清单保存根目录未获写入授权：${authCheck.reason}`);
          }
        }
      }

      // 授权变更后执行端尚未确认收到（旧授权仍可能生效）时，不得向手机宣称可用 (4.2, WC-18)
      if (isReady) {
        const pendingSync = db.prepare(`
          SELECT root_path, version, sync_status FROM worker_allowed_paths
          WHERE worker_id = ? AND sync_status != 'SYNCED'
        `).all(workerId);
        if (pendingSync.length > 0) {
          isReady = false;
          unreadyReasons.push(`业务路径授权变更尚未被执行端确认（待同步: ${pendingSync.map(p => p.root_path).join(', ')}），请等待执行端同步后再提交 (WC-18)`);
        }
      }

      let optionName = b.option_name;
      if (effectiveCombo === 'cert_and_packing') {
        optionName = b.model_display === 'POA200' ? '带泵' : '带清单';
      } else if (effectiveCombo === 'cert_only') {
        optionName = '仅证书';
      } else if (effectiveCombo === 'packing_only') {
        optionName = '仅清单';
      }

      validBundles.push({
        ...b,
        option_name: optionName,
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
    is_draft: !!t.draft_mappings,
    file_exists: !!(t.filepath && fs.existsSync(t.filepath))
  }));
  res.json(tmpls);
});

app.post('/api/templates/upload', requireAdminAccess, upload.single('templateFile'), (req, res) => {
  const { model, type, version = 'v1.0' } = req.body;
  if (!req.file || !model || !type) {
    return res.status(400).json({ error: 'templateFile, model, and type are required' });
  }

  const userModel = String(model).trim();
  const resolved = resolveModelAlias(userModel);
  try {
    const existingModel = db.prepare('SELECT id FROM models WHERE id = ?').get(resolved.modelId);
    if (!existingModel) {
      db.prepare('INSERT OR IGNORE INTO models (id, display_name, aliases, created_at) VALUES (?, ?, ?, ?)').run(
        resolved.modelId,
        userModel,
        JSON.stringify([userModel]),
        new Date().toISOString()
      );
    }
  } catch (e) {}
  const originalName = fixMulterFilename(req.file.originalname);
  const cleanKey = userModel.toLowerCase().replace(/[^a-zA-Z0-9_-]/g, '');
  const tmplId = `tmpl_${cleanKey || resolved.displayName.toLowerCase()}_${type}_${Date.now()}`;
  const destPath = path.join(uploadDir, `${tmplId}_${originalName}`);

  try {
    fs.renameSync(req.file.path, destPath);
    const sha256 = getFileSha256(destPath);
    const now = new Date().toISOString();

    db.prepare(`
      INSERT OR IGNORE INTO templates (id, model, type, filename, filepath, file_hash, version, field_mappings, published_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?)
    `).run(tmplId, userModel, type, originalName, destPath, sha256, version, now);

    logAudit(null, 'ADMIN', 'Admin', 'UPLOAD_TEMPLATE', { tmplId, model: userModel, type, originalName, sha256 });
    res.json({ success: true, tmplId, model: userModel, type, filename: originalName, sha256, version });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save template file: ' + err.message });
  }
});

app.get('/api/templates/:id/download', requireWorkerAuth, (req, res) => {
  const tmpl = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
  if (!tmpl || !fs.existsSync(tmpl.filepath)) {
    return res.status(404).json({ error: 'Template file not found' });
  }
  res.download(tmpl.filepath, tmpl.filename);
});

/**
 * 执行端下载本任务已回传原件的受控副本（REV183-10 / §6）。
 *
 * 用途：本机原件缺失或被清理时，允许从协调端下载副本到本机授权位置，
 * 并在打印前校验哈希；执行端不得直接打开协调端的盘符路径。
 * 归属校验：只有该任务的目标终端能下载（防串端）。
 */
app.get('/api/worker/tasks/:id/files/:fileType/download', requireWorkerAuth, (req, res) => {
  const { id, fileType } = req.params;
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) return res.status(404).json({ error: `未找到任务 ${id}` });

  const identity = req.workerIdentity;
  if (identity && identity.workerId && task.worker_id && identity.workerId !== task.worker_id) {
    return res.status(403).json({
      success: false,
      error: `任务 ${id} 归属终端 [${task.worker_id}]，当前身份 [${identity.workerId}] 无权下载原件`,
      code: 'TASK_OWNERSHIP_MISMATCH'
    });
  }

  const fileRec = db.prepare('SELECT * FROM task_files WHERE task_id = ? AND file_type = ?').get(id, fileType);
  if (!fileRec || !fileRec.server_filepath || !fs.existsSync(fileRec.server_filepath)) {
    return res.status(404).json({ error: `任务 ${id} 的 ${fileType} 副本不存在，无法下载`, code: 'SERVER_COPY_MISSING' });
  }

  // 明确告知执行端期望哈希，便于下载后校验；不返回凭据
  res.setHeader('x-file-sha256', fileRec.sha256 || '');
  res.setHeader('x-file-version', String(Math.round(fs.statSync(fileRec.server_filepath).mtimeMs)));
  res.download(fileRec.server_filepath, fileRec.official_filename);
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


/**
 * 证书测量表头检测：统一走“先识别区域，再匹配字段”（整改 3.1）。
 * 返回真实测量表头列名；解析产物无法保留坐标时返回 null，由调用方提示结构不可靠。
 */
function detectCertificateTableHeaders(docItems, model) {
  const regions = detectTableRegions(docItems, { type: 'cert' });
  const measurement = regions.find(r => r.kind === 'measurement');
  if (!measurement) return null;
  const labels = measurement.headerColumns
    .map(c => String(c.label).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return labels.length >= 2 ? labels : null;
}

/**
 * 清单表头自动发现：从模板真实表头得到业务字段（含“单位”），
 * 不再使用固定列表，也不把“主设备/传感器”当成列字段（整改 B02/B03）。
 */
function detectPackingHeaderLabels(docItems) {
  const regions = detectTableRegions(docItems, { type: 'packing' });
  const packing = regions.find(r => r.kind === 'packing');
  if (!packing) return null;
  const labels = [];
  for (const col of packing.headerColumns) {
    const label = String(col.label).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!label) continue;
    if (labels.includes(label)) continue;
    labels.push(label);
  }
  return labels.length >= 2 ? labels : null;
}

/**
 * 结构可靠性检查：二进制/回退解析若不能保留真实表格坐标，
 * 必须提示“结构不可靠”，阻止据此正式发布（整改 3.1）。
 */
function assessStructureReliability(docItems, regions) {
  const cells = (docItems || []).filter(x => x.type === 'cell');
  if (cells.length === 0) {
    return { reliable: false, reason: '未能从文档中提取任何表格单元格，可能缺少办公组件或文件格式不受支持' };
  }
  const tableCount = new Set(cells.map(c => c.tableIdx)).size;
  const hasNegativeOrMissing = cells.some(c => typeof c.tableIdx !== 'number' || typeof c.rowIdx !== 'number' || typeof c.colIdx !== 'number');
  if (hasNegativeOrMissing) {
    return { reliable: false, reason: '解析产物缺少真实的表格编号/行列坐标，无法可靠绑定发布' };
  }
  // 回退解析的特征：每个表格只有列号递增、行号不递增（坐标被扁平化）
  for (let t = 0; t < tableCount; t++) {
    const tCells = cells.filter(c => c.tableIdx === t);
    const rows = new Set(tCells.map(c => c.rowIdx));
    if (tCells.length >= 6 && rows.size <= 1) {
      return { reliable: false, reason: '表格坐标被扁平化为单一数据行，无法可靠区分表头与数据区' };
    }
  }
  if (!regions || regions.length === 0) {
    return { reliable: false, reason: '未能定位到可用的表格区域（表头/数据区）' };
  }
  return { reliable: true, reason: '' };
}

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

  const regions = detectTableRegions(docItems, { type: tmpl.type === 'packing' ? 'packing' : 'cert' });
  const reliability = assessStructureReliability(docItems, regions);

  let targetLabels = [];
  if (tmpl.type === 'cert') {
    const baseCertLabels = ['Inst. SN.', 'Instrument', 'Date:', 'Ambient Temperature:', 'Relative Humidity'];
    const detectedTableCols = detectCertificateTableHeaders(docItems, tmpl.model);
    if (detectedTableCols && detectedTableCols.length >= 2) {
      targetLabels = [...baseCertLabels, ...detectedTableCols];
    } else if (tmpl.model === '990') {
      targetLabels = [...baseCertLabels, 'NIST Traceable Standard ℃ dp', 'Analyzer ℃ dp'];
    } else if (tmpl.model === 'DPT810') {
      targetLabels = [...baseCertLabels, 'Analyzer Under Test mA'];
    } else {
      targetLabels = [...baseCertLabels, 'Analyzer pv ppm'];
    }
  } else {
    const packingLabels = detectPackingHeaderLabels(docItems);
    targetLabels = packingLabels && packingLabels.length >= 2
      ? packingLabels
      : ['名称', '规格', '数量', '单位', '标配', '备注'];
  }

  const matchResults = {};
  targetLabels.forEach(lbl => {
    matchResults[lbl] = findFieldCandidates(lbl, docItems, { type: tmpl.type === 'packing' ? 'packing' : 'cert', regions });
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
    tableRegions: regions,
    structureReliability: reliability,
    docItems
  });
});

app.post('/api/templates/match-candidates', (req, res) => {
  const { targetLabel, docItems = [], type = 'cert', regions } = req.body;
  if (!targetLabel) return res.status(400).json({ error: 'targetLabel required' });

  const result = findFieldCandidates(targetLabel, docItems, { type, regions });
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

    // 区域一致性 / 固定行数 / 默认值完整性校验（整改 3.2, M11）
    // 仅当本次发布实际提交了测量表格区配置时校验，避免把历史模板的发布请求一律拒绝。
    const submittedTableConfig = (fieldMappings || {}).tableConfig;
    const submittedTestPoints = (fieldMappings || {}).testPoints;
    if (submittedTableConfig || Array.isArray(submittedTestPoints)) {
      let publishDocItems = [];
      if (fs.existsSync(filePath)) {
        try { publishDocItems = extractDocumentStructure(filePath); } catch (e) { publishDocItems = []; }
      }
      const tableErrors = validateCertificateTableConfig(mergedMappings, publishDocItems);
      if (tableErrors.length > 0) {
        return res.status(400).json({
          error: `无法发布：测量表格区配置不一致（${tableErrors.join('；')}）。请重新分析并绑定后再发布。`,
          errorCode: 'TABLE_CONFIG_INVALID'
        });
      }
    }
  }

  if (type === 'packing') {
    const packingItems = Array.isArray(mergedMappings.packingItems) ? mergedMappings.packingItems : [];
    const singleFields = Array.isArray(mergedMappings.singleFields) ? mergedMappings.singleFields : [];
    const columnLikeSingles = singleFields.filter(f => f && f.valueLocation && f.valueLocation.type === 'table_column');
    if (columnLikeSingles.length > 0 && (fieldMappings || {}).singleFields) {
      return res.status(400).json({
        error: `无法发布：装箱清单字段 (${columnLikeSingles.map(f => f.label).join(', ')}) 被误绑定成整列，请按模板真实表头重新绑定。`,
        errorCode: 'PACKING_FIELD_INVALID'
      });
    }
    if (Array.isArray((fieldMappings || {}).packingItems) && packingItems.length === 0) {
      return res.status(400).json({
        error: '无法发布：装箱清单模板缺少物料行数据，请先完成清单表头识别与保存。',
        errorCode: 'PACKING_ROWS_MISSING'
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
  const authState = getWorkerAuthState(workerId);
  const noteRow = db.prepare('SELECT note FROM worker_auth_state WHERE worker_id = ?').get(workerId);

  // 旧版本前端按数组消费，这里通过查询参数保留兼容输出 (4.2)
  if (req.query.format === 'array') return res.json(paths);

  res.json({
    workerId,
    authState,
    authStateNote: noteRow ? noteRow.note : null,
    allowedPaths: paths
  });
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

    // 管理员显式配置业务路径即视为授权范围已确认，之后执行端与协调服务均按严格模式校验 (4.2, 7.2)
    confirmWorkerAuthScope(workerId, `管理员配置业务路径 [${cleanPath}]`);
    logAudit(null, 'ADMIN', 'System', 'SAVE_WORKER_ALLOWED_PATH', {
      workerId, pathId, rootPath: cleanPath, allowRead: allowReadInt, allowWrite: allowWriteInt, allowCreate: allowCreateInt, version
    });

    res.json({ success: true, allowedPath: saved, authState: 'EXPLICIT' });
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

  // 撤销授权后必须让执行端确认收到；未确认前不得再依据旧授权执行写入 (4.2, WC-18, WC-20)
  const remaining = db.prepare('SELECT COUNT(*) AS cnt FROM worker_allowed_paths WHERE worker_id = ?').get(workerId);
  if (remaining.cnt === 0) {
    markWorkerAuthState(workerId, 'EXPLICIT', '所有业务路径授权已被撤销，执行端不得再写入任何业务目录 (4.2, WC-20)');
  }
  logAudit(null, 'ADMIN', 'System', 'DELETE_WORKER_ALLOWED_PATH', { workerId, pathId: id, rootPath: ap.root_path });

  res.json({ success: true, remainingPaths: remaining.cnt, authState: getWorkerAuthState(workerId) });
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

  // FIX-02: Filter out orphaned test templates/residue and pick latest published templates per model & doc_type
  const allTmpls = db.prepare(`
    SELECT * FROM templates 
    WHERE id NOT LIKE 'tmpl_dummy_%' AND id NOT LIKE 'tmpl_test_%'
    ORDER BY published_at DESC, rowid DESC
  `).all();

  const grouped = new Map();
  allTmpls.forEach(t => {
    const key = `${t.model}_${t.type}`;
    if (!grouped.has(key)) {
      grouped.set(key, t);
    } else {
      const existing = grouped.get(key);
      if (!existing.published_at && t.published_at) {
        grouped.set(key, t);
      }
    }
  });

  const selectedTmpls = Array.from(grouped.values()).sort((a, b) => a.model.localeCompare(b.model) || a.type.localeCompare(b.type));

  const configs = db.prepare("SELECT * FROM worker_save_configs WHERE worker_id = ?").all(workerId);
  const map = new Map();
  configs.forEach(c => map.set(`${c.template_id}_${c.doc_type}`, c));

  const result = selectedTmpls.map(t => {
    const cfg = map.get(`${t.id}_${t.type}`);
    map.delete(`${t.id}_${t.type}`);
    const fileExists = !!(t.filepath && fs.existsSync(t.filepath));
    const isDraft = !!t.draft_mappings || !t.published_at;
    const isValid = fileExists && !isDraft;

    let statusNote = 'OK';
    if (!fileExists) {
      statusNote = '文件缺失';
    } else if (isDraft) {
      statusNote = '草稿';
    }

    // 同步状态：仅“已下发并被执行端确认”的配置才视为同步完成 (4.2, WC-18)
    let syncStatus = 'NOT_CONFIGURED';
    if (cfg) {
      if (cfg.check_status === 'PASSED') syncStatus = 'SYNCED';
      else if (cfg.is_enabled) syncStatus = 'PENDING';
      else syncStatus = 'DISABLED';
    }

    return {
      template_id: t.id,
      model: t.model,
      doc_type: t.type,
      filename: t.filename,
      file_exists: fileExists,
      is_draft: isDraft,
      is_valid: isValid,
      status_note: statusNote,
      config_id: cfg ? cfg.id : null,
      is_enabled: isValid ? (cfg ? (cfg.is_enabled || 0) : 0) : 0,
      root_dir: cfg ? (cfg.root_dir || '') : '',
      save_mode: cfg ? (cfg.save_mode || 'direct') : 'direct',
      subfolder_rule: cfg ? (cfg.subfolder_rule || 'deviceSn') : 'deviceSn',
      allow_create: cfg ? (cfg.allow_create || 0) : 0,
      version: cfg ? cfg.version : 1,
      sync_status: syncStatus,
      check_status: cfg ? cfg.check_status : 'PENDING',
      check_message: cfg ? (cfg.check_message || '未配置') : '未配置',
      checked_at: cfg ? cfg.checked_at : null
    };
  });

  // 残留配置（模板已删除或不再作为最新版本出现）也必须可见，避免静默持有授权 (4.3)
  for (const [key, cfg] of map.entries()) {
    result.push({
      template_id: cfg.template_id,
      model: '(模板已失效)',
      doc_type: cfg.doc_type,
      filename: '(模板记录不存在或已删除)',
      file_exists: false,
      is_draft: false,
      is_valid: false,
      status_note: '模板缺失',
      is_orphaned: true,
      config_id: cfg.id,
      is_enabled: 0,
      root_dir: cfg.root_dir || '',
      save_mode: cfg.save_mode || 'direct',
      subfolder_rule: cfg.subfolder_rule || 'deviceSn',
      allow_create: cfg.allow_create || 0,
      version: cfg.version,
      sync_status: 'ORPHANED',
      check_status: cfg.check_status,
      check_message: '该配置对应的模板已不存在，请删除或重新为该终端选择模板后再配置',
      checked_at: cfg.checked_at
    });
  }

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

  const targetTmpl = db.prepare('SELECT * FROM templates WHERE id = ?').get(templateId);
  if (!targetTmpl) {
    return res.status(404).json({ error: '对应的模板记录不存在' });
  }
  const fileExists = !!(targetTmpl.filepath && fs.existsSync(targetTmpl.filepath));
  const isDraft = !!targetTmpl.draft_mappings || !targetTmpl.published_at;

  if (isEnabled && (!fileExists || isDraft)) {
    return res.status(400).json({
      error: `无法启用此模板：该模板当前状态为 [${!fileExists ? '文件缺失' : '草稿未发布'}]，禁止作为终端配置启用 (FIX-02, TL-10)`
    });
  }

  const cleanRootDir = (rootDir || '').trim();

  // 启用模板必须已配置保存根目录；未启用可先预配置目录 (4.3)
  if (isEnabled && !cleanRootDir) {
    return res.status(400).json({ error: '启用模板前必须先配置保存根目录，不允许以空目录启用 (4.3)' });
  }

  if (cleanRootDir) {
    const isAbs = path.isAbsolute(cleanRootDir) || /^[a-zA-Z]:[\\/]/.test(cleanRootDir);
    if (!isAbs) return res.status(400).json({ error: `保存根目录必须是合法的绝对路径: ${cleanRootDir}` });
    if (/[<>"|?*]/.test(cleanRootDir.replace(/^[a-zA-Z]:/, ''))) {
      return res.status(400).json({ error: `保存根目录包含系统非法字符: ${cleanRootDir}` });
    }

    // Validate authorized write path boundary with strict mode (E04, WC-08, 4.2)
    const authCheck = isPathInWorkerAllowedPathsDetailed(workerId, cleanRootDir, { requireWrite: true });
    if (!authCheck.allowed) {
      return res.status(400).json({ error: authCheck.reason, authState: authCheck.authState });
    }

    // 保存方式为子文件夹时，子文件夹规则字段必填 (4.3)
    if (saveMode === 'subfolder' && !String(subfolderRule || '').trim()) {
      return res.status(400).json({ error: '保存方式为按字段建立子文件夹时，子文件夹规则字段必填 (4.3)' });
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

  // 配置保存成功后，该终端的授权范围视为已确认，进入严格校验状态 (4.2, 7.2)
  confirmWorkerAuthScope(workerId, `管理员配置模板保存目录 [${cleanRootDir || '未配置'}]`);
  logAudit(null, 'ADMIN', 'System', 'SAVE_WORKER_TEMPLATE_CONFIG', {
    workerId, templateId, docType, rootDir: cleanRootDir, isEnabled: isEnabledInt, version
  });

  res.json({ success: true, config: saved, authState: getWorkerAuthState(workerId) });
});

// 删除某终端某模板的保存配置（含模板已失效的残留配置），避免遗留授权 (4.3)
app.delete('/api/admin/workers/:workerId/template-configs/:id', requireAdminAccess, (req, res) => {
  const { workerId, id } = req.params;
  const config = db.prepare('SELECT * FROM worker_save_configs WHERE id = ? AND worker_id = ?').get(id, workerId);
  if (!config) return res.status(404).json({ error: '目录配置不存在' });

  db.prepare('DELETE FROM worker_save_configs WHERE id = ?').run(id);
  db.prepare('DELETE FROM worker_directory_checks WHERE (target_id = ? OR config_id = ?)').run(id, id);
  logAudit(null, 'ADMIN', 'System', 'DELETE_WORKER_TEMPLATE_CONFIG', {
    workerId, configId: id, templateId: config.template_id, docType: config.doc_type, rootDir: config.root_dir
  });
  res.json({ success: true, id });
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

  // Validate allowed paths strictly: 未确认授权范围的终端不得通过此兼容接口扩大授权 (4.2, E04)
  const authCheck = isPathInWorkerAllowedPathsDetailed(workerId, rootDir, { requireWrite: true });
  if (!authCheck.allowed) {
    return res.status(400).json({ error: authCheck.reason, authState: authCheck.authState });
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
  confirmWorkerAuthScope(workerId, `管理员配置模板保存目录 [${rootDir}]`);
  logAudit(null, 'ADMIN', 'System', 'SAVE_WORKER_DIRECTORY_CONFIG', { configId, workerId, templateId, docType, rootDir });
  res.json({ success: true, config: saved, authState: getWorkerAuthState(workerId) });
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
app.get('/api/worker/directory-checks/pending', requireWorkerAuth, (req, res) => {
  const { workerId = 'worker-local' } = req.query;
  const checks = db.prepare(`
    SELECT * FROM worker_directory_checks
    WHERE worker_id = ? AND status = 'PENDING'
    ORDER BY id ASC
  `).all(workerId);
  res.json(checks);
});

app.post('/api/worker/directory-checks/result', requireWorkerAuth, (req, res) => {
  const { checkId, workerId, checkType = 'save_config', targetId, configId, version, status, message } = req.body;
  const finalId = targetId || configId;

  let applied = false;
  if (checkType === 'allowed_path') {
    const ap = db.prepare('SELECT * FROM worker_allowed_paths WHERE id = ?').get(finalId);
    // 旧版本的迟到结果不得覆盖新配置 (WC-17)
    if (ap && Number(ap.version) === Number(version)) {
      db.prepare(`
        UPDATE worker_allowed_paths
        SET check_status = ?, check_message = ?, sync_status = 'SYNCED', checked_at = ?
        WHERE id = ?
      `).run(status, message || '', new Date().toISOString(), finalId);

      // 写权限被撤销时，受影响的结果目录配置立即失效 (4.2, WC-18, WC-20)
      if (!ap.allow_write) {
        const affected = db.prepare('SELECT * FROM worker_save_configs WHERE worker_id = ?').all(ap.worker_id);
        for (const c of affected) {
          if (isSubpath(ap.root_path, c.root_dir)) {
            db.prepare(`
              UPDATE worker_save_configs
              SET check_status = 'PENDING', check_message = '所属业务路径已取消写权限，需重新授权并检查 (4.2)',
                  version = version + 1, updated_at = ?
              WHERE id = ?
            `).run(new Date().toISOString(), c.id);
          }
        }
      }
      applied = true;
    }
  } else {
    const config = db.prepare('SELECT * FROM worker_save_configs WHERE id = ?').get(finalId);
    if (config && Number(config.version) === Number(version)) {
      db.prepare(`
        UPDATE worker_save_configs
        SET check_status = ?, check_message = ?, checked_at = ?
        WHERE id = ?
      `).run(status, message || '', new Date().toISOString(), finalId);
      applied = true;
    }
  }

  // 仅当结果确实应用到当前版本时才将检查任务置为完成；旧结果保留待重新检查 (WC-17)
  if (checkId && applied) {
    db.prepare("UPDATE worker_directory_checks SET status = 'DONE' WHERE id = ?").run(checkId);
  } else if (checkId && workerId) {
    db.prepare("UPDATE worker_directory_checks SET status = 'STALE' WHERE id = ?").run(checkId);
  }

  res.json({ success: true, applied });
});

app.get('/api/worker/authorizations', requireWorkerAuth, (req, res) => {
  const { workerId } = req.query;
  if (!workerId) return res.status(400).json({ error: '缺少 workerId' });
  const paths = db.prepare('SELECT id, root_path, allow_read, allow_write, allow_create, version, sync_status FROM worker_allowed_paths WHERE worker_id = ?').all(workerId);
  res.json({
    workerId,
    authState: getWorkerAuthState(workerId),
    allowedPaths: paths
  });
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
        const authCheck = isPathInWorkerAllowedPathsDetailed(workerId, certCfg.root_dir, { requireWrite: true });
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
    if (!packTmpl && (resolvedModel.displayName.toUpperCase().includes('POA') || model === '3500')) {
      packTmpl = db.prepare("SELECT * FROM templates WHERE model = 'POA200' AND type = 'packing'").get();
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
        const authCheck = isPathInWorkerAllowedPathsDetailed(workerId, packCfg.root_dir, { requireWrite: true });
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

// Helper: 解析型号对应的公共模板（优先使用已发布版本，禁止跨型号乱套） (4.3)
function resolveModelTemplates({ bundle, model, displayName, fileType }) {
  let tmpl = null;
  const bundleField = fileType === 'cert' ? 'cert_template_id' : 'packing_template_id';
  if (bundle && bundle[bundleField]) {
    tmpl = db.prepare('SELECT * FROM templates WHERE id = ?').get(bundle[bundleField]);
  }
  if (!tmpl) {
    tmpl = db.prepare("SELECT * FROM templates WHERE (model = ? OR model = ?) AND type = ? AND published_at IS NOT NULL ORDER BY published_at DESC")
      .get(model, displayName, fileType);
  }
  if (!tmpl) {
    tmpl = db.prepare("SELECT * FROM templates WHERE (model = ? OR model = ?) AND type = ? ORDER BY published_at DESC")
      .get(model, displayName, fileType);
  }
  return tmpl;
}

// Helper: 校验某终端当前对某公共模板的启用/可用状态 (4.3, 5, WC-14)
// requireReady=true 时还会校验保存目录配置与检查状态
function evaluateWorkerTemplateFor(workerId, tmpl, docType, opts = {}) {
  const requireReady = opts.requireReady !== false;
  if (!tmpl) {
    return { ok: false, enabled: false, reason: `未找到对应型号的发货证书模板` };
  }
  const cfg = db.prepare('SELECT * FROM worker_save_configs WHERE worker_id = ? AND template_id = ? AND doc_type = ?')
    .get(workerId, tmpl.id, docType);
  if (!cfg) {
    return {
      ok: false,
      enabled: false,
      config: null,
      template: tmpl,
      reason: `执行端 [${workerId}] 缺少${docType === 'cert' ? '证书' : '装箱清单'}模板 [${tmpl.filename}] 的保存目录配置！(DIR-0${docType === 'cert' ? 6 : 7})`
    };
  }
  if (!cfg.is_enabled) {
    return {
      ok: false,
      enabled: false,
      config: cfg,
      template: tmpl,
      disabled: true,
      reason: `该模板已被管理员在执行端停用，请刷新页面重新获取可用模板 (WC-14)`
    };
  }
  if (!requireReady) {
    return { ok: true, enabled: true, config: cfg, template: tmpl };
  }
  if (!cfg.root_dir) {
    return {
      ok: false,
      enabled: true,
      config: cfg,
      template: tmpl,
      reason: `执行端 [${workerId}] 的${docType === 'cert' ? '证书' : '装箱清单'}模板 [${tmpl.filename}] 尚未配置保存根目录 (4.3)`
    };
  }
  if (cfg.check_status !== 'PASSED') {
    return {
      ok: false,
      enabled: true,
      config: cfg,
      template: tmpl,
      reason: `执行端 [${workerId}] 的${docType === 'cert' ? '证书' : '装箱清单'}模板 [${tmpl.filename}] 的保存目录尚未检查通过（当前状态: ${cfg.check_status}，原因: ${cfg.check_message || '待检查'}）！(DIR-0${docType === 'cert' ? 6 : 7})`
    };
  }
  const authCheck = isPathInWorkerAllowedPathsDetailed(workerId, cfg.root_dir, { requireWrite: true });
  if (!authCheck.allowed) {
    const docLabel = docType === 'cert' ? '证书' : '装箱清单';
    return {
      ok: false,
      enabled: true,
      config: cfg,
      template: tmpl,
      reason: `${docLabel}保存根目录 [${cfg.root_dir}] 未获写入授权：${authCheck.reason}`
    };
  }
  return { ok: true, enabled: true, config: cfg, template: tmpl, authState: authCheck.authState };
}

// Helper: 计算某终端某组合配置在业务路径授权变更未确认时是否可提交 (WC-18)
function getPendingAuthorizationSync(workerId) {
  return db.prepare("SELECT root_path, version, sync_status FROM worker_allowed_paths WHERE worker_id = ? AND sync_status != 'SYNCED'").all(workerId);
}

// Helper: 校验子文件夹规则求值并生成最终保存目录 (DIR-13, 4.3)
function buildTargetDirectory({ cfg, deviceSn, body }) {
  const rootDir = cfg.root_dir;
  let subfolderName = '';
  let targetDir = rootDir;
  if (cfg.save_mode === 'subfolder') {
    const ruleKey = cfg.subfolder_rule || 'deviceSn';
    const rawVal = ruleKey === 'deviceSn' ? String(deviceSn || '').trim() : String((body || {})[ruleKey] || '').trim();
    if (!rawVal) {
      return { error: `子文件夹规则字段 [${ruleKey}] 缺失或为空，无法建立子文件夹！(4.3)` };
    }
    if (!isSafePathSegment(rawVal)) {
      return { error: `子文件夹名称包含非法字符或试图跳出根目录 [${rawVal}]！(DIR-13)` };
    }
    subfolderName = rawVal;
    targetDir = path.join(rootDir, subfolderName);
    if (!isSubpath(rootDir, targetDir)) {
      return { error: `安全拦截：子文件夹路径试图跳出根目录范围！(DIR-13)` };
    }
  }
  return { rootDir, subfolderName, targetDir };
}

// Helper: 判断某终端已发布且已启用的模板组合 (4.3, 5, WC-12)
// 说明：证书/清单任一被启用即构成一种可提交组合；两者都未启用时返回 null
// （即使终端只存在“已配置但被停用”的记录，也返回可下载组合，以便提交时明确提示“已停用”，
//   绝不静默降级为另一种组合）
function resolveWorkerEnabledCombo(workerId, certTmpl, packTmpl) {
  const certEval = certTmpl ? evaluateWorkerTemplateFor(workerId, certTmpl, 'cert', { requireReady: false }) : { enabled: false };
  const packEval = packTmpl ? evaluateWorkerTemplateFor(workerId, packTmpl, 'packing', { requireReady: false }) : { enabled: false };
  const certPresent = Boolean(certTmpl) && (certEval.enabled || Boolean(certEval.config));
  const packPresent = Boolean(packTmpl) && (packEval.enabled || Boolean(packEval.config));
  const certEnabled = Boolean(certEval.enabled);
  const packEnabled = Boolean(packEval.enabled);

  let combo = null;
  if (certEnabled && packEnabled) combo = 'cert_and_packing';
  else if (certEnabled) combo = 'cert_only';
  else if (packEnabled) combo = 'packing_only';

  return { combo, certEnabled, packEnabled, certPresent, packPresent, certEval, packEval };
}

// ==================== TASK SUBMISSION & DEDUPLICATION ====================
/**
 * 证书测量表区域一致性校验（整改 3.2）。
 * 发布前必须确认：所有列属于同一区域；列键/位置不冲突；行数与模板数据区一致；
 * 单值字段没有混进测量列；默认数据没有被截断。
 */
function validateCertificateTableConfig(mappings, docItems) {
  const errors = [];
  const tc = mappings && mappings.tableConfig;
  const testPoints = Array.isArray(mappings && mappings.testPoints) ? mappings.testPoints : [];
  if (!tc) return ['缺少测量表格区配置 (tableConfig)'];

  const columns = Array.isArray(tc.columns) ? tc.columns : [];
  if (columns.length === 0) return ['测量表格区没有任何列'];

  const tableIdxs = new Set(columns.map(c => c.tableIdx === undefined ? tc.tableIdx : c.tableIdx));
  if (tableIdxs.size > 1) errors.push('测量列分布在多个表格中，必须属于同一个测量区域');

  const colIdxSeen = new Set();
  for (const col of columns) {
    const colIdx = typeof col.colIdx === 'number' ? col.colIdx : null;
    if (colIdx === null) {
      errors.push(`列 [${col.label || col.key}] 缺少真实列坐标`);
      continue;
    }
    if (colIdxSeen.has(colIdx)) errors.push(`列坐标 ${colIdx} 被多列重复使用`);
    colIdxSeen.add(colIdx);
  }

  const startRow = tc.startRow;
  const endRow = tc.endRow;
  if (typeof startRow !== 'number' || typeof endRow !== 'number' || endRow < startRow) {
    errors.push('测量数据行范围无效');
  } else {
    const templateRowCount = endRow - startRow + 1;
    if (testPoints.length !== templateRowCount) {
      errors.push(`测量数据行数 (${testPoints.length}) 与模板数据区行数 (${templateRowCount}) 不一致，证书测量表固定行数不得增删`);
    }
  }

  // 每行必须按稳定列键给出对应值，且维度与列数一致
  testPoints.forEach((tp, idx) => {
    const values = (tp && tp.values) || {};
    for (const col of columns) {
      const hasValue = Object.prototype.hasOwnProperty.call(values, col.key);
      if (!hasValue) {
        errors.push(`第 ${idx + 1} 行缺少列 [${col.label || col.key}] 的模板默认值`);
        break;
      }
    }
  });

  // 单值字段不得同时作为测量列出现
  const singleFields = Array.isArray(mappings.singleFields) ? mappings.singleFields : [];
  for (const sf of singleFields) {
    if (sf && sf.valueLocation && sf.valueLocation.type === 'table_column') {
      errors.push(`单值字段 [${sf.label}] 被绑定成整列测量数据`);
    }
  }

  // 若解析产物可用，校验列确实属于检测到的测量区域
  if (Array.isArray(docItems) && docItems.length > 0) {
    const regions = detectTableRegions(docItems, { type: 'cert' });
    const region = regions.find(r => r.kind === 'measurement');
    if (region && typeof tc.tableIdx === 'number' && tc.tableIdx !== region.tableIdx) {
      errors.push('测量列绑定的表格与模板检测到的测量区域不一致');
    }
  }

  return errors;
}

function parseTemplateMappings(tmpl) {
  if (!tmpl) return {};
  if (tmpl.mappings && typeof tmpl.mappings === 'object') return tmpl.mappings;
  try {
    return typeof tmpl.field_mappings === 'string' ? JSON.parse(tmpl.field_mappings || '{}') : (tmpl.field_mappings || {});
  } catch (e) {
    return {};
  }
}

/**
 * 校验提交的证书测量数据维度必须与受理时发布快照完全一致（整改 3.3）。
 * 绕过手机界面少一行、多一行、缺列、未知列都必须拒绝。
 */
function validateSubmittedTestPoints(testPoints, mappings) {
  const errors = [];
  const tc = mappings && mappings.tableConfig;
  const templatePoints = Array.isArray(mappings && mappings.testPoints) ? mappings.testPoints : [];
  if (!tc || !Array.isArray(tc.columns) || tc.columns.length === 0) {
    return { errors: ['证书模板缺少有效测量表格区，无法校验提交数据'], columns: [] };
  }
  const columns = tc.columns;

  if (!Array.isArray(testPoints) || testPoints.length === 0) {
    return { errors: ['提交的测量数据为空，无法生成证书'], columns };
  }
  if (templatePoints.length > 0 && testPoints.length !== templatePoints.length) {
    errors.push(`测量数据行数 (${testPoints.length}) 与模板固定行数 (${templatePoints.length}) 不一致`);
  }

  const knownKeys = new Set();
  columns.forEach(col => {
    if (col.key) knownKeys.add(String(col.key));
    knownKeys.add(String(col.colIdx));
    if (col.label) knownKeys.add(String(col.label));
  });

  testPoints.forEach((tp, idx) => {
    const values = (tp && tp.values) || {};
    const unknown = Object.keys(values).filter(k => !knownKeys.has(String(k)));
    if (unknown.length > 0) {
      errors.push(`第 ${idx + 1} 行包含模板中不存在的测量列: ${unknown.join(', ')}`);
    }
    for (const col of columns) {
      const hasKey = Object.prototype.hasOwnProperty.call(values, col.key);
      const hasIdx = Object.prototype.hasOwnProperty.call(values, String(col.colIdx));
      if (!hasKey && !hasIdx) {
        errors.push(`第 ${idx + 1} 行缺少测量列 [${col.label || col.key}]`);
      }
    }
  });

  return { errors, columns };
}

/**
 * 校验提交的装箱清单数据与模板真实行角色（整改 3.4）。
 *
 * 注意：模板中的保护行（主设备/传感器/参考仪器）由执行端按模板与表单参数写入，
 * 手机在“仅证书”组合下可能不提交清单明细，因此“提交数据里看不到保护行”本身不是错误；
 * 只有“提交数据把保护行改名/删除”或“模板没有传感器却凭空提交传感器行”才拒绝。
 */
function validateSubmittedPackingItems(packingItems, mappings) {
  const errors = [];
  const templateItems = Array.isArray(mappings && mappings.packingItems) ? mappings.packingItems : [];
  if (templateItems.length === 0) return errors;
  if (!Array.isArray(packingItems)) return errors;

  // 主设备行是模板的固定行，提交数据中删除/改名即拒绝（整改 3.4, P09）
  const templateMain = templateItems.find(it => it && (it.role === 'mainDevice' || String(it.name || '').trim() === '主设备'));
  if (templateMain) {
    const stillPresent = packingItems.some(pi => pi && (pi.role === 'mainDevice' || String(pi.name || '').trim() === '主设备'));
    if (!stillPresent) {
      errors.push(`保护行 [${templateMain.name || '主设备'}] 不允许删除或改名`);
    }
  }

  // 模板没有传感器行时，不允许凭空提交传感器行
  const templateHasSensor = templateItems.some(it => it && (it.role === 'sensor' || String(it.name || '').includes('传感器')));
  if (!templateHasSensor) {
    const fabricated = packingItems.find(pi => pi && (pi.role === 'sensor' || String(pi.name || '').includes('传感器')));
    if (fabricated) errors.push('该模板没有传感器行，提交数据中不得出现传感器行');
  }

  return errors;
}

app.post('/api/tasks/submit', (req, res) => {
  // 表单字段兼容：手机端历史上可能提交下划线命名，统一归一化，避免保存目录快照缺失字段 (J04)
  const formBody = { ...req.body };
  const aliasPairs = [
    ['deviceSn', 'device_sn'], ['salesPerson', 'sales_person'], ['shippingLocation', 'shipping_location'],
    ['sensorModel', 'sensor_model'], ['sensorSn', 'sensor_sn'], ['hasPump', 'has_pump'], ['certDate', 'cert_date'],
    ['packingItems', 'packing_items'], ['testPoints', 'test_points']
  ];
  for (const [camel, snake] of aliasPairs) {
    if ((formBody[camel] === undefined || formBody[camel] === '') && formBody[snake] !== undefined) formBody[camel] = formBody[snake];
  }

  const reqId = formBody.reqId;
  const clientId = formBody.clientId;
  const clientName = formBody.clientName;
  const workerId = formBody.workerId;
  const model = formBody.model;
  const bundleId = formBody.bundleId;
  const docCombo = formBody.docCombo;
  const deviceSn = formBody.deviceSn;
  const salesPerson = formBody.salesPerson;
  const shippingLocation = formBody.shippingLocation || '南京';
  const sensorModel = formBody.sensorModel;
  const sensorSn = formBody.sensorSn;
  const hasPump = formBody.hasPump === undefined ? true : formBody.hasPump;
  const certDate = formBody.certDate;
  const testPoints = formBody.testPoints || [];
  const packingItems = formBody.packingItems || [];
  const overwriteConfirmed = Boolean(formBody.overwriteConfirmed);

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

  // Sensor Model option validation against sensor_configs table if configured for the model
  try {
    const sensorCfg = db.prepare('SELECT * FROM sensor_configs WHERE LOWER(TRIM(model)) = LOWER(?)').get(resolvedModel.displayName);
    if (sensorCfg) {
      const options = JSON.parse(sensorCfg.sensor_options || '[]');
      if (options.length > 0) {
        if (sensorModel && !options.includes(sensorModel)) {
          return res.status(400).json({
            error: `传感器型号 [${sensorModel}] 不属于型号 (${resolvedModel.displayName}) 已配置的有效选项列表 (${options.join(', ')})！`
          });
        }
      } else if (sensorModel) {
        return res.status(400).json({
          error: `设备型号 (${resolvedModel.displayName}) 未配置有效的传感器型号，拒绝提交传感器参数！`
        });
      }
    } else if (sensorModel) {
      return res.status(400).json({
        error: `设备型号 (${resolvedModel.displayName}) 未配置传感器型号选项，拒绝提交传感器参数！`
      });
    }
  } catch (e) {
    if (e.message && e.message.includes('拒绝')) {
      return res.status(400).json({ error: e.message });
    }
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

  // Determine doc combo: 以本终端实际启用的模板为准，服务端权威校验组合，拒绝手机伪造 docCombo (5, WC-15)
  const certTmplForCombo = resolveModelTemplates({ bundle, model, displayName: resolvedModel.displayName, fileType: 'cert' });
  const packTmplForCombo = resolveModelTemplates({ bundle, model, displayName: resolvedModel.displayName, fileType: 'packing' });
  const enabledCombo = resolveWorkerEnabledCombo(workerId, certTmplForCombo, packTmplForCombo);

  if (!enabledCombo.certEnabled && !enabledCombo.packEnabled) {
    // 终端确实持有该型号模板配置，但已被停用：必须明确提示“已停用/刷新”，不得静默降级 (WC-14)
    const disabledReasons = [enabledCombo.certEval, enabledCombo.packEval]
      .filter(ev => ev && ev.disabled)
      .map(ev => ev.reason);
    if (disabledReasons.length > 0) {
      return res.status(400).json({ error: disabledReasons.join('；') });
    }
    // 完全未配置：逐份文档说明缺少哪一项保存目录配置，避免笼统报错 (DIR-06, DIR-07)
    const missingConfigReasons = [enabledCombo.certEval, enabledCombo.packEval]
      .filter(ev => ev && ev.reason)
      .map(ev => ev.reason);
    if (missingConfigReasons.length > 0) {
      return res.status(400).json({ error: missingConfigReasons.join('；'), combo: null });
    }
    return res.status(400).json({
      error: `执行端 [${targetWorker.name || workerId}] 未启用该型号的任何模板（证书/清单均未启用），拒绝受理。请在终端详情页启用后再提交 (E03, WC-11)`
    });
  }

  const requestedCombo = docCombo || null;

  // 组合校验规则 (5, WC-12, WC-13, WC-15)：
  //   1. 请求组合属于“已启用集合”的子集时按请求生成（同一型号下可只出证书或只出清单）；
  //   2. 请求包含任何“未启用/未配置”的文档时一律拒绝，并指出具体文档，绝不静默降级；
  //   3. 未指定组合时使用已启用集合推导的完整组合。
  if (requestedCombo) {
    const wantsCert = requestedCombo === 'cert_and_packing' || requestedCombo === 'cert_only';
    const wantsPacking = requestedCombo === 'cert_and_packing' || requestedCombo === 'packing_only';

    if (!wantsCert && !wantsPacking) {
      return res.status(400).json({ error: `无法识别的文档组合 [${requestedCombo}]，已拒绝 (5)` });
    }

    if (wantsCert && !enabledCombo.certEnabled) {
      const ev = enabledCombo.certEval;
      const detail = ev && ev.reason ? ev.reason : `执行端 [${targetWorker.name || workerId}] 未启用发货证书模板`;
      return res.status(400).json({ error: `${detail}；请求组合 [${requestedCombo}] 中包含该文档，已拒绝且不降级为其他组合 (WC-13, WC-14)` });
    }

    if (wantsPacking && !enabledCombo.packEnabled) {
      const ev = enabledCombo.packEval;
      const detail = ev && ev.reason ? ev.reason : `执行端 [${targetWorker.name || workerId}] 未启用装箱清单模板`;
      return res.status(400).json({ error: `${detail}；请求组合 [${requestedCombo}] 中包含该文档，已拒绝且不降级为其他组合 (WC-13, WC-14)` });
    }
  }

  const effectiveCombo = requestedCombo || enabledCombo.combo;
  const createCert = effectiveCombo === 'cert_and_packing' || effectiveCombo === 'cert_only';
  const createPacking = effectiveCombo === 'cert_and_packing' || effectiveCombo === 'packing_only';

  // 说明：业务路径授权是否已同步、是否已被撤销，由“模板可见性接口”和“执行端执行前校验”负责拦截
  // （6.5：检查通过不是永久保证；6.6/WC-20：已受理任务仍须遵守当前路径权限），
  // 受理阶段不因授权快照未同步而拒绝，避免把已受理任务与权限变更顺序耦合。

  // Directory Configuration & Snapshotting (DIR-06, DIR-07, DIR-13, DIR-15)
  let certDirSnapshot = null;
  let packingDirSnapshot = null;

  if (createCert) {
    const certTmpl = resolveModelTemplates({ bundle, model, displayName: resolvedModel.displayName, fileType: 'cert' });

    if (!certTmpl) {
      return res.status(400).json({ error: `未找到 ${resolvedModel.displayName} 对应的发货证书模板` });
    }

    const certEval = evaluateWorkerTemplateFor(workerId, certTmpl, 'cert', { requireReady: true });
    if (!certEval.ok) {
      return res.status(400).json({ error: certEval.reason, docType: 'cert', enabled: certEval.enabled });
    }
    const certCfg = certEval.config;
    const certDir = buildTargetDirectory({ cfg: certCfg, deviceSn, body: req.body });
    if (certDir.error) return res.status(400).json({ error: certDir.error });

    certDirSnapshot = {
      targetDir: certDir.targetDir,
      rootDir: certDir.rootDir,
      subfolderName: certDir.subfolderName,
      configId: certCfg.id,
      version: certCfg.version
    };
  }

  if (createPacking) {
    const packTmpl = resolveModelTemplates({ bundle, model, displayName: resolvedModel.displayName, fileType: 'packing' });

    if (!packTmpl) {
      return res.status(400).json({ error: `未找到 ${resolvedModel.displayName} 对应的装箱清单模板` });
    }

    const packEval = evaluateWorkerTemplateFor(workerId, packTmpl, 'packing', { requireReady: true });
    if (!packEval.ok) {
      return res.status(400).json({ error: packEval.reason, docType: 'packing', enabled: packEval.enabled });
    }
    const packCfg = packEval.config;
    const packDir = buildTargetDirectory({ cfg: packCfg, deviceSn, body: req.body });
    if (packDir.error) return res.status(400).json({ error: packDir.error });

    packingDirSnapshot = {
      targetDir: packDir.targetDir,
      rootDir: packDir.rootDir,
      subfolderName: packDir.subfolderName,
      configId: packCfg.id,
      version: packCfg.version
    };
  }

  // 后端权威校验提交数据维度：绕过手机界面少一行/多一行/缺列/未知列一律拒绝 (整改 3.3, M12)
  // 仅在模板已发布有效测量表格区时生效；缺少表格区配置的模板由“未绑定/未发布”流程拦截。
  if (createCert) {
    const certTmplForDimension = resolveModelTemplates({ bundle, model, displayName: resolvedModel.displayName, fileType: 'cert' });
    const certMappings = parseTemplateMappings(certTmplForDimension);
    if (certMappings.tableConfig && Array.isArray(certMappings.tableConfig.columns) && certMappings.tableConfig.columns.length > 0) {
      const dim = validateSubmittedTestPoints(testPoints, certMappings);
      if (dim.errors.length > 0) {
        return res.status(400).json({
          error: `证书测量数据维度校验失败：${dim.errors.join('；')}`,
          errorCode: 'DIMENSION_MISMATCH',
          expectedColumns: dim.columns.map(c => ({ key: c.key, label: c.label, colIdx: c.colIdx }))
        });
      }
    }
  }

  if (createPacking) {
    const packTmplForDimension = resolveModelTemplates({ bundle, model, displayName: resolvedModel.displayName, fileType: 'packing' });
    const packMappings = parseTemplateMappings(packTmplForDimension);
    if (Array.isArray(packMappings.packingItems) && packMappings.packingItems.length > 0) {
      const packErrors = validateSubmittedPackingItems(packingItems, packMappings);
      if (packErrors.length > 0) {
        return res.status(400).json({ error: `装箱清单数据校验失败：${packErrors.join('；')}`, errorCode: 'PACKING_DIMENSION_MISMATCH' });
      }
    }
  }

  const ambientTemp = (req.body.ambientTemp !== undefined && req.body.ambientTemp !== null && req.body.ambientTemp !== '') ? String(req.body.ambientTemp) : '22.1';
  const relativeHumidity = (req.body.relativeHumidity !== undefined && req.body.relativeHumidity !== null && req.body.relativeHumidity !== '') ? String(req.body.relativeHumidity) : '50%RH';

  const acceptedAt = new Date().toISOString();
  const formData = JSON.stringify({
    salesPerson,
    shippingLocation,
    sensorModel: sensorModel ? String(sensorModel).trim() : undefined,
    sensorSn: resolvedModel.displayName === 'POA200' ? sensorSn : undefined,
    ambientTemp,
    relativeHumidity,
    hasPump: resolvedModel.displayName === 'POA200' ? hasPump : false,
    certDate,
    testPoints,
    packingItems: createPacking ? packingItems : [],
    overwriteConfirmed
  });

  let taskId;
  try {
    const result = db.prepare(`
      INSERT INTO tasks (req_id, client_id, client_name, worker_id, model, model_id, bundle_id, device_sn, status, accepted_at, form_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?, ?)
    `).run(reqId, clientId, clientName, workerId, resolvedModel.displayName, resolvedModel.modelId, bundleId || (bundle ? bundle.bundle_id : null), String(deviceSn), acceptedAt, formData);
    taskId = result.lastInsertRowid;
  } catch (dbErr) {
    console.error('[Task Submit DB Error]', dbErr);
    return res.status(500).json({ error: '数据库保存任务失败: ' + dbErr.message });
  }

  // Create Task Files with Target Directory Snapshot (DIR-15)
  if (createCert) {
    const certOfficialName = generateCertFilename({
      model: resolvedModel.displayName,
      deviceSn: String(deviceSn),
      acceptedDate: acceptedAt,
      salesPerson,
      shippingLocation,
      sensorModel: sensorModel ? String(sensorModel).trim() : undefined,
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
      shippingLocation,
      hasPump: Boolean(hasPump)
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
app.get('/api/worker/tasks/pending', requireWorkerAuth, (req, res) => {
  const { workerId = '' } = req.query;
  if (!workerId) return res.status(400).json({ error: '缺少 workerId，拒绝领取任务' });

  db.exec('BEGIN IMMEDIATE');
  try {
    // 多执行端归属（REV183-11 / MW17）：只领取派给本终端的任务。
    // 不得再用 'worker-local' / 'worker-e2e' 兜底抢单——否则任一终端都能把别人的任务领走。
    const task = db.prepare(`
      SELECT * FROM tasks
      WHERE status = 'QUEUED' AND worker_id = ?
      ORDER BY id ASC LIMIT 1
    `).get(workerId);

    if (task) {
      db.prepare("UPDATE tasks SET status = 'IN_PROGRESS', worker_id = ? WHERE id = ?").run(workerId, task.id);
      db.exec('COMMIT');

      let bundle = null;
      if (task.bundle_id) {
        bundle = db.prepare('SELECT * FROM published_bundles WHERE bundle_id = ?').get(task.bundle_id);
      }
      if (!bundle && task.model_id) {
        bundle = db.prepare('SELECT * FROM published_bundles WHERE model_id = ?').get(task.model_id);
      }

      // 修复：此前遗漏型号别名解析，导致 templateId 回退分支抛 ReferenceError 并被吞掉，任务永远派发不出去
      const taskModel = resolveModelAlias(task.model);

      const files = db.prepare('SELECT * FROM task_files WHERE task_id = ?').all(task.id).map(f => {
        let templateId = null;
        let fieldMappings = null;
        if (bundle) {
          if (f.file_type === 'cert') {
            templateId = bundle.cert_template_id;
            if (bundle.config_snapshot) {
              try {
                const snap = JSON.parse(bundle.config_snapshot);
                if (snap.certTemplate && snap.certTemplate.field_mappings) {
                  fieldMappings = snap.certTemplate.field_mappings;
                }
              } catch (e) {}
            }
          } else if (f.file_type === 'packing') {
            templateId = bundle.packing_template_id;
            if (bundle.config_snapshot) {
              try {
                const snap = JSON.parse(bundle.config_snapshot);
                if (snap.packingTemplate && snap.packingTemplate.field_mappings) {
                  fieldMappings = snap.packingTemplate.field_mappings;
                }
              } catch (e) {}
            }
          }
        }
        if (!templateId) {
          const tmpl = db.prepare("SELECT * FROM templates WHERE (model = ? OR model = ?) AND type = ? AND published_at IS NOT NULL ORDER BY published_at DESC")
            .get(task.model, taskModel.displayName, f.file_type);
          if (tmpl) {
            templateId = tmpl.id;
            fieldMappings = JSON.parse(tmpl.draft_mappings || tmpl.field_mappings || '{}');
          }
        }
        return {
          ...f,
          template_id: templateId,
          field_mappings: fieldMappings
        };
      });

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

app.post('/api/worker/tasks/:id/file-failed', requireWorkerAuth, (req, res) => {
  const taskId = req.params.id;
  const { fileType, errorMsg } = req.body;

  db.prepare(`
    UPDATE task_files SET status = 'FAILED', error_msg = ? WHERE task_id = ? AND file_type = ?
  `).run(errorMsg || 'Generation failed', taskId, fileType);

  const files = db.prepare('SELECT * FROM task_files WHERE task_id = ?').all(taskId);
  const anySuccess = files.some(f => f.status === 'PREVIEW_READY' || f.status === 'PRINTED');
  const allFinished = files.every(f => ['PREVIEW_READY', 'PREVIEW_FAILED', 'PRINTED', 'FAILED'].includes(f.status));

  if (allFinished && anySuccess) {
    // DIR-20: 证书与清单分别记录状态；其中一份失败时，不得将整个任务显示为全部成功。
    db.prepare("UPDATE tasks SET status = 'PARTIAL_SUCCESS', completed_at = ?, error_msg = ? WHERE id = ?").run(new Date().toISOString(), errorMsg || 'Partially failed', taskId);
  } else {
    db.prepare("UPDATE tasks SET status = 'FAILED', error_msg = ? WHERE id = ?").run(errorMsg || 'Generation failed', taskId);
  }

  logAudit(null, 'WORKER', 'WorkerService', 'FILE_FAILED', { taskId, fileType, errorMsg });
  res.json({ success: true, taskId, fileType });
});

app.post('/api/worker/tasks/:id/file-returned', requireWorkerAuth, upload.single('wordFile'), (req, res) => {
  const taskId = req.params.id;
  const { fileType, officialFilename, sha256, workerFilePath } = req.body;

  if (!req.file) return res.status(400).json({ error: 'No wordFile uploaded' });

  const destPath = path.join(returnedDir, `${taskId}_${fileType}_${req.file.originalname}`);
  fs.renameSync(req.file.path, destPath);

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);

  // 预览基于本任务实际生成并返回的 Word 文件转换；失败必须如实标记，不得伪造就绪 (整改 A.2/A.3)
  // 分阶段：Word→PDF、PDF→逐页图片；任一阶段失败都不算就绪 (PV05)
  let previewPayload = null;
  let previewError = null;
  try {
    previewPayload = generateDocumentPreview({
      sourcePath: destPath,
      previewDir,
      taskId,
      fileType,
      force: false
    });
  } catch (err) {
    previewError = err.message;
    console.error(`[Preview] task ${taskId} ${fileType} 预览生成失败(阶段 ${err.stage || 'unknown'}):`, err.message);
  }

  const fileStatus = previewError ? 'PREVIEW_FAILED' : 'PREVIEW_READY';
  const previewImagesJson = previewPayload ? JSON.stringify(previewPayload.pageUrls) : JSON.stringify([]);

  db.prepare(`
    UPDATE task_files
    SET server_filepath = ?, sha256 = ?, preview_images = ?, status = ?, error_msg = ?, worker_filepath = ?
    WHERE task_id = ? AND file_type = ?
  `).run(
    destPath,
    sha256 || getFileSha256(destPath),
    previewImagesJson,
    fileStatus,
    previewError,
    workerFilePath || null,
    taskId,
    fileType
  );

  const files = db.prepare('SELECT * FROM task_files WHERE task_id = ?').all(taskId);
  const anyFailed = files.some(f => f.status === 'FAILED' || f.status === 'PREVIEW_FAILED');
  const allFinished = files.every(f => ['PREVIEW_READY', 'PREVIEW_FAILED', 'PRINTED', 'FAILED'].includes(f.status));

  if (allFinished) {
    if (anyFailed) {
      // DIR-20：证书与清单分别记录状态；其中一份失败时，不得将整个任务显示为全部成功。
      db.prepare("UPDATE tasks SET status = 'PARTIAL_SUCCESS', completed_at = ? WHERE id = ?").run(new Date().toISOString(), taskId);
    } else {
      db.prepare("UPDATE tasks SET status = 'SUCCESS', completed_at = ? WHERE id = ?").run(new Date().toISOString(), taskId);
    }
  } else {
    db.prepare("UPDATE tasks SET status = 'IN_PROGRESS' WHERE id = ?").run(taskId);
  }

  logAudit(null, 'WORKER', 'WorkerService', 'FILE_RETURNED', {
    taskId, fileType, officialFilename, fileStatus, previewError,
    previewPages: previewPayload ? previewPayload.pages : null,
    previewEngine: previewPayload ? previewPayload.engine : null,
    previewImageEngine: previewPayload ? previewPayload.imageEngine : null
  });

  res.json({
    success: true,
    taskId,
    fileType,
    fileStatus,
    previewImages: previewPayload ? previewPayload.pageUrls : [],
    previewUrl: previewPayload ? previewPayload.pdfUrl : null,
    previewError,
    previewPages: previewPayload ? previewPayload.pages : null,
    previewEngine: previewPayload ? previewPayload.engine : null,
    previewImageEngine: previewPayload ? previewPayload.imageEngine : null
  });
});

/**
 * 仅重试预览：不重新生成原文档、不再次打印 (整改 A.4)
 */
app.post('/api/tasks/:id/files/:fileType/retry-preview', async (req, res) => {
  const { id, fileType } = req.params;
  const taskFile = db.prepare('SELECT * FROM task_files WHERE task_id = ? AND file_type = ?').get(id, fileType);
  if (!taskFile) return res.status(404).json({ error: '未找到对应的文件记录' });

  if (!taskFile.server_filepath || !fs.existsSync(taskFile.server_filepath)) {
    return res.status(400).json({
      error: '原 Word 文档不存在，无法重试预览。请重新生成该文档。',
      status: taskFile.status
    });
  }

  // 仅重做失败的那一阶段（PV04/PV05）：
  //  - 没有有效 PDF → 只重做 Word→PDF（下一阶段随之进行）
  //  - 已有有效 PDF → 只重做 PDF→页图，不重新转换、不重新生成 Word
  const pdfPath = getPreviewPdfPath(previewDir, id, fileType);
  const pdfUsable = isValidPdf(pdfPath)
    && fs.existsSync(pdfPath)
    && fs.statSync(pdfPath).mtimeMs >= fs.statSync(taskFile.server_filepath).mtimeMs;
  const forceStage = pdfUsable ? 'images' : 'pdf';
  if (forceStage === 'images') {
    // 只清理页图，保留有效 PDF
    const pageDir = getPreviewPageDir(previewDir, id, fileType);
    if (fs.existsSync(pageDir)) {
      for (const f of fs.readdirSync(pageDir)) {
        try { fs.unlinkSync(path.join(pageDir, f)); } catch (e) {}
      }
    }
  } else {
    clearDocumentPreview(previewDir, id, fileType);
  }

  try {
    const preview = generateDocumentPreview({
      sourcePath: taskFile.server_filepath,
      previewDir,
      taskId: id,
      fileType,
      forceStage
    });
    db.prepare(`
      UPDATE task_files SET preview_images = ?, status = 'PREVIEW_READY', error_msg = NULL
      WHERE task_id = ? AND file_type = ?
    `).run(JSON.stringify(preview.pageUrls), id, fileType);
    reconcileTaskStatus(id);
    logAudit(null, 'WORKER', 'WorkerService', 'RETRY_PREVIEW', {
      taskId: id, fileType, retryStage: forceStage, pages: preview.pages, imageEngine: preview.imageEngine
    });
    res.json({
      success: true,
      taskId: id,
      fileType,
      retryStage: forceStage,
      previewUrl: preview.pdfUrl,
      previewImages: preview.pageUrls,
      pages: preview.pages,
      engine: preview.engine,
      imageEngine: preview.imageEngine
    });
  } catch (err) {
    db.prepare(`
      UPDATE task_files SET status = 'PREVIEW_FAILED', error_msg = ?, preview_images = '[]'
      WHERE task_id = ? AND file_type = ?
    `).run(err.message, id, fileType);
    reconcileTaskStatus(id);
    res.status(500).json({
      success: false,
      error: err.message,
      failedStage: err.stage || forceStage,
      status: 'PREVIEW_FAILED'
    });
  }
});

/** 转换与页图渲染能力自检：能启动 Word 不代表能导出 PDF，如实报告检测到的组件与原因 (3.2) */
app.get('/api/preview/capabilities', (req, res) => {
  const caps = getConversionCapabilities();
  res.json({
    success: true,
    ...caps,
    wordToPdfReady: caps.wordToPdf.engines.length > 0,
    pdfToImageReady: caps.pdfToImage.engines.length > 0,
    notice: '这里只报告检测到的组件；真实可用性以实际转换结果为准。'
  });
});

/** 依据分文件状态重新汇总任务状态（一份成功一份失败不得报全部成功） */
function reconcileTaskStatus(taskId) {
  const files = db.prepare('SELECT * FROM task_files WHERE task_id = ?').all(taskId);
  const anyFailed = files.some(f => f.status === 'FAILED' || f.status === 'PREVIEW_FAILED');
  const allFinished = files.every(f => ['PREVIEW_READY', 'PREVIEW_FAILED', 'PRINTED', 'FAILED'].includes(f.status));
  if (!allFinished) {
    db.prepare("UPDATE tasks SET status = 'IN_PROGRESS' WHERE id = ?").run(taskId);
    return;
  }
  if (anyFailed) {
    db.prepare("UPDATE tasks SET status = 'PARTIAL_SUCCESS', completed_at = ? WHERE id = ?").run(new Date().toISOString(), taskId);
  } else {
    db.prepare("UPDATE tasks SET status = 'SUCCESS', completed_at = ? WHERE id = ?").run(new Date().toISOString(), taskId);
  }
}

// ==================== PRINT JOBS ====================
/**
 * 打印状态机（整改 4.3）
 *   QUEUED              手机已提交，等待执行端领取
 *   CLAIMED             执行端已原子领取
 *   DISPATCHING         正在调用打印能力
 *   SUBMITTED_TO_SPOOLER 已确认进入 Windows 打印队列（可带队列作业号）
 *   FAILED              明确失败（文件不存在/未授权/命令非零退出等）
 *   RESULT_UNKNOWN      已调用但结果无法确认（不得自动重印）
 */
const PRINT_JOB_FINAL_STATUSES = ['SUBMITTED_TO_SPOOLER', 'FAILED', 'RESULT_UNKNOWN'];

function parseSnapshotItems(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

/** 把某个文件项的状态汇总回打印任务状态 */
function reconcilePrintJobStatus(printJobId) {
  const items = db.prepare('SELECT * FROM print_job_items WHERE print_job_id = ? ORDER BY id ASC').all(printJobId);
  if (items.length === 0) return null;
  let overall;
  const nonFinal = items.filter(it => !PRINT_JOB_FINAL_STATUSES.includes(it.status));
  if (nonFinal.length > 0) {
    // 仍有文件未定案：报告推进到的最远阶段，且**进度不得回退**
    // （已有文件进入队列后，整体不能退回“仅领取”，否则手机看到的状态会倒退）(PR13/PV05 同思路)
    if (nonFinal.some(it => it.status === 'DISPATCHING')) {
      overall = 'DISPATCHING';
    } else if (items.some(it => it.status === 'SUBMITTED_TO_SPOOLER')) {
      overall = 'SUBMITTED_TO_SPOOLER';
    } else if (nonFinal.some(it => it.status === 'CLAIMED')) {
      overall = 'CLAIMED';
    } else {
      overall = 'QUEUED';
    }
  } else if (items.some(it => it.status === 'RESULT_UNKNOWN')) {
    overall = 'RESULT_UNKNOWN';
  } else if (items.every(it => it.status === 'SUBMITTED_TO_SPOOLER')) {
    overall = 'SUBMITTED_TO_SPOOLER';
  } else if (items.some(it => it.status === 'SUBMITTED_TO_SPOOLER')) {
    // 全部定案且部分成功：确定失败项不影响已进入队列的文件
    overall = 'PARTIAL_SUBMITTED';
  } else {
    overall = 'FAILED';
  }
  const firstError = items.find(it => it.error_msg && it.error_msg.trim());
  db.prepare('UPDATE print_jobs SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?')
    .run(overall, firstError ? firstError.error_msg : null, new Date().toISOString(), printJobId);
  return overall;
}

function serializePrintJob(job) {
  const items = db.prepare('SELECT * FROM print_job_items WHERE print_job_id = ? ORDER BY id ASC').all(job.id);
  return {
    ...job,
    batch_items: parseSnapshotItems(job.batch_items),
    items: items.map(it => ({
      id: it.id,
      taskId: it.task_id,
      taskFileId: it.task_file_id,
      fileType: it.file_type,
      officialFilename: it.official_filename,
      copies: it.copies,
      status: it.status,
      attempts: it.attempts,
      windowsJobId: it.windows_job_id,
      printerName: it.printer_name,
      errorMsg: it.error_msg,
      dispatchedAt: it.dispatched_at,
      updatedAt: it.updated_at,
      // 受理时确认的真实文件与内容版本：执行端据此校验并打印，不按文件名猜测 (PR-B04/PR14)
      snapshotPath: it.snapshot_path,
      sha256: it.sha256
    })),
    // 阶段语义提示：受理 ≠ 进入队列 ≠ 已出纸
    stageNotice: '“已受理/已排队”仅代表系统已登记；“SUBMITTED_TO_SPOOLER”代表已确认进入 Windows 打印队列，仍不等于实际出纸；结果不确定时必须人工核对后再决定是否重印。'
  };
}

app.post('/api/print/submit', (req, res) => {
  const body = req.body || {};
  const clientId = body.clientId;
  const requestId = body.requestId || body.reqId || null;
  const taskId = body.taskId;
  const printerName = String(body.printerName || body.printerId || '').trim();
  const batchItems = Array.isArray(body.batchItems) ? body.batchItems : [];

  if (!clientId) return res.status(400).json({ error: '缺少 clientId，拒绝受理打印' });
  if (!taskId) {
    return res.status(400).json({
      error: '缺少 taskId：打印必须关联已生成的真实任务文件，不能按文件名猜测 (PR-B03/PR-B04)',
      errorCode: 'TASK_REQUIRED'
    });
  }
  if (batchItems.length === 0) return res.status(400).json({ error: '缺少待打印文件清单 batchItems' });
  if (!printerName) return res.status(400).json({ error: '缺少目标打印机，拒绝受理打印' });

  // 幂等：同一 requestId 重复提交返回同一打印任务，避免重复出纸 (PR10)
  if (requestId) {
    const existing = db.prepare('SELECT * FROM print_jobs WHERE request_id = ?').get(requestId);
    if (existing) {
      return res.json({ success: true, printJobId: existing.id, status: existing.status, deduplicated: true, job: serializePrintJob(existing) });
    }
  }

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) return res.status(404).json({ error: `未找到任务 ${taskId}，拒绝受理打印` });

  const workerId = String(body.workerId || task.worker_id || '').trim();
  if (!workerId) return res.status(400).json({ error: '任务没有关联执行终端，拒绝受理打印' });

  const taskFiles = db.prepare('SELECT * FROM task_files WHERE task_id = ?').all(taskId);
  if (taskFiles.length === 0) return res.status(400).json({ error: `任务 ${taskId} 尚无生成文件，拒绝受理打印` });

  // 解析真实文件与内容版本；不信任手机提供的任何路径
  const resolved = [];
  for (const raw of batchItems) {
    const fileType = raw && raw.fileType ? String(raw.fileType) : '';
    const copiesRaw = raw && raw.copies !== undefined && raw.copies !== null && raw.copies !== '' ? Number(raw.copies) : 1;
    if (fileType !== 'cert' && fileType !== 'packing') {
      return res.status(400).json({ error: `不支持的 fileType [${fileType || '空'}]，仅允许 cert / packing`, errorCode: 'BAD_FILETYPE' });
    }
    if (!Number.isInteger(copiesRaw) || copiesRaw < 1 || copiesRaw > 99) {
      return res.status(400).json({ error: `份数非法 [${raw && raw.copies}]，必须是 1-99 的整数`, errorCode: 'BAD_COPIES' });
    }
    let fileRec = null;
    if (raw && raw.fileId !== undefined && raw.fileId !== null && String(raw.fileId).trim() !== '') {
      fileRec = taskFiles.find(f => String(f.id) === String(raw.fileId));
      if (!fileRec) {
        return res.status(404).json({ error: `任务 ${taskId} 中不存在 fileId [${raw.fileId}]，拒绝受理打印`, errorCode: 'FILE_NOT_FOUND' });
      }
      if (fileRec.file_type !== fileType) {
        return res.status(400).json({ error: `fileId [${raw.fileId}] 的实际类型为 ${fileRec.file_type}，与请求的 ${fileType} 不一致`, errorCode: 'FILETYPE_MISMATCH' });
      }
    } else {
      fileRec = taskFiles.find(f => f.file_type === fileType) || null;
      if (!fileRec) {
        return res.status(404).json({ error: `任务 ${taskId} 没有 ${fileType} 类型的文件，拒绝受理打印`, errorCode: 'FILE_NOT_FOUND' });
      }
    }
    if (!fileRec.server_filepath) {
      return res.status(400).json({ error: `${fileType} 文件尚未生成回传，拒绝受理打印`, errorCode: 'FILE_NOT_GENERATED' });
    }
    const snapshotHash = fileRec.sha256 || (fs.existsSync(fileRec.server_filepath) ? getFileSha256(fileRec.server_filepath) : null);
    if (!snapshotHash) {
      return res.status(400).json({ error: `${fileType} 文件内容无法确定（缺少哈希），拒绝受理打印`, errorCode: 'HASH_UNAVAILABLE' });
    }
    resolved.push({
      fileId: fileRec.id,
      fileType,
      officialFilename: fileRec.official_filename,
      copies: copiesRaw,
      // 执行端优先使用它自己保存的 worker_filepath；协调端保存副本仅作回退
      snapshotPath: fileRec.worker_filepath || fileRec.server_filepath,
      serverPath: fileRec.server_filepath,
      sha256: snapshotHash
    });
  }

  const createdAt = new Date().toISOString();
  const snapshot = resolved.map(r => ({
    fileId: r.fileId,
    fileType: r.fileType,
    copies: r.copies,
    sha256: r.sha256,
    officialFilename: r.officialFilename
  }));

  const result = db.prepare(`
    INSERT INTO print_jobs (client_id, worker_id, printer_name, batch_items, status, created_at, task_id, request_id, updated_at)
    VALUES (?, ?, ?, ?, 'QUEUED', ?, ?, ?, ?)
  `).run(clientId, workerId, printerName, JSON.stringify(snapshot), createdAt, taskId, requestId, createdAt);

  const printJobId = result.lastInsertRowid;
  const insertItem = db.prepare(`
    INSERT INTO print_job_items (
      print_job_id, task_id, task_file_id, file_type, official_filename,
      snapshot_path, sha256, copies, status, printer_name, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?)
  `);
  for (const r of resolved) {
    insertItem.run(printJobId, taskId, r.fileId, r.fileType, r.officialFilename, r.snapshotPath, r.sha256, r.copies, printerName, createdAt, createdAt);
    try {
      db.prepare('UPDATE task_files SET print_job_id = ? WHERE id = ?').run(printJobId, r.fileId);
    } catch (e) {}
  }

  logAudit(null, clientId, 'User', 'SUBMIT_PRINT_JOB', {
    printJobId, workerId, printerName, taskId, items: snapshot
  });

  const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(printJobId);
  res.json({
    success: true,
    printJobId,
    status: 'QUEUED',
    message: '系统已受理打印请求，等待执行端领取；受理不等于已进入打印机队列或已出纸。',
    job: serializePrintJob(job)
  });
});

/** 执行端查询某个打印文件项的真实保存路径（仅内部端口） */
app.get('/api/worker/tasks/print-item/:id/file', requireWorkerAuth, (req, res) => {
  const item = db.prepare('SELECT * FROM print_job_items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: `未找到打印文件项 ${req.params.id}` });
  res.json({
    success: true,
    printItemId: item.id,
    printJobId: item.print_job_id,
    taskId: item.task_id,
    taskFileId: item.task_file_id,
    fileType: item.file_type,
    snapshotPath: item.snapshot_path,
    workerFilePath: item.snapshot_path,
    sha256: item.sha256,
    copies: item.copies
  });
});

app.get('/api/print/pending', requireWorkerAuth, (req, res) => {
  const { workerId } = req.query;
  if (!workerId) return res.status(400).json({ error: '缺少 workerId，拒绝领取打印任务' });

  // 原子领取：只取本终端的任务，且状态必须仍为 QUEUED，避免多终端重复领取 (PR-B06/PR11)
  const candidates = db.prepare(
    "SELECT id FROM print_jobs WHERE worker_id = ? AND status = 'QUEUED' ORDER BY id ASC LIMIT 5"
  ).all(workerId);

  const claimJob = db.prepare(
    "UPDATE print_jobs SET status = 'CLAIMED', claimed_by = ?, claimed_at = ?, updated_at = ? WHERE id = ? AND status = 'QUEUED'"
  );
  const claimItem = db.prepare(
    "UPDATE print_job_items SET status = 'CLAIMED', attempts = attempts + 1, updated_at = ? WHERE print_job_id = ? AND status = 'QUEUED'"
  );

  const claimed = [];
  for (const c of candidates) {
    const now = new Date().toISOString();
    const info = claimJob.run(workerId, now, now, c.id);
    if (info.changes !== 1) continue; // 已被其他轮询领取
    claimItem.run(now, c.id);
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(c.id);
    claimed.push(serializePrintJob(job));
  }

  res.json(claimed);
});

/**
 * 手机查询打印任务状态（含每个文件独立状态；只读，允许对外端口）
 * 注意：必须注册在 `/api/print/pending` 之后，且只接受数字编号，
 * 否则 'pending' 之类固定子路径会被 `:id` 抢先匹配（路由顺序陷阱）。
 */
app.get('/api/print/:id(\\d+)', (req, res) => {
  const id = String(req.params.id);
  const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(id);
  if (!job) return res.status(404).json({ error: `未找到打印任务 ${id}` });
  res.json({ success: true, job: serializePrintJob(job) });
});

/** 执行端回报打印状态（仅内部端口） */
app.post('/api/print/:id/status', requireWorkerAuth, (req, res) => {
  const { id } = req.params;
  const { status, errorMsg, fileId, fileType, windowsJobId, printerName } = req.body || {};

  const allowed = ['CLAIMED', 'DISPATCHING', 'SUBMITTED_TO_SPOOLER', 'FAILED', 'RESULT_UNKNOWN', 'UNKNOWN'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `不支持的打印状态 [${status}]，已拒绝，避免写入未定义状态` });
  }

  // 打印任务归属校验：只允许目标任务所属终端回报，防 W2 越权更新 W1 任务 (§6 / MW16)
  const printJob = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(id);
  if (!printJob) return res.status(404).json({ error: `未找到打印任务 ${id}` });
  const identity = req.workerIdentity;
  if (identity && identity.workerId && printJob.worker_id && identity.workerId !== printJob.worker_id) {
    return res.status(403).json({
      success: false,
      error: `打印任务 ${id} 归属终端 [${printJob.worker_id}]，当前认证身份 [${identity.workerId}] 无权更新`,
      code: 'PRINT_JOB_OWNERSHIP_MISMATCH'
    });
  }

  const job = printJob;

  const now = new Date().toISOString();
  if (fileId || fileType) {
    // 单项状态：证书/清单分别记录，确定单项失败不影响已成功项 (PR13)
    const item = fileId
      ? db.prepare('SELECT * FROM print_job_items WHERE print_job_id = ? AND task_file_id = ?').get(id, fileId)
      : db.prepare('SELECT * FROM print_job_items WHERE print_job_id = ? AND file_type = ?').get(id, fileType);
    if (!item) {
      return res.status(404).json({ error: `打印任务 ${id} 中没有匹配的文件项 (fileId=${fileId || '-'}, fileType=${fileType || '-'})` });
    }
    db.prepare(`
      UPDATE print_job_items
      SET status = ?, error_msg = ?, windows_job_id = COALESCE(?, windows_job_id),
          printer_name = COALESCE(?, printer_name), dispatched_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      status === 'UNKNOWN' ? 'RESULT_UNKNOWN' : status,
      errorMsg || null,
      windowsJobId || null,
      printerName || null,
      now,
      now,
      item.id
    );
  } else if (status !== 'CLAIMED') {
    db.prepare('UPDATE print_jobs SET error_msg = ?, updated_at = ? WHERE id = ?').run(errorMsg || null, now, id);
  }

  // 每次回报后都汇总整体状态，否则任务会一直停留在 QUEUED (PR-B05)
  const overall = reconcilePrintJobStatus(id);
  logAudit(null, 'WORKER', 'PrintWorker', 'UPDATE_PRINT_STATUS', {
    printJobId: id, status, overall, fileId: fileId || null, fileType: fileType || null, windowsJobId: windowsJobId || null, errorMsg: errorMsg || null
  });
  const updated = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(id);
  res.json({ success: true, printJobId: Number(id), itemStatus: status, status: overall, job: serializePrintJob(updated) });
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
  const workerPort = internalPort();
  // 执行端接入口监听地址（整改 §3.2）：
  //  - 默认 0.0.0.0，使局域网内远程执行端可达；可用 INTERNAL_BIND 指定单个网卡地址，
  //    或设为 127.0.0.1 退回「仅协调机本机执行端」；
  //  - 该端口绝不可发布到公网隧道；远程接入的安全性由执行端身份凭据保证，而不是靠绑定地址。
  const workerBindHost = String(process.env.INTERNAL_BIND || process.env.WORKER_BIND || '0.0.0.0').trim() || '0.0.0.0';

  const startMainServer = () => {
    app.listen(PORT, () => {
      console.log('====================================================');
      console.log('协调服务 (Coordination Service) 启动成功！');
      console.log('====================================================');
      console.log(`- 对外服务端口: ${PORT}`);
      if (workerPort) {
        console.log(`- 执行端接入口已绑定: ${workerBindHost}:${workerPort}（隧道请勿发布该端口）`);
      } else {
        console.log('- 执行端接入口: 未启用（执行端接口与对外端口共用；公网暴露时建议设置 INTERNAL_PORT）');
      }
      console.log(`- 关键 API 路由已就绪:`);
      console.log(`  * GET  /api/published-bundles (获取已发布型号与文档组合配置)`);
      console.log(`  * POST /api/tasks/submit       (任务提交与重复校验)`);
      console.log(`  * GET  /api/workers            (执行终端心跳与状态列表)`);
      console.log(`  * POST /api/templates/publish  (模板三合一严格校验与动态组合生成)`);
      console.log(`- 协调管理控制台 (仅限本机直连，隧道访问会被拒绝): http://localhost:${PORT}/admin`);
      console.log(`- 手机端发货作业地址 (含访问口令): /frontend/index.html?k=<口令>`);
      console.log(`- 访问口令文件: ${path.join(__dirname, '../../data/access_token.txt')}`);
      console.log(`- 数据存储目录: ${path.join(__dirname, '../../data')}`);
      if (workerPort && workerBindHost !== '127.0.0.1' && workerBindHost !== 'localhost') {
        console.log(`- 远程执行端接入地址（在其它电脑上使用）:`);
        for (const ip of listLanIPv4()) {
          console.log(`    node src/worker/worker.js --server http://${ip}:${workerPort}`);
        }
        console.log(`  * 若远程电脑连接超时/被拒，请在协调电脑上**仅按需**放行可信局域网访问 TCP ${workerPort}`);
        console.log(`    例: New-NetFirewallRule -DisplayName "phoneApp Worker" -Direction Inbound -Protocol TCP -LocalPort ${workerPort} -Action Allow -Profile Private -RemoteAddress LocalSubnet`);
        console.log(`    （不要关闭整机防火墙，也不要把该端口发布到 Cloudflare 等公网隧道）`);
      }
      console.log('====================================================');
      console.log('等待手机端/前端连接，以及执行端 (worker.js) 上线...');
    });
  };

  if (workerPort && workerPort !== Number(PORT)) {
    const workerServer = app.listen(workerPort, workerBindHost, () => {
      startMainServer();
    });
    workerServer.on('error', (err) => {
      const hint = err.code === 'EADDRINUSE'
        ? `端口 ${workerPort} 已被占用，请释放该端口或改用其它 INTERNAL_PORT`
        : (err.code === 'EADDRNOTAVAIL'
          ? `绑定地址 ${workerBindHost} 在本机不存在，请改用本机实际网卡地址或 0.0.0.0`
          : err.message);
      console.error(`[严重] 执行端接入口 ${workerBindHost}:${workerPort} 启动失败: ${hint}`);
      console.error('       无法开启内部端口，服务已停止启动；请修正后重新启动。');
      process.exit(1);
    });
  } else {
    startMainServer();
  }
}

module.exports = app;
module.exports.isLocalhostRequest = isLocalhostRequest;
module.exports.resolveModelAlias = resolveModelAlias;
// 供回归测试直接调用真实生产校验逻辑（不使用源码字符串断言）
module.exports.validateSubmittedTestPoints = validateSubmittedTestPoints;
module.exports.validateSubmittedPackingItems = validateSubmittedPackingItems;
module.exports.validateCertificateTableConfig = validateCertificateTableConfig;
module.exports.detectPackingHeaderLabels = detectPackingHeaderLabels;
module.exports.detectCertificateTableHeaders = detectCertificateTableHeaders;
// 多执行端接入：身份/接入鉴权相关（供回归测试直接调用真实生产逻辑）
module.exports.authenticateWorker = authenticateWorker;
module.exports.registerWorkerSecret = registerWorkerSecret;
module.exports.hashWorkerSecret = hashWorkerSecret;
module.exports.normalizeClientIp = normalizeClientIp;
module.exports.listLanIPv4 = listLanIPv4;
module.exports.requireWorkerAuth = requireWorkerAuth;
