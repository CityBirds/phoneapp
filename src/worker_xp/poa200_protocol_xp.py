# -*- coding: utf-8 -*-
"""
POA200 Binary Protocol & W610 HTTP Client for Windows XP (Python 2.7 / 3.4+)
Protocol Spec: W610串口服务器与POA200设备通信整改要求_20261014.md
"""

import struct
import json
import sys

# Python 2 / 3 compatibility for HTTP requests
try:
    import urllib.request as urllib_req
    import urllib.parse as urllib_parse
    import urllib.error as urllib_err
except ImportError:
    import urllib2 as urllib_req
    import urllib as urllib_parse
    import urllib2 as urllib_err

CMD_READ_MEASUREMENT = 0x84
CMD_WRITE_DATA = 0x0101
CMD_READ_DATA = 0x0102

ADDR_INFO_DEVICE = 0xE000
ADDR_O2CALFILE = 0xE200
ADDR_CALFILE = 0xE400


def calc_crc16(data):
    crc = 0xFFFF
    for byte in data:
        if sys.version_info[0] >= 3:
            val = byte
        else:
            val = ord(byte)
        crc ^= val
        for _ in range(8):
            if (crc & 0x0001) != 0:
                crc >>= 1
                crc ^= 0xA001
            else:
                crc >>= 1
    return crc & 0xFFFF


def read_string(data, offset, length):
    raw = data[offset:offset+length]
    null_idx = raw.find(b'\x00' if isinstance(raw, bytes) else '\x00')
    if null_idx != -1:
        raw = raw[:null_idx]
    if isinstance(raw, bytes):
        try:
            return raw.decode('utf-8').strip()
        except Exception:
            return raw.decode('latin1').strip()
    return str(raw).strip()


def write_string(data, text, offset, length):
    if text is None:
        text = ""
    if isinstance(text, str) and sys.version_info[0] < 3:
        encoded = text
    elif isinstance(text, str):
        encoded = text.encode('utf-8')
    else:
        encoded = str(text).encode('utf-8')

    encoded = encoded[:length]
    padded = encoded + b'\x00' * (length - len(encoded))
    data[offset:offset+length] = padded


def unpack_device_info(buf):
    if len(buf) < 248:
        raise ValueError("Device info buffer length invalid (%d < 248)" % len(buf))

    info = {}
    info['Name'] = read_string(buf, 0, 16)
    info['typecode'] = struct.unpack('<H', buf[16:18])[0]
    info['typeName'] = read_string(buf, 18, 14)
    info['OutDate'] = read_string(buf, 32, 16)
    info['SnNo'] = read_string(buf, 48, 16)
    info['VerNo'] = read_string(buf, 64, 32)
    info['SensorData'] = read_string(buf, 96, 16)

    floats = struct.unpack('<' + '20f', buf[112:192])
    info['Minimumdisplayvalue'] = floats[0]
    info['K1minCode'] = floats[1]
    info['K2maxCode'] = floats[2]
    info['BAK1'] = floats[3]
    info['MaxValue'] = floats[4]
    info['MinValue'] = floats[5]
    info['xIntervalValue'] = floats[6]
    info['BAK5'] = floats[7]
    info['xMinValue'] = floats[8]
    info['Min_Negative_value'] = floats[9]
    info['BAK6'] = floats[10]
    info['BAK7'] = floats[11]
    info['BAK8'] = floats[12]
    info['BAK9'] = floats[13]
    info['BAK10'] = floats[14]
    info['BAK11'] = floats[15]
    info['MinCoordinates_PPM'] = floats[16]
    info['MinCoordinates_BF'] = floats[17]
    info['BAK13'] = floats[18]
    info['BAKB16'] = floats[19]

    uints32 = struct.unpack('<4I', buf[192:208])
    info['AddrSerNo'] = uints32[0]
    info['Maximum_Charge_Voltage'] = uints32[1]
    info['Minimum_Charge_Current'] = uints32[2]
    info['Minimum_Charge_Voltage'] = uints32[3]

    bytes24 = struct.unpack('24B', buf[208:232])
    info['xEnable'] = bytes24[0]
    info['BAKC1'] = bytes24[1]
    info['BAKC2'] = bytes24[2]
    info['OpenDelayFlag'] = bytes24[3]
    info['OpenAirPumpFlag'] = bytes24[4]
    info['OpenPrintfFlag'] = bytes24[5]
    info['OpenBlueToothFlag'] = bytes24[6]
    info['OpenRecordFlag'] = bytes24[7]
    info['Language'] = bytes24[8]
    info['BlackLight'] = bytes24[9]
    info['DispiayNO'] = bytes24[10]
    info['SaveRepetFlag'] = bytes24[11]
    info['IntervalTime'] = bytes24[12]
    info['CurveTime'] = bytes24[13]
    info['PressureFlag'] = bytes24[14]
    info['AirPumpFlag'] = bytes24[15]
    info['PrintfFlag'] = bytes24[16]
    info['TemperatureFlag'] = bytes24[17]
    info['BlueToothFlag'] = bytes24[18]
    info['RecordFlag'] = bytes24[19]
    info['CalPassword'] = bytes24[20]
    info['ResetPassword'] = bytes24[21]
    info['BAKC9'] = bytes24[22]
    info['ChangeParFlag'] = bytes24[23]

    info['mode'] = struct.unpack('B', buf[232:233])[0]
    info['PumpOutValue'] = struct.unpack('B', buf[233:234])[0]

    uints16 = struct.unpack('<3H', buf[234:240])
    info['SalePassword'] = uints16[0]
    info['AdminPassword'] = uints16[1]
    info['DecimalNums'] = uints16[2]

    info['JMFlag'] = struct.unpack('B', buf[240:241])[0]
    info['TempFlag'] = struct.unpack('B', buf[241:242])[0]

    uints16_tail = struct.unpack('<3H', buf[242:248])
    info['BAKD1'] = uints16_tail[0]
    info['xCalDay'] = uints16_tail[1]
    info['Crc16'] = uints16_tail[2]

    return info


