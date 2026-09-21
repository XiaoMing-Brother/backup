const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function bumpVersion(root) {
  const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
  const pkg = JSON.parse(read("package.json"));
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error("版本号必须为 major.minor.patch");
  const [major, minor, patch] = pkg.version.split(".");
  const version = `${major}.${minor}.${BigInt(patch) + 1n}`;
  const lock = JSON.parse(read("package-lock.json"));
  const config = JSON.parse(read("src-tauri/tauri.conf.json"));
  const cargo = read("src-tauri/Cargo.toml");
  const pattern = /(\[package\][\s\S]*?\nversion\s*=\s*)"[^"]+"/;
  if (!pattern.test(cargo)) throw new Error("Cargo.toml 缺少 package.version");
  pkg.version = lock.version = lock.packages[""].version = config.version = version;
  const files = {
    "package.json": JSON.stringify(pkg, null, 2) + "\n",
    "package-lock.json": JSON.stringify(lock, null, 2) + "\n",
    "src-tauri/tauri.conf.json": JSON.stringify(config, null, 2) + "\n",
    "src-tauri/Cargo.toml": cargo.replace(pattern, `$1"${version}"`),
  };
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(root, file), content);
  return version;
}

if (require.main === module) {
  const root = path.resolve(__dirname, "..");
  const args = process.argv.slice(2);
  const cli = require.resolve("@tauri-apps/cli/tauri.js");
  // 本机 MSVC 标准目录缺失的兼容库，可由本地副本补充，不覆盖系统安装。
  const compatLib = path.join(root, "tools", "msvc-libs");
  if (process.platform === "win32" && fs.existsSync(compatLib)) {
    process.env._LINK_ = `${process.env._LINK_ || ""} /LIBPATH:"${compatLib}"`;
  }
  // 先更新版本再启动 CLI，确保 Tauri 读取到本次打包版本；失败重试也使用新版本。
  if (args[0] === "build" && !args.includes("--help") && !args.includes("-h")) {
    console.log(`Backy ${bumpVersion(root)}`);
  }
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

module.exports = { bumpVersion };
