# Backy

基于 Tauri 2 + Rust 的 Windows 桌面工具，支持增量备份、定时调度、镜像清理、演练模式和托盘常驻。

## 运行

本次保留的主程序和安装包位于 `release/`。运行需要 Windows 10/11 和 WebView2；安装包会在缺少 WebView2 时联网下载。

## 开发与验证

需要 Node.js、Rust（版本见 `rust-toolchain.toml`）、Visual Studio C++ Build Tools 和 Windows SDK。

```bash
npm ci
npm start
npm test
npm run check
npm run dist
```

`npm run pack` 仅生成 EXE。新构建的主程序位于 `src-tauri/target/release/Backy.exe`，安装包位于其 `bundle/nsis/` 子目录；`release/` 中的副本不会自动更新。

使用 `npm run pack`、`npm run dist` 或 `npm run tauri -- build` 打包时，版本号末位自动加一（例如 `1.1.0` 变为 `1.1.1`），并同步 Node、Rust 和 Tauri 配置。打包失败也保留递增后的版本，重试继续递增。开发启动不递增版本；请通过上述入口打包，直接执行 `tauri build` 或 `cargo build` 不会递增。窗口标题栏显示实际应用版本。

本机构建环境的 MSVC 标准目录缺少 `legacy_stdio_definitions.lib` 和 `oldnames.lib`，已将同版本 x64 兼容库复制到 `tools/msvc-libs/`。打包入口自动补充该目录的链接搜索路径；这些本地二进制文件不提交 Git。其他机器建议安装完整的 C++ Build Tools。

真实窗口及备份流程验证使用独立临时数据目录：

```bash
node tools/tauri-smoke.cjs src-tauri/target/release/Backy.exe
```

运行前请先退出托盘中已启动的 Backy：应用是单实例的，新进程会把参数交给已运行实例后立即退出，
脚本会因此看不到 WebView。脚本不会主动结束已运行的实例。

## 目录

- `app/renderer/`：界面和 Tauri 通信代码，`changelog.js` 保存升级日志数据。
- `src-tauri/`：Rust 备份、调度逻辑及桌面构建配置，单元测试包含在源码中。
- `assets/icon.ico`：应用图标。
- `tools/tauri-smoke.cjs`：真实窗口验证脚本；`tools/ui-smoke.cjs`：界面渲染验证脚本。
- `release/`：保留的可运行程序和安装包，不进入版本管理。
- `CHANGELOG.md`：升级日志，与 `app/renderer/changelog.js` 内容保持一致。

依赖、构建产物（`node_modules/`、`src-tauri/target/`、`release/`）、界面截图产物
（`artifacts/`）、本地兼容库（`tools/msvc-libs/`）和开发期运行数据都已在 `.gitignore` 中排除。

## 关于与升级日志

界面「关于」页展示版本号、构建类型、应用标识、许可证、仓库地址与数据目录，
并提供打开仓库、查看升级日志、复制版本信息和打开数据目录四个入口。
版本与数据目录由 Rust 端 `get_app_info` 提供，升级日志读取 `app/renderer/changelog.js`。

发版时在 `changelog.js` 的 `entries` 顶部追加一条记录，并同步补充到 `CHANGELOG.md`，
两者内容应保持一致。

## 数据与备份规则

设置页的“备份排除”可编辑所有任务共用的排除规则，每行一个文件名、目录名或通配符（如 `node_modules`、`.git`、`.svn`、`*.log`）。匹配任意层级的名称，区分大小写，不接受路径；命中目录时跳过整棵目录树。隐藏名称需要显式规则，例如 `.env*`，`*.log` 不匹配 `.hidden.log`。旧配置自动沿用原有默认规则，清空并保存表示不排除任何名称。规则存储在 `backup.config.json` 的 `excludePatterns` 数组，保存后从下一次本地备份或夸克上传生效。已有排除项不会被更新或清理；包含排除项的过期目录也会整体保留，云端已有文件不会主动删除。

设置页的“数据”区域可修改增量状态文件路径，保存后用于后续备份并在重启后保留。原文件不会自动搬迁或删除；选择新的空路径后，下次实际备份会生成状态文件。备份运行期间不能切换路径。

开发模式数据保存在项目根目录：`backup.config.json`、`backup-state.json`、`backup-history.json`（三者已在 `.gitignore` 中排除，不会提交）。正式版沿用 `%APPDATA%/incremental-backup-assistant`，兼容旧版 JSON 数据。可用绝对路径环境变量 `BACKUP_ASSISTANT_DATA_DIR` 指定独立数据目录。

备份采用镜像同步：源目录删除的文件会从目标目录清理。源目录缺失或不可读时不会按空目录清理；拒绝源/目标重叠及符号链接、目录联接。演练模式不写入目标和增量状态。请避免多个版本同时执行备份。

## 夸克压缩包上传

点击“上传夸克”时，每个已选任务的本地备份目录会先打包成一个 ZIP，再上传到目标网盘目录下的同名任务文件夹。包内保留目录结构、中文文件名和空目录，并应用设置中的排除规则。

压缩包使用内容摘要命名（`Backy-<SHA-256>.zip`）；相同内容再次上传或恢复任务时会检查云端并跳过已有包。内容变化时上传新的完整包，保留旧版本和原先已上传的散文件。打包期间需要本地临时磁盘空间，临时压缩包在上传完成、失败或停止后自动清理。界面显示“打包 ZIP 压缩包”和“上传到夸克”两个阶段；上传进度按压缩包计数。

## 许可证

MIT
