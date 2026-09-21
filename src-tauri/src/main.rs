#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backup;
mod quark;
mod schedule;

use backup::{read_json, write_json, Task};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    fs,
    path::{Path, PathBuf},
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;

struct Data {
    dir: PathBuf,
    config: Value,
    history: Vec<Value>,
    logs: VecDeque<Value>,
    running: bool,
    scheduler: bool,
    next: Option<i64>,
    last: Value,
    live_stats: Option<backup::Stats>,
    quark_cookie: Option<String>,
    quark_login_checking: bool,
    control: Option<Arc<RunControl>>,
    recovery: Option<Value>,
}
struct Runtime(Mutex<Data>);
struct TrayAuto(CheckMenuItem<tauri::Wry>);
#[derive(Default)]
struct RunControl {
    pause_requested: AtomicBool,
    stop_requested: AtomicBool,
    paused: AtomicBool,
}
fn now() -> i64 {
    chrono::Local::now().timestamp_millis()
}
fn push(app: &AppHandle, kind: &str, data: Value) {
    let _ = app.emit("push", json!({"type": kind, "data": data}));
}
fn recovery_path(dir: &Path) -> PathBuf {
    dir.join("backup-recovery.json")
}
fn checkpoint(app: &AppHandle, control: &RunControl, announced_pause: &mut bool) -> bool {
    if control.stop_requested.load(Ordering::Acquire) {
        return false;
    }
    if control.pause_requested.load(Ordering::Acquire) {
        if !*announced_pause {
            *announced_pause = true;
            control.paused.store(true, Ordering::Release);
            log(app, "info", "备份已暂停，将从当前位置继续");
            publish_status(app);
        }
        while control.pause_requested.load(Ordering::Acquire)
            && !control.stop_requested.load(Ordering::Acquire)
        {
            std::thread::sleep(Duration::from_millis(100));
        }
        if *announced_pause {
            *announced_pause = false;
            control.paused.store(false, Ordering::Release);
            if !control.stop_requested.load(Ordering::Acquire) {
                log(app, "info", "继续备份");
                publish_status(app);
            }
        }
    }
    !control.stop_requested.load(Ordering::Acquire)
}
fn defaults() -> Value {
    json!({"tasks": [], "intervalMinutes":30, "scheduleMode":"interval", "dailyTimes":["09:00","18:00"],
        "weeklyDays":[1,5], "weeklyTime":"09:00", "notifyOnFinish":true, "theme":"graphite", "dryRun":false,
        "useHashComparison":true, "minimizeToTray":true, "autoStart":false, "autoStartBackup":true, "shortcutCreated":false,
        "quarkEnabled":false, "quarkRootId":"0", "excludePatterns":backup::DEFAULT_EXCLUDE_PATTERNS})
}

fn normalize_quark_config(config: &mut Value) {
    let legacy_enabled = config["quarkEnabled"].as_bool().unwrap_or(false);
    if let Some(tasks) = config["tasks"].as_array_mut() {
        for task in tasks {
            if let Some(task) = task.as_object_mut() {
                // 旧版全局开关控制全部任务，迁移时保留原有上传范围。
                task.entry("quarkEnabled").or_insert(json!(legacy_enabled));
            }
        }
    }
    if let Some(root) = config["quarkRootId"].as_str() {
        config["quarkRootId"] = json!(if root.trim().is_empty() { "0" } else { root.trim() });
    }
}

fn select_tasks(all: &[Task], requested: Option<Vec<Task>>) -> Result<Vec<Task>, String> {
    match requested {
        None => Ok(all.to_vec()),
        Some(tasks) => tasks.iter().map(|task| {
            all.iter().find(|saved| saved.source == task.source && saved.backup == task.backup)
                .cloned().ok_or_else(|| "任务配置已变化，请重新选择".into())
        }).collect(),
    }
}

fn quark_tasks<'a>(tasks: &'a [Task], config: &Value) -> Vec<&'a Task> {
    if !config["quarkEnabled"].as_bool().unwrap_or(false)
        || config["dryRun"].as_bool().unwrap_or(false) {
        return Vec::new();
    }
    tasks.iter().filter(|task| task.quark_enabled).collect()
}