def pack_device_info(data_obj, existing_buf=None):
    if existing_buf and len(existing_buf) >= 248:
        buf = bytearray(existing_buf[:248])
    else:
        buf = bytearray(248)

    if 'Name' in data_obj:
        write_string(buf, data_obj['Name'], 0, 16)
    if 'typecode' in data_obj:
        struct.pack_into('<H', buf, 16, int(data_obj['typecode']))
    if 'typeName' in data_obj:
        write_string(buf, data_obj['typeName'], 18, 14)
    if 'OutDate' in data_obj:
        write_string(buf, data_obj['OutDate'], 32, 16)
    if 'SnNo' in data_obj:
        write_string(buf, data_obj['SnNo'], 48, 16)
    if 'VerNo' in data_obj:
        write_string(buf, data_obj['VerNo'], 64, 32)
    if 'SensorData' in data_obj:
        write_string(buf, data_obj['SensorData'], 96, 16)

    fmt_f = "<" + "float"[0]
    if 'Minimumdisplayvalue' in data_obj:
        struct.pack_into(fmt_f, buf, 112, float(data_obj['Minimumdisplayvalue']))
    if 'K1minCode' in data_obj:
        struct.pack_into(fmt_f, buf, 116, float(data_obj['K1minCode']))
    if 'K2maxCode' in data_obj:
        struct.pack_into(fmt_f, buf, 120, float(data_obj['K2maxCode']))

    crc = calc_crc16(bytes(buf[:246]) if sys.version_info[0] >= 3 else str(buf[:246]))
    struct.pack_into('<H', buf, 246, crc)

    return bytes(buf) if sys.version_info[0] >= 3 else str(buf)


def unpack_o2_cal_file(buf):
    if len(buf) < 204:
        raise ValueError("O2CALFILE buffer length invalid (%d < 204)" % len(buf))

    cal = {}
    floats = struct.unpack('<' + '6f', buf[0:24])
    cal['K1'] = floats[0]
    cal['K2'] = floats[1]
    cal['ZeroMax'] = floats[2]
    cal['ZeroMin'] = floats[3]
    cal['MinCal'] = floats[4]
    cal['lifeSpan'] = floats[5]

    bytes12 = struct.unpack('12B', buf[24:36])
    cal['SenserInx'] = bytes12[0]
    cal['openSatble1'] = bytes12[1]
    cal['openSatble2'] = bytes12[2]
    cal['openTc'] = bytes12[3]
    cal['calPtInx'] = bytes12[4]
    cal['Senser_ptCnt'] = bytes12[5]
    cal['stable_PtCnt'] = bytes12[6]
    cal['K1_I_ptCnt'] = bytes12[7]
    cal['K2_I_ptCnt'] = bytes12[8]
    cal['F_CAL_ptCnt'] = bytes12[9]
    cal['U_CAL_ptCnt'] = bytes12[10]
    cal['BK1'] = bytes12[11]

    fmt_2f = '<' + '2f'
    fmt_4f = '<' + '4f'
    fmt_2f2H = '<' + '2f2H'

    cal['Senser_pt'] = []
    offset = 36
    for _ in range(4):
        code, val = struct.unpack(fmt_2f, buf[offset:offset+8])
        cal['Senser_pt'].append({'code': code, 'Value': val})
        offset += 8

    cal['stable_Pt'] = []
    for _ in range(2):
        oldH, newH, oldL, newL = struct.unpack(fmt_4f, buf[offset:offset+16])
        cal['stable_Pt'].append({'oldH': oldH, 'newH': newH, 'oldL': oldL, 'newL': newL})
        offset += 16

    cal['K1_I_pt'] = []
    for _ in range(2):
        code, val = struct.unpack(fmt_2f, buf[offset:offset+8])
        cal['K1_I_pt'].append({'code': code, 'Value': val})
        offset += 8

    cal['K2_I_pt'] = []
    for _ in range(2):
        code, val = struct.unpack(fmt_2f, buf[offset:offset+8])
        cal['K2_I_pt'].append({'code': code, 'Value': val})
        offset += 8

    cal['F_CAL_pt'] = []
    for _ in range(3):
        code, val, u_f, bk = struct.unpack(fmt_2f2H, buf[offset:offset+12])
        cal['F_CAL_pt'].append({'code': code, 'Value': val, 'U_F': u_f, 'BK': bk})
        offset += 12

    cal['U_CAL_pt'] = []
    for _ in range(3):
        code, val, u_f, bk = struct.unpack(fmt_2f2H, buf[offset:offset+12])
        cal['U_CAL_pt'].append({'code': code, 'Value': val, 'U_F': u_f, 'BK': bk})
        offset += 12

    return cal


