const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { create, sweep, checkedDir } = require('./smoke-temp.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('拒绝临时目录外、根目录和非测试目录的清理', () => {
  assert.throws(() => checkedDir(os.tmpdir()));
  assert.throws(() => checkedDir(__dirname));
  assert.throws(() => checkedDir(path.join(os.tmpdir(), 'unrelated-profile')));
});

test('回收跳过活跃测试和未知目录，正常清理可重复执行', async () => {
  const unknown = fs.mkdtempSync(path.join(os.tmpdir(), 'backy-ui-'));
  fs.writeFileSync(path.join(unknown, 'keep.txt'), 'unrelated');
  let temporary;
  try {
    temporary = await create('tauri-backup-smoke-');
    await sweep();
    assert.ok(fs.existsSync(temporary.dir));
    assert.equal(fs.readFileSync(path.join(unknown, 'keep.txt'), 'utf8'), 'unrelated');
    await temporary.cleanup();
    assert.equal(fs.existsSync(temporary.dir), false);
    await temporary.cleanup();
  } finally {
    if (temporary && fs.existsSync(temporary.dir)) await temporary.cleanup();
    fs.rmSync(checkedDir(unknown), { recursive: true, force: true });
  }
});

test('测试所有者被强制终止后，独立清理进程删除目录', { timeout: 60000 }, async () => {
  const child = spawn(process.execPath, ['-e', `
    require(${JSON.stringify(require.resolve('./smoke-temp.cjs'))}).create('backy-ui-').then(temp => {
      const worker = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
        { detached: true, windowsHide: true, stdio: 'ignore' });
      temp.track(worker, process.execPath);
      worker.unref();
      process.send({ dir: temp.dir, workerPid: worker.pid });
      setInterval(() => {}, 1000);
    }).catch(error => { console.error(error); process.exit(1); });
  `], { windowsHide: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  let dir;
  try {
    const launched = await new Promise((resolve, reject) => {
      child.once('message', resolve);
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`测试进程提前退出: ${code}`)));
    });
    dir = launched.dir;
    assert.ok(fs.existsSync(dir));
    const stopped = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGKILL');
    await stopped;
    for (let i = 0; i < 160 && fs.existsSync(dir); i++) await sleep(250);
    assert.equal(fs.existsSync(dir), false, '强制终止后的目录应由独立进程回收');
    assert.throws(() => process.kill(launched.workerPid, 0), { code: 'ESRCH' }, '遗留的测试子进程应一并退出');
  } finally {
    child.kill();
    if (dir && fs.existsSync(dir)) await sweep();
  }
});

test('下一次运行回收断电留下的归属标记目录', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tauri-backup-smoke-'));
  // 先取得一个已退出的真实 PID，模拟所有者和清理进程一起停止的情况。
  const child = spawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  fs.writeFileSync(path.join(dir, '.backy-smoke-owner.json'), JSON.stringify({ kind: 'backy-smoke-v1', pid: child.pid }));
  try {
    await sweep();
    assert.equal(fs.existsSync(dir), false);
  } finally {
    fs.rmSync(checkedDir(dir), { recursive: true, force: true });
  }
});
