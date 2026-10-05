const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const { extractDocumentStructure } = require('../src/common/doc_structure');
const { findFieldCandidates, normalizeText } = require('../src/common/matcher');

const samplesDir = path.join(__dirname, '../samples');
const cert990Path = path.join(samplesDir, '990-Ex-EX10260902发货证书.doc');
const pack990Path = path.join(samplesDir, '990-Ex-EX10260902装箱清单.doc');
const poaCertPath = path.join(samplesDir, 'POA200证书AP10007513-20260403发南京订单-PSR-12-223(封装）带泵.doc');

test('验收 1: POA200 两个测量列正确绑定到 1 行数据区，且不回退取右侧表头', () => {
  const poaItems = extractDocumentStructure(poaCertPath);
  assert.ok(poaItems.length > 0, 'POA200 document structure should be extracted');

  const nist = findFieldCandidates('NIST Traceable Standard', poaItems);
  const act = findFieldCandidates('Analyzer pv ppm', poaItems);

  assert.ok(nist.candidates.length > 0, 'Should find candidate for NIST Standard');
  assert.ok(act.candidates.length > 0, 'Should find candidate for Analyzer pv ppm');

  const nistLoc = nist.candidates[0]?.suggestedValueLocation;
  const actLoc = act.candidates[0]?.suggestedValueLocation;

  // Verify type is table_column (not single right cell)
  if (nistLoc) {
    assert.equal(nistLoc.type, 'table_column', 'NIST Standard must be identified as table_column');
  }
  if (actLoc) {
    assert.equal(actLoc.type, 'table_column', 'Analyzer pv ppm must be identified as table_column');
  }

  // Verify data row count
  assert.equal(nistLoc.startRow, nistLoc.endRow);
  assert.equal(nist.candidates[0].sampleValues.length, 1);

  if (actLoc) {
    assert.equal(actLoc.startRow, actLoc.endRow);
  }
});

test('验收 2: 990 两个测量列正确绑定到 9 行数据区，且不延伸到说明/签名区域', () => {
  const cert990Items = extractDocumentStructure(cert990Path);
  assert.ok(cert990Items.length > 0, '990 cert document structure should be extracted');

  const nist = findFieldCandidates('NIST Traceable Standard ℃ dp', cert990Items);
  const act = findFieldCandidates('Analyzer ℃ dp', cert990Items);

  assert.ok(nist.candidates.length > 0, 'Should find candidate for NIST Standard');
  assert.ok(act.candidates.length > 0, 'Should find candidate for Analyzer ℃ dp');

  const nistLoc = nist.candidates[0].suggestedValueLocation;
  const actLoc = act.candidates[0].suggestedValueLocation;

  assert.equal(nistLoc.type, 'table_column');
  assert.equal(actLoc.type, 'table_column');

  // 9 data rows: startRow 12 to endRow 20
  const nistRowCount = nistLoc.endRow - nistLoc.startRow + 1;
  const actRowCount = actLoc.endRow - actLoc.startRow + 1;
  assert.equal(nistRowCount, 9, '990 NIST column should span exactly 9 data rows');
  assert.equal(actRowCount, 9, '990 Analyzer column should span exactly 9 data rows');

  // Verify sample values
  assert.ok(nist.candidates[0].sampleValues.length >= 5);
  assert.equal(nist.candidates[0].sampleValues[0], '-80.75');
  assert.equal(act.candidates[0].sampleValues[0], '-80.1');

  // Ensure footer / comments are not included in sample values
  const hasFooter = [...nist.candidates[0].sampleValues, ...act.candidates[0].sampleValues].some(
    s => s.includes('certify') || s.includes('Comments') || s.includes('PhyMetrix')
  );
  assert.equal(hasFooter, false, 'Footer and comments must not contaminate measurement data rows');
});

test('验收 3: 证书 Test point Number 和清单序号从业务填写字段中移除，作为内部特征与只读自动编号', () => {
  const normSeq = normalizeText('序 号');
  assert.equal(normSeq, '序号');

  const normTp = normalizeText('Test\npoint\nNumber');
  assert.equal(normTp, 'test point number');

  const packItems = extractDocumentStructure(pack990Path);
  const nameCol = findFieldCandidates('名称', packItems);
  assert.ok(nameCol.candidates.length > 0);
  assert.equal(nameCol.candidates[0].suggestedValueLocation.type, 'table_column');
  assert.ok(nameCol.candidates[0].sampleValues.includes('主设备'));
  assert.ok(nameCol.candidates[0].sampleValues.includes('计量证书'));
});

test('验收 4: PowerShell 脚本编码与参数声明合法性，零双重 BOM，param() 在脚本首部', () => {
  const extractPs1 = path.join(__dirname, '../src/worker/extract_doc_structure.ps1');
  const procPs1 = path.join(__dirname, '../src/worker/doc_processor.ps1');

  [extractPs1, procPs1].forEach(file => {
    const raw = fs.readFileSync(file);
    assert.equal(raw[0], 0xef);
    assert.equal(raw[1], 0xbb);
    assert.equal(raw[2], 0xbf);
    assert.notEqual(raw[3], 0xef, 'Duplicate BOM detected!');

    const text = fs.readFileSync(file, 'utf-8');
    const firstLine = text.trim().split('\n')[0].trim();
    assert.ok(firstLine.startsWith('param('), `${path.basename(file)} must start with param(...)`);
  });
});
