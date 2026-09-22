/* 渲染层逻辑 */
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const S = {
  config: null,
  status: { running: false, schedulerRunning: false, nextRunAt: null, lastResult: null },
  logs: [],
  history: [],
  liveStats: null,
  backupProgress: null,
  editingIndex: -1,
  appInfo: null,
};
const LOG_LIMIT = 800;
const logTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});
let pendingLogCount = 0;
let logRenderTimer = null;
let windowVisible = true;
let resultFeedback = null;
let resultFeedbackTimer = null;
let progressResetTimer = null;
let quarkLoginStage = "idle";
let quarkLoginMessage = "";
let taskQuarkSaving = false;

function isViewVisible(name) {
  return windowVisible && !document.hidden && $(`#view-${name}`).classList.contains("active");
}

/* ---------- 工具 ---------- */
function fmtBytes(bytes) {
  if (!bytes && bytes !== 0) return "-";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return (bytes / 1024 ** i).toFixed(2) + " " + units[i];
}
function fmtDuration(ms) {
  if (ms == null) return "-";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} 秒`;
  const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
  return `${m} 分 ${s} 秒`;
}
function fmtTime(ts) {
  return ts ? new Date(ts).toLocaleString("zh-CN", { hour12: false }) : "暂无记录";
}
function esc(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* ---------- 视图切换 ---------- */
function bindNav() {
  $$(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });
  $$("[data-goto]").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.goto));
  });
}
function switchView(name) {
  document.body.dataset.view = name;
  // 切换视图回到顶部，避免沿用上一页的滚动位置
  $("#main").scrollTop = 0;
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  if (name === "logs") flushLogs(true);
  if (name === "dashboard") { renderResult(); renderBackupProgress(); }
  const meta = {
    dashboard: ["备份概览", "查看备份状态与最近的文件变化。"],
    tasks: ["备份任务", "管理本地备份目录，直接选择哪些任务上传到夸克。"],
    logs: ["运行日志", "查看每一次备份的处理过程与异常信息。"],
    stats: ["备份统计", "查看历史记录和传输量。"],
    settings: ["设置", "配置备份计划、夸克连接与应用行为；开关修改后自动保存。"],
    about: ["关于", "查看版本信息、升级日志与项目仓库。"],
  }[name];
  if (meta) { $("#page-title").textContent = meta[0]; $("#page-description").textContent = meta[1]; }
  $$(".nav-item").forEach((b) => b.setAttribute("aria-current", b.dataset.view === name ? "page" : "false"));
  updateCountdownTimer();
}

/* ---------- 渲染 ---------- */
function renderStatus() {
  const st = S.status;
  const chip = $("#tb-status");
  const text = $("#status-text"), sub = $("#status-sub");
  sub.title = "";
  const statusCard = document.querySelector(".status-card");
  statusCard.dataset.motion = resultFeedback === "stopped" ? "error" : resultFeedback || (st.running ? "running" : st.schedulerRunning ? "waiting" : "idle");
  chip.className = "chip " + (st.running ? "running" : st.schedulerRunning ? "ok" : "idle");
  chip.textContent = st.running ? "备份中" : st.schedulerRunning ? "定时运行中" : "定时已停止";

  if (resultFeedback) {
    text.textContent = resultFeedback === "success" ? "备份已完成" : resultFeedback === "stopped" ? "备份已停止" : "本次备份失败";
    sub.textContent = resultFeedback === "success" ? "本次结果已更新，可在下方查看详情" : resultFeedback === "stopped" ? "已完成的文件会保留，可继续上次任务" : "部分操作未完成，请打开“运行日志”查看原因";
  } else if (st.running) {
    text.textContent = st.paused ? "备份已暂停" : st.pauseRequested ? "正在暂停…" : "正在备份…";
    sub.textContent = st.paused ? "已在安全检查点暂停，可继续或停止本次任务" : st.pauseRequested ? "正在完成当前文件后暂停" : `正在处理 ${st.taskCount ?? S.config.tasks.length} 个任务`;
  } else {
    text.textContent = st.schedulerRunning ? "等待下次备份" : "随时可以备份";
    sub.textContent = st.schedulerRunning ? `计划：${scheduleText(S.config)}` : "可立即备份全部任务，或启动定时备份";
  }

  $("#btn-run-now").disabled = st.running;
  const selectedQuarkTasks = S.config.tasks.filter((task) => task.quarkEnabled).length;
  const quarkReady = !!S.config.quarkEnabled && !!S.status.quarkLoggedIn && !S.config.dryRun && selectedQuarkTasks > 0;
  $("#btn-upload-quark").disabled = st.running || !quarkReady;
  $("#btn-upload-quark").textContent = st.running ? "上传中…" : "上传夸克";
  $("#btn-upload-quark").title = st.running ? "当前任务完成后可上传" : !S.config.quarkEnabled ? "请先在设置中开启夸克同步" : !S.status.quarkLoggedIn ? "请先在设置中登录并连接夸克" : S.config.dryRun ? "演练模式下不会上传" : !selectedQuarkTasks ? "请先选择至少一个“备份到夸克”任务" : "上传已选择的任务到夸克";
  $$("#task-list [data-task-quark]").forEach(el => { el.disabled = st.running || taskQuarkSaving; });
  $("#btn-run-now").textContent = st.running ? "备份中…" : "立即备份";
  $("#btn-run-now").classList.toggle("busy", !!st.running);
  $("#btn-scheduler").textContent = st.schedulerRunning ? "停止定时" : "启动定时";
  $("#btn-pause-backup").hidden = !st.running || !!st.pauseRequested;
  $("#btn-resume-backup").hidden = !st.running || !st.pauseRequested;
  $("#btn-stop-backup").hidden = !st.running;
  $("#btn-resume-last").hidden = st.running || !st.recovery;
  $("#btn-pause-backup").disabled = !!st.pauseRequested;

  // 倒计时
  const countdownCard = $(".countdown-card");
  const scheduleState = $("#schedule-state");
  const scheduleMetaValue = $("#schedule-meta-value");
  if (st.running) {
    $("#countdown").textContent = "进行中";
    $("#countdown-sub").textContent = "备份完成后重新计时";
    countdownCard.dataset.state = "running";
    scheduleState.textContent = "正在备份";
    scheduleMetaValue.textContent = "完成后续排";
  } else if (st.schedulerRunning && st.nextRunAt) {
    $("#countdown").textContent = fmtCountdown(st.nextRunAt - Date.now());
    $("#countdown-sub").textContent = scheduleText(S.config);
    countdownCard.dataset.state = "scheduled";
    scheduleState.textContent = "已安排";
    scheduleMetaValue.textContent = scheduleText(S.config);
  } else {
    $("#countdown").textContent = "--:--";
    $("#countdown-sub").textContent = "定时未启用";
    countdownCard.dataset.state = "idle";
    scheduleState.textContent = "未启用";
    scheduleMetaValue.textContent = "等待开启";
  }

  renderResult();
  renderBackupProgress();
  renderDashTasks();
  updateCountdownTimer();
}

function renderBackupProgress() {
  const detail = $("#backup-detail");
  detail.hidden = !S.status.running && !resultFeedback;
  if (detail.hidden) return;
  const p = S.backupProgress || {};
  const cloud = p.phase === "quark";
  const total = Math.max(0, p.tasksTotal || 0);
  const done = resultFeedback === "success" ? total : Math.min(total, Math.max(0, p.tasksDone || 0));
  const stages = { preparing: "准备备份", scanning: "扫描文件夹", comparing: "比较文件", hashing: "校验文件内容", copying: "复制文件", cleaning: "清理本地过期项", processed: "处理文件", "task-finished": "切换任务", saving: "保存备份记录", packing: "打包 ZIP 压缩包", uploading: "上传到夸克" };
  const stage = stages[p.stage] || "准备备份";
  const path = p.currentPath || p.taskSource || "";
  const taskName = String(p.taskSource || "").split(/[\\/]/).filter(Boolean).pop();
  const name = path.split(/[\\/]/).filter(Boolean).pop() || "正在准备文件列表…";
  if (S.status.running && !resultFeedback) {
    $("#status-text").textContent = cloud ? (p.stage === "packing" ? "正在打包 ZIP 压缩包…" : "正在上传到夸克…") : S.config.dryRun ? "正在演练备份…" : "正在备份…";
    $("#status-sub").textContent = taskName ? `任务 ${p.taskIndex || 1} / ${total} · ${taskName}` : total ? `本次备份 ${total} 个任务` : "正在准备备份…";
    $("#status-sub").title = p.taskSource || "";
  }
  $("#backup-stage").textContent = resultFeedback ? (resultFeedback === "success" ? "本次备份已完成" : resultFeedback === "stopped" ? "本次备份已停止" : "本次备份有错误，请查看运行日志") : `${cloud ? "夸克同步" : S.config.dryRun ? "本地演练" : "本地备份"} · ${stage}`;
  $("#backup-task-count").textContent = total ? `已处理 ${done} / ${total} 个任务` : "";
  $("#backup-current-name").textContent = name;
  $("#backup-current-name").title = path;
  $("#backup-current-path").textContent = path;
  $("#backup-current-path").title = path;
  const meter = $("#backup-meter");
  const percent = resultFeedback === "success" ? 100 : total ? Math.floor(done / total * 100) : 0;
  $("#backup-meter-fill").style.width = `${percent}%`;
  meter.dataset.active = String(S.status.running && !resultFeedback);
  if (total || resultFeedback === "success") meter.setAttribute("aria-valuenow", String(percent));
  else meter.removeAttribute("aria-valuenow");
  meter.setAttribute("aria-valuetext", resultFeedback ? $("#backup-stage").textContent : `${cloud ? "夸克同步" : "本地备份"}，已处理 ${done} / ${total} 个任务，${stage}`);
  // 夸克同步先扫清单再压缩，filesProcessed 是清单条目数，总数已知时一并显示。
  const filesTotal = Math.max(0, p.filesTotal || 0);
  const progressCaption = cloud
    ? `已扫描 ${p.filesProcessed || 0}${filesTotal ? ` / ${filesTotal}` : ""} 个文件 · 进度按任务数计算`
    : `已处理 ${p.filesProcessed || 0} 个文件（含未变化文件） · 进度按任务数计算`;
  $("#backup-progress-caption").textContent = resultFeedback ? (resultFeedback === "success" ? "全部处理完成" : resultFeedback === "stopped" ? "已完成的操作已保留，可继续上次任务" : "已完成的操作已保留，可在日志中查看失败项目") : progressCaption;
}

function renderResult() {
  const r = S.status.lastResult;
  $("#last-time").textContent = r ? `完成于 ${fmtTime(r.finishedAt)} · 耗时 ${fmtDuration(r.durationMs)}` : "暂无记录";
  const live = S.liveStats;
  const d = live || r || {};
  $("#st-copied").textContent = d.filesCopied ?? "-";
  $("#st-copied").className = "stat-num green";
  $("#st-skipped").textContent = d.filesSkipped ?? "-";
  $("#st-saved").textContent = d.savedBytes != null ? fmtBytes(d.savedBytes) : "-";
  $("#st-transferred").textContent = d.totalBytes != null ? fmtBytes(d.totalBytes) : "-";
  $("#st-deleted").textContent = d.itemsDeleted ?? "-";
  $("#st-errors").textContent = d.errors ?? "-";
  $("#st-errors").className = "stat-num" + (d.errors ? " red" : "");
}

function taskRow(t, idx, compact) {
  const div = document.createElement("div");
  div.className = "task-item";
  const taskName = String(t.source || "备份任务").split(/[\\/]/).filter(Boolean).pop() || "备份任务";
  div.innerHTML = `
    <div class="ti-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg></div>
    <div class="ti-body">
      <div class="ti-name">${esc(taskName)} <span class="task-sync-label">${!t.quarkEnabled ? "仅本地备份" : !S.config.quarkEnabled ? "夸克：待开启总开关" : !S.status.quarkLoggedIn ? "夸克：待登录" : S.config.dryRun ? "夸克：演练时不上传" : "夸克：已就绪"}</span></div>
      <div class="ti-paths">
        <span class="path-group"><span class="path-label">源目录</span><button class="ti-path" data-open="${esc(t.source)}" title="点击打开目录">${esc(t.source)}</button></span>
        <span class="arrow">→</span>
        <span class="path-group"><span class="path-label">备份到</span><button class="ti-path" data-open="${esc(t.backup)}" title="点击打开目录">${esc(t.backup)}</button></span>
      </div>
    </div>`;
  if (!compact) {
    const actions = document.createElement("div");
    actions.className = "row-gap task-actions";
    actions.innerHTML = `
      <label class="switch-row task-quark-switch"><input type="checkbox" role="switch" data-task-quark /><span>备份到夸克</span></label>
      <button class="btn small" data-act="run" data-i="${idx}">备份</button>
      <button class="btn small" data-act="edit" data-i="${idx}">编辑</button>
      <button class="btn small" data-act="del" data-i="${idx}">删除</button>`;
    const quarkSwitch = actions.querySelector("[data-task-quark]");
    quarkSwitch.checked = !!t.quarkEnabled;
    quarkSwitch.disabled = S.status.running || taskQuarkSaving;
    quarkSwitch.setAttribute("aria-label", `${taskName}：备份到夸克`);
    quarkSwitch.title = S.status.running ? "当前任务完成后可修改" : !S.config.quarkEnabled ? "可先选择任务，再到设置中开启夸克同步总开关" : !S.status.quarkLoggedIn ? "选择会自动保存；上传前请到设置中登录并连接夸克" : "自动保存；点击“上传夸克”时上传此任务";
    quarkSwitch.addEventListener("change", async () => {
      const tasks = S.config.tasks.map((task, i) => i === idx ? { ...task, quarkEnabled: quarkSwitch.checked } : { ...task });
      taskQuarkSaving = true;
      $$("#task-list [data-task-quark]").forEach(el => { el.disabled = true; });
      try {
        await window.backupAPI.saveConfig({ tasks });
        showSavedToast();
      } catch (error) {
        alert(String(error.message || error));
      } finally {
        taskQuarkSaving = false;
        renderTasks();
      }
    });
    div.appendChild(actions);
  }
  div.querySelectorAll("[data-open]").forEach((el) =>
    el.addEventListener("click", () => window.backupAPI.openPath(el.dataset.open))
  );
  return div;
}

function renderDashTasks() {
  const box = $("#dash-tasks");
  box.innerHTML = "";
  S.config.tasks.forEach((t, i) => box.appendChild(taskRow(t, i, true)));
  if (!S.config.tasks.length) box.innerHTML = '<div class="empty-state"><strong>还没有备份任务</strong><p>添加源目录和目标目录即可开始。</p><button class="btn primary small" data-goto="tasks">添加备份任务</button></div>';
  box.querySelector("[data-goto]")?.addEventListener("click", () => switchView("tasks"));
}

function renderTasks() {
  const box = $("#task-list");
  box.innerHTML = "";
  S.config.tasks.forEach((t, i) => {
    const row = taskRow(t, i, false);
    row.querySelectorAll("[data-act]").forEach((btn) =>
      btn.addEventListener("click", () => onTaskAction(btn.dataset.act, +btn.dataset.i))
    );
    box.appendChild(row);
  });
  if (!S.config.tasks.length) box.innerHTML = '<div class="empty-state"><strong>暂无备份任务</strong><p>添加源目录和目标目录后，就可以开始第一次备份。</p><button class="btn primary small" id="empty-add-task">添加备份任务</button></div>';
  box.querySelector("#empty-add-task")?.addEventListener("click", () => openModal(-1));
  $("#task-count").textContent = S.config.tasks.length;
}

function renderLogs() {
  const panel = $("#log-panel");
  panel.replaceChildren();
  pendingLogCount = S.logs.length;
  flushLogs(true);
}
function logLine(l) {
  const div = document.createElement("div");
  div.className = `log-line ${l.level}`;
  const t = logTimeFormatter.format(l.time);
  div.innerHTML = `<span class="lt">[${t}]</span>${esc(l.text)}`;
  return div;
}
function flushLogs(force = false) {
  clearTimeout(logRenderTimer);
  logRenderTimer = null;
  if (!isViewVisible("logs")) return;
  const panel = $("#log-panel");
  const nearBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 60;
  if (pendingLogCount) {
    const fragment = document.createDocumentFragment();
    S.logs.slice(-pendingLogCount).forEach((l) => fragment.appendChild(logLine(l)));
    while (panel.firstElementChild && panel.childElementCount + fragment.childElementCount > LOG_LIMIT) {
      panel.firstElementChild.remove();
    }
    panel.appendChild(fragment);
    pendingLogCount = 0;
  }
  if (nearBottom || force) panel.scrollTop = panel.scrollHeight;
}

/* ---------- 统计 ---------- */
function shortTime(ts) {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}/${dd} ${hh}:${mi}`;
}

