const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const testDbPath = path.resolve(__dirname, '../data/phoneapp_test_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + '.db');
process.env.DB_PATH = testDbPath;
// 测试隔离：预览与回传产物不得写入生产 data/previews、data/returned
process.env.PREVIEW_DIR = path.join(path.dirname(testDbPath), 'previews_test_isolated');
process.env.RETURNED_DIR = path.join(path.dirname(testDbPath), 'returned_test_isolated');

const app = require('../src/backend/server');
const db = require('../src/backend/db');
const { extractDocumentStructure } = require('../src/common/doc_structure');
const { findFieldCandidates } = require('../src/common/matcher');
const { getFileSha256 } = require('../src/common/utils');

let server;
const PORT = 3025;

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

test('验收 1: 990 证书提取与匹配应保留全部 9 行测量数据，不能截断为 5 行样例', () => {
  const doc990Path = path.join(__dirname, '../samples/990-Ex-EX10260902发货证书.doc');
  assert.ok(fs.existsSync(doc990Path), '990 template must exist');

  const items = extractDocumentStructure(doc990Path);
  const matchResult = findFieldCandidates('NIST Traceable Standard', items, 'cert');

  assert.ok(matchResult.candidates.length > 0, 'Should find NIST Traceable Standard candidate');
  const candidate = matchResult.candidates[0];

  assert.ok(Array.isArray(candidate.sampleValues), 'Should have sampleValues');
  assert.ok(candidate.sampleValues.length <= 5, 'sampleValues should be preview sample');
  assert.ok(Array.isArray(candidate.fullValues), 'Should have fullValues');
  assert.equal(candidate.fullValues.length, 9, '990 cert must preserve all 9 full data rows');
  assert.equal(candidate.suggestedValueLocation.endRow - candidate.suggestedValueLocation.startRow + 1, 9, 'Row count must be 9');
});

test('验收 2: 统一手机读取协议与回显：990 发布组合包含完整 9 行测量点且实测值留空', async () => {
  const res = await fetch(`http://localhost:${PORT}/api/published-bundles`);
  const bundles = await res.json();
  const bundle990 = bundles.find(b => b.model_display === '990');

  assert.ok(bundle990, '990 bundle should be published and active');
  assert.ok(bundle990.certTemplate, 'Cert template must be present');

  const testPoints = bundle990.certTemplate.field_mappings.testPoints;
  assert.ok(Array.isArray(testPoints), 'testPoints must be an array');
  assert.equal(testPoints.length, 9, '990 must have exactly 9 test points');

  testPoints.forEach((tp, idx) => {
    assert.equal(tp.point, idx + 1, `Point index should be ${idx + 1}`);
    assert.ok(tp.std && tp.std.includes('℃ dp'), `Standard value should contain ℃ dp: ${tp.std}`);
    assert.equal(tp.act || '', '', 'Actual value must be empty string for mobile user input');
  });

  // Verify singleFields does NOT contain standard/actual column measurements
  const singleFields = bundle990.certTemplate.field_mappings.singleFields || [];
  const hasStdInSingle = singleFields.some(f => f.label.includes('Standard') || f.label.includes('NIST'));
  const hasActInSingle = singleFields.some(f => f.label.includes('Analyzer') || f.label.includes('Indication'));
  assert.equal(hasStdInSingle, false, 'Standard table column must not be placed in singleFields');
  assert.equal(hasActInSingle, false, 'Actual table column must not be placed in singleFields');
});

test('验收 3: 草稿与发布彻底分开：保存草稿不触发已发布组合变更，不改变手机可用配置', async () => {
  // 1. Initial snapshot of published bundles for 990
  const initialRes = await fetch(`http://localhost:${PORT}/api/published-bundles`);
  const initialBundles = await initialRes.json();
  const init990Bundle = initialBundles.find(b => b.model_display === '990');
  const initPublishedAt = init990Bundle ? init990Bundle.published_at : null;

  // 2. Save a draft modification with isDraft: true
  const draftRes = await fetch(`http://localhost:${PORT}/api/templates/publish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': 'phoneapp-admin-secret'
    },
    body: JSON.stringify({
      id: 'tmpl_990_cert',
      model: '990',
      type: 'cert',
      filename: '990-Ex-EX10260902发货证书.doc',
      fieldMappings: {
        draftNotice: 'DRAFT_IN_PROGRESS_TEST',
        singleFields: [
          { label: 'Inst. SN.', status: 'bound' }
        ]
      },
      isDraft: true
    })
  });

  assert.equal(draftRes.status, 200, 'Draft save should succeed');

  // 3. Fetch published bundles again: draft MUST NOT alter published_bundles
  const postDraftRes = await fetch(`http://localhost:${PORT}/api/published-bundles`);
  const postDraftBundles = await postDraftRes.json();
  const post990Bundle = postDraftBundles.find(b => b.model_display === '990');

  assert.ok(post990Bundle, '990 bundle must still exist');
  assert.equal(post990Bundle.published_at, initPublishedAt, 'Draft save must not alter published_at on bundle');
  assert.ok(post990Bundle.certTemplate.field_mappings.testPoints, 'Published bundle must retain published test points');
  assert.equal(post990Bundle.certTemplate.field_mappings.testPoints.length, 9, 'Published bundle must still have 9 rows');
  assert.equal(post990Bundle.certTemplate.field_mappings.draftNotice, undefined, 'Draft changes must not leak to mobile active bundles');
});

test('验收 4: 发布校验：证书模板缺少有效测量点表格区（标准值列/实测值列/数据行）时禁止正式发布', async () => {
  // Create a clean template for testing publish rejection
  const testTmplId = 'tmpl_test_cert_pub_validation';
  const certPath = path.join(__dirname, '../samples/990-Ex-EX10260902发货证书.doc');
  db.prepare(`
    INSERT INTO templates (id, model, type, filename, filepath, file_hash, version, field_mappings, published_at)
    VALUES (?, 'TESTMODEL', 'cert', '990-Ex-EX10260902发货证书.doc', ?, ?, 'v1.0', '{}', NULL)
    ON CONFLICT(id) DO UPDATE SET file_hash = excluded.file_hash, field_mappings = '{}'
  `).run(testTmplId, certPath, getFileSha256(certPath));

  // Attempt formal publication with NO tableConfig and empty testPoints
  const pubRes = await fetch(`http://localhost:${PORT}/api/templates/publish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': 'phoneapp-admin-secret'
    },
    body: JSON.stringify({
      id: testTmplId,
      model: 'TESTMODEL',
      type: 'cert',
      filename: '990-Ex-EX10260902发货证书.doc',
      fieldMappings: {
        singleFields: [
          { label: 'Inst. SN.', status: 'bound' }
        ],
        tableConfig: null,
        testPoints: []
      },
      isDraft: false
    })
  });

  assert.equal(pubRes.status, 400, 'Formal publish must be rejected with 400 when measurement table is missing');
  const errData = await pubRes.json();
  assert.ok(errData.error.includes('测量点表格区'), 'Error message should mention missing measurement table');

  // Draft save for the same incomplete template must succeed
  const draftRes = await fetch(`http://localhost:${PORT}/api/templates/publish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': 'phoneapp-admin-secret'
    },
    body: JSON.stringify({
      id: testTmplId,
      model: 'TESTMODEL',
      type: 'cert',
      filename: '990-Ex-EX10260902发货证书.doc',
      fieldMappings: {
        singleFields: [
          { label: 'Inst. SN.', status: 'bound' }
        ],
        tableConfig: null,
        testPoints: []
      },
      isDraft: true
    })
  });

  assert.equal(draftRes.status, 200, 'Draft save should be accepted even if table configuration is pending');
});
