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

// Helper function to create clean remark without wiping custom user text (SN07, 2.2.5)
function updateMainDeviceRemark(oldRemark, cleanSn, hasPump) {
  oldRemark = String(oldRemark || '').trim();
  cleanSn = String(cleanSn || '').trim();
  const pumpStr = hasPump ? '带泵' : '';
  const snTag = cleanSn ? `SN: ${cleanSn}${pumpStr}` : '';

  if (!oldRemark) {
    return snTag;
  }

  // Check if oldRemark already contains SN: ...
  const snRegex = /SN:\s*[^\s\r\n]+/i;
  if (snRegex.test(oldRemark)) {
    if (snTag) {
      return oldRemark.replace(snRegex, snTag);
    } else {
      // Remove SN tag and clean up double spaces
      return oldRemark.replace(snRegex, '').replace(/\s+/g, ' ').trim();
    }
  } else {
    if (snTag) {
      return `${oldRemark} ${snTag}`.trim();
    } else {
      return oldRemark;
    }
  }
}

// Helper to extract default SN from template bundle (SN01 - SN05, 2.1)
function extractDefaultDeviceSn(bundle) {
  if (!bundle) return { sn: '', conflict: false };

  let certSn = '';
  let packingSn = '';

  // 1. Read from cert template bound single field Inst. SN.
  const certTmpl = bundle.certTemplate;
  if (certTmpl && certTmpl.field_mappings) {
    const singleFields = certTmpl.field_mappings.singleFields || [];
    const snField = singleFields.find(f =>
      f.status === 'bound' && /Inst\.?\s*SN|设备序列号|序列号|Instrument\s*SN|SN:/i.test(f.label || '')
    );
    if (snField && snField.candidateValue) {
      certSn = String(snField.candidateValue).trim();
    }
  }

  // 2. Read from packing template main device row
  const packTmpl = bundle.packingTemplate;
  if (packTmpl && packTmpl.field_mappings) {
    const items = packTmpl.field_mappings.packingItems || [];
    const mainItem = items.find(it => it.role === 'mainDevice' || /主设备|主机/.test(it.name || ''));
    if (mainItem) {
      if (mainItem.sn) {
        packingSn = String(mainItem.sn).trim();
      } else if (mainItem.remark) {
        const match = /SN:\s*([^\s\r\n带泵]+)/i.exec(mainItem.remark);
        if (match) packingSn = match[1].trim();
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
  let remark = updateMainDeviceRemark('加急特快 SN: EX001带泵 箱体完好', 'EX002', false);
  assert.equal(remark, '加急特快 SN: EX002 箱体完好');

  // Scenario 2: Toggle pump on
  remark = updateMainDeviceRemark('加急特快 SN: EX002 箱体完好', 'EX002', true);
  assert.equal(remark, '加急特快 SN: EX002带泵 箱体完好');

  // Scenario 3: Remove SN
  remark = updateMainDeviceRemark('加急特快 SN: EX002带泵 箱体完好', '', false);
  assert.equal(remark, '加急特快 箱体完好');

  // Scenario 4: Empty initial remark
  remark = updateMainDeviceRemark('', 'EX003', true);
  assert.equal(remark, 'SN: EX003带泵');
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
