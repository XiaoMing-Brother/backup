// 使用独立临时目录验证真实 Tauri 窗口和 Rust 命令，不接触用户备份。
const fs = require("node:fs");
const smokeTemp = require("./smoke-temp.cjs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
(async () => {
const temporary = await smokeTemp.create("tauri-backup-smoke-");
const root = temporary.dir;
let child;
let ws;
let exited = false;
let stopped = Promise.resolve();
try {
const source = path.join(root, "source");
const backup = path.join(root, "backup");
const data = path.join(root, "data");
for (const dir of [source, backup, data]) fs.mkdirSync(dir);
fs.writeFileSync(path.join(source, "hello.txt"), "backup smoke test");
fs.writeFileSync(path.join(source, "ignored.log"), "ignored");
fs.writeFileSync(path.join(backup, "stale.txt"), "stale");
fs.writeFileSync(path.join(data, "backup.config.json"), JSON.stringify({ tasks: [{ source, backup }], autoStartBackup: false, notifyOnFinish: false, autoStart: false }));
fs.writeFileSync(path.join(data, "backup-history.json"), JSON.stringify([{ id: 1, finishedAt: 1, success: true, filesCopied: 7 }]));
fs.writeFileSync(path.join(data, "backup-state.json"), JSON.stringify({ "legacy-file": { size: 1, mtimeMs: 1, hash: "legacy" } }));
const executable = path.resolve(process.argv[2] || "src-tauri/target/release/Backy.exe");
const port = Number(process.env.CDP_PORT || 9335);
child = spawn(executable, [], { windowsHide: true, env: { ...process.env, BACKUP_ASSISTANT_DATA_DIR: data, WEBVIEW2_USER_DATA_FOLDER: path.join(root, "webview"), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }, stdio: "pipe" });
let childError;
child.on("error", (error) => { childError = error; });
child.stderr.on("data", (chunk) => process.stderr.write(chunk));
let exitDetails;
stopped = new Promise((resolve) => child.once("exit", (code, signal) => { exited = true; exitDetails = { code, signal }; resolve(); }));
temporary.track(child, executable);

    let target;
    for (let i = 0; i < 120; i++) {
      if (childError) throw childError;
      // 及早退出且退出码为 0，几乎总是单实例插件把参数转交给了已在运行的正式版实例。
      if (exited) {
        const detail = `Application exited before WebView became ready: ${JSON.stringify(exitDetails)}`;
        throw new Error(exitDetails && exitDetails.code === 0
          ? `${detail}\n提示：已有一个 Backy 实例在运行（单实例限制）。请先退出托盘中的 Backy，再运行本脚本；本脚本不会主动结束已运行的实例。`
          : detail);
      }
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = targets.find((t) => t.type === "page" && !t.url.startsWith("devtools:"));
        if (target) break;
      } catch {}
      await sleep(500);
    }
    assert.ok(target, "WebView CDP target available");
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0;
    const pending = new Map();
    ws.onmessage = ({ data }) => {
      const msg = JSON.parse(data);
      if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const seq = ++id;
      const timer = setTimeout(() => { pending.delete(seq); reject(new Error(`Timeout: ${method}`)); }, 20000);
      pending.set(seq, (msg) => { clearTimeout(timer); msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result); });
      ws.send(JSON.stringify({ id: seq, method, params }));
    });
    const evaluate = async (expression) => {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    for (let i = 0; i < 50; i++) {
      if (await evaluate("document.body?.dataset.ready === '1'")) break;
      await sleep(200);
    }
    assert.equal(await evaluate("document.body.dataset.ready"), "1", "UI initialized");
    if (process.argv.includes("--quark-login")) {
      await evaluate("switchView('settings'); document.querySelector('#btn-quark-login').click()");
      for (let i = 0; i < 100; i++) {
        if (await evaluate("quarkLoginStage === 'confirm'")) break;
        await sleep(100);
      }
      assert.equal(await evaluate("quarkLoginStage"), "confirm", "login window creation returns without deadlock");
      assert.equal((await evaluate("window.backupAPI.getState()")).status.quarkLoggedIn, false, "main window commands still respond");
      assert.equal((await evaluate("window.backupAPI.quarkLogin()")).ok, true, "reopening the login window responds");
      let loginTarget;
      for (let i = 0; i < 60; i++) {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        loginTarget = targets.find((t) => t.type === "page" && t.url.startsWith("https://pan.quark.cn/"));
        if (loginTarget) break;
        await sleep(500);
      }
      assert.ok(loginTarget, "Quark page opens in WebView2");
      // 页面加载期间持续调用后端，覆盖原先整个应用无响应的回归场景。
      for (let i = 0; i < 10; i++) {
        assert.equal((await evaluate("window.backupAPI.getState()")).status.running, false);
        await sleep(500);
      }
      const loginWs = new WebSocket(loginTarget.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { loginWs.onopen = resolve; loginWs.onerror = reject; });
      try {
        let loginId = 0;
        const loginSend = (method, params = {}) => new Promise((resolve, reject) => {
          const seq = ++loginId;
          const timer = setTimeout(() => reject(new Error(`Quark timeout: ${method}`)), 20000);
          loginWs.onmessage = ({ data }) => {
            const msg = JSON.parse(data);
            if (msg.id !== seq) return;
            clearTimeout(timer);
            msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
          };
          loginWs.send(JSON.stringify({ id: seq, method, params }));
        });
        const page = await loginSend("Runtime.evaluate", { expression: "({title:document.title, text:document.body.innerText.slice(0,1500), images:Array.from(document.images).map(i=>({className:i.className,width:i.naturalWidth,height:i.naturalHeight})), canvases:document.querySelectorAll('canvas').length})", returnByValue: true });
        const shot = await loginSend("Page.captureScreenshot", { format: "png" });
        fs.mkdirSync("artifacts", { recursive: true });
        fs.writeFileSync("artifacts/quark-login-smoke.png", Buffer.from(shot.data, "base64"));
        console.log(JSON.stringify({ quarkPage: page.result.value, screenshot: "artifacts/quark-login-smoke.png" }, null, 2));
      } finally {
        loginWs.close();
      }
      console.log(JSON.stringify({ ok: true, root, checks: ["quark window opens", "main window remains responsive", "reopen login window", "isolated browser profile"], loginTarget: { id: loginTarget.id, url: loginTarget.url } }, null, 2));
      return;
    }
    const version = await evaluate("window.__TAURI__.app.getVersion()");
    assert.equal(await evaluate("document.querySelector('.tb-title').textContent"), `Backy ${version}`, "application name and version");
    assert.equal(await evaluate("document.title"), `Backy ${version}`, "document title");
    assert.equal(await evaluate("document.querySelector('.tb-icon').naturalWidth > 0"), true, "icon loaded");
    const initial = await evaluate("window.backupAPI.getState()");
    assert.equal(initial.history.length, 1, "legacy history retained");
    assert.equal(initial.config.tasks[0].source, source);
    assert.equal(initial.config.tasks[0].quarkEnabled, false, "legacy local tasks stay local");
    assert.equal(initial.status.schedulerRunning, false);
    for (const rule of ['node_modules', '.git', '.svn', '*.log']) assert.ok(initial.config.excludePatterns.includes(rule), 'legacy configuration gets default exclusions');
    await evaluate("window.backupAPI.saveConfig({theme:'forest', intervalMinutes:2})");
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, "backup.config.json"))).theme, "forest");
    await evaluate("window.backupAPI.startScheduler()");
    assert.equal((await evaluate("window.backupAPI.getState()")).status.schedulerRunning, true);
    await evaluate("window.backupAPI.stopScheduler()");
    const run = async () => {
      await evaluate("window.smokeProgress=[];if(!window.smokeProgressListening){window.smokeProgressListening=true;window.backupAPI.onPush(e=>{if(e.type==='stats'&&e.data?.progress)window.smokeProgress.push(e.data.progress)})}");
      assert.equal((await evaluate("window.backupAPI.runNow(null)")).ok, true);
      for (let i = 0; i < 100; i++) {
        const state = await evaluate("window.backupAPI.getState()");
        if (!state.status.running) return state;
        await sleep(100);
      }
      throw new Error("Backup did not finish");
    };
    const first = await run();
    assert.equal(first.status.lastResult.success, true);
    assert.equal(first.status.lastResult.filesCopied, 1);
    assert.equal(first.status.lastResult.itemsDeleted, 1);
    assert.equal(first.history.length, 2);
    const progressEvents = await evaluate("window.smokeProgress");
    assert.ok(progressEvents.length > 0, "real progress events reach the renderer");
    assert.equal(progressEvents.at(-1).tasksTotal, 1);
    assert.equal(progressEvents.at(-1).tasksDone, 1);
    assert.equal(progressEvents.at(-1).filesProcessed, 1);
    assert.equal(progressEvents.at(-1).taskSource, source);
    assert.equal(first.liveStats, null, "finished run clears the live snapshot");
    assert.equal(first.history.at(-1).progress, undefined, "progress does not grow history records");
    assert.equal(fs.readFileSync(path.join(backup, "hello.txt"), "utf8"), "backup smoke test");
    assert.equal(fs.existsSync(path.join(backup, "stale.txt")), false);
    assert.equal(fs.existsSync(path.join(backup, "ignored.log")), false);
    // state 每轮重建：预置的遗留条目会被清掉，只保留本轮真正遍历到的源文件。
    const rebuiltState = JSON.parse(fs.readFileSync(path.join(data, "backup-state.json")));
    assert.equal(rebuiltState["legacy-file"], undefined, "rebuilt state drops entries this run never walked");
    assert.ok(Object.keys(rebuiltState).some((key) => key.endsWith("hello.txt")), "rebuilt state records this run's source files");
    assert.ok(!Object.keys(rebuiltState).some((key) => key.endsWith("ignored.log")), "excluded files never enter the state");
    const unchangedState = path.join(data, "backup-state.json");
    fs.utimesSync(unchangedState, new Date(100000), new Date(100000));
    const unchangedMtime = fs.statSync(unchangedState).mtimeMs;
    const second = await run();
    assert.equal(second.status.lastResult.filesSkipped, 1);
    assert.equal(fs.statSync(unchangedState).mtimeMs, unchangedMtime, "unchanged backup does not rewrite state");
    const oldState = fs.readFileSync(path.join(data, "backup-state.json"), "utf8");
    const customState = path.join(root, "custom", "state.json");
    await evaluate(`window.backupAPI.saveConfig({stateFile:${JSON.stringify(customState)}})`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, "backup.config.json"))).stateFile, customState);
    assert.equal((await run()).status.lastResult.success, true);
    assert.ok(fs.existsSync(customState));
    assert.equal(fs.readFileSync(path.join(data, "backup-state.json"), "utf8"), oldState);
    assert.equal(await evaluate("document.querySelector('#state-file').value"), customState);
    await evaluate("window.backupAPI.saveConfig({dryRun:true})");
    fs.writeFileSync(path.join(source, "new.txt"), "dry");
    await run();
    assert.equal(fs.existsSync(path.join(backup, "new.txt")), false);
    await evaluate("window.backupAPI.saveConfig({dryRun:false,quarkEnabled:true,quarkRootId:'   '})");
    assert.equal((await evaluate("window.backupAPI.getState()")).config.quarkRootId, "0", "blank root defaults on the backend");
    assert.equal((await run()).status.lastResult.success, true, "unselected tasks do not need a Quark login");
    await evaluate("window.backupAPI.saveConfig({tasks:S.config.tasks.map(t=>({...t,quarkEnabled:true}))})");
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, "backup.config.json"))).tasks[0].quarkEnabled, true, "per-task choice persisted");
    assert.equal((await run()).status.lastResult.success, true, "local backups do not upload selected Quark tasks automatically");
    const uploadWithoutLogin = await evaluate("window.backupAPI.uploadQuark()");
    assert.equal(uploadWithoutLogin.ok, false, "manual Quark upload requires a login");
    await evaluate("window.backupAPI.saveConfig({tasks:S.config.tasks.map(t=>({...t,quarkEnabled:false}))})");
    await evaluate("window.backupAPI.runNow(S.config.tasks.map(t=>({...t,quarkEnabled:true})))");
    for (let i = 0; i < 100; i++) {
      if (!(await evaluate("window.backupAPI.getState()")).status.running) break;
      await sleep(100);
    }
    const manual = await evaluate("window.backupAPI.getState()");
    assert.equal(manual.status.running, false);
    assert.equal(manual.status.lastResult.success, true, "manual runs use the saved task choice");
    await evaluate("window.backupAPI.saveConfig({quarkEnabled:false})");
    fs.mkdirSync(path.join(source, 'nested', 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(source, 'nested', 'node_modules', 'package.json'), '{}');
    fs.writeFileSync(path.join(source, 'nested', 'skip.zip'), 'skip');
    const customExcludes = ['node_modules', '*.zip'];
    await evaluate(`switchView('settings');document.querySelector('#exclude-patterns').value=${JSON.stringify(customExcludes.join('\n'))};document.querySelector('#btn-save-excludes').click()`);
    for (let i = 0; i < 50; i++) {
      if (await evaluate("document.querySelector('#exclude-message').textContent.includes('已保存')")) break;
      await sleep(100);
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, 'backup.config.json'))).excludePatterns, customExcludes);
    assert.equal((await run()).status.lastResult.success, true);
    assert.equal(fs.existsSync(path.join(backup, 'nested', 'node_modules')), false);
    assert.equal(fs.existsSync(path.join(backup, 'nested', 'skip.zip')), false);
    assert.equal(fs.existsSync(path.join(backup, 'ignored.log')), true, 'custom rules replace the defaults');
    const beforeInvalid = fs.readFileSync(path.join(data, 'backup.config.json'), 'utf8');
    const invalidExcludes = await evaluate("window.backupAPI.saveConfig({excludePatterns:['[broken']}).then(()=>null,error=>String(error))");
    assert.match(invalidExcludes, /排除规则无效/);
    assert.equal(fs.readFileSync(path.join(data, 'backup.config.json'), 'utf8'), beforeInvalid, 'invalid rules never overwrite saved config');
    await send('Page.reload');
    for (let i = 0; i < 50; i++) {
      if (await evaluate("document.body?.dataset.ready === '1'")) break;
      await sleep(100);
    }
    assert.equal(await evaluate("document.querySelector('#exclude-patterns').value"), customExcludes.join('\n'), 'reopened UI reads saved rules');
    await evaluate("window.backupAPI.saveConfig({excludePatterns:[]})");
    assert.equal((await run()).status.lastResult.success, true);
    assert.equal(fs.existsSync(path.join(backup, 'nested', 'node_modules', 'package.json')), true);
    assert.equal(fs.existsSync(path.join(backup, 'nested', 'skip.zip')), true);
    const maximized = await evaluate("window.backupAPI.toggleMaximize()");
    await sleep(300);
    assert.equal(await evaluate("window.backupAPI.isMaximized()"), true);
    await evaluate("window.backupAPI.toggleMaximize()");
    await sleep(300);
    assert.equal(await evaluate("window.backupAPI.isMaximized()"), false);
    for (const view of ["tasks", "settings", "stats", "logs", "dashboard"]) {
      await evaluate(`document.querySelector('[data-view="${view}"]').click()`);
      assert.equal(await evaluate(`document.querySelector('#view-${view}').classList.contains('active')`), true);
    }
    await evaluate("switchView('logs'); document.querySelector('#btn-clear-log').click()");
    const logBurst = await evaluate(`(() => {
      const started = performance.now();
      for (let i = 0; i < 10000; i++) {
        handlePush({ type: 'log', data: { level: 'info', text: 'burst-' + i, time: Date.now() } });
      }
      return { buffered: S.logs.length, nodesBeforeFlush: document.querySelector('#log-panel').childElementCount, enqueueMs: performance.now() - started };
    })()`);
    assert.equal(logBurst.buffered, 800, "log data is bounded");
    assert.equal(logBurst.nodesBeforeFlush, 0, "log rendering is batched");
    await sleep(250);
    assert.equal(await evaluate("document.querySelector('#log-panel').childElementCount"), 800, "log DOM is bounded after a burst");
    assert.ok((await evaluate("document.querySelector('#log-panel').lastElementChild.textContent")).endsWith("burst-9999"));
    await evaluate("document.querySelector('#log-panel').scrollTop = 0; handlePush({type:'log',data:{level:'info',text:'while-reading',time:Date.now()}})");
    await sleep(250);
    assert.equal(await evaluate("document.querySelector('#log-panel').scrollTop"), 0, "new logs do not force scrolling while reading");
    await evaluate("switchView('dashboard')");
    await evaluate(`handlePush({type:'logs',data:Array.from({length:1000},(_,i)=>({level:'info',text:'hidden-'+i,time:Date.now()}))})`);
    await sleep(250);
    assert.ok((await evaluate("document.querySelector('#log-panel').lastElementChild.textContent")).endsWith("while-reading"), "inactive log page does not render");
    await evaluate("switchView('logs')");
    assert.equal(await evaluate("document.querySelector('#log-panel').childElementCount"), 800);
    assert.ok((await evaluate("document.querySelector('#log-panel').lastElementChild.textContent")).endsWith("hidden-999"), "opening logs renders the latest buffered entries");
    await evaluate("handlePush({type:'log',data:{level:'info',text:'pending-clear',time:Date.now()}}); document.querySelector('#btn-clear-log').click()");
    await sleep(250);
    assert.equal(await evaluate("document.querySelector('#log-panel').childElementCount"), 0, "clearing logs cancels pending rendering");
    await evaluate("window.backupAPI.startScheduler()");
    assert.equal(await evaluate("countdownTimer"), null, "inactive dashboard has no countdown timer");
    await evaluate("switchView('dashboard')");
    assert.equal(await evaluate("countdownTimer !== null"), true, "countdown resumes on dashboard");
    for (const action of ["minimizeWindow", "hideWindow"]) {
      await evaluate(`window.backupAPI.${action}()`);
      await sleep(300);
      const hiddenTimer = await evaluate("countdownTimer");
      const opener = spawn(executable, [], { windowsHide: true, env: { ...process.env, BACKUP_ASSISTANT_DATA_DIR: data }, stdio: "ignore" });
      await new Promise((resolve, reject) => {
        opener.once("error", reject);
        opener.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Restore failed: ${code}`)));
      });
      await sleep(300);
      assert.equal(hiddenTimer, null, `${action} stops the countdown timer`);
      assert.equal(await evaluate("countdownTimer !== null"), true, "restoring the window resumes countdown");
    }
    await evaluate("window.backupAPI.stopScheduler()");
    assert.equal(await evaluate("countdownTimer"), null, "stopping scheduling stops the countdown timer");
    await send("Page.enable");
    const screenshot = await send("Page.captureScreenshot", { format: "png" });
    fs.mkdirSync("artifacts", { recursive: true });
    fs.writeFileSync("artifacts/tauri-smoke.png", Buffer.from(screenshot.data, "base64"));
    await evaluate("window.backupAPI.clearHistory()");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, "backup-history.json"))), []);
    console.log(JSON.stringify({ ok: true, root, checks: ["initialization", "icon", "legacy data", "config persistence", "scheduler", "backup", "cleanup", "incremental skip", "unchanged state", "dry run", "optional Quark root", "per-task upload persistence", "local backups never upload automatically", "manual Quark upload requires login", "maximize", "navigation", "bounded log rendering", "inactive page buffering", "countdown lifecycle", "history clear"], logBurst, screenshot: "artifacts/tauri-smoke.png" }, null, 2));
    send("Runtime.evaluate", { expression: "window.backupAPI.quitApp()" }).catch(() => {});
    await Promise.race([stopped, sleep(5000)]);
    assert.equal(exited, true, "quit exits the application");
  } finally {
    if (ws) ws.close();
    if (child && !exited) { child.kill(); await Promise.race([stopped, sleep(3000)]); }
    await temporary.cleanup();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
