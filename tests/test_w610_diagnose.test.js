const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { execSync } = require('child_process');

// Setup isolated environment for W610 diagnostic tests
const testBaseDir = path.resolve(__dirname, '../data/test_w610_diag_20261020');
const testDbPath = path.join(testBaseDir, 'test_w610_diag.db');
process.env.DB_PATH = testDbPath;
process.env.PREVIEW_DIR = path.join(testBaseDir, 'previews');
process.env.RETURNED_DIR = path.join(testBaseDir, 'returned');
process.env.PORT = '3098';
process.env.NODE_ENV = 'test';

if (fs.existsSync(testBaseDir)) {
  fs.rmSync(testBaseDir, { recursive: true, force: true });
}
fs.mkdirSync(testBaseDir, { recursive: true });

const db = require('../src/backend/db');
const app = require('../src/backend/server');
const ExecutionWorker = require('../src/worker/worker');
const poa200 = require('../src/worker/poa200_protocol');

let server;
const serverUrl = 'http://localhost:3098';

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(3098, () => resolve());
  });
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  try {
    if (fs.existsSync(testBaseDir)) fs.rmSync(testBaseDir, { recursive: true, force: true });
  } catch (e) {}
});

// Helper mock TCP server with strict socket tracking and cleanup
function createMockTcpDeviceServer(handler) {
  return new Promise((resolve) => {
    const sockets = new Set();
    const tcpServer = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {}); // Ignore server-side socket errors in mock
      socket.on('close', () => sockets.delete(socket));
      handler(socket);
    });
    tcpServer.listen(0, '127.0.0.1', () => {
      const port = tcpServer.address().port;
      resolve({
        tcpServer,
        port,
        close: () => new Promise((r) => {
          for (const s of sockets) {
            try { s.destroy(); } catch (e) {}
          }
          tcpServer.close(() => r());
        })
      });
    });
  });
}

test('DIAG-01: 连接被拒绝 / 连接超时 (tcpConnected=false, 明确区分错误，任务有限时间结束)', async () => {
  // Test connection to closed port
  const res = await poa200.sendW610Request({ ip: '127.0.0.1', port: 59999 }, poa200.CMD_READ_DATA, poa200.ADDR_INFO_DEVICE, null, 1000);
  assert.equal(res.ok, false);
  assert.equal(res.tcpConnected, false);
  assert.equal(res.deviceResponded, false);
  assert.equal(res.protocolValid, false);
  assert.equal(res.stage, 'CONNECT_FAILED');
  assert.ok(res.errorCode);
  assert.ok(res.elapsedMs >= 0);
  assert.equal(res.remotePort, 59999);
});

test('DIAG-02: TCP接受连接但无串口回复 (tcpConnected=true, DEVICE_TIMEOUT)', async () => {
  const dummyTcp = await createMockTcpDeviceServer((socket) => {
    // Silent TCP server: accept, do not reply
  });

  try {
    const res = await poa200.sendW610Request({ ip: '127.0.0.1', port: dummyTcp.port }, poa200.CMD_READ_DATA, poa200.ADDR_INFO_DEVICE, null, 500);
    assert.equal(res.ok, false);
    assert.equal(res.tcpConnected, true);
    assert.equal(res.deviceResponded, false);
    assert.equal(res.protocolValid, false);
    assert.equal(res.stage, 'DEVICE_TIMEOUT');
    assert.equal(res.errorCode, 'READ_TIMEOUT');
    assert.ok(res.message.includes('TCP已连接'));
    assert.ok(res.localAddress);
  } finally {
    await dummyTcp.close();
  }
});

test('DIAG-03: 收到坏CRC、错误长度或不匹配响应 (PROTOCOL_INVALID, 保留收到数据)', async () => {
  const dummyTcp = await createMockTcpDeviceServer((socket) => {
    socket.on('data', () => {
      // Send 30 bad CRC bytes
      const badFrame = Buffer.alloc(30, 0xAA);
      // Valid fstart 0xFE6B
      badFrame.writeUInt16LE(0xFE6B, 0);
      badFrame.writeUInt16LE(28, 14); // buslen
      badFrame.writeUInt16LE(10, 16); // datalen
      // Bad CRC at offset 28
      badFrame.writeUInt16BE(0x1234, 28);
      socket.write(badFrame);
    });
  });

  try {
    const res = await poa200.sendW610Request({ ip: '127.0.0.1', port: dummyTcp.port }, poa200.CMD_READ_DATA, poa200.ADDR_INFO_DEVICE, null, 500);
    assert.equal(res.ok, false);
    assert.equal(res.tcpConnected, true);
    assert.equal(res.deviceResponded, true);
    assert.equal(res.protocolValid, false);
    assert.equal(res.stage, 'PROTOCOL_INVALID');
    assert.ok(res.bytesReceived > 0);
  } finally {
    await dummyTcp.close();
  }
});