function renderStats() {
  const h = S.history || [];
  const ok = h.filter((r) => r.success);
  const sum = (k) => h.reduce((a, r) => a + (r[k] || 0), 0);

  $("#sum-count").textContent = h.length ? h.length : "-";
  $("#sum-copied").textContent = h.length ? sum("filesCopied") : "-";
  $("#sum-transferred").textContent = h.length ? fmtBytes(sum("totalBytes")) : "-";
  $("#sum-saved").textContent = h.length ? fmtBytes(sum("savedBytes")) : "-";
  const avgMs = ok.length ? ok.reduce((a, r) => a + (r.durationMs || 0), 0) / ok.length : 0;
  $("#sum-avg-duration").textContent = ok.length ? fmtDuration(avgMs) : "-";
  const rate = h.length ? Math.round((ok.length / h.length) * 100) + "%" : "-";
  $("#sum-success-rate").textContent = rate;
  $("#sum-success-rate").className = "stat-num" + (h.length && ok.length < h.length ? " red" : "");

  renderTrend();
  renderHistoryTable();
}

function renderTrend() {
  const box = $("#stats-trend");
  const h = S.history || [];
  const recent = h.slice(-20);
  if (!recent.length) {
    box.innerHTML = '<div class="trend-empty">暂无备份记录，运行一次备份后这里会显示传输量趋势。</div>';
    return;
  }
  const maxBytes = Math.max(1, ...recent.map((r) => r.totalBytes || 0));
  box.innerHTML = "";
  recent.forEach((r) => {
    const col = document.createElement("div");
    col.className = "trend-col" + (r.success ? "" : " fail");
    const pct = Math.max(2, ((r.totalBytes || 0) / maxBytes) * 100);
    col.innerHTML = `
      <div class="trend-bar" style="height:${pct.toFixed(1)}%" title="${fmtTime(r.finishedAt)} · 传输 ${fmtBytes(r.totalBytes)}"></div>
      <div class="trend-val">${fmtBytes(r.totalBytes)}</div>
      <div class="trend-x">${shortTime(r.finishedAt)}</div>`;
    box.appendChild(col);
  });
  scheduleDrawTrendLine(box, recent);
}

