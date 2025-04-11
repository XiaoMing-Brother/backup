import fs from "fs";
import path from "path";
import { promisify } from "util";
import { minimatch } from "minimatch";
import chalk from "chalk";
import crypto from "crypto";

// 在文件顶部添加
process.env.FORCE_COLOR = "1";
chalk.level = 3; // 强制启用颜色
/**
 * 默认配置项
 */
const ICONS = {
  success: "✅",
  error: "❌",
  warning: "⚠️",
  info: "ℹ️",
  file: "📄",
  folder: "📁",
  clock: "⏱️",
  storage: "💾",
  network: "📶",
  start: "🚀",
  complete: "🏁",
  backup: "📂",
  sync: "🔄",
  clean: "🧹",
  config: "⚙️",
  hash: "🔢",
  timer: "⏲️",
  statistics: "📊",
};

const DEFAULT_CONFIG = {
  BACKUP_TASKS: [],
  INTERVAL: 30 * 60 * 1000, // 默认备份间隔30分钟
  IGNORED_DIRECTORIES: new Set([
    "node_modules",
    "dist",
    ".git",
    ".svn",
    ".idea",
    ".vscode",
    ".DS_Store",
    "miniprogram_npm",
  ]),
  IGNORE_PATTERNS: [
    "*.log",
    "*.tmp",
    "*.temp",
    ".git*",
    ".DS_Store",
    "Thumbs.db",
    "desktop.ini",
    ".env*",
    "*.bak",
    "*.swp",
    "*.swo",
  ],
  USE_HASH_COMPARISON: true,
  DRY_RUN: false,
};

/**
 * 文件操作工具类
 */
class FileUtils {
  /**
   * 计算文件哈希
   */
  static async calculateFileHash(filePath) {
    const fileBuffer = await fs.promises.readFile(filePath);
    const hashSum = crypto.createHash("sha256");
    hashSum.update(fileBuffer);
    return hashSum.digest("hex");
  }

  /**
   * 确保目录存在
   */
  static async ensureDirectory(dirPath) {
    try {
      await fs.promises.mkdir(dirPath, { recursive: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }

  /**
   * 删除目录及其内容
   */
  static async removeDirectory(dirPath) {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(dirPath, entry.name);
        entry.isDirectory()
          ? await this.removeDirectory(fullPath)
          : await fs.promises.unlink(fullPath);
      })
    );
    await fs.promises.rmdir(dirPath);
  }

  /**
   * 获取文件状态，包含哈希值(如果配置需要)
   */
  static async getFileStats(filePath, withHash = false) {
    const stats = await fs.promises.stat(filePath);
    if (!withHash || !stats.isFile()) return stats;

    const hash = await this.calculateFileHash(filePath);
    return { ...stats, hash };
  }

  /**
   * 复制文件
   */
  static async copyFile(source, target) {
    await fs.promises.copyFile(source, target);
  }
}
/**
 * 文件过滤器
 */
class FileFilter {
  /**
   * 检查文件是否应该被忽略
   */
  static shouldIgnore(fileName, ignoredDirectories, ignorePatterns) {
    if (ignoredDirectories.has(fileName)) return true;
    return ignorePatterns.some(
      (pattern) =>
        !pattern.startsWith("!") &&
        minimatch(fileName, pattern, { matchBase: true })
    );
  }
}

/**
 * 备份统计信息
 */
class BackupStats {
  constructor() {
    this.reset();
  }

  reset() {
    this.startTime = Date.now();
    this.filesCopied = 0;
    this.filesSkipped = 0;
    this.itemsIgnored = 0;
    this.itemsDeleted = 0;
    this.errors = 0;
    this.totalBytes = 0;
    this.savedBytes = 0;
  }

  /**
   * 打印统计摘要
   */
  printSummary() {
    const duration = Date.now() - this.startTime;
    const durationStr = this.formatDuration(duration);
    const savedSpaceStr = this.formatBytes(this.savedBytes);
    const transferred = this.formatBytes(this.totalBytes);
    const rate = this.formatBytes(this.totalBytes / (duration / 1000)) + "/s";
    console.log(
      chalk.green(
        `${ICONS.statistics} 备份统计摘要:
      ├─ ${ICONS.clock} 总耗时: ${durationStr}
      ├─ ${ICONS.network} 传输: ${transferred} (${rate})
      ├─ ${ICONS.file} 文件操作:
      │  ├─ ${ICONS.sync} 新增/更新: ${chalk.green(this.filesCopied)} 文件
      │  ├─ ${ICONS.success} 跳过: ${chalk.blue(this.filesSkipped)} 文件
      │  └─ ${ICONS.storage} 节省空间: ${chalk.blue(savedSpaceStr)}
      ├─ ${ICONS.info} 其他:
      │  ├─ ${ICONS.warning} 忽略: ${chalk.gray(this.itemsIgnored)} 项
      │  ├─ ${ICONS.clean} 清理: ${chalk.yellow(this.itemsDeleted)} 项
      │  └─ ${ICONS.error} 错误: ${chalk.red(this.errors)} 个
      └─ ${ICONS.clock} ${new Date().toLocaleString()}`
      )
    );
    console.log(
      chalk.cyan(
        `
${ICONS.complete} [${new Date().toLocaleString()}] 备份任务完成`
      )
    );
  }

