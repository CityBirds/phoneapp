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
 * T07, T08, T10, T11
 */
function generateCertFilename(params) {
  const {
    model,             // e.g. "POA200"
    deviceSn,          // e.g. "AP10007513"
    acceptedDate,      // e.g. "2026-04-03" or Date object
    shippingLocation,  // e.g. "南京"
    sensorModel,       // e.g. "PSR-12-223(封装）"
    hasPump,           // boolean
    extension = '.doc' // e.g. ".doc"
  } = params;

  const dateStr = formatBeijingDate(acceptedDate);
  const pumpSuffix = hasPump ? '带泵' : '';
  const ext = extension.startsWith('.') ? extension : `.${extension}`;

  return `${model}证书${deviceSn}-${dateStr}发${shippingLocation}订单-${sensorModel}${pumpSuffix}${ext}`;
}

/**
 * Generate Packing List File Name
 * T07, T09, T10, T11
 */
function generatePackingListFilename(params) {
  const {
    model,             // e.g. "POA200"
    deviceSn,          // e.g. "AP10007513"
    acceptedDate,      // e.g. "2026-04-03" or Date object
    hasPump,           // boolean
    extension = '.doc' // e.g. ".doc"
  } = params;

  const dateStr = formatBeijingDate(acceptedDate);
  const poa140 = model === 'POA200' ? '(140)' : '';
  const pumpSuffix = hasPump ? '带泵' : '';
  const ext = extension.startsWith('.') ? extension : `.${extension}`;

  return `${model}${poa140}${deviceSn}发货清单${dateStr}${pumpSuffix}${ext}`;
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
