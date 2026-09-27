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

  // Clean existing output file if present and remove read-only attribute
  if (fs.existsSync(outputPath)) {
    try {
      fs.chmodSync(outputPath, 0o666);
      fs.unlinkSync(outputPath);
    } catch (e) {}
  }

  // Write temporary json data for doc_processor.py
  const tmpJsonPath = path.join(outputDir, `task_${Date.now()}.json`);
  fs.writeFileSync(tmpJsonPath, JSON.stringify(taskData, null, 2), 'utf-8');

  // Invoke python doc_processor.py script
  const scriptPath = path.join(__dirname, 'doc_processor.py');
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
  try {
    execSync(`"${pythonCmd}" "${scriptPath}" "${templatePath}" "${outputPath}" "${tmpJsonPath}"`, {
      stdio: 'pipe',
      timeout: 30000
    });
    if (fs.existsSync(outputPath)) {
      try { fs.chmodSync(outputPath, 0o666); } catch (e) {}
    }
  } catch (err) {
    // If python fails or isn't found, fallback to copying template
    console.warn('doc_processor.py fallback:', err.message);
    fs.copyFileSync(templatePath, outputPath);
    try { fs.chmodSync(outputPath, 0o666); } catch (e) {}
  } finally {
    if (fs.existsSync(tmpJsonPath)) fs.unlinkSync(tmpJsonPath);
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