  formatDuration(ms) {
    if (ms < 1000) return `${Math.round(ms)}毫秒`;
    if (ms < 60000) return `${(ms / 1000).toFixed(2)}秒`;
    const seconds = Math.floor((ms % 60000) / 1000);
    const minutes = Math.floor(ms / 60000);
    if (ms < 3600000) return `${minutes}分${seconds}秒`;
    const hours = Math.floor(ms / 3600000);
    const remainingMinutes = Math.floor((ms % 3600000) / 60000);
    return `${hours}小时${remainingMinutes}分${seconds}秒`;
  }

  formatBytes(bytes) {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }
}

/**
 * 增量备份状态管理器
 */
class BackupStateManager {
  constructor(stateFilePath) {
    this.stateFilePath = stateFilePath;
    this.state = {};
  }

  async loadState() {
    try {
      const data = await fs.promises.readFile(this.stateFilePath, "utf8");
      this.state = JSON.parse(data);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.state = {};
    }
  }

  async saveState() {
    await FileUtils.ensureDirectory(path.dirname(this.stateFilePath));
    await fs.promises.writeFile(
      this.stateFilePath,
      JSON.stringify(this.state, null, 2),
      "utf8"
    );
  }

  updateFileState(filePath, stats) {
    this.state[filePath] = {
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      hash: stats.hash,
    };
  }

  getFileState(filePath) {
    return this.state[filePath];
  }
}
/**
 * 备份管理器
 */