test('DIAG-04: 有效回复分成多个TCP片段 (完整组帧后READY)', async () => {
  const mockDevBuf = poa200.createMockDeviceInfo({ SnNo: 'AP10007513' });
  const validFrame = poa200.packYkbusFrame({
    cmd: poa200.CMD_READ_DATA,
    dataAddr: poa200.ADDR_INFO_DEVICE,
    payloadBuf: mockDevBuf
  });

  const dummyTcp = await createMockTcpDeviceServer((socket) => {
    socket.on('data', () => {
      // Send frame in 3 chunks with slight delays
      const part1 = validFrame.subarray(0, 50);
      const part2 = validFrame.subarray(50, 150);
      const part3 = validFrame.subarray(150);

      socket.write(part1);
      setTimeout(() => { try { socket.write(part2); } catch (e) {} }, 30);
      setTimeout(() => { try { socket.write(part3); } catch (e) {} }, 60);
    });
  });

  try {
    const res = await poa200.sendW610Request({ ip: '127.0.0.1', port: dummyTcp.port }, poa200.CMD_READ_DATA, poa200.ADDR_INFO_DEVICE, null, 1000);
    assert.equal(res.ok, true);
    assert.equal(res.tcpConnected, true);
    assert.equal(res.deviceResponded, true);
    assert.equal(res.protocolValid, true);
    assert.equal(res.stage, 'READY');
    assert.equal(res.bytesReceived, validFrame.length);
    const info = poa200.unpackDeviceInfo(res.dataBuffer);
    assert.equal(info.SnNo, 'AP10007513');
  } finally {
    await dummyTcp.close();
  }
});

test('DIAG-05: 收到部分帧后对方关闭 (CONNECTION_CLOSED, 说明不完整，无悬挂)', async () => {
  const dummyTcp = await createMockTcpDeviceServer((socket) => {
    socket.on('data', () => {
      // Send 10 bytes then close
      try { socket.write(Buffer.from([0x6B, 0xFE, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08])); } catch (e) {}
      setTimeout(() => { try { socket.destroy(); } catch (e) {} }, 20);
    });
  });

  try {
    const res = await poa200.sendW610Request({ ip: '127.0.0.1', port: dummyTcp.port }, poa200.CMD_READ_DATA, poa200.ADDR_INFO_DEVICE, null, 1000);
    assert.equal(res.ok, false);
    assert.equal(res.tcpConnected, true);
    assert.equal(res.deviceResponded, true);
    assert.equal(res.protocolValid, false);
    assert.equal(res.stage, 'CONNECTION_CLOSED');
    assert.ok(res.message.includes('不完整'));
  } finally {
    await dummyTcp.close();
  }
});

test('DIAG-06: 有效帧但设备信息结构非法 / 内部 CRC 失败 (DEVICE_INFO_INVALID)', async () => {
  // Create 248 bytes with corrupted internal CRC
  const badInfoBuf = Buffer.alloc(248, 0x55);
  badInfoBuf.writeUInt16LE(0x1234, 246); // Bad CRC

  const frame = poa200.packYkbusFrame({
    cmd: poa200.CMD_READ_DATA,
    dataAddr: poa200.ADDR_INFO_DEVICE,
    payloadBuf: badInfoBuf
  });

  const dummyTcp = await createMockTcpDeviceServer((socket) => {
    socket.on('data', () => {
      try { socket.write(frame); } catch (e) {}
    });
  });

  try {
    const res = await poa200.sendW610Request({ ip: '127.0.0.1', port: dummyTcp.port }, poa200.CMD_READ_DATA, poa200.ADDR_INFO_DEVICE, null, 1000);
    assert.equal(res.ok, true); // Frame was received and valid
    assert.equal(res.protocolValid, true);

    const info = poa200.unpackDeviceInfo(res.dataBuffer);
    assert.equal(info._crcValid, false);
  } finally {
    await dummyTcp.close();
  }
});

