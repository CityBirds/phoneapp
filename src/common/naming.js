/**
 * Conditional Naming Engine
 * Baseline Rules: T07, T08, T09, T10, T11, C07
 */

function formatBeijingDate(dateInput) {
  const date = dateInput ? new Date(dateInput) : new Date();
  // Convert to Beijing time (UTC+8)
  const utc = date.getTime() + date.getTimezoneOffset() * 60000;
  const bjDate = new Date(utc + 3600000 * 8);
  const yyyy = bjDate.getFullYear();
  const mm = String(bjDate.getMonth() + 1).padStart(2, '0');
  const dd = String(bjDate.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

/**
 * Generate Certificate File Name
 * Spec Rule: 设备型号+证书+设备序列号+-+日期+-+发+选择的销售名字[+-+传感器型号].扩展名
 * Standard Examples:
 * - PGA500-EX证书EX0000608-20260717-发陈文-PSR-12-223.doc
 * - PGA500-EX证书EX0000608-20260717-发陈文.doc
 */
function generateCertFilename(params) {
  const {
    model,             // e.g. "PGA500-EX"
    deviceSn,          // e.g. "EX0000608"
    acceptedDate,      // e.g. "2026-07-17" or Date object
    salesPerson,       // e.g. "陈文"
    shippingLocation,  // optional fallback if salesPerson omitted
    sensorModel,       // e.g. "PSR-12-223"
    extension = '.doc' // e.g. ".doc"
  } = params;

  const dateStr = formatBeijingDate(acceptedDate);
  const ext = extension.startsWith('.') ? extension : `.${extension}`;

  const sensorPart = (sensorModel && String(sensorModel).trim()) ? `-${String(sensorModel).trim()}` : '';
  const salesName = salesPerson || shippingLocation || '';
  const salesPart = salesName ? `-发${String(salesName).trim()}` : '-发';

  return `${model}证书${deviceSn}-${dateStr}${salesPart}${sensorPart}${ext}`;
}

/**
 * Generate Packing List File Name
 * Spec Rule: 设备型号+发货清单+设备序列号+[带泵]+-+发+选择的发货地址+日期.扩展名
 * Standard Examples:
 * - PGA500-EX发货清单EX0000608带泵-发南京20260717.doc
 * - PGA500-EX发货清单EX0000608-发南京20260717.doc
 */
function generatePackingListFilename(params) {
  const {
    model,             // e.g. "PGA500-EX"
    deviceSn,          // e.g. "EX0000608"
    acceptedDate,      // e.g. "2026-07-17" or Date object
    shippingLocation = '南京', // e.g. "南京"
    hasPump,           // boolean
    extension = '.doc' // e.g. ".doc"
  } = params;

  const dateStr = formatBeijingDate(acceptedDate);
  const pumpSuffix = hasPump ? '带泵' : '';
  const locationPart = shippingLocation ? `-发${String(shippingLocation).trim()}` : '-发';
  const ext = extension.startsWith('.') ? extension : `.${extension}`;

  return `${model}发货清单${deviceSn}${pumpSuffix}${locationPart}${dateStr}${ext}`;
}

/**
 * Duplicate filename suffix handler (R19)
 * If target file exists and is protected/printed, generates "原名-副本(N).doc"
 */
function generateDuplicateCopyFilename(originalFilename, copyIndex = 1) {
  const lastDotIndex = originalFilename.lastIndexOf('.');
  let baseName = originalFilename;
  let ext = '';
  if (lastDotIndex > 0) {
    baseName = originalFilename.substring(0, lastDotIndex);
    ext = originalFilename.substring(lastDotIndex);
  }
  return `${baseName}-副本(${copyIndex})${ext}`;
}

module.exports = {
  formatBeijingDate,
  generateCertFilename,
  generatePackingListFilename,
  generateDuplicateCopyFilename
};
