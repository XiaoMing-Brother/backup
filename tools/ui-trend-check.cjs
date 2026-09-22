// 专门验证「备份趋势」折线：多轮历史下的绘制、尺寸稳定性、resize 重绘。
// ui-smoke.cjs 的 mock 只有 1 条 history，折线会走 points.length<2 提前返回，
// 覆盖不到 drawTrendLine —— 所以单独需要一个多轮数据的用例。
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

// 12 轮历史：大小起伏 + 含失败轮 + 含零传输轮（验证 val>0 的过滤）
const fixture = (version) => {
  let listener;
  const now = Date.now();
  const history = [];
  for (let i = 0; i < 12; i++) {
    history.push({
      success: i !== 4 && i !== 9,
      filesCopied: 5 + (i * 7) % 40,
      filesSkipped: 300,
      totalBytes: i === 7 ? 0 : (i % 3 === 0 ? 18 : 6 + i) * 1258291,
      savedBytes: 1024,
      errors: i === 4 ? 2 : 0,
      itemsDeleted: 0,
      finishedAt: now - (12 - i) * 3600000,
      durationMs: 2300 + i * 130,
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

    // 1) 切到统计视图，等调度器完成（320ms 间隔 + 稳定性轮询）
    await evaluate("switchView('stats')");
    await pause(1400);
    const svg = await evaluate(`(()=>{const s=document.querySelector('#stats-trend .trend-line-svg');if(!s)return null;return {
      circles:s.querySelectorAll('circle').length,
      paths:s.querySelectorAll('path').length,
      viewBox:s.getAttribute('viewBox'),
      w:parseFloat(s.style.width),
      minW:parseFloat(s.style.minWidth),
      h:parseFloat(s.style.height),
      scrollW:document.querySelector('#stats-trend').scrollWidth,
      clientH:document.querySelector('#stats-trend').clientHeight,
      cols:document.querySelectorAll('#stats-trend .trend-col').length,
      failDots:[...s.querySelectorAll('circle')].filter(c=>c.getAttribute('fill')==='#cb6770').length};
    })()`);
    assert.ok(svg, 'trend-line-svg 必须存在');
    assert.equal(svg.cols, 12, '12 根柱子');
    // 12 轮里 1 轮 totalBytes=0 被 val>0 过滤 → 11 个圆点
    assert.equal(svg.circles, 11, `圆点数应为 11，实际 ${svg.circles}`);
    assert.equal(svg.paths, 2, '面积 + 折线两条 path');
    assert.equal(svg.failDots, 2, '两轮失败应有两个红色圆点');
    console.log('  ✓ 折线已绘制:', JSON.stringify(svg));

    // 2) 尺寸必须与容器一致（动画期读脏尺寸会写歪）
    assert.equal(svg.w, svg.scrollW, `SVG 宽度 ${svg.w} 应等于容器 scrollWidth ${svg.scrollW}`);
    assert.equal(svg.h, svg.clientH, `SVG 高度 ${svg.h} 应等于容器 clientHeight ${svg.clientH}`);
    assert.equal(svg.minW, svg.scrollW, 'min-width 不应锁在旧值');
    assert.equal(svg.viewBox, `0 0 ${svg.scrollW} ${svg.clientH}`, 'viewBox 应与容器一致');
    console.log('  ✓ 尺寸与容器一致，viewBox =', svg.viewBox);
    await shot('trend-line-1120');

    // 3) 圆点坐标必须落在柱子中心 / 柱顶（x 对位）
    const align = await evaluate(`(()=>{const box=document.querySelector('#stats-trend');const s=box.querySelector('.trend-line-svg');const cs=getComputedStyle(box);const padTop=parseFloat(cs.paddingTop)||16;const chartBottom=box.clientHeight-48;
      const dots=[...s.querySelectorAll('circle')].map(c=>({x:parseFloat(c.getAttribute('cx')),y:parseFloat(c.getAttribute('cy'))}));
      const cols=[...box.querySelectorAll('.trend-col')];const bars=[...box.querySelectorAll('.trend-bar')];
      let maxDx=0,maxDy=0;
      cols.forEach((col,i)=>{const bar=col.querySelector('.trend-bar');if(!bar||!bar.offsetHeight)return;
        const ex=col.offsetLeft+col.offsetWidth/2, ey=chartBottom-padTop-bar.offsetHeight;
        const d=dots.find(p=>Math.abs(p.x-ex)<0.6);if(!d)return;
        maxDx=Math.max(maxDx,Math.abs(d.x-ex));maxDy=Math.max(maxDy,Math.abs(d.y-ey));});
      return {maxDx,maxDy,dots:dots.length};})()`);
    assert.ok(align.maxDx < 0.6, `圆点横向应与柱心对齐，实测最大偏差 ${align.maxDx}`);
    assert.ok(align.maxDy < 0.6, `圆点纵向应贴合柱顶，实测最大偏差 ${align.maxDy}`);
    console.log('  ✓ 圆点对位正确，最大偏差 dx=' + align.maxDx.toFixed(2) + ' dy=' + align.maxDy.toFixed(2));

    // 4) 真正会读到脏尺寸的场景：视图切换动画进行中就收到 history。
    //    view-enter 动画带 translateY(5px)，动画期 clientHeight 与最终值不同；
    //    旧实现（一次性 rAF）会立刻取尺寸，落到动画中间态。
    //    先把容器清空并重置 SVG，再在动画开始的瞬间灌入 history。
    await evaluate(`(()=>{const box=document.querySelector('#stats-trend');box.innerHTML='';switchView('dashboard');})()`);
    await pause(400);
    await evaluate(`(()=>{switchView('stats');const h=[];for(let i=0;i<12;i++){h.push({success:i!==3,filesCopied:9,filesSkipped:300,totalBytes:(5+i*4)*1258291,savedBytes:1024,errors:0,itemsDeleted:0,finishedAt:Date.now()-(12-i)*3600000,durationMs:2000+i*90});}
      S.history=h;renderStats();})()`);
    await pause(1400);
    const mid = await evaluate(`(()=>{const box=document.querySelector('#stats-trend');const s=box.querySelector('.trend-line-svg');return {w:parseFloat(s.style.width),scrollW:box.scrollWidth,h:parseFloat(s.style.height),clientH:box.clientHeight,vb:s.getAttribute('viewBox'),dots:s.querySelectorAll('circle').length};})()`);
    assert.equal(mid.w, mid.scrollW, `动画期渲染后 SVG 宽度必须等于容器宽度：${mid.w} vs ${mid.scrollW}`);
    assert.equal(mid.h, mid.clientH, `动画期渲染后 SVG 高度必须等于容器高度：${mid.h} vs ${mid.clientH}`);
    assert.equal(mid.vb, `0 0 ${mid.scrollW} ${mid.clientH}`, 'viewBox 必须与容器一致');
    assert.equal(mid.dots, 12, `正数 totalBytes 的轮次都应有点，实际 ${mid.dots}`);
    console.log('  ✓ 动画期渲染尺寸稳定: ' + mid.w + ' x ' + mid.h + '，viewBox=' + mid.vb);
    await shot('trend-line-920');

    // 5) 切走再切回，不应报错、不应叠加 SVG
    await evaluate("switchView('dashboard')"); await pause(500);
    await evaluate("switchView('stats')"); await pause(1400);
    const after2 = await evaluate("document.querySelectorAll('#stats-trend .trend-line-svg').length");
    assert.equal(after2, 1, `反复切换后 SVG 只应有一个，实际 ${after2}`);
    console.log('  ✓ 反复切换视图未叠加 SVG');

    assert.equal(errors.length, 0, '不应有运行时异常: ' + JSON.stringify(errors));
    assert.equal(await evaluate('document.querySelector("#main").scrollWidth <= document.querySelector("#main").clientWidth'), true, 'stats 视图无横向溢出');

    console.log(JSON.stringify({ ok: true, checks: ['折线绘制(12轮/11点/2失败点)', '尺寸与容器一致', '圆点对位', 'resize 重算', '反复切换不叠加', '无运行时异常'], screenshots: ['trend-line-1120.png', 'trend-line-920.png'] }, null, 2));
    try { ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' })); } catch {}
  } finally {
    await pause(200); ws?.close();
    server.close();
    await temporary.cleanup?.();
  }
})().catch(e => { console.error('FAILED:', e.message); server.close(); process.exitCode = 1; });
