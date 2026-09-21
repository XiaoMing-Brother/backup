// 两套冒烟测试共用目录归属、进程退出后的清理和中断恢复逻辑。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const markerName = '.backy-smoke-owner.json';
const prefixes = ['backy-ui-', 'tauri-backup-smoke-'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function checkedDir(dir) {
  const absolute = path.resolve(dir);
  const parent = fs.realpathSync(path.dirname(absolute));
  if (parent !== fs.realpathSync(os.tmpdir()) ||
      !/^(backy-ui-|tauri-backup-smoke-)[A-Za-z0-9]{6}$/.test(path.basename(absolute))) {
    throw new Error(`拒绝清理测试临时目录以外的路径: ${dir}`);
  }
  if (fs.existsSync(absolute) && fs.lstatSync(absolute).isSymbolicLink()) {
    throw new Error(`拒绝清理目录联接或符号链接: ${dir}`);
  }
  return absolute;
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

function owner(dir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dir, markerName), 'utf8'));
    return value.kind === 'backy-smoke-v1' && Number.isInteger(value.pid) && value.pid > 0 ? value : null;
  } catch { return null; }
}

async function processes() {
  if (process.platform !== 'win32') return [];
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; @(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine) | ConvertTo-Json -Compress'],
  { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 15000 });
  return JSON.parse(stdout.trim() || '[]');
}

function samePath(a, b) {
  try { return fs.realpathSync(a).toLowerCase() === fs.realpathSync(b).toLowerCase(); }
  catch { return false; }
}

function usesProfile(proc, dir) {
  if (!/^(msedge|msedgewebview2|chrome)\.exe$/i.test(path.basename(proc.ExecutablePath || ''))) return false;
  const match = (proc.CommandLine || '').match(/(?:^|\s)--user-data-dir=(?:"([^"]+)"|([^\s]+))/);
  return !!match && (samePath(match[1] || match[2], dir) || samePath(match[1] || match[2], path.join(dir, 'webview', 'EBWebView')) || samePath(match[1] || match[2], path.join(dir, 'webview')));
}

async function remove(dir, info, snapshot) {
  dir = checkedDir(dir);
  if (!fs.existsSync(dir)) return;
  // 只结束使用该测试 profile 的浏览器，以及本次记录的测试应用子进程。
  for (const proc of snapshot) {
    const testChild = info && proc.ProcessId === info.childPid && proc.ParentProcessId === info.pid &&
      samePath(proc.ExecutablePath || '', info.executable || '');
    if (!usesProfile(proc, dir) && !testChild) continue;
    try {
      await exec('taskkill.exe', ['/PID', String(proc.ProcessId), '/T', '/F'], { windowsHide: true, timeout: 10000 });
    } catch (error) {
      if (alive(proc.ProcessId)) throw error;
    }
  }
  await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  console.log(`Test temporary directory removed: ${dir}`);
}

function legacyProfile(dir) {
  if (path.basename(dir).startsWith('backy-ui-')) {
    return fs.existsSync(path.join(dir, 'Local State')) && fs.existsSync(path.join(dir, 'Default'));
  }
  try {
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'backup.config.json'), 'utf8'));
    return config.tasks?.some(task => samePath(task.source, path.join(dir, 'source')) && samePath(task.backup, path.join(dir, 'backup')));
  } catch { return false; }
}

async function sweep() {
  const snapshot = await processes();
  for (const entry of fs.readdirSync(os.tmpdir(), { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^(backy-ui-|tauri-backup-smoke-)[A-Za-z0-9]{6}$/.test(entry.name)) continue;
    const dir = checkedDir(path.join(os.tmpdir(), entry.name));
    const info = owner(dir);
    if (info && alive(info.pid)) continue;
    if (!info && (!legacyProfile(dir) || snapshot.some(proc => usesProfile(proc, dir)))) continue;
    await remove(dir, info, snapshot);
  }
}

async function create(prefix) {
  if (!prefixes.includes(prefix)) throw new Error('无效的测试目录前缀');
  await sweep();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const info = { kind: 'backy-smoke-v1', pid: process.pid };
  const save = () => fs.writeFileSync(path.join(dir, markerName), JSON.stringify(info));
  try {
    save();
    // 独立进程在测试进程被强制结束后仍可收尾；断电残留由下次 sweep 处理。
    const watcher = spawn(process.execPath, [__filename, '--watch', dir, String(process.pid)],
      { detached: true, windowsHide: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => { watcher.once('spawn', resolve); watcher.once('error', reject); });
    watcher.unref();
  } catch (error) {
    await fs.promises.rm(checkedDir(dir), { recursive: true, force: true });
    throw error;
  }
  return {
    dir,
    track(child, executable) { info.childPid = child.pid; info.executable = path.resolve(executable); save(); },
    async cleanup() { await remove(dir, info, await processes()); },
  };
}

if (require.main === module) {
  (async () => {
    if (process.argv[2] === '--sweep') return sweep();
    if (process.argv[2] !== '--watch') throw new Error('无效的清理命令');
    const dir = checkedDir(process.argv[3]);
    const pid = Number(process.argv[4]);
    while (fs.existsSync(dir) && alive(pid)) await sleep(1000);
    if (fs.existsSync(dir) && owner(dir)?.pid === pid) await remove(dir, owner(dir), await processes());
  })().catch(error => { console.error(error); process.exitCode = 1; });
}

module.exports = { create, sweep, checkedDir };
