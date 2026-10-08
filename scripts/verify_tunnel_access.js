// 验证：通过公网隧道访问时，手机端需口令、管理接口必须被拒绝
const fs = require('fs');
const path = require('path');

const base = process.argv[2];
if (!base) { console.log('usage: node verify_tunnel_access.js <baseUrl>'); process.exit(1); }

const tokenFile = path.resolve(__dirname, '..', 'data', 'access_token.txt');
const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf-8').trim() : '';
console.log('隧道地址:', base);
console.log('口令长度:', token.length, token ? '(已从 data/access_token.txt 读取)' : '(未找到口令文件!)');
console.log('');

async function probe(name, url, options = {}) {
  try {
    const res = await fetch(url, { redirect: 'manual', ...options });
    let body = '';
    try { body = (await res.text()).slice(0, 120).replace(/\s+/g, ' '); } catch (e) {}
    console.log(`${res.status}  ${name}`);
    if (body) console.log(`        ${body}`);
    return res.status;
  } catch (e) {
    console.log(`ERR  ${name} -> ${e.message}`);
    return 0;
  }
}

(async () => {
  const results = {};

  console.log('=== 1. 未带口令的手机端接口（应 401） ===');
  results.noTokenWorkers = await probe('GET /api/workers?all=true', `${base}/api/workers?all=true`);
  results.noTokenBundles = await probe('GET /api/published-bundles', `${base}/api/published-bundles`);
  results.noTokenTasks = await probe('GET /api/tasks?range=today', `${base}/api/tasks?range=today`);

  console.log('\n=== 2. 带口令的手机端接口（应 200） ===');
  const h = { 'x-phone-token': token };
  results.tokenWorkers = await probe('GET /api/workers?all=true (+token)', `${base}/api/workers?all=true`, { headers: h });
  results.tokenBundles = await probe('GET /api/published-bundles (+token)', `${base}/api/published-bundles`, { headers: h });

  console.log('\n=== 3. 通过隧道的管理接口写操作（必须 403，即使带口令） ===');
  results.adminUpload = await probe('POST /api/admin/sales-persons', `${base}/api/admin/sales-persons`, {
    method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '隧穿透测试' })
  });
  results.adminUpload2 = await probe('POST /api/templates/upload', `${base}/api/templates/upload`, {
    method: 'POST', headers: { ...h, 'x-admin-token': 'phoneapp-admin-secret' }
  });
  results.adminDelete = await probe('DELETE /api/templates/tmpl_nonexistent', `${base}/api/templates/tmpl_nonexistent`, {
    method: 'DELETE', headers: { ...h, 'x-admin-token': 'phoneapp-admin-secret' }
  });
  results.adminWorkerCfg = await probe('POST /api/admin/workers/x/template-configs', `${base}/api/admin/workers/x/template-configs`, {
    method: 'POST', headers: { ...h, 'Content-Type': 'application/json', 'x-admin-token': 'phoneapp-admin-secret' }, body: JSON.stringify({ templateId: 'x', docType: 'cert' })
  });

  console.log('\n=== 4. 页面与静态资源 ===');
  results.pageNoToken = await probe('GET /frontend/index.html (无口令，应 200 页面)', `${base}/frontend/index.html`);
  results.pageWithToken = await probe('GET /frontend/index.html?k=*** (带口令，应 200)', `${base}/frontend/index.html?k=${encodeURIComponent(token)}`);

  console.log('\n=== 5. 执行端接口 ===');
  results.workerPublic = await probe('GET /api/worker/authorizations (对外端口，应 403)', `${base}/api/worker/authorizations?workerId=worker-local`);
  results.workerHeartbeat = await probe('POST /api/workers/heartbeat (对外端口，应 403)', `${base}/api/workers/heartbeat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workerId: 'evil-worker', name: 'attacker' })
  });
  results.workerPending = await probe('GET /api/worker/tasks/pending (对外端口，应 403)', `${base}/api/worker/tasks/pending?workerId=evil-worker`);
  try {
    const r = await fetch('http://127.0.0.1:3001/api/worker/authorizations?workerId=worker-local');
    console.log(`${r.status}  GET /api/worker/authorizations (内部端口 3001，应 200)`);
    results.workerInternal = r.status;
  } catch (e) { console.log('ERR  内部端口探测 -> ' + e.message); results.workerInternal = 0; }

  console.log('\n=== 结论 ===');
  const ok1 = [results.noTokenWorkers, results.noTokenBundles, results.noTokenTasks].every(s => s === 401);
  const ok2 = [results.tokenWorkers, results.tokenBundles].every(s => s === 200);
  const ok3 = [results.adminUpload, results.adminUpload2, results.adminDelete, results.adminWorkerCfg].every(s => s === 403);
  const ok4 = [results.workerPublic, results.workerHeartbeat, results.workerPending].every(s => s === 403);
  const ok5 = results.workerInternal === 200;
  console.log(` 手机端未带口令被拦      : ${ok1 ? '✅ 通过' : '❌ 未通过'}`);
  console.log(` 手机端带口令可用        : ${ok2 ? '✅ 通过' : '❌ 未通过'}`);
  console.log(` 隧道管理写操作被拒      : ${ok3 ? '✅ 通过' : '❌ 未通过'}`);
  console.log(` 执行端接口在对外端口被拒: ${ok4 ? '✅ 通过' : '❌ 未通过'}`);
  console.log(` 执行端接口内部端口可用  : ${ok5 ? '✅ 通过' : '❌ 未通过'}`);
})();