fn recovery_task(value: Value) -> Option<Value> {
    match value["kind"].as_str() {
        Some("local") | Some("quark")
            if serde_json::from_value::<Vec<Task>>(value["tasks"].clone()).is_ok() =>
        {
            Some(value)
        }
        _ => None,
    }
}
fn status(d: &Data) -> Value {
    let mut s = d.config.clone();
    let o = s.as_object_mut().unwrap();
    o.insert("running".into(), json!(d.running));
    o.insert("schedulerRunning".into(), json!(d.scheduler));
    o.insert("nextRunAt".into(), json!(d.next));
    o.insert("lastResult".into(), d.last.clone());
    o.insert("quarkLoggedIn".into(), json!(d.quark_cookie.is_some()));
    o.insert(
        "pauseRequested".into(),
        json!(d.control.as_ref().is_some_and(|c| c.pause_requested.load(Ordering::Acquire))),
    );
    o.insert(
        "paused".into(),
        json!(d.control.as_ref().is_some_and(|c| c.paused.load(Ordering::Acquire))),
    );
    o.insert("recovery".into(), d.recovery.clone().unwrap_or(Value::Null));
    o.insert(
        "taskCount".into(),
        json!(d.config["tasks"].as_array().map_or(0, Vec::len)),
    );
    s
}
fn log(app: &AppHandle, level: &str, text: &str) {
    publish_logs(app, vec![json!({"level":level,"text":text,"time":now()})]);
}
fn live_stats_value(stats: &backup::Stats) -> Value {
    let mut value = serde_json::to_value(stats).unwrap();
    value["progress"] = json!(stats.progress);
    value
}
fn update_live_stats(app: &AppHandle, stats: &backup::Stats) {
    app.state::<Runtime>().0.lock().unwrap().live_stats = Some(stats.clone());
}
fn publish_logs(app: &AppHandle, entries: Vec<Value>) {
    if entries.is_empty() {
        return;
    }
    {
        let state = app.state::<Runtime>();
        let mut d = state.0.lock().unwrap();
        d.logs.extend(entries.iter().cloned());
        let overflow = d.logs.len().saturating_sub(800);
        d.logs.drain(..overflow);
    }
    push(app, "logs", json!(entries));
}
fn show(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        publish_window_visibility(app);
    }
}
fn publish_window_visibility(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let visible = w.is_visible().unwrap_or(true) && !w.is_minimized().unwrap_or(false);
        push(app, "window:visibility", json!(visible));
    }
}
fn publish_status(app: &AppHandle) {
    let state = app.state::<Runtime>();
    let d = state.0.lock().unwrap();
    let payload = status(&d);
    let auto = d.config["autoStart"].as_bool().unwrap_or(false);
    let text = if d.running { "备份中" } else if d.scheduler { "定时运行中" } else { "定时已停止" };
    drop(d);
    push(app, "status", payload);
    if let Some(item) = app.try_state::<TrayAuto>() {
        let _ = item
            .0
            .set_checked(auto);
    }
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(format!("Backy - {text}")));
    }
}
fn set_scheduler(app: &AppHandle, enabled: bool) {
    {
        let state = app.state::<Runtime>();
        let mut d = state.0.lock().unwrap();
        d.scheduler = enabled;
        d.next = if enabled {
            schedule::next(&d.config, now())
        } else {
            None
        };
    }
    log(
        app,
        "info",
        if enabled {
            "定时备份已启动"
        } else {
            "定时备份已停止"
        },
    );
    publish_status(app);
}

fn launch_backup(
    app: &AppHandle,
    tasks: Option<Vec<Task>>,
    trigger: &str,
) -> Result<Value, String> {
    let (selected, config, state_file, control, excludes) = {
        let state = app.state::<Runtime>();
        let mut d = state.0.lock().unwrap();
        if d.running {
            return Ok(json!({"ok":false,"message":"备份正在进行中"}));
        }
        // 手动选择也必须属于当前任务，并检查全部任务之间的目录关系。
        let all: Vec<Task> =
            serde_json::from_value(d.config["tasks"].clone()).map_err(|e| e.to_string())?;
        let selected = select_tasks(&all, tasks)?;
        backup::validate_tasks(&all)?;
        let state_file = PathBuf::from(d.config["stateFile"].as_str().ok_or("状态文件路径无效")?);
        backup::validate_state_path(&state_file, &d.dir, &all)?;
        let excludes = backup::ExcludeRules::from_config(&d.config["excludePatterns"])?;
        let recovery = json!({"version":1,"kind":"local","trigger":trigger,"createdAt":now(),"tasks":selected});
        write_json(&recovery_path(&d.dir), &recovery)?;
        let control = Arc::new(RunControl::default());
        d.running = true;
        d.control = Some(control.clone());
        d.recovery = Some(recovery);
        d.live_stats = Some(backup::Stats {
            progress: backup::Progress { phase: "local", stage: "preparing", tasks_total: selected.len(), ..Default::default() },
            ..Default::default()
        });
        (selected, d.config.clone(), state_file, control, excludes)
    };
    publish_status(app);
    push(app, "backup:start", json!({"trigger":trigger,"taskCount":selected.len()}));
    log(app, "info", "开始备份");
    let app = app.clone();
    let trigger = trigger.to_owned();
    std::thread::spawn(move || {
        let started = now();
        let mut last_emit = Instant::now();
        let mut pending_logs = Vec::new();
        let mut announced_pause = false;
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            backup::run_controlled(
                &selected,
                &state_file,
                config["dryRun"].as_bool().unwrap_or(false),
                config["useHashComparison"].as_bool().unwrap_or(true),
                &excludes,
                &mut |level, text, stats| {
                    update_live_stats(&app, stats);
                    if !level.is_empty() {
                        pending_logs.push(json!({"level":level,"text":text,"time":now()}));
                    }
                    let update_stats = last_emit.elapsed() >= Duration::from_millis(400);
                    if pending_logs.len() >= 100 || update_stats {
                        publish_logs(&app, std::mem::take(&mut pending_logs));
                    }
                    if update_stats {
                        last_emit = Instant::now();
                    }
                },
                &mut |_| checkpoint(&app, &control, &mut announced_pause),
            )
        }));
        publish_logs(&app, pending_logs);
        let (stats, interrupted) = match outcome {
            Ok(outcome) => (outcome.stats, outcome.interrupted),
            Err(_) => {
                log(&app, "error", "备份线程异常，已停止本次备份");
                (backup::Stats {
                    start_time: started,
                    errors: 1,
                    ..Default::default()
                }, false)
            }
        };
        let finished = now();
        let mut result = serde_json::to_value(&stats).unwrap();
        let object = result.as_object_mut().unwrap();
        object.extend(json!({"id":finished,"finishedAt":finished,"durationMs":finished-started,
            "trigger":trigger,"taskCount":selected.len(),"running":false,"stopped":interrupted,"success":stats.errors == 0 && !interrupted,
            "error":if interrupted { json!("备份已停止，可继续上次任务") } else if stats.errors > 0 { json!(format!("备份发生 {} 个错误，请查看运行日志", stats.errors)) } else { Value::Null }
        }).as_object().unwrap().clone());
        let (persist_error, recovery_error) = {
            let state = app.state::<Runtime>();
            let mut d = state.0.lock().unwrap();
            let mut history = d.history.clone();
            history.push(result.clone());
            if history.len() > 500 {
                history.drain(..history.len() - 500);
            }
            let error = write_json(&d.dir.join("backup-history.json"), &json!(history)).err();
            if let Some(ref e) = error {
                result["success"] = json!(false);
                result["error"] = json!(e);
                if let Some(last) = history.last_mut() {
                    *last = result.clone();
                }
            }
            d.history = history;
            d.last = result.clone();
            d.running = false;
            d.control = None;
            d.live_stats = None;
            let recovery_error = if result["success"].as_bool() == Some(true) {
                match fs::remove_file(recovery_path(&d.dir)) {
                    Ok(()) => {
                        d.recovery = None;
                        None
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        d.recovery = None;
                        None
                    }
                    Err(e) => Some(e.to_string()),
                }
            } else {
                None
            };
            if d.scheduler {
                d.next = schedule::next(&d.config, now());
            }
            push(&app, "history", json!(d.history));
            (error, recovery_error)
        };
        if let Some(e) = persist_error {
            log(&app, "error", &e);
        }
        if let Some(e) = recovery_error {
            log(&app, "error", &format!("清理恢复任务失败: {e}"));
        }
        let success = result["success"].as_bool().unwrap_or(false);
        let summary = format!(
            "{}：更新 {} 个文件，跳过 {} 个，错误 {} 个",
            if interrupted {
                "备份已停止"
            } else if success {
                "备份完成"
            } else {
                "备份失败"
            },
            stats.files_copied,
            stats.files_skipped,
            stats.errors
        );
        log(
            &app,
            if interrupted {
                "info"
            } else if success {
                "success"
            } else {
                "error"
            },
            &summary,
        );
        push(&app, "stats", live_stats_value(&stats));
        push(&app, "backup:result", result);
        push(&app, "stats", Value::Null);
        publish_status(&app);
        if config["notifyOnFinish"].as_bool().unwrap_or(true) {
            if let Err(e) = app
                .notification()
                .builder()
                .title("Backy")
                .body(summary)
                .show()
            {
                log(&app, "error", &format!("通知失败: {e}"));
            }
        }
    });
    Ok(json!({"ok":true}))
}

