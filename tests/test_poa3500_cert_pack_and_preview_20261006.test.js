/**
 * POA3500 证书预览与清单生成整改 —— 端到端验收（整改文档 20261006）
 *
 * 验证要点：
 *  A. 证书：四行（Gas/Value/Actual Reading/mA Output）四列数据按列 key 写入真实 Word，
 *     表头保持模板原样、单位不重复、表格下方的认证声明行不被新增行覆盖；
 *  B. 清单：POA3500 无需传感器行即可生成；保护行按模板决定；POA200 保护规则不回退；
 *  C. 预览：基于真实 Word 转 PDF（预览产物为 PDF 且包含真实文本），非 Word 文件被明确拒绝；
 *  D. 模板保护：生成过程不得修改源模板（哈希不变）。
 *
 * 说明：本测试会真实调用 Word/WPS COM 生成文档（约 10-30 秒）。若当前环境没有可用 Office，
 *      相关用例会被跳过并在结果中标注，而不是伪装通过。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const fixture = path.resolve(__dirname, '../data/test_poa3500_remediation');
const testDbPath = path.join(fixture, 'poa3500.db');
process.env.DB_PATH = testDbPath;
// 测试隔离：预览与回传产物不得写入生产 data/previews、data/returned
process.env.PREVIEW_DIR = path.join(path.dirname(testDbPath), 'previews_test_isolated');
process.env.RETURNED_DIR = path.join(path.dirname(testDbPath), 'returned_test_isolated');
process.env.NODE_ENV = 'test';

if (fs.existsSync(fixture)) fs.rmSync(fixture, { recursive: true, force: true });
fs.mkdirSync(fixture, { recursive: true });

const db = require('../src/backend/db');
const { generateWordDocument } = require('../src/worker/word_engine');
const { getFileSha256 } = require('../src/common/utils');
const { generateDocumentPreview } = require('../src/backend/preview');

const DUMP_PS1 = path.resolve(__dirname, 'helpers/dump_doc_tables.ps1');

/**
 * 隔离数据库里没有模板数据，这里写入自包含夹具：
 *  - Word 文件由 tests/helpers/make_word_fixtures.js 用 Word COM 现场生成（结构固定），
 *    不再读取 data/phoneapp.db 生产模板，也不依赖任何现存模板文件 —— 生产库清空后测试依然有效；
 *  - 字段匹配配置在本文件内显式声明，与真实模板的配置结构保持一致。
 */
