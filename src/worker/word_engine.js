const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { getFileSha256 } = require('../common/utils');

/**
 * 解析模板配置中的保护行定义。
 * 保护行只能来自该任务实际绑定模板的 protectedRows 配置，
 * 不得由型号名称（如包含 POA）推导，否则 POA3500 会被误认为需要传感器行 (E06, T06)。
 */
function resolveProtectedRowSpec(fieldMappings) {
  const fm = fieldMappings || {};
  const rawRows = Array.isArray(fm.protectedRows) ? fm.protectedRows.slice() : [];
  const roles = fm.protectedRowRoles && typeof fm.protectedRowRoles === 'object' ? fm.protectedRowRoles : {};
  const templateItems = Array.isArray(fm.packingItems) ? fm.packingItems : [];

  const spec = rawRows.map((rowNum, i) => {
    const idx = Number(rowNum);
    const templateItem = templateItems.find(it => Number(it.index) === idx) || templateItems[i] || null;
    const role = roles[String(idx)] || roles[idx] ||
      (templateItem && templateItem.isProtectedSensor ? 'sensor'
        : templateItem && templateItem.isProtectedMain ? 'main'
          : (i === 0 ? 'main' : null));
    return {
      row: idx,
      order: i + 1,
      role,
      expectedName: templateItem && templateItem.name ? String(templateItem.name) : null
    };
  }).filter(s => Number.isFinite(s.row) && s.row > 0);

  return { spec, hasExplicitConfig: spec.length > 0, templateItems };
}

/**
 * 校验清单保护行：必须存在与模板保护行一一对应、身份匹配且被保留的条目。
 * - 以模板保护行为准：模板没有传感器行时（如 POA3500），不要求补造传感器行；
 * - 模板要求主设备行时，缺失或被改名仍必须拒绝；
 * - 序号变化不影响判断（按身份而非序号匹配）。
 */
function validateProtectedRows(packingItems, fieldMappings) {
  const { spec, hasExplicitConfig } = resolveProtectedRowSpec(fieldMappings);
  if (packingItems.length === 0) return;

  const findItem = (s) => {
    const byName = s.expectedName
      ? packingItems.find(it => String(it.name || '').trim() === s.expectedName)
      : null;
    if (byName) return byName;
    if (s.role === 'main') {
      return packingItems.find(it => it.isProtectedMain || it.isProtected)
        || packingItems.find(it => String(it.name || '').trim() === '主设备')
        || packingItems.find(it => /^主设备|^主机|^main\s*device/i.test(String(it.name || '').trim()))
        || null;
    }
    if (s.role === 'sensor') {
      return packingItems.find(it => it.isProtectedSensor)
        || packingItems.find(it => String(it.name || '').trim() === '传感器')
        || null;
    }
    return null;
  };

  if (hasExplicitConfig) {
    const missing = [];
    for (const s of spec) {
      const item = findItem(s);
      if (!item) {
        missing.push(s.expectedName || (s.role === 'sensor' ? '传感器' : s.role === 'main' ? '主设备' : `第 ${s.row} 行`));
      } else if (item.removed === true) {
        missing.push(`${s.expectedName || '保护行'}(已被删除)`);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `Packing list generation rejected: 模板要求的保护行缺失或被删除 [${missing.join('、')}] (E06, T06)`
      );
    }
    return;
  }

  // 未配置 protectedRows 的模板：保持最小安全底线 —— 主设备行仍不可缺失 (E06, T06)
  const hasMainDevice = packingItems.some(item => item.name === '主设备' || item.isProtectedMain || item.isProtected);
  if (!hasMainDevice) {
    throw new Error('Packing list generation rejected: Missing protected main device row (E06, T06)');
  }
}

/**
 * Generate Word Document (.doc / .docx)
 * Rules: E04, E05, E06, R17, T06, T10, 03-Spec Section 8
 */
function generateWordDocument(templatePath, outputPath, taskData) {
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Source template file not found: ${templatePath}`);
  }

  // Calculate source template hash before processing to verify R17
  const initialTemplateHash = getFileSha256(templatePath);

  // Validate Packing List Protected Rows if type is 'packing'
  if (taskData.type === 'packing') {
    const packingItems = taskData.formData?.packingItems || [];
    const effectiveMappings = taskData.fieldMappings || taskData.field_mappings || taskData.certTemplate?.field_mappings || {};
    validateProtectedRows(packingItems, effectiveMappings);
  }

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Clean existing output file if present and explicitly remove read-only attribute
  if (fs.existsSync(outputPath)) {
    try {
      fs.chmodSync(outputPath, 0o666);
      fs.unlinkSync(outputPath);
    } catch (e) {}
  }

  // Copy template to output path (strict template protection R17)
  fs.copyFileSync(templatePath, outputPath);
  try {
    fs.chmodSync(outputPath, 0o666);
  } catch (e) {}

  // Write temporary json data for doc_processor
  const tmpJsonPath = path.join(outputDir, `task_${Date.now()}_${Math.random().toString(36).substring(2, 6)}.json`);
  fs.writeFileSync(tmpJsonPath, JSON.stringify(taskData, null, 2), 'utf-8');

  let processedSuccessfully = false;

  // On Windows, prioritize native PowerShell COM execution (doc_processor.ps1)
  if (process.platform === 'win32') {
    const psScriptPath = path.join(__dirname, 'doc_processor.ps1');
    if (fs.existsSync(psScriptPath)) {
      try {
        execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psScriptPath}" "${templatePath}" "${outputPath}" "${tmpJsonPath}"`, {
          stdio: 'pipe',
          timeout: 30000
        });
        processedSuccessfully = true;
      } catch (psErr) {
        console.warn('doc_processor.ps1 execution notice:', psErr.message);
      }
    }
  }

  // Secondary fallback: Python doc_processor.py if PowerShell did not run or on non-Windows
  if (!processedSuccessfully) {
    const pyScriptPath = path.join(__dirname, 'doc_processor.py');
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    if (fs.existsSync(pyScriptPath)) {
      try {
        execSync(`"${pythonCmd}" "${pyScriptPath}" "${templatePath}" "${outputPath}" "${tmpJsonPath}"`, {
          stdio: 'pipe',
          timeout: 30000
        });
        processedSuccessfully = true;
      } catch (pyErr) {
        console.warn('doc_processor.py fallback notice:', pyErr.message);
      }
    }
  }

  // Ensure output file remains non-read-only
  if (fs.existsSync(outputPath)) {
    try {
      fs.chmodSync(outputPath, 0o666);
    } catch (e) {}
  }

  // Cleanup temporary JSON file
  if (fs.existsSync(tmpJsonPath)) {
    try {
      fs.unlinkSync(tmpJsonPath);
    } catch (e) {}
  }

  if (!processedSuccessfully) {
    if (fs.existsSync(outputPath)) {
      try { fs.unlinkSync(outputPath); } catch (e) {}
    }
    throw new Error(`Word document processing failed: Neither PowerShell COM nor Python script completed writeback successfully! (J14, Q38)`);
  }

  // Verify R17: Source template must remain completely unchanged
  const postTemplateHash = getFileSha256(templatePath);
  if (initialTemplateHash !== postTemplateHash) {
    throw new Error('CRITICAL SAFETY VIOLATION: Source template was altered during document generation! (R17)');
  }

  return {
    outputPath,
    sha256: getFileSha256(outputPath)
  };
}

module.exports = {
  generateWordDocument,
  validateProtectedRows,
  resolveProtectedRowSpec
};
