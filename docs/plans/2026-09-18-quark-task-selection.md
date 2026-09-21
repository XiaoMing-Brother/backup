# 夸克登录配置与任务选择

**目标：** 默认根目录无需填写；用户可逐个指定备份任务是否上传夸克；登录失败可直接重试。

**实现：** 保留全局 `quarkEnabled`，任务增加布尔字段 `quarkEnabled`。旧任务缺少该字段时，按旧全局开关迁移；新任务默认关闭。手动执行从当前配置解析任务，上传选择不信任调用方传来的旧字段。空目录在保存和执行时统一使用 `0`。

**技术栈：** Tauri 2、Rust、原生 JavaScript / HTML / CSS。

## 实施步骤

1. 修改 `src-tauri/src/backup.rs` 的任务结构；在 `src-tauri/src/main.rs` 加入旧配置迁移、目录默认值和服务端任务筛选。补充配置兼容、任务筛选、演练模式测试。
2. 修改 `app/renderer/index.html`、`app/renderer/app.js`、`app/renderer/styles.css`：分离打开登录与完成登录按钮，增加明确操作提示；自定义目录折叠展示且可留空；任务弹窗增加上传开关，列表显示同步状态。
3. 修复登录重开时窗口未聚焦、验证失败后不能直接重试的问题；登录检查不得将空账户数据认作成功。
4. 扩展 `tools/ui-smoke.cjs` 和 `tools/tauri-smoke.cjs`，覆盖目录留空、任务选择持久化、未选择任务不要求登录、登录重试。

## 验收

- `npm run check`：JavaScript 语法与 Rust 检查。
- `npm test`：配置、任务筛选与现有备份测试通过。
- `node tools/ui-smoke.cjs`：任务开关、登录状态、根目录、窄窗口布局通过，并检查截图。
- 构建测试用可执行文件，在隔离数据目录运行 Tauri 冒烟验证。真实账号扫码与云端上传需实际账号，不使用用户数据作为测试样本。

不提交 Git，不修改用户现有备份配置和数据。

## 验证结果

- `npm test`：26 项 Rust 测试通过，包含新增的旧配置迁移、默认根目录、上传范围、手动执行选项和登录响应校验。
- `npm run check`：JavaScript 语法和 Rust 检查通过。
- `node tools/ui-smoke.cjs`：任务选项保存与回填、登录重试、目录留空、未保存输入保护、1120 / 920 宽度布局通过；检查了 `artifacts/light-ui/quark-settings.png` 与 `quark-task.png`。
- `cargo build --manifest-path src-tauri/Cargo.toml` 后运行 `node tools/tauri-smoke.cjs src-tauri/target/debug/Backy.exe`：实际命令、配置持久化、本地备份、按任务决定是否需要登录均通过。
- 同一测试命令追加 `--quark-login`：真实登录窗口打开、再次置前、主窗口持续响应均通过。
- 本机已有正式 Backy 实例，因此真实程序测试构建使用环境变量 `TAURI_CONFIG={"identifier":"com.local.backy.quark-smoke"}`、`CDP_PORT=9347`；项目应用标识未修改，临时数据目录已清理。
- 未执行实际账号扫码后的云端上传。
