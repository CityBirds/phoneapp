const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

test('worker.js fetchTemplateForTask does not throw API_BASE ReferenceError and resolves templates by template_id and flexible model name', async () => {
  const workerCode = fs.readFileSync(path.join(__dirname, '../src/worker/worker.js'), 'utf-8');

  // Verify API_BASE is not in fetchTemplateForTask
  const fetchTmplDef = workerCode.match(/async fetchTemplateForTask[\s\S]*?\n  \}/);
  assert.ok(fetchTmplDef, 'fetchTemplateForTask exists');
  assert.equal(fetchTmplDef[0].includes('API_BASE'), false, 'API_BASE undeclared reference completely removed');

  // Create isolated worker sandbox
  let downloadedId = null;
  const mockFetch = async (url) => {
    if (url.endsWith('/api/templates')) {
      return {
        ok: true,
        json: async () => [
          {
            id: 'tmpl_poa3500_cert',
            model: 'POA3500',
            type: 'cert',
            filename: 'POA3500_cert.doc',
            filepath: '/nonexistent/path/on/server.doc',
            field_mappings: { tableConfig: { columns: [{ label: 'Step' }] } }
          }
        ]
      };
    }
    if (url.includes('/api/templates/tmpl_poa3500_cert/download')) {
      downloadedId = 'tmpl_poa3500_cert';
      return {
        ok: true,
        arrayBuffer: async () => Buffer.from('mock doc content')
      };
    }
    return { ok: false };
  };

  const { WorkerClient } = require('../src/worker/worker');
  const worker = new WorkerClient({
    serverUrl: 'http://localhost:3000',
    workerId: 'test-worker-1',
    workingDir: '/tmp/test_worker_dir'
  });

  // Override global fetch in worker context
  global.fetch = mockFetch;

  // Test 1: Fetch by templateId
  const resById = await worker.fetchTemplateForTask('POA3500', 'cert', 'tmpl_poa3500_cert');
  assert.ok(resById, 'Template found by ID');
  assert.equal(resById.id, 'tmpl_poa3500_cert');
  assert.equal(downloadedId, 'tmpl_poa3500_cert', 'Downloaded template file from coordinator');

  // Test 2: Fetch by model '3500' (fuzzy matches 'POA3500')
  const resFuzzy = await worker.fetchTemplateForTask('3500', 'cert');
  assert.ok(resFuzzy, 'Template found by fuzzy 3500 model name');
  assert.equal(resFuzzy.id, 'tmpl_poa3500_cert');

  // Clean up
  try { fs.rmSync('/tmp/test_worker_dir', { recursive: true, force: true }); } catch (e) {}
});

test('doc_processor.ps1 and doc_processor.py include table header syncing logic for dynamic columns', () => {
  const ps1Code = fs.readFileSync(path.join(__dirname, '../src/worker/doc_processor.ps1'), 'utf-8');
  assert.ok(ps1Code.includes('headerRowIdx'), 'PS1 script contains headerRowIdx detection');
  assert.ok(ps1Code.includes('$colDef.label'), 'PS1 script sets cell Range.Text to colDef.label for headers');

  const pyCode = fs.readFileSync(path.join(__dirname, '../src/worker/doc_processor.py'), 'utf-8');
  assert.ok(pyCode.includes('header_r = tc.get'), 'Python script contains header_r calculation');
  assert.ok(pyCode.includes('table.Cell(header_r, c_idx).Range.Text = str(c_lbl)'), 'Python script syncs header cell text');
});
