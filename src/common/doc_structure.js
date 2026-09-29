const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * Extract Document Structure for .doc and .docx files
 * Returns array of docItems:
 * - Paragraphs: { type: 'paragraph', paragraphIdx, text, rawText }
 * - Table Cells: { type: 'cell', tableIdx, rowIdx, colIdx, text, rawText }
 */
function extractDocumentStructure(filepath) {
  if (!fs.existsSync(filepath)) {
    throw new Error(`File not found: ${filepath}`);
  }

  const ext = path.extname(filepath).toLowerCase();

  // Strategy 1: Try PowerShell COM script on Windows if Word/WPS is available
  if (process.platform === 'win32') {
    const psScript = path.join(__dirname, '../worker/extract_doc_structure.ps1');
    if (fs.existsSync(psScript)) {
      try {
        const output = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psScript}" "${filepath}"`, {
          encoding: 'utf-8',
          timeout: 10000,
          stdio: ['ignore', 'pipe', 'ignore']
        });
        const parsed = JSON.parse(output.trim());
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      } catch (e) {
        // Fallback to JS extraction if PS fails
      }
    }
  }

  // Strategy 2: Extract from binary stream / cell delimiters or XML
  const items = [];
  const raw = fs.readFileSync(filepath);

  if (ext === '.docx') {
    return extractDocxStructure(raw);
  } else {
    return extractDocBinaryStructure(raw);
  }
}

/**
 * Fallback parser for .doc binary streams
 * Uses Word cell delimiter (\x07 or \r\x07) and paragraph markers (\r)
 * to preserve multiline cell headers like "NIST Traceable \rStandard ℃ dp"
 */
function extractDocBinaryStructure(buffer) {
  const items = [];
  const str16 = buffer.toString('utf16le');

  // Split by cell delimiter \x07
  const rawTokens = str16.split(/\x07+/);

  let currentTableIdx = 0;
  let currentRowIdx = 0;
  let currentColIdx = 0;
  let inTable = false;

  for (let i = 0; i < rawTokens.length; i++) {
    let token = rawTokens[i];

    // Clean null bytes and control chars except \r \n
    token = token.replace(/[\x00-\x06\x08-\x09\x0b-\x1f\x7f]/g, '').trim();

    if (!token || token.length < 2) continue;

    // Remove noise or non-printable garbage strings at start/end of binary file
    // Check if token contains meaningful alphanumeric/Chinese text
    if (!/[\u4e00-\u9fa5A-Za-z0-9]/.test(token)) continue;

    // Clean up trailing/leading paragraph breaks if present
    const cleanedText = token
      .replace(/^\r+|\r+$/g, '')
      .replace(/\r\n/g, '\r')
      .trim();

    if (!cleanedText) continue;

    // Detect row / table boundaries heuristics
    // If token contains row break markers or comes after cell sequences
    items.push({
      type: 'cell',
      text: cleanedText,
      rawText: token,
      tableIdx: currentTableIdx,
      rowIdx: currentRowIdx,
      colIdx: currentColIdx
    });

    currentColIdx++;
    if (currentColIdx > 6) { // Most calibration/packing tables have 2 to 7 cols
      currentColIdx = 0;
      currentRowIdx++;
    }
  }

  return items;
}

/**
 * Parser for .docx files (unzipping XML if zlib/zip available or extracting XML tags)
 */
function extractDocxStructure(buffer) {
  const items = [];
  try {
    const str = buffer.toString('utf8');
    // Extract text blocks inside <w:tc> (table cells) and <w:p> (paragraphs)
    const tcRegex = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g;
    let tcMatch;
    let colIdx = 0;
    let rowIdx = 0;

    while ((tcMatch = tcRegex.exec(str)) !== null) {
      const tcXml = tcMatch[1];
      const textMatches = tcXml.match(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g) || [];
      const text = textMatches.map(t => t.replace(/<[^>]+>/g, '')).join('\r').trim();

      if (text && /[\u4e00-\u9fa5A-Za-z0-9]/.test(text)) {
        items.push({
          type: 'cell',
          text,
          rawText: text,
          tableIdx: 0,
          rowIdx,
          colIdx
        });
        colIdx++;
        if (colIdx > 5) {
          colIdx = 0;
          rowIdx++;
        }
      }
    }
  } catch (e) {}

  return items;
}

module.exports = {
  extractDocumentStructure
};
