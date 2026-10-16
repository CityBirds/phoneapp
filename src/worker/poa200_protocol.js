/**
 * POA200 Binary Protocol & Communication Transports (Node.js 64-bit)
 * Protocol Spec: W610_POA200通信协议与程序整改执行规范_20261016.md
 */

const net = require('net');
const http = require('http');

// Command constants
const CMD_READ_MEASUREMENT = 0x84;
const CMD_WRITE_DATA = 0x0101;
const CMD_READ_DATA = 0x0102;

// Data addresses
const ADDR_INFO_DEVICE = 0xE000;
const ADDR_O2CALFILE = 0xE200;
const ADDR_CALFILE = 0xE400;

// Frame Start
const FRAME_START = 0xFE6B; // 0x6B, 0xFE in bytes

/**
 * Calculate CRC16 (MODBUS)
 */
function calcCrc16(buf, length) {
  let crc = 0xFFFF;
  const len = length !== undefined ? length : buf.length;
  for (let pos = 0; pos < len; pos++) {
    crc ^= buf[pos];
    for (let i = 8; i !== 0; i--) {
      if ((crc & 0x0001) !== 0) {
        crc >>= 1;
        crc ^= 0xA001;
      } else {
        crc >>= 1;
      }
    }
  }
  return crc & 0xFFFF;
}

/**
 * Helper to write string to Buffer with fixed size and null padding
 */
function writeString(buf, str, offset, length) {
  buf.fill(0, offset, offset + length);
  if (str !== undefined && str !== null) {
    const strBuf = Buffer.from(String(str), 'utf-8');
    strBuf.copy(buf, offset, 0, Math.min(strBuf.length, length));
  }
}

/**
 * Helper to read null-terminated string from Buffer
 */
function readString(buf, offset, length) {
  let end = offset;
  while (end < offset + length && buf[end] !== 0) {
    end++;
  }
  return buf.toString('utf-8', offset, end).trim();
}

/**
 * Pack YKBUS request frame (18-byte packed header + datalen bytes payload + 2-byte outer CRC)
 */
function packYkbusFrame(options = {}) {
  const {
    addr = 0x0000FFFF,
    deviceType = 0xD625,
    cmd = CMD_READ_MEASUREMENT,
    dataAddr = 0,
    payloadBuf = null,
    crcBigEndian = true
  } = options;

  const payload = payloadBuf ? Buffer.from(payloadBuf) : Buffer.alloc(0);
  const datalen = payload.length;
  const buslen = 18 + datalen;
  const frameLen = buslen + 2;

  const buf = Buffer.alloc(frameLen);
  buf.writeUInt16LE(FRAME_START, 0);       // 0-1: fstart 0xFE6B (6B FE)
  buf.writeUInt32LE(addr >>> 0, 2);        // 2-5: Addr
  buf.writeUInt16LE(deviceType, 6);         // 6-7: devicetype
  buf.writeUInt16LE(cmd, 8);               // 8-9: cmd
  buf.writeUInt32LE(dataAddr >>> 0, 10);    // 10-13: dataAddr
  buf.writeUInt16LE(buslen, 14);            // 14-15: buslen
  buf.writeUInt16LE(datalen, 16);           // 16-17: datalen

  if (datalen > 0) {
    payload.copy(buf, 18);
  }

  const crcVal = calcCrc16(buf, buslen);
  if (crcBigEndian) {
    buf.writeUInt16BE(crcVal, buslen);     // e.g. 0xC1FB in vector is C1 FB
  } else {
    buf.writeUInt16LE(crcVal, buslen);
  }

  return buf;
}

/**
 * Unpack YKBUS frame from buffer
 */
