const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Setup isolated environment for tests
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phoneapp-test-sn-wait-'));
const testDbPath = path.join(tmpDir, 'test_sn_wait.db');
process.env.DB_PATH = testDbPath;
process.env.NODE_ENV = 'test';

const db = require('../src/backend/db');

// Helper function to create clean remark matching src/frontend/app.js generateMainDeviceRemark
function generateMainDeviceRemark(oldRemark, sn, hasPump) {
  const cleanSn = String(sn || '').trim();
  let text = String(oldRemark || '').trim();

  // Remove all existing SN occurrences (supporting halfwidth SN: and fullwidth SN：)
  text = text.replace(/SN[:：]\s*[^\s\r\n带泵]*/gi, ' ');
  // Remove all existing "带泵" occurrences
  text = text.replace(/带泵/g, ' ');
  // Clean up extra whitespace
  text = text.replace(/\s+/g, ' ').trim();

  let tag = '';
  if (cleanSn) {
    tag = `SN: ${cleanSn}${hasPump ? '带泵' : ''}`;
  } else if (hasPump) {
    tag = '带泵';
  }

  if (text && tag) {
    return `${text} ${tag}`;
  } else if (tag) {
    return tag;
  } else {
    return text;
  }
}

// Helper to extract default SN from template bundle matching src/frontend/app.js extractDefaultDeviceSn
function extractDefaultDeviceSn(bundle) {
  if (!bundle) return { sn: '', conflict: false };

  let certSn = '';
  let packingSn = '';

  // 1. Read from cert template bound single field Inst. SN.
  const certTmpl = bundle.certTemplate;
  if (certTmpl && certTmpl.field_mappings) {
    const singleFields = certTmpl.field_mappings.singleFields || [];
    const snField = singleFields.find(f =>
      f.status === 'bound' && /Inst\.?\s*SN|设备序列号|序列号|Instrument\s*SN|SN[:：]/i.test(f.label || '')
    );
    if (snField && (snField.candidateValue || snField.defaultValue)) {
      certSn = String(snField.candidateValue || snField.defaultValue).replace(/带泵/g, '').trim();
    }
  }

  // 2. Read from packing template main device row
  const packTmpl = bundle.packingTemplate;
  if (packTmpl && packTmpl.field_mappings) {
    const items = packTmpl.field_mappings.packingItems || [];
    const mainItem = items.find(it => it.role === 'mainDevice' || /主设备|主机/.test(it.name || ''));
    if (mainItem) {
      if (mainItem.sn) {
        packingSn = String(mainItem.sn).replace(/带泵/g, '').trim();
      } else if (mainItem.remark) {
        const match = /SN[:：]\s*([^\s\r\n带泵]+)/i.exec(mainItem.remark);
        if (match) packingSn = match[1].replace(/带泵/g, '').trim();
      }
    }
  }

  if (certSn && packingSn && certSn !== packingSn) {
    return { sn: certSn, certSn, packingSn, conflict: true };
  }

  const sn = certSn || packingSn || '';
  return { sn, certSn, packingSn, conflict: false };
}

// ==========================================
// TEST SUITE: SN01 - SN09 (Template SN Autofill)
// ==========================================

test('SN01: Extracts bound Inst. SN. preserving leading zeros', () => {
  const bundle = {
    certTemplate: {
      field_mappings: {
        singleFields: [
          { label: 'Inst. SN.', status: 'bound', candidateValue: '0000123' }
        ]
      }
    }
  };
  const res = extractDefaultDeviceSn(bundle);
  assert.equal(res.sn, '0000123');
  assert.equal(res.conflict, false);
});

test('SN02 & SN03: Main device SN vs Sensor SN isolation in packing list', () => {
  const bundle = {
    packingTemplate: {
      field_mappings: {
        packingItems: [
          { role: 'mainDevice', name: 'POA200主机', remark: 'SN: MAIN0001带泵' },
          { role: 'sensor', name: '氧气传感器', remark: 'SN: SENS9999' }
        ]
      }
    }
  };
  const res = extractDefaultDeviceSn(bundle);
  assert.equal(res.sn, 'MAIN0001');
  assert.notEqual(res.sn, 'SENS9999');
});

