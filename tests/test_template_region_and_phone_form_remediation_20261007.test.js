/**
 * 模板表格识别与手机表单整改回归测试 (2026-10-07)
 *
 * 覆盖 TEST.md 的 M01–M15、P01–P10 关键断言与整改文档 B01–B03：
 *   B01 单值字段不得升级为测量列、数据区不得跨区域拼接
 *   B02 清单“单位”首次自动发现必须来自真实表头，选中候选必须被尊重
 *   B03 清单行角色（主设备/传感器）来自模板，不虚构传感器行/单位/标配
 *
 * 所有样本使用 samples/ 下真实 .doc 模板与独立测试数据库，不写入生产库、预览或返回目录。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const vm = require('node:vm');

const testDbPath = path.resolve(__dirname, '../data/phoneapp_test_region_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + '.db');
process.env.DB_PATH = testDbPath;
process.env.PREVIEW_DIR = path.join(path.dirname(testDbPath), 'previews_test_isolated');
process.env.RETURNED_DIR = path.join(path.dirname(testDbPath), 'returned_test_isolated');

const app = require('../src/backend/server');
const db = require('../src/backend/db');
const { extractDocumentStructure } = require('../src/common/doc_structure');
const {
  findFieldCandidates, detectTableRegions, resolvePackingHeaderFields,
  assignPackingRowRoles, isSingleValueLabel, isMeasurementHeaderLabel
} = require('../src/common/matcher');
const { getFileSha256 } = require('../src/common/utils');

let server;
const PORT = 3081;

const SAMPLE_CERT_990 = path.join(__dirname, '../samples/990-Ex-EX10260902发货证书.doc');
const SAMPLE_CERT_POA200 = path.join(__dirname, '../samples/POA200证书AP10007513-20260403发南京订单-PSR-12-223(封装）带泵.doc');
const SAMPLE_PACK_POA200 = path.join(__dirname, '../samples/POA200(140)AP10007513发货清单20260403带泵.doc');
const SAMPLE_PACK_990 = path.join(__dirname, '../samples/990-Ex-EX10260902装箱清单.doc');

/** 人工核对的独立预期 manifest（由人工读取原件登记，不由解析器输出反推） */
const MANIFEST = {
  cert990: {
    tableIdx: 0,
    headerRow: 11,
    dataRows: 9,
    columns: [
      { colIdx: 1, label: 'Test point Number' },
      { colIdx: 2, label: 'NIST Traceable Standard ℃ dp' },
      { colIdx: 3, label: 'Analyzer ℃ dp' }
    ],
    singleValues: {
      'Inst. SN.': { rowIdx: 6, colIdx: 2, value: 'EX10260902' },
      'Instrument': { rowIdx: 5, colIdx: 2, value: 'DPT-990-Ex' }
    }
  },
  certPoa200: {
    tableIdx: 0,
    headerRow: 11,
    dataRows: 1,
    columns: [
      { colIdx: 1, label: 'Test Point Number' },
      { colIdx: 2, label: 'NIST Traceable Standard gas ppm' },
      { colIdx: 3, label: 'Analyzer pv ppm' }
    ],
    singleValues: {
      'Inst. SN.': { rowIdx: 6, colIdx: 2, value: 'AP10007513' },
      'Instrument': { rowIdx: 5, colIdx: 2, value: 'POA200' }
    }
  },
  packPoa200: {
    headerColumns: [
      { colIdx: 0, label: '序号' },
      { colIdx: 1, label: '名称' },
      { colIdx: 2, label: '规格/型号' },
      { colIdx: 3, label: '数量' },
      { colIdx: 4, label: '单位' },
      { colIdx: 5, label: '标配' },
      { colIdx: 6, label: '备注' }
    ],
    dataRows: 9,
    mainDeviceSn: 'AP10007513',
    sensorSn: '201N200258',
    sensorUnit: '只'
  },
  pack990: {
    headerColumns: [
      { colIdx: 0, label: '序号' },
      { colIdx: 1, label: '名称' },
      { colIdx: 2, label: '规格/型号' },
      { colIdx: 3, label: '数量' },
      { colIdx: 4, label: '单位' },
      { colIdx: 5, label: '标配' },
      { colIdx: 6, label: '备注' }
    ],
    dataRows: 11,
    mainDeviceSn: 'EX10260902',
    hasSensorRow: false
  }
};