/* 折线依赖柱子的真实布局尺寸，而视图切换动画（view-enter 的 translateY）
   会让 clientHeight 在动画期间抖动 —— 这里用小间隔轮询等布局稳定，
   并保证只有最后一次请求生效，避免快速重渲染时多个 rAF 互相覆盖。 */
let trendLineTimer = 0;
let trendLineToken = 0;

function scheduleDrawTrendLine(box, recent) {
  clearTimeout(trendLineTimer);
  trendLineTimer = setTimeout(() => {
    const token = ++trendLineToken;
    let tries = 0;
    let lastW = -1;
    let lastH = -1;
    const tick = () => {
      if (token !== trendLineToken) return;
      const w = box.scrollWidth;
      const h = box.clientHeight;
      const stable = w === lastW && h === lastH;
      lastW = w;
      lastH = h;
      if ((stable && w > 0 && h > 0) || ++tries > 12) {
        drawTrendLine(box, recent);
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, 320);
}

function drawTrendLine(container, recent) {
  const cols = container.querySelectorAll(".trend-col");
  if (cols.length < 2) return;
  let svg = container.querySelector(".trend-line-svg");
  if (!svg) {
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("trend-line-svg");
    container.appendChild(svg);
  }
  // 先清掉上一轮的固定尺寸，否则改窗口大小后内联样式会盖住新测量值，
  // 重绘等于没发生（宽度、viewBox 全部锁死在旧值上）。
  svg.removeAttribute("viewBox");
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.style.cssText = "position:absolute;top:0;left:0;pointer-events:none;z-index:1;";
  const cs = getComputedStyle(container);
  const padTop = parseFloat(cs.paddingTop) || 16;
  const totalH = container.clientHeight;
  const totalW = container.scrollWidth;
  const chartBottom = totalH - 48;
  const lineColor = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#2e8b57";

  const points = [];
  cols.forEach((col, i) => {
    const bar = col.querySelector(".trend-bar");
    if (!bar) return;
    const barH = bar.offsetHeight;
    const x = col.offsetLeft + col.offsetWidth / 2;
    const y = chartBottom - padTop - barH;
    const val = (recent[i] && recent[i].totalBytes) || 0;
    if (val > 0) points.push({ x, y, val, success: recent[i].success !== false, index: i });
  });
  if (points.length < 2) return;

  const smoothPath = smoothLine(points);
  const areaPath = smoothPath + ` L${points[points.length - 1].x},${chartBottom} L${points[0].x},${chartBottom} Z`;
  // 圆点要给填充色留出可见面积：白描边必须比半径细得多，
  // 否则 3px 圆 + 1.5px 描边只剩一圈白环，看不出成功/失败配色。
  const dotRadius = 3.6;

  svg.setAttribute("viewBox", `0 0 ${totalW} ${totalH}`);
  svg.setAttribute("width", totalW);
  svg.setAttribute("height", totalH);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.style.cssText = `position:absolute;top:0;left:0;pointer-events:none;z-index:1;width:${totalW}px;min-width:${totalW}px;height:${totalH}px;`;

  let dots = "";
  points.forEach((p) => {
    const color = p.success ? lineColor : "#cb6770";
    const title = recent[p.index] ? `${fmtTime(recent[p.index].finishedAt)} · ${fmtBytes(recent[p.index].totalBytes)}` : "";
    dots += `<circle cx="${p.x}" cy="${p.y}" r="${dotRadius}" fill="${color}"><title>${title}</title></circle>`;
  });

  svg.innerHTML = `
    <defs>
      <linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${lineColor}" stop-opacity="0.18"/>
        <stop offset="100%" stop-color="${lineColor}" stop-opacity="0.02"/>
      </linearGradient>
      <filter id="trend-shadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="1" stdDeviation="2" flood-color="${lineColor}" flood-opacity="0.25"/>
      </filter>
    </defs>
    <path d="${areaPath}" fill="url(#trend-fill)"/>
    <path d="${smoothPath}" fill="none" stroke="${lineColor}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" filter="url(#trend-shadow)"/>
    ${dots}
  `;

  // 尺寸是写死的内联值，窗口变化必须重算；只绑一次，避免 renderTrend 反复叠加监听。
  if (!container.dataset.trendResizeBound) {
    container.dataset.trendResizeBound = "1";
    let resizeTimer = 0;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const h = S.history || [];
        if (h.length) drawTrendLine(container, h.slice(-20));
      }, 150);
    });
  }
}

