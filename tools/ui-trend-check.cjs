// 使用模拟历史验证日期热力图，不读写真实备份数据。
const fs = require('node:fs');
const path = require('node:path');
const smokeTemp = require('./smoke-temp.cjs');
const http = require('node:http');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const pause = ms => new Promise(r => setTimeout(r, ms));
const root = path.resolve(__dirname, '..');
const pkgVersion = require(path.join(root, 'package.json')).version;
const output = path.join(root, 'artifacts', 'light-ui');
fs.mkdirSync(output, { recursive: true });

const STATIC = ['index.html', 'app.js', 'styles.css', 'tauri-bridge.js', 'changelog.js', 'icon.png'];
const server = http.createServer((req, res) => {
  const name = req.url === '/' ? 'index.html' : req.url.slice(1);
  if (!STATIC.includes(name)) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', png: 'image/png' }[name.split('.').pop()]);
  res.end(fs.readFileSync(path.join(root, 'app', 'renderer', name)));
});

const fixture = (version) => {
  let listener;
  const now = Date.now();
  const history = [];
  for (let i = 0; i < 365; i++) {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - 364 + i);
    if (date.getDay() === 0 || i % 9 === 0 || (i < 120 && i % 13 !== 0)) continue;
    history.push({
      success: i % 47 !== 0,
      filesCopied: (i * 7) % 40, filesSkipped: 300,
      totalBytes: i % 11 === 0 ? 0 : ((i * 17) % 80 + 1) * 1048576,
      savedBytes: 1024, errors: i % 47 === 0 ? 1 : 0, itemsDeleted: 0,
      finishedAt: date.getTime(), durationMs: 2300 + i * 10,
    });
  }
  const config = { theme: 'graphite', tasks: [], intervalMinutes: 30, scheduleMode: 'interval', dailyTimes: ['09:00'], weeklyDays: [1], weeklyTime: '09:00', useHashComparison: true };
  window.backupAPI = {
    getState: async () => ({ config, status: { schedulerRunning: true, running: false, nextRunAt: now + 60000, lastResult: history[history.length - 1] }, logs: [], history }),
    onPush: fn => listener = fn,
    saveConfig: async p => { Object.assign(config, p); listener?.({ type: 'config', data: config }); },
    onMaximizeChange: () => {}, isMaximized: async () => false,
    runNow: async () => ({ ok: true }), pauseBackup: async () => ({ ok: true }), resumeBackup: async () => ({ ok: true }),
    stopBackup: async () => ({ ok: true }), resumeLastBackup: async () => ({ ok: true }), uploadQuark: async () => ({ ok: true }),
    pickFolder: async () => null, startScheduler: async () => {}, stopScheduler: async () => {},
    openPath: async () => {}, openUrl: async () => {}, clearHistory: async () => {},
    quarkLogin: async () => ({ ok: true }), quarkFinishLogin: async () => ({ ok: true }),
    getAppInfo: async () => ({ version, identifier: 'com.local.backup-assistant', license: 'MIT', repository: 'https://github.com/XiaoMing-Brother/backup', dataDir: 'C:\\t', debug: false }),
    minimizeWindow: () => {}, toggleMaximize: () => {}, hideWindow: () => {}, closeWindow: () => {},
  };
};