function loadSandboxFromFile(file, extraGlobals = {}) {
  const code = fs.readFileSync(file, 'utf-8');
  const sandbox = {
    window: { location: { origin: 'http://localhost:3000' }, addEventListener: () => {} },
    document: {
      getElementById: () => ({ style: {}, innerHTML: '', innerText: '', value: '', set innerHTML(v) {}, set innerText(v) {} }),
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener: () => {}
    },
    localStorage: { getItem: () => null, setItem: () => {} },
    console,
    alert: () => {},
    ...extraGlobals
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox;
}

/** 运行 admin.js 的 saveMatchedRules 并返回提交的 payload */
async function runSaveMatchedRules(matcherData, extraGlobals = {}) {
  const adminFile = path.join(__dirname, '../src/frontend/admin.js');
  const sandbox = loadSandboxFromFile(adminFile, {
    escapeHtml: (s) => String(s === undefined || s === null ? '' : s),
    ...extraGlobals
  });
  sandbox.fixtureData = matcherData;
  vm.runInContext('currentMatcherData = fixtureData;', sandbox);
  // 复现真实分析页行为：先按模板区域自动补齐默认候选选择，再保存
  vm.runInContext('autoBindRegionColumns(fixtureData);', sandbox);
  sandbox.fetch = async (url, options) => {
    sandbox.lastSavedPayload = JSON.parse(options.body);
    return { ok: true, json: async () => ({ success: true }) };
  };
  await vm.runInContext('saveMatchedRules(false)', sandbox);
  return sandbox.lastSavedPayload;
}

test.before(async () => {
  await new Promise(resolve => {
    server = app.listen(PORT, () => resolve());
  });
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
});

// ==================== M01 / M03 / M04：区域与单值分类 ====================

test('M01: Date 与 Inst. SN. 是单值字段，不会因为下方有数字而升级成整列', () => {
  const rows = [
    ['Date:', '2026/10/07'],
    ['Test point Number', 'NIST Traceable Standard gas ppm', 'Analyzer pv ppm'],
    ['1', '10.10(N2 balance)', '9.96']
  ];
  const cells = rows.flatMap((row, r) => row.map((text, c) => ({ type: 'cell', tableIdx: 0, rowIdx: r, colIdx: c, text })));

  const dateMatch = findFieldCandidates('Date:', cells);
  assert.equal(dateMatch.inferredType, 'date', 'Date must stay a single-value date field, not a table');
  assert.deepEqual(
    dateMatch.candidates[0].suggestedValueLocation,
    { type: 'cell', tableIdx: 0, rowIdx: 0, colIdx: 1 },
    'Date must bind to the cell on its right'
  );
  assert.equal(dateMatch.candidates[0].candidateValue, '2026/10/07');

  // 测量表头仍然正确识别为整列
  const stdMatch = findFieldCandidates('NIST Traceable Standard gas ppm', cells);
  assert.equal(stdMatch.inferredType, 'table');
  assert.equal(stdMatch.candidates[0].suggestedValueLocation.type, 'table_column');
  assert.deepEqual(stdMatch.candidates[0].fullValues, ['10.10(N2 balance)']);

  // 特征值 'Test point Number' 属于区域锚点，不是业务必填单值字段
  assert.equal(isSingleValueLabel('Test point Number'), false);
  assert.equal(isMeasurementHeaderLabel('Test point Number'), true);
});

test('M03: 同一物理表格中的第二张表与说明行不跨区拼接', () => {
  const cells = [];
  const pushRow = (tableIdx, rowIdx, texts) => texts.forEach((text, c) => {
    if (text !== null) cells.push({ type: 'cell', tableIdx, rowIdx, colIdx: c, text });
  });

  // 表格 1：单值描述区 + 两行测量区
  pushRow(0, 0, ['Date:', '2026/10/07', null]);
  pushRow(0, 1, ['Test point Number', 'NIST Traceable Standard ppm', 'Analyzer ppm']);
  pushRow(0, 2, ['1', '10.0', '9.9']);
  pushRow(0, 3, ['2', '50.0', '49.8']);
  // 表格 2：说明/签章区，含相同列号
  pushRow(1, 0, ['说明', '本证书仅对本次校准有效', null]);
  pushRow(1, 1, ['Test point Number', 'NIST Traceable Standard ppm', 'Analyzer ppm']);
  pushRow(1, 2, ['1', '999', '888']);
  pushRow(1, 3, ['签名', '授权签字人', null]);

  const regions = detectTableRegions(cells, { type: 'cert' });
  const region0 = regions.find(r => r.tableIdx === 0);
  const region1 = regions.find(r => r.tableIdx === 1);

  assert.ok(region0, 'table 0 region detected');
  assert.equal(region0.rowCount, 2, 'table 0 data region must not include the description row');
  assert.ok(region1, 'table 1 region detected');
  assert.equal(region1.rowCount, 1, 'table 1 data region must stop before the signature row');

  const std = findFieldCandidates('NIST Traceable Standard ppm', cells, { type: 'cert', regions });
  const table0Values = ['10.0', '50.0'];
  const table1Values = ['999'];
  std.candidates.forEach(c => {
    if (!c.suggestedValueLocation || c.suggestedValueLocation.type !== 'table_column') return;
    const rows = c.fullValues || [];
    const fromTable0 = rows.some(v => table0Values.includes(v));
    const fromTable1 = rows.some(v => table1Values.includes(v));
    assert.equal(fromTable0 && fromTable1, false, 'A single column binding must not merge rows from two physical tables');
  });
});

// ==================== M04 / M07 / M08：真实模板行列与默认值 ====================

test('M04/M08: 990 证书按人工 manifest 识别 9 行 3 列，默认值不截断为 5 行', () => {
  assert.ok(fs.existsSync(SAMPLE_CERT_990), '990 sample must exist');
  const items = extractDocumentStructure(SAMPLE_CERT_990);
  const regions = detectTableRegions(items, { type: 'cert' });
  const region = regions.find(r => r.kind === 'measurement');

  assert.ok(region, 'measurement region detected');
  assert.equal(region.tableIdx, MANIFEST.cert990.tableIdx);
  assert.equal(region.headerRow, MANIFEST.cert990.headerRow, 'header row must match manual manifest');
  assert.equal(region.rowCount, MANIFEST.cert990.dataRows, 'data row count must equal manual manifest (9), not 5');
  assert.deepEqual(
    region.headerColumns.map(c => ({ colIdx: c.colIdx, label: c.label })),
    MANIFEST.cert990.columns,
    'columns must match manual manifest exactly (order + names)'
  );

  MANIFEST.cert990.columns.forEach(col => {
    const m = findFieldCandidates(col.label, items, { type: 'cert', regions });
    const c0 = m.candidates.find(c => c.suggestedValueLocation && c.suggestedValueLocation.colIdx === col.colIdx);
    assert.ok(c0, `column ${col.label} must bind to colIdx ${col.colIdx}`);
    assert.equal(c0.fullValues.length, 9, `column ${col.label} must keep all 9 full default values`);
  });
});

test('M04/M07: POA200 证书固定 1 行 3 列，单值字段各就各位', () => {
  assert.ok(fs.existsSync(SAMPLE_CERT_POA200), 'POA200 sample must exist');
  const items = extractDocumentStructure(SAMPLE_CERT_POA200);
  const regions = detectTableRegions(items, { type: 'cert' });
  const region = regions.find(r => r.kind === 'measurement');

  assert.ok(region);
  assert.equal(region.rowCount, MANIFEST.certPoa200.dataRows, 'POA200 cert must be a single fixed data row');
  assert.deepEqual(
    region.headerColumns.map(c => ({ colIdx: c.colIdx, label: c.label })),
    MANIFEST.certPoa200.columns
  );

  Object.entries(MANIFEST.certPoa200.singleValues).forEach(([label, expected]) => {
    const m = findFieldCandidates(label, items, { type: 'cert', regions });
    assert.equal(m.inferredType === 'table', false, `${label} must not be classified as a table`);
    const c0 = m.candidates[0];
    assert.deepEqual(c0.suggestedValueLocation, { type: 'cell', tableIdx: 0, rowIdx: expected.rowIdx, colIdx: expected.colIdx });
    assert.equal(c0.candidateValue, expected.value);
  });
});

// ==================== M09 / M11：发布映射与旧配置 ====================

test('M09: 多列不同哨兵值保存后互不覆盖，行数等于模板数据区，默认值逐格保留', async () => {
  const payload = await runSaveMatchedRules({
    template: { id: 'tmpl_poa3500_sentinel', type: 'cert', model: 'POA3500' },
    targetLabels: ['Inst. SN.', 'Step', 'Test Gas', 'Nominal Value ppm', 'Analyzer Reading ppm'],
    tableRegions: [{
      tableIdx: 0, kind: 'measurement', headerRow: 11,
      dataStartRow: 12, dataEndRow: 13, rowCount: 2, rowIndices: [12, 13],
      headerColumns: [
        { colIdx: 0, label: 'Step' }, { colIdx: 1, label: 'Test Gas' },
        { colIdx: 2, label: 'Nominal Value ppm' }, { colIdx: 3, label: 'Analyzer Reading ppm' }
      ],
      colStart: 0, colEnd: 3, ambiguous: false
    }],
    selectedChoices: { 'Inst. SN.': 0, 'Step': 0, 'Test Gas': 0, 'Nominal Value ppm': 0, 'Analyzer Reading ppm': 0 },
    matchResults: {
      'Inst. SN.': { candidates: [{ location: { type: 'cell', tableIdx: 0, rowIdx: 6, colIdx: 1 }, suggestedValueLocation: { type: 'cell', tableIdx: 0, rowIdx: 6, colIdx: 2 }, candidateValue: 'POA3500-101' }] },
      'Step': { candidates: [{ location: { type: 'cell', tableIdx: 0, rowIdx: 11, colIdx: 0 }, suggestedValueLocation: { type: 'table_column', tableIdx: 0, colIdx: 0, startRow: 12, endRow: 13 }, fullValues: ['1', '2'] }] },
      'Test Gas': { candidates: [{ location: { type: 'cell', tableIdx: 0, rowIdx: 11, colIdx: 1 }, suggestedValueLocation: { type: 'table_column', tableIdx: 0, colIdx: 1, startRow: 12, endRow: 13 }, fullValues: ['O2 in N2', 'CO in N2'] }] },
      'Nominal Value ppm': { candidates: [{ location: { type: 'cell', tableIdx: 0, rowIdx: 11, colIdx: 2 }, suggestedValueLocation: { type: 'table_column', tableIdx: 0, colIdx: 2, startRow: 12, endRow: 13 }, fullValues: ['SENTINEL-STD-1', 'SENTINEL-STD-2'] }] },
      'Analyzer Reading ppm': { candidates: [{ location: { type: 'cell', tableIdx: 0, rowIdx: 11, colIdx: 3 }, suggestedValueLocation: { type: 'table_column', tableIdx: 0, colIdx: 3, startRow: 12, endRow: 13 }, fullValues: ['SENTINEL-ACT-1', 'SENTINEL-ACT-2'] }] }
    }
  });

  const tc = payload.fieldMappings.tableConfig;
  assert.equal(tc.rowCount, 2, 'row count must equal the template data region');
  assert.equal(tc.rowStrategy, 'fixed');
  assert.deepEqual(tc.columns.map(c => c.label), ['Step', 'Test Gas', 'Nominal Value ppm', 'Analyzer Reading ppm']);

  const pts = payload.fieldMappings.testPoints;
  assert.equal(pts.length, 2, 'certificate keeps exactly the template row count');
  assert.equal(pts[0].values.col_2, 'SENTINEL-STD-1 ppm');
  assert.equal(pts[1].values.col_2, 'SENTINEL-STD-2 ppm');
  assert.equal(pts[0].values.col_3, 'SENTINEL-ACT-1 ppm', 'actual column must not be overwritten by the standard column');
  assert.equal(pts[1].values.col_3, 'SENTINEL-ACT-2 ppm');
  assert.equal(pts[0].values.col_0, '1');
  assert.equal(pts[1].values.col_0, '2');

  // 单值字段绝不进入测量列
  const singleLabels = payload.fieldMappings.singleFields.map(f => f.label);
  assert.equal(singleLabels.includes('Inst. SN.'), true, 'Inst. SN. must remain a single field');
  assert.equal(tc.columns.some(c => c.label === 'Inst. SN.'), false, 'Inst. SN. must not become a measurement column');
});

test('M09(b): 空值保持空、0 与负数不丢失，Gas 列语义不被改成 seq', async () => {
  const payload = await runSaveMatchedRules({
    template: { id: 'tmpl_poa3500_gas', type: 'cert', model: 'POA3500' },
    targetLabels: ['Inst. SN.', 'Gas', 'Value', 'Actual Reading mA'],
    tableRegions: [{
      tableIdx: 0, kind: 'measurement', headerRow: 11,
      dataStartRow: 12, dataEndRow: 14, rowCount: 3, rowIndices: [12, 13, 14],
      headerColumns: [
        { colIdx: 0, label: 'Gas' }, { colIdx: 1, label: 'Value' }, { colIdx: 2, label: 'Actual Reading mA' }
      ],
      colStart: 0, colEnd: 2, ambiguous: false
    }],
    selectedChoices: { 'Inst. SN.': 0, 'Gas': 0, 'Value': 0, 'Actual Reading mA': 0 },
    matchResults: {
      'Inst. SN.': { candidates: [{ location: { type: 'cell', tableIdx: 0, rowIdx: 6, colIdx: 1 }, suggestedValueLocation: { type: 'cell', tableIdx: 0, rowIdx: 6, colIdx: 2 }, candidateValue: 'POA3500-202' }] },
      'Gas': { candidates: [{ location: { type: 'cell', tableIdx: 0, rowIdx: 11, colIdx: 0 }, suggestedValueLocation: { type: 'table_column', tableIdx: 0, colIdx: 0, startRow: 12, endRow: 14 }, fullValues: ['Zero Air', 'Span Gas', ''] }] },
      'Value': { candidates: [{ location: { type: 'cell', tableIdx: 0, rowIdx: 11, colIdx: 1 }, suggestedValueLocation: { type: 'table_column', tableIdx: 0, colIdx: 1, startRow: 12, endRow: 14 }, fullValues: ['0', '-12.5', '50'] }] },
      'Actual Reading mA': { candidates: [{ location: { type: 'cell', tableIdx: 0, rowIdx: 11, colIdx: 2 }, suggestedValueLocation: { type: 'table_column', tableIdx: 0, colIdx: 2, startRow: 12, endRow: 14 }, fullValues: ['4.0', '12.0', ''] }] }
    }
  });

  const tc = payload.fieldMappings.tableConfig;
  assert.equal(tc.columns[0].label, 'Gas');
  assert.equal(tc.columns[0].role, 'gas', 'Gas column must keep text/gas role, never be promoted to seq');
  assert.equal(tc.columns[0].isSeq, false, 'Gas must not be treated as the sequence column');

  const pts = payload.fieldMappings.testPoints;
  // “Value”列自身不带单位，绝不补造 mA/单位文本（整改 3.3）
  assert.equal(tc.columns[1].unit, '');
  assert.equal(pts[0].values.col_1, '0', '0 must not be lost or turned into an empty value');
  assert.equal(pts[1].values.col_1, '-12.5', 'negative values must be preserved');
  assert.equal(pts[2].values.col_0, '', 'truly empty template cell must stay empty');
  assert.equal(pts[0].values.col_2, '4.0 mA', 'mA column keeps its own unit');
  assert.equal(pts[0].values.col_1.includes('mA'), false, 'mA unit must not leak into the Value column');
});

test('M11: 污染旧配置（Date 列、9 行）在分析页被标出并要求重新绑定', () => {
  const adminFile = path.join(__dirname, '../src/frontend/admin.js');
  const sandbox = loadSandboxFromFile(adminFile, { escapeHtml: (s) => String(s || '') });

  sandbox.analyzeData = {
    template: { type: 'cert', model: 'POA200', field_mappings: {} },
    tableRegions: [{ tableIdx: 0, kind: 'measurement', headerRow: 11, dataStartRow: 12, dataEndRow: 12, rowCount: 1, rowIndices: [12], headerColumns: [], colStart: 1, colEnd: 3, ambiguous: false }]
  };
  sandbox.savedData = {
    tableConfig: {
      tableIdx: 0, rowCount: 9, startRow: 12, endRow: 20,
      columns: [
        { key: 'col_1', label: 'Date:' },
        { key: 'col_2', label: 'NIST Traceable Standard gas ppm' }
      ]
    },
    testPoints: Array.from({ length: 9 }, (_, i) => ({ point: i + 1, values: {} })),
    singleFields: []
  };

  const warnings = vm.runInContext('validateLoadedTemplateConfig(analyzeData, savedData)', sandbox);
  assert.ok(warnings.some(w => w.includes('行数')), 'row count mismatch must be reported');
  assert.ok(warnings.some(w => w.includes('Date:')), 'Date column pollution must be reported');
});

// ==================== M12 / M15：发布与提交校验 ====================

test('M12: 后端拒绝绕过手机界面提交的不同维度测量数据', async () => {
  const { validateSubmittedTestPoints } = require('../src/backend/server');

  const mappings = {
    tableConfig: {
      tableIdx: 0, startRow: 12, endRow: 13, rowCount: 2,
      columns: [
        { key: 'col_1', label: 'Test point Number', colIdx: 1, isSeq: true },
        { key: 'col_2', label: 'NIST Traceable Standard gas ppm', colIdx: 2, isStd: true },
        { key: 'col_3', label: 'Analyzer pv ppm', colIdx: 3, isAct: true }
      ]
    },
    testPoints: [
      { point: 1, values: { col_1: '1', col_2: '9.96', col_3: '' } },
      { point: 2, values: { col_1: '2', col_2: '50.0', col_3: '' } }
    ]
  };

  // 基准：维度正确时必须通过
  const ok = validateSubmittedTestPoints([
    { point: 1, values: { col_1: '1', col_2: '9.96', col_3: '9.93' } },
    { point: 2, values: { col_1: '2', col_2: '50.0', col_3: '49.8' } }
  ], mappings);
  assert.deepEqual(ok.errors, [], 'valid dimensions must pass');

  // 少一行
  const tooFew = validateSubmittedTestPoints([{ point: 1, values: { col_1: '1', col_2: '9.96', col_3: '' } }], mappings);
  assert.ok(tooFew.errors.some(e => e.includes('行数')), 'missing row must be rejected');

  // 多一行
  const tooMany = validateSubmittedTestPoints([
    { point: 1, values: { col_1: '1', col_2: 'a', col_3: '' } },
    { point: 2, values: { col_1: '2', col_2: 'b', col_3: '' } },
    { point: 3, values: { col_1: '3', col_2: 'c', col_3: '' } }
  ], mappings);
  assert.ok(tooMany.errors.some(e => e.includes('行数')), 'extra row must be rejected');

  // 缺列
  const missingCol = validateSubmittedTestPoints([
    { point: 1, values: { col_1: '1', col_2: 'a' } },
    { point: 2, values: { col_1: '2', col_2: 'b' } }
  ], mappings);
  assert.ok(missingCol.errors.some(e => e.includes('col_3') || e.includes('Analyzer')), 'missing column must be rejected');

  // 未知列
  const unknownCol = validateSubmittedTestPoints([
    { point: 1, values: { col_1: '1', col_2: 'a', col_3: 'b', hacked: 'x' } },
    { point: 2, values: { col_1: '2', col_2: 'a', col_3: 'b' } }
  ], mappings);
  assert.ok(unknownCol.errors.some(e => e.includes('hacked')), 'unknown column must be rejected');
});

test('M15: /api/templates/:id/analyze 对真实 POA200 证书返回区域、可靠性与真实列', async () => {
  const tmplId = 'tmpl_test_region_poa200_cert';
  db.prepare(`
    INSERT INTO templates (id, model, type, filename, filepath, file_hash, version, field_mappings, published_at)
    VALUES (?, 'POA200', 'cert', ?, ?, ?, 'v1.0', '{}', NULL)
    ON CONFLICT(id) DO UPDATE SET filepath = excluded.filepath, file_hash = excluded.file_hash
  `).run(tmplId, path.basename(SAMPLE_CERT_POA200), SAMPLE_CERT_POA200, getFileSha256(SAMPLE_CERT_POA200));

  const res = await fetch(`http://localhost:${PORT}/api/templates/${tmplId}/analyze`);
  assert.equal(res.status, 200);
  const data = await res.json();

  assert.equal(data.structureReliability.reliable, true, 'real Word template structure must be usable');
  assert.ok(Array.isArray(data.tableRegions) && data.tableRegions.length > 0, 'regions must be returned');

  const region = data.tableRegions.find(r => r.kind === 'measurement');
  assert.equal(region.rowCount, 1, 'POA200 cert has exactly one measurement row');
  assert.deepEqual(region.headerColumns.map(c => c.label), ['Test Point Number', 'NIST Traceable Standard gas ppm', 'Analyzer pv ppm']);

  // 目标字段不得把 Date/Inst. SN. 当成表格列
  assert.equal(data.targetLabels.includes('Date:'), true);
  assert.equal(data.matchResults['Date:'].inferredType === 'table', false, 'Date must not be a table field');
  assert.equal(data.matchResults['Inst. SN.'].inferredType === 'table', false, 'Inst. SN. must not be a table field');
});

// ==================== P01–P04 / P08 / P09：清单 ====================

test('P01/P02: 清单首次分析自动发现“单位”等真实表头，且不含主设备/传感器列', async () => {
  const items = extractDocumentStructure(SAMPLE_PACK_POA200);
  const regions = detectTableRegions(items, { type: 'packing' });
  const region = regions.find(r => r.kind === 'packing');

  assert.ok(region, 'packing region detected');
  assert.equal(region.rowCount, MANIFEST.packPoa200.dataRows);
  assert.deepEqual(
    region.headerColumns.map(c => ({ colIdx: c.colIdx, label: c.label })),
    MANIFEST.packPoa200.headerColumns,
    'packing headers must equal manual manifest including 单位'
  );

  const fields = resolvePackingHeaderFields(region.headerColumns).map(f => f.field);
  ['index', 'name', 'spec', 'count', 'unit', 'standard', 'remark'].forEach(f => {
    assert.ok(fields.includes(f), `field ${f} must be discovered from real headers`);
  });

  // 端点返回的 targetLabels 必须包含单位、且不含行角色
  const tmplId = 'tmpl_test_region_poa200_pack';
  db.prepare(`
    INSERT INTO templates (id, model, type, filename, filepath, file_hash, version, field_mappings, published_at)
    VALUES (?, 'POA200', 'packing', ?, ?, ?, 'v1.0', '{}', NULL)
    ON CONFLICT(id) DO UPDATE SET filepath = excluded.filepath, file_hash = excluded.file_hash
  `).run(tmplId, path.basename(SAMPLE_PACK_POA200), SAMPLE_PACK_POA200, getFileSha256(SAMPLE_PACK_POA200));

  const res = await fetch(`http://localhost:${PORT}/api/templates/${tmplId}/analyze`);
  const data = await res.json();
  assert.ok(data.targetLabels.includes('单位'), 'unit must be auto-discovered on first analysis (B02)');
  assert.equal(data.targetLabels.includes('主设备'), false, '主设备 is a row role, not a column (B03)');
  assert.equal(data.targetLabels.includes('传感器'), false, '传感器 is a row role, not a column (B03)');

  // 单位参考值来自同列下方数据
  const unitMatch = data.matchResults['单位'];
  assert.ok(unitMatch && unitMatch.candidates.length > 0, 'unit candidate found');
  assert.ok(unitMatch.candidates[0].fullValues.includes('只'), 'unit defaults must come from the template column (只, not 件)');
});

test('P03: 管理员选中第二个候选后保存，使用的必须是选中项而不是 candidates[0]', async () => {
  const payload = await runSaveMatchedRules({
    template: { id: 'tmpl_pack_candidates', type: 'packing', model: 'PGA500-EX' },
    targetLabels: ['序号', '名称', '规格/型号', '数量', '单位', '标配', '备注'],
    tableRegions: [{
      tableIdx: 0, kind: 'packing', headerRow: 0,
      dataStartRow: 1, dataEndRow: 2, rowCount: 2, rowIndices: [1, 2],
      headerColumns: [
        { colIdx: 0, label: '序号' }, { colIdx: 1, label: '名称' }, { colIdx: 2, label: '规格/型号' },
        { colIdx: 3, label: '数量' }, { colIdx: 4, label: '单位' }, { colIdx: 5, label: '标配' }, { colIdx: 6, label: '备注' }
      ],
      colStart: 0, colEnd: 6, ambiguous: false
    }],
    // 管理员显式选择第二个候选（第二张同名表）
    selectedChoices: { '序号': 0, '名称': 1, '规格/型号': 0, '数量': 0, '单位': 0, '标配': 0, '备注': 0 },
    matchResults: {
      '序号': { candidates: [{ location: { type: 'cell', tableIdx: 0, rowIdx: 0, colIdx: 0 }, suggestedValueLocation: { type: 'table_column', tableIdx: 0, colIdx: 0, startRow: 1, endRow: 2 }, fullValues: ['1', '2'] }] },
      '名称': { candidates: [
        { location: { type: 'cell', tableIdx: 0, rowIdx: 0, colIdx: 1 }, suggestedValueLocation: { type: 'table_column', tableIdx: 0, colIdx: 1, startRow: 1, endRow: 2 }, fullValues: ['WRONG-NAMES-A', 'WRONG-NAMES-B'] },
        { location: { type: 'cell', tableIdx: 1, rowIdx: 0, colIdx: 1 }, suggestedValueLocation: { type: 'table_column', tableIdx: 1, colIdx: 1, startRow: 1, endRow: 2 }, fullValues: ['主设备', '传感器'] }
      ] },
      '规格/型号': { candidates: [{ location: { type: 'cell', tableIdx: 1, rowIdx: 0, colIdx: 2 }, suggestedValueLocation: { type: 'table_column', tableIdx: 1, colIdx: 2, startRow: 1, endRow: 2 }, fullValues: ['PGA500-Ex', 'PSR-12-223'] }] },
      '数量': { candidates: [{ location: { type: 'cell', tableIdx: 1, rowIdx: 0, colIdx: 3 }, suggestedValueLocation: { type: 'table_column', tableIdx: 1, colIdx: 3, startRow: 1, endRow: 2 }, fullValues: ['1', '1'] }] },
      '单位': { candidates: [{ location: { type: 'cell', tableIdx: 1, rowIdx: 0, colIdx: 4 }, suggestedValueLocation: { type: 'table_column', tableIdx: 1, colIdx: 4, startRow: 1, endRow: 2 }, fullValues: ['台', '只'] }] },
      '标配': { candidates: [{ location: { type: 'cell', tableIdx: 1, rowIdx: 0, colIdx: 5 }, suggestedValueLocation: { type: 'table_column', tableIdx: 1, colIdx: 5, startRow: 1, endRow: 2 }, fullValues: ['是', '是'] }] },
      '备注': { candidates: [{ location: { type: 'cell', tableIdx: 1, rowIdx: 0, colIdx: 6 }, suggestedValueLocation: { type: 'table_column', tableIdx: 1, colIdx: 6, startRow: 1, endRow: 2 }, fullValues: ['SN: A001', 'SN: S009'] }] }
    }
  });

  const items = payload.fieldMappings.packingItems;
  assert.deepEqual(items.map(i => i.name), ['主设备', '传感器'], 'selectedChoices[1] must be used instead of candidates[0]');
  assert.equal(items[0].unit, '台', 'template unit must be preserved');
  assert.equal(items[1].unit, '只', 'sensor row unit must come from the template (not 件)');
  assert.equal(items[0].standard, '是');
  assert.equal(items[0].role, 'mainDevice');
  assert.equal(items[0].isProtected, true);
  assert.equal(items[1].role, 'sensor');
  assert.equal(items[1].isProtected, true);
  assert.equal(items[1].sn, 'S009', 'sensor SN must be extracted from its own remark');
  assert.equal(payload.fieldMappings.packingRowRoles.length, 2);
});

test('P04/P08: 主设备 SN 与传感器 SN 相互独立，不被覆盖', async () => {
  const payload = await runSaveMatchedRules({
    template: { id: 'tmpl_pack_sn', type: 'packing', model: 'POA200' },
    targetLabels: ['序号', '名称', '规格/型号', '数量', '单位', '标配', '备注'],
    tableRegions: [{
      tableIdx: 0, kind: 'packing', headerRow: 0,
      dataStartRow: 1, dataEndRow: 3, rowCount: 3, rowIndices: [1, 2, 3],
      headerColumns: [
        { colIdx: 0, label: '序号' }, { colIdx: 1, label: '名称' }, { colIdx: 2, label: '规格/型号' },
        { colIdx: 3, label: '数量' }, { colIdx: 4, label: '单位' }, { colIdx: 5, label: '标配' }, { colIdx: 6, label: '备注' }
      ],
      colStart: 0, colEnd: 6, ambiguous: false
    }],
    selectedChoices: { '序号': 0, '名称': 0, '规格/型号': 0, '数量': 0, '单位': 0, '标配': 0, '备注': 0 },
    matchResults: {
      '序号': { candidates: [{ location: { type: 'cell', tableIdx: 0, rowIdx: 0, colIdx: 0 }, suggestedValueLocation: { type: 'table_column', tableIdx: 0, colIdx: 0, startRow: 1, endRow: 3 }, fullValues: ['1', '2', '3'] }] },
      '名称': { candidates: [{ location: { type: 'cell', tableIdx: 0, rowIdx: 0, colIdx: 1 }, suggestedValueLocation: { type: 'table_column', tableIdx: 0, colIdx: 1, startRow: 1, endRow: 3 }, fullValues: ['主设备', '传感器', '包装箱'] }] },
      '规格/型号': { candidates: [{ location: { type: 'cell', tableIdx: 0, rowIdx: 0, colIdx: 2 }, suggestedValueLocation: { type: 'table_column', tableIdx: 0, colIdx: 2, startRow: 1, endRow: 3 }, fullValues: ['POA200', 'PMT210SEN', 'ABS'] }] },
      '数量': { candidates: [{ location: { type: 'cell', tableIdx: 0, rowIdx: 0, colIdx: 3 }, suggestedValueLocation: { type: 'table_column', tableIdx: 0, colIdx: 3, startRow: 1, endRow: 3 }, fullValues: ['1', '1', '1'] }] },
      '单位': { candidates: [{ location: { type: 'cell', tableIdx: 0, rowIdx: 0, colIdx: 4 }, suggestedValueLocation: { type: 'table_column', tableIdx: 0, colIdx: 4, startRow: 1, endRow: 3 }, fullValues: ['台', '只', '个'] }] },
      '标配': { candidates: [{ location: { type: 'cell', tableIdx: 0, rowIdx: 0, colIdx: 5 }, suggestedValueLocation: { type: 'table_column', tableIdx: 0, colIdx: 5, startRow: 1, endRow: 3 }, fullValues: ['是', '是', ''] }] },
      '备注': { candidates: [{ location: { type: 'cell', tableIdx: 0, rowIdx: 0, colIdx: 6 }, suggestedValueLocation: { type: 'table_column', tableIdx: 0, colIdx: 6, startRow: 1, endRow: 3 }, fullValues: ['SN: A001 带泵', 'SN: S009', ''] }] }
    }
  });

  const items = payload.fieldMappings.packingItems;
  assert.equal(items[0].sn, 'A001');
  assert.equal(items[1].sn, 'S009');
  assert.notEqual(items[0].sn, items[1].sn, 'main device SN and sensor SN must be independent');
  assert.equal(items[2].standard, '', 'missing template 标配 must stay empty, not fabricated as 是');
  assert.equal(items[2].isProtected, false, 'ordinary material rows must stay deletable');
});

test('P05/P09: 无传感器清单不虚构传感器行，主设备与真实传感器行禁止删除', async () => {
  const items = extractDocumentStructure(SAMPLE_PACK_990);
  const regions = detectTableRegions(items, { type: 'packing' });
  const region = regions.find(r => r.kind === 'packing');

  assert.equal(region.rowCount, MANIFEST.pack990.dataRows, '990 packing has 11 real rows');
  assert.deepEqual(region.headerColumns.map(c => c.label), MANIFEST.pack990.headerColumns.map(c => c.label));

  const tCells = items.filter(x => x.type === 'cell' && x.tableIdx === region.tableIdx);
  const rows = region.rowIndices.map(r => ({
    rowIdx: r,
    cells: tCells.filter(x => x.rowIdx === r).sort((a, b) => a.colIdx - b.colIdx).map(c => ({ colIdx: c.colIdx, text: c.text }))
  }));
  const roles = assignPackingRowRoles(rows);

  assert.equal(roles[0].role, 'mainDevice');
  assert.equal(roles[0].sn, MANIFEST.pack990.mainDeviceSn);
  assert.equal(roles.some(r => r.role === 'sensor'), MANIFEST.pack990.hasSensorRow, '990 packing template has no sensor row and none may be invented');

  const { validateSubmittedPackingItems } = require('../src/backend/server');
  const mappings = {
    packingItems: [
      { index: 1, name: '主设备', role: 'mainDevice', isProtected: true },
      { index: 2, name: '用户手册', role: 'material', isProtected: false }
    ]
  };

  // 正常提交（无传感器行）必须通过
  const ok = validateSubmittedPackingItems([
    { index: 1, name: '主设备', role: 'mainDevice' },
    { index: 2, name: '用户手册', role: 'material' }
  ], mappings);
  assert.deepEqual(ok, [], 'payload without sensor row must pass for a template without sensors');

  // 删除保护行必须被拒绝
  const removed = validateSubmittedPackingItems([{ index: 1, name: '用户手册', role: 'material' }], mappings);
  assert.ok(removed.some(e => e.includes('主设备')), 'deleting the main device row must be rejected');

  // 凭空添加传感器行必须被拒绝
  const fabricated = validateSubmittedPackingItems([
    { index: 1, name: '主设备', role: 'mainDevice' },
    { index: 2, name: '传感器', role: 'sensor' }
  ], mappings);
  assert.ok(fabricated.some(e => e.includes('传感器')), 'fabricating a sensor row must be rejected');
});

test('M15(b)/P01(b): 真实模板 /analyze 输出直接进入保存流程，产生一致的发布映射', async () => {
  // 证书：真实 POA200 证书
  const certTmplId = 'tmpl_e2e_poa200_cert';
  db.prepare(`
    INSERT INTO templates (id, model, type, filename, filepath, file_hash, version, field_mappings, published_at)
    VALUES (?, 'POA200', 'cert', ?, ?, ?, 'v1.0', '{}', NULL)
    ON CONFLICT(id) DO UPDATE SET filepath = excluded.filepath, file_hash = excluded.file_hash
  `).run(certTmplId, path.basename(SAMPLE_CERT_POA200), SAMPLE_CERT_POA200, getFileSha256(SAMPLE_CERT_POA200));

  const certData = await (await fetch(`http://localhost:${PORT}/api/templates/${certTmplId}/analyze`)).json();
  const certPayload = await runSaveMatchedRules({
    template: certData.template,
    targetLabels: certData.targetLabels,
    matchResults: certData.matchResults,
    tableRegions: certData.tableRegions,
    structureReliability: certData.structureReliability,
    selectedChoices: {}
  });

  const certFm = certPayload.fieldMappings;
  assert.equal(certFm.tableConfig.rowCount, 1, 'analyze → save must keep the template fixed row count');
  assert.deepEqual(certFm.tableConfig.columns.map(c => c.label),
    ['Test Point Number', 'NIST Traceable Standard gas ppm', 'Analyzer pv ppm'],
    'columns must come from the detected measurement region in template order');
  assert.equal(certFm.testPoints.length, 1);
  assert.equal(certFm.testPoints[0].values.col_2, '9.96(N2 balance) ppm', 'template default value must survive to the phone payload');
  const certSingle = certFm.singleFields.map(f => f.label);
  ['Inst. SN.', 'Instrument', 'Date:', 'Ambient Temperature:', 'Relative Humidity'].forEach(l => {
    assert.ok(certSingle.includes(l), `${l} must stay a single-value field`);
  });

  // 清单：真实 POA200 发货清单，7 列全部绑定（含“规格/型号”“单位”）
  const packTmplId = 'tmpl_e2e_poa200_pack';
  db.prepare(`
    INSERT INTO templates (id, model, type, filename, filepath, file_hash, version, field_mappings, published_at)
    VALUES (?, 'POA200', 'packing', ?, ?, ?, 'v1.0', '{}', NULL)
    ON CONFLICT(id) DO UPDATE SET filepath = excluded.filepath, file_hash = excluded.file_hash
  `).run(packTmplId, path.basename(SAMPLE_PACK_POA200), SAMPLE_PACK_POA200, getFileSha256(SAMPLE_PACK_POA200));

  const packData = await (await fetch(`http://localhost:${PORT}/api/templates/${packTmplId}/analyze`)).json();
  const packPayload = await runSaveMatchedRules({
    template: packData.template,
    targetLabels: packData.targetLabels,
    matchResults: packData.matchResults,
    tableRegions: packData.tableRegions,
    structureReliability: packData.structureReliability,
    selectedChoices: {}
  });

  const packFm = packPayload.fieldMappings;
  assert.deepEqual(Object.keys(packFm.selectedChoices).sort(),
    ['序号', '名称', '规格/型号', '数量', '单位', '标配', '备注'].sort(),
    'every real packing header (including 规格/型号) must be bound as a column');
  assert.deepEqual(packFm.singleFields, [], 'packing headers must not be saved as single-value fields');

  const items = packFm.packingItems;
  assert.equal(items.length, MANIFEST.packPoa200.dataRows);
  assert.deepEqual(items.map(i => i.name), ['主设备', '传感器', '包装箱', '用户手册', '计量证书', '电源适配器', 'USB数据线', '标定指南', 'F46采样管']);
  assert.equal(items[0].spec, 'POA200');
  assert.equal(items[0].unit, '台');
  assert.equal(items[1].unit, '只', 'sensor unit must come from the template header column');
  assert.equal(items[1].sn, MANIFEST.packPoa200.sensorSn);
  assert.equal(items[0].role, 'mainDevice');
  assert.equal(items[1].role, 'sensor');
  assert.equal(items[2].isProtected, false);
});

test('M11(b): 已发布配置缺少 tableConfig 绑定时，手机停止渲染假表头并报告问题', () => {
  const appFile = path.join(__dirname, '../src/frontend/app.js');
  let renderedThead = '';
  let renderedTbody = '';
  const sandbox = {
    window: { location: { origin: 'http://localhost:3000' }, addEventListener: () => {} },
    document: {
      getElementById: (id) => {
        if (id === 'test-points-thead') return { set innerHTML(v) { renderedThead = v; } };
        if (id === 'test-points-body') return { set innerHTML(v) { renderedTbody = v; } };
        return { style: {}, innerHTML: '', innerText: '', value: '', set innerHTML(v) {} };
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {}
    },
    localStorage: { getItem: () => null, setItem: () => {} },
    console,
    alert: () => {},
    escapeHtml: (s) => String(s === undefined || s === null ? '' : s)
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(appFile, 'utf-8'), sandbox);

  // 复刻线上真实已发布 POA200 证书 bundle 的形态：
  // field_mappings 只有 sensorModelConfig/singleFields/testPoints（无 tableConfig），
  // 快照 tableConfig 为 null，testPoints 是旧格式（只有 std，无 values）
  sandbox.liveBundle = {
    model_display: 'POA200',
    doc_combo: 'cert_and_packing',
    certTemplate: {
      id: 'tmpl_poa200_cert',
      field_mappings: {
        sensorModelConfig: { options: ['PMT210SEN'], defaultValue: 'PMT210SEN' },
        singleFields: [
          { label: 'Inst. SN.', status: 'bound' },
          { label: 'Date:', status: 'bound' }
        ],
        testPoints: [{ point: 1, std: '9.96 ppm (N2 balance)' }]
      }
    },
    config_snapshot: { tableConfig: null, testPoints: [{ point: 1, std: '9.96 ppm (N2 balance)' }] }
  };

  vm.runInContext('state.activeBundle = liveBundle; state.testPoints = []; initTestPointsForModel();', sandbox);

  assert.equal(vm.runInContext('state.testPoints.length', sandbox), 0,
    'No measurement rows may be built when the published binding is missing');
  assert.equal(renderedThead.includes('标准值'), false,
    'A generic fallback header must NOT be rendered (the exact defect seen on the live phone page)');
  assert.equal(renderedThead.includes('Inst. SN.'), false,
    'Polluted single-value columns must never be rendered as measurement columns');
  assert.ok(renderedTbody.includes('tableConfig'),
    'The table must explain that the published binding is missing');
  const warnings = vm.runInContext('state.testPointsConfigWarning', sandbox);
  assert.ok(Array.isArray(warnings) && warnings.some(w => w.includes('tableConfig')),
    'Config warning must call out the missing tableConfig binding');

  // 旧格式（缺 values）的行也必须被标出
  const legacyWarnings = vm.runInContext(`validateActiveTableConfig(${JSON.stringify({
    tableIdx: 0, rowCount: 1,
    columns: [{ key: 'col_1', colIdx: 1, label: 'Test point Number', isSeq: true }]
  })}, [{ point: 1, std: 'x' }])`, sandbox);
  assert.ok(legacyWarnings.some(w => w.includes('旧格式')), 'Legacy row format must be reported');
});

test('M11(c): 手机提交被缺少绑定的已发布配置阻止，不会生成错误文档', () => {
  const appFile = path.join(__dirname, '../src/frontend/app.js');
  let alertMessages = [];
  const sandbox = {
    window: { location: { origin: 'http://localhost:3000' }, addEventListener: () => {} },
    document: {
      getElementById: (id) => {
        if (id === 'device-sn') return { value: 'AP10007513' };
        if (id === 'sales-person') return { value: '陈文' };
        if (id === 'shipping-location') return { value: '南京' };
        if (id === 'ambient-temp') return { value: '22.1' };
        if (id === 'relative-humidity') return { value: '50%RH' };
        if (id === 'cert-date') return { value: '2026-10-07' };
        if (id === 'model-select') return { value: 'b1' };
        return { style: {}, innerHTML: '', innerText: '', value: '', set innerHTML(v) {} };
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {}
    },
    localStorage: { getItem: () => null, setItem: () => {} },
    console,
    alert: (m) => alertMessages.push(String(m)),
    escapeHtml: (s) => String(s === undefined || s === null ? '' : s),
    fetch: async () => ({ ok: true, json: async () => ({ valid: true }) })
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(appFile, 'utf-8'), sandbox);

  sandbox.liveBundle = {
    id: 'b1', bundle_id: 'bundle_poa200_full', model_display: 'POA200', doc_combo: 'cert_and_packing', is_ready: true,
    certTemplate: { field_mappings: { singleFields: [{ label: 'Inst. SN.', status: 'bound' }], testPoints: [{ point: 1, std: '9.96 ppm' }] } },
    config_snapshot: { tableConfig: null, testPoints: [{ point: 1, std: '9.96 ppm' }] }
  };
  vm.runInContext(`
    state.selectedWorker = { id: 'w1', name: 'W1' };
    state.clientId = 'c1'; state.clientName = 'tester';
    state.activeBundle = liveBundle;
    state.sensorConfigs = [];
    state.testPoints = [];
    state.packingItems = [];
    state.testPointsConfigWarning = ['已发布配置缺少测量表格区绑定 (tableConfig)，无法确定真实列名与行数'];
  `, sandbox);

  return vm.runInContext('submitTaskForm()', sandbox).then(() => {
    assert.ok(alertMessages.some(m => m.includes('tableConfig') && m.includes('缺少测量表格区绑定')),
      `Submission must be blocked with the missing-binding reason first, got: ${JSON.stringify(alertMessages)}`);
  });
});

test('M11(d): 后端拒绝“无 tableConfig 的旧格式证书配置”正式发布', async () => {
  const tmplId = 'tmpl_test_legacy_cert_shape';
  db.prepare(`
    INSERT INTO templates (id, model, type, filename, filepath, file_hash, version, field_mappings, published_at)
    VALUES (?, 'POA200', 'cert', ?, ?, ?, 'v1.0', '{}', NULL)
    ON CONFLICT(id) DO UPDATE SET filepath = excluded.filepath, file_hash = excluded.file_hash
  `).run(tmplId, path.basename(SAMPLE_CERT_POA200), SAMPLE_CERT_POA200, getFileSha256(SAMPLE_CERT_POA200));

  // 复刻线上真实已发布形态：只有 singleField + 旧格式 testPoints（std 且无 values），无 tableConfig
  const res = await fetch(`http://localhost:${PORT}/api/templates/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': 'phoneapp-admin-secret' },
    body: JSON.stringify({
      id: tmplId,
      model: 'POA200',
      type: 'cert',
      filename: path.basename(SAMPLE_CERT_POA200),
      fieldMappings: {
        singleFields: [
          { label: 'Inst. SN.', status: 'bound', valueLocation: { type: 'cell', tableIdx: 0, rowIdx: 6, colIdx: 2 } },
          { label: 'Date:', status: 'bound', valueLocation: { type: 'cell', tableIdx: 0, rowIdx: 3, colIdx: 6 } }
        ],
        testPoints: [{ point: 1, std: '9.96 ppm (N2 balance)' }]
      },
      version: 'v1.0',
      isDraft: false
    })
  });

  assert.equal(res.status, 400, 'Legacy certificate config without tableConfig must not be formally published');
  const body = await res.json();
  assert.ok(body.error.includes('测量表格区'), `Error must mention the measurement table region, got: ${body.error}`);
});

test('P10: 仅证书/仅清单/两者都有的组合各自只渲染对应表单', () => {
  const appFile = path.join(__dirname, '../src/frontend/app.js');
  const sandbox = loadSandboxFromFile(appFile, { escapeHtml: (s) => String(s || '') });

  const certTemplate = {
    field_mappings: {
      tableConfig: {
        rowCount: 1, startRow: 12, endRow: 12,
        columns: [{ key: 'col_1', colIdx: 1, label: 'Test Point Number', isSeq: true, role: 'seq', defaultValues: ['1'] }]
      },
      testPoints: [{ point: 1, values: { col_1: '1' } }]
    }
  };
  const packingTemplate = {
    field_mappings: {
      packingItems: [{ index: 1, name: '主设备', role: 'mainDevice', isProtected: true, unit: '台', count: 1, spec: 'POA200' }]
    }
  };

  // 仅证书：不初始化清单行
  sandbox.certT = certTemplate;
  sandbox.packT = packingTemplate;
  vm.runInContext('state.activeBundle = { model_display: "POA200", doc_combo: "cert_only", certTemplate: certT, packingTemplate: packT }; state.currentModel = "POA200"; state.testPoints = []; state.packingItems = []; initTestPointsForModel();', sandbox);
  assert.equal(vm.runInContext('state.testPoints.length', sandbox), 1, 'cert_only shows certificate rows');
  assert.equal(vm.runInContext('state.packingItems.length', sandbox), 0, 'cert_only must not build packing rows');

  // 仅清单：不初始化证书测量行
  vm.runInContext('state.activeBundle = { model_display: "POA200", doc_combo: "packing_only", certTemplate: certT, packingTemplate: packT }; state.testPoints = []; state.packingItems = []; initPackingItemsForModel();', sandbox);
  assert.equal(vm.runInContext('state.testPoints.length', sandbox), 0, 'packing_only must not build certificate rows');
  assert.equal(vm.runInContext('state.packingItems.length', sandbox), 1, 'packing_only shows packing rows');

  // 两者都有：同时初始化
  vm.runInContext('state.activeBundle = { model_display: "POA200", doc_combo: "cert_and_packing", certTemplate: certT, packingTemplate: packT }; state.testPoints = []; state.packingItems = []; initTestPointsForModel(); initPackingItemsForModel();', sandbox);
  assert.equal(vm.runInContext('state.testPoints.length', sandbox), 1);
  assert.equal(vm.runInContext('state.packingItems.length', sandbox), 1);
});
