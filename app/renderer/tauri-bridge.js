/* 保留页面原有接口，桌面操作交给 Tauri。 */
if (window.__TAURI__) {
  window.__TAURI__.app.getVersion().then((version) => {
    document.querySelector(".tb-title").textContent = `Backy ${version}`;
    document.title = `Backy ${version}`;
  });
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const callbacks = [];
  const pending = [];
  const ready = listen("push", ({ payload }) => {
    if (!callbacks.length) pending.push(payload);
    else callbacks.forEach((cb) => cb(payload));
  });
  const action = (action) => invoke("window_action", { action });
  window.backupAPI = {
    getState: async () => { await ready; return invoke("get_state"); },
    getAppInfo: () => invoke("get_app_info"),
    runNow: (tasks) => invoke("run_now", { tasks: tasks ?? null }),
    pauseBackup: () => invoke("pause_backup"),
    resumeBackup: () => invoke("resume_backup"),
    stopBackup: () => invoke("stop_backup"),
    resumeLastBackup: () => invoke("resume_last_backup"),
    uploadQuark: () => invoke("upload_quark"),
    quarkLogin: () => invoke("quark_login"),
    quarkFinishLogin: () => invoke("quark_finish_login"),
    startScheduler: () => invoke("scheduler_start"),
    stopScheduler: () => invoke("scheduler_stop"),
    saveConfig: (partial) => invoke("save_config", { partial }),
    clearHistory: () => invoke("clear_history"),
    pickFolder: (title) => invoke("pick_folder", { title: title || "选择文件夹" }),
    openPath: (path) => invoke("open_path", { path }),
    openUrl: (url) => invoke("open_url", { url }),
    hideWindow: () => action("hide"),
    minimizeWindow: () => action("minimize"),
    toggleMaximize: () => action("toggleMaximize"),
    isMaximized: () => action("isMaximized"),
    closeWindow: () => action("close"),
    quitApp: () => action("quit"),
    onMaximizeChange: (cb) => listen("window:maximizeChange", ({ payload }) => cb(payload)),
    onPush: (cb) => { callbacks.push(cb); pending.splice(0).forEach(cb); },
  };
  document.querySelector("#titlebar").addEventListener("mousedown", (event) => {
    if (event.button === 0 && !event.target.closest("button")) {
      window.__TAURI__.window.getCurrentWindow().startDragging();
    }
  });
  document.querySelector("#titlebar").addEventListener("dblclick", (event) => {
    if (!event.target.closest("button")) action("toggleMaximize");
  });
  window.addEventListener("unhandledrejection", (event) => {
    event.preventDefault();
    document.querySelector("#saved-toast")?.classList.remove("show");
    alert(String(event.reason?.message || event.reason || "操作失败"));
  });
}
