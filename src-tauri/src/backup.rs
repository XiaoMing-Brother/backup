use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    ffi::OsString,
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Task {
    pub source: String,
    pub backup: String,
    #[serde(default, rename = "quarkEnabled")]
    pub quark_enabled: bool,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub start_time: i64,
    pub files_copied: u64,
    pub files_skipped: u64,
    pub items_ignored: u64,
    pub items_deleted: u64,
    pub errors: u64,
    pub total_bytes: u64,
    pub saved_bytes: u64,
    #[serde(skip)]
    pub progress: Progress,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub phase: &'static str,
    pub stage: &'static str,
    pub tasks_total: usize,
    pub tasks_done: usize,
    pub task_index: usize,
    pub task_source: String,
    pub current_path: String,
    pub files_processed: u64,
    /// 当前阶段的条目总数；夸克打包这类「先扫描后处理」的流程才会用到，
    /// 未知时为 0。
    pub files_total: u64,
}

pub struct RunOutcome {
    pub stats: Stats,
    pub interrupted: bool,
    /// 生产路径只累加不消费（排查性能时配合 perf_* 基准测试使用），
    /// 所以这里显式允许未被读取。
    #[allow(dead_code)]
    pub profile: StageProfile,
}

/// 性能剖析用的阶段耗时累加器（纳秒）与计数。
/// 生产路径下每项只多两次 Instant::now 调用，开销在微秒量级。
#[derive(Default, Clone)]
pub struct StageProfile {
    /// 实际遍历到的源目录数 / 处理的源文件数
    pub dirs: u64,
    pub files: u64,
    /// 源目录枚举 read_dir
    pub source_read_dir_ns: u64,
    /// 目标目录枚举 read_dir
    pub target_read_dir_ns: u64,
    /// 目标目录条目索引构建（entry_info + HashMap 插入）
    pub target_index_ns: u64,
    /// 源目录名字集合构建
    pub source_names_ns: u64,
    /// 源目录自身的 symlink_metadata（仅顶层任务需要）
    pub dir_stat_ns: u64,
    /// 目标目录自身的 symlink_metadata（仅顶层任务需要）
    pub target_stat_ns: u64,
    /// 每个源文件的 fs::metadata。现在直接复用目录枚举结果，这一项恒为 0，
    /// 保留它是为了让 perf_scan_of_real_tasks 的输出格式保持稳定。
    #[allow(dead_code)]
    pub source_meta_ns: u64,
    /// state.json 读取
    pub state_read_ns: u64,
    /// state.json 写入
    pub state_write_ns: u64,
}

const INTERRUPTED: &str = "备份已中止";

pub fn read_json(path: &Path, default: Value) -> Result<Value, String> {
    match fs::read(path) {
        Ok(data) => serde_json::from_slice(&data).map_err(|e| format!("{}: {e}", path.display())),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(default),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

pub fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    write_json_inner(path, value, true)
}

/// 紧凑输出。状态文件条目多、又只有程序自己读，pretty 的两空格缩进实测多占约 10% 体积。
pub fn write_json_compact(path: &Path, value: &Value) -> Result<(), String> {
    write_json_inner(path, value, false)
}

fn write_json_inner(path: &Path, value: &Value, pretty: bool) -> Result<(), String> {
    (|| -> Result<(), Box<dyn std::error::Error>> {
        let parent = path.parent().ok_or("数据路径缺少父目录")?;
        fs::create_dir_all(parent)?;
        let mut tmp = tempfile::NamedTempFile::new_in(parent)?;
        {
            let mut writer = io::BufWriter::with_capacity(65536, &mut tmp);
            if pretty {
                serde_json::to_writer_pretty(&mut writer, value)?;
            } else {
                serde_json::to_writer(&mut writer, value)?;
            }
            writer.write_all(b"\n")?;
            writer.flush()?;
        }
        tmp.as_file().sync_all()?;
        tmp.persist(path)?;
        Ok(())
    })()
    .map_err(|e| format!("保存 {} 失败: {e}", path.display()))
}

fn resolved(path: &Path) -> io::Result<PathBuf> {
    if path.exists() {
        return fs::canonicalize(path);
    }
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("路径不存在"))?;
    Ok(resolved(parent)?.join(
        path.file_name()
            .ok_or_else(|| io::Error::other("无效路径"))?,
    ))
}

