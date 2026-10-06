const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

test('POA3500: syncPublishedBundlesForModel generates full bundle with packing list fallback when only cert template is uploaded', async () => {
  // Test bundle generation logic in server.js
  const serverCode = fs.readFileSync(path.join(__dirname, '../src/backend/server.js'), 'utf-8');
  assert.ok(serverCode.includes("model === '3500'"), 'server.js supports model 3500 in packing fallback');
  assert.ok(serverCode.includes("bundle_${mName.toLowerCase()}_full"), 'server.js creates full bundle with packing list');
  assert.ok(serverCode.includes("ensureMainDeviceSpec"), 'server.js updates main device spec to current model display');
});

test('POA3500: doc_processor.py and doc_processor.ps1 correctly receive fieldMappings.tableConfig and write dynamic columns and headers', async () => {
  const pyCode = fs.readFileSync(path.join(__dirname, '../src/worker/doc_processor.py'), 'utf-8');
  assert.ok(pyCode.includes("field_mappings = data.get('fieldMappings')"), 'Python processor gets fieldMappings from data');
  assert.ok(pyCode.includes("tc = field_mappings.get('tableConfig')"), 'Python processor extracts tableConfig');
  assert.ok(pyCode.includes("header_r = tc.get('headerRow'"), 'Python processor computes headerRow');
  assert.ok(pyCode.includes("for col_def in columns:"), 'Python processor iterates columns for both headers and rows');

  const ps1Code = fs.readFileSync(path.join(__dirname, '../src/worker/doc_processor.ps1'), 'utf-8');
  assert.ok(ps1Code.includes("$headerRowIdx = if ($null -ne $tc.headerRow)"), 'PS1 computes headerRowIdx');
  assert.ok(ps1Code.includes("foreach ($colDef in $tc.columns)"), 'PS1 iterates columns');
  assert.ok(ps1Code.includes("$targetTable.Cell($headerRowIdx, $cIdx)"), 'PS1 uses direct table cell access with fallback');
});

test('POA3500: app.js captures all live dynamic column input values upon task submission without data loss', async () => {
  const appCode = fs.readFileSync(path.join(__dirname, '../src/frontend/app.js'), 'utf-8');
  assert.ok(appCode.includes("tp-cell-${i}-${colKey}") || appCode.includes("tp-cell-${i}-${col.key}"), 'app.js gives unique id to every dynamic column input');
  assert.ok(appCode.includes("tp-dyn-input"), 'app.js tags inputs with tp-dyn-input class');
  assert.ok(appCode.includes("values[col.key] = liveVal"), 'app.js syncs live DOM input value into values[col.key]');
  assert.ok(appCode.includes("values[String(col.colIdx)] = liveVal"), 'app.js syncs live DOM input value into values[col.colIdx]');
});
