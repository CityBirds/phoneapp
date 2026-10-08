const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('fs');
const path = require('path');

test('Template measurement table column detection and template order preservation', async () => {
  const mockDocItems = [
    { type: 'cell', tableIdx: 0, rowIdx: 3, colIdx: 1, text: 'Customer' },
    { type: 'cell', tableIdx: 0, rowIdx: 3, colIdx: 2, text: 'York' },
    { type: 'cell', tableIdx: 0, rowIdx: 6, colIdx: 1, text: 'Inst. SN.' },
    { type: 'cell', tableIdx: 0, rowIdx: 6, colIdx: 2, text: 'POA3500-101' },
    // Measurement table header row
    { type: 'cell', tableIdx: 0, rowIdx: 11, colIdx: 0, text: 'Step' },
    { type: 'cell', tableIdx: 0, rowIdx: 11, colIdx: 1, text: 'Test Gas' },
    { type: 'cell', tableIdx: 0, rowIdx: 11, colIdx: 2, text: 'Nominal Value ppm' },
    { type: 'cell', tableIdx: 0, rowIdx: 11, colIdx: 3, text: 'Analyzer Reading ppm' },
    // Measurement table data rows
    { type: 'cell', tableIdx: 0, rowIdx: 12, colIdx: 0, text: '1' },
    { type: 'cell', tableIdx: 0, rowIdx: 12, colIdx: 1, text: 'O2 in N2' },
    { type: 'cell', tableIdx: 0, rowIdx: 12, colIdx: 2, text: '10.5 ppm' },
    { type: 'cell', tableIdx: 0, rowIdx: 12, colIdx: 3, text: '10.4 ppm' },
    { type: 'cell', tableIdx: 0, rowIdx: 13, colIdx: 0, text: '2' },
    { type: 'cell', tableIdx: 0, rowIdx: 13, colIdx: 1, text: 'CO in N2' },
    { type: 'cell', tableIdx: 0, rowIdx: 13, colIdx: 2, text: '50.0 ppm' },
    { type: 'cell', tableIdx: 0, rowIdx: 13, colIdx: 3, text: '49.8 ppm' },
  ];

  const serverCode = fs.readFileSync(path.join(__dirname, '../src/backend/server.js'), 'utf-8');
  const funcMatch = serverCode.match(/function detectCertificateTableHeaders[\s\S]*?\n\}/);
  assert.ok(funcMatch, 'detectCertificateTableHeaders found in server.js');

  const { normalizeText, detectTableRegions } = require('../src/common/matcher');
  const sandbox = { normalizeText, detectTableRegions };
  vm.createContext(sandbox);
  vm.runInContext(funcMatch[0], sandbox);

  const detected = sandbox.detectCertificateTableHeaders(mockDocItems, 'POA3500');
  assert.ok(detected, 'Detected table headers');
  assert.equal(detected.length, 4, 'Should detect all 4 columns from template');
  assert.deepEqual(detected, ['Step', 'Test Gas', 'Nominal Value ppm', 'Analyzer Reading ppm'], 'Exact column names in colIdx order');
});

