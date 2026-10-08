/**
 * 用无头 Chrome 验证管理控制台本机可用：进入执行终端列表，确认渲染出终端卡片而不是错误文字。
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
  const base = process.argv[2] || 'http://localhost:3000';
  if (!CHROME) { console.log('未找到 Chrome/Edge'); process.exit(1); }
  const profile = path.resolve(__dirname, '../data/_admin_check_profile');
  fs.rmSync(profile, { recursive: true, force: true });
  const port = 9355;
  const proc = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });

  const badResponses = [];
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
    cdp.ws.on('message', raw => {
      let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
      if (m.method === 'Network.responseReceived' && m.params && /\/api\//.test(m.params.response.url) && m.params.response.status >= 400) {
        badResponses.push(m.params.response.status + ' ' + m.params.response.url.replace(base, ''));
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        consoleErrors.push((m.params.args || []).map(a => a.value || a.description || '').join(' ').slice(0, 200));
      }
    });

    console.log('--- 打开管理控制台 #workers ---');
    await cdp.send('Page.navigate', { url: `${base}/admin#workers` });
    await sleep(4000);

    const r = await cdp.send('Runtime.evaluate', {
      expression: `(function(){
        var c = document.getElementById('workers-grid-container');
        var html = c ? c.innerHTML : '';
        return JSON.stringify({
          title: document.title,
          cards: document.querySelectorAll('.worker-stat-card').length,
          hasError: /加载执行终端失败/.test(html),
          errorText: (html.match(/加载执行终端失败[^<]*/) || [''])[0],
          hasConfigButton: !!document.querySelector('.btn-worker-config'),
          bannerText: (function(){ var b = document.querySelector('body > div'); return b ? b.innerText.slice(0,80).replace(/\\s+/g,' ') : ''; })()
        });
      })()`,
      returnByValue: true
    });
    const info = JSON.parse(r.result.value);
    console.log('  页面标题:', info.title);
    console.log('  终端卡片数:', info.cards);
    console.log('  出现“加载执行终端失败”:', info.hasError ? ('❌ 是 -> ' + info.errorText) : '✅ 否');
    console.log('  “终端详情与保存配置”按钮:', info.hasConfigButton ? '✅ 存在' : '❌ 缺失');
    console.log('  顶部提示条:', info.bannerText || '(无)');

    console.log('--- 再测：进入终端详情 ---');
    await cdp.send('Page.navigate', { url: `${base}/admin#worker-detail?workerId=worker-local` });
    await sleep(3500);
    const r2 = await cdp.send('Runtime.evaluate', {
      expression: `(function(){
        return JSON.stringify({
          title: (document.getElementById('detail-worker-title')||{}).innerText || '',
          paths: (document.getElementById('allowed-paths-tbody')||{}).innerHTML ? document.getElementById('allowed-paths-tbody').innerHTML.length : 0,
          hasEmpty: /加载授权业务路径失败|加载本终端模板配置失败/.test(document.body.innerHTML),
          tmplRows: (document.getElementById('worker-templates-tbody')||{querySelectorAll:function(){return[]}}).querySelectorAll ? document.getElementById('worker-templates-tbody').querySelectorAll('tr').length : 0
        });
      })()`,
      returnByValue: true
    });
    const info2 = JSON.parse(r2.result.value);
    console.log('  详情标题:', info2.title || '(空)');
    console.log('  授权路径表格内容长度:', info2.paths);
    console.log('  模板配置行数:', info2.tmplRows);
    console.log('  出现加载失败提示:', info2.hasEmpty ? '❌ 是' : '✅ 否');

    console.log('--- 汇总 ---');
    console.log('  4xx/5xx 接口响应:', badResponses.length ? badResponses.slice(0, 5).join(' | ') : '✅ 无');
    console.log('  控制台错误:', consoleErrors.length ? consoleErrors.slice(0, 3).join(' | ') : '✅ 无');
    console.log('');
    console.log(`  管理控制台终端列表: ${(!info.hasError && info.cards > 0) ? '✅ 正常' : '❌ 异常'}`);
    console.log(`  终端详情页:         ${(!info2.hasEmpty && info2.paths > 0) ? '✅ 正常' : '❌ 异常'}`);
  } catch (e) {
    console.log('FAILED:', e.message);
  } finally {
    try { proc.kill(); } catch (e) {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }
})();
