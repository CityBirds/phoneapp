const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('Mobile Web Frontend Assets and Structure (M01-M15)', () => {
  const htmlPath = path.resolve(__dirname, '../src/frontend/index.html');
  const jsPath = path.resolve(__dirname, '../src/frontend/app.js');
  const cssPath = path.resolve(__dirname, '../src/frontend/styles.css');

  assert.ok(fs.existsSync(htmlPath), 'index.html must exist');
  assert.ok(fs.existsSync(jsPath), 'app.js must exist');
  assert.ok(fs.existsSync(cssPath), 'styles.css must exist');

  const htmlContent = fs.readFileSync(htmlPath, 'utf-8');

  // Verify key UI components exist in HTML
  assert.ok(htmlContent.includes('id="user-badge"'), 'Name badge must exist (M01)');
  assert.ok(htmlContent.includes('id="model-select"'), 'Model selector must exist (M04)');
  assert.ok(htmlContent.includes('id="test-points-table"'), 'Test points table must exist (M06)');
  assert.ok(htmlContent.includes('id="packing-items-body"'), 'Packing items table must exist (M07)');
  assert.ok(htmlContent.includes('id="tab-serial-view"'), 'Serial port tab must exist (M15)');
  assert.ok(htmlContent.includes('暂未开放'), 'Serial port must explicitly state 暂未开放 (M15, R06)');
});