function unpackYkbusFrame(buf, options = {}) {
  const { crcBigEndian = true } = options;
  if (!buf || buf.length < 20) {
    throw new Error(`YKBUS 帧长度不足 20 字节 (${buf ? buf.length : 0})`);
  }

  const fstart = buf.readUInt16LE(0);
  if (fstart !== FRAME_START) {
    throw new Error(`Invalid YKBUS fstart: 0x${fstart.toString(16)} (expected 0xFE6B)`);
  }

  const addr = buf.readUInt32LE(2);
  const deviceType = buf.readUInt16LE(6);
  const cmd = buf.readUInt16LE(8);
  const dataAddr = buf.readUInt32LE(10);
  const buslen = buf.readUInt16LE(14);
  const datalen = buf.readUInt16LE(16);

  if (buslen !== 18 + datalen) {
    throw new Error(`YKBUS buslen Mismatch: buslen=${buslen}, datalen=${datalen} (expected buslen=18+datalen)`);
  }

  if (buf.length < buslen + 2) {
    throw new Error(`YKBUS 帧缓冲未包含完整载荷 (${buf.length} < ${buslen + 2})`);
  }

  const calcCrc = calcCrc16(buf, buslen);
  const frameCrc = crcBigEndian ? buf.readUInt16BE(buslen) : buf.readUInt16LE(buslen);

  if (calcCrc !== frameCrc) {
    throw new Error(`YKBUS 帧 CRC 校验失败: 期望 0x${calcCrc.toString(16)}, 实际 0x${frameCrc.toString(16)}`);
  }

  const payload = buf.subarray(18, 18 + datalen);
  return {
    fstart,
    addr,
    deviceType,
    cmd,
    dataAddr,
    buslen,
    datalen,
    payload,
    crc: frameCrc,
    crcValid: true
  };
}

/**
 * Stream Framer / Parser for YKBUS with bounded buffering
 */
function parseYkbusStream(streamBuf, options = {}) {
  const frames = [];
  let offset = 0;

  while (offset + 20 <= streamBuf.length) {
    // Find frame header 0xFE6B (bytes 0x6B 0xFE)
    if (streamBuf[offset] === 0x6B && streamBuf[offset + 1] === 0xFE) {
      if (offset + 18 > streamBuf.length) break;
      const buslen = streamBuf.readUInt16LE(offset + 14);
      const totalLen = buslen + 2;

      // Reject overlong frames
      if (buslen < 18 || buslen > 4096) {
        offset++;
        continue;
      }

      if (offset + totalLen <= streamBuf.length) {
        const candidate = streamBuf.subarray(offset, offset + totalLen);
        try {
          const frame = unpackYkbusFrame(candidate, options);
          frames.push(frame);
          offset += totalLen;
          continue;
        } catch (e) {
          // Invalid CRC or frame corrupt, advance by 1
          offset++;
          continue;
        }
      } else {
        // Incomplete frame, wait for more data
        break;
      }
    } else {
      offset++;
    }
  }

  return { frames, remaining: streamBuf.subarray(offset) };
}

/**
 * Unpack INFO_DEVICE binary structure (248 bytes)
 */
