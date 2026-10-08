/**
 * 执行端首次接入 / 连接测试工具（多执行端局域网接入整改 §3.1 / 183部署文档 §3.1）
 *
 * 用法：
 *   node tools/worker_connect.js                                    # 交互式输入协调电脑地址并保存
 *   node tools/worker_connect.js --server http://192.168.1.183:3001 # 直接指定并保存
 *   node tools/worker_connect.js --test                             # 只测试当前已保存地址是否可达
 *
 * 写入位置与执行端读取位置一致：本机文件 worker_config.local.json（连接地址 + 身份），
 * 一次配置后重启自动沿用，不需要每次输入；不写入随安装包分发的共享配置。
 *
 * 职责边界：本工具只写「连接地址」这类启动必需信息；
 * 模板启用、授权路径、保存目录等业务规则仍由协调服务集中维护。
 */

const path = require('path');
const readline = require('readline');
const fs = require('fs');
const {
  loadWorkerConfig,
  normalizeServerUrl,
  classifyConnectionError,
  firewallHint,
  LOCAL_CONFIG_PATH
} = require(path.resolve(__dirname, '../src/worker/worker_config'));

function parseArgs(argv) {
  const out = { server: '', test: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--server' && argv[i + 1]) { out.server = argv[i + 1]; i++; }
    else if (argv[i] === '--test') out.test = true;
    else if (argv[i] === '--yes' || argv[i] === '-y') out.yes = true;
  }
  return out;
}

function readLocalConfig() {
  try {
    if (fs.existsSync(LOCAL_CONFIG_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(LOCAL_CONFIG_PATH, 'utf-8'));
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch (e) {}
  return {};
}

/** 只更新本机文件：连接地址与身份同处一地，保证“工具写入处 = 执行端读取处” */
function saveLocalServerUrl(serverUrl) {
  const current = readLocalConfig();
  const next = {
    ...current,
    serverUrl,
    updatedAt: new Date().toISOString(),
    note: '本文件是本机执行端的连接地址与身份凭据，请勿复制到其他电脑或随安装包分发'
  };
  fs.writeFileSync(LOCAL_CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', 'utf-8');
  return next;
}

async function testConnection(serverUrl, workerId, workerSecret) {
  const target = `${serverUrl}/api/workers/heartbeat`;
  process.stdout.write(`正在测试连接：${serverUrl} ... `);
  let res;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      res = await fetch(target, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-worker-id': workerId,
          'x-worker-token': workerSecret
        },
        body: JSON.stringify({ workerId, name: `连接测试 (${workerId})`, status: 'ONLINE' }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const classified = classifyConnectionError(err);
    console.log('失败');
    console.log(`  ✗ ${classified.text}（类型: ${classified.kind}）`);
    return { ok: false, kind: classified.kind, text: classified.text };
  }

  const contentType = res.headers.get('content-type') || '';
  let data = null;
  if (contentType.includes('application/json')) {
    try { data = await res.json(); } catch (e) { data = null; }
  }
  if (!data) {
    console.log('失败');
    console.log(`  ✗ 响应不是有效 JSON（HTTP ${res.status}）；请确认该地址端口确实是协调服务的执行端接入口。`);
    return { ok: false, kind: 'bad-response', text: `HTTP ${res.status} 非 JSON` };
  }
  if (!res.ok || data.success !== true) {
    console.log('失败');
    console.log(`  ✗ ${data.error || `HTTP ${res.status}`}（类型: ${res.status === 401 || res.status === 403 ? 'auth' : 'server'}）`);
    return { ok: false, kind: 'auth-or-server', text: data.error || `HTTP ${res.status}` };
  }
  if (data.workerId && data.workerId !== workerId) {
    console.log('失败');
    console.log(`  ✗ 协调服务返回的 workerId (${data.workerId}) 与本机 (${workerId}) 不一致`);
    return { ok: false, kind: 'identity-mismatch', text: 'workerId 不一致' };
  }
  console.log('成功');
  console.log(`  ✓ 协调服务可达，本终端已登记为 ${data.workerId}${data.registered ? '（本次为首次登记）' : ''}`);
  console.log(`  ✓ 直连来源地址（协调端看到）: ${data.sourceIp || '未知'}`);
  return { ok: true, data };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadWorkerConfig();

  console.log('====================================================');
  console.log('执行端接入配置（本机为执行端，只需指定协调电脑地址）');
  console.log('====================================================');
  console.log(`- 本机终端 ID: ${cfg.workerId}（来源: ${cfg.sources.workerId}）`);
  console.log(`- 当前连接地址: ${cfg.serverUrl}（来源: ${cfg.sources.server}）`);
  console.log(`- 本机配置文件: ${LOCAL_CONFIG_PATH}（存放连接地址与接入凭据，请勿复制到其他电脑）`);
  console.log('- 本机监听端口: 无（执行端只主动连接协调服务，不需要开放入站端口）');
  console.log('----------------------------------------------------');

  if (args.test) {
    const result = await testConnection(cfg.serverUrl, cfg.workerId, cfg.workerSecret);
    process.exit(result.ok ? 0 : 1);
  }

  let target = args.server;
  if (!target) {
    if (!process.stdin.isTTY) {
      console.error('✗ 非交互环境下必须用 --server 指定协调电脑地址，例如：');
      console.error('    node tools/worker_connect.js --server http://<协调电脑IP>:3001');
      process.exit(1);
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const question = (q) => new Promise(resolve => rl.question(q, resolve));
    console.log('请输入【协调服务所在电脑】的局域网地址（即运行协调服务的那台机器）。');
    console.log('  格式示例: <协调电脑IP>            → 自动使用执行端端口 3001');
    console.log('            http://<协调电脑IP>:3001');
    console.log('  只有协调电脑本机的执行端才填 127.0.0.1');
    const answer = (await question('协调电脑地址: ')).trim();
    rl.close();
    target = answer || '127.0.0.1';
  }

  const envPort = Number(process.env.WORKER_PORT || process.env.INTERNAL_PORT || 0);
  const normalized = normalizeServerUrl(target, envPort || 3001);
  if (!normalized) {
    console.error(`✗ 无法解析地址: ${target}`);
    process.exit(1);
  }

  console.log(`\n将把连接地址保存为: ${normalized}`);
  const testResult = await testConnection(normalized, cfg.workerId, cfg.workerSecret);
  if (!testResult.ok && !args.yes) {
    console.log('\n连接测试未通过。');
    console.log('  如果只是协调服务暂时未启动，可以仍然保存该地址，稍后协调服务启动会自动重连。');
    if (!process.stdin.isTTY) {
      console.log('  非交互环境未确认，已取消保存（可加 --yes 强制保存）。');
      process.exit(1);
    }
    const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
    const confirm = await new Promise(resolve => rl2.question('仍然保存该地址吗？(y/N) ', resolve));
    rl2.close();
    if (!/^y(es)?$/i.test(String(confirm).trim())) {
      console.log('已取消，未修改配置。');
      process.exit(1);
    }
  }

  saveLocalServerUrl(normalized);

  console.log(`\n✓ 已保存到 ${LOCAL_CONFIG_PATH}`);
  console.log('  下一步：启动执行端  node src/worker/worker.js（以后启动会自动沿用该地址，无需再输入）');
  if (!testResult.ok) {
    console.log('  连接排查：');
    console.log('    ' + firewallHint(new URL(normalized).hostname, Number(new URL(normalized).port || 3001)));
  }
}

main().catch(err => {
  console.error('接入配置失败:', err.message);
  process.exit(1);
});
