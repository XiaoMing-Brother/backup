const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { bumpVersion } = require("./tauri.cjs");

test("打包连续递增版本并同步配置，保留依赖版本", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "backy-version-"));
  try {
    fs.mkdirSync(path.join(root, "src-tauri"));
    const write = (file, value) => fs.writeFileSync(path.join(root, file), value);
    const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
    write("package.json", JSON.stringify({ version: "1.1.9" }));
    write("package-lock.json", JSON.stringify({ version: "1.1.9", packages: { "": { version: "1.1.9" }, dep: { version: "2.0.0" } } }));
    write("src-tauri/tauri.conf.json", JSON.stringify({ version: "1.1.9", productName: "Backy" }));
    write("src-tauri/Cargo.toml", '[package]\nname = "backup-assistant"\nversion = "1.1.9"\n[dependencies]\ntauri = { version = "2" }\n');
    assert.equal(bumpVersion(root), "1.1.10");
    assert.equal(bumpVersion(root), "1.1.11");
    for (const file of ["package.json", "package-lock.json", "src-tauri/tauri.conf.json"]) assert.equal(read(file).version, "1.1.11");
    assert.equal(read("package-lock.json").packages[""].version, "1.1.11");
    assert.equal(read("package-lock.json").packages.dep.version, "2.0.0");
    assert.match(fs.readFileSync(path.join(root, "src-tauri/Cargo.toml"), "utf8"), /version = "1.1.11"/);
    write("package.json", JSON.stringify({ version: "invalid" }));
    assert.throws(() => bumpVersion(root), /major.minor.patch/);
    assert.equal(read("src-tauri/tauri.conf.json").version, "1.1.11");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
