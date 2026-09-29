const path = require('path');
const fs = require('fs');
const { extractDocumentStructure } = require('../common/doc_structure');

function escapeXml(unsafe) {
  if (unsafe == null) return '';
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generate Real Word Document Paged Preview based on actual extracted document structure
 * Rules: C11, R21, R22, F14, G12, 03-Spec Section 9
 */
function generateDocumentPreview(wordFilePath, outputDir, fileId, extraContext = {}) {
  if (!fs.existsSync(wordFilePath)) {
    throw new Error(`Word file not found: ${wordFilePath}`);
  }

  // Validate file extension (J12, Q33)
  const ext = path.extname(wordFilePath).toLowerCase();
  if (ext !== '.doc' && ext !== '.docx') {
    throw new Error(`Non-Word file rejected: ${wordFilePath} is not a valid .doc or .docx file! (J12, Q33)`);
  }

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const fileBaseName = `preview_${fileId}`;
  const images = [];

  // Extract actual document structure from the generated Word file
  let docItems = [];
  try {
    docItems = extractDocumentStructure(wordFilePath);
  } catch (e) {
    console.warn('Preview structure extraction error:', e.message);
  }

  const fileType = extraContext.fileType || (fileId.includes('cert') ? 'cert' : 'packing');

  let svgContent = '';
  if (fileType === 'cert') {
    svgContent = renderCertSvgFromDocItems(docItems, extraContext);
  } else {
    svgContent = renderPackingSvgFromDocItems(docItems, extraContext);
  }

  const svgFilePath = path.join(outputDir, `${fileBaseName}-1.svg`);
  fs.writeFileSync(svgFilePath, svgContent, 'utf-8');
  images.push(`/previews/${fileBaseName}-1.svg`);

  return images;
}

function renderCertSvgFromDocItems(docItems, extraContext) {
  let customer = 'YORK';
  let certDate = '';
  let model = extraContext.task ? extraContext.task.model : '990';
  let deviceSn = extraContext.task ? extraContext.task.device_sn : '';
  let ambientTemp = '';
  let relativeHumidity = '';

  for (let i = 0; i < docItems.length; i++) {
    const text = docItems[i].text;
    if (text === 'Customer' && i + 1 < docItems.length) {
      customer = docItems[i + 1].text || customer;
    } else if ((text === 'Date:' || text === 'Date') && i + 1 < docItems.length) {
      certDate = docItems[i + 1].text || certDate;
    } else if (text === 'Instrument' && i + 1 < docItems.length) {
      model = docItems[i + 1].text || model;
    } else if (text === 'Inst. SN.' && i + 1 < docItems.length) {
      deviceSn = docItems[i + 1].text || deviceSn;
    } else if (text.includes('Ambient Temperature') && i + 1 < docItems.length) {
      ambientTemp = docItems[i + 1].text || ambientTemp;
    } else if (text.includes('Relative Humidity') && i + 1 < docItems.length) {
      relativeHumidity = docItems[i + 1].text || relativeHumidity;
    }
  }

  // Extract test points table rows directly from docItems
  const testRows = [];
  for (let i = 0; i < docItems.length; i++) {
    const item = docItems[i];
    if (/^[1-9]\d*$/.test(item.text.trim())) {
      const ptNum = item.text.trim();
      const stdVal = (i + 1 < docItems.length) ? docItems[i + 1].text.trim() : '';
      const actVal = (i + 2 < docItems.length) ? docItems[i + 2].text.trim() : '';
      if (stdVal || actVal) {
        testRows.push({ ptNum, stdVal, actVal });
      }
    }
  }

  let testRowsSvg = '';
  const rowsToRender = testRows.length > 0 ? testRows : [{ ptNum: '1', stdVal: '-80.75 ℃ dp', actVal: '' }];

  rowsToRender.forEach((tr, idx) => {
    const y = 430 + idx * 30;
    testRowsSvg += `
      <rect x="60" y="${y}" width="680" height="30" fill="${idx % 2 === 0 ? '#ffffff' : '#f9fafb'}" stroke="#1e293b" stroke-width="1"/>
      <line x1="180" y1="${y}" x2="180" y2="${y + 30}" stroke="#1e293b" stroke-width="1"/>
      <line x1="520" y1="${y}" x2="520" y2="${y + 30}" stroke="#1e293b" stroke-width="1"/>
      <text x="120" y="${y + 20}" font-size="13" fill="#0f172a" text-anchor="middle">${escapeXml(tr.ptNum)}</text>
      <text x="350" y="${y + 20}" font-size="13" fill="#0f172a" text-anchor="middle">${escapeXml(tr.stdVal)}</text>
      <text x="630" y="${y + 20}" font-size="13" fill="#0f172a" font-weight="600" text-anchor="middle">${escapeXml(tr.actVal)}</text>
    `;
  });

  const tableBottomY = 430 + rowsToRender.length * 30 + 40;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 1130" width="800" height="1130" font-family="'Times New Roman', 'Arial', 'SimSun', sans-serif">
  <!-- Paper Background -->
  <rect x="0" y="0" width="800" height="1130" fill="#ffffff"/>
  <rect x="40" y="40" width="720" height="1050" fill="#ffffff" stroke="#cbd5e1" stroke-width="1"/>

  <!-- Logo/Header Area -->
  <text x="60" y="80" font-size="20" font-weight="bold" fill="#003366" font-family="Arial">PhyMetrix</text>

  <!-- Title -->
  <text x="400" y="125" font-size="22" font-weight="bold" fill="#0f172a" text-anchor="middle">CERTIFICATE OF CONFORMANCE</text>
  <text x="400" y="150" font-size="13" fill="#475569" text-anchor="middle">Calibration with NIST Traceable Certification</text>

  <!-- Info Table -->
  <rect x="60" y="180" width="680" height="190" fill="#ffffff" stroke="#1e293b" stroke-width="1"/>
  
  <line x1="60" y1="218" x2="740" y2="218" stroke="#1e293b" stroke-width="1"/>
  <line x1="60" y1="256" x2="740" y2="256" stroke="#1e293b" stroke-width="1"/>
  <line x1="60" y1="294" x2="740" y2="294" stroke="#1e293b" stroke-width="1"/>
  <line x1="60" y1="332" x2="740" y2="332" stroke="#1e293b" stroke-width="1"/>

  <line x1="220" y1="180" x2="220" y2="370" stroke="#1e293b" stroke-width="1"/>
  <line x1="430" y1="180" x2="430" y2="370" stroke="#1e293b" stroke-width="1"/>
  <line x1="580" y1="180" x2="580" y2="370" stroke="#1e293b" stroke-width="1"/>

  <!-- Row 1 -->
  <text x="70" y="205" font-size="13" font-weight="bold" fill="#0f172a">Customer</text>
  <text x="230" y="205" font-size="13" fill="#0f172a">${escapeXml(customer)}</text>
  <text x="440" y="205" font-size="13" font-weight="bold" fill="#0f172a">Date:</text>
  <text x="590" y="205" font-size="13" fill="#0f172a">${escapeXml(certDate)}</text>

  <!-- Row 2 -->
  <text x="70" y="243" font-size="13" font-weight="bold" fill="#0f172a">Cust Ref #</text>
  <text x="230" y="243" font-size="13" fill="#0f172a">-</text>
  <text x="440" y="243" font-size="13" font-weight="bold" fill="#0f172a">Examiner:</text>
  <text x="590" y="243" font-size="13" fill="#0f172a">TP</text>

  <!-- Row 3 -->
  <text x="70" y="281" font-size="13" font-weight="bold" fill="#0f172a">Instrument</text>
  <text x="230" y="281" font-size="13" fill="#0f172a">${escapeXml(model)}</text>
  <text x="440" y="281" font-size="13" font-weight="bold" fill="#0f172a">Inst. SN.</text>
  <text x="590" y="281" font-size="13" font-weight="bold" fill="#003366">${escapeXml(deviceSn)}</text>

  <!-- Row 4 -->
  <text x="70" y="319" font-size="13" font-weight="bold" fill="#0f172a">Ambient Temperature:</text>
  <text x="230" y="319" font-size="13" fill="#0f172a">${escapeXml(ambientTemp)}</text>
  <text x="440" y="319" font-size="13" font-weight="bold" fill="#0f172a">Relative Humidity</text>
  <text x="590" y="319" font-size="13" fill="#0f172a">${escapeXml(relativeHumidity)}</text>

  <!-- Row 5 -->
  <text x="70" y="357" font-size="13" font-weight="bold" fill="#0f172a">Comments</text>
  <text x="230" y="357" font-size="13" fill="#0f172a">Observations: PASSED</text>

  <!-- Test Points Table Header -->
  <rect x="60" y="395" width="680" height="35" fill="#f1f5f9" stroke="#1e293b" stroke-width="1"/>
  <line x1="180" y1="395" x2="180" y2="430" stroke="#1e293b" stroke-width="1"/>
  <line x1="520" y1="395" x2="520" y2="430" stroke="#1e293b" stroke-width="1"/>

  <text x="120" y="418" font-size="13" font-weight="bold" fill="#0f172a" text-anchor="middle">Test point Number</text>
  <text x="350" y="418" font-size="13" font-weight="bold" fill="#0f172a" text-anchor="middle">NIST Traceable Standard</text>
  <text x="630" y="418" font-size="13" font-weight="bold" fill="#0f172a" text-anchor="middle">Analyzer Under Test</text>

  <!-- Test Rows -->
  ${testRowsSvg}

  <!-- Statement Paragraph -->
  <text x="60" y="${tableBottomY}" font-size="12" fill="#334155">
    We hereby certify that the analyzer detailed above has been tested and calibrated by the
  </text>
  <text x="60" y="${tableBottomY + 20}" font-size="12" fill="#334155">
    Undersigned, and its performance was found to meet our specifications unless noted otherwise in the comments section.
  </text>

  <!-- Signatures -->
  <text x="60" y="${tableBottomY + 70}" font-size="13" font-weight="bold" fill="#0f172a">For and on behalf of PhyMetrix Ltd</text>
  <text x="60" y="${tableBottomY + 110}" font-size="13" fill="#334155">For Quality Assurance Manager</text>

  <!-- Footer -->
  <line x1="60" y1="1040" x2="740" y2="1040" stroke="#cbd5e1" stroke-width="1"/>
  <text x="400" y="1065" font-size="11" fill="#64748b" text-anchor="middle">PhyMetrix Ltd. 120 West Beaver Creek Road #19, Richmond Hill, ON L4B 1L2 tel: (905)762-1616</text>
</svg>`;
}

function renderPackingSvgFromDocItems(docItems, extraContext) {
  let model = extraContext.task ? extraContext.task.model : 'DPT-990-Ex';

  for (let i = 0; i < docItems.length; i++) {
    const text = docItems[i].text;
    if (text.includes('发货清单') || text.includes('装箱清单')) {
      model = text.replace(/发货清单|装箱清单/g, '').trim() || model;
    }
  }

  let itemsSvg = '';
  let rowCount = 0;
  for (let i = 0; i < docItems.length; i++) {
    const item = docItems[i];
    if (/^[1-9]\d*$/.test(item.text.trim()) && i + 6 < docItems.length) {
      const idx = item.text.trim();
      const name = docItems[i + 1].text.trim();
      const spec = docItems[i + 2].text.trim();
      const count = docItems[i + 3].text.trim();
      const unit = docItems[i + 4].text.trim();
      const standard = docItems[i + 5].text.trim();
      const remark = docItems[i + 6].text.trim();

      if (name && (standard === '是' || standard === '否')) {
        const y = 160 + rowCount * 32;
        itemsSvg += `
          <rect x="60" y="${y}" width="680" height="32" fill="#ffffff" stroke="#1e293b" stroke-width="1"/>
          <line x1="110" y1="${y}" x2="110" y2="${y + 32}" stroke="#1e293b" stroke-width="1"/>
          <line x1="230" y1="${y}" x2="230" y2="${y + 32}" stroke="#1e293b" stroke-width="1"/>
          <line x1="380" y1="${y}" x2="380" y2="${y + 32}" stroke="#1e293b" stroke-width="1"/>
          <line x1="440" y1="${y}" x2="440" y2="${y + 32}" stroke="#1e293b" stroke-width="1"/>
          <line x1="500" y1="${y}" x2="500" y2="${y + 32}" stroke="#1e293b" stroke-width="1"/>
          <line x1="560" y1="${y}" x2="560" y2="${y + 32}" stroke="#1e293b" stroke-width="1"/>

          <text x="85" y="${y + 21}" font-size="13" fill="#0f172a" text-anchor="middle">${escapeXml(idx)}</text>
          <text x="170" y="${y + 21}" font-size="13" fill="#0f172a" text-anchor="middle">${escapeXml(name)}</text>
          <text x="305" y="${y + 21}" font-size="13" fill="#0f172a" text-anchor="middle">${escapeXml(spec)}</text>
          <text x="410" y="${y + 21}" font-size="13" fill="#0f172a" text-anchor="middle">${escapeXml(count)}</text>
          <text x="470" y="${y + 21}" font-size="13" fill="#0f172a" text-anchor="middle">${escapeXml(unit)}</text>
          <text x="530" y="${y + 21}" font-size="13" fill="#0f172a" text-anchor="middle">${escapeXml(standard)}</text>
          <text x="650" y="${y + 21}" font-size="12" fill="#0f172a" text-anchor="middle">${escapeXml(remark)}</text>
        `;
        rowCount++;
      }
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 1130" width="800" height="1130" font-family="'SimSun', 'Microsoft YaHei', sans-serif">
  <!-- Paper Background -->
  <rect x="0" y="0" width="800" height="1130" fill="#ffffff"/>
  <rect x="40" y="40" width="720" height="1050" fill="#ffffff" stroke="#cbd5e1" stroke-width="1"/>

  <!-- Top Header Lines -->
  <text x="60" y="80" font-size="15" font-weight="bold" fill="#000000">约克仪器</text>
  <text x="740" y="80" font-size="15" font-weight="bold" fill="#000000" text-anchor="end">创新科技</text>

  <text x="400" y="110" font-size="22" font-weight="bold" fill="#000000" text-anchor="middle">${escapeXml(model)}发货清单</text>

  <!-- Items Table Header -->
  <rect x="60" y="130" width="680" height="30" fill="#ffffff" stroke="#1e293b" stroke-width="1"/>
  <line x1="110" y1="130" x2="110" y2="160" stroke="#1e293b" stroke-width="1"/>
  <line x1="230" y1="130" x2="230" y2="160" stroke="#1e293b" stroke-width="1"/>
  <line x1="380" y1="130" x2="380" y2="160" stroke="#1e293b" stroke-width="1"/>
  <line x1="440" y1="130" x2="440" y2="160" stroke="#1e293b" stroke-width="1"/>
  <line x1="500" y1="130" x2="500" y2="160" stroke="#1e293b" stroke-width="1"/>
  <line x1="560" y1="130" x2="560" y2="160" stroke="#1e293b" stroke-width="1"/>

  <text x="85" y="150" font-size="13" font-weight="bold" fill="#000000" text-anchor="middle">序号</text>
  <text x="170" y="150" font-size="13" font-weight="bold" fill="#000000" text-anchor="middle">名称</text>
  <text x="305" y="150" font-size="13" font-weight="bold" fill="#000000" text-anchor="middle">规格/型号</text>
  <text x="410" y="150" font-size="13" font-weight="bold" fill="#000000" text-anchor="middle">数量</text>
  <text x="470" y="150" font-size="13" font-weight="bold" fill="#000000" text-anchor="middle">单位</text>
  <text x="530" y="150" font-size="13" font-weight="bold" fill="#000000" text-anchor="middle">标配</text>
  <text x="650" y="150" font-size="13" font-weight="bold" fill="#000000" text-anchor="middle">备注</text>

  <!-- Item Rows -->
  ${itemsSvg}
</svg>`;
}

module.exports = {
  generateDocumentPreview
};