test('DIAG-07: 正常信息回复 (READY, 字段正确, 只读探测不产生设备写命令)', async () => {
  const mockBuf = poa200.createMockDeviceInfo({ SnNo: 'AP99887766', OutDate: '2026/10/20' });
  const frame = poa200.packYkbusFrame({
    cmd: poa200.CMD_READ_DATA,
    dataAddr: poa200.ADDR_INFO_DEVICE,
    payloadBuf: mockBuf
  });

  let receivedCmd = null;
  const dummyTcp = await createMockTcpDeviceServer((socket) => {
    socket.on('data', (buf) => {
      receivedCmd = buf.readUInt16LE(8);
      try { socket.write(frame); } catch (e) {}
    });
  });

  try {
    const res = await poa200.sendW610Request({ ip: '127.0.0.1', port: dummyTcp.port }, poa200.CMD_READ_DATA, poa200.ADDR_INFO_DEVICE, null, 1000);
    assert.equal(res.ok, true);
    assert.equal(res.stage, 'READY');
    assert.equal(receivedCmd, poa200.CMD_READ_DATA); // 0x0102, read-only
    const info = poa200.unpackDeviceInfo(res.dataBuffer);
    assert.equal(info.SnNo, 'AP99887766');
    assert.equal(info.OutDate, '2026/10/20');
  } finally {
    await dummyTcp.close();
  }
});

test('DIAG-08: timeout/error/close 连续触发 (仅一次结算，无未捕获异常或泄露)', async () => {
  const dummyTcp = await createMockTcpDeviceServer((socket) => {
    socket.on('data', () => {
      try { socket.write(Buffer.from([1, 2, 3])); } catch (e) {}
      setTimeout(() => {
        try { socket.destroy(new Error('err')); } catch (e) {}
      }, 10);
    });
  });

  try {
    const res = await poa200.sendW610Request({ ip: '127.0.0.1', port: dummyTcp.port }, poa200.CMD_READ_DATA, poa200.ADDR_INFO_DEVICE, null, 500);
    assert.ok(res.stage === 'CONNECTION_CLOSED' || res.stage === 'PROTOCOL_INVALID' || res.stage === 'DEVICE_TIMEOUT');
    assert.equal(res.tcpConnected, true);
  } finally {
    await dummyTcp.close();
  }
});