#[tauri::command]
fn get_state(app: AppHandle) -> Value {
    let state = app.state::<Runtime>();
    let d = state.0.lock().unwrap();
    json!({"config":d.config,"status":status(&d),"logs":d.logs,"history":d.history,"liveStats":d.live_stats.as_ref().map(live_stats_value)})
}
#[tauri::command]
fn run_now(app: AppHandle, tasks: Option<Vec<Task>>) -> Result<Value, String> {
    launch_backup(&app, tasks, "manual")
}

#[tauri::command]
fn pause_backup(app: AppHandle) -> Result<Value, String> {
    let state = app.state::<Runtime>();
    let d = state.0.lock().unwrap();
    let Some(control) = d.control.as_ref() else {
        return Ok(json!({"ok":false,"message":"当前没有可暂停的任务"}));
    };
    control.pause_requested.store(true, Ordering::Release);
    drop(d);
    log(&app, "info", "已请求暂停，将在当前文件完成后生效");
    publish_status(&app);
    Ok(json!({"ok":true}))
}

#[tauri::command]
fn resume_backup(app: AppHandle) -> Result<Value, String> {
    let state = app.state::<Runtime>();
    let d = state.0.lock().unwrap();
    let Some(control) = d.control.as_ref() else {
        return Ok(json!({"ok":false,"message":"当前没有可继续的任务"}));
    };
    control.pause_requested.store(false, Ordering::Release);
    control.paused.store(false, Ordering::Release);
    drop(d);
    publish_status(&app);
    Ok(json!({"ok":true}))
}

#[tauri::command]
fn stop_backup(app: AppHandle) -> Result<Value, String> {
    let state = app.state::<Runtime>();
    let d = state.0.lock().unwrap();
    let Some(control) = d.control.as_ref() else {
        return Ok(json!({"ok":false,"message":"当前没有可停止的任务"}));
    };
    control.stop_requested.store(true, Ordering::Release);
    control.pause_requested.store(false, Ordering::Release);
    control.paused.store(false, Ordering::Release);
    drop(d);
    log(&app, "info", "已请求停止，将在当前文件完成后结束");
    publish_status(&app);
    Ok(json!({"ok":true}))
}

#[tauri::command]
fn resume_last_backup(app: AppHandle) -> Result<Value, String> {
    let recovery = app.state::<Runtime>().0.lock().unwrap().recovery.clone();
    let Some(recovery) = recovery else {
        return Ok(json!({"ok":false,"message":"没有可恢复的任务"}));
    };
    let tasks: Vec<Task> = serde_json::from_value(recovery["tasks"].clone())
        .map_err(|_| "恢复任务数据无效".to_owned())?;
    match recovery["kind"].as_str() {
        Some("local") => launch_backup(&app, Some(tasks), "resume"),
        Some("quark") => launch_quark(
            &app,
            Some(tasks),
            "resume",
            recovery["quarkRootId"].as_str().map(str::to_owned),
        ),
        _ => Ok(json!({"ok":false,"message":"恢复任务类型无效"})),
    }
}

#[tauri::command]
fn upload_quark(app: AppHandle) -> Result<Value, String> {
    launch_quark(&app, None, "quark", None)
}