function smoothLine(points) {
  if (points.length < 2) return "";
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const n = points.length;
  let d = `M${xs[0]},${ys[0]}`;
  for (let i = 0; i < n - 1; i++) {
    const x0 = xs[i], y0 = ys[i];
    const x1 = xs[i + 1], y1 = ys[i + 1];
    const dx = x1 - x0;
    const cp1x = x0 + dx * 0.4;
    const cp2x = x1 - dx * 0.4;
    d += ` C${cp1x},${y0} ${cp2x},${y1} ${x1},${y1}`;
  }
  return d;
}

function renderHistoryTable() {
  const tb = $("#stats-tbody");
  const h = S.history || [];
  $("#stats-total").textContent = h.length ? `共 ${h.length} 条记录` : "";
  tb.innerHTML = "";
  [...h].sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0)).forEach((r) => {
    const tr = document.createElement("tr");
    const trigger = r.trigger === "scheduled" ? '<span class="badge scheduled">定时</span>' : '<span class="badge manual">手动</span>';
    const status = r.success ? '<span class="badge ok">成功</span>' : '<span class="badge fail">失败</span>';
    const errCell = r.success ? "" : `<span class="col-err"> ${esc(r.error || "未知错误")}</span>`;
    tr.innerHTML = `
      <td>${fmtTime(r.finishedAt)}</td>
      <td>${trigger}</td>
      <td>${r.filesCopied ?? 0}</td>
      <td>${r.filesSkipped ?? 0}</td>
      <td>${fmtBytes(r.totalBytes)}</td>
      <td>${fmtBytes(r.savedBytes)}</td>
      <td>${fmtDuration(r.durationMs)}</td>
      <td>${status}${errCell}</td>`;
    tb.appendChild(tr);
  });
}

const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function scheduleText(cfg) {
  const mode = cfg.scheduleMode || "interval";
  if (mode === "daily") {
    const t = (cfg.dailyTimes || []).filter(Boolean).slice().sort();
    return t.length ? `每天 ${t.join(" / ")}` : "每天（未设置时刻）";
  }
  if (mode === "weekly") {
    const d = (cfg.weeklyDays || []).map(Number).sort();
    return `每周 ${d.map((x) => WEEK[x]).join("、") || "未选择"} ${cfg.weeklyTime || "09:00"}`;
  }
  return `间隔 ${Math.max(1, cfg.intervalMinutes || 30)} 分钟`;
}

/** 倒计时格式化：按剩余时长智能切换单位，避免出现"270:18"这种不可读的大分钟数 */
function fmtCountdown(ms) {
  if (!ms || ms <= 0) return "已到期";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `00:${String(s).padStart(2, "0")}`;        // 不到 1 分钟：秒
  if (s < 3600) {                                                // 不到 1 小时：分:秒
    const m = Math.floor(s / 60), r = s % 60;
    return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  }
  if (s < 86400) {                                               // 不到 1 天：X 小时 Y 分
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return `${h} 小时 ${m} 分`;
  }
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600); // 1 天以上：X 天 Y 小时
  return `${d} 天 ${h} 小时`;
}

function renderSettings() {
  const excludes = $("#exclude-patterns");
  const savedExcludes = (S.config.excludePatterns || []).join("\n");
  if (excludes.dataset.saved !== savedExcludes) {
    excludes.value = savedExcludes;
    excludes.dataset.saved = savedExcludes;
  }
  $("#set-hash").checked = S.config.useHashComparison !== false;
  $("#set-dryrun").checked = !!S.config.dryRun;
  $("#set-notify").checked = S.config.notifyOnFinish !== false;
  $("#set-tray").checked = S.config.minimizeToTray !== false;
  $("#set-autostart").checked = !!S.config.autoStart;
  $("#set-autobackup").checked = !!S.config.autoStartBackup;
  $("#set-quark").checked = !!S.config.quarkEnabled;
  const root = $("#quark-root");
  const savedRoot = S.config.quarkRootId || "0";
  if (root.dataset.saved !== savedRoot) {
    root.value = savedRoot === "0" ? "" : savedRoot;
    if (root.dataset.saved === undefined) $("#quark-directory").open = savedRoot !== "0";
    root.dataset.saved = savedRoot;
  }
  $("#quark-status").textContent = quarkLoginMessage || (S.status.quarkLoggedIn ? "已连接夸克；重启软件后需重新连接" : "尚未连接。请先扫码登录，再点击“已登录，验证并连接”");
  const loginButton = $("#btn-quark-login");
  loginButton.disabled = quarkLoginStage === "checking" || quarkLoginStage === "opening";
  loginButton.textContent = quarkLoginStage === "opening" ? "正在打开…" : quarkLoginStage === "confirm" ? "返回登录窗口" : S.status.quarkLoggedIn ? "重新登录夸克" : "扫码登录夸克";
  const finishButton = $("#btn-quark-finish");
  finishButton.hidden = !["confirm", "checking"].includes(quarkLoginStage);
  finishButton.disabled = quarkLoginStage === "checking";
  finishButton.textContent = quarkLoginStage === "checking" ? "正在验证…" : "已登录，验证并连接";
  const selectedCount = S.config.tasks.filter(t => t.quarkEnabled).length;
  $("#quark-task-summary").textContent = `已选择 ${selectedCount} / ${S.config.tasks.length} 个任务` + (!S.config.quarkEnabled ? " · 总开关已关闭，当前不会上传" : selectedCount === 0 ? " · 请在任务列表打开“备份到夸克”" : !S.status.quarkLoggedIn ? " · 请先扫码并验证连接" : S.config.dryRun ? " · 演练模式下不会上传" : " · 可点击概览页的“上传夸克”开始同步");
  $("#task-quark-guidance").textContent = S.status.running ? "备份或上传正在进行，完成后可修改任务的上传开关。" : !S.config.quarkEnabled ? "夸克同步总开关尚未开启。可先选择任务，再前往设置开启同步并连接账号。" : !S.status.quarkLoggedIn ? "夸克尚未连接。上传前请到设置中扫码登录并验证连接，仅本地备份的任务不受影响。" : S.config.dryRun ? "当前为演练模式，只统计变化，不复制、不删除，也不上传到夸克。" : "夸克已连接。点击概览页“上传夸克”即可同步已选择的任务。";
  $("#state-file").value = S.config.stateFile || "";
  renderSchedule();
  renderTheme();
}