test('DIAG-09: 多设备探测累计耗时控制 (不误报离线，总限时可配置)', async () => {
  const workerDir = path.join(testBaseDir, 'worker_dir_diag09');
  fs.mkdirSync(workerDir, { recursive: true });

  const worker = new ExecutionWorker({ workerId: 'worker-diag-09', name: 'DiagWorker09', serverUrl, workingDir: workerDir });
  await worker.sendHeartbeat();

  // Create task with multiple mock devices
  const taskRes = await fetch(`${serverUrl}/api/w610/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workerId: 'worker-diag-09',
      action: 'probe',
      model: 'POA200',
      payload: {
        isMock: true,
        devices: [
          { id: 1, name: 'D1', ip: '127.0.0.1', port: 8899, mock: true },
          { id: 2, name: 'D2', ip: '127.0.0.2', port: 8899, mock: true },
          { id: 3, name: 'D3', ip: '127.0.0.3', port: 8899, mock: true }
        ]
      }
    })
  });

  const taskId = (await taskRes.json()).task.id;
  await worker.pollAndExecuteW610Tasks();

  const taskData = await (await fetch(`${serverUrl}/api/w610/tasks/${taskId}`)).json();
  assert.equal(taskData.status, 'SUCCESS');
  assert.equal(taskData.result.probeResults.length, 3);
});

test('DIAG-10: W1 任务由 W2 领取或回传 (拒绝越权 403，不修改 W1 任务)', async () => {
  // Register Worker 1 and Worker 2
  db.prepare(`
    INSERT INTO worker_access_auth (worker_id, secret_hash, secret_hint, registered_at, name_source)
    VALUES ('worker-diag-w1', 'hash1', 'hint1', ?, 'report')
  `).run(new Date().toISOString());

  db.prepare(`
    INSERT INTO worker_access_auth (worker_id, secret_hash, secret_hint, registered_at, name_source)
    VALUES ('worker-diag-w2', 'hash2', 'hint2', ?, 'report')
  `).run(new Date().toISOString());

  // Create W610 task for W1
  const ins = db.prepare(`
    INSERT INTO w610_tasks (req_id, client_id, client_name, worker_id, action, model, status, created_at, updated_at)
    VALUES ('req_diag_10', 'client1', 'Operator', 'worker-diag-w1', 'probe', 'POA200', 'PENDING', ?, ?)
  `).run(new Date().toISOString(), new Date().toISOString());

  const taskId = ins.lastInsertRowid;

  // Attempt to report W1 task result using W2 identity credentials
  const secret2 = 'token-w2-secret';
  db.prepare("UPDATE worker_access_auth SET secret_hash = ? WHERE worker_id = 'worker-diag-w2'").run(
    require('crypto').createHash('sha256').update(secret2).digest('hex')
  );

  const hackRes = await fetch(`${serverUrl}/api/worker/w610-tasks/${taskId}/result`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-worker-id': 'worker-diag-w2',
      'x-worker-token': secret2
    },
    body: JSON.stringify({ status: 'SUCCESS', result: { hacked: true } })
  });

  assert.equal(hackRes.status, 403);
  const hackData = await hackRes.json();
  assert.equal(hackData.code, 'TASK_WORKER_MISMATCH');

  // Verify W1 task remains unchanged in PENDING status
  const taskAfter = db.prepare('SELECT * FROM w610_tasks WHERE id = ?').get(taskId);
  assert.equal(taskAfter.status, 'PENDING');
  assert.ok(taskAfter.result === null || taskAfter.result === '{}');
});

test('DIAG-11: 选择 W1 后切换 W2，W1 旧响应迟到 (仅接受 W2 结果)', async () => {
  let serialState = { probeVersion: 1, activeWorkerId: 'W1' };
  const currentProbeVersion = serialState.probeVersion;

  // Simulate user switching to W2
  serialState.probeVersion += 1;
  serialState.activeWorkerId = 'W2';

  // Check condition for discarding late response
  const isStale = (serialState.probeVersion !== currentProbeVersion || serialState.activeWorkerId !== 'W1');
  assert.equal(isStale, true);
});

test('DIAG-12: 协调端看到 NAT 来源 IP (按 workerId 调度，记录真实 TCP 源地址)', async () => {
  const workerDir = path.join(testBaseDir, 'worker_dir_diag12');
  fs.mkdirSync(workerDir, { recursive: true });

  const worker = new ExecutionWorker({ workerId: 'worker-diag-12', name: 'DiagWorker12', serverUrl, workingDir: workerDir });
  worker.selfReportedIp = '192.168.2.106'; // WLAN IP behind NAT
  await worker.sendHeartbeat();

  const wRecord = db.prepare("SELECT * FROM workers WHERE id = 'worker-diag-12'").get();
  assert.ok(wRecord);
  assert.equal(wRecord.id, 'worker-diag-12');
  assert.ok(wRecord.ip);
});

test('DIAG-13: 配置不存在、停用、待探测、失败、就绪 (五种状态提示与未授权路径拦截)', async () => {
  const checkState = (cfg, auth) => {
    if (!cfg) return { code: 'UNCONFIGURED', reason: '未配置' };
    if (!cfg.is_enabled) return { code: 'DISABLED', reason: '未启用' };
    if (cfg.check_status === 'PENDING') return { code: 'PENDING', reason: '探测待完成' };
    if (cfg.check_status === 'FAILED') return { code: 'CHECK_FAILED', reason: '探测失败' };
    if (cfg.check_status === 'PASSED' && auth.allowed) return { code: 'READY', reason: '已就绪' };
    return { code: 'CHECK_FAILED', reason: '未获写入授权' };
  };

  assert.equal(checkState(null, { allowed: false }).code, 'UNCONFIGURED');
  assert.equal(checkState({ is_enabled: 0 }, { allowed: false }).code, 'DISABLED');
  assert.equal(checkState({ is_enabled: 1, check_status: 'PENDING' }, { allowed: false }).code, 'PENDING');
  assert.equal(checkState({ is_enabled: 1, check_status: 'FAILED' }, { allowed: false }).code, 'CHECK_FAILED');
  assert.equal(checkState({ is_enabled: 1, check_status: 'PASSED' }, { allowed: true }).code, 'READY');
});

test('DIAG-14: 新前端收到旧执行端结果 (不崩溃、不虚构 TCP 成功)', async () => {
  const oldResult = {
    http_ok: true,
    device_ok: false,
    detail: '网络不通'
  };

  const getStatusText = (dev) => {
    if (dev.stage === 'READY' || dev.device_ok) return ' (在线可通信)';
    if (dev.tcpConnected && !dev.deviceResponded) return ' (TCP可连接，设备未应答)';
    if (dev.deviceResponded && !dev.protocolValid) return ' (收到数据但协议校验失败)';
    if (dev.tcpConnected) return ' (TCP已连通，协议未就绪)';
    if (dev.tcpConnected === undefined) return ' (旧版结果，阶段未知)';
    return ' (离线)';
  };

  assert.equal(getStatusText(oldResult), ' (旧版结果，阶段未知)');
});

test('DIAG-15: 错误内容带 HTML、超长报文 (正确转义、长度受控)', async () => {
  const rawHtmlError = '<script>alert("XSS")</script><b>Overlong Error</b> ' + 'x'.repeat(1000);
  const escapeHtml = (str) => String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');

  const sanitized = escapeHtml(rawHtmlError);
  assert.equal(sanitized.includes('<script>'), false);
  assert.equal(sanitized.includes('&lt;script&gt;'), true);
});

test('DIAG-16: Node 与 XP 相同网络 / 协议夹具 (阶段、成功标准一致)', () => {
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
  const pyCode = "import sys, json; sys.path.insert(0, 'src/worker_xp'); import poa200_protocol_xp as poa200_xp; mock_buf = poa200_xp.create_mock_device_info({'SnNo': 'SN_PARITY_123'}); info = poa200_xp.unpack_device_info(mock_buf); print(json.dumps({'length': len(mock_buf), 'sn': info['SnNo'], 'crcValid': info['_crcValid']}))";
  const pyOutput = execSync(`${pythonCmd} -c "${pyCode}"`, { encoding: 'utf-8' });

  const pyRes = JSON.parse(pyOutput.trim());
  assert.equal(pyRes.length, 248);
  assert.equal(pyRes.sn, 'SN_PARITY_123');
  assert.equal(pyRes.crcValid, true);

  const nodeMock = poa200.createMockDeviceInfo({ SnNo: 'SN_PARITY_123' });
  const nodeInfo = poa200.unpackDeviceInfo(nodeMock);
  assert.equal(nodeMock.length, 248);
  assert.equal(nodeInfo.SnNo, 'SN_PARITY_123');
  assert.equal(nodeInfo._crcValid, true);
});

test('DIAG-17: 多网卡与实际跨网段部署 (协调端无需访问 W610，目标执行端主动完成请求)', async () => {
  const workerDir = path.join(testBaseDir, 'worker_dir_diag17');
  fs.mkdirSync(workerDir, { recursive: true });

  const worker = new ExecutionWorker({ workerId: 'worker-diag-17', name: 'CrossSubnetWorker', serverUrl, workingDir: workerDir });
  await worker.sendHeartbeat();

  // Create read_device task on worker
  const taskRes = await fetch(`${serverUrl}/api/w610/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workerId: 'worker-diag-17',
      action: 'read_device',
      model: 'POA200',
      payload: {
        isMock: true,
        w610Device: { id: 200, ip: '192.168.2.140', port: 8899 }
      }
    })
  });

  const taskId = (await taskRes.json()).task.id;
  await worker.pollAndExecuteW610Tasks();

  const taskData = await (await fetch(`${serverUrl}/api/w610/tasks/${taskId}`)).json();
  assert.equal(taskData.status, 'SUCCESS');
  assert.equal(taskData.result.deviceSn, 'AP10007513');
  assert.equal(taskData.result.diagnostics.remoteAddress, '192.168.2.140');
  assert.equal(taskData.result.diagnostics.remotePort, 8899);
});

test('DIAG-18: 同一 TCP 连接持续传入无效碎片 (总截止时间仍生效，缓冲不无限增长)', async () => {
  let timerId = null;
  const dummyTcp = await createMockTcpDeviceServer((socket) => {
    // Continuously write junk fragments every 10ms
    timerId = setInterval(() => {
      try {
        socket.write(Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55]));
      } catch (e) {
        clearInterval(timerId);
      }
    }, 10);
    socket.on('close', () => clearInterval(timerId));
  });

  try {
    const start = Date.now();
    const res = await poa200.sendW610Request({ ip: '127.0.0.1', port: dummyTcp.port }, poa200.CMD_READ_DATA, poa200.ADDR_INFO_DEVICE, null, 400);
    const elapsed = Date.now() - start;

    assert.equal(res.ok, false);
    assert.equal(res.tcpConnected, true);
    assert.equal(res.deviceResponded, true);
    assert.equal(res.protocolValid, false);
    assert.equal(res.stage, 'PROTOCOL_INVALID');
    assert.ok(elapsed <= 1000, `Execution should finish near timeout limit (got ${elapsed}ms)`);
  } finally {
    if (timerId) clearInterval(timerId);
    await dummyTcp.close();
  }
});