(async () => {
  const temporary = await smokeTemp.create('backy-ui-');
  const profile = temporary.dir;
  let child, ws;
  try {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const edge = process.env.BACKY_TEST_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    child = spawn(edge, ['--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    let launchError; child.on('error', e => launchError = e);
    temporary.track(child, edge);
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) { if (launchError) throw launchError; await pause(100); }
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    ws = new WebSocket(pages.find(x => x.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0; const pending = new Map(); const errors = [];
    ws.onmessage = ({ data }) => { const m = JSON.parse(data); if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails); const p = pending.get(m.id); if (p) { pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } };
    const send = (method, params = {}) => new Promise((resolve, reject) => { const seq = ++id; const timer = setTimeout(() => { pending.delete(seq); reject(new Error(`Timeout: ${method}`)); }, 12000); pending.set(seq, { resolve, reject, timer }); ws.send(JSON.stringify({ id: seq, method, params })); });
    const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
    const shot = async name => { await pause(350); const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(output, `${name}.png`), Buffer.from(r.data, 'base64')); };

    await send('Runtime.enable'); await send('Page.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `(${fixture.toString()})(${JSON.stringify(pkgVersion)})` });
    await send('Emulation.setDeviceMetricsOverride', { width: 1120, height: 740, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
    for (let i = 0; i < 80; i++) { if (await evaluate('document.body?.dataset.ready === "1"')) break; await pause(100); }
    assert.equal(await evaluate('document.body.dataset.ready'), '1', 'app booted');

    await evaluate("switchView('stats')");
    await pause(400);
    assert.equal(await evaluate("document.querySelectorAll('.heatmap-day').length"), 365);
    assert.ok(await evaluate("document.querySelectorAll('.heatmap-day.has-record').length > 100"));
    assert.equal(await evaluate("document.querySelectorAll('.trend-line-svg, .trend-bar').length"), 0);
    await shot('heatmap-1120');

    // 实际鼠标悬浮，并检查提示框没有越出可用宽度。
    const target = await evaluate(`(()=>{const cell=document.querySelector('.heatmap-day.has-record');const r=cell.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,date:cell.dataset.date};})()`);
    await send('Input.dispatchMouseEvent', {type:'mouseMoved', x:target.x, y:target.y});
    await pause(150);
    assert.equal(await evaluate("document.querySelector('#heatmap-tooltip').hidden"), false);
    assert.match(await evaluate("document.querySelector('#heatmap-tooltip').textContent"), new RegExp(target.date));
    assert.ok(await evaluate("(()=>{const t=document.querySelector('#heatmap-tooltip').getBoundingClientRect();const b=document.querySelector('#stats-trend').getBoundingClientRect();return t.left>=b.left-1 && t.right<=b.right+1;})()"));
    await shot('heatmap-tooltip');

    // 新历史到达后，同一天聚合；零传输与无记录保持可区分。
    await evaluate(`(()=>{
      const today=new Date();today.setHours(12,0,0,0);
      const yesterday=new Date(today);yesterday.setDate(yesterday.getDate()-1);
      const record=(finishedAt,totalBytes,success,filesCopied)=>({finishedAt,totalBytes,success,filesCopied,durationMs:100});
      handlePush({type:'history',data:[record(today.getTime(),100,true,2),record(today.getTime(),200,false,3),record(yesterday.getTime(),0,true,0)]});
    })()`);
    assert.equal(await evaluate("document.querySelectorAll('.heatmap-day.has-record').length"), 2);
    assert.equal(await evaluate("document.querySelectorAll('.heatmap-day.has-failure').length"), 1);
    assert.equal(await evaluate("document.querySelectorAll('.heatmap-day.has-record[data-level=\"0\"]').length"), 1);
    assert.equal(await evaluate("document.querySelector('#sum-count').textContent"), '3');
    assert.match(await evaluate("document.querySelector('.heatmap-summary').textContent"), /3 次备份.*5 个更新文件.*300.00 B/);
    await evaluate("document.querySelector('.heatmap-day:last-child').focus()");
    assert.match(await evaluate("document.querySelector('#heatmap-tooltip').textContent"), /300.00 B/);
    assert.match(await evaluate("document.querySelector('#heatmap-tooltip').textContent"), /1 \/ 1/);
    await send('Input.dispatchKeyEvent', {type:'keyDown', key:'ArrowUp', code:'ArrowUp'});
    await send('Input.dispatchKeyEvent', {type:'keyUp', key:'ArrowUp', code:'ArrowUp'});
    assert.equal(await evaluate("document.activeElement.dataset.index"), '363');
    assert.match(await evaluate("document.querySelector('#heatmap-tooltip').textContent"), /0 B/);
    assert.equal(await evaluate("document.querySelectorAll('.heatmap-day[tabindex=\"0\"]').length"), 1);
    await send('Input.dispatchKeyEvent', {type:'keyDown', key:'Escape', code:'Escape'});
    assert.equal(await evaluate("document.querySelector('#heatmap-tooltip').hidden"), true);

    // CSS 网格在窗口变化后直接适配，无图表重绘计时器。
    for (const width of [1120, 920]) {
      await send('Emulation.setDeviceMetricsOverride', {width,height:740,deviceScaleFactor:1,mobile:false});
      await send('Input.dispatchMouseEvent', {type:'mouseMoved',x:10,y:10});
      await evaluate("document.activeElement.blur()");
      await evaluate(`(${fixture.toString()})(${JSON.stringify(pkgVersion)});window.backupAPI.getState().then(state=>handlePush({type:'history',data:state.history}))`);
      await pause(400);
      const layout = await evaluate(`(()=>{
        const cells=[...document.querySelectorAll('.heatmap-day')].map(c=>c.getBoundingClientRect());
        let overlap=false;
        for(let i=0;i<cells.length;i++)for(let j=i+1;j<cells.length;j++){
          const a=cells[i],b=cells[j];
          if(Math.min(a.right,b.right)-Math.max(a.left,b.left)>0.5 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>0.5)overlap=true;
        }
        const scroll=document.querySelector('.heatmap-scroll');
        return {overlap,square:cells.every(c=>Math.abs(c.width-c.height)<1),visible:cells.every(c=>c.width>=8&&c.height>=8),count:cells.length,overflow:document.querySelector('#main').scrollWidth>document.querySelector('#main').clientWidth,fullCalendar:scroll.scrollWidth<=scroll.clientWidth,atEnd:Math.abs(scroll.scrollLeft+scroll.clientWidth-scroll.scrollWidth)<=1};
      })()`);
      assert.equal(layout.count,365);
      assert.equal(layout.overlap,false);
      assert.equal(layout.square,true);
      assert.equal(layout.visible,true);
      assert.equal(layout.overflow,false);
      assert.equal(layout.fullCalendar,true);
      assert.equal(layout.atEnd,true);
      await shot(`heatmap-${width}`);
    }
    for (const theme of ['graphite','ocean','forest','plum','calm']) {
      await evaluate(`applyTheme('${theme}')`);
      assert.equal(await evaluate("getComputedStyle(document.querySelector('.heatmap-day[data-level=\"4\"]')).backgroundColor"), 'rgb(8, 124, 153)');
    }
    await evaluate("applyTheme('graphite');switchView('dashboard');switchView('stats')");
    assert.equal(await evaluate("document.querySelectorAll('.heatmap-calendar').length"), 1);
    assert.equal(await evaluate("document.querySelectorAll('#heatmap-tooltip').length"), 1);
    await evaluate("handlePush({type:'history',data:[]})");
    assert.equal(await evaluate("document.querySelectorAll('.heatmap-day').length"), 365);
    assert.equal(await evaluate("document.querySelectorAll('.heatmap-day.has-record').length"), 0);
    assert.match(await evaluate("document.querySelector('.heatmap-empty').textContent"), /暂无备份记录/);
    await shot('heatmap-empty');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ok:true,checks:['365 个日期','同日聚合及推送刷新','零传输与失败记录','鼠标悬浮及键盘操作','1120/920 方格布局无重叠或页面溢出','五套主题','空历史及视图切换','无运行时异常'],screenshots:output},null,2));
    try { ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' })); } catch {}
  } finally {
    await pause(200); ws?.close();
    server.close();
    await temporary.cleanup?.();
  }
})().catch(e => { console.error('FAILED:', e.message); server.close(); process.exitCode = 1; });