function renderTheme() {
  const theme = S.config.theme || "graphite";
  $$("#theme-grid .theme-card").forEach((c) => {
    c.classList.toggle("active", c.dataset.theme === theme);
    c.setAttribute("aria-pressed", String(c.dataset.theme === theme));
  });
}

function renderSchedule() {
  const cfg = S.config;
  const mode = cfg.scheduleMode || "interval";
  $$("#sched-mode .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  ["interval", "daily", "weekly"].forEach((m) => $("#pane-" + m).classList.toggle("hidden", m !== mode));
  $("#set-interval").value = cfg.intervalMinutes;
  $("#weekly-time").value = cfg.weeklyTime || "09:00";
  $("#sched-desc").textContent = scheduleText(cfg);

  const dc = $("#daily-chips");
  dc.innerHTML = "";
  const times = (cfg.dailyTimes || []).slice().sort();
  times.forEach((t) => {
    const el = document.createElement("span");
    el.className = "chip-item";
    el.innerHTML = `${t}<button class="x" title="移除">×</button>`;
    el.querySelector(".x").addEventListener("click", () => saveDaily(times.filter((x) => x !== t)));
    dc.appendChild(el);
  });
  if (!times.length) dc.innerHTML = '<span class="muted">尚未添加时刻，点下方「添加时刻」</span>';

  const wc = $("#week-chips");
  wc.innerHTML = "";
  [1, 2, 3, 4, 5, 6, 0].forEach((d) => {
    const el = document.createElement("span");
    el.className = "chip-item day" + ((cfg.weeklyDays || []).includes(d) ? " on" : "");
    el.textContent = WEEK[d];
    el.addEventListener("click", () => {
      const cur = (cfg.weeklyDays || []).slice();
      const next = cur.includes(d) ? cur.filter((x) => x !== d) : cur.concat(d);
      window.backupAPI.saveConfig({ weeklyDays: next });
      showSavedToast();
    });
    wc.appendChild(el);
  });
}

function saveDaily(times) {
  window.backupAPI.saveConfig({ dailyTimes: times.slice().sort() });
  showSavedToast();
}

function renderAll() {
  renderStatus();
  renderTasks();
  renderLogs();
  renderStats();
  renderSettings();
}

/* ---------- 任务编辑弹窗 ---------- */
function openModal(idx = -1) {
  S.editingIndex = idx;
  $("#modal-caption").textContent = idx >= 0 ? "编辑备份任务" : "添加备份任务";
  const t = idx >= 0 ? S.config.tasks[idx] : { source: "", backup: "" };
  $("#modal-source").value = t.source;
  $("#modal-backup").value = t.backup;
  $("#modal-quark").checked = !!t.quarkEnabled;
  $("#modal-quark-hint").textContent = !S.config.quarkEnabled ? "保存后还需在设置中开启夸克同步总开关，并登录连接账号。" : !S.status.quarkLoggedIn ? "保存后请到设置中扫码登录并验证连接，再点击概览页“上传夸克”。" : S.config.dryRun ? "当前为演练模式，不会实际上传；关闭演练后再点击“上传夸克”。" : "保存后，点击概览页“上传夸克”即可同步。也可随时在任务列表修改此开关。";
  $("#modal-error").hidden = true;
  $("#modal-mask").classList.remove("hidden");
  requestAnimationFrame(() => $("#modal-source").focus());
}
function closeModal() {
  $("#modal-mask").classList.add("hidden");
}

async function saveModal() {
  const source = $("#modal-source").value.trim();
  const backup = $("#modal-backup").value.trim();
  const error = $("#modal-error");
  error.hidden = true;
  if (!source || !backup) { error.textContent = "请填写源目录和目标目录。"; error.hidden = false; return; }
  if (source.toLowerCase() === backup.toLowerCase()) { error.textContent = "源目录和目标目录不能相同。"; error.hidden = false; return; }
  const tasks = S.config.tasks.map((t) => ({ ...t }));
  const item = { ...(S.editingIndex >= 0 ? tasks[S.editingIndex] : {}), source, backup, quarkEnabled: $("#modal-quark").checked };
  if (S.editingIndex >= 0) tasks[S.editingIndex] = item;
  else tasks.push(item);
  try {
    await window.backupAPI.saveConfig({ tasks });
    closeModal();
  } catch (failure) {
    error.textContent = String(failure.message || failure);
    error.hidden = false;
  }
}

async function onTaskAction(act, i) {
  if (act === "edit") return openModal(i);
  if (act === "run") {
    const r = await window.backupAPI.runNow([S.config.tasks[i]]);
    if (!r.ok) alert(r.message);
    return;
  }
  if (act === "del") {
    const t = S.config.tasks[i];
    if (!confirm(`确定删除该任务吗？\n\n${t.source} → ${t.backup}\n\n（只删除任务配置，不会删除已备份的文件）`)) return;
    const tasks = S.config.tasks.filter((_, idx) => idx !== i);
    await window.backupAPI.saveConfig({ tasks });
  }
}

/* ---------- 事件绑定 ---------- */
function bindButtons() {
  // 标题栏
  $("#btn-min").addEventListener("click", () => window.backupAPI.minimizeWindow());
  $("#btn-max").addEventListener("click", async () => {
    const isMax = await window.backupAPI.toggleMaximize();
    applyMaxState(isMax);
  });
  $("#btn-tray").addEventListener("click", () => window.backupAPI.hideWindow());
  $("#btn-close").addEventListener("click", () => window.backupAPI.closeWindow());
  // 最大化状态变更：同步按钮图标
  window.backupAPI.onMaximizeChange((isMax) => applyMaxState(isMax));
  // 初始化时查询一次
  window.backupAPI.isMaximized().then((isMax) => applyMaxState(!!isMax));

  // 概览
  $("#btn-run-now").addEventListener("click", async () => {
    const r = await window.backupAPI.runNow(null);
    if (!r.ok) alert(r.message);
  });
  $("#btn-upload-quark").addEventListener("click", async () => {
    const r = await window.backupAPI.uploadQuark();
    if (!r.ok) alert(r.message);
  });
  $("#btn-pause-backup").addEventListener("click", async () => {
    const r = await window.backupAPI.pauseBackup();
    if (!r.ok) alert(r.message);
  });
  $("#btn-resume-backup").addEventListener("click", async () => {
    const r = await window.backupAPI.resumeBackup();
    if (!r.ok) alert(r.message);
  });
  $("#btn-stop-backup").addEventListener("click", async () => {
    const r = await window.backupAPI.stopBackup();
    if (!r.ok) alert(r.message);
  });
  $("#btn-resume-last").addEventListener("click", async () => {
    const r = await window.backupAPI.resumeLastBackup();
    if (!r.ok) alert(r.message);
  });
  $("#btn-scheduler").addEventListener("click", () => {
    if (S.status.schedulerRunning) window.backupAPI.stopScheduler();
    else window.backupAPI.startScheduler();
  });

  // 任务
  $("#btn-add-task").addEventListener("click", () => openModal(-1));
  $("#modal-cancel").addEventListener("click", closeModal);
  $("#modal-save").addEventListener("click", saveModal);
  $("#modal-pick-source").addEventListener("click", async () => {
    const p = await window.backupAPI.pickFolder("选择源目录");
    if (p) $("#modal-source").value = p;
  });
  $("#modal-pick-backup").addEventListener("click", async () => {
    const p = await window.backupAPI.pickFolder("选择备份目录");
    if (p) $("#modal-backup").value = p;
  });
  $("#modal-mask").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
  $("#modal-mask").addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
    if (e.key === "Enter" && e.target.tagName === "INPUT") saveModal();
  });

  // 日志
  $("#btn-clear-log").addEventListener("click", () => {
    S.logs = [];
    renderLogs();
  });

  // 统计
  $("#btn-clear-history").addEventListener("click", async () => {
    if (!confirm("确定清空所有备份历史记录吗？\n\n（只清除统计记录，不会影响已备份的文件）")) return;
    await window.backupAPI.clearHistory();
  });
  $("#btn-copy-log").addEventListener("click", async () => {
    const text = S.logs.map((l) => `[${new Date(l.time).toLocaleString("zh-CN", { hour12: false })}] ${l.text}`).join("\n");
    await navigator.clipboard.writeText(text);
    $("#btn-copy-log").textContent = "已复制";
    setTimeout(() => ($("#btn-copy-log").textContent = "复制"), 1200);
  });

  // 设置 · 定时计划
  $$("#sched-mode .seg-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      window.backupAPI.saveConfig({ scheduleMode: btn.dataset.mode });
      showSavedToast();
    }),
  );
  $("#daily-add-btn").addEventListener("click", () => {
    const v = $("#daily-add").value;
    if (!v) return;
    const cur = (S.config.dailyTimes || []).slice();
    if (!cur.includes(v)) cur.push(v);
    saveDaily(cur);
  });
  $("#weekly-time").addEventListener("change", () => {
    const v = $("#weekly-time").value;
    if (v) {
      window.backupAPI.saveConfig({ weeklyTime: v });
      showSavedToast();
    }
  });

  // 设置 · 备份设置（立即生效，不再需要"保存设置"按钮）
  bindInstantSave($("#set-hash"), "useHashComparison");
  bindInstantSave($("#set-dryrun"), "dryRun");
  bindInstantSave($("#set-notify"), "notifyOnFinish");
  // 应用行为
  bindInstantSave($("#set-tray"), "minimizeToTray");
  bindInstantSave($("#set-autostart"), "autoStart");
  bindInstantSave($("#set-autobackup"), "autoStartBackup");
  bindInstantSave($("#set-quark"), "quarkEnabled");
  $("#btn-quark-login").addEventListener("click", async () => {
    try {
      quarkLoginStage = "opening";
      quarkLoginMessage = "正在打开夸克登录窗口…";
      renderSettings();
      await window.backupAPI.quarkLogin();
      quarkLoginStage = "confirm";
      quarkLoginMessage = "请在登录窗口完成扫码，保持窗口打开，再点击“已登录，验证并连接”";
      renderSettings();
    } catch (error) {
      quarkLoginStage = "idle";
      quarkLoginMessage = `无法打开登录窗口：${String(error.message || error)}`;
      renderSettings();
    }
  });
  $("#btn-quark-finish").addEventListener("click", async () => {
    quarkLoginStage = "checking";
    quarkLoginMessage = "正在验证登录信息…";
    renderSettings();
    try {
      await window.backupAPI.quarkFinishLogin();
    } catch (error) {
      quarkLoginStage = "confirm";
      quarkLoginMessage = `验证失败，可重试：${String(error.message || error)}`;
      renderSettings();
    }
  });
  $("#btn-save-quark").addEventListener("click", async () => {
    const root = $("#quark-root");
    const value = root.value.trim() || "0";
    await window.backupAPI.saveConfig({ quarkRootId: value });
    root.value = value === "0" ? "" : value;
    showSavedToast();
  });
  // 备份间隔（input number，change 时即时保存）
  $("#set-interval").addEventListener("change", () => {
    const v = parseInt($("#set-interval").value, 10);
    if (!(v >= 1)) {
      $("#set-interval").value = S.config.intervalMinutes || 30;
      return alert("备份间隔必须 ≥ 1 分钟");
    }
    window.backupAPI.saveConfig({ intervalMinutes: v });
    showSavedToast();
  });
  $("#btn-open-state").addEventListener("click", () => {
    const f = S.config.stateFile;
    if (f) window.backupAPI.openPath(f.replace(/[^\\/]+$/, ""));
  });
  $("#btn-select-state").addEventListener("click", async () => {
    const folder = await window.backupAPI.pickFolder("选择增量状态文件目录");
    if (folder) $("#state-file").value = folder.replace(/[\\/]+$/, "") + "/backup-state.json";
  });
  $("#btn-save-state").addEventListener("click", async () => {
    await window.backupAPI.saveConfig({ stateFile: $("#state-file").value.trim() });
    showSavedToast();
  });

  const excludeInput = $("#exclude-patterns");
  const excludeMessage = $("#exclude-message");
  const readExcludes = () => [...new Set(excludeInput.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean))];
  excludeInput.addEventListener("input", () => { excludeMessage.textContent = "尚未保存"; });
  $$("[data-exclude]").forEach(button => button.addEventListener("click", () => {
    excludeInput.value = [...new Set([...readExcludes(), button.dataset.exclude])].join("\n");
    excludeMessage.textContent = "尚未保存";
  }));
  $("#btn-save-excludes").addEventListener("click", async () => {
    const button = $("#btn-save-excludes");
    button.disabled = true;
    excludeInput.disabled = true;
    $$("[data-exclude]").forEach(item => { item.disabled = true; });
    excludeMessage.textContent = "正在保存…";
    try {
      const excludePatterns = readExcludes();
      await window.backupAPI.saveConfig({ excludePatterns });
      excludeInput.value = excludePatterns.join("\n");
      excludeInput.dataset.saved = excludeInput.value;
      excludeMessage.textContent = "已保存，下次运行生效";
      showSavedToast();
    } catch (error) {
      excludeMessage.textContent = String(error.message || error);
    } finally {
      button.disabled = false;
      excludeInput.disabled = false;
      $$("[data-exclude]").forEach(item => { item.disabled = false; });
    }
  });

  // 关于
  $("#btn-about-download").addEventListener("click", downloadLatest);
  $("#btn-about-repo").addEventListener("click", openRepository);
  $("#btn-about-copy").addEventListener("click", copyAppInfo);
  $("#btn-about-changelog").addEventListener("click", () => {
    const card = $("#about-changelog-card");
    if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("#btn-about-data").addEventListener("click", () => {
    const dir = (S.appInfo && S.appInfo.dataDir) || "";
    if (!dir) return alert("未获取到数据目录");
    window.backupAPI.openPath(dir).catch((e) => alert(String((e && e.message) || e || "打开目录失败")));
  });

  // 主题切换
  $$("#theme-grid .theme-card").forEach((card) =>
    card.addEventListener("click", () => {
      const theme = card.dataset.theme;
      applyTheme(theme);
      window.backupAPI.saveConfig({ theme });
      showSavedToast();
    }),
  );

  // ESC 关弹窗
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });
}