fn launch_quark(
    app: &AppHandle,
    requested_tasks: Option<Vec<Task>>,
    trigger: &str,
    recovery_root: Option<String>,
) -> Result<Value, String> {
    let (uploads, root, cookie, control, excludes) = {
        let state = app.state::<Runtime>();
        let mut d = state.0.lock().unwrap();
        if d.running {
            return Ok(json!({"ok":false,"message":"备份或夸克上传正在进行中"}));
        }
        if d.config["dryRun"].as_bool().unwrap_or(false) {
            return Ok(json!({"ok":false,"message":"演练模式下不会上传到夸克"}));
        }
        let all: Vec<Task> = serde_json::from_value(d.config["tasks"].clone()).map_err(|e| e.to_string())?;
        let uploads = match requested_tasks {
            Some(tasks) => select_tasks(&all, Some(tasks))?,
            None => {
                if !d.config["quarkEnabled"].as_bool().unwrap_or(false) {
                    return Ok(json!({"ok":false,"message":"请先在设置中开启夸克同步"}));
                }
                quark_tasks(&all, &d.config).into_iter().cloned().collect()
            }
        };
        if uploads.is_empty() {
            return Ok(json!({"ok":false,"message":"没有可继续的夸克上传任务"}));
        }
        let Some(cookie) = d.quark_cookie.clone() else {
            return Ok(json!({"ok":false,"message":"请先在设置中扫码并连接夸克"}));
        };
        let root = recovery_root
            .as_deref()
            .map(str::trim)
            .filter(|root| !root.is_empty())
            .unwrap_or_else(|| d.config["quarkRootId"].as_str().unwrap_or("0"))
            .to_owned();
        let excludes = backup::ExcludeRules::from_config(&d.config["excludePatterns"])?;
        let recovery = json!({"version":1,"kind":"quark","trigger":trigger,"createdAt":now(),"quarkRootId":root,"tasks":uploads});
        write_json(&recovery_path(&d.dir), &recovery)?;
        let control = Arc::new(RunControl::default());
        d.running = true;
        d.control = Some(control.clone());
        d.recovery = Some(recovery);
        d.live_stats = Some(backup::Stats {
            progress: backup::Progress { phase: "quark", stage: "preparing", tasks_total: uploads.len(), ..Default::default() },
            ..Default::default()
        });
        (uploads, root, cookie, control, excludes)
    };
    publish_status(&app);
    push(app, "backup:start", json!({"trigger":trigger,"taskCount":uploads.len(),"phase":"quark"}));
    log(app, "info", if trigger == "resume" { "继续上传到夸克" } else { "开始上传到夸克" });
    let handle = app.clone();
    let trigger = trigger.to_owned();
    std::thread::spawn(move || {
        let started = now();
        let mut stats = backup::Stats {
            start_time: started,
            progress: backup::Progress { phase: "quark", stage: "uploading", tasks_total: uploads.len(), ..Default::default() },
            ..Default::default()
        };
        let mut announced_pause = false;
        let mut interrupted = false;
        for (index, task) in uploads.iter().enumerate() {
            if !checkpoint(&handle, &control, &mut announced_pause) {
                interrupted = true;
                break;
            }
            stats.progress.task_index = index + 1;
            stats.progress.task_source = task.source.clone();
            stats.progress.current_path = task.backup.clone();
            update_live_stats(&handle, &stats);
            if let Err(e) = quark::sync_dir(&cookie, Path::new(&task.backup), &root, &excludes, &mut |text| log(&handle, "info", &text), &mut |path, stage, completed| {
                stats.progress.stage = stage;
                stats.progress.current_path = path.to_string_lossy().into_owned();
                if completed { stats.progress.files_processed += 1; }
                update_live_stats(&handle, &stats);
            }, &mut || checkpoint(&handle, &control, &mut announced_pause)) {
                if e == quark::INTERRUPTED {
                    interrupted = true;
                    break;
                } else {
                    stats.errors += 1;
                    log(&handle, "error", &format!("夸克同步失败: {e}"));
                }
            }
            stats.progress.tasks_done = index + 1;
            update_live_stats(&handle, &stats);
        }
        let finished = now();
        let mut result = serde_json::to_value(&stats).unwrap();
        result.as_object_mut().unwrap().extend(json!({"id":finished,"finishedAt":finished,"durationMs":finished-started,
            "trigger":trigger,"taskCount":uploads.len(),"running":false,"stopped":interrupted,"success":stats.errors == 0 && !interrupted,
            "error":if interrupted { json!("夸克上传已停止，可继续上次任务") } else if stats.errors > 0 { json!(format!("夸克上传发生 {} 个错误，请查看运行日志", stats.errors)) } else { Value::Null }
        }).as_object().unwrap().clone());
        let persist_error = {
            let state = handle.state::<Runtime>();
            let mut d = state.0.lock().unwrap();
            let mut history = d.history.clone();
            history.push(result.clone());
            if history.len() > 500 { history.drain(..history.len() - 500); }
            let error = write_json(&d.dir.join("backup-history.json"), &json!(history)).err();
            if let Some(ref e) = error {
                result["success"] = json!(false);
                result["error"] = json!(e);
                if let Some(last) = history.last_mut() {
                    *last = result.clone();
                }
            }
            d.history = history;
            d.last = result.clone();
            d.running = false;
            d.control = None;
            d.live_stats = None;
            let recovery_error: Option<String> = if result["success"].as_bool() == Some(true) {
                match fs::remove_file(recovery_path(&d.dir)) {
                    Ok(()) => { d.recovery = None; None }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => { d.recovery = None; None }
                    Err(e) => Some(e.to_string()),
                }
            } else { None };
            push(&handle, "history", json!(d.history));
            (error, recovery_error)
        };
        if let Some(e) = persist_error.0 { log(&handle, "error", &e); }
        if let Some(e) = persist_error.1 { log(&handle, "error", &format!("清理恢复任务失败: {e}")); }
        let success = result["success"].as_bool().unwrap_or(false);
        log(&handle, if interrupted { "info" } else if success { "success" } else { "error" }, if interrupted { "夸克上传已停止" } else if success { "夸克上传完成" } else { "夸克上传失败" });
        push(&handle, "stats", live_stats_value(&stats));
        push(&handle, "backup:result", result);
        push(&handle, "stats", Value::Null);
        publish_status(&handle);
    });
    Ok(json!({"ok":true}))
}
#[tauri::command]
fn scheduler_start(app: AppHandle) {
    set_scheduler(&app, true);
}
#[tauri::command]
fn scheduler_stop(app: AppHandle) {
    set_scheduler(&app, false);
}
#[tauri::command]
async fn quark_login(app: AppHandle) -> Result<Value, String> {
    // WebView2 在同步命令中创建窗口会死锁，必须从异步命令发起。
    if let Some(window) = app.get_webview_window("quark-login") {
        window.unminimize().map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(json!({"ok":true}));
    }
    let window = WebviewWindowBuilder::new(
        &app,
        "quark-login",
        WebviewUrl::External(
            "https://pan.quark.cn/"
                .parse()
                .map_err(|e: url::ParseError| e.to_string())?,
        ),
    )
    .title("夸克网盘登录")
    .inner_size(960.0, 720.0)
    .build()
    .map_err(|e| e.to_string())?;

    let handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            let logged_in = handle.state::<Runtime>().0.lock().unwrap().quark_cookie.is_some();
            push(&handle, "quark:login", json!({"loggedIn":logged_in, "windowOpen":false}));
        }
    });
    Ok(json!({"ok":true}))
}