function unpackDeviceInfo(buf) {
  if (!buf || buf.length < 248) {
    throw new Error(`Device info buffer length invalid (${buf ? buf.length : 0} < 248)`);
  }

  const info = {};
  info.Name = readString(buf, 0, 16);
  info.typecode = buf.readUInt16LE(16);
  info.typeName = readString(buf, 18, 14);
  info.OutDate = readString(buf, 32, 16);
  info.SnNo = readString(buf, 48, 16);
  info.VerNo = readString(buf, 64, 32);
  info.SensorData = readString(buf, 96, 16);

  info.Minimumdisplayvalue = buf.readFloatLE(112);
  info.K1minCode = buf.readFloatLE(116);
  info.K2maxCode = buf.readFloatLE(120);
  info.BAK1 = buf.readFloatLE(124);

  info.MaxValue = buf.readFloatLE(128);
  info.MinValue = buf.readFloatLE(132);
  info.xIntervalValue = buf.readFloatLE(136);
  info.BAK5 = buf.readFloatLE(140);
  info.xMinValue = buf.readFloatLE(144);
  info.Min_Negative_value = buf.readFloatLE(148);
  info.BAK6 = buf.readFloatLE(152);
  info.BAK7 = buf.readFloatLE(156);
  info.BAK8 = buf.readFloatLE(160);
  info.BAK9 = buf.readFloatLE(164);
  info.BAK10 = buf.readFloatLE(168);
  info.BAK11 = buf.readFloatLE(172);

  info.MinCoordinates_PPM = buf.readFloatLE(176);
  info.MinCoordinates_BF = buf.readFloatLE(180);
  info.BAK13 = buf.readFloatLE(184);
  info.BAKB16 = buf.readFloatLE(188);

  info.AddrSerNo = buf.readUInt32LE(192);
  info.Maximum_Charge_Voltage = buf.readUInt32LE(196);
  info.Minimum_Charge_Current = buf.readUInt32LE(200);
  info.Minimum_Charge_Voltage = buf.readUInt32LE(204);

  info.xEnable = buf.readUInt8(208);
  info.BAKC1 = buf.readUInt8(209);
  info.BAKC2 = buf.readUInt8(210);
  info.OpenDelayFlag = buf.readUInt8(211);
  info.OpenAirPumpFlag = buf.readUInt8(212);
  info.OpenPrintfFlag = buf.readUInt8(213);
  info.OpenBlueToothFlag = buf.readUInt8(214);
  info.OpenRecordFlag = buf.readUInt8(215);

  info.Language = buf.readUInt8(216);
  info.BlackLight = buf.readUInt8(217);
  info.DispiayNO = buf.readUInt8(218);
  info.SaveRepetFlag = buf.readUInt8(219);
  info.IntervalTime = buf.readUInt8(220);
  info.CurveTime = buf.readUInt8(221);

  info.PressureFlag = buf.readUInt8(222);
  info.AirPumpFlag = buf.readUInt8(223);
  info.PrintfFlag = buf.readUInt8(224);
  info.TemperatureFlag = buf.readUInt8(225);
  info.BlueToothFlag = buf.readUInt8(226);
  info.RecordFlag = buf.readUInt8(227);
  info.CalPassword = buf.readUInt8(228);
  info.ResetPassword = buf.readUInt8(229);
  info.BAKC9 = buf.readUInt8(230);
  info.ChangeParFlag = buf.readUInt8(231);

  info.mode = buf.readUInt8(232);
  info.PumpOutValue = buf.readUInt8(233);

  info.SalePassword = buf.readUInt16LE(234);
  info.AdminPassword = buf.readUInt16LE(236);
  info.DecimalNums = buf.readUInt16LE(238);
  info.JMFlag = buf.readUInt8(240);
  info.TempFlag = buf.readUInt8(241);
  info.BAKD1 = buf.readUInt16LE(242);
  info.xCalDay = buf.readUInt16LE(244);
  info.Crc16 = buf.readUInt16LE(246);

  // Validate internal CRC
  const computedCrc = calcCrc16(buf, 246);
  if (computedCrc !== info.Crc16) {
    info._crcValid = false;
  } else {
    info._crcValid = true;
  }

  return info;
}

/**
 * Pack INFO_DEVICE structure into 248-byte Buffer.
 * P0 Safety Rule: Must preserve original block bytes if existingBuf is supplied.
 */
function packDeviceInfo(dataObj, existingBuf) {
  const buf = Buffer.alloc(248);
  if (existingBuf && existingBuf.length >= 248) {
    existingBuf.copy(buf, 0, 0, 248);
  } else if (!existingBuf && dataObj.isMock !== true && process.env.NODE_ENV !== 'test') {
    throw new Error('P0 校验拦截：必须基于读到的原始 248 字节 INFO_DEVICE 块进行修改，禁止从零重建！');
  }

  if (dataObj.Name !== undefined) writeString(buf, dataObj.Name, 0, 16);
  if (dataObj.typecode !== undefined) buf.writeUInt16LE(Number(dataObj.typecode) || 0, 16);
  if (dataObj.typeName !== undefined) writeString(buf, dataObj.typeName, 18, 14);
  if (dataObj.OutDate !== undefined) writeString(buf, dataObj.OutDate, 32, 16);
  if (dataObj.SnNo !== undefined) writeString(buf, dataObj.SnNo, 48, 16);
  if (dataObj.VerNo !== undefined) writeString(buf, dataObj.VerNo, 64, 32);
  if (dataObj.SensorData !== undefined) writeString(buf, dataObj.SensorData, 96, 16);

  if (dataObj.Minimumdisplayvalue !== undefined) buf.writeFloatLE(Number(dataObj.Minimumdisplayvalue) || 0, 112);
  if (dataObj.K1minCode !== undefined) buf.writeFloatLE(Number(dataObj.K1minCode) || 0, 116);
  if (dataObj.K2maxCode !== undefined) buf.writeFloatLE(Number(dataObj.K2maxCode) || 0, 120);
  if (dataObj.BAK1 !== undefined) buf.writeFloatLE(Number(dataObj.BAK1) || 0, 124);

  if (dataObj.MaxValue !== undefined) buf.writeFloatLE(Number(dataObj.MaxValue) || 0, 128);
  if (dataObj.MinValue !== undefined) buf.writeFloatLE(Number(dataObj.MinValue) || 0, 132);
  if (dataObj.xIntervalValue !== undefined) buf.writeFloatLE(Number(dataObj.xIntervalValue) || 0, 136);

  if (dataObj.Language !== undefined) buf.writeUInt8(Number(dataObj.Language) || 0, 216);
  if (dataObj.ChangeParFlag !== undefined) buf.writeUInt8(dataObj.ChangeParFlag ? 1 : 0, 231);

  // Re-calculate internal CRC16 on bytes 0..245
  const crc = calcCrc16(buf, 246);
  buf.writeUInt16LE(crc, 246);

  return buf;
}