function applyTheme(theme) {
  document.body.dataset.theme = theme;
  $$("#theme-grid .theme-card").forEach((c) => {
    c.classList.toggle("active", c.dataset.theme === theme);
    c.setAttribute("aria-pressed", String(c.dataset.theme === theme));
  });
}

/** 切换最大化/还原按钮的图标（最大化时显示「还原」，否则显示「最大化」） */
function applyMaxState(isMax) {
  const btn = $("#btn-max");
  if (!btn) return;
  btn.title = isMax ? "还原" : "最大化";
  const icoMax = btn.querySelector(".ico-max");
  const icoRestore = btn.querySelector(".ico-restore");
  if (icoMax) icoMax.style.display = isMax ? "none" : "";
  if (icoRestore) icoRestore.style.display = isMax ? "" : "none";
}

/** 即时保存通用绑定：checkbox 改变立即写回配置 + 显示提示 */
function bindInstantSave(el, key) {
  if (!el) return;
  el.addEventListener("change", () => {
    window.backupAPI.saveConfig({ [key]: el.checked });
    showSavedToast();
  });
}

/** 浮动"已保存"提示：右下角出现 1s 后淡出，复用同一个 DOM 避免频繁创建 */
let savedToastTimer = null;
function showSavedToast(text) {
  const t = $("#saved-toast");
  if (!t) return;
  t.textContent = text || "已保存";
  t.classList.add("show");
  if (savedToastTimer) clearTimeout(savedToastTimer);
  savedToastTimer = setTimeout(() => t.classList.remove("show"), 1000);
}