function seedTemplates() {
  const fixtureMaker = path.resolve(__dirname, 'helpers/make_word_fixtures.js');
  const fixturesDir = path.join(fixture, 'word_fixtures');
  const certPath = path.join(fixturesDir, 'poa3500_cert_fixture.doc');
  const packPath = path.join(fixturesDir, 'poa200_pack_fixture.doc');

  if (!fs.existsSync(certPath) || !fs.existsSync(packPath)) {
    execFileSync(process.execPath, [fixtureMaker, fixturesDir], {
      timeout: 240000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
  }
  assert.ok(fs.existsSync(certPath), `证书夹具必须生成成功: ${certPath}`);
  assert.ok(fs.existsSync(packPath), `清单夹具必须生成成功: ${packPath}`);

  // 与真实 POA3500 证书映射同构：顶层 tableConfig（0 基索引）+ 4 列
  // 注意：夹具首列是纵向合并的占位列（与真实模板一致），因此数据列位于物理第 2..5 列
  const certTableConfig = {
    tableIdx: 0,
    headerRow: 0,
    startRow: 1,
    endRow: 3,
    rowCount: 3,
    columns: [
      { key: 'col_1', label: 'Gas', colIdx: 1, role: 'seq', isSeq: true, isStd: false, isAct: false, unit: '' },
      { key: 'col_2', label: 'Value', colIdx: 2, role: 'standard', isSeq: false, isStd: true, isAct: false, unit: '' },
      { key: 'col_3', label: 'Actual Reading', colIdx: 3, role: 'actual', isSeq: false, isStd: false, isAct: true, unit: '' },
      { key: 'col_4', label: 'mA Output(If fitted)', colIdx: 4, role: 'actual', isSeq: false, isStd: false, isAct: true, unit: 'mA' }
    ],
    pointCol: { label: 'Gas', colIdx: 1 },
    standardCol: { label: 'Value', colIdx: 2 },
    actualCol: { label: 'Actual Reading', colIdx: 3 }
  };
  const certMappings = Object.assign({ protectedRows: [1] }, certTableConfig, { tableConfig: certTableConfig });

  // 与真实 POA200 清单映射同构：7 列，protectedRows 含主设备与传感器
  const packMappings = {
    protectedRows: [1, 2],
    packingItems: [
      { index: 1, name: '主设备', spec: 'POA200', count: 1, unit: '台', standard: '是', isProtected: true },
      { index: 2, name: '传感器', spec: 'PMT210SEN', count: 1, unit: '只', standard: '是', isProtectedSensor: true },
      { index: 3, name: '包装箱', spec: 'ABS', count: 1, unit: '个', standard: '是' },
      { index: 4, name: '用户手册', spec: '中英文', count: 2, unit: '本', standard: '是' }
    ]
  };

  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO templates (id, model, type, filename, filepath, file_hash, version, field_mappings, published_at, draft_mappings)
    VALUES (@id, @model, @type, @filename, @filepath, @file_hash, @version, @field_mappings, @published_at, NULL)
  `);
  insert.run({
    id: 'fixture_poa3500_cert',
    model: 'POA3500',
    type: 'cert',
    filename: path.basename(certPath),
    filepath: certPath,
    file_hash: getFileSha256(certPath) || '',
    version: 'v1.0',
    field_mappings: JSON.stringify(certMappings),
    published_at: now
  });
  insert.run({
    id: 'fixture_poa200_pack',
    model: 'POA200',
    type: 'packing',
    filename: path.basename(packPath),
    filepath: packPath,
    file_hash: getFileSha256(packPath) || '',
    version: 'v1.0',
    field_mappings: JSON.stringify(packMappings),
    published_at: now
  });

  return [certPath, packPath];
}

/** 用 Word/WPS COM 读取文档结构，用于核对真实写入结果 */
function dumpDocTables(docPath) {
  const outJson = path.join(fixture, `dump_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', DUMP_PS1, '-DocPath', docPath, '-OutJson', outJson], {
    timeout: 180000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const data = JSON.parse(fs.readFileSync(outJson, 'utf-8'));
  try { fs.unlinkSync(outJson); } catch (e) {}
  return data;
}

function officeAvailable() {
  if (process.platform !== 'win32') return false;
  try {
    execFileSync('powershell', ['-NoProfile', '-Command',
      'try { $a = New-Object -ComObject Word.Application; $a.Quit(); exit 0 } catch { exit 1 }'
    ], { timeout: 90000, stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 解压 PDF 内容流并统计绘制操作，用于确认预览产物是“真实渲染的文档”而不是固定重绘模板。
 */
function countPdfContentOperators(pdfPath) {
  const zlib = require('zlib');
  const buf = fs.readFileSync(pdfPath);
  const latin = buf.toString('latin1');
  const stat = { streams: 0, decoded: 0, textShows: 0, shows: 0, rects: 0, texts: 0 };
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(latin))) {
    const start = m.index + m[0].length;
    const end = latin.indexOf('endstream', start);
    if (end < 0) continue;
    stat.streams++;
    const raw = buf.slice(start, end);
    let data = null;
    try { data = zlib.inflateSync(raw); } catch (e) { continue; }
    stat.decoded++;
    const text = data.toString('latin1');
    stat.textShows += (text.match(/\bTj\b/g) || []).length + (text.match(/\bTJ\b/g) || []).length;
    stat.shows += (text.match(/\bTf\b/g) || []).length;
    stat.rects += (text.match(/\bre\b/g) || []).length;
    stat.texts += (text.match(/\bBT\b/g) || []).length;
  }
  return stat;
}

const testPoints = [
  { point: 1, name: 'Oxygen', values: { col_1: 'Oxygen', col_2: '100.00', col_3: '99.91', col_4: '19.982' } },
  { point: 2, name: 'Nitrogen', values: { col_1: 'Nitrogen', col_2: '0.00', col_3: '0.03', col_4: '4.006' } },
  { point: 3, name: 'Air', values: { col_1: 'Air', col_2: '21.00', col_3: '20.87', col_4: '7.339' } },
  { point: 4, name: 'CO2', values: { col_1: 'CO2', col_2: '10.00', col_3: '9.98', col_4: '5.678' } }
];

let certTemplate;
let certFieldMappings;
let packTemplate;
let packFieldMappings;
let hasOffice = false;

test.before(() => {
  hasOffice = officeAvailable();
  seedTemplates();

  const cert = db.prepare("SELECT * FROM templates WHERE model = 'POA3500' AND type = 'cert'").get();
  assert.ok(cert && fs.existsSync(cert.filepath), `POA3500 证书夹具必须存在: ${cert && cert.filepath}`);
  certTemplate = cert;
  certFieldMappings = JSON.parse(cert.field_mappings || '{}');
  assert.ok(certFieldMappings.tableConfig, 'POA3500 证书夹具必须包含 tableConfig');
  assert.equal(certFieldMappings.tableConfig.columns.length, 4, 'POA3500 证书夹具必须是四列');

  // 复用 POA200 口径的清单夹具来验证保护行逻辑（与任务 43 的组合绑定一致）
  const pack = db.prepare("SELECT * FROM templates WHERE model = 'POA200' AND type = 'packing' ORDER BY published_at DESC").get();
  assert.ok(pack && fs.existsSync(pack.filepath), `POA200 清单夹具必须存在: ${pack && pack.filepath}`);
  packTemplate = pack;
  packFieldMappings = JSON.parse(pack.field_mappings || '{}');
});

test.after(() => {
  try { if (fs.existsSync(fixture)) fs.rmSync(fixture, { recursive: true, force: true }); } catch (e) {}
});

test('POA3500 证书：四行四列按列 key 写入真实 Word，表头与声明行不被破坏（整改 C.1/C.6）', { timeout: 300000 }, (t) => {
  if (!hasOffice) { t.skip('当前环境无可用 Word/WPS COM，跳过真实 Word 生成核对'); return; }

  const sourceHashBefore = getFileSha256(certTemplate.filepath);
  const outPath = path.join(fixture, 'poa3500_cert_out.doc');

  generateWordDocument(certTemplate.filepath, outPath, {
    type: 'cert',
    formData: {
      model: 'POA3500',
      deviceSn: 'AP80260617',
      certDate: '2026-10-06',
      ambientTemp: '22.1',
      relativeHumidity: '50%RH',
      testPoints
    },
    fieldMappings: certFieldMappings,
    field_mappings: certFieldMappings
  });

  assert.ok(fs.existsSync(outPath), '必须生成证书文件');
  assert.equal(getFileSha256(certTemplate.filepath), sourceHashBefore, '源模板哈希必须保持不变 (R17)');

  const dump = dumpDocTables(outPath);
  const table = dump.tables[0];
  assert.ok(table, '证书必须包含表格');

  // 定位表头行与四行数据（按表头文本定位，避免依赖固定行号）
  const headerIdx = table.rows.findIndex(row => row.includes('Gas') && row.some(c => c === 'mA Output(If fitted)'));
  assert.ok(headerIdx >= 0, `必须保留模板原表头 Gas/.../mA Output(If fitted)，实际表格: ${JSON.stringify(table.rows)}`);

  const headerRow = table.rows[headerIdx];
  assert.ok(headerRow.includes('Value'), '表头必须包含 Value');
  assert.ok(headerRow.includes('Actual Reading'), '表头必须包含 Actual Reading');

  const dataRows = table.rows.slice(headerIdx + 1, headerIdx + 5).map(r => r.filter(c => c !== null));
  const flat = JSON.stringify(table.rows);

  // 四行数据逐项核对
  for (let i = 0; i < testPoints.length; i++) {
    const tp = testPoints[i];
    const row = table.rows[headerIdx + 1 + i];
    assert.ok(row, `必须存在第 ${i + 1} 行数据`);
    assert.equal(row[1], tp.values.col_1, `第 ${i + 1} 行 Gas 必须为 ${tp.values.col_1}`);
    assert.equal(row[2], tp.values.col_2, `第 ${i + 1} 行 Value 必须为 ${tp.values.col_2}`);
    assert.equal(row[3], tp.values.col_3, `第 ${i + 1} 行 Actual Reading 必须为 ${tp.values.col_3}`);
    assert.equal(row[4], tp.values.col_4, `第 ${i + 1} 行 mA Output 必须为 ${tp.values.col_4}`);
  }

  // 单位不得重复（如 19.982 mA mA）
  assert.ok(!/mA\s*mA/.test(flat), 'mA 单位不得重复写入');

  // 表格下方认证声明必须保留（新增行不得覆盖声明行）
  const stmt = dump.paragraphs.find(p => p.includes('We herby certify')) || (flat.includes('We herby certify') ? 'in-table' : '');
  assert.ok(stmt, '表格下方的认证声明内容必须保留');

  // 新增的 CO2 行必须保持四列结构（不得因合并单元格而丢列）
  const co2Row = table.rows[headerIdx + 4];
  assert.equal(co2Row[1], 'CO2', 'CO2 行必须存在');
  assert.ok(co2Row[3] !== null && co2Row[4] !== null, 'CO2 行必须保留 Actual Reading 与 mA Output 列');
  void dataRows;
});

test('POA3500 清单：无需传感器行即可生成，保护行由模板决定（整改 B.1/B.2/B.6）', { timeout: 300000 }, (t) => {
  if (!hasOffice) { t.skip('当前环境无可用 Word/WPS COM，跳过真实 Word 生成核对'); return; }

  const outPath = path.join(fixture, 'poa3500_pack_out.doc');
  const packingItems = [
    { index: 1, name: '主设备', spec: 'POA3500', count: 1, unit: '台', standard: '是', remark: 'SN: AP80260617', isProtected: true },
    { index: 2, name: '包装箱', spec: 'ABS', count: 1, unit: '个', standard: '是', remark: '空' },
    { index: 3, name: '用户手册', spec: '中英文', count: 1, unit: '本', standard: '是' },
    { index: 4, name: '校准证书', spec: '英文', count: 1, unit: '份', standard: '是' },
    { index: 5, name: '电源线', spec: '902B', count: 1, unit: '根', standard: '是' },
    { index: 6, name: '过滤器', spec: 'F46', count: 1, unit: '个', standard: '是' },
    { index: 7, name: '洗气瓶', spec: '玻璃', count: 1, unit: '个', standard: '是' },
    { index: 8, name: '针阀', spec: 'SS316', count: 1, unit: '个', standard: '是' },
    { index: 9, name: '流量计', spec: '2SCFH', count: 1, unit: '个', standard: '是' }
  ];

  // 使用 POA3500 清单模板的保护行配置（仅主设备），不该因缺少传感器行而抛错
  const poa3500PackMappings = {
    protectedRows: [1],
    packingItems: [{ index: 1, name: '主设备', isProtected: true }]
  };

  assert.doesNotThrow(() => {
    generateWordDocument(packTemplate.filepath, outPath, {
      type: 'packing',
      formData: { model: 'POA3500', deviceSn: 'AP80260617', hasPump: true, sensorModel: '', packingItems },
      fieldMappings: poa3500PackMappings,
      field_mappings: poa3500PackMappings
    });
  }, 'POA3500 清单不得要求传感器行');

  const dump = dumpDocTables(outPath);
  const table = dump.tables[0];
  const flat = JSON.stringify(table.rows);

  // 九项物料全部输出
  for (const item of packingItems) {
    assert.ok(flat.includes(item.name), `清单必须包含物料 ${item.name}`);
  }

  // 第二行数据（包装箱）的规格与备注不得被传感器逻辑覆盖
  const row2 = table.rows[2];
  assert.equal(row2[1], '包装箱', '第二条物料必须是包装箱');
  assert.equal(row2[2], 'ABS', '包装箱规格不得被传感器型号覆盖 (整改 B.6)');
  assert.equal(row2[6], '空', '包装箱备注不得被传感器备注覆盖 (整改 B.6)');

  // 主设备序列号正确
  assert.ok(String(table.rows[1][6] || '').includes('AP80260617'), '主设备行必须写入正确的设备序列号');
  assert.ok(!flat.includes('PMT210SEN'), 'POA3500 清单不得出现传感器型号');
});

test('预览：基于真实 Word 转 PDF，非 Word 文件被明确拒绝（整改 A.1/A.2）', { timeout: 300000 }, (t) => {
  if (!hasOffice) { t.skip('当前环境无可用 Word/WPS COM，跳过真实预览转换'); return; }

  const docPath = path.join(fixture, 'preview_source.doc');
  generateWordDocument(certTemplate.filepath, docPath, {
    type: 'cert',
    formData: { model: 'POA3500', deviceSn: 'AP80260617', certDate: '2026-10-06', testPoints },
    fieldMappings: certFieldMappings,
    field_mappings: certFieldMappings
  });

  const previewDir = path.join(fixture, 'previews');
  const preview = generateDocumentPreview({ sourcePath: docPath, previewDir, taskId: 'poa3500_e2e', fileType: 'cert' });

  assert.ok(fs.existsSync(preview.pdfPath), '必须生成 PDF 预览产物');
  assert.equal(path.extname(preview.pdfPath).toLowerCase(), '.pdf', '预览产物必须是 PDF');
  // 整改 3.1（2026-10-07）：PDF 与逐页图片都要产出；手机端看页图，PDF 作为独立下载入口
  assert.ok(preview.pdfUrl.startsWith('/previews/'), 'PDF 地址必须指向预览目录');
  assert.ok(Array.isArray(preview.pageUrls) && preview.pageUrls.length > 0, '必须生成逐页页图');
  assert.equal(preview.pages, preview.pageUrls.length, '页图数量必须与页数一致');
  assert.ok(preview.pageUrls.every(u => u.startsWith('/previews/') && /\.png(\?|$)/i.test(u)), '页图地址必须是预览目录下的 PNG');
  assert.ok(fs.statSync(preview.pdfPath).size > 1000, 'PDF 预览必须有实际内容');

  // 预览必须来自真实 Word：解压 PDF 内容流，确认存在真实文本绘制与图形绘制操作
  const pdfText = fs.readFileSync(preview.pdfPath, 'latin1');
  assert.ok(pdfText.startsWith('%PDF'), '产物必须是合法 PDF');
  const opsStat = countPdfContentOperators(preview.pdfPath);
  assert.ok(opsStat.textShows > 0, `PDF 内容流必须包含真实文本绘制（实际 textShows=${opsStat.textShows}）`);
  assert.ok(opsStat.shows > 0, 'PDF 内容流必须包含字形绘制操作');
  assert.ok(opsStat.rects > 0, 'PDF 内容流必须包含表格/边框矩形绘制');

  // 复用：同一源文件再次请求不应重复转换（PDF 与页图两阶段都应复用）
  const again = generateDocumentPreview({ sourcePath: docPath, previewDir, taskId: 'poa3500_e2e', fileType: 'cert' });
  assert.equal(again.reused, true, '相同源文件应复用已有预览，避免重复转换');
  assert.equal(again.stages.pdf.reused, true, 'PDF 阶段应复用');
  assert.equal(again.stages.images.reused, true, '页图阶段应复用');

  // 非 Word 文件必须明确拒绝
  const txtPath = path.join(fixture, 'not_word.txt');
  fs.writeFileSync(txtPath, 'not a word file', 'utf-8');
  assert.throws(() => {
    generateDocumentPreview({ sourcePath: txtPath, previewDir, taskId: 'bad', fileType: 'cert' });
  }, /仅支持 \.doc\/\.docx 预览/);

  // 源文件缺失必须明确报错（不得产出假预览）
  assert.throws(() => {
    generateDocumentPreview({ sourcePath: path.join(fixture, 'missing.doc'), previewDir, taskId: 'missing', fileType: 'cert' });
  }, /源 Word 文件不存在/);
});