test('admin.js saves tableConfig.columns in template file colIdx order and preserves all column headers', async () => {
  const adminCode = fs.readFileSync(path.join(__dirname, '../src/frontend/admin.js'), 'utf-8');
  
  const mockWindow = {
    location: { origin: 'http://localhost:3000' },
    addEventListener: () => {}
  };
  const sandbox = {
    window: mockWindow,
    document: {
      getElementById: (id) => {
        if (id === 'sensor-default-model') return { value: '' };
        return { style: {}, innerHTML: '', innerText: '', value: '' };
      },
      querySelectorAll: () => [],
      addEventListener: () => {}
    },
    localStorage: { getItem: () => null, setItem: () => {} },
    console,
    alert: () => {}
  };

  vm.createContext(sandbox);
  vm.runInContext(adminCode, sandbox);

  const matcherData = {
    template: { id: 'tmpl_poa3500_cert', type: 'cert', model: 'POA3500' },
    targetLabels: ['Inst. SN.', 'Step', 'Test Gas', 'Nominal Value ppm', 'Analyzer Reading ppm'],
    // 区域识别结果（整改 3.1/3.2）：发布必须依据真实测量区域，不能跨区域拼接
    tableRegions: [{
      tableIdx: 0,
      kind: 'measurement',
      headerRow: 11,
      dataStartRow: 12,
      dataEndRow: 13,
      rowCount: 2,
      rowIndices: [12, 13],
      headerColumns: [
        { colIdx: 0, label: 'Step' },
        { colIdx: 1, label: 'Test Gas' },
        { colIdx: 2, label: 'Nominal Value ppm' },
        { colIdx: 3, label: 'Analyzer Reading ppm' }
      ],
      colStart: 0,
      colEnd: 3,
      ambiguous: false
    }],
    selectedChoices: {
      'Inst. SN.': 0,
      'Step': 0,
      'Test Gas': 0,
      'Nominal Value ppm': 0,
      'Analyzer Reading ppm': 0
    },
    matchResults: {
      'Inst. SN.': {
        candidates: [{
          suggestedValueLocation: { type: 'cell', tableIdx: 0, rowIdx: 6, colIdx: 2 },
          location: { type: 'cell', tableIdx: 0, rowIdx: 6, colIdx: 1 },
          candidateValue: 'POA3500-101'
        }]
      },
      // Columns defined in arbitrary order in matchResults, but with colIdx 0, 1, 2, 3
      'Analyzer Reading ppm': {
        candidates: [{
          suggestedValueLocation: { type: 'table_column', tableIdx: 0, colIdx: 3, startRow: 12, endRow: 13 },
          location: { type: 'cell', tableIdx: 0, rowIdx: 11, colIdx: 3 },
          fullValues: ['10.4 ppm', '49.8 ppm']
        }]
      },
      'Step': {
        candidates: [{
          suggestedValueLocation: { type: 'table_column', tableIdx: 0, colIdx: 0, startRow: 12, endRow: 13 },
          location: { type: 'cell', tableIdx: 0, rowIdx: 11, colIdx: 0 },
          fullValues: ['1', '2']
        }]
      },
      'Test Gas': {
        candidates: [{
          suggestedValueLocation: { type: 'table_column', tableIdx: 0, colIdx: 1, startRow: 12, endRow: 13 },
          location: { type: 'cell', tableIdx: 0, rowIdx: 11, colIdx: 1 },
          fullValues: ['O2 in N2', 'CO in N2']
        }]
      },
      'Nominal Value ppm': {
        candidates: [{
          suggestedValueLocation: { type: 'table_column', tableIdx: 0, colIdx: 2, startRow: 12, endRow: 13 },
          location: { type: 'cell', tableIdx: 0, rowIdx: 11, colIdx: 2 },
          fullValues: ['10.5 ppm', '50.0 ppm']
        }]
      }
    }
  };

  sandbox.fixtureData = matcherData;
  vm.runInContext('currentMatcherData = fixtureData;', sandbox);

  sandbox.fetch = async (url, options) => {
    const payload = JSON.parse(options.body);
    sandbox.lastSavedPayload = payload;
    return { ok: true, json: async () => ({ success: true }) };
  };

  await vm.runInContext('saveMatchedRules(false)', sandbox);

  const tc = sandbox.lastSavedPayload.fieldMappings.tableConfig;
  assert.ok(tc, 'tableConfig generated');
  assert.equal(tc.columns.length, 4, '4 columns preserved');
  assert.equal(tc.columns[0].label, 'Step', 'Col 0 is Step');
  assert.equal(tc.columns[1].label, 'Test Gas', 'Col 1 is Test Gas');
  assert.equal(tc.columns[2].label, 'Nominal Value ppm', 'Col 2 is Nominal Value ppm');
  assert.equal(tc.columns[3].label, 'Analyzer Reading ppm', 'Col 3 is Analyzer Reading ppm');

  const pts = sandbox.lastSavedPayload.fieldMappings.testPoints;
  assert.equal(pts.length, 2, '2 test points rows');
  assert.equal(pts[0].values['col_0'], '1');
  assert.equal(pts[0].values['col_1'], 'O2 in N2');
  assert.equal(pts[1].values['col_1'], 'CO in N2');
});

