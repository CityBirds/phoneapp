const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Convert .doc or .docx file to paged preview PNG images (C11, R21, R22)
 * Returns array of public preview image URLs
 */
function generateDocumentPreview(wordFilePath, outputDir, fileId) {
  if (!fs.existsSync(wordFilePath)) {
    throw new Error(`Word file not found: ${wordFilePath}`);
  }

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const fileBaseName = `preview_${fileId}`;
  const pdfPath = path.join(outputDir, `${fileBaseName}.pdf`);

  // Step 1: Convert .doc / .docx to .pdf using LibreOffice if available
  try {
    execSync(`soffice --headless --convert-to pdf --outdir "${outputDir}" "${wordFilePath}"`, {
      stdio: 'pipe',
      timeout: 30000
    });

    const defaultConvertedPdf = path.join(outputDir, `${path.basename(wordFilePath, path.extname(wordFilePath))}.pdf`);
    if (fs.existsSync(defaultConvertedPdf)) {
      fs.renameSync(defaultConvertedPdf, pdfPath);
    }
  } catch (err) {
    // Fallback if soffice is not available or fails
    console.warn('soffice conversion failed or unavailable, creating mock/fallback preview:', err.message);
  }

  // Step 2: Convert PDF to PNG pages using pdftoppm or python script or fallback
  const images = [];
  if (fs.existsSync(pdfPath)) {
    try {
      execSync(`pdftoppm -png -r 150 "${pdfPath}" "${path.join(outputDir, fileBaseName)}"`, {
        stdio: 'pipe',
        timeout: 20000
      });

      const files = fs.readdirSync(outputDir);
      const pageFiles = files
        .filter(f => f.startsWith(fileBaseName) && f.endsWith('.png'))
        .sort();

      for (const pageFile of pageFiles) {
        images.push(`/previews/${pageFile}`);
      }
    } catch (err) {
      console.warn('pdftoppm failed:', err.message);
    }
  }

  // Fallback placeholder image if no images were produced
  if (images.length === 0) {
    const fallbackPng = path.join(outputDir, `${fileBaseName}-1.png`);
    // Create a 1x1 or simple placeholder PNG if needed, or simple SVG/HTML preview
    const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800">
      <rect width="100%" height="100%" fill="#ffffff" stroke="#cccccc" stroke-width="2"/>
      <text x="50%" y="40%" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="20" fill="#333333">文档预览: ${path.basename(wordFilePath)}</text>
      <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#666666">（已接收 Word 格式原件，准备打印）</text>
    </svg>`;
    
    fs.writeFileSync(fallbackPng.replace('.png', '.svg'), svgContent, 'utf-8');
    images.push(`/previews/${fileBaseName}-1.svg`);
  }

  return images;
}

module.exports = {
  generateDocumentPreview
};