/* ---------- 主进程推送 ---------- */
// 顶部进度条状态控制：idle 隐藏 / running 扫描动画 / done 完成淡出 / error 失败变红淡出
function setProgressState(state) {
  clearTimeout(progressResetTimer);
  const bar = $("#progress-bar");
  if (!bar) return;
  // 若已在 done/error 淡出阶段，避免被 running 覆盖
  if ((bar.dataset.state === "done" || bar.dataset.state === "error") && state === "running") {
    // 直接重启扫描
    bar.dataset.state = state;
    return;
  }
  bar.dataset.state = state;
}

function handlePush({ type, data }) {
  if (type === "window:visibility") {
    windowVisible = data;
    refreshVisibleView();
  } else if (type === "status") {
    const quarkChanged = data.quarkLoggedIn !== undefined && data.quarkLoggedIn !== S.status.quarkLoggedIn;
    Object.assign(S.status, data);
    if (quarkChanged) renderTasks();
    renderStatus();
    renderSettings();
  } else if (type === "stats") {
    if (data && S.status.running && !resultFeedback) {
      S.liveStats = data;
      S.backupProgress = data.progress || S.backupProgress;
      setProgressState("running");
    } else if (!data) {
      S.liveStats = null;
      // 进度条最终状态由 backup:result 事件精确决定；此处不动
    }
    if (isViewVisible("dashboard")) { renderResult(); renderBackupProgress(); }
  } else if (type === "log" || type === "logs") {
    const entries = type === "logs" ? data : [data];
    S.logs.push(...entries);
    if (S.logs.length > LOG_LIMIT) S.logs.splice(0, S.logs.length - LOG_LIMIT);
    pendingLogCount = Math.min(LOG_LIMIT, pendingLogCount + entries.length);
    if (logRenderTimer === null && isViewVisible("logs")) {
      logRenderTimer = setTimeout(flushLogs, 150);
    }
  } else if (type === "config") {
    S.config = data;
    renderTasks();
    renderDashTasks();
    renderSettings();
  } else if (type === "quark:login") {
    S.status.quarkLoggedIn = !!data.loggedIn;
    quarkLoginStage = data.windowOpen ? "confirm" : "idle";
    quarkLoginMessage = data.error || "";
    renderTasks();
    renderDashTasks();
    renderSettings();
  } else if (type === "history") {
    S.history = data || [];
    renderStats();
  } else if (type === "backup:start") {
    clearTimeout(resultFeedbackTimer);
    resultFeedback = null;
    S.status.running = true;
    S.liveStats = null;
    S.backupProgress = { phase: data.phase || "local", stage: "preparing", tasksTotal: data.taskCount || 0, tasksDone: 0, filesProcessed: 0 };
    setProgressState("running");
    renderStatus();
  } else if (type === "backup:result") {
    S.status.running = false;
    const outcome = data?.success ? "success" : data?.stopped ? "stopped" : "error";
    setProgressState(outcome === "success" ? "done" : "error");
    flashBackupResult(outcome);
    // 淡出完成后 1.2s 重置 idle，避免阻塞下次启动
    progressResetTimer = setTimeout(() => setProgressState("idle"), 1200);
  }
}

function flashBackupResult(outcome) {
  clearTimeout(resultFeedbackTimer);
  resultFeedback = outcome;
  renderStatus();
  // 新一轮备份会取消旧反馈，避免旧定时器覆盖正在运行的动画。
  resultFeedbackTimer = setTimeout(() => {
    resultFeedback = null;
    renderStatus();
  }, 1800);
}

let countdownTimer = null;
function updateCountdown() {
  const st = S.status;
  const text = fmtCountdown(Math.max(0, st.nextRunAt - Date.now()));
  if ($("#countdown").textContent !== text) $("#countdown").textContent = text;
}
function updateCountdownTimer() {
  clearInterval(countdownTimer);
  countdownTimer = null;
  const st = S.status;
  if (isViewVisible("dashboard") && !st.running && st.schedulerRunning && st.nextRunAt) {
    updateCountdown();
    countdownTimer = setInterval(updateCountdown, 1000);
  }
}
function refreshVisibleView() {
  document.body.dataset.motionPaused = String(!windowVisible || document.hidden);
  flushLogs();
  if (isViewVisible("dashboard")) { renderResult(); renderBackupProgress(); }
  updateCountdownTimer();
}
document.addEventListener("visibilitychange", refreshVisibleView);