/**
 * Unpack O2CALFILE binary structure (204 bytes)
 */
function unpackO2CalFile(buf) {
  if (!buf || buf.length < 204) {
    throw new Error(`O2CALFILE buffer length invalid (${buf ? buf.length : 0} < 204)`);
  }

  const cal = {};
  cal.K1 = buf.readFloatLE(0);
  cal.K2 = buf.readFloatLE(4);
  cal.ZeroMax = buf.readFloatLE(8);
  cal.ZeroMin = buf.readFloatLE(12);
  cal.MinCal = buf.readFloatLE(16);
  cal.lifeSpan = buf.readFloatLE(20);

  cal.SenserInx = buf.readUInt8(24);
  cal.openSatble1 = buf.readUInt8(25);
  cal.openSatble2 = buf.readUInt8(26);
  cal.openTc = buf.readUInt8(27);
  cal.calPtInx = buf.readUInt8(28);

  cal.Senser_ptCnt = buf.readUInt8(29);
  cal.stable_PtCnt = buf.readUInt8(30);
  cal.K1_I_ptCnt = buf.readUInt8(31);
  cal.K2_I_ptCnt = buf.readUInt8(32);
  cal.F_CAL_ptCnt = buf.readUInt8(33);
  cal.U_CAL_ptCnt = buf.readUInt8(34);
  cal.BK1 = buf.readUInt8(35);

  cal.Senser_pt = [];
  let offset = 36;
  for (let i = 0; i < 4; i++) {
    cal.Senser_pt.push({ code: buf.readFloatLE(offset), Value: buf.readFloatLE(offset + 4) });
    offset += 8;
  }

  cal.stable_Pt = [];
  for (let i = 0; i < 2; i++) {
    cal.stable_Pt.push({
      oldH: buf.readFloatLE(offset),
      newH: buf.readFloatLE(offset + 4),
      oldL: buf.readFloatLE(offset + 8),
      newL: buf.readFloatLE(offset + 12)
    });
    offset += 16;
  }

  cal.K1_I_pt = [];
  for (let i = 0; i < 2; i++) {
    cal.K1_I_pt.push({ code: buf.readFloatLE(offset), Value: buf.readFloatLE(offset + 4) });
    offset += 8;
  }

  cal.K2_I_pt = [];
  for (let i = 0; i < 2; i++) {
    cal.K2_I_pt.push({ code: buf.readFloatLE(offset), Value: buf.readFloatLE(offset + 4) });
    offset += 8;
  }

  cal.F_CAL_pt = [];
  for (let i = 0; i < 3; i++) {
    cal.F_CAL_pt.push({
      code: buf.readFloatLE(offset),
      Value: buf.readFloatLE(offset + 4),
      U_F: buf.readUInt16LE(offset + 8),
      BK: buf.readUInt16LE(offset + 10)
    });
    offset += 12;
  }

  cal.U_CAL_pt = [];
  for (let i = 0; i < 3; i++) {
    cal.U_CAL_pt.push({
      code: buf.readFloatLE(offset),
      Value: buf.readFloatLE(offset + 4),
      U_F: buf.readUInt16LE(offset + 8),
      BK: buf.readUInt16LE(offset + 10)
    });
    offset += 12;
  }

  return cal;
}

/**
 * Unpack CALVALUE_O2 measurement binary structure (112 bytes)
 * Spec 3.4 & attachment screenshot fb2768d1-c75b-4301-8c50-5773b6f67e9f.png
 */
