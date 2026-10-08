/**
 * 真实验证执行端「已连接判定」（MW-B04 / §5）。
 *
 * 做法：启动一个假协调服务返回指定的心跳响应，再真正启动 src/worker/worker.js
 * 指向它，观察执行端进程自己的判定输出——不使用 mock 替身，不用源码字符串断言。
 *
 * 用法: node tests/helpers/probe_worker_connection.js <mode> <port> <workerId>
 * 输出: 执行端 stdout 摘要（含是否误报“[成功] 已连接”）。
 */

const { spawn } = require('child_process');
const path = require('path');

const mode = process.argv[2] || 'ok';
const port = Number(process.argv[3] || 3099);
const workerId = process.argv[4] || 'mw-probe-worker';
const root = path.resolve(__dirname, '../..');

function run(seconds, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'src/worker/worker.js'),
      '--id', workerId, '--server', `http://127.0.0.1:${port}`, '--dir', path.join(root, 'data', `mw_probe_${mode}`)
    ], {
      cwd: root,
      env: {
        ...process.env,
        // 隔离：执行端只做连接判定，不读生产库、不用生产身份，
        // 也不得写入程序根目录的身份文件（否则会污染其它用例）
        DB_PATH: path.join(root, 'data', `phoneapp_test_mwprobe_${mode}.db`),
        PHONEAPP_CONFIG_DIR: path.join(root, 'data', `mw_probe_config_${mode}_${port}`),
        WORKER_PORT: String(port),
        NODE_ENV: 'test',
        ...extraEnv
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });

    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (e) {}
      resolve(out);
    }, seconds * 1000);
  });
}

(async () => {
  const seconds = mode === 'refused' ? 5 : 4;
  const output = await run(seconds);
  const result = {
    mode,
    connected: /\[成功\] 已连接协调服务/.test(output),
    reportedKinds: {
      auth: /\[鉴权失败\]/.test(output),
      badResponse: /\[响应异常\]/.test(output),
      identityMismatch: /\[身份不一致\]/.test(output),
      refused: /\[连接失败\]/.test(output),
      timeout: /\[连接超时\]/.test(output)
    },
    waitingForStartupOnly: /正在等待协调服务启动/.test(output),
    sentWorkerHeaders: null,
    raw: output.slice(0, 1500)
  };
  process.stdout.write(JSON.stringify(result));
})();