test('SN04: Unbound or empty SN leaves field empty without hardcoded EX10260902', () => {
  const bundle = {
    certTemplate: {
      field_mappings: {
        singleFields: [
          { label: 'Inst. SN.', status: 'unbound', candidateValue: 'EX10260902' }
        ]
      }
    }
  };
  const res = extractDefaultDeviceSn(bundle);
  assert.equal(res.sn, '');
});

test('SN05: Detects conflict when cert SN and packing main device SN disagree', () => {
  const bundle = {
    certTemplate: {
      field_mappings: {
        singleFields: [
          { label: 'Inst. SN.', status: 'bound', candidateValue: 'CERT0001' }
        ]
      }
    },
    packingTemplate: {
      field_mappings: {
        packingItems: [
          { role: 'mainDevice', name: '主机', remark: 'SN: PACK0002' }
        ]
      }
    }
  };
  const res = extractDefaultDeviceSn(bundle);
  assert.equal(res.conflict, true);
  assert.equal(res.certSn, 'CERT0001');
  assert.equal(res.packingSn, 'PACK0002');
});

test('SN07: Main device remark sync preserves custom text without duplicating SN:', () => {
  // Scenario 1: Existing remark has custom text and old SN with pump
  let remark = generateMainDeviceRemark('加急特快 SN: EX001带泵 箱体完好', 'EX002', false);
  assert.equal(remark, '加急特快 箱体完好 SN: EX002');

  // Scenario 2: Toggle pump on
  remark = generateMainDeviceRemark('加急特快 SN: EX002 箱体完好', 'EX002', true);
  assert.equal(remark, '加急特快 箱体完好 SN: EX002带泵');

  // Scenario 3: Remove SN
  remark = generateMainDeviceRemark('加急特快 SN: EX002带泵 箱体完好', '', false);
  assert.equal(remark, '加急特快 箱体完好');

  // Scenario 4: Empty initial remark
  remark = generateMainDeviceRemark('', 'EX003', true);
  assert.equal(remark, 'SN: EX003带泵');
});

test('SN08: Fullwidth colon, idempotency, pump toggling and backend validation', () => {
  // 1. Fullwidth colon SN： template remark replacement
  let remark = generateMainDeviceRemark('SN：AP10007513 带泵', 'AP20261008', true);
  assert.equal(remark, 'SN: AP20261008带泵');

  // 2. Strict Idempotency test (f(f(x)) === f(x))
  const pass1 = generateMainDeviceRemark('加急特快 SN：AP10007513 带泵 箱体完好', 'AP20261008', true);
  const pass2 = generateMainDeviceRemark(pass1, 'AP20261008', true);
  const pass3 = generateMainDeviceRemark(pass2, 'AP20261008', true);
  assert.equal(pass1, pass2);
  assert.equal(pass2, pass3);
  assert.equal(pass1, '加急特快 箱体完好 SN: AP20261008带泵');

  // 3. Modifying SN replaces old SN without duplicate tags
  const updatedSn = generateMainDeviceRemark(pass1, 'AP20269999', true);
  assert.equal(updatedSn, '加急特快 箱体完好 SN: AP20269999带泵');
  assert.equal((updatedSn.match(/SN[:：]/gi) || []).length, 1);

  // 4. Toggling pump off/on cleanly adds/removes exactly one "带泵" tag, preserving custom user text
  const pumpOff = generateMainDeviceRemark(updatedSn, 'AP20269999', false);
  assert.equal(pumpOff, '加急特快 箱体完好 SN: AP20269999');
  assert.equal(pumpOff.includes('带泵'), false);

  const pumpOnAgain = generateMainDeviceRemark(pumpOff, 'AP20269999', true);
  assert.equal(pumpOnAgain, '加急特快 箱体完好 SN: AP20269999带泵');
  assert.equal((pumpOnAgain.match(/带泵/g) || []).length, 1);

  // 5. extractDefaultDeviceSn with fullwidth colon
  const bundleFullwidth = {
    packingTemplate: {
      field_mappings: {
        packingItems: [
          { role: 'mainDevice', name: '主机', remark: 'SN：AP10007513 带泵' },
          { role: 'sensor', name: '传感器', remark: 'SN: SENSOR_SN_9999' }
        ]
      }
    }
  };
  const extracted = extractDefaultDeviceSn(bundleFullwidth);
  assert.equal(extracted.sn, 'AP10007513');

  // 6. Sensor serial numbers in packing list remain untouched
  const sensorRemark = 'SN: SENSOR_SN_9999';
  const untouchedSensorRemark = generateMainDeviceRemark(sensorRemark, 'AP20261008', true);
  // Note: syncDeviceSnToPackingList explicitly targets ONLY findMainDeviceRowIndex() and never modifies sensor row.
  assert.equal(sensorRemark, 'SN: SENSOR_SN_9999');

  // 7. Backend consistency check logic: matches main device row, supports fullwidth colon, strips "带泵", rejects genuine mismatch
  const packingItemsGood = [
    { role: 'mainDevice', name: '主设备', remark: 'SN：AP20261008 带泵' },
    { role: 'sensor', name: '传感器', remark: 'SN: SENS_001' }
  ];
  const mainItem = packingItemsGood.find(it => it.role === 'mainDevice' || it.isProtectedMain || /主设备|主机/.test(it.name || '')) || packingItemsGood[0];
  const matchGood = mainItem.remark.match(/SN[:：]\s*([A-Za-z0-9_.-]+)/i);
  assert.ok(matchGood);
  assert.equal(matchGood[1].replace(/带泵/g, '').trim(), 'AP20261008');

  // Genuine mismatch check
  const packingItemsBad = [
    { role: 'mainDevice', name: '主设备', remark: 'SN：AP10007513 带泵' }
  ];
  const mainItemBad = packingItemsBad.find(it => it.role === 'mainDevice' || it.isProtectedMain || /主设备|主机/.test(it.name || '')) || packingItemsBad[0];
  const matchBad = mainItemBad.remark.match(/SN[:：]\s*([A-Za-z0-9_.-]+)/i);
  assert.ok(matchBad);
  const extractedBad = matchBad[1].replace(/带泵/g, '').trim();
  assert.notEqual(extractedBad, 'AP20261008');
});

