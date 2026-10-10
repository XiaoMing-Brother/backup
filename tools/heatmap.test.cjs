const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../app/renderer/app.js'), 'utf8');
const context = vm.createContext({});
vm.runInContext(source.slice(source.indexOf('function localDateKey('), source.indexOf('function renderStats(')), context);
const build = context.buildBackupHeatmap;
const today = new Date(2026, 9, 10, 12);
const record = (date, totalBytes = 0, success = true, filesCopied = 0) => ({ finishedAt: date.getTime(), totalBytes, success, filesCopied });

test('365 个连续本地日期，周一在第一行，范围外记录不计入', () => {
  const model = build([
    record(new Date(2025, 9, 10, 23, 59), 10),
    record(new Date(2025, 9, 11), 20),
    record(new Date(2026, 9, 10, 23, 59), 30),
    record(new Date(2026, 9, 11), 40),
    { finishedAt: 'invalid', totalBytes: 100 },
    { totalBytes: 100 },
  ], today);
  assert.equal(model.days.length, 365);
  assert.equal(model.days[0].date, '2025-10-11');
  assert.equal(model.days.at(-1).date, '2026-10-10');
  assert.equal(model.days[0].row, 5);
  assert.equal(model.days[2].row, 0);
  assert.equal(model.days[2].column, 1);
  assert.equal(model.days.reduce((sum, day) => sum + day.count, 0), 2);
  assert.equal(model.days.reduce((sum, day) => sum + day.totalBytes, 0), 50);
});

test('同日记录合并传输量、文件数和失败次数，兼容历史缺省字段', () => {
  const day = build([
    record(new Date(2026, 9, 10, 0, 1), 100, true, 2),
    record(new Date(2026, 9, 10, 23, 59), 300, false, 3),
    { finishedAt: today.getTime(), success: true },
  ], today).days.at(-1);
  assert.equal(day.count, 3);
  assert.equal(day.failures, 1);
  assert.equal(day.totalBytes, 400);
  assert.equal(day.filesCopied, 5);
  assert.equal(day.level, 4);
});

test('零传输备份仍计数，无记录日期和空历史稳定显示', () => {
  const model = build([record(today)], today);
  assert.equal(model.maxBytes, 0);
  assert.equal(model.days.at(-1).count, 1);
  assert.equal(model.days.at(-1).level, 0);
  assert.equal(model.days[0].count, 0);
  const empty = build([], today);
  assert.equal(empty.days.length, 365);
  assert.ok(empty.days.every(day => day.level === 0 && day.count === 0));
});

test('按当天总传输量分成四档，少量传输不会变成无记录', () => {
  const history = [1, 100, 101, 200, 201, 300, 301, 400].map((bytes, i) => record(new Date(2026, 9, 3 + i), bytes));
  const days = build(history, today).days.slice(-8);
  assert.equal(JSON.stringify(days.map(day => day.level)), '[1,1,2,2,3,3,4,4]');
});

test('闰年包含 2 月 29 日，月首位置按日期计算', () => {
  const model = build([], new Date(2024, 2, 1, 12));
  assert.equal(model.days.at(-2).date, '2024-02-29');
  assert.equal(model.days.at(-1).date, '2024-03-01');
  assert.equal(model.days.at(-1).monthStart, true);
  assert.equal(new Set(model.days.map(day => day.date)).size, 365);
});

test('上海和纽约按本地午夜分组，跨夏令时保持连续日期', () => {
  const previous = process.env.TZ;
  try {
    for (const timezone of ['Asia/Shanghai', 'America/New_York']) {
      process.env.TZ = timezone;
      const end = new Date(2026, 2, 10, 12);
      const model = build([
        record(new Date(2026, 2, 7, 23, 59), 10),
        record(new Date(2026, 2, 8, 0, 1), 20),
      ], end);
      assert.equal(model.days.length, 365, timezone);
      assert.equal(new Set(model.days.map(day => day.date)).size, 365, timezone);
      assert.equal(model.days.find(day => day.date === '2026-03-07').totalBytes, 10, timezone);
      assert.equal(model.days.find(day => day.date === '2026-03-08').totalBytes, 20, timezone);
    }
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
