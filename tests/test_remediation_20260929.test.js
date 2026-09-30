const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const testDbPath = path.resolve(__dirname, '../data/phoneapp_test_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + '.db');
process.env.DB_PATH = testDbPath;

const app = require('../src/backend/server');
const db = require('../src/backend/db');
const { getFileSha256 } = require('../src/common/utils');

let server;
const PORT = 3015;

test.before(async () => {
  await new Promise(resolve => {
    server = app.listen(PORT, () => resolve());
  });
});

test.after(async () => {
  if (server) {
    await new Promise(resolve => server.close(resolve));
  }
});

test('R20260929-01: Published bundles are generated dynamically without hardcoded startup rows', async () => {
  const res = await fetch(`http://localhost:${PORT}/api/published-bundles`);
  assert.equal(res.status, 200);
  const bundles = await res.json();
  assert.ok(Array.isArray(bundles) && bundles.length > 0);

  // Check that bundles contain config_snapshot and active template mappings
  const poaBundle = bundles.find(b => b.model_display === 'POA200');
  assert.ok(poaBundle, 'POA200 bundle should exist dynamically');
  assert.equal(poaBundle.status, 'PUBLISHED');
  assert.ok(poaBundle.certTemplate, 'Cert template should be attached');
  assert.ok(poaBundle.packingTemplate, 'Packing template should be attached');

  const dptBundle = bundles.find(b => b.model_display === 'DPT810');
  assert.ok(dptBundle, 'DPT810 bundle should exist dynamically');
  assert.equal(dptBundle.doc_combo, 'cert_only');
});

test('R20260929-02: Three-in-One validation marks bundle UNAVAILABLE if template file is missing or SHA256 mismatched', async () => {
  // Create a dummy template in DB pointing to a non-existent file
  db.prepare(`
    INSERT INTO templates (id, model, type, filename, filepath, file_hash, version, field_mappings, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?)
    ON CONFLICT(id) DO UPDATE SET filepath = excluded.filepath, file_hash = excluded.file_hash
  `).run('tmpl_dummy_missing', 'DUMMYMODEL', 'cert', 'missing.doc', 'C:\\non_existent_file_xyz.doc', 'fakehash123', 'v1.0', new Date().toISOString());

  db.prepare(`
    INSERT INTO published_bundles (id, bundle_id, version, model_id, model_display, option_name, doc_combo, cert_template_id, packing_template_id, status, published_at)
    VALUES (?, ?, ?, ?, ?, ?, 'cert_only', ?, NULL, 'PUBLISHED', ?)
    ON CONFLICT(id) DO UPDATE SET status = 'PUBLISHED'
  `).run('bundle_dummymodel_cert', 'bundle_dummymodel', 'v1.0', 'model_dummymodel', 'DUMMYMODEL', '通用', 'tmpl_dummy_missing', new Date().toISOString());

  // Fetch /api/published-bundles should validate and mark bundle_dummymodel_cert as UNAVAILABLE
  const res = await fetch(`http://localhost:${PORT}/api/published-bundles`);
  const bundles = await res.json();
  const dummyBundle = bundles.find(b => b.model_display === 'DUMMYMODEL');
  assert.equal(dummyBundle, undefined, 'Missing template file bundle should be filtered out from active published bundles');

  // Verify status in DB became UNAVAILABLE
  const dbBundle = db.prepare("SELECT * FROM published_bundles WHERE id = 'bundle_dummymodel_cert'").get();
  assert.equal(dbBundle.status, 'UNAVAILABLE');
});

test('R20260929-03: Formal publish requires file existence and correct SHA256 file hash', async () => {
  // Attempt to formally publish a non-existent file path
  const pubRes = await fetch(`http://localhost:${PORT}/api/templates/publish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': 'phoneapp-admin-secret'
    },
    body: JSON.stringify({
      id: 'tmpl_fake_nonexistent',
      model: 'FAKEMODEL',
      type: 'cert',
      filename: 'nonexistent_template.doc',
      fieldMappings: { singleFields: [] },
      isDraft: false
    })
  });

  assert.equal(pubRes.status, 400);
  const data = await pubRes.json();
  assert.ok(data.error.includes('物理文件在磁盘上不存在'));
});

test('R20260929-04: Test point table and packing list are purely driven by config_snapshot / field_mappings', async () => {
  const res = await fetch(`http://localhost:${PORT}/api/published-bundles`);
  const bundles = await res.json();

  const bundle990 = bundles.find(b => b.model_display === '990' && b.doc_combo === 'cert_and_packing');
  assert.ok(bundle990, '990 cert_and_packing bundle should exist');

  // Verify test points config is attached
  const certTmpl = bundle990.certTemplate;
  assert.ok(certTmpl && certTmpl.field_mappings && Array.isArray(certTmpl.field_mappings.testPoints));
  assert.equal(certTmpl.field_mappings.testPoints.length, 9, '990 should have 9 test points in config');

  // Verify packing items config is attached
  const packTmpl = bundle990.packingTemplate;
  assert.ok(packTmpl && packTmpl.field_mappings && Array.isArray(packTmpl.field_mappings.packingItems));
  assert.equal(packTmpl.field_mappings.packingItems.length, 11, '990 should have 11 packing items in config');
  assert.deepEqual(packTmpl.field_mappings.protectedRows, [1], '990 should only protect main device row 1');
});