function unpackCalValueO2(buf) {
  if (!buf || buf.length < 112) {
    throw new Error(`CALVALUE_O2 buffer length invalid (${buf ? buf.length : 0} < 112)`);
  }

  const data = {};
  data.sTmpValue = buf.readFloatLE(0);
  data.O2code = buf.readFloatLE(4);
  data.cvalue = buf.readFloatLE(8);
  data.dvalue = buf.readFloatLE(12);
  data.dot = buf.readFloatLE(16);
  data.k = buf.readFloatLE(20);

  data.cO2Value = buf.readFloatLE(24);
  data.cTmpValue = buf.readFloatLE(28);
  data.cOutO2Value = buf.readFloatLE(32);
  data.ssO2Value = buf.readFloatLE(36);
  data.sOutO2Value = buf.readFloatLE(40);
  data.ADvalue = buf.readFloatLE(44);

  data.adsG = buf.readUInt16LE(48); // 0: low gain, 1: high gain
  data.unit = buf.readUInt16LE(50); // 0: %, 1: PPM
  data.Err = buf.readUInt16LE(52);
  data.INA2 = buf.readUInt16LE(54);

  data.Ina = buf.readFloatLE(56);
  data.Ina_no_t = buf.readFloatLE(60);
  data.aOutO2Value = buf.readFloatLE(64);
  data.d1 = buf.readFloatLE(68);
  data.d2 = buf.readFloatLE(72);
  data.CalPtRangeMax = buf.readFloatLE(76);
  data.CalPtRangeMin = buf.readFloatLE(80);

  data.Back = [];
  let offset = 84;
  for (let i = 0; i < 14; i++) {
    data.Back.push(buf.readUInt16LE(offset));
    offset += 2;
  }

  return data;
}

/**
 * Transport Adapters
 */

class TcpTransportAdapter {
  async sendRequest(device, frameBuf, timeoutMs = 5000) {
    const ip = device.ip;
    const port = device.port || 80;

    return new Promise((resolve) => {
      const socket = new net.Socket();
      let rxBuf = Buffer.alloc(0);

      socket.setTimeout(timeoutMs);

      socket.connect(port, ip, () => {
        socket.write(frameBuf);
      });

      socket.on('data', (chunk) => {
        rxBuf = Buffer.concat([rxBuf, chunk]);
        const parseResult = parseYkbusStream(rxBuf);
        if (parseResult.frames.length > 0) {
          socket.destroy();
          return resolve({ ok: true, frame: parseResult.frames[0], rawData: parseResult.frames[0].payload });
        }
      });

      socket.on('timeout', () => {
        socket.destroy();
        resolve({ ok: false, stage: 'DEVICE_NO_RESPONSE', error: `TCP 连接/响应超时 (${timeoutMs}ms)` });
      });

      socket.on('error', (err) => {
        socket.destroy();
        resolve({ ok: false, stage: 'NETWORK_UNREACHABLE', error: `TCP 网络不可达: ${err.message}` });
      });
    });
  }
}

class HttpBridgeTransportAdapter {
  async sendRequest(device, frameBuf, timeoutMs = 5000) {
    const ip = device.ip;
    const port = device.port || 80;

    return new Promise((resolve) => {
      const hexPayload = frameBuf.toString('hex');
      const req = http.request({
        hostname: ip,
        port: port,
        path: `/api/v1/transfer`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(hexPayload)
        },
        timeout: timeoutMs
      }, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const bodyBuf = Buffer.concat(chunks);
          // Reject HTML response
          const headStr = bodyBuf.slice(0, 100).toString('utf-8').trim().toLowerCase();
          if (headStr.includes('<html') || headStr.includes('<!doctype')) {
            return resolve({ ok: false, stage: 'INTERFACE_MISMATCH', error: 'W610 接口返回 HTML 网页，非有效设备报文' });
          }

          if (res.statusCode >= 200 && res.statusCode < 300) {
            // Attempt YKBUS frame parsing from body
            const parseRes = parseYkbusStream(bodyBuf);
            if (parseRes.frames.length > 0) {
              return resolve({ ok: true, frame: parseRes.frames[0], rawData: parseRes.frames[0].payload });
            }
            if (bodyBuf.length >= 200) {
              return resolve({ ok: true, rawData: bodyBuf });
            }
            return resolve({ ok: true, rawData: bodyBuf });
          } else {
            return resolve({ ok: false, stage: 'INTERFACE_MISMATCH', error: `W610 HTTP 响应错误: ${res.statusCode}` });
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, stage: 'DEVICE_NO_RESPONSE', error: `HTTP 请求超时 (${timeoutMs}ms)` });
      });

      req.on('error', (err) => {
        resolve({ ok: false, stage: 'NETWORK_UNREACHABLE', error: `W610 HTTP 连接失败: ${err.message}` });
      });

      req.write(hexPayload);
      req.end();
    });
  }
}

/**
 * Unified request dispatcher
 */