def send_w610_request(w610_device, cmd, data_addr, payload_bytes=None, timeout_sec=5):
    ip = w610_device.get('ip')
    port = w610_device.get('port', 80)
    cmd_hex = "0x%x" % cmd
    addr_hex = "0x%x" % data_addr

    data_hex = ""
    if payload_bytes:
        if sys.version_info[0] >= 3:
            data_hex = payload_bytes.hex()
        else:
            data_hex = payload_bytes.encode('hex')

    url = "http://%s:%d/api/v1/transfer?cmd=%s&addr=%s" % (ip, port, cmd_hex, addr_hex)
    post_dict = {
        "cmd": cmd_hex,
        "dataAddr": addr_hex,
        "data": data_hex
    }
    post_body = json.dumps(post_dict).encode('utf-8')

    req = urllib_req.Request(url, data=post_body)
    req.add_header('Content-Type', 'application/json')

    try:
        response = urllib_req.urlopen(req, timeout=timeout_sec)
        resp_bytes = response.read()
        try:
            resp_json = json.loads(resp_bytes.decode('utf-8'))
            if 'data' in resp_json and resp_json['data']:
                hex_data = resp_json['data']
                if sys.version_info[0] >= 3:
                    data_buf = bytes.fromhex(hex_data)
                else:
                    data_buf = hex_data.decode('hex')
                return {"ok": True, "dataBuffer": data_buf, "json": resp_json}
        except Exception:
            pass

        if len(resp_bytes) >= 200:
            return {"ok": True, "dataBuffer": resp_bytes}

        hex_str = resp_bytes.decode('utf-8').strip()
        if sys.version_info[0] >= 3:
            data_buf = bytes.fromhex(hex_str)
        else:
            data_buf = hex_str.decode('hex')
        return {"ok": True, "dataBuffer": data_buf}

    except Exception as e:
        return {"ok": False, "stage": "w610_http", "error": "W610 HTTP 通信失败: %s" % str(e)}


def create_mock_device_info(data=None):
    defaults = {
        'Name': 'POA200',
        'typecode': 0x200,
        'typeName': 'POA200',
        'OutDate': '2026/10/14',
        'SnNo': 'AP10007513',
        'VerNo': 'V1.0.2',
        'SensorData': '2026/10/01',
        'Minimumdisplayvalue': 0.1,
        'K1minCode': 1.0,
        'K2maxCode': 100.0,
        'BAK1': 0.0,
        'MaxValue': 1000.0,
        'MinValue': 0.0,
        'xIntervalValue': 3.0,
        'xMinValue': 0.3,
        'Min_Negative_value': -10.0,
        'MinCoordinates_PPM': 0.0,
        'MinCoordinates_BF': 0.0,
        'AddrSerNo': 10001,
        'Maximum_Charge_Voltage': 8200000,
        'Minimum_Charge_Current': 160,
        'Minimum_Charge_Voltage': 7300000,
        'xEnable': 1,
        'OpenDelayFlag': 1,
        'OpenAirPumpFlag': 1,
        'Language': 1,
        'BlackLight': 2,
        'DispiayNO': 1,
        'IntervalTime': 5,
        'CurveTime': 10,
        'PressureFlag': 1,
        'AirPumpFlag': 1,
        'PrintfFlag': 0,
        'TemperatureFlag': 1,
        'BlueToothFlag': 1,
        'RecordFlag': 1,
        'mode': 0,
        'PumpOutValue': 0,
        'DecimalNums': 2
    }
    if data:
        defaults.update(data)
    return pack_device_info(defaults)


def create_mock_o2_cal_file():
    buf = bytearray(204)
    fmt_f = "<" + "float"[0]
    struct.pack_into(fmt_f, buf, 0, 1.05)
    struct.pack_into(fmt_f, buf, 4, 0.98)
    struct.pack_into(fmt_f, buf, 8, 25.0)
    struct.pack_into(fmt_f, buf, 12, 0.0)
    struct.pack_into(fmt_f, buf, 16, 20.9)
    struct.pack_into(fmt_f, buf, 20, 365.0)
    buf[24] = 1
    buf[29] = 1
    struct.pack_into(fmt_f, buf, 36, 100.0)
    struct.pack_into(fmt_f, buf, 40, 20.9)
    return bytes(buf) if sys.version_info[0] >= 3 else str(buf)
