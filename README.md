echo "# 增量备份工具

## 简介

这是一个基于 Node.js 的增量备份工具，它可以定时备份指定目录，并通过哈希比较来判断文件是否需要更新，从而实现增量备份，节省存储空间和备份时间。

## 功能特性

- **定时备份**：支持设置备份间隔时间，实现定时自动备份。
- **增量备份**：通过文件哈希比较，仅备份有变化的文件，节省存储空间。
- **忽略规则**：可以配置忽略的目录和文件模式，避免备份不必要的文件。
- **统计信息**：备份完成后输出详细的统计信息，包括备份时间、传输量、跳过的文件等。

## 安装

确保你已经安装了 Node.js 和 npm。然后克隆这个仓库并安装依赖：

```bash
git clone <repository-url>
cd <repository-directory>
npm install
```

在代码中可以修改 main 函数中的 config 对象来配置备份任务：

```javascript
const config = {
  BACKUP_TASKS: [
    { source: \"D:\\projectCode\", backup: \"E:\\公司项目代码\" },
    { source: \"D:\\测试项目\", backup: \"E:\\个人代码\" },
  ],
  INTERVAL: 30 * 60 * 1000, // 备份间隔时间，单位为毫秒
  DRY_RUN: false, // 是否进行干运行，不实际执行备份操作
  USE_HASH_COMPARISON: true, // 是否使用哈希比较来判断文件是否需要更新
};
```

## 配置项说明

- **BACKUP_TASKS**：备份任务列表，每个任务包含两个属性：`source` 和 `backup`。`source` 是需要备份的源目录，`backup` 是备份到的文件夹。
- **INTERVAL**：备份间隔时间，单位为毫秒。
- **DRY_RUN**：是否进行干运行，不实际执行备份操作。
- **USE_HASH_COMPARISON**：是否使用哈希比较来判断文件是否需要更新。

## 运行

```bash
node d:/测试项目/backup/qwen.js
```

## 注意事项

- 请不要备份包含重要数据的目录，如系统目录、用户目录等。
- 请不要备份包含大量文件的目录，如 node_modules 目录。