fn path_key(p: &Path) -> String {
    let s = p.to_string_lossy().replace('/', "\\");
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

fn contains(parent: &Path, child: &Path) -> bool {
    let a = path_key(parent);
    let b = path_key(child);
    a == b || b.starts_with(&(a.trim_end_matches('\\').to_owned() + "\\"))
}

pub fn validate_state_path(path: &Path, data_dir: &Path, tasks: &[Task]) -> Result<(), String> {
    if !path.is_absolute() || path.extension().and_then(|s| s.to_str()).is_none_or(|s| !s.eq_ignore_ascii_case("json")) {
        return Err("状态文件必须是绝对路径的 JSON 文件".into());
    }
    let target = resolved(path).map_err(|e| e.to_string())?;
    for name in ["backup.config.json", "backup-history.json"] {
        if path_key(&target) == path_key(&resolved(&data_dir.join(name)).map_err(|e| e.to_string())?) {
            return Err("状态文件不能覆盖配置或历史文件".into());
        }
    }
    for task in tasks {
        for folder in [&task.source, &task.backup] {
            if contains(&resolved(Path::new(folder)).map_err(|e| e.to_string())?, &target) {
                return Err("状态文件不能放在备份源目录或目标目录内".into());
            }
        }
    }
    Ok(())
}

fn read_state(path: &Path) -> Result<Value, String> {
    let state = read_json(path, json!({}))?;
    let entries = state.as_object().ok_or("所选文件不是增量状态文件")?;
    if entries.values().any(|v| !v["size"].is_u64() || !v["mtimeMs"].is_number() || !(v["hash"].is_null() || v["hash"].is_string())) {
        return Err("所选文件不是增量状态文件".into());
    }
    Ok(state)
}

pub fn validate_state_file(path: &Path, data_dir: &Path, tasks: &[Task]) -> Result<(), String> {
    validate_state_path(path, data_dir, tasks)?;
    read_state(path).map(|_| ())
}

pub fn validate_tasks(tasks: &[Task]) -> Result<(), String> {
    let paths = tasks
        .iter()
        .map(|t| {
            let a = Path::new(&t.source);
            let b = Path::new(&t.backup);
            if !a.is_absolute() || !b.is_absolute() {
                return Err("源目录和目标目录必须是绝对路径".to_owned());
            }
            Ok((
                resolved(a).map_err(|e| e.to_string())?,
                resolved(b).map_err(|e| e.to_string())?,
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;
    for (i, (source, target)) in paths.iter().enumerate() {
        if target.parent().is_none() {
            return Err("不能将磁盘根目录作为备份目标".into());
        }
        for (j, (_, other_target)) in paths.iter().enumerate() {
            if contains(source, other_target)
                || contains(other_target, source)
                || (i != j && (contains(target, other_target) || contains(other_target, target)))
            {
                return Err("备份源与目标或多个任务的目标目录不能相同或相互包含".into());
            }
        }
    }
    Ok(())
}

pub const DEFAULT_EXCLUDE_PATTERNS: &[&str] = &[
    "node_modules",
    "dist",
    ".git",
    ".svn",
    ".idea",
    ".vscode",
    "miniprogram_npm",
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
];

pub struct ExcludeRules(Vec<glob::Pattern>);

impl ExcludeRules {
    pub fn from_config(value: &Value) -> Result<Self, String> {
        let patterns: Vec<String> = serde_json::from_value(value.clone())
            .map_err(|_| "备份排除规则必须是字符串数组")?;
        patterns.iter().map(|pattern| {
            let pattern = pattern.trim();
            if pattern.is_empty() || pattern.contains(['/', '\\', ':', '\n', '\r']) || [".", ".."].contains(&pattern) {
                return Err("排除规则请填写文件名、目录名或通配符，不支持路径和空规则".into());
            }
            glob::Pattern::new(pattern).map_err(|e| format!("排除规则无效「{pattern}」: {e}"))
        }).collect::<Result<Vec<_>, String>>().map(Self)
    }

    pub fn matches(&self, name: &str) -> bool {
        self.0.iter().any(|p| {
            p.matches_with(
                name,
                glob::MatchOptions {
                    case_sensitive: true,
                    require_literal_separator: true,
                    require_literal_leading_dot: true,
                },
            )
        })
    }
}

pub(crate) fn is_link(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}

#[derive(Clone, Copy, Default)]
struct EntryInfo {
    is_dir: bool,
    is_file: bool,
    is_link: bool,
    len: u64,
    modified: Option<SystemTime>,
}

// Windows 上目录枚举结果已带元数据，DirEntry 的元数据不产生额外系统调用；
// 逐文件 fs::metadata 会在机械硬盘上退化成随机寻道，必须避免。
fn entry_info(entry: &fs::DirEntry) -> io::Result<EntryInfo> {
    let file_type = entry.file_type()?;
    let meta = entry.metadata()?;
    Ok(EntryInfo {
        is_dir: file_type.is_dir(),
        is_file: file_type.is_file(),
        is_link: is_link(&meta),
        len: meta.len(),
        modified: meta.modified().ok(),
    })
}

pub(crate) fn no_links(path: &Path) -> io::Result<()> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(m) if is_link(&m) => {
                return Err(io::Error::other(format!(
                    "不支持符号链接或目录联接: {}",
                    ancestor.display()
                )))
            }
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

fn hash(path: &Path) -> io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        digest.update(&buffer[..n]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

pub struct Engine<'a> {
    pub stats: Stats,
    pub profile: StageProfile,
    /// 上一轮落盘的状态，只用来判断本轮重建出来的快照是否需要写盘。
    state: Value,
    /// 本轮实际遍历到的源文件快照。每轮重建、不做增量累积，见 run_controlled 的说明。
    rebuilt: Map<String, Value>,
    dry: bool,
    use_hash: bool,
    excludes: &'a ExcludeRules,
    report: &'a mut dyn FnMut(&str, &str, &Stats),
    control: Option<&'a mut dyn FnMut(&Stats) -> bool>,
    last_report: Option<Instant>,
    reported_stage: &'static str,
    reported_task: usize,
}

// 进度上报节流：扫描阶段会在同一阶段内对成千上万个条目调用，逐条上报会把
// 时间耗在克隆状态和跨进程通知上。
const PROGRESS_INTERVAL: Duration = Duration::from_millis(120);

impl Engine<'_> {
    fn progress(&mut self, stage: &'static str, path: &Path) {
        let files = self.stats.files_copied + self.stats.files_skipped;
        let task = self.stats.progress.task_index;
        {
            let p = &mut self.stats.progress;
            p.stage = stage;
            p.files_processed = files;
        }
        let due = self.last_report.is_none()
            || self.reported_stage != stage
            || self.reported_task != task
            || self.last_report.is_some_and(|t| t.elapsed() >= PROGRESS_INTERVAL);
        if !due {
            return;
        }
        self.reported_stage = stage;
        self.reported_task = task;
        self.last_report = Some(Instant::now());
        self.stats.progress.current_path = path.to_string_lossy().into_owned();
        (self.report)("", "", &self.stats);
    }

    // 单个文件处理结束后只更新计数，不触发上报；界面刷新交给后续节流点。
    fn mark_processed(&mut self) {
        let files = self.stats.files_copied + self.stats.files_skipped;
        self.stats.progress.stage = "processed";
        self.stats.progress.files_processed = files;
    }
    fn error(&mut self, message: String) {
        self.stats.errors += 1;
        (self.report)("error", &message, &self.stats);
    }
    fn checkpoint(&mut self) -> io::Result<()> {
        if self.control.as_mut().is_some_and(|control| !control(&self.stats)) {
            return Err(io::Error::other(INTERRUPTED));
        }
        Ok(())
    }

    // known 是调用方目录枚举时已经拿到的自身信息。Windows 上枚举结果自带元数据，
    // 复用它可省掉每目录一次 symlink_metadata（实测占扫描耗时约 8%）。
    // 祖先链由上层逐个校验，递归里重复遍历会在机械硬盘上放大成大量随机寻道。
    fn directory(&mut self, source: &Path, target: &Path, known: Option<&EntryInfo>, target_known: Option<&EntryInfo>) -> io::Result<()> {
        self.checkpoint()?;
        self.progress("scanning", source);
        self.profile.dirs += 1;
        let (self_is_link, self_is_dir) = match known {
            Some(info) => (info.is_link, info.is_dir),
            None => {
                let t = Instant::now();
                let meta = fs::symlink_metadata(source)?;
                self.profile.dir_stat_ns += t.elapsed().as_nanos() as u64;
                (is_link(&meta), meta.is_dir())
            }
        };
        if self_is_link {
            return Err(io::Error::other(format!(
                "不支持符号链接或目录联接: {}",
                source.display()
            )));
        }
        if !self_is_dir {
            return Err(io::Error::other("源路径不是目录"));
        }
        // 目标目录是否需要创建：先只判断不落盘，保证「读不到源目录就不动目标」。
        // 目标侧信息优先复用父目录的枚举结果：机械硬盘上每目录一次 stat 就是一次随机寻道。
        let create_target = match target_known {
            Some(info) if info.is_link => {
                return Err(io::Error::other(format!(
                    "不支持符号链接或目录联接: {}",
                    target.display()
                )))
            }
            Some(info) if !info.is_dir => return Err(io::Error::other("目标不是目录")),
            Some(_) => false,
            None => {
                let t = Instant::now();
                let result = fs::symlink_metadata(target);
                self.profile.target_stat_ns += t.elapsed().as_nanos() as u64;
                match result {
                    Ok(meta) if is_link(&meta) => {
                        return Err(io::Error::other(format!(
                            "不支持符号链接或目录联接: {}",
                            target.display()
                        )))
                    }
                    Ok(meta) if !meta.is_dir() => return Err(io::Error::other("目标不是目录")),
                    Ok(_) => false,
                    Err(e) if e.kind() == io::ErrorKind::NotFound => true,
                    Err(e) => return Err(e),
                }
            }
        };
        // 串行枚举。实测「每目录 spawn 两个线程并行读源/目标」是负收益：
        // 线程创建与汇合约 90µs/次，超过重叠 IO 的收益，热缓存下整体反而慢 33%。
        let t = Instant::now();
        let entries = fs::read_dir(source).and_then(|it| it.collect::<Result<Vec<_>, _>>());
        self.profile.source_read_dir_ns += t.elapsed().as_nanos() as u64;
        let t = Instant::now();
        // create_target 说明目标目录刚被判定为不存在，而 create_dir_all 在下面才执行，
        // 这次枚举必然 NotFound —— 直接跳过，首次全量备份时每目录省一次失败调用。
        let targets = if create_target {
            Ok(vec![])
        } else {
            match fs::read_dir(target) {
                Ok(v) => v.collect::<Result<Vec<_>, _>>(),
                Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(vec![]),
                Err(e) => Err(e),
            }
        };
        self.profile.target_read_dir_ns += t.elapsed().as_nanos() as u64;
        // 完整读取源目录后才允许创建目标目录，读取失败不能被当成空目录。
        let entries = entries?;
        if create_target && !self.dry {
            fs::create_dir_all(target)?;
        }
        let targets = targets?;
        // 目录枚举已经带回目标条目的大小和修改时间，缓存后逐文件比较无需再访问磁盘。
        let t = Instant::now();
        let mut target_index: HashMap<OsString, EntryInfo> = HashMap::with_capacity(targets.len());
        for entry in &targets {
            if let Ok(info) = entry_info(entry) {
                target_index.insert(entry.file_name(), info);
            }
        }
        self.profile.target_index_ns += t.elapsed().as_nanos() as u64;
        let t = Instant::now();
        let mut source_names: HashSet<OsString> = HashSet::with_capacity(entries.len());
        for entry in &entries {
            source_names.insert(entry.file_name());
        }
        self.profile.source_names_ns += t.elapsed().as_nanos() as u64;
        for entry in &targets {
            self.checkpoint()?;
            let name = entry.file_name();
            if self.excludes.matches(&name.to_string_lossy()) {
                continue;
            }
            if source_names.contains(&name) {
                continue;
            }
            let info = target_index.get(&name).copied().unwrap_or_default();
            if info.is_link {
                self.error(format!("清理失败 {}: 目标包含链接，拒绝清理", entry.path().display()));
                continue;
            }
            self.progress("cleaning", &entry.path());
            let result = if info.is_dir {
                self.remove_tree(&entry.path())
            } else if self.dry {
                Ok(true)
            } else {
                fs::remove_file(entry.path()).map(|_| true)
            };
            match result {
                Ok(true) => {
                    self.stats.items_deleted += 1;
                    (self.report)(
                        "info",
                        &format!(
                            "{}清理: {}",
                            if self.dry { "[演练] " } else { "" },
                            entry.path().display()
                        ),
                        &self.stats,
                    );
                }
                Ok(false) => {},
                Err(e) => self.error(format!("清理失败 {}: {e}", entry.path().display())),
            }
        }
        for entry in entries {
            self.checkpoint()?;
            let name = entry.file_name();
            if self.excludes.matches(&name.to_string_lossy()) {
                self.stats.items_ignored += 1;
                continue;
            }
            let src = entry.path();
            self.progress("scanning", &src);
            let dst = target.join(&name);
            let result = (|| {
                let info = entry_info(&entry)?;
                if info.is_link {
                    return Err(io::Error::other("源包含链接，未复制"));
                }
                if info.is_dir {
                    self.directory(&src, &dst, Some(&info), target_index.get(&name))
                } else if info.is_file {
                    self.file(&src, &dst, target_index.get(&name), &info)
                } else {
                    Err(io::Error::other("不支持的文件类型"))
                }
            })();
            if let Err(e) = result {
                if e.to_string() == INTERRUPTED {
                    return Err(e);
                }
                self.error(format!("处理失败 {}: {e}", src.display()));
            }
        }
        Ok(())
    }

    fn remove_tree(&self, path: &Path) -> io::Result<bool> {
        // 整棵树检查通过后才删除；含排除项的过期目录整体保留，避免连带删除。
        fn check(path: &Path, excludes: &ExcludeRules) -> io::Result<bool> {
            for entry in fs::read_dir(path)? {
                let entry = entry?;
                if excludes.matches(&entry.file_name().to_string_lossy()) {
                    return Ok(false);
                }
                // entry_info 复用目录枚举结果（Windows 上不产生额外系统调用）；
                // 原来的 symlink_metadata 是逐条真 syscall，而清理只发生在整棵过期目录上。
                let info = entry_info(&entry)?;
                if info.is_link {
                    return Err(io::Error::other("待清理目录包含链接"));
                }
                if info.is_dir && !check(&entry.path(), excludes)? {
                    return Ok(false);
                }
            }
            Ok(true)
        }
        if !check(path, self.excludes)? {
            return Ok(false);
        }
        if !self.dry {
            fs::remove_dir_all(path)?;
        }
        Ok(true)
    }

    // src_info 来自父目录的枚举结果（Windows 上不产生额外系统调用），
    // 因此这里不再对源文件单独 fs::metadata —— 实测那一步占原扫描总耗时约 45%。
    fn file(&mut self, source: &Path, target: &Path, existing: Option<&EntryInfo>, src_info: &EntryInfo) -> io::Result<()> {
        self.checkpoint()?;
        self.progress("comparing", source);
        self.profile.files += 1;
        let src_len = src_info.len;
        let src_modified = src_info
            .modified
            .ok_or_else(|| io::Error::other("源文件缺少修改时间"))?;
        let mut source_hash = None;
        // 目标侧信息来自所在目录的枚举结果，这里不再单独访问目标文件。
        let copy = match existing {
            Some(d) if d.is_link => return Err(io::Error::other("目标包含链接")),
            Some(d) if !d.is_file => return Err(io::Error::other("目标不是文件")),
            Some(d) if src_len != d.len => true,
            Some(d) if d.modified == Some(src_modified) => false,
            Some(_) if self.use_hash => {
                let h = hash(source)?;
                let changed = h != hash(target)?;
                source_hash = Some(h);
                changed
            }
            _ => true,
        };
        if copy {
            self.progress("hashing", source);
            if !self.dry && self.use_hash && source_hash.is_none() {
                source_hash = Some(hash(source)?);
            }
            if !self.dry {
                self.progress("copying", source);
                let parent = target
                    .parent()
                    .ok_or_else(|| io::Error::other("目标无父目录"))?;
                let tmp = tempfile::NamedTempFile::new_in(parent)?;
                fs::copy(source, tmp.path())?;
                // 复制完成后重新核对一次源文件，确认复制期间它没有变化。
                let after = fs::metadata(source)?;
                if src_len != after.len() || src_modified != after.modified()? {
                    return Err(io::Error::other("源文件在复制期间变化，将在下次备份重试"));
                }
                tmp.as_file()
                    .set_times(fs::FileTimes::new().set_modified(src_modified))?;
                tmp.as_file().sync_all()?;
                tmp.persist(target).map_err(|e| e.error)?;
            }
            self.stats.files_copied += 1;
            self.stats.total_bytes += src_len;
            (self.report)(
                "info",
                &format!(
                    "{}更新: {}",
                    if self.dry { "[演练] " } else { "" },
                    source.display()
                ),
                &self.stats,
            );
        } else {
            self.stats.files_skipped += 1;
            self.stats.saved_bytes += src_len;
        }
        // 无论复制还是跳过都记进本轮快照：state 的价值在于「当前源目录长什么样」，
        // 只记复制过的文件会让快照随时间失真。dry 模式不落盘，也就不必构造。
        if !self.dry {
            self.record(source, src_len, src_modified, source_hash);
        }
        self.mark_processed();
        Ok(())
    }

    /// 记录本轮遍历到的一个源文件。
    ///
    /// state 目前不参与增量判断（比较完全走目标目录枚举），所以这里只维护「本轮快照」，
    /// 不再像以前那样只增不减地累积 —— 旧写法会让已删除的任务、被排除规则命中的旧记录
    /// 永远留在文件里（2026-09-22 实测 33 508 条中有 32 233 条已永不会再被扫描到）。
    fn record(&mut self, source: &Path, len: u64, modified: SystemTime, hash: Option<String>) {
        let key = source.to_string_lossy().into_owned();
        // 跳过复制的文件这一轮没有重算哈希，沿用上一轮的记录（仅大小一致才沿用）。
        // 否则同一份内容会每轮在 hash「有值 / null」之间摆动，快照永远不等于上一轮，
        // state 就会被反复重写。
        let hash = hash.or_else(|| {
            let previous = self.state.get(key.as_str())?;
            if previous["size"].as_u64() != Some(len) {
                return None;
            }
            previous["hash"].as_str().map(str::to_owned)
        });
        self.rebuilt.insert(
            key,
            json!({
                "size": len,
                "mtimeMs": modified.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs_f64() * 1000.0,
                "hash": hash,
            }),
        );
    }
}

#[cfg(test)]
pub fn run(
    tasks: &[Task],
    state_file: &Path,
    dry: bool,
    use_hash: bool,
    report: &mut dyn FnMut(&str, &str, &Stats),
) -> Stats {
    let excludes = ExcludeRules::from_config(&json!(DEFAULT_EXCLUDE_PATTERNS)).unwrap();
    run_controlled(tasks, state_file, dry, use_hash, &excludes, report, &mut |_| true).stats
}

pub fn run_controlled(
    tasks: &[Task],
    state_file: &Path,
    dry: bool,
    use_hash: bool,
    excludes: &ExcludeRules,
    report: &mut dyn FnMut(&str, &str, &Stats),
    control: &mut dyn FnMut(&Stats) -> bool,
) -> RunOutcome {
    let mut engine = Engine {
        stats: Stats {
            start_time: chrono::Local::now().timestamp_millis(),
            progress: Progress { phase: "local", tasks_total: tasks.len(), ..Default::default() },
            ..Default::default()
        },
        profile: StageProfile::default(),
        state: json!({}),
        rebuilt: Map::new(),
        dry,
        use_hash,
        excludes,
        report,
        control: Some(control),
        last_report: None,
        reported_stage: "",
        reported_task: 0,
    };
    let mut interrupted = false;
    let result = (|| -> Result<(), String> {
        validate_tasks(tasks)?;
        let state_missing = !state_file.exists();
        let t = Instant::now();
        engine.state = read_state(state_file)?;
        engine.profile.state_read_ns = t.elapsed().as_nanos() as u64;
        for (index, task) in tasks.iter().enumerate() {
            if let Err(e) = engine.checkpoint() {
                if e.to_string() == INTERRUPTED {
                    interrupted = true;
                    break;
                }
                return Err(e.to_string());
            }
            engine.stats.progress.task_index = index + 1;
            engine.stats.progress.task_source = task.source.clone();
            let source = Path::new(&task.source);
            let backup = Path::new(&task.backup);
            // 顶层校验整条祖先链，目录递归内部只校验自身。
            let checked = no_links(source).and_then(|_| no_links(backup));
            let outcome = checked.and_then(|_| engine.directory(source, backup, None, None));
            if let Err(e) = outcome {
                if e.to_string() == INTERRUPTED {
                    interrupted = true;
                    break;
                }
                engine.error(format!("任务失败 {}: {e}", task.source));
            }
            engine.stats.progress.tasks_done = index + 1;
            engine.progress("task-finished", source);
        }
        // 状态重建：直接用本轮遍历结果覆盖，而不是往旧状态里增量追加。
        // 中断时同样落盘，保住中断点之前已经完成的遍历（与旧行为一致）。
        // 空快照只在文件本来就不存在时才写，免得把一份已有记录清成空文件。
        let rebuilt = Value::Object(std::mem::take(&mut engine.rebuilt));
        let empty = rebuilt.as_object().is_some_and(|entries| entries.is_empty());
        if !dry && (state_missing || (!empty && rebuilt != engine.state)) {
            engine.progress("saving", state_file);
            let t = Instant::now();
            write_json_compact(state_file, &rebuilt)?;
            engine.profile.state_write_ns = t.elapsed().as_nanos() as u64;
        }
        Ok(())
    })();
    if let Err(e) = result {
        engine.error(e);
    }
    RunOutcome { stats: engine.stats, interrupted, profile: engine.profile }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn progress_reports_current_path_before_work_and_counts_selected_tasks() {
        let (root, mut tasks, state) = setup();
        let source = Path::new(&tasks[0].source).join("file.txt");
        let target = Path::new(&tasks[0].backup).join("file.txt");
        fs::write(&source, "progress").unwrap();
        let empty = root.path().join("empty");
        fs::create_dir(&empty).unwrap();
        tasks.push(Task { source: empty.to_string_lossy().into(), backup: root.path().join("empty-backup").to_string_lossy().into(), quark_enabled: false });
        let mut events = Vec::new();
        let first = run(&tasks, &state, false, true, &mut |_, _, stats| {
            let p = &stats.progress;
            if p.stage == "copying" && stats.files_copied == 0 { assert!(!target.exists(), "report before copying starts"); }
            events.push(p.clone());
        });
        assert_eq!(first.errors, 0);
        assert_eq!(first.progress.tasks_total, 2);
        assert_eq!(first.progress.tasks_done, 2);
        assert_eq!(first.progress.files_processed, 1);
        assert!(events.iter().any(|p| p.stage == "copying" && Path::new(&p.current_path) == source && p.task_index == 1));
        assert!(events.iter().any(|p| p.stage == "scanning" && Path::new(&p.current_path) == empty && p.task_index == 2));
        assert!(serde_json::to_value(&first).unwrap().get("progress").is_none(), "progress is not historical statistics");
        let second = run(&tasks[..1], &state, false, true, &mut |_, _, _| {});
        assert_eq!(second.files_skipped, 1);
        assert_eq!(second.progress.tasks_total, 1);
        assert_eq!(second.progress.tasks_done, 1);
        assert_eq!(second.progress.files_processed, 1);
    }

    #[test]
    fn progress_handles_empty_selection_dry_run_and_failed_tasks() {
        let (_root, tasks, state) = setup();
        fs::write(Path::new(&tasks[0].source).join("dry.txt"), "dry").unwrap();
        let dry = run(&tasks, &state, true, true, &mut |_, _, _| {});
        assert_eq!(dry.progress.files_processed, 1);
        assert_eq!(dry.progress.tasks_done, 1);
        assert!(!Path::new(&tasks[0].backup).exists());
        let none = run(&[], &state, true, true, &mut |_, _, _| {});
        assert_eq!(none.progress.tasks_total, 0);
        assert_eq!(none.progress.tasks_done, 0);
        fs::remove_dir_all(&tasks[0].source).unwrap();
        let failed = run(&tasks, &state, false, true, &mut |_, _, _| {});
        assert_eq!(failed.errors, 1);
        assert_eq!(failed.progress.tasks_done, 1);
        assert_eq!(failed.progress.task_source, tasks[0].source);
    }

    #[test]
    fn controlled_run_stops_at_a_file_boundary_and_persists_completed_work() {
        let (_root, tasks, state) = setup();
        let source = Path::new(&tasks[0].source);
        fs::write(source.join("a.txt"), "first").unwrap();
        fs::write(source.join("b.txt"), "second").unwrap();
        let mut checks = 0;
        let outcome = run_controlled(
            &tasks,
            &state,
            false,
            true,
            &ExcludeRules::from_config(&json!(DEFAULT_EXCLUDE_PATTERNS)).unwrap(),
            &mut |_, _, _| {},
            &mut |_| {
                checks += 1;
                checks <= 4
            },
        );
        assert!(outcome.interrupted);
        assert_eq!(outcome.stats.errors, 0);
        assert!(state.exists());
        let resumed = run(&tasks, &state, false, true, &mut |_, _, _| {});
        assert_eq!(resumed.errors, 0);
        assert!(Path::new(&tasks[0].backup).join("a.txt").exists());
        assert!(Path::new(&tasks[0].backup).join("b.txt").exists());
    }
    fn setup() -> (tempfile::TempDir, Vec<Task>, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        fs::create_dir(&source).unwrap();
        let tasks = vec![Task {
            source: source.to_string_lossy().into(),
            backup: root.path().join("backup").to_string_lossy().into(),
            quark_enabled: false,
        }];
        let state = root.path().join("state.json");
        (root, tasks, state)
    }
    #[test]
    fn custom_state_path_safety() {
        let (root, tasks, state) = setup();
        assert!(validate_state_file(&state, root.path(), &tasks).is_ok());
        assert!(validate_state_file(Path::new("relative.json"), root.path(), &tasks).is_err());
        assert!(validate_state_file(&root.path().join("backup.config.json"), root.path(), &tasks).is_err());
        assert!(validate_state_file(&Path::new(&tasks[0].backup).join("state.json"), root.path(), &tasks).is_err());
        fs::write(&state, br#"{"theme":"forest"}"#).unwrap();
        assert!(validate_state_file(&state, root.path(), &tasks).is_err());
        assert_eq!(fs::read_to_string(&state).unwrap(), r#"{"theme":"forest"}"#);
        write_json(&state, &json!({"file":{"size":1,"mtimeMs":2,"hash":null}})).unwrap();
        assert!(validate_state_file(&state, root.path(), &tasks).is_ok());
    }

    #[test]
    fn incremental_cleanup_and_legacy_state() {
        let (_root, tasks, state) = setup();
        let src = Path::new(&tasks[0].source);
        let dst = Path::new(&tasks[0].backup);
        fs::write(src.join("a.txt"), "hello").unwrap();
        fs::write(src.join("a.log"), "ignored").unwrap();
        write_json(
            &state,
            &json!({"old-path":{"size":1,"mtimeMs":10,"hash":"old"}}),
        )
        .unwrap();
        let first = run(&tasks, &state, false, true, &mut |_, _, _| {});
        assert_eq!(
            (first.files_copied, first.items_ignored, first.errors),
            (1, 1, 0)
        );
        let second = run(&tasks, &state, false, true, &mut |_, _, _| {});
        assert_eq!((second.files_skipped, second.saved_bytes), (1, 5));
        // 状态每轮重建而不是累积：遗留的无效条目（任务已删除、规则已变更）会被清掉，
        // 只留下本轮真正遍历到的源文件。
        let entries = read_json(&state, json!({})).unwrap();
        assert!(entries.get("old-path").is_none());
        assert!(entries.get(src.join("a.txt").to_string_lossy().as_ref()).is_some());
        fs::remove_file(src.join("a.txt")).unwrap();
        let third = run(&tasks, &state, false, true, &mut |_, _, _| {});
        assert_eq!(third.items_deleted, 1);
        assert!(!dst.join("a.txt").exists());
    }
    #[test]
    fn missing_source_preserves_target() {
        let (_root, tasks, state) = setup();
        fs::remove_dir(&tasks[0].source).unwrap();
        fs::create_dir(&tasks[0].backup).unwrap();
        let keep = Path::new(&tasks[0].backup).join("keep");
        fs::write(&keep, "keep").unwrap();
        let stats = run(&tasks, &state, false, true, &mut |_, _, _| {});
        assert_eq!(stats.errors, 1);
        assert_eq!(fs::read_to_string(keep).unwrap(), "keep");
    }

    #[test]
    fn unchanged_backup_does_not_rewrite_state() {
        let (_root, tasks, state) = setup();
        fs::write(Path::new(&tasks[0].source).join("a.txt"), "hello").unwrap();
        assert_eq!(run(&tasks, &state, false, true, &mut |_, _, _| {}).errors, 0);
        let before = fs::read(&state).unwrap();
        fs::File::options().write(true).open(&state).unwrap()
            .set_times(fs::FileTimes::new().set_modified(UNIX_EPOCH + std::time::Duration::from_secs(100)))
            .unwrap();
        let modified = fs::metadata(&state).unwrap().modified().unwrap();

        let stats = run(&tasks, &state, false, true, &mut |_, _, _| {});
        assert_eq!((stats.files_skipped, stats.errors), (1, 0));
        assert_eq!(fs::metadata(&state).unwrap().modified().unwrap(), modified);
        assert_eq!(fs::read(&state).unwrap(), before);

        fs::write(Path::new(&tasks[0].source).join("a.txt"), "changed").unwrap();
        assert_eq!(run(&tasks, &state, false, true, &mut |_, _, _| {}).files_copied, 1);
        assert_eq!(read_json(&state, json!({})).unwrap()[Path::new(&tasks[0].source).join("a.txt").to_string_lossy().as_ref()]["size"], 7);
    }

    #[test]
    fn invalid_state_entries_prevent_cleanup() {
        let (_root, tasks, state) = setup();
        fs::create_dir(&tasks[0].backup).unwrap();
        let keep = Path::new(&tasks[0].backup).join("keep.txt");
        fs::write(&keep, "keep").unwrap();
        let invalid = br#"{"file":{"size":"invalid","mtimeMs":1,"hash":null}}"#;
        fs::write(&state, invalid).unwrap();
        assert_eq!(run(&tasks, &state, false, true, &mut |_, _, _| {}).errors, 1);
        assert_eq!(fs::read_to_string(keep).unwrap(), "keep");
        assert_eq!(fs::read(&state).unwrap(), invalid);
    }

    #[test]
    fn dry_run_writes_nothing() {
        let (_root, tasks, state) = setup();
        fs::write(Path::new(&tasks[0].source).join("a"), "hello").unwrap();
        let stats = run(&tasks, &state, true, true, &mut |_, _, _| {});
        assert_eq!(stats.files_copied, 1);
        assert!(!Path::new(&tasks[0].backup).exists());
        assert!(!state.exists());
    }
    #[test]
    fn overlap_and_corrupt_state_rejected() {
        let (_root, tasks, state) = setup();
        let nested = vec![Task {
            source: tasks[0].source.clone(),
            quark_enabled: false,
            backup: Path::new(&tasks[0].source)
                .join("nested")
                .to_string_lossy()
                .into(),
        }];
        assert!(validate_tasks(&nested).is_err());
        fs::write(&state, "broken").unwrap();
        assert_eq!(
            run(&tasks, &state, false, true, &mut |_, _, _| {}).errors,
            1
        );
        assert_eq!(fs::read_to_string(state).unwrap(), "broken");
    }
    #[test]
    fn hash_compares_equal_sized_files() {
        let (_root, tasks, state) = setup();
        let src = Path::new(&tasks[0].source).join("a");
        fs::write(&src, "same").unwrap();
        run(&tasks, &state, false, true, &mut |_, _, _| {});
        fs::File::options()
            .write(true)
            .open(&src)
            .unwrap()
            .set_times(
                fs::FileTimes::new().set_modified(UNIX_EPOCH + std::time::Duration::from_secs(100)),
            )
            .unwrap();
        assert_eq!(
            run(&tasks, &state, false, true, &mut |_, _, _| {}).files_skipped,
            1
        );
        fs::write(&src, "diff").unwrap();
        assert_eq!(
            run(&tasks, &state, false, true, &mut |_, _, _| {}).files_copied,
            1
        );
    }

    #[test]
    fn explicit_empty_selection_and_dry_cleanup() {
        let (_root, tasks, state) = setup();
        let target = Path::new(&tasks[0].backup);
        assert_eq!(run(&[], &state, false, true, &mut |_,_,_| {}).files_copied, 0);
        assert!(!target.exists());
        fs::create_dir(target).unwrap();
        fs::write(target.join("stale"), "keep during dry run").unwrap();
        let before = fs::read(&state).unwrap();
        assert_eq!(run(&tasks, &state, true, true, &mut |_,_,_| {}).items_deleted, 1);
        assert!(target.join("stale").exists());
        assert_eq!(fs::read(&state).unwrap(), before);
    }

    #[test]
    fn default_ignore_patterns_match_legacy_dot_rules() {
        let rules = ExcludeRules::from_config(&json!(DEFAULT_EXCLUDE_PATTERNS)).unwrap();
        for name in ["node_modules", ".gitignore", ".env.local", "a.log", "Thumbs.db", "dist"] {
            assert!(rules.matches(name), "{name}");
        }
        for name in [".hidden.log", "app.js", "README.md", "package-lock.json"] {
            assert!(!rules.matches(name), "{name}");
        }
    }

    #[test]
    fn custom_excludes_skip_nested_trees_and_empty_rules_restore_copying() {
        let (_root, tasks, state) = setup();
        let src = Path::new(&tasks[0].source);
        let dst = Path::new(&tasks[0].backup);
        for name in ["project/node_modules", "project/.git", "project/.svn"] {
            fs::create_dir_all(src.join(name)).unwrap();
            fs::write(src.join(name).join("keep.txt"), "excluded tree").unwrap();
        }
        fs::write(src.join("project/data.zip"), "archive").unwrap();
        fs::write(src.join("project/app.js"), "code").unwrap();
        fs::write(src.join("project/app.log"), "custom rules replace defaults").unwrap();
        let rules = ExcludeRules::from_config(&json!(["node_modules", ".git", ".svn", "*.zip"])).unwrap();
        let dry = run_controlled(&tasks, &state, true, true, &rules, &mut |_, _, _| {}, &mut |_| true).stats;
        assert_eq!((dry.files_copied, dry.items_ignored, dry.errors), (2, 4, 0));
        assert!(!dst.exists());
        assert!(!state.exists());
        let actual = run_controlled(&tasks, &state, false, true, &rules, &mut |_, _, _| {}, &mut |_| true).stats;
        assert_eq!((actual.files_copied, actual.items_ignored, actual.errors), (2, 4, 0));
        assert!(dst.join("project/app.log").exists());
        for name in ["node_modules", ".git", ".svn", "data.zip"] {
            assert!(!dst.join("project").join(name).exists());
        }
        let all = ExcludeRules::from_config(&json!([])).unwrap();
        let restored = run_controlled(&tasks, &state, false, true, &all, &mut |_, _, _| {}, &mut |_| true).stats;
        assert_eq!((restored.files_copied, restored.files_skipped, restored.items_ignored, restored.errors), (4, 2, 0, 0));
        assert!(dst.join("project/node_modules/keep.txt").exists());
    }

    #[test]
    fn excluded_targets_and_their_missing_ancestors_are_preserved() {
        let (_root, tasks, state) = setup();
        let src = Path::new(&tasks[0].source);
        let dst = Path::new(&tasks[0].backup);
        fs::create_dir_all(dst.join("old/nested/node_modules")).unwrap();
        fs::write(dst.join("old/nested/node_modules/keep.txt"), "keep").unwrap();
        fs::write(dst.join("cache.zip"), "old archive").unwrap();
        fs::write(dst.join("only-target.zip"), "keep").unwrap();
        fs::write(dst.join("stale.txt"), "remove").unwrap();
        fs::write(src.join("cache.zip"), "new archive").unwrap();
        let rules = ExcludeRules::from_config(&json!(["node_modules", "*.zip"])).unwrap();
        for dry in [true, false] {
            let stats = run_controlled(&tasks, &state, dry, true, &rules, &mut |_, _, _| {}, &mut |_| true).stats;
            assert_eq!((stats.files_copied, stats.items_deleted, stats.errors), (0, 1, 0));
            assert_eq!(fs::read_to_string(dst.join("cache.zip")).unwrap(), "old archive");
            assert!(dst.join("only-target.zip").exists());
            assert!(dst.join("old/nested/node_modules/keep.txt").exists());
            assert_eq!(dst.join("stale.txt").exists(), dry);
        }
    }

    #[test]
    fn invalid_exclude_rules_are_rejected() {
        for value in [json!(null), json!("*.log"), json!([42]), json!([""]), json!(["  "]), json!(["src/cache"]), json!(["src\\cache"]), json!(["[broken"]), json!([".."])] {
            assert!(ExcludeRules::from_config(&value).is_err(), "{value}");
        }
        let rules = ExcludeRules::from_config(&json!([" *.zip ", ".git"])).unwrap();
        assert!(rules.matches("data.zip"));
        assert!(!rules.matches("data.ZIP"));
        assert!(!rules.matches(".hidden.zip"));
        assert!(rules.matches(".git"));
        assert!(!rules.matches(".github"));
    }

    #[cfg(windows)]
    #[test]
    fn locked_cleanup_keeps_copying_other_files() {
        use std::os::windows::fs::OpenOptionsExt;
        let (_root, tasks, state) = setup();
        let source = Path::new(&tasks[0].source);
        let target = Path::new(&tasks[0].backup);
        fs::create_dir(target).unwrap();
        fs::write(target.join("stale"), "locked").unwrap();
        fs::write(source.join("fresh"), "fresh").unwrap();
        let lock = fs::OpenOptions::new().read(true).share_mode(0).open(target.join("stale")).unwrap();
        let stats = run(&tasks, &state, false, true, &mut |_,_,_| {});
        assert_eq!(stats.errors, 1);
        assert_eq!(stats.files_copied, 1);
        assert_eq!(fs::read_to_string(target.join("fresh")).unwrap(), "fresh");
        drop(lock);
    }

    // 手动性能基准（演练模式，不写入目标）：
    //   BACKY_PERF_PAIRS="D:\源=>E:\目标" cargo test -- --ignored --nocapture perf_scan_of_real_tasks
    // 可选 BACKY_PERF_EXCLUDES="target,node_modules" 覆盖排除规则（逗号分隔）。
    #[test]
    #[ignore]
    fn perf_scan_of_real_tasks() {
        let raw = match std::env::var("BACKY_PERF_PAIRS") {
            Ok(v) if !v.trim().is_empty() => v,
            _ => {
                eprintln!("未设置 BACKY_PERF_PAIRS，示例：BACKY_PERF_PAIRS=\"D:\\src=>E:\\dst\"");
                return;
            }
        };
        let tasks: Vec<Task> = raw
            .split(';')
            .filter_map(|pair| {
                let (source, backup) = pair.split_once("=>")?;
                Some(Task {
                    source: source.trim().to_owned(),
                    backup: backup.trim().to_owned(),
                    quark_enabled: false,
                })
            })
            .collect();
        assert!(!tasks.is_empty(), "BACKY_PERF_PAIRS 格式应为「源=>目标」，多个任务用分号分隔");
        let excludes = match std::env::var("BACKY_PERF_EXCLUDES") {
            Ok(v) => ExcludeRules::from_config(&json!(v
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()))
            .unwrap(),
            Err(_) => ExcludeRules::from_config(&json!(DEFAULT_EXCLUDE_PATTERNS)).unwrap(),
        };
        let use_hash = std::env::var("BACKY_PERF_HASH").map(|v| v != "0").unwrap_or(true);
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().join("state.json");
        let started = std::time::Instant::now();
        let outcome = run_controlled(&tasks, &state, true, use_hash, &excludes, &mut |_, _, _| {}, &mut |_| true);
        let elapsed = started.elapsed();
        let stats = outcome.stats;
        let p = outcome.profile;
        let ms = |ns: u64| ns as f64 / 1e6;
        eprintln!(
            "扫描 {:?}（hash={}）：跳过 {}、待复制 {}、忽略 {}、错误 {}",
            elapsed, use_hash, stats.files_skipped, stats.files_copied, stats.items_ignored, stats.errors
        );
        eprintln!("  实际遍历 目录 {} / 文件 {}", p.dirs, p.files);
        eprintln!(
            "  源read_dir {:.1}ms | 目标read_dir {:.1}ms | 目标索引 {:.1}ms | 源名字集 {:.1}ms",
            ms(p.source_read_dir_ns), ms(p.target_read_dir_ns), ms(p.target_index_ns), ms(p.source_names_ns)
        );
        eprintln!(
            "  源目录stat {:.1}ms | 目标目录stat {:.1}ms | 文件stat {:.1}ms | state读 {:.1}ms | state写 {:.1}ms",
            ms(p.dir_stat_ns), ms(p.target_stat_ns), ms(p.source_meta_ns), ms(p.state_read_ns), ms(p.state_write_ns)
        );
    }

    // 目录枚举吞吐基准：串行读取真实目录树，用于复测 read_dir 是否仍是扫描瓶颈。
    // 用法：BACKY_PERF_PAIRS="D:\src=>E:\dst" BACKY_AB_LIMIT=2000
    #[test]
    #[ignore]
    fn perf_readdir_throughput() {
        let raw = std::env::var("BACKY_PERF_PAIRS").unwrap_or_default();
        let limit: usize = std::env::var("BACKY_AB_LIMIT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(2000);
        let mut pairs: Vec<(PathBuf, PathBuf)> = Vec::new();
        for pair in raw.split(';') {
            let Some((src, dst)) = pair.split_once("=>") else {
                continue;
            };
            let mut queue = vec![(PathBuf::from(src.trim()), PathBuf::from(dst.trim()))];
            while let Some((s, d)) = queue.pop() {
                if pairs.len() >= limit {
                    break;
                }
                if let Ok(it) = fs::read_dir(&s) {
                    for entry in it.flatten() {
                        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                            queue.push((entry.path(), d.join(entry.file_name())));
                        }
                    }
                }
                pairs.push((s, d));
            }
        }
        assert!(!pairs.is_empty(), "未收集到目录对，请检查 BACKY_PERF_PAIRS");
        eprintln!("已收集 {} 个 (源, 目标) 目录对", pairs.len());
        for round in 1..=3 {
            let mut items = 0u64;
            let t = std::time::Instant::now();
            for (s, d) in &pairs {
                items += fs::read_dir(s).map(|it| it.count() as u64).unwrap_or(0);
                items += fs::read_dir(d).map(|it| it.count() as u64).unwrap_or(0);
            }
            let elapsed = t.elapsed();
            eprintln!(
                "第{round}轮  串行 {:>9.1?}（条目 {items}，{} 对，平均 {:.0?}/对）",
                elapsed,
                pairs.len(),
                elapsed / pairs.len() as u32
            );
        }
    }
}
