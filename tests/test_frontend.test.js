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

  // Verify mobile view does NOT expose admin configuration tabs (separation of roles)
  assert.ok(!htmlContent.includes('id="tmpl-file-input"'), 'Mobile app must not allow uploading templates');
  assert.ok(!htmlContent.includes('id="matcher-template-select"'), 'Mobile app must not allow configuring field matchers');
});

test('Coordination Server Dedicated Admin Console (C01-C05, C13)', () => {
  const adminHtmlPath = path.resolve(__dirname, '../src/frontend/admin.html');
  const adminJsPath = path.resolve(__dirname, '../src/frontend/admin.js');
  const adminCssPath = path.resolve(__dirname, '../src/frontend/admin.css');

  assert.ok(fs.existsSync(adminHtmlPath), 'admin.html must exist');
  assert.ok(fs.existsSync(adminJsPath), 'admin.js must exist');
  assert.ok(fs.existsSync(adminCssPath), 'admin.css must exist');

  const adminHtml = fs.readFileSync(adminHtmlPath, 'utf-8');
  assert.ok(adminHtml.includes('sec-clients'), 'Admin console must manage client names (C01)');
  assert.ok(adminHtml.includes('sec-workers'), 'Admin console must monitor workers and printers (C02, R04)');
  assert.ok(adminHtml.includes('sec-templates'), 'Admin console must manage templates (C03)');
  assert.ok(adminHtml.includes('sec-matcher'), 'Admin console must assist field candidate matching (C04, C05)');
});