class BackupManager {
  constructor(config = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      IGNORED_DIRECTORIES: new Set([
        ...DEFAULT_CONFIG.IGNORED_DIRECTORIES,
        ...(config.IGNORED_DIRECTORIES || []),
      ]),
      BACKUP_TASKS: [
        ...DEFAULT_CONFIG.BACKUP_TASKS,
        ...(config.BACKUP_TASKS || []),
      ],
    };
    this.stats = new BackupStats();
    this.backupState = new BackupStateManager("./backup-state.json");
  }

  /**
   * 执行所有备份任务
   */
  async execute() {
    await this.backupState.loadState();
    this.stats.reset();
    console.log(
      chalk.cyan(
        `\n${ICONS.start} [${new Date().toLocaleString()}] 开始执行备份任务`
      )
    );

    try {
      await Promise.all(
        this.config.BACKUP_TASKS.map((task) => this.executeBackupTask(task))
      );
    } finally {
      await this.backupState.saveState();
      this.stats.printSummary();
    }
  }
  /**
   * 执行单个备份任务
   */
  async executeBackupTask(task) {
    const { source, backup } = task;
    console.log(chalk.cyan(`${ICONS.backup} 处理任务: ${source} → ${backup}`));
    try {
      await this.processDirectory(source, backup);
    } catch (error) {
      console.error(
        chalk.red(`${ICONS.error} 任务失败: ${source} → ${backup}`),
        error
      );
      this.stats.errors++;
    }
  }

  /**
   * 处理目录备份
   */
  async processDirectory(sourceDir, backupDir) {
    if (!this.config.DRY_RUN) {
      await FileUtils.ensureDirectory(backupDir);
    }

    const [sourceEntries, backupEntries] = await Promise.all([
      this.readDirectory(sourceDir),
      this.readDirectory(backupDir).catch(() => []),
    ]);

    await this.cleanBackupDirectory(sourceDir, backupDir, backupEntries);
    await this.processSourceDirectory(sourceDir, backupDir, sourceEntries);
  }

  async readDirectory(dirPath) {
    try {
      const entries = await fs.promises.readdir(dirPath, {
        withFileTypes: true,
      });
      return entries;
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async cleanBackupDirectory(sourceDir, backupDir, backupEntries) {
    await Promise.all(
      backupEntries.map(async (entry) => {
        const sourcePath = path.join(sourceDir, entry.name);
        try {
          await fs.promises.stat(sourcePath);
        } catch (error) {
          if (error.code === "ENOENT") {
            const backupPath = path.join(backupDir, entry.name);
            if (!this.config.DRY_RUN) {
              entry.isDirectory()
                ? await fs.promises.rm(backupPath, { recursive: true }) // 使用 fs.promises.rm 替代 removeDirectory
                : await fs.promises.unlink(backupPath);
            }
            this.stats.itemsDeleted++;
          }
        }
      })
    );
  }

  async processSourceDirectory(sourceDir, backupDir, sourceEntries) {
    await Promise.all(
      sourceEntries.map(async (entry) => {
        const sourcePath = path.join(sourceDir, entry.name);
        const backupPath = path.join(backupDir, entry.name);
        if (
          FileFilter.shouldIgnore(
            entry.name,
            this.config.IGNORED_DIRECTORIES,
            this.config.IGNORE_PATTERNS
          )
        ) {
          this.stats.itemsIgnored++;
          return;
        }
        if (entry.isDirectory()) {
          await this.processDirectory(sourcePath, backupPath);
        } else {
          await this.processFile(sourcePath, backupPath);
        }
      })
    );
  }
  async processFile(sourcePath, backupPath) {
    try {
      const sourceStats = await FileUtils.getFileStats(
        sourcePath,
        false // 先不计算哈希值
      );
      let backupStats;
      try {
        backupStats = await FileUtils.getFileStats(
          backupPath,
          false // 先不计算哈希值
        );
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }

      // 判断是否需要备份
      const shouldBackup = this.shouldBackupFile(sourceStats, backupStats);
      if (shouldBackup) {
        // 如果需要备份，再计算哈希值
        if (this.config.USE_HASH_COMPARISON) {
          sourceStats.hash = await FileUtils.calculateFileHash(sourcePath);
          if (backupStats) {
            backupStats.hash = await FileUtils.calculateFileHash(backupPath);
          }
        }

        if (!this.config.DRY_RUN) {
          await FileUtils.copyFile(sourcePath, backupPath);
          console.log(
            chalk.green(`${ICONS.sync} 更新: ${path.basename(sourcePath)}`)
          );
        }
        this.stats.filesCopied++;
        this.stats.totalBytes += sourceStats.size;
        this.backupState.updateFileState(sourcePath, sourceStats);
      } else {
        this.stats.filesSkipped++;
        if (backupStats) {
          this.stats.savedBytes += sourceStats.size;
        }
      }
    } catch (error) {
      console.error(
        chalk.red(`${ICONS.error} 处理文件失败: ${path.basename(sourcePath)}`),
        error
      );
      this.stats.errors++;
    }
  }
  shouldBackupFile(sourceStats, backupStats) {
    if (!backupStats) return true;
    if (sourceStats.size !== backupStats.size) return true;
    if (sourceStats.mtimeMs !== backupStats.mtimeMs) {
      if (
        this.config.USE_HASH_COMPARISON &&
        sourceStats.hash &&
        backupStats.hash
      ) {
        return sourceStats.hash !== backupStats.hash;
      }
      return true;
    }
    return false;
  }

  /**
   * 启动定时备份
   */
  startScheduledBackups() {
    if (this.config.INTERVAL <= 0) return;
    console.log(
      chalk.cyan(
        `${ICONS.timer} 设置定时备份，间隔: ${new BackupStats().formatDuration(
          this.config.INTERVAL
        )}`
      )
    );
    this.scheduleInterval = setInterval(() => {
      this.execute().catch(console.error);
    }, this.config.INTERVAL);
    if (this.scheduleInterval.unref) {
      this.scheduleInterval.unref();
    }
  }
}

/**
 * 主函数
 */
async function main() {
  try {
    const config = {
      BACKUP_TASKS: [
        { source: "D:\\projectCode", backup: "E:\\公司项目代码" },
        { source: "D:\\测试项目", backup: "E:\\个人代码" },
      ],
      INTERVAL: 30 * 60 * 1000,
      DRY_RUN: false,
      USE_HASH_COMPARISON: true,
    };
    console.log(chalk.yellow(`${ICONS.config} 使用配置:`));
    console.log(config);

    const backupManager = new BackupManager(config);
    await backupManager.execute();
    backupManager.startScheduledBackups();

    process.on("SIGINT", () => {
      console.log(
        chalk.yellow(`\n${ICONS.warning} 接收到终止信号，停止备份...`)
      );
      if (backupManager.scheduleInterval) {
        clearInterval(backupManager.scheduleInterval);
      }
      process.exit(0);
    });
  } catch (error) {
    console.error(chalk.red(`${ICONS.error} 应用程序启动失败:`), error);
    process.exit(1);
  }
}

main().catch(console.error);
