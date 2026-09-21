// 使用模拟接口检查渲染层，不读写真实备份数据。
const fs = require('node:fs');
const path = require('node:path');
const smokeTemp = require('./smoke-temp.cjs');
const http = require('node:http');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const pause = ms => new Promise(r => setTimeout(r, ms));
const root = path.resolve(__dirname, '..');
const pkgVersion = require(path.join(root,'package.json')).version;
const output = path.join(root, 'artifacts', 'light-ui');
fs.mkdirSync(output, {recursive:true});
const server = http.createServer((req, res) => {
  const name = req.url === '/' ? 'index.html' : req.url.slice(1);
  if (!['index.html','app.js','styles.css','tauri-bridge.js','changelog.js','icon.png'].includes(name)) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', {html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',png:'image/png'}[name.split('.').pop()]);
  res.end(fs.readFileSync(path.join(root,'app','renderer',name)));
});
const fixture = (version) => {
  let listener;
  const config = {theme:'graphite',tasks:[{source:'D:\\Projects\\网站项目',backup:'E:\\Backups\\网站项目'},{source:'D:\\Documents\\设计素材',backup:'E:\\Backups\\设计素材'}],intervalMinutes:30,scheduleMode:'interval',dailyTimes:['09:00','18:00'],weeklyDays:[1,5],weeklyTime:'09:00',useHashComparison:true};
  const result = {success:true,filesCopied:12,filesSkipped:328,totalBytes:24117248,savedBytes:403701760,errors:0,itemsDeleted:0,finishedAt:Date.now()-120000,durationMs:2300};
  window.backupAPI = {
    getState: async()=>({config,status:{schedulerRunning:true,running:false,nextRunAt:Date.now()+1234000,lastResult:result},logs:[],history:[result]}),
    onPush:fn=>listener=fn,saveConfig:async patch=>{Object.assign(config,patch);listener?.({type:'config',data:config});},
    onMaximizeChange:()=>{},isMaximized:async()=>false,runNow:async()=>({ok:true}),pauseBackup:async()=>{window.pauseClicks=(window.pauseClicks||0)+1;return {ok:true};},resumeBackup:async()=>{window.resumeClicks=(window.resumeClicks||0)+1;return {ok:true};},stopBackup:async()=>{window.stopClicks=(window.stopClicks||0)+1;return {ok:true};},resumeLastBackup:async()=>{window.recoveryClicks=(window.recoveryClicks||0)+1;return {ok:true};},uploadQuark:async()=>{window.quarkUploadClicks=(window.quarkUploadClicks||0)+1;return {ok:true};},pickFolder:async()=>null,
    startScheduler:async()=>{},stopScheduler:async()=>{},openPath:async p=>{(window.openedPaths=window.openedPaths||[]).push(p);},openUrl:async u=>{(window.externalUrls=window.externalUrls||[]).push(u);},clearHistory:async()=>{},quarkLogin:async()=>({ok:true}),quarkFinishLogin:async()=>({ok:true}),
    getAppInfo:async()=>({version,identifier:'com.local.backup-assistant',license:'MIT',repository:'https://github.com/XiaoMing-Brother/backup',dataDir:'C:\\Users\\Test\\AppData\\Roaming\\incremental-backup-assistant',debug:false}),
    minimizeWindow:()=>{},toggleMaximize:()=>{},hideWindow:()=>{},closeWindow:()=>{},
  };
};
(async()=>{
  const temporary = await smokeTemp.create('backy-ui-');
  const profile = temporary.dir;
  let child;
  let ws;
  try {
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const edge = process.env.BACKY_TEST_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  child = spawn(edge,['--headless=new','--disable-gpu','--disable-extensions','--disable-background-networking','--disable-background-timer-throttling','--disable-renderer-backgrounding','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
  let launchError;
  child.on('error',e=>launchError=e);
  temporary.track(child, edge);
    const portFile = path.join(profile,'DevToolsActivePort');
    for(let i=0;i<100&&!fs.existsSync(portFile);i++){if(launchError)throw launchError; await pause(100);}
    const port = fs.readFileSync(portFile,'utf8').split('\n')[0];
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    ws = new WebSocket(pages.find(x=>x.type==='page').webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
    let id=0;const pending=new Map();const errors=[];
    ws.onmessage=({data})=>{const m=JSON.parse(data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}};
    const send=(method,params={})=>new Promise((resolve,reject)=>{const seq=++id;const timer=setTimeout(()=>{pending.delete(seq);reject(new Error(`Timeout: ${method}`));},12000);pending.set(seq,{resolve,reject,timer});ws.send(JSON.stringify({id:seq,method,params}));});
    const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
    const shot=async name=>{await pause(350);const r=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,`${name}.png`),Buffer.from(r.data,'base64'));};
    await send('Runtime.enable');await send('Page.enable');
    await send('Page.addScriptToEvaluateOnNewDocument',{source:`(${fixture.toString()})(${JSON.stringify(pkgVersion)})`});
    await send('Emulation.setDeviceMetricsOverride',{width:1120,height:740,deviceScaleFactor:1,mobile:false});
    await send('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/`});
    for(let i=0;i<80;i++){if(await evaluate('document.body?.dataset.ready === "1"'))break;await pause(100);}
    assert.equal(await evaluate('document.body.dataset.ready'),'1',JSON.stringify(errors));
    assert.equal(await evaluate('getComputedStyle(document.body).animationName'),'ambient-flow');
    const backgroundPosition=await evaluate('getComputedStyle(document.body).backgroundPosition');await pause(170);
    assert.notEqual(await evaluate('getComputedStyle(document.body).backgroundPosition'),backgroundPosition,'ambient background moves');
    for(const theme of ['graphite','ocean','forest','plum','calm']) {
      await evaluate(`document.querySelector('.theme-card[data-theme="${theme}"]').click()`);
      assert.equal(await evaluate('S.config.theme'),theme,'theme selection is saved through the API');
      assert.equal(await evaluate(`document.querySelector('[data-theme="${theme}"].theme-card').getAttribute('aria-pressed')`),'true');
      await shot(theme);
    }
    await evaluate("applyTheme('graphite')");
    await evaluate("switchView('settings');document.querySelector('#exclude-patterns').value='node_modules\\n*.zip';document.querySelector('#exclude-patterns').dispatchEvent(new Event('input'));handlePush({type:'status',data:{running:false}})");
    assert.equal(await evaluate("document.querySelector('#exclude-patterns').value"), 'node_modules\n*.zip', 'status updates preserve the draft');
    await evaluate("window.backupAPI.saveConfig({theme:'graphite'});document.querySelector('[data-exclude=\"node_modules\"]').click();document.querySelector('[data-exclude=\".git\"]').click();document.querySelector('#btn-save-excludes').click()");
    assert.deepEqual(await evaluate('S.config.excludePatterns'), ['node_modules', '*.zip', '.git'], 'quick add deduplicates and saves rules');
    assert.match(await evaluate("document.querySelector('#exclude-message').textContent"), /已保存/);
    await evaluate("document.querySelector('#exclude-settings').scrollIntoView({block:'start'})");
    await shot('exclude-settings');
    await evaluate("window.savedConfigAPI=window.backupAPI.saveConfig;window.backupAPI.saveConfig=async()=>{throw new Error('排除规则无效')};document.querySelector('#exclude-patterns').value='[broken';document.querySelector('#btn-save-excludes').click()");
    assert.match(await evaluate("document.querySelector('#exclude-message').textContent"), /排除规则无效/);
    assert.equal(await evaluate("document.querySelector('#exclude-patterns').value"), '[broken', 'failed saves preserve the draft');
    assert.deepEqual(await evaluate('S.config.excludePatterns'), ['node_modules', '*.zip', '.git']);
    await evaluate("window.backupAPI.saveConfig=window.savedConfigAPI;document.querySelector('#exclude-patterns').value='';document.querySelector('#btn-save-excludes').click()");
    assert.deepEqual(await evaluate('S.config.excludePatterns'), [], 'empty rules are saved explicitly');
    for(const width of [1120,920]) {
      await send('Emulation.setDeviceMetricsOverride',{width,height:620,deviceScaleFactor:1,mobile:false});
      for(const view of ['dashboard','tasks','logs','stats','settings','about']) {
        await evaluate(`switchView('${view}')`);await pause(350);
        assert.equal(await evaluate('document.querySelector("#main").scrollWidth <= document.querySelector("#main").clientWidth'),true,`${view} overflow at ${width}`);
        if(width===920)await shot(`small-${view}`);
      }
    }
    await send('Emulation.setDeviceMetricsOverride',{width:1120,height:740,deviceScaleFactor:1,mobile:false});
    await evaluate("switchView('settings');document.querySelector('#theme-grid').scrollIntoView({block:'center'})");await shot('themes');
    await evaluate("switchView('about')");await shot('about');
    // 关于页：外链必须交给系统浏览器，不能在应用窗口内导航
    const appUrl = await evaluate('location.href');
    await evaluate("window.externalUrls=[];window.openedPaths=[];window.copiedText='';try{Object.defineProperty(navigator,'clipboard',{value:{writeText:async t=>{window.copiedText=t;}},configurable:true});}catch(e){}window.__scrolled=[];window.__origScrollIntoView=Element.prototype.scrollIntoView;Element.prototype.scrollIntoView=function(){window.__scrolled.push(this.id||'?');};");
    await evaluate("document.querySelector('#about-repo-link').click()");
    await pause(250);
    assert.equal(await evaluate('location.href'),appUrl,'repository link must not navigate inside the app window');
    assert.deepEqual(await evaluate('window.externalUrls'),['https://github.com/XiaoMing-Brother/backup'],'repository link is handed to the system browser');
    await evaluate("window.externalUrls=[];document.querySelector('#btn-about-repo').click()");
    assert.deepEqual(await evaluate('window.externalUrls'),['https://github.com/XiaoMing-Brother/backup'],'repository button is handed to the system browser');
    await evaluate("document.querySelector('#btn-about-changelog').click()");
    assert.deepEqual(await evaluate('window.__scrolled'),['about-changelog-card'],'changelog button scrolls to the timeline');
    await evaluate("document.querySelector('#btn-about-data').click()");
    assert.deepEqual(await evaluate('window.openedPaths'),['C:\\Users\\Test\\AppData\\Roaming\\incremental-backup-assistant'],'data directory button opens the data folder');
    await evaluate("document.querySelector('#btn-about-copy').click()");
    await pause(150);
    assert.match(await evaluate('window.copiedText'),new RegExp(`Backy ${pkgVersion.replace(/\./g,'\\.')}`),'copy button copies version info');
    await evaluate("Element.prototype.scrollIntoView=window.__origScrollIntoView");
    await evaluate("switchView('tasks');openModal(-1)");
    assert.equal(await evaluate("document.querySelector('#modal-quark').checked"),false,'new tasks default to local only');
    await evaluate("closeModal();document.querySelector('#task-list [data-task-quark]').click()");
    assert.equal(await evaluate('S.config.tasks[0].quarkEnabled'),true,'task choice saved');
    assert.equal(await evaluate('!!S.config.tasks[1].quarkEnabled'),false,'other tasks stay local');
    await shot('quark-task-switch');
    await evaluate('openModal(0)');
    assert.equal(await evaluate("document.querySelector('#modal-quark').checked"),true,'editing retains the choice');
    await shot('quark-task');
    await evaluate('saveModal()');
    assert.equal(await evaluate('S.config.tasks[0].quarkEnabled'),true,'saving paths preserves the choice');
    await evaluate("switchView('settings');window.backupAPI.saveConfig({quarkEnabled:true})");
    assert.match(await evaluate("document.querySelector('#quark-task-summary').textContent"),/1 \/ 2/);
    assert.equal(await evaluate("document.querySelector('#quark-root').value"),'','default root needs no entry');
    assert.equal(await evaluate("document.querySelector('#quark-directory').open"),false,'custom root starts collapsed');
    await evaluate("document.querySelector('#quark-directory').open=true;document.querySelector('#quark-root').value=' 123 ';handlePush({type:'status',data:{running:false}})");
    assert.equal(await evaluate("document.querySelector('#quark-root').value"),' 123 ','status refresh preserves an unsaved root');
    await evaluate("document.querySelector('#btn-save-quark').click()");
    assert.equal(await evaluate('S.config.quarkRootId'),'123');
    await evaluate("document.querySelector('#quark-root').value='';document.querySelector('#btn-save-quark').click()");
    assert.equal(await evaluate('S.config.quarkRootId'),'0','empty root saves the default');
    assert.equal(await evaluate("document.querySelector('#quark-root').value"),'');
    await evaluate("document.querySelector('#btn-quark-login').click()");
    assert.equal(await evaluate("document.querySelector('#btn-quark-login').textContent"),'返回登录窗口');
    assert.equal(await evaluate("document.querySelector('#btn-quark-finish').hidden"),false);
    await evaluate("document.querySelector('#btn-quark-finish').click()");
    assert.equal(await evaluate("document.querySelector('#btn-quark-finish').disabled"),true);
    await evaluate("handlePush({type:'status',data:{quarkLoggedIn:false}})");
    assert.equal(await evaluate('quarkLoginStage'),'checking','status refresh does not interrupt login');
    await evaluate("handlePush({type:'quark:login',data:{loggedIn:false,windowOpen:true,error:'请完成扫码登录后重试'}})");
    assert.equal(await evaluate("document.querySelector('#btn-quark-finish').disabled"),false,'failed verification can be retried');
    await evaluate("document.querySelector('#btn-quark-finish').click()");
    await evaluate("handlePush({type:'quark:login',data:{loggedIn:true}})");
    assert.equal(await evaluate("document.querySelector('#quark-status').textContent"),'已连接夸克；重启软件后需重新连接');
    await evaluate("document.querySelector('#btn-quark-login').click();handlePush({type:'status',data:{quarkLoggedIn:true}})");
    assert.equal(await evaluate('quarkLoginStage'),'confirm','existing login does not reset a new login attempt');
    await evaluate("handlePush({type:'quark:login',data:{loggedIn:true,windowOpen:false}});document.querySelector('#quark-settings').scrollIntoView({block:'start'})");
    assert.equal(await evaluate("document.querySelector('#btn-quark-finish').hidden"),true);
    await evaluate("switchView('dashboard')");
    assert.equal(await evaluate("document.querySelector('#btn-upload-quark').disabled"),false,'manual Quark upload is available after selecting a task and connecting');
    await evaluate("document.querySelector('#btn-upload-quark').click()");
    assert.equal(await evaluate("window.quarkUploadClicks"),1,'manual Quark upload button invokes the dedicated command');
    await shot('quark-settings');
    await evaluate("switchView('dashboard');document.querySelector('#main').scrollTop=0;handlePush({type:'status',data:{running:true}});handlePush({type:'backup:start',data:{}})");
    assert.equal(await evaluate('document.querySelector(".status-card").dataset.motion'),'running');
    assert.equal(await evaluate("document.querySelector('#btn-pause-backup').hidden"),false,'pause is available while a task runs');
    assert.equal(await evaluate("document.querySelector('#btn-stop-backup').hidden"),false,'stop is available while a task runs');
    await evaluate("document.querySelector('#btn-pause-backup').click()");
    assert.equal(await evaluate("window.pauseClicks"),1,'pause invokes its dedicated command');
    await evaluate("handlePush({type:'status',data:{running:true,pauseRequested:true,paused:true}})");
    assert.equal(await evaluate("document.querySelector('#btn-resume-backup').hidden"),false,'resume appears after pausing');
    await evaluate("document.querySelector('#btn-resume-backup').click();document.querySelector('#btn-stop-backup').click()");
    assert.equal(await evaluate("window.resumeClicks"),1,'resume invokes its dedicated command');
    assert.equal(await evaluate("window.stopClicks"),1,'stop invokes its dedicated command');
    await evaluate("handlePush({type:'status',data:{running:false,pauseRequested:false,paused:false,recovery:{kind:'local',tasks:[]}}})");
    assert.equal(await evaluate("document.querySelector('#btn-resume-last').hidden"),false,'unfinished recovery task is visible');
    await evaluate("document.querySelector('#btn-resume-last').click()");
    assert.equal(await evaluate("window.recoveryClicks"),1,'recovery button invokes its dedicated command');
    await evaluate("handlePush({type:'status',data:{running:true,recovery:null}});handlePush({type:'backup:start',data:{}})");
    const localProgress = {phase:'local',stage:'copying',tasksTotal:2,tasksDone:1,taskIndex:2,taskSource:'D:\\Projects\\网站项目',currentPath:'D:\\Projects\\网站项目\\资料\\产品设计与交互说明文档-final.pdf',filesProcessed:136};
    await evaluate(`handlePush({type:'stats',data:{filesCopied:36,filesSkipped:100,progress:${JSON.stringify(localProgress)}}})`);
    assert.equal(await evaluate('document.querySelector("#backup-current-name").textContent'),'产品设计与交互说明文档-final.pdf');
    assert.equal(await evaluate('document.querySelector("#backup-meter").getAttribute("aria-valuenow")'),'50');
    assert.equal(await evaluate('document.querySelector("#backup-current-path").title'),localProgress.currentPath);
    assert.match(await evaluate('document.querySelector("#backup-progress-caption").textContent'),/136/);
    await shot('running');
    await send('Emulation.setDeviceMetricsOverride',{width:920,height:620,deviceScaleFactor:1,mobile:false});
    assert.equal(await evaluate('document.querySelector("#main").scrollWidth <= document.querySelector("#main").clientWidth'),true,'progress fits minimum window');
    await shot('small-progress');
    await evaluate(`handlePush({type:'stats',data:{progress:${JSON.stringify({...localProgress,taskSource:'D:\\'+ 'long-task-name-'.repeat(25)})}}})`);
    assert.equal(await evaluate('document.querySelector("#main").scrollWidth <= document.querySelector("#main").clientWidth'),true,'long task names fit minimum window');
    await evaluate(`handlePush({type:'stats',data:{progress:${JSON.stringify(localProgress)}}})`);
    await send('Emulation.setDeviceMetricsOverride',{width:1120,height:740,deviceScaleFactor:1,mobile:false});
    await evaluate("switchView('tasks')");
    await evaluate(`handlePush({type:'stats',data:{progress:${JSON.stringify({...localProgress,phase:'quark',stage:'uploading',tasksTotal:1,tasksDone:0,taskIndex:1,filesProcessed:8})}}});switchView('dashboard')`);
    assert.equal(await evaluate('document.querySelector("#status-text").textContent'),'正在上传到夸克…');
    assert.equal(await evaluate('document.querySelector("#backup-meter").getAttribute("aria-valuenow")'),'0','cloud stage does not reuse local completion');
    await shot('quark-progress');
    const a=await evaluate('getComputedStyle(document.querySelector(".flying-file")).transform');await pause(170);
    assert.notEqual(await evaluate('getComputedStyle(document.querySelector(".flying-file")).transform'),a,'file animation moves');
    await evaluate("handlePush({type:'backup:result',data:{success:true}});handlePush({type:'status',data:{running:false}})");
    assert.equal(await evaluate('document.querySelector(".status-card").dataset.motion'),'success');await shot('success');
    assert.equal(await evaluate('document.querySelector("#backup-meter").getAttribute("aria-valuenow")'),'100');
    await evaluate(`handlePush({type:'stats',data:{progress:${JSON.stringify(localProgress)}}})`);
    assert.equal(await evaluate('document.querySelector("#backup-meter").getAttribute("aria-valuenow")'),'100','late progress cannot overwrite completion');
    await evaluate("handlePush({type:'status',data:{running:true}});handlePush({type:'backup:start',data:{}})");await pause(1900);
    assert.equal(await evaluate('document.querySelector("#backup-current-name").textContent'),'正在准备文件列表…','new run clears the previous file');
    assert.equal(await evaluate('document.querySelector("#backup-meter").hasAttribute("aria-valuenow")'),false,'unknown total has no fake percent');
    assert.equal(await evaluate('document.querySelector(".status-card").dataset.motion'),'running');
    assert.equal(await evaluate('document.querySelector("#progress-bar").dataset.state'),'running','old timeout must not stop new run');
    await evaluate("handlePush({type:'backup:result',data:{success:false}});handlePush({type:'status',data:{running:false}})");
    assert.equal(await evaluate('document.querySelector(".status-card").dataset.motion'),'error');await shot('error');
    for(let i=0;i<60;i++) { if(await evaluate('document.querySelector(".status-card").dataset.motion === "waiting"')) break; await pause(100); }
    assert.equal(await evaluate('document.querySelector(".status-card").dataset.motion'),'waiting');
    assert.equal(await evaluate('document.querySelector("#backup-detail").hidden'),true);
    await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".clock-hand")).animationName'),'none');
    assert.equal(await evaluate('getComputedStyle(document.body).animationName'),'none');
    await evaluate("handlePush({type:'window:visibility',data:false})");
    assert.equal(await evaluate('document.body.dataset.motionPaused'),'true');
    await evaluate("handlePush({type:'window:visibility',data:true});handlePush({type:'status',data:{running:false,schedulerRunning:false}})");
    assert.equal(await evaluate('document.querySelector(".status-card").dataset.motion'),'idle');
    await evaluate("S.config.tasks=[];renderTasks();renderDashTasks();S.history=[];renderStats();switchView('dashboard')");await shot('empty');
    assert.equal(await evaluate('document.querySelectorAll("#dash-tasks .empty-state").length'),1);
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({ok:true,checks:['five themes','six views at 1120 and 920','about panel actions','quark login and retry states','per-task upload choice','optional root and unsaved draft','state transitions','moving file','rapid restart','reduced motion','hidden window','empty state','no runtime exceptions'],screenshots:output},null,2));
  } finally {
    try {
      // Edge 在 Windows 上可能重启为新进程，用 CDP 关闭整个测试浏览器。
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({id:999999,method:'Browser.close'}));
        await pause(1000);
      }
    } finally {
      ws?.close();
      child?.kill();
      server.close();
      await temporary.cleanup();
    }
  }
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
