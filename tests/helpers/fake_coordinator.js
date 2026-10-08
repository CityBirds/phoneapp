/**
 * 假协调服务：用于真实验证执行端的「已连接判定」（MW-B04）。
 *
 * 按用例返回不同的心跳响应：
 *   forbidden   → 403 业务错误（不得判为已连接）
 *   successFalse→ 200 但 success=false（不得判为已连接）
 *   wrongId     → 200 但返回的 workerId 不同（不得判为已连接）
 *   html        → 200 但响应是 HTML（不得判为已连接）
 *   ok          → 200 且 success=true、workerId 一致（必须判为已连接）
 *   refused     → 该用例不启动本服务，用连接被拒验证错误分类
 *
 * 用法: node tests/helpers/fake_coordinator.js <mode> <port> [workerId]
 * 启动后打印 "READY"；收到每次心跳时把请求记录追加到 stdout（便于取证）。
 */

const http = require('http');

const mode = process.argv[2] || 'ok';
const port = Number(process.argv[3] || 3099);
const expectedWorkerId = process.argv[4] || 'mw-probe-worker';

const server = http.createServer((req, res) => {
  if (!req.url.startsWith('/api/workers/heartbeat')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const headers = {
      'x-worker-id': req.headers['x-worker-id'] || null,
      'x-worker-token-present': !!req.headers['x-worker-token']
    };
    process.stdout.write(`HEARTBEAT ${JSON.stringify({ headers, body: body.slice(0, 300) })}\n`);

    if (mode === 'forbidden') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '权限拒绝（模拟）' }));
      return;
    }
    if (mode === 'html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body>not json</body></html>');
      return;
    }
    if (mode === 'successFalse') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, workerId: expectedWorkerId }));
      return;
    }
    if (mode === 'wrongId') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, workerId: 'someone-else' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, workerId: expectedWorkerId, registered: true, sourceIp: '127.0.0.1', timestamp: new Date().toISOString() }));
  });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`READY mode=${mode} port=${port}\n`);
});

// 被父进程杀死时正常退出
process.on('SIGTERM', () => { try { server.close(); } catch (e) {} process.exit(0); });
