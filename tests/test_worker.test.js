const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { isPathInWhitelist, isPrinterAllowed } = require('../src/worker/security');
const { handleFileConflictAndOverwrite } = require('../src/worker/conflict');
const { generateWordDocument } = require('../src/worker/word_engine');
const { getFileSha256 } = require('../src/common/utils');

test('Security Whitelist Path Traversal Interception (E02, R03, R05)', () => {
  const allowedDir = path.resolve(__dirname, '../data/test_docs');
  if (!fs.existsSync(allowedDir)) fs.mkdirSync(allowedDir, { recursive: true });

  const validPath = path.join(allowedDir, 'valid_cert.doc');
  assert.strictEqual(isPathInWhitelist(validPath, allowedDir), true);

  const invalidPathTraversal = path.join(allowedDir, '../../system32/cmd.exe');
  assert.strictEqual(isPathInWhitelist(invalidPathTraversal, allowedDir), false);
});

test('Printer Whitelist Verification (E02, R03)', () => {
  const allowedPrinters = ['Epson EcoTank L3258', 'Microsoft Print to PDF'];

  assert.strictEqual(isPrinterAllowed('Epson EcoTank L3258', allowedPrinters), true);
  assert.strictEqual(isPrinterAllowed('Unauthorized Network Printer', allowedPrinters), false);
});

test('Conflict Handling and Duplicate Copy Renaming -副本(N).doc (E07, R18-R20)', () => {
  const testDir = path.resolve(__dirname, '../data/test_conflict');
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
  fs.mkdirSync(testDir, { recursive: true });

  const officialName = 'POA200(140)AP10007513发货清单20260403带泵.doc';
  const officialPath = path.join(testDir, officialName);

  // Write existing official file
  fs.writeFileSync(officialPath, 'Old Content Version 1', 'utf-8');

  // First conflict overwrite check -> renames old file to -副本(1).doc
  const res1 = handleFileConflictAndOverwrite(testDir, officialName, false);
  assert.strictEqual(res1.copyFilename, 'POA200(140)AP10007513发货清单20260403带泵-副本(1).doc');
  assert.ok(fs.existsSync(res1.renamedCopyPath));

  // Write new official file again
  fs.writeFileSync(officialPath, 'Old Content Version 2', 'utf-8');

  // Second conflict overwrite check -> renames to -副本(2).doc
  const res2 = handleFileConflictAndOverwrite(testDir, officialName, false);
  assert.strictEqual(res2.copyFilename, 'POA200(140)AP10007513发货清单20260403带泵-副本(2).doc');
  assert.ok(fs.existsSync(res2.renamedCopyPath));
});

test('Real Word Document Generation and Source Template Hash Preservation (R17, E05)', () => {
  const samplesDir = path.resolve(__dirname, '../samples');
  const templatePath = path.join(samplesDir, 'POA200(140)AP10007513发货清单20260403带泵.doc');

  if (!fs.existsSync(templatePath)) return;

  const initialHash = getFileSha256(templatePath);
  const outputDir = path.resolve(__dirname, '../data/test_output');
  const outputPath = path.join(outputDir, 'generated_test_pack.doc');

  const genResult = generateWordDocument(templatePath, outputPath, {
    type: 'packing',
    formData: {
      model: 'POA200',
      deviceSn: 'AP10007513',
      hasPump: true,
      packingItems: [
        { index: 1, name: '主设备', spec: 'POA200', count: 1, unit: '台', standard: '是', remark: 'SN：AP10007513带泵', isProtectedMain: true },
        { index: 2, name: '传感器', spec: 'PMT210SEN', count: 1, unit: '只', standard: '是', remark: 'SN：201N200258', isProtectedSensor: true },
        { index: 3, name: '包装箱', spec: 'ABS', count: 1, unit: '个', standard: '是', remark: '' }
      ]
    }
  });

  assert.ok(fs.existsSync(outputPath));

  // R17 verification: Source template hash must not change!
  const postHash = getFileSha256(templatePath);
  assert.strictEqual(initialHash, postHash, 'Source template sha256 hash must remain unchanged');
});

test('Packing List Protected Row Enforcement (E06, T06)', () => {
  const samplesDir = path.resolve(__dirname, '../samples');
  const templatePath = path.join(samplesDir, 'POA200(140)AP10007513发货清单20260403带泵.doc');
  const outputPath = path.resolve(__dirname, '../data/test_output/invalid_pack.doc');

  if (!fs.existsSync(templatePath)) return;

  // Invalid item list missing main device and sensor protected rows
  const invalidTaskData = {
    type: 'packing',
    formData: {
      packingItems: [
        { index: 1, name: '包装箱', spec: 'ABS', count: 1 }
      ]
    }
  };

  // 整改 B.3：模板要求的主设备保护行缺失时仍必须拒绝
  // （未配置 protectedRows 的历史模板走最小安全底线，错误信息为主设备保护行缺失）
  assert.throws(() => {
    generateWordDocument(templatePath, outputPath, invalidTaskData);
  }, /Missing protected main device|模板要求的保护行缺失/);
});

test('POA3500 清单保护行由模板决定，不因型号含 POA 而要求传感器行 (整改 B.1/B.2)', () => {
  const { validateProtectedRows } = require('../src/worker/word_engine');

  // POA3500 清单模板：只有主设备是保护行，没有传感器行
  const poa3500Mappings = {
    protectedRows: [1],
    packingItems: [{ index: 1, name: '主设备', spec: 'POA3500', isProtected: true }]
  };
  const poa3500Items = [
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
  assert.doesNotThrow(() => {
    validateProtectedRows(poa3500Items, poa3500Mappings);
  }, 'POA3500 清单缺少传感器行时不得被拒绝');

  // 主设备行缺失仍必须拒绝（保护规则不因 3500 而全局取消）
  const withoutMain = poa3500Items.slice(1);
  assert.throws(() => {
    validateProtectedRows(withoutMain, poa3500Mappings);
  }, /模板要求的保护行缺失/);

  // POA200 模板要求主设备 + 传感器两行保护，缺少传感器仍必须拒绝
  const poa200Mappings = {
    protectedRows: [1, 2],
    packingItems: [
      { index: 1, name: '主设备', isProtected: true },
      { index: 2, name: '传感器', isProtectedSensor: true }
    ]
  };
  const poa200WithoutSensor = [
    { index: 1, name: '主设备', spec: 'POA200', count: 1, unit: '台', standard: '是', remark: 'SN: A1', isProtected: true },
    { index: 2, name: '包装箱', spec: 'ABS', count: 1, unit: '个', standard: '是' }
  ];
  assert.throws(() => {
    validateProtectedRows(poa200WithoutSensor, poa200Mappings);
  }, /模板要求的保护行缺失/);

  // 新增普通物料导致序号变化时，不得因序号变化误判（按身份匹配）
  const poa200WithExtraItem = [
    { index: 1, name: '主设备', spec: 'POA200', count: 1, unit: '台', standard: '是', remark: 'SN: A1', isProtected: true },
    { index: 2, name: '包装箱', spec: 'ABS', count: 1, unit: '个', standard: '是' },
    { index: 3, name: '传感器', spec: 'PMT210SEN', count: 1, unit: '只', standard: '是', isProtectedSensor: true }
  ];
  assert.doesNotThrow(() => {
    validateProtectedRows(poa200WithExtraItem, poa200Mappings);
  }, '保护行按身份匹配，序号变化不应误判');
});