test('app.js dynamically generates exact template table headers and columns in template order', async () => {
  const appCode = fs.readFileSync(path.join(__dirname, '../src/frontend/app.js'), 'utf-8');

  let renderedTheadHtml = '';
  let renderedTbodyHtml = '';

  const mockWindow = {
    location: { origin: 'http://localhost:3000' },
    addEventListener: () => {}
  };
  const sandbox = {
    window: mockWindow,
    document: {
      getElementById: (id) => {
        if (id === 'test-points-thead') return { set innerHTML(val) { renderedTheadHtml = val; } };
        if (id === 'test-points-body') return { set innerHTML(val) { renderedTbodyHtml = val; } };
        if (id === 'th-point-name') return { innerText: '' };
        return { style: {}, innerHTML: '', innerText: '', value: '' };
      },
      querySelectorAll: () => [],
      addEventListener: () => {}
    },
    localStorage: { getItem: () => null, setItem: () => {} },
    console,
    alert: () => {},
    escapeHtml: (str) => String(str || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  };

  vm.createContext(sandbox);
  vm.runInContext(appCode, sandbox);

  sandbox.testBundle = {
    model_display: 'POA3500',
    certTemplate: {
      field_mappings: {
        tableConfig: {
          columns: [
            { key: 'col_0', colIdx: 0, label: 'Step', isSeq: true, role: 'seq' },
            { key: 'col_1', colIdx: 1, label: 'Gas Name', isSeq: false, role: 'gas' },
            { key: 'col_2', colIdx: 2, label: 'Standard Conc. (ppm)', isStd: true, role: 'standard' },
            { key: 'col_3', colIdx: 3, label: 'Analyzer Value (ppm)', isAct: true, role: 'actual' }
          ]
        },
        testPoints: [
          { point: 1, values: { col_0: '1', col_1: 'Zero Air', col_2: '0.00 ppm', col_3: '' } },
          { point: 2, values: { col_0: '2', col_1: 'Span Gas', col_2: '10.00 ppm', col_3: '' } }
        ]
      }
    }
  };

  vm.runInContext('state.activeBundle = testBundle; state.testPoints = [];', sandbox);

  // Initialize test points
  vm.runInContext('initTestPointsForModel();', sandbox);

  const testPoints = vm.runInContext('state.testPoints', sandbox);
  assert.equal(testPoints.length, 2, '2 test points initialized');
  assert.ok(renderedTheadHtml.includes('Step'), 'Header Step rendered');
  assert.ok(renderedTheadHtml.includes('Gas Name'), 'Header Gas Name rendered');
  assert.ok(renderedTheadHtml.includes('Standard Conc. (ppm)'), 'Header Standard Conc. rendered');
  assert.ok(renderedTheadHtml.includes('Analyzer Value (ppm)'), 'Header Analyzer Value rendered');
  // 证书测量表固定行数：不得出现增删操作列（整改 3.3, M07）
  assert.equal(renderedTheadHtml.includes('操作'), false, 'Certificate table must not render an operation column');
  assert.equal(renderedTheadHtml.includes('删除'), false, 'Certificate table must not render delete buttons');

  // Verify columns are in exact order: Step, Gas Name, Standard Conc. (ppm), Analyzer Value (ppm)
  const stepIdx = renderedTheadHtml.indexOf('Step');
  const gasIdx = renderedTheadHtml.indexOf('Gas Name');
  const stdIdx = renderedTheadHtml.indexOf('Standard Conc. (ppm)');
  const actIdx = renderedTheadHtml.indexOf('Analyzer Value (ppm)');
  assert.ok(stepIdx < gasIdx && gasIdx < stdIdx && stdIdx < actIdx, 'Headers are in exact template colIdx order');

  // 证书固定行数：新增/删除入口必须被拒绝，行数保持与模板一致（整改 3.3）
  vm.runInContext('addTestPointRow();', sandbox);
  assert.equal(vm.runInContext('state.testPoints.length', sandbox), 2, 'Add row must be rejected for certificates');
  vm.runInContext('deleteTestPointRow(0);', sandbox);
  assert.equal(vm.runInContext('state.testPoints.length', sandbox), 2, 'Delete row must be rejected for certificates');
  assert.equal(vm.runInContext('state.testPoints[0].values.col_0', sandbox), '1', 'Row 0 seq default preserved');
  assert.equal(vm.runInContext('state.testPoints[1].values.col_0', sandbox), '2', 'Row 1 seq default preserved');
});

test('app.js rebuilds fixed measurement rows from the template when saved rows are polluted', async () => {
  const appCode = fs.readFileSync(path.join(__dirname, '../src/frontend/app.js'), 'utf-8');

  let renderedTbodyHtml = '';
  const sandbox = {
    window: { location: { origin: 'http://localhost:3000' }, addEventListener: () => {} },
    document: {
      getElementById: (id) => {
        if (id === 'test-points-body') return { set innerHTML(val) { renderedTbodyHtml = val; } };
        return { style: {}, innerHTML: '', innerText: '', value: '' };
      },
      querySelectorAll: () => [],
      addEventListener: () => {}
    },
    localStorage: { getItem: () => null, setItem: () => {} },
    console,
    alert: () => {},
    escapeHtml: (str) => String(str || '')
  };

  vm.createContext(sandbox);
  vm.runInContext(appCode, sandbox);

  // 污染配置：模板数据区只有 1 行，却保存了 3 行
  sandbox.testBundle = {
    model_display: 'POA200',
    certTemplate: {
      field_mappings: {
        tableConfig: {
          tableIdx: 0, startRow: 12, endRow: 12, rowCount: 1,
          columns: [
            { key: 'col_1', colIdx: 1, label: 'Test Point Number', isSeq: true, role: 'seq', defaultValues: ['1'] },
            { key: 'col_2', colIdx: 2, label: 'NIST Traceable Standard gas ppm', isStd: true, role: 'standard', defaultValues: ['9.96'] },
            { key: 'col_3', colIdx: 3, label: 'Analyzer pv ppm', isAct: true, role: 'actual', defaultValues: [''] }
          ]
        },
        testPoints: [
          { point: 1, values: { col_2: '9.96' } },
          { point: 2, values: { col_2: '伪造行' } },
          { point: 3, values: { col_2: '伪造行' } }
        ]
      }
    }
  };

  vm.runInContext('state.activeBundle = testBundle; state.testPoints = [];', sandbox);
  vm.runInContext('initTestPointsForModel();', sandbox);

  const testPoints = vm.runInContext('state.testPoints', sandbox);
  assert.equal(testPoints.length, 1, 'Polluted rows must be rebuilt to the template row count (M11)');
  assert.equal(testPoints[0].values.col_2, '9.96', 'Template default value must be preserved');
  assert.equal(testPoints[0].values.col_1, '1', 'Sequence column keeps read-only default');
  assert.ok(renderedTbodyHtml.includes('9.96'), 'Cell default rendered on the phone form');
});