/* ---------- 背景流体粒子 ---------- */
function initBackgroundParticles() {
  const canvas = document.getElementById("bg-particles");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  let width = 0, height = 0;
  let particles = [];
  const PARTICLE_COUNT = 55;
  const MAX_DIST = 145;
  let animId = null;

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // 主题色只在切换时读一次。render() 每帧调 getComputedStyle 会强制一次样式重算，
  // 60fps 下就是每秒 60 次 —— 对一个常驻托盘的界面属于持续的无谓 CPU 占用。
  let accentColor = "";
  function readAccentColor() {
    const value = getComputedStyle(document.body).getPropertyValue("--accent").trim();
    accentColor = value || "#52645a";
  }
  function getThemeColor() {
    if (!accentColor) readAccentColor();
    return accentColor;
  }
  // 主题切换改的是 body 的 data-theme，用属性观察比在每个切换入口挂钩更不容易漏。
  new MutationObserver(readAccentColor).observe(document.body, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });

  class Particle {
    constructor() {
      this.reset(true);
    }
    reset(init = false) {
      this.x = Math.random() * (width || 800);
      this.y = init ? Math.random() * (height || 600) : height + 15;
      this.vx = (Math.random() - 0.5) * 0.6;
      this.vy = -(0.35 + Math.random() * 0.55);
      this.size = 2.2 + Math.random() * 2.8;
      this.baseAlpha = 0.35 + Math.random() * 0.35;
      this.phase = Math.random() * Math.PI * 2;
    }
    update() {
      this.phase += 0.025;
      this.x += this.vx + Math.sin(this.phase) * 0.25;
      this.y += this.vy;

      if (this.y < -20 || this.x < -30 || this.x > width + 30) {
        this.reset(false);
      }
    }
    draw(color) {
      // 呼吸发光效果
      const pulse = 0.85 + Math.sin(this.phase) * 0.15;
      const currentAlpha = this.baseAlpha * pulse;

      // 绘制外层光晕
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.size * 2.2, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.globalAlpha = currentAlpha * 0.25;
      ctx.fill();

      // 绘制粒子核心
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.globalAlpha = currentAlpha;
      ctx.fill();
    }
  }

  function initParticles() {
    particles = [];
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      particles.push(new Particle());
    }
  }

  function render() {
    if (!document.hidden && windowVisible) {
      ctx.clearRect(0, 0, width, height);
      const color = getThemeColor();

      // 绘制粒子间流动连线
      for (let i = 0; i < particles.length; i++) {
        const p1 = particles[i];
        p1.update();
        p1.draw(color);

        for (let j = i + 1; j < particles.length; j++) {
          const p2 = particles[j];
          const dx = p1.x - p2.x;
          const dy = p1.y - p2.y;
          const dist = Math.hypot(dx, dy);

          if (dist < MAX_DIST) {
            const lineAlpha = (1 - dist / MAX_DIST) * 0.22;
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.strokeStyle = color;
            ctx.globalAlpha = lineAlpha;
            ctx.lineWidth = 1.2;
            ctx.stroke();
          }
        }
      }
    }
    animId = requestAnimationFrame(render);
  }

  window.addEventListener("resize", () => {
    resize();
  });

  resize();
  initParticles();
  if (animId) cancelAnimationFrame(animId);
  render();
}

/* ---------- 关于 ---------- */
function fmtReleaseDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  return m ? `${m[1]} 年 ${m[2]} 月 ${m[3]} 日` : String(value || "");
}

/** 渲染关于页：版本与运行环境来自 Rust 端 get_app_info，升级日志来自 changelog.js */
function renderAbout(info) {
  const release = window.BACKY_RELEASE || {};
  const repo = (info && info.repository) || release.repository || "";
  S.appInfo = {
    version: (info && info.version) || "-",
    identifier: (info && info.identifier) || "-",
    license: (info && info.license) || release.license || "MIT",
    dataDir: (info && info.dataDir) || "",
    debug: !!(info && info.debug),
    repository: repo,
  };
  $("#about-version").textContent = S.appInfo.version;
  $("#about-version-cell").textContent = S.appInfo.version;
  $("#about-build").textContent = S.appInfo.debug ? "开发模式（未打包）" : "正式版（release）";
  $("#about-identifier").textContent = S.appInfo.identifier;
  $("#about-license").textContent = S.appInfo.license;
  const dataDirCell = $("#about-datadir");
  dataDirCell.textContent = S.appInfo.dataDir || "暂不可用";
  dataDirCell.title = S.appInfo.dataDir || "";
  const link = $("#about-repo-link");
  link.textContent = repo ? repo.replace(/^https?:\/\/(www\.)?/, "") : "-";
  link.href = repo || "#";

  const entries = release.entries || [];
  $("#about-changelog").innerHTML = entries.length
    ? entries.map((entry) => {
        const items = (entry.highlights || [])
          .map((t) => `<li>${esc(t)}</li>`)
          .concat((entry.fixes || []).map((t) => `<li>修复：${esc(t)}</li>`));
        return `<article class="timeline-item">
          <div class="timeline-head">
            <span class="timeline-version">${esc(entry.version)}</span>
            ${entry.title ? `<span class="timeline-title">${esc(entry.title)}</span>` : ""}
            ${entry.date ? `<time class="timeline-date">${esc(fmtReleaseDate(entry.date))}</time>` : ""}
          </div>
          <ul>${items.join("")}</ul>
          ${entry.note ? `<p class="muted">${esc(entry.note)}</p>` : ""}
        </article>`;
      }).join("")
    : '<p class="muted">暂无记录。</p>';
}

async function copyAppInfo() {
  const info = S.appInfo || {};
  const text = [
    `Backy ${info.version || "-"}`,
    `构建类型：${info.debug ? "开发模式（未打包）" : "正式版（release）"}`,
    `应用标识：${info.identifier || "-"}`,
    `数据目录：${info.dataDir || "-"}`,
    `仓库：${info.repository || "-"}`,
    `系统：${navigator.userAgent}`,
  ].join("\n");
  try {
    await navigator.clipboard.writeText(text);
    showSavedToast("版本信息已复制");
  } catch {
    alert(text);
  }
}

/** 取仓库地址并去掉结尾斜杠，便于安全拼接子路径 */
function repoBase() {
  const repo = (S.appInfo && S.appInfo.repository) || (window.BACKY_RELEASE || {}).repository || "";
  return String(repo).replace(/\/+$/, "");
}

function openRepository() {
  const repo = repoBase();
  if (!repo) { alert("未配置仓库地址"); return; }
  window.backupAPI.openUrl(repo).catch((e) => alert(String((e && e.message) || e || "打开链接失败")));
}

/**
 * 打开最新版下载页。
 * 固定指向 releases/latest（而不是当前版本的 tag）：老版本用户点它总能拿到最新包，
 * 也不需要每次发版都改前端。
 */
function downloadLatest() {
  const repo = repoBase();
  if (!repo) { alert("未配置仓库地址"); return; }
  window.backupAPI.openUrl(`${repo}/releases/latest`).catch((e) => alert(String((e && e.message) || e || "打开链接失败")));
}

/**
 * 外链统一交给系统浏览器。
 * WebView 中 <a href="https://..."> 的默认行为是在应用窗口内导航，页面会「跳」进网站且无法返回；
 * 这里在捕获阶段拦下点击，改走 open_url 交给默认浏览器。中键（auxclick）同样处理。
 */
function handleExternalLink(event) {
  const anchor = event.target && event.target.closest ? event.target.closest("a[href]") : null;
  if (!anchor) return;
  const href = anchor.getAttribute("href") || "";
  if (!/^https?:\/\//i.test(href)) return; // 站内锚点与相对路径保持默认行为
  const api = window.backupAPI;
  if (!api || typeof api.openUrl !== "function") return; // 纯浏览器预览时不拦截
  event.preventDefault();
  api.openUrl(href).catch((e) => alert(String((e && e.message) || e || "打开链接失败")));
}
document.addEventListener("click", handleExternalLink, true);
document.addEventListener("auxclick", handleExternalLink, true);

/* ---------- 初始化 ---------- */
(async function init() {
  const state = await window.backupAPI.getState();
  S.config = state.config;
  Object.assign(S.status, state.status);
  S.liveStats = state.liveStats || null;
  S.backupProgress = S.liveStats?.progress || null;
  S.logs = (state.logs || []).slice(-LOG_LIMIT);
  S.history = state.history || [];
  window.backupAPI.onPush(handlePush);
  bindNav();
  bindButtons();
  applyTheme(S.config.theme || "graphite"); // 应用持久化主题
  initBackgroundParticles(); // 启动背景粒子效果
  renderAll();
  if (window.backupAPI.getAppInfo) {
    window.backupAPI.getAppInfo().then(renderAbout).catch(() => renderAbout(null));
  } else {
    renderAbout(null);
  }
  if (S.status.running) setProgressState("running");
  refreshVisibleView();
  $("#init-notice")?.remove();
  document.body.dataset.ready = "1";
})();
