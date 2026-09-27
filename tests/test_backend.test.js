const test = require('node:test');
const assert = require('node:assert');
const { generateCertFilename, generatePackingListFilename, generateDuplicateCopyFilename } = require('../src/common/naming');
const { findFieldCandidates } = require('../src/common/matcher');
const { getBeijingCalendarRange } = require('../src/common/utils');

test('Conditional Naming Engine - POA200 Cert & Packing List (T07-T11)', () => {
  const certName = generateCertFilename({
    model: 'POA200',
    deviceSn: 'AP10007513',
    acceptedDate: '2026-04-03',
    shippingLocation: '南京',
    sensorModel: 'PSR-12-223(封装）',
    hasPump: true,
    extension: '.doc'
  });

  assert.strictEqual(
    certName,
    'POA200证书AP10007513-20260403发南京订单-PSR-12-223(封装）带泵.doc'
  );

  const packName = generatePackingListFilename({
    model: 'POA200',
    deviceSn: 'AP10007513',
    acceptedDate: '2026-04-03',
    hasPump: true,
    extension: '.doc'
  });

  assert.strictEqual(
    packName,
    'POA200(140)AP10007513发货清单20260403带泵.doc'
  );
});

test('Conditional Naming Engine - Non-POA200 Without Pump (T05, T09, T10)', () => {
  const packNameOther = generatePackingListFilename({
    model: 'DPT810',
    deviceSn: 'A010007031',
    acceptedDate: '2026-04-03',
    hasPump: false,
    extension: '.doc'
  });

  // Should NOT contain (140) and NOT contain 带泵
  assert.strictEqual(
    packNameOther,
    'DPT810A010007031发货清单20260403.doc'
  );
});

test('Duplicate Copy Naming Algorithm (R19)', () => {
  const copy1 = generateDuplicateCopyFilename('POA200(140)AP10007513发货清单20260403带泵.doc', 1);
  assert.strictEqual(copy1, 'POA200(140)AP10007513发货清单20260403带泵-副本(1).doc');

  const copy2 = generateDuplicateCopyFilename('POA200(140)AP10007513发货清单20260403带泵.doc', 2);
  assert.strictEqual(copy2, 'POA200(140)AP10007513发货清单20260403带泵-副本(2).doc');
});

test('Field Position Matcher Candidate Finder (T03, C04)', () => {
  const docItems = [
    { type: 'cell', text: 'Inst. SN.:', tableIdx: 0, rowIdx: 1, colIdx: 0 },
    { type: 'cell', text: 'AP10007513', tableIdx: 0, rowIdx: 1, colIdx: 1 },
    { type: 'cell', text: 'Customer:', tableIdx: 0, rowIdx: 0, colIdx: 0 },
    { type: 'cell', text: 'York', tableIdx: 0, rowIdx: 0, colIdx: 1 }
  ];

  const result = findFieldCandidates('Inst. SN.', docItems);
  assert.strictEqual(result.matchCount, 1);
  assert.strictEqual(result.candidates[0].candidateValue, 'AP10007513');
});

test('Beijing Natural Calendar Date Range (R30)', () => {
  const refDate = new Date('2026-04-09T10:30:00Z'); // Thursday
  const rangeToday = getBeijingCalendarRange('today', refDate);
  const rangeWeek = getBeijingCalendarRange('week', refDate);
  const rangeMonth = getBeijingCalendarRange('month', refDate);

  assert.ok(rangeToday.start.getTime() <= refDate.getTime());
  assert.ok(rangeWeek.start.getTime() <= rangeToday.start.getTime());
  assert.ok(rangeMonth.start.getTime() <= rangeToday.start.getTime());
});
