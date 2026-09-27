const crypto = require('crypto');
const fs = require('fs');

function getBeijingNow() {
  const date = new Date();
  const utc = date.getTime() + date.getTimezoneOffset() * 60000;
  return new Date(utc + 3600000 * 8);
}

/**
 * Get Beijing Natural Calendar Date Ranges (R30)
 * Returns { start: Date, end: Date } for today, this week, or this month
 */
function getBeijingCalendarRange(rangeType, referenceDate = null) {
  const now = referenceDate ? new Date(referenceDate) : getBeijingNow();
  const yyyy = now.getFullYear();
  const mm = now.getMonth();
  const dd = now.getDate();

  // End date is current moment
  const end = new Date(now.getTime());

  let start;
  if (rangeType === 'today') {
    start = new Date(yyyy, mm, dd, 0, 0, 0, 0);
  } else if (rangeType === 'week') {
    // Week starts on Monday (00:00:00)
    const dayOfWeek = now.getDay(); // 0 is Sun, 1 is Mon...
    const diffToMon = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    start = new Date(yyyy, mm, dd - diffToMon, 0, 0, 0, 0);
  } else if (rangeType === 'month') {
    // Month starts on 1st day (00:00:00)
    start = new Date(yyyy, mm, 1, 0, 0, 0, 0);
  } else {
    // Default all time
    start = new Date(0);
  }

  return { start, end };
}

function generateUUID() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

function getFileSha256(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

module.exports = {
  getBeijingNow,
  getBeijingCalendarRange,
  generateUUID,
  getFileSha256
};