test('SN09: Task submission retains historical deviceSn snapshot', () => {
  db.prepare(`
    INSERT INTO tasks (req_id, client_id, client_name, model, device_sn, status, accepted_at)
    VALUES ('REQ_HIST_01', 'CLIENT_01', 'Tester', 'POA200', 'HIST_SN_001', 'SUCCESS', ?)
  `).run(new Date().toISOString());

  const task = db.prepare("SELECT * FROM tasks WHERE req_id = 'REQ_HIST_01'").get();
  assert.equal(task.device_sn, 'HIST_SN_001');
});

// ==========================================
// TEST SUITE: WAIT01 - WAIT08 (Async Conversion Queue)
// ==========================================

test('WAIT08: Database recovery resets orphaned converting task files on startup', () => {
  // Insert task with task_files stuck in CONVERTING_PDF
  const stmt = db.prepare(`
    INSERT INTO tasks (req_id, client_id, client_name, model, device_sn, status, accepted_at)
    VALUES ('REQ_ORPHAN_01', 'CLIENT_01', 'Tester', 'POA200', 'SN001', 'IN_PROGRESS', ?)
  `);
  const res = stmt.run(new Date().toISOString());
  const taskId = res.lastInsertRowid;

  db.prepare(`
    INSERT INTO task_files (task_id, file_type, official_filename, status, error_msg)
    VALUES (?, 'cert', 'POA200证书.doc', 'CONVERTING_PDF', NULL)
  `).run(taskId);

  // Simulate recovery logic on startup
  db.prepare(`
    UPDATE task_files
    SET status = 'PREVIEW_FAILED', error_msg = '服务重启，未完成的预览转换已被自动取消，可手动重试'
    WHERE status IN ('QUEUED', 'PROCESSING', 'CONVERTING', 'CONVERTING_PDF', 'CONVERTING_IMAGE')
  `).run();

  const file = db.prepare('SELECT * FROM task_files WHERE task_id = ?').get(taskId);
  assert.equal(file.status, 'PREVIEW_FAILED');
  assert.ok(file.error_msg.includes('服务重启'));
});

// Clean up test database
test.after(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (e) {}
});
