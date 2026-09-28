const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { getFileSha256 } = require('../common/utils');

/**
 * Generate Word Document (.doc / .docx)
 * Rules: E04, E05, E06, R17, T06, T10
 */
function generateWordDocument(templatePath, outputPath, taskData) {
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Source template file not found: ${templatePath}`);
  }

  // Calculate source template hash before processing to verify R17
  const initialTemplateHash = getFileSha256(templatePath);

  // Validate Packing List Protected Rows if type is 'packing' (E06, T06)
  if (taskData.type === 'packing') {
    const packingItems = taskData.formData?.packingItems || [];
    const hasMainDevice = packingItems.some(item => item.name === '主设备' || item.isProtectedMain);
    const hasSensor = packingItems.some(item => item.name === '传感器' || item.isProtectedSensor);

    if (packingItems.length > 0 && (!hasMainDevice || !hasSensor)) {
      throw new Error('Packing list generation rejected: Missing protected main device or sensor row (E06, T06)');
    }
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

  // On Windows, prioritize native PowerShell COM execution (doc_processor.ps1) with zero third-party dependencies
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

  // Secondary fallback: Python doc_processor.py if PowerShell did not run or on non-Windows platforms
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
    // Remove unmodified raw template copy if processing failed (J14, Q38)
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
  generateWordDocument
};