#[tauri::command]
fn quark_finish_login(app: AppHandle) -> Result<Value, String> {
    {
        let state = app.state::<Runtime>();
        let mut data = state.0.lock().unwrap();
        if data.quark_login_checking {
            return Ok(json!({"ok":true, "pending":true}));
        }
        data.quark_login_checking = true;
    }

    let handle = app.clone();
    std::thread::spawn(move || {
        let result = (|| -> Result<String, String> {
            let login = handle
                .get_webview_window("quark-login")
                .ok_or("扫码登录窗口已关闭，请重新打开")?;
            let url = "https://pan.quark.cn/"
                .parse()
                .map_err(|e: url::ParseError| e.to_string())?;
            let cookies = login.cookies_for_url(url).map_err(|e| e.to_string())?;
            let cookie = cookies
                .iter()
                .map(|c| format!("{}={}", c.name(), c.value()))
                .collect::<Vec<_>>()
                .join("; ");
            if cookie.is_empty() {
                return Err("未检测到登录信息，请完成扫码登录后重试".into());
            }
            quark::validate_cookie(&cookie)?;
            Ok(cookie)
        })();

        handle.state::<Runtime>().0.lock().unwrap().quark_login_checking = false;
        match result {
            Ok(cookie) => {
                handle.state::<Runtime>().0.lock().unwrap().quark_cookie = Some(cookie);
                if let Some(login) = handle.get_webview_window("quark-login") {
                    let _ = login.close();
                }
                log(&handle, "success", "夸克网盘登录成功");
                push(&handle, "quark:login", json!({"loggedIn":true, "windowOpen":false}));
                publish_status(&handle);
            }
            Err(error) => {
                log(&handle, "error", &format!("夸克网盘登录失败: {error}"));
                let logged_in = handle.state::<Runtime>().0.lock().unwrap().quark_cookie.is_some();
                let window_open = handle.get_webview_window("quark-login").is_some();
                push(&handle, "quark:login", json!({"loggedIn":logged_in, "windowOpen":window_open, "error":error}));
            }
        }
    });
    Ok(json!({"ok":true}))
}

fn validate_config(cfg: &Value) -> Result<(), String> {
    backup::ExcludeRules::from_config(&cfg["excludePatterns"])?;
    let tasks: Vec<Task> =
        serde_json::from_value(cfg["tasks"].clone()).map_err(|_| "备份任务格式无效")?;
    for task in &tasks {
        if !Path::new(&task.source).is_absolute() || !Path::new(&task.backup).is_absolute() {
            return Err("源目录和目标目录必须是绝对路径".into());
        }
    }
    let minutes = cfg["intervalMinutes"]
        .as_u64()
        .ok_or("备份间隔必须是正整数")?;
    if !(1..=525600).contains(&minutes) {
        return Err("备份间隔必须在 1 至 525600 分钟之间".into());
    }
    if !["interval", "daily", "weekly"].contains(&cfg["scheduleMode"].as_str().unwrap_or("")) {
        return Err("定时模式无效".into());
    }
    let times = cfg["dailyTimes"].as_array().ok_or("每日时刻格式无效")?;
    if times
        .iter()
        .any(|t| !schedule::valid_time(t.as_str().unwrap_or("")))
        || !schedule::valid_time(cfg["weeklyTime"].as_str().unwrap_or(""))
    {
        return Err("时刻必须为 HH:MM".into());
    }
    let days = cfg["weeklyDays"].as_array().ok_or("每周日期格式无效")?;
    if days.iter().any(|d| d.as_u64().is_none_or(|d| d > 6)) {
        return Err("每周日期无效".into());
    }
    for key in [
        "notifyOnFinish",
        "dryRun",
        "useHashComparison",
        "minimizeToTray",
        "autoStart",
        "autoStartBackup",
        "quarkEnabled",
    ] {
        if !cfg[key].is_boolean() {
            return Err(format!("{key} 必须是布尔值"));
        }
    }
    if !cfg["quarkRootId"].is_string() { return Err("夸克目标目录 ID 无效".into()); }
    Ok(())
}