async function sendW610Request(device, cmd, dataAddr, payloadBuffer = null, timeoutMs = 5000, options = {}) {
  const { transport = 'tcp' } = options;
  const frameBuf = packYkbusFrame({
    addr: device.addr !== undefined ? device.addr : 0x0000FFFF,
    deviceType: device.deviceType !== undefined ? device.deviceType : 0xD625,
    cmd,
    dataAddr,
    payloadBuf: payloadBuffer
  });

  if (transport === 'http') {
    const adapter = new HttpBridgeTransportAdapter();
    const res = await adapter.sendRequest(device, frameBuf, timeoutMs);
    if (res.ok) {
      return { ok: true, dataBuffer: res.rawData, frame: res.frame };
    }
    return res;
  }

  // Default TCP adapter
  const adapter = new TcpTransportAdapter();
  const res = await adapter.sendRequest(device, frameBuf, timeoutMs);
  if (res.ok) {
    return { ok: true, dataBuffer: res.rawData, frame: res.frame };
  }
  return res;
}

/**
 * Mocks for explicit isolated test mode
 */
function createMockDeviceInfo(data = {}) {
  const defaults = {
    Name: 'POA200',
    typecode: 0x200,
    typeName: 'POA200',
    OutDate: '2026/10/14',
    SnNo: 'AP10007513',
    VerNo: 'V1.0.2',
    SensorData: '2026/10/01',
    Minimumdisplayvalue: 0.1,
    K1minCode: 1.0,
    K2maxCode: 100.0,
    BAK1: 0,
    MaxValue: 1000.0,
    MinValue: 0.0,
    xIntervalValue: 3.0,
    xMinValue: 0.3,
    Min_Negative_value: -10.0,
    MinCoordinates_PPM: 0.0,
    MinCoordinates_BF: 0.0,
    AddrSerNo: 10001,
    Maximum_Charge_Voltage: 8200000,
    Minimum_Charge_Current: 160,
    Minimum_Charge_Voltage: 7300000,
    xEnable: 1,
    OpenDelayFlag: 1,
    OpenAirPumpFlag: 1,
    Language: 1,
    BlackLight: 2,
    DispiayNO: 1,
    IntervalTime: 5,
    CurveTime: 10,
    PressureFlag: 1,
    AirPumpFlag: 1,
    PrintfFlag: 0,
    TemperatureFlag: 1,
    BlueToothFlag: 1,
    RecordFlag: 1,
    mode: 0,
    PumpOutValue: 0,
    DecimalNums: 2,
    isMock: true,
    ...data
  };

  const emptyBuf = Buffer.alloc(248);
  return packDeviceInfo(defaults, emptyBuf);
}

function createMockO2CalFile() {
  const buf = Buffer.alloc(204);
  buf.writeFloatLE(1.05, 0); // K1
  buf.writeFloatLE(0.98, 4); // K2
  buf.writeFloatLE(25.0, 8); // ZeroMax
  buf.writeFloatLE(0.0, 12); // ZeroMin
  buf.writeFloatLE(20.9, 16); // MinCal
  buf.writeFloatLE(365.0, 20); // lifeSpan

  buf.writeUInt8(1, 24); // SenserInx
  buf.writeUInt8(1, 29); // Senser_ptCnt

  // Senser_pt[0]
  buf.writeFloatLE(100.0, 36);
  buf.writeFloatLE(20.9, 40);

  return buf;
}

function createMockCalValueO2() {
  const buf = Buffer.alloc(112);
  buf.writeFloatLE(25.4, 0);  // sTmpValue
  buf.writeFloatLE(10.5, 4);  // O2code
  buf.writeFloatLE(9.98, 8);  // cvalue
  buf.writeUInt16LE(1, 48);   // adsG
  buf.writeUInt16LE(1, 50);   // unit (PPM)
  return buf;
}

module.exports = {
  CMD_READ_MEASUREMENT,
  CMD_WRITE_DATA,
  CMD_READ_DATA,
  ADDR_INFO_DEVICE,
  ADDR_O2CALFILE,
  ADDR_CALFILE,
  FRAME_START,
  calcCrc16,
  packYkbusFrame,
  unpackYkbusFrame,
  parseYkbusStream,
  unpackDeviceInfo,
  packDeviceInfo,
  unpackO2CalFile,
  unpackCalValueO2,
  sendW610Request,
  createMockDeviceInfo,
  createMockO2CalFile,
  createMockCalValueO2
};
