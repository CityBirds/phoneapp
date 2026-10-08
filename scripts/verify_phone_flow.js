/**
 * 用无头 Chrome 模拟手机走完整流程：打开登录页 → 输入口令 → 进入系统 → 确认数据真的加载出来。
 * 只在本地验证浏览器侧逻辑（口令存储、跳转、API 调用是否带口令）。
 */
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => { try { return fs.existsSync(p); } catch (e) { return false; } });

function getJson(url) {
  return new Promise((res, rej) => {
    http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
  });
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.sessionId = null; }
  static async connect(url) {
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
    const c = new Cdp(ws);
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
      if (m.id && c.pending.has(m.id)) { const { resolve, reject } = c.pending.get(m.id); c.pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
    });
    return c;
  }
  send(method, params = {}, sid = this.sessionId) {
    const id = ++this.id; const p = { id, method, params }; if (sid) p.sessionId = sid;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify(p));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 60000);
    });
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const base = process.argv[2];
  const token = process.argv[3];
  if (!base || !token) { console.log('usage: node verify_phone_flow.js <baseUrl> <token>'); process.exit(1); }
  if (!CHROME) { console.log('未找到 Chrome/Edge'); process.exit(1); }

  const profile = path.resolve(__dirname, '../data/_phone_flow_profile');
  fs.rmSync(profile, { recursive: true, force: true });
  const port = 9344;
  const proc = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--window-size=390,844', 'about:blank'], { stdio: 'ignore' });

  const apiCalls = [];
  const consoleErrors = [];
  try {
    let ver; for (let i = 0; i < 60; i++) { try { ver = await getJson(`http://127.0.0.1:${port}/json/version`); break; } catch (e) { await sleep(300); } }
    const cdp = await Cdp.connect(ver.webSocketDebuggerUrl);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    cdp.sessionId = sessionId;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    cdp.ws.on('message', raw => {
      let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
      if (m.method === 'Network.requestWillBeSent' && m.params && /\/api\//.test(m.params.request.url)) {
        apiCalls.push(m.params.request.url.replace(base, ''));
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        consoleErrors.push((m.params.args || []).map(a => a.value || a.description || '').join(' ').slice(0, 160));
      }
    });

    console.log('--- 步骤1：打开登录页 ---');
    await cdp.send('Page.navigate', { url: `${base}/frontend/login.html` });
    await sleep(2500);
    const t1 = await cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
    const hasForm = await cdp.send('Runtime.evaluate', { expression: '!!document.getElementById("token-input") && !!document.getElementById("login-form")', returnByValue: true });
    console.log('  标题:', t1.result.value);
    console.log('  表单存在:', hasForm.result.value);

    console.log('--- 步骤2：输入口令并提交 ---');
    await cdp.send('Runtime.evaluate', { expression: `document.getElementById('token-input').value = ${JSON.stringify(token)};` });
    await cdp.send('Runtime.evaluate', { expression: `document.getElementById('login-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));` });
    await sleep(4500);

    const urlNow = await cdp.send('Runtime.evaluate', { expression: 'location.pathname + location.search', returnByValue: true });
    const stored = await cdp.send('Runtime.evaluate', { expression: `localStorage.getItem('phoneapp_access_token') ? 'YES' : 'NO'`, returnByValue: true });
    console.log('  当前地址:', urlNow.result.value);
    console.log('  口令已保存:', stored.result.value);

    console.log('--- 步骤3：确认应用真的加载了数据 ---');
    await sleep(3500);
    const workerText = await cdp.send('Runtime.evaluate', {
      expression: `(function(){ var el = document.getElementById('current-worker-name'); return el ? el.textContent.trim() : '(元素不存在)'; })()`,
      returnByValue: true
    });
    console.log('  终端指示:', workerText.result.value);
    const modelOptions = await cdp.send('Runtime.evaluate', {
      expression: `(function(){ var s = document.getElementById('model-select'); return s ? s.options.length : -1; })()`,
      returnByValue: true
    });
    console.log('  模板下拉项数:', modelOptions.result.value);

    console.log('--- 汇总 ---');
    console.log('  API 请求:', apiCalls.length ? apiCalls.slice(0, 8).join('\n            ') : '(无)');
    const bad = apiCalls.filter(u => !/[?&]k=/.test(u));
    console.log('  未带口令的 API 请求:', bad.length, bad.slice(0, 3).join(', '));
    console.log('  控制台错误:', consoleErrors.length ? consoleErrors.slice(0, 3).join(' | ') : '(无)');
    const landedOnApp = String(urlNow.result.value).includes('/frontend/index.html');
    const tokenOk = stored.result.value === 'YES';
    console.log('');
    console.log(`  登录跳转成功: ${landedOnApp ? '✅' : '❌'}`);
    console.log(`  口令已持久化: ${tokenOk ? '✅' : '❌'}`);
    console.log(`  数据加载成功: ${Number(modelOptions.result.value) > 0 ? '✅' : '❌'} (下拉 ${modelOptions.result.value} 项)`);
  } catch (e) {
    console.log('FAILED:', e.message);
  } finally {
    try { proc.kill(); } catch (e) {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }
})();