fn changes_schedule(partial: &Value) -> bool {
    [
        "intervalMinutes",
        "scheduleMode",
        "dailyTimes",
        "weeklyDays",
        "weeklyTime",
    ]
    .iter()
    .any(|key| partial.get(*key).is_some())
}

#[tauri::command]
fn save_config(app: AppHandle, partial: Value) -> Result<Value, String> {
    let reschedule = changes_schedule(&partial);
    let config = {
        let state = app.state::<Runtime>();
        let mut d = state.0.lock().unwrap();
        let mut config = d.config.clone();
        let partial = partial.as_object().ok_or("配置必须是对象")?;
        for (key, value) in partial {
            if defaults().get(key).is_none() && key != "stateFile" {
                return Err(format!("不支持的配置项: {key}"));
            }
            config[key] = value.clone();
        }
        normalize_quark_config(&mut config);
        validate_config(&config)?;
        if partial.contains_key("stateFile") || partial.contains_key("tasks") {
            if d.running { return Err("备份运行中不能修改状态文件或任务，请完成后重试".into()); }
            let path = config["stateFile"].as_str().ok_or("状态文件路径无效")?;
            let tasks: Vec<Task> = serde_json::from_value(config["tasks"].clone()).map_err(|e| e.to_string())?;
            backup::validate_state_file(Path::new(path), &d.dir, &tasks)?;
        }
        if partial.contains_key("tasks") {
            let tasks: Vec<Task> = serde_json::from_value(config["tasks"].clone()).map_err(|e| e.to_string())?;
            backup::validate_tasks(&tasks)?;
        }
        let auto = config["autoStart"].as_bool().unwrap_or(false);
        let old_auto = d.config["autoStart"].as_bool().unwrap_or(false);
        if auto != old_auto {
            apply_autostart(&app, auto)?;
        }
        if let Err(e) = write_json(&d.dir.join("backup.config.json"), &config) {
            if auto != old_auto {
                let _ = apply_autostart(&app, old_auto);
            }
            return Err(e);
        }
        d.config = config.clone();
        if d.scheduler && reschedule {
            d.next = schedule::next(&config, now());
        }
        config
    };
    push(&app, "config", config.clone());
    log(&app, "info", "配置已保存");
    publish_status(&app);
    Ok(json!({"ok":true,"config":config}))
}
fn apply_autostart(app: &AppHandle, enabled: bool) -> Result<(), String> {
    if enabled {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    }
    .map_err(|e| e.to_string())
}
#[tauri::command]
fn clear_history(app: AppHandle) -> Result<Value, String> {
    let state = app.state::<Runtime>();
    let mut d = state.0.lock().unwrap();
    write_json(&d.dir.join("backup-history.json"), &json!([]))?;
    d.history.clear();
    push(&app, "history", json!([]));
    Ok(json!({"ok":true,"history":[]}))
}
#[tauri::command]
async fn pick_folder(app: AppHandle, title: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title(title)
            .blocking_pick_folder()
            .map(|p| {
                p.into_path()
                    .map(|p| p.to_string_lossy().into_owned())
                    .map_err(|e| e.to_string())
            })
            .transpose()
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.is_absolute() || !p.is_dir() {
        return Err("只能打开已存在的绝对目录路径".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer.exe")
            .arg(p)
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 关于页所需的运行环境信息。版本号取自 Cargo 包版本，与 tauri.conf.json 同步递增。
#[tauri::command]
fn get_app_info() -> Value {
    let data_dir = data_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|e| format!("不可用：{e}"));
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "identifier": "com.local.backup-assistant",
        "license": "MIT",
        "repository": "https://github.com/XiaoMing-Brother/backup",
        "dataDir": data_dir,
        "debug": cfg!(debug_assertions),
    })
}

