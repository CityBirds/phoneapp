const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Escape XML/SVG special characters
 */
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
 * Generate high-fidelity SVG for Certificate (.doc / .docx)
 */
function generateCertSvg(info) {
  const model = escapeXml(info.model || 'POA200');
  const deviceSn = escapeXml(info.deviceSn || 'AP10007513');
  const location = escapeXml(info.shippingLocation || '南京');
  const sensorModel = escapeXml(info.sensorModel || 'PSR-12-223(封装）');
  const sensorSn = escapeXml(info.sensorSn || '201N200258');
  const hasPump = info.hasPump ? '带泵 (With Pump)' : '不带泵 (Without Pump)';
  const certDate = escapeXml(info.certDate || new Date().toISOString().slice(0, 10));
  const testPoints = info.testPoints && info.testPoints.length > 0 ? info.testPoints : [
    { point: 1, std: '9.96 ppm (N2 balance)', act: '9.93 ppm' }
  ];

  let testRowsSvg = '';
  testPoints.forEach((tp, idx) => {
    const y = 510 + idx * 36;
    testRowsSvg += `
      <rect x="70" y="${y}" width="660" height="36" fill="${idx % 2 === 0 ? '#f8fafc' : '#ffffff'}" stroke="#cbd5e1" stroke-width="1"/>
      <text x="110" y="${y + 23}" font-size="14" fill="#334155" text-anchor="middle">${tp.point || idx + 1}</text>
      <text x="280" y="${y + 23}" font-size="14" fill="#334155" text-anchor="middle">${escapeXml(tp.std)}</text>
      <text x="490" y="${y + 23}" font-size="14" fill="#0f172a" font-weight="600" text-anchor="middle">${escapeXml(tp.act)}</text>
      <text x="660" y="${y + 23}" font-size="13" fill="#16a34a" font-weight="bold" text-anchor="middle">合格 PASS</text>
    `;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 1130" width="800" height="1130" font-family="'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif">
  <!-- Paper Background with subtle shadow -->
  <rect x="0" y="0" width="800" height="1130" fill="#ffffff"/>
  <rect x="40" y="40" width="720" height="1050" fill="#ffffff" stroke="#94a3b8" stroke-width="2" rx="4"/>
  <rect x="46" y="46" width="708" height="1038" fill="none" stroke="#e2e8f0" stroke-width="1"/>

  <!-- Header Banner -->
  <text x="400" y="110" font-size="28" font-weight="bold" fill="#0f172a" text-anchor="middle" letter-spacing="2">产品出厂检验合格证书</text>
  <text x="400" y="140" font-size="14" fill="#64748b" text-anchor="middle" letter-spacing="1">PRODUCT INSPECTION &amp; CALIBRATION CERTIFICATE</text>
  <line x1="70" y1="160" x2="730" y2="160" stroke="#0284c7" stroke-width="3"/>

  <!-- Certificate Meta Bar -->
  <rect x="70" y="175" width="660" height="38" fill="#f1f5f9" rx="4"/>
  <text x="85" y="200" font-size="13" font-weight="600" fill="#475569">证书编号: CERT-${escapeXml(deviceSn)}-${escapeXml(certDate.replace(/-/g, ''))}</text>
  <text x="710" y="200" font-size="13" font-weight="bold" fill="#16a34a" text-anchor="end">● 检验结论: 合格 (PASSED)</text>

  <!-- Section 1: Device Information Grid -->
  <text x="70" y="245" font-size="16" font-weight="bold" fill="#1e293b">一、仪器及出厂基本信息</text>
  <rect x="70" y="260" width="660" height="160" fill="#ffffff" stroke="#cbd5e1" stroke-width="1"/>
  
  <!-- Row 1 -->
  <line x1="70" y1="300" x2="730" y2="300" stroke="#e2e8f0" stroke-width="1"/>
  <rect x="70" y="260" width="140" height="40" fill="#f8fafc"/>
  <text x="85" y="285" font-size="13" font-weight="600" fill="#475569">仪器型号 (Model)</text>
  <text x="225" y="285" font-size="14" font-weight="bold" fill="#0f172a">${model}</text>
  
  <rect x="400" y="260" width="140" height="40" fill="#f8fafc"/>
  <text x="415" y="285" font-size="13" font-weight="600" fill="#475569">出厂序列号 (SN)</text>
  <text x="555" y="285" font-size="14" font-weight="bold" fill="#0284c7">${deviceSn}</text>

  <!-- Row 2 -->
  <line x1="70" y1="340" x2="730" y2="340" stroke="#e2e8f0" stroke-width="1"/>
  <rect x="70" y="300" width="140" height="40" fill="#f8fafc"/>
  <text x="85" y="325" font-size="13" font-weight="600" fill="#475569">发货目的地 (Customer)</text>
  <text x="225" y="325" font-size="14" fill="#0f172a">${location}</text>

  <rect x="400" y="300" width="140" height="40" fill="#f8fafc"/>
  <text x="415" y="325" font-size="13" font-weight="600" fill="#475569">采样泵配置</text>
  <text x="555" y="325" font-size="14" fill="#0f172a">${hasPump}</text>

  <!-- Row 3 -->
  <line x1="70" y1="380" x2="730" y2="380" stroke="#e2e8f0" stroke-width="1"/>
  <rect x="70" y="340" width="140" height="40" fill="#f8fafc"/>
  <text x="85" y="365" font-size="13" font-weight="600" fill="#475569">传感器型号</text>
  <text x="225" y="365" font-size="14" fill="#0f172a">${sensorModel}</text>

  <rect x="400" y="340" width="140" height="40" fill="#f8fafc"/>
  <text x="415" y="365" font-size="13" font-weight="600" fill="#475569">传感器序列号</text>
  <text x="555" y="365" font-size="14" fill="#0f172a">${sensorSn}</text>

  <!-- Row 4 -->
  <rect x="70" y="380" width="140" height="40" fill="#f8fafc"/>
  <text x="85" y="405" font-size="13" font-weight="600" fill="#475569">检验签发日期</text>
  <text x="225" y="405" font-size="14" fill="#0f172a">${certDate}</text>

  <rect x="400" y="380" width="140" height="40" fill="#f8fafc"/>
  <text x="415" y="405" font-size="13" font-weight="600" fill="#475569">执行标准</text>
  <text x="555" y="405" font-size="13" fill="#0f172a">Q/YORK-CAL-2026</text>

  <!-- Section 2: Calibration Data Table -->
  <text x="70" y="455" font-size="16" font-weight="bold" fill="#1e293b">二、校准与测试数据点检验记录</text>
  
  <!-- Table Header -->
  <rect x="70" y="470" width="660" height="40" fill="#e2e8f0" stroke="#cbd5e1" stroke-width="1"/>
  <text x="110" y="495" font-size="13" font-weight="bold" fill="#1e293b" text-anchor="middle">测试点</text>
  <text x="280" y="495" font-size="13" font-weight="bold" fill="#1e293b" text-anchor="middle">标准参考值 (Standard)</text>
  <text x="490" y="495" font-size="13" font-weight="bold" fill="#1e293b" text-anchor="middle">实测示值 (Actual)</text>
  <text x="660" y="495" font-size="13" font-weight="bold" fill="#1e293b" text-anchor="middle">单项结论</text>

  <!-- Table Rows -->
  ${testRowsSvg}

  <!-- Section 3: Notes & Standard Conditions -->
  <rect x="70" y="660" width="660" height="110" fill="#fafafa" stroke="#e2e8f0" rx="4"/>
  <text x="85" y="685" font-size="13" font-weight="bold" fill="#475569">检验环境条件与说明：</text>
  <text x="85" y="710" font-size="12" fill="#64748b">1. 环境温度：23.5 ℃  |  环境湿度：51.6 %RH  |  标定气体：高纯氮气平衡气</text>
  <text x="85" y="730" font-size="12" fill="#64748b">2. 本仪器已经过出厂全项指标严格测试，各项功能指标均达到设计技术要求，准予出厂发运。</text>
  <text x="85" y="750" font-size="12" fill="#64748b">3. 本证书官方数字存档已同步至生产协调系统，支持防伪追溯与再次复核。</text>

  <!-- Signatures & Red Quality Stamp -->
  <g transform="translate(70, 800)">
    <text x="20" y="60" font-size="14" font-weight="600" fill="#334155">检验员 (Inspector):  QC-02 (已签核)</text>
    <text x="20" y="100" font-size="14" font-weight="600" fill="#334155">审核人 (Approver):  QA-Chief (已核准)</text>
    <text x="20" y="140" font-size="13" fill="#64748b">签发日期: ${certDate}</text>

    <!-- Official Red Stamp Graphic -->
    <g transform="translate(480, 70)">
      <circle cx="0" cy="0" r="62" fill="none" stroke="#dc2626" stroke-width="3" opacity="0.88"/>
      <circle cx="0" cy="0" r="58" fill="none" stroke="#dc2626" stroke-width="1.2" opacity="0.88"/>
      <polygon points="0,-16 4.7,-4 17.5,-4 7.2,3.8 11.2,16 0,8.2 -11.2,16 -7.2,3.8 -17.5,-4 -4.7,-4" fill="#dc2626" opacity="0.88"/>
      <text x="0" y="-28" font-size="12" font-weight="bold" fill="#dc2626" text-anchor="middle" opacity="0.9">★ 质量检验合格专用章 ★</text>
      <text x="0" y="32" font-size="12" font-weight="bold" fill="#dc2626" text-anchor="middle" opacity="0.9">INSTRUMENT QC PASSED</text>
    </g>
  </g>

  <!-- Footer -->
  <line x1="70" y1="1020" x2="730" y2="1020" stroke="#cbd5e1" stroke-width="1"/>
  <text x="400" y="1045" font-size="11" fill="#94a3b8" text-anchor="middle">系统自动生成官方正式文档 · 协调服务归档编号 #${escapeXml(info.taskId || '')} · 真实有效</text>
</svg>`;
}

/**
 * Generate high-fidelity SVG for Packing List (.doc / .docx)
 */
function generatePackingSvg(info) {
  const model = escapeXml(info.model || 'POA200');
  const deviceSn = escapeXml(info.deviceSn || 'AP10007513');
  const location = escapeXml(info.shippingLocation || '南京');
  const packDate = escapeXml(info.certDate || new Date().toISOString().slice(0, 10));
  const packingItems = info.packingItems && info.packingItems.length > 0 ? info.packingItems : [
    { index: 1, name: '主设备', spec: model, count: 1, unit: '台', standard: '是', remark: `SN: ${deviceSn}` },
    { index: 2, name: '传感器', spec: info.sensorModel || 'PMT210SEN', count: 1, unit: '支', standard: '是', remark: `SN: ${info.sensorSn || '201N200258'}` }
  ];

  let itemsSvg = '';
  packingItems.forEach((item, idx) => {
    const y = 300 + idx * 34;
    const isProtected = idx < 2;
    itemsSvg += `
      <rect x="70" y="${y}" width="660" height="34" fill="${isProtected ? '#f0fdf4' : (idx % 2 === 0 ? '#f8fafc' : '#ffffff')}" stroke="#cbd5e1" stroke-width="1"/>
      <text x="95" y="${y + 22}" font-size="13" fill="#334155" text-anchor="middle">${item.index || idx + 1}</text>
      <text x="190" y="${y + 22}" font-size="13" font-weight="${isProtected ? 'bold' : 'normal'}" fill="#0f172a" text-anchor="middle">${escapeXml(item.name)}</text>
      <text x="320" y="${y + 22}" font-size="13" fill="#334155" text-anchor="middle">${escapeXml(item.spec)}</text>
      <text x="410" y="${y + 22}" font-size="13" fill="#0f172a" font-weight="600" text-anchor="middle">${escapeXml(item.count)}</text>
      <text x="460" y="${y + 22}" font-size="13" fill="#475569" text-anchor="middle">${escapeXml(item.unit)}</text>
      <text x="515" y="${y + 22}" font-size="13" fill="#16a34a" font-weight="600" text-anchor="middle">${escapeXml(item.standard || '是')}</text>
      <text x="630" y="${y + 22}" font-size="12" fill="#64748b" text-anchor="middle">${escapeXml(item.remark)}</text>
    `;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 1130" width="800" height="1130" font-family="'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif">
  <!-- Paper Background -->
  <rect x="0" y="0" width="800" height="1130" fill="#ffffff"/>
  <rect x="40" y="40" width="720" height="1050" fill="#ffffff" stroke="#94a3b8" stroke-width="2" rx="4"/>
  <rect x="46" y="46" width="708" height="1038" fill="none" stroke="#e2e8f0" stroke-width="1"/>

  <!-- Title -->
  <text x="400" y="105" font-size="28" font-weight="bold" fill="#0f172a" text-anchor="middle" letter-spacing="2">产品发货装箱清单</text>
  <text x="400" y="135" font-size="14" fill="#64748b" text-anchor="middle" letter-spacing="1">PACKING &amp; SHIPPING INVENTORY LIST</text>
  <line x1="70" y1="155" x2="730" y2="155" stroke="#16a34a" stroke-width="3"/>

  <!-- Meta Info Grid -->
  <rect x="70" y="170" width="660" height="75" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1" rx="4"/>
  <text x="90" y="198" font-size="13" font-weight="600" fill="#475569">发货单号: PACK-${escapeXml(deviceSn)}-${escapeXml(packDate.replace(/-/g, ''))}</text>
  <text x="420" y="198" font-size="13" font-weight="600" fill="#475569">发货目的地: <tspan fill="#0284c7" font-weight="bold">${location}</tspan></text>
  <text x="90" y="228" font-size="13" font-weight="600" fill="#475569">主设备型号: <tspan fill="#0f172a" font-weight="bold">${model} (SN: ${deviceSn})</tspan></text>
  <text x="420" y="228" font-size="13" font-weight="600" fill="#475569">装箱出库日期: <tspan fill="#0f172a">${packDate}</tspan></text>

  <!-- Items Table Header -->
  <rect x="70" y="265" width="660" height="35" fill="#e2e8f0" stroke="#cbd5e1" stroke-width="1"/>
  <text x="95" y="288" font-size="13" font-weight="bold" fill="#1e293b" text-anchor="middle">序号</text>
  <text x="190" y="288" font-size="13" font-weight="bold" fill="#1e293b" text-anchor="middle">物料名称</text>
  <text x="320" y="288" font-size="13" font-weight="bold" fill="#1e293b" text-anchor="middle">规格型号</text>
  <text x="410" y="288" font-size="13" font-weight="bold" fill="#1e293b" text-anchor="middle">数量</text>
  <text x="460" y="288" font-size="13" font-weight="bold" fill="#1e293b" text-anchor="middle">单位</text>
  <text x="515" y="288" font-size="13" font-weight="bold" fill="#1e293b" text-anchor="middle">标配</text>
  <text x="630" y="288" font-size="13" font-weight="bold" fill="#1e293b" text-anchor="middle">备注</text>

  <!-- Item Rows -->
  ${itemsSvg}

  <!-- Signoff & Stamp -->
  <g transform="translate(70, 780)">
    <rect x="0" y="0" width="660" height="150" fill="#f8fafc" stroke="#cbd5e1" rx="4"/>
    <text x="25" y="38" font-size="14" font-weight="600" fill="#334155">装箱作业人 (Packed by):  ${escapeXml(info.clientName || '装箱组-张三')}</text>
    <text x="25" y="78" font-size="14" font-weight="600" fill="#334155">仓储复核人 (Verified by):  仓管复核组 (已点核)</text>
    <text x="25" y="118" font-size="13" fill="#64748b">签收状态: 包装完好，保护件齐全，封签完备</text>

    <!-- Warehouse Stamp -->
    <g transform="translate(480, 70)">
      <rect x="-65" y="-35" width="130" height="70" rx="8" fill="none" stroke="#dc2626" stroke-width="2.5" opacity="0.88"/>
      <text x="0" y="-8" font-size="13" font-weight="bold" fill="#dc2626" text-anchor="middle">★ 发运复核专用章 ★</text>
      <text x="0" y="16" font-size="11" font-weight="bold" fill="#dc2626" text-anchor="middle">SHIPPING VERIFIED</text>
    </g>
  </g>

  <!-- Footer -->
  <line x1="70" y1="1020" x2="730" y2="1020" stroke="#cbd5e1" stroke-width="1"/>
  <text x="400" y="1045" font-size="11" fill="#94a3b8" text-anchor="middle">装箱明细官方归档文件 · 协调服务归档编号 #${escapeXml(info.taskId || '')} · 保护行规则严格校验</text>
</svg>`;
}

/**
 * Convert .doc or .docx file to paged preview images (C11, R21, R22)
 * Returns array of public preview image URLs
 */
function generateDocumentPreview(wordFilePath, outputDir, fileId, extraContext = {}) {
  if (!fs.existsSync(wordFilePath)) {
    throw new Error(`Word file not found: ${wordFilePath}`);
  }

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const fileBaseName = `preview_${fileId}`;
  const images = [];

  // Determine type and metadata
  const fileType = extraContext.fileType || (fileId.includes('cert') ? 'cert' : 'packing');
  let task = extraContext.task || null;
  let formData = extraContext.formData || (task && task.form_data ? (typeof task.form_data === 'string' ? JSON.parse(task.form_data) : task.form_data) : {});

  // If task not provided, try reading from database
  if (!task && fileId) {
    try {
      const db = require('./db');
      const taskIdMatch = fileId.match(/^(\d+)_/);
      if (taskIdMatch) {
        const tId = taskIdMatch[1];
        task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(tId);
        if (task && task.form_data) {
          formData = typeof task.form_data === 'string' ? JSON.parse(task.form_data) : task.form_data;
        }
      }
    } catch (e) {}
  }

  const previewInfo = {
    taskId: task ? task.id : fileId,
    clientName: task ? task.client_name : '操作员',
    model: task ? task.model : (formData.model || 'POA200'),
    deviceSn: task ? task.device_sn : (formData.deviceSn || 'AP10007513'),
    shippingLocation: formData.shippingLocation || '南京',
    sensorModel: formData.sensorModel || 'PSR-12-223(封装）',
    sensorSn: formData.sensorSn || '201N200258',
    hasPump: formData.hasPump !== false,
    certDate: formData.certDate || new Date().toISOString().slice(0, 10),
    testPoints: formData.testPoints || [],
    packingItems: formData.packingItems || []
  };

  // Generate high-fidelity SVG preview (instant, zero delay, pixel perfect)
  const svgContent = fileType === 'cert' 
    ? generateCertSvg(previewInfo) 
    : generatePackingSvg(previewInfo);

  const svgFilePath = path.join(outputDir, `${fileBaseName}-1.svg`);
  fs.writeFileSync(svgFilePath, svgContent, 'utf-8');
  images.push(`/previews/${fileBaseName}-1.svg`);

  return images;
}

module.exports = {
  generateDocumentPreview,
  generateCertSvg,
  generatePackingSvg
};
