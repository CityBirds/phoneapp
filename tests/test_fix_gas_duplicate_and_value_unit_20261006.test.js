const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

test('matcher.js does not treat Remark, Format, Decimal as mA unit and correctly detects word-bounded mA', () => {
  const { extractUnits, normalizeText } = require('../src/common/matcher');

  // Should NOT detect mA in words like Remark, Format, Decimal, Primary, Smart
  assert.equal(extractUnits('Remark').includes('ma'), false, 'Remark has no mA unit');
  assert.equal(extractUnits('Format').includes('ma'), false, 'Format has no mA unit');
  assert.equal(extractUnits('Decimal').includes('ma'), false, 'Decimal has no mA unit');
  assert.equal(extractUnits('Primary').includes('ma'), false, 'Primary has no mA unit');

  // Should detect mA when it is an actual unit
  assert.equal(extractUnits('Analyzer Under Test mA').includes('ma'), true, 'Analyzer Under Test mA has mA');
  assert.equal(extractUnits('Output (mA)').includes('ma'), true, 'Output (mA) has mA');
  assert.equal(extractUnits('4-20 mA').includes('ma'), true, '4-20 mA has mA');
  assert.equal(extractUnits('mA').includes('ma'), true, 'mA has mA');

  // Should detect ppm and ℃ dp without issue
  assert.equal(extractUnits('NIST Traceable Standard gas ppm').includes('ppm'), true);
  assert.equal(extractUnits('NIST Traceable Standard ℃ dp').includes('℃ dp'), true);
});

test('admin.js prevents gas column duplication and prevents mA cross-contamination onto Value column', async () => {
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

  // Template with: Gas (colIdx: 0), Value (colIdx: 1), Output mA (colIdx: 2)
  const matcherData = {
    template: { id: 'tmpl_transmitter_cert', type: 'cert', model: 'POA3500' },
    targetLabels: ['Inst. SN.', 'Gas', 'Value', 'Output mA'],
    selectedChoices: {
      'Inst. SN.': 0,
      'Gas': 0,
      'Value': 0,
      'Output mA': 0
    },
    matchResults: {
      'Inst. SN.': {
        candidates: [{
          suggestedValueLocation: { type: 'cell', tableIdx: 0, rowIdx: 6, colIdx: 2 },
          location: { type: 'cell', tableIdx: 0, rowIdx: 6, colIdx: 1 },
          candidateValue: 'POA3500-202'
        }]
      },
      'Gas': {
        candidates: [{
          suggestedValueLocation: { type: 'table_column', tableIdx: 0, colIdx: 0, startRow: 12, endRow: 13 },
          location: { type: 'cell', tableIdx: 0, rowIdx: 11, colIdx: 0 },
          fullValues: ['CO', 'O2']
        }]
      },
      'Value': {
        candidates: [{
          suggestedValueLocation: { type: 'table_column', tableIdx: 0, colIdx: 1, startRow: 12, endRow: 13 },
          location: { type: 'cell', tableIdx: 0, rowIdx: 11, colIdx: 1 },
          fullValues: ['10', '50']
        }]
      },
      'Output mA': {
        candidates: [{
          suggestedValueLocation: { type: 'table_column', tableIdx: 0, colIdx: 2, startRow: 12, endRow: 13 },
          location: { type: 'cell', tableIdx: 0, rowIdx: 11, colIdx: 2 },
          fullValues: ['4.0', '12.0']
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

  // Check 1: Gas should appear EXACTLY ONCE, not duplicated!
  const gasCols = tc.columns.filter(c => c.label.toLowerCase() === 'gas');
  assert.equal(gasCols.length, 1, 'Gas column should appear exactly once, not duplicated!');
  assert.equal(tc.columns.length, 3, 'Total 3 columns: Gas, Value, Output mA');
  assert.equal(tc.columns[0].label, 'Gas');
  assert.equal(tc.columns[1].label, 'Value');
  assert.equal(tc.columns[2].label, 'Output mA');

  // Check 2: Value column should NOT have mA attached to it!
  const pts = sandbox.lastSavedPayload.fieldMappings.testPoints;
  assert.equal(pts.length, 2, '2 test points');
  assert.equal(pts[0].values['col_1'], '10', 'Value row 0 must remain 10 without mA contamination');
  assert.equal(pts[1].values['col_1'], '50', 'Value row 1 must remain 50 without mA contamination');
  assert.equal(pts[0].std, '10', 'std property must remain 10 without mA contamination');
  assert.equal(pts[1].std, '50', 'std property must remain 50 without mA contamination');

  // Check 3: Output mA column correctly has mA unit
  assert.equal(pts[0].values['col_2'], '4.0 mA', 'Output mA row 0 should have mA unit');
  assert.equal(pts[1].values['col_2'], '12.0 mA', 'Output mA row 1 should have mA unit');
});