/// 打开外部链接：只接受 http/https，交给系统默认浏览器，避免 WebView 内跳转。
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("只支持打开 http/https 链接".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer.exe")
            .arg(&url)
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn perform_window_action(app: &AppHandle, action: &str) -> Result<bool, String> {
    let w = app.get_webview_window("main").ok_or("窗口不存在")?;
    let result = match action {
        "hide" => w.hide(),
        "minimize" => w.minimize(),
        "close" => w.close(),
        "toggleMaximize" => {
            if w.is_maximized().map_err(|e| e.to_string())? {
                w.unmaximize()
            } else {
                w.maximize()
            }
        }
        "isMaximized" => return w.is_maximized().map_err(|e| e.to_string()),
        "quit" => {
            if app.state::<Runtime>().0.lock().unwrap().running {
                return Err("备份正在进行，请完成后退出".into());
            }
            app.exit(0);
            return Ok(false);
        }
        _ => return Err("不支持的窗口操作".into()),
    };
    result.map_err(|e| e.to_string())?;
    if action == "hide" || action == "minimize" {
        push(app, "window:visibility", json!(false));
    }
    w.is_maximized().map_err(|e| e.to_string())
}

#[tauri::command]
async fn window_action(app: AppHandle, action: String) -> Result<bool, String> {
    perform_window_action(&app, &action)
}

fn data_dir() -> Result<PathBuf, String> {
    if let Some(p) = std::env::var_os("BACKUP_ASSISTANT_DATA_DIR") {
        let path = PathBuf::from(p);
        if !path.is_absolute() {
            return Err("BACKUP_ASSISTANT_DATA_DIR 必须是绝对路径".into());
        }
        return Ok(path);
    }
    if cfg!(debug_assertions) {
        return Ok(Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf());
    }
    // 沿用 Electron 的目录，避免复制出两份会分叉的配置和历史。
    let roaming = std::env::var_os("APPDATA").ok_or("无法获取 APPDATA")?;
    Ok(PathBuf::from(roaming).join("incremental-backup-assistant"))
}

fn initialize() -> Result<Data, String> {
    let dir = data_dir()?;
    let raw = read_json(&dir.join("backup.config.json"), json!({}))?;
    let mut config = defaults();
    config
        .as_object_mut()
        .unwrap()
        .extend(raw.as_object().ok_or("配置格式无效")?.clone());
    normalize_quark_config(&mut config);
    backup::ExcludeRules::from_config(&config["excludePatterns"])?;
    let _: Vec<Task> =
        serde_json::from_value(config["tasks"].clone()).map_err(|e| e.to_string())?;
    if config.get("stateFile").is_none() {
        config["stateFile"] = json!(dir.join("backup-state.json"));
    }
    let history: Vec<Value> =
        serde_json::from_value(read_json(&dir.join("backup-history.json"), json!([]))?)
            .map_err(|e| e.to_string())?;
    let recovery = recovery_task(read_json(&recovery_path(&dir), Value::Null)?);
    let scheduler = config["autoStartBackup"].as_bool().unwrap_or(true);
    let next = if scheduler {
        schedule::next(&config, now())
    } else {
        None
    };
    Ok(Data {
        dir,
        config,
        history,
        logs: VecDeque::new(),
        running: false,
        scheduler,
        next,
        last: Value::Null,
        live_stats: None,
        quark_cookie: None,
        quark_login_checking: false,
        control: None,
        recovery,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exclusion_config_defaults_persistence_and_validation() {
        let mut config = defaults();
        assert_eq!(config["excludePatterns"], json!(backup::DEFAULT_EXCLUDE_PATTERNS));
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("backup.config.json");
        for patterns in [json!(["node_modules", "*.zip"]), json!([])] {
            config["excludePatterns"] = patterns.clone();
            validate_config(&config).unwrap();
            write_json(&path, &config).unwrap();
            let mut reloaded = defaults();
            reloaded.as_object_mut().unwrap().extend(read_json(&path, json!({})).unwrap().as_object().unwrap().clone());
            assert_eq!(reloaded["excludePatterns"], patterns);
        }
        config["excludePatterns"] = json!(["[invalid"]);
        assert!(validate_config(&config).is_err());
        assert_eq!(read_json(&path, json!({})).unwrap()["excludePatterns"], json!([]));
    }

    #[test]
    fn legacy_quark_tasks_keep_their_previous_upload_scope() {
        for enabled in [false, true] {
            let mut config = defaults();
            config["quarkEnabled"] = json!(enabled);
            config["tasks"] = json!([
                {"source":"source-a", "backup":"backup-a"},
                {"source":"source-b", "backup":"backup-b", "quarkEnabled":false},
                {"source":"source-c", "backup":"backup-c", "quarkEnabled":true}
            ]);
            normalize_quark_config(&mut config);
            assert_eq!(config["tasks"][0]["quarkEnabled"], enabled);
            assert_eq!(config["tasks"][1]["quarkEnabled"], false);
            assert_eq!(config["tasks"][2]["quarkEnabled"], true);
            config["quarkEnabled"] = json!(!enabled);
            normalize_quark_config(&mut config);
            assert_eq!(config["tasks"][0]["quarkEnabled"], enabled);
        }
    }

    #[test]
    fn quark_root_is_optional_and_custom_roots_are_preserved() {
        for (input, expected) in [("", "0"), ("  ", "0"), ("0", "0"), (" 123 ", "123")] {
            let mut config = defaults();
            config["quarkRootId"] = json!(input);
            normalize_quark_config(&mut config);
            assert_eq!(config["quarkRootId"], expected);
            validate_config(&config).unwrap();
        }
        let mut invalid = defaults();
        invalid["tasks"] = json!([{"source":"a","backup":"b","quarkEnabled":"true"}]);
        normalize_quark_config(&mut invalid);
        assert!(validate_config(&invalid).is_err());
    }

    #[test]
    fn uploads_only_selected_tasks_and_respects_global_switch_and_dry_run() {
        let tasks: Vec<Task> = serde_json::from_value(json!([
            {"source":"a","backup":"a-backup","quarkEnabled":true},
            {"source":"b","backup":"b-backup","quarkEnabled":false}
        ])).unwrap();
        let mut config = defaults();
        assert!(quark_tasks(&tasks, &config).is_empty());
        config["quarkEnabled"] = json!(true);
        let uploads = quark_tasks(&tasks, &config);
        assert_eq!(uploads.len(), 1);
        assert_eq!(uploads[0].source, "a");
        assert!(quark_tasks(&tasks[1..], &config).is_empty());
        assert!(quark_tasks(&[], &config).is_empty());
        config["dryRun"] = json!(true);
        assert!(quark_tasks(&tasks, &config).is_empty());
    }

    #[test]
    fn manual_backup_uses_current_saved_upload_choice() {
        let saved: Vec<Task> = serde_json::from_value(json!([
            {"source":"a","backup":"a-backup","quarkEnabled":true},
            {"source":"b","backup":"b-backup","quarkEnabled":false}
        ])).unwrap();
        let mut stale = saved.clone();
        stale[0].quark_enabled = false;
        stale[1].quark_enabled = true;
        let selected = select_tasks(&saved, Some(stale)).unwrap();
        assert!(selected[0].quark_enabled);
        assert!(!selected[1].quark_enabled);
        assert_eq!(select_tasks(&saved, None).unwrap().len(), 2);
        assert!(select_tasks(&saved, Some(vec![])).unwrap().is_empty());
        let mut removed = saved[0].clone();
        removed.source = "removed".into();
        assert!(select_tasks(&saved, Some(vec![removed])).is_err());
    }

    #[test]
    fn recovery_task_accepts_only_resumable_backup_kinds() {
        let tasks = json!([{"source":"a","backup":"a-backup","quarkEnabled":false}]);
        assert!(recovery_task(json!({"kind":"local","tasks":tasks})).is_some());
        assert!(recovery_task(json!({"kind":"quark","tasks":[{"source":"a","backup":"a-backup","quarkEnabled":true}]})).is_some());
        assert!(recovery_task(json!({"kind":"other","tasks":[]})).is_none());
        assert!(recovery_task(json!({"kind":"local","tasks":"invalid"})).is_none());
    }

    #[test]
    fn only_schedule_fields_reset_the_next_run() {
        assert!(!changes_schedule(&json!({"theme": "forest"})));
        assert!(!changes_schedule(&json!({"notifyOnFinish": false})));
        assert!(!changes_schedule(&json!({"tasks": []})));
        assert!(changes_schedule(&json!({"intervalMinutes": 15})));
        assert!(changes_schedule(&json!({"scheduleMode": "daily"})));
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name("incremental-backup-assistant")
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            get_state,
            get_app_info,
            open_url,
            run_now,
            pause_backup,
            resume_backup,
            stop_backup,
            resume_last_backup,
            upload_quark,
            quark_login,
            quark_finish_login,
            scheduler_start,
            scheduler_stop,
            save_config,
            clear_history,
            pick_folder,
            open_path,
            window_action
        ])
        .setup(|app| {
            let data = match initialize() {
                Ok(data) => data,
                Err(e) => {
                    let handle = app.handle().clone();
                    app.dialog().message(e).title("无法读取备份数据").show(move |_| handle.exit(1));
                    return Ok(());
                }
            };
            let auto = data.config["autoStart"].as_bool().unwrap_or(false);
            app.manage(Runtime(Mutex::new(data)));
            let handle = app.handle();
            // 独立测试目录不改变当前用户的开机启动设置。
            if std::env::var_os("BACKUP_ASSISTANT_DATA_DIR").is_none() {
                if let Err(e) = apply_autostart(handle, auto) {
                    log(handle, "error", &e);
                }
            }
            let show_item = MenuItem::with_id(app, "show", "显示主界面", true, None::<&str>)?;
            let run_item = MenuItem::with_id(app, "run", "立即备份", true, None::<&str>)?;
            let start_item = MenuItem::with_id(app, "start", "启动定时备份", true, None::<&str>)?;
            let stop_item = MenuItem::with_id(app, "stop", "停止定时备份", true, None::<&str>)?;
            let auto_item =
                CheckMenuItem::with_id(app, "auto", "开机自启", true, auto, None::<&str>)?;
            app.manage(TrayAuto(auto_item.clone()));
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &show_item,
                    &run_item,
                    &start_item,
                    &stop_item,
                    &auto_item,
                    &quit_item,
                ],
            )?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Backy")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            ..
                        }
                    ) {
                        show(tray.app_handle());
                    }
                })
                .on_menu_event(|app, event| {
                    let result = match event.id.as_ref() {
                        "show" => {
                            show(app);
                            Ok(())
                        }
                        "run" => launch_backup(app, None, "manual").map(|_| ()),
                        "start" => {
                            set_scheduler(app, true);
                            Ok(())
                        }
                        "stop" => {
                            set_scheduler(app, false);
                            Ok(())
                        }
                        "auto" => {
                            let enabled = !app.state::<Runtime>().0.lock().unwrap().config
                                ["autoStart"]
                                .as_bool()
                                .unwrap_or(false);
                            save_config(app.clone(), json!({"autoStart":enabled})).map(|_| ())
                        }
                        "quit" => perform_window_action(app, "quit").map(|_| ()),
                        _ => Ok(()),
                    };
                    if let Err(e) = result {
                        log(app, "error", &e);
                        show(app);
                        app.dialog().message(e).title("Backy").show(|_| {});
                    }
                })
                .build(app)?;
            log(handle, "info", "应用已启动（Tauri）");
            let handle = handle.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(500));
                let (due, postponed) = {
                    let state = handle.state::<Runtime>();
                    let mut d = state.0.lock().unwrap();
                    if d.running {
                        if let Some(stats) = &d.live_stats {
                            push(&handle, "stats", live_stats_value(stats));
                        }
                    }
                    if d.scheduler && d.next.is_some_and(|at| at <= now()) {
                        if d.running {
                            d.next = Some(now() + 60000);
                            (false, true)
                        } else {
                            d.next = None;
                            (true, false)
                        }
                    } else {
                        (false, false)
                    }
                };
                if postponed {
                    publish_status(&handle);
                }
                if due {
                    if let Err(e) = launch_backup(&handle, None, "scheduled") {
                        log(&handle, "error", &e);
                        let state = handle.state::<Runtime>();
                        let mut d = state.0.lock().unwrap();
                        d.next = schedule::next(&d.config, now());
                    }
                    publish_status(&handle);
                }
            });
            Ok(())
        })
        .on_window_event(|w, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                let Some(state) = w.try_state::<Runtime>() else {
                    return;
                };
                let d = state.0.lock().unwrap();
                if d.config["minimizeToTray"].as_bool().unwrap_or(true) || d.running {
                    drop(d);
                    api.prevent_close();
                    let _ = w.hide();
                    publish_window_visibility(w.app_handle());
                } else {
                    drop(d);
                    w.app_handle().exit(0);
                }
            }
            tauri::WindowEvent::Resized(_) => {
                let _ = w.emit("window:maximizeChange", w.is_maximized().unwrap_or(false));
                publish_window_visibility(w.app_handle());
            }
            tauri::WindowEvent::Focused(_) => publish_window_visibility(w.app_handle()),
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("启动 Backy 失败");
}
