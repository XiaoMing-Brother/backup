use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use md5::{Digest, Md5};
use reqwest::blocking::{Client, RequestBuilder};
use serde_json::{json, Value};
use sha1::Sha1;
use sha2::Sha256;
use std::{
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::Duration,
};

const API: &str = "https://drive-pc.quark.cn/1/clouddrive";
const UPLOAD_USER_AGENT: &str = "aliyun-sdk-js/6.6.1 Chrome 98.0.4758.80 on Windows 10 64-bit";
const UPLOAD_ATTEMPTS: usize = 4;
const LIST_PAGE_SIZE: usize = 100;
pub const INTERRUPTED: &str = "夸克上传已中止";

pub fn validate_cookie(cookie: &str) -> Result<(), String> {
    if cookie.trim().is_empty() {
        return Err("未获取到夸克登录态".into());
    }
    let response = Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?
        .get("https://pan.quark.cn/account/info")
        .header("Cookie", cookie)
        .query(&[("fr", "pc"), ("platform", "pc")])
        .send()
        .map_err(|e| format!("验证夸克登录态失败: {e}"))?;
    let success = response.status().is_success();
    let body: Value = response
        .json()
        .map_err(|e| format!("夸克登录响应无效: {e}"))?;
    if success && valid_account(&body) {
        Ok(())
    } else {
        Err("夸克登录态无效，请重新扫码".into())
    }
}

fn valid_account(body: &Value) -> bool {
    body["data"].as_object().is_some_and(|data| !data.is_empty())
        && body["code"].as_i64().is_none_or(|code| code == 0)
        && body["status"].as_u64().is_none_or(|status| status < 400)
}

struct Drive {
    client: Client,
    cookie: String,
    api: String,
    #[cfg(test)]
    upload_origin: Option<String>,
}
impl Drive {
    fn new(cookie: String) -> Result<Self, String> {
        Ok(Self {
            client: Client::builder()
                .timeout(Duration::from_secs(90))
                .build()
                .map_err(|e| e.to_string())?,
            cookie,
            api: API.into(),
            #[cfg(test)]
            upload_origin: None,
        })
    }
    fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
        query: &[(&str, String)],
    ) -> Result<Value, String> {
        let mut req = self
            .client
            .request(method, format!("{}{path}", self.api))
            .header("Cookie", &self.cookie)
            .header("Referer", "https://pan.quark.cn/")
            .header("User-Agent", "Mozilla/5.0")
            .header("Accept", "application/json, text/plain, */*")
            .query(&[("pr", "ucpro"), ("fr", "pc"), ("uc_param_str", "")]);
        for (k, v) in query {
            req = req.query(&[(k, v)]);
        }
        if let Some(value) = body {
            req = req.json(&value);
        }
        let response = req.send().map_err(|e| format!("夸克请求失败: {e}"))?;
        let status = response.status();
        let value: Value = response
            .json()
            .map_err(|_| format!("夸克响应无效: {path}, HTTP {status}"))?;
        if !status.is_success()
            || value["status"].as_u64().is_some_and(|s| s >= 400)
            || value["code"].as_i64() != Some(0)
        {
            return Err(value
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("夸克请求失败")
                .to_owned());
        }
        Ok(value)
    }
    fn children(&self, parent: &str) -> Result<Vec<Value>, String> {
        let mut entries = Vec::new();
        for page in 1.. {
            let list = self.request(
                reqwest::Method::GET,
                "/file/sort",
                None,
                &[
                    ("pdir_fid", parent.into()),
                    ("_page", page.to_string()),
                    ("_size", LIST_PAGE_SIZE.to_string()),
                    ("_fetch_total", "1".into()),
                ],
            )?;
            let page_entries = list["data"]["list"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let page_len = page_entries.len();
            entries.extend(page_entries);
            if page_len < LIST_PAGE_SIZE {
                break;
            }
        }
        Ok(entries)
    }

    fn create_child(&self, parent: &str, name: &str) -> Result<String, String> {
        let made = self.request(
            reqwest::Method::POST,
            "/file",
            Some(json!({"pdir_fid":parent,"file_name":name,"dir_init_lock":false,"dir_path":""})),
            &[],
        )?;
        made["data"]["fid"]
            .as_str()
            .map(str::to_owned)
            .ok_or("创建夸克目录失败".into())
    }

    fn child(&self, parent: &str, name: &str) -> Result<String, String> {
        let entries = self.children(parent)?;
        if let Some(fid) = entries
            .iter()
            .find(|x| x["dir"].as_bool() == Some(true) && x["file_name"].as_str() == Some(name))
            .and_then(|x| x["fid"].as_str())
        {
            return Ok(fid.into());
        }
        self.create_child(parent, name)
    }

    fn upload_request(
        &self,
        path: &str,
        body: Value,
        report: &mut dyn FnMut(String),
    ) -> Result<Value, String> {
        for attempt in 1..=UPLOAD_ATTEMPTS {
            match self.request(reqwest::Method::POST, path, Some(body.clone()), &[]) {
                Ok(value) => return Ok(value),
                Err(error) => {
                    // 仅重试服务端明确返回的锁超时，网络断开等结果不明的请求不盲目重发。
                    if error == "complete_upload_lock_timeout" && attempt < UPLOAD_ATTEMPTS {
                        retry_delay(path, attempt, &error, report);
                    } else {
                        return Err(format!("{path}: {error}"));
                    }
                }
            }
        }
        unreachable!()
    }

    fn upload(
        &self,
        local: &Path,
        parent: &str,
        report: &mut dyn FnMut(String),
        control: &mut dyn FnMut() -> bool,
    ) -> Result<(), String> {
        let meta = fs::metadata(local).map_err(|e| e.to_string())?;
        let name = local
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or("文件名无效")?;
        // 先计算摘要再创建上传任务，避免大文件哈希耗时消耗服务端上下文的有效期。
        let mut file = fs::File::open(local).map_err(|e| e.to_string())?;
        let (mut md5, mut sha1) = (Md5::new(), Sha1::new());
        let mut buffer = [0u8; 64 * 1024];
        loop {
            check_control(control)?;
            let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            md5.update(&buffer[..n]);
            sha1.update(&buffer[..n]);
        }
        let pre = self.upload_request("/file/upload/pre", json!({"ccp_hash_update":true,"pdir_fid":parent,"dir_name":"","size":meta.len(),"file_name":name,"format_type":"application/octet-stream","l_updated_at":chrono::Utc::now().timestamp_millis(),"l_created_at":chrono::Utc::now().timestamp_millis()}), report)?;
        let data = &pre["data"];
        if data["finish"].as_bool() == Some(true) {
            return Ok(());
        }
        let task = data["task_id"].as_str().ok_or("夸克预上传缺少任务 ID")?;
        let hash_body = json!({
            "task_id":task, "md5":format!("{:x}", md5.finalize()), "sha1":format!("{:x}", sha1.finalize())
        });
        let hash = self.upload_request("/file/update/hash", hash_body.clone(), report)?;
        if hash["data"]["finish"].as_bool() == Some(true) {
            return Ok(());
        }
        file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
        let bucket = data["bucket"].as_str().ok_or("夸克预上传缺少存储桶")?;
        let key = data["obj_key"].as_str().ok_or("夸克预上传缺少对象")?;
        let upload_id = data["upload_id"].as_str().ok_or("夸克预上传缺少上传 ID")?;
        let endpoint = data["upload_url"]
            .as_str()
            .ok_or("夸克预上传缺少存储地址")?;
        let object_url = upload_url(endpoint, bucket, key)?;
        #[cfg(test)]
        let object_url = self
            .upload_origin
            .as_ref()
            .map_or(object_url, |origin| format!("{origin}/{key}"));
        let part_size = pre["metadata"]["part_size"]
            .as_u64()
            .filter(|n| *n > 0 && *n <= 64 * 1024 * 1024)
            .ok_or("夸克预上传分片大小无效")?;
        let part_count = meta.len().div_ceil(part_size).max(1);
        if part_count > 10000 {
            return Err("文件超过夸克分片数量限制".into());
        }
        let callback = data
            .get("callback")
            .filter(|v| v.is_object())
            .ok_or("夸克预上传缺少完成回调")?;
        let mut parts = String::from("<CompleteMultipartUpload>");
        for number in 1..=part_count {
            check_control(control)?;
            let expected = (meta.len().saturating_sub((number - 1) * part_size)).min(part_size);
            let mut bytes = vec![0; expected as usize];
            file.read_exact(&mut bytes)
                .map_err(|e| format!("读取上传分片失败: {e}"))?;
            let resource = format!("/{bucket}/{key}?partNumber={number}&uploadId={upload_id}");
            let mut attempt = 1;
            let headers = loop {
                check_control(control)?;
                let request = self
                    .client
                    .put(&object_url)
                    .query(&[
                        ("partNumber", number.to_string()),
                        ("uploadId", upload_id.to_owned()),
                    ])
                    .header("Content-Type", "application/octet-stream")
                    .body(bytes.clone());
                match self.oss_request(data, request, &resource, "上传分片", report) {
                    Ok((headers, _)) => break headers,
                    Err(error)
                        if error.contains("(NoHashContext)") && attempt < UPLOAD_ATTEMPTS =>
                    {
                        retry_delay(&format!("第 {number} 个分片"), attempt, &error, report);
                        // 保留 task_id、upload_id 和分片内容，仅恢复摘要并重新签名当前分片。
                        let hash =
                            self.upload_request("/file/update/hash", hash_body.clone(), report)?;
                        if hash["data"]["finish"].as_bool() == Some(true) {
                            return Ok(());
                        }
                        attempt += 1;
                    }
                    Err(error) => return Err(error),
                }
            };
            let etag = headers
                .get("etag")
                .and_then(|h| h.to_str().ok())
                .filter(|s| !s.is_empty())
                .ok_or("夸克上传分片缺少 ETag")?;
            let etag = etag
                .replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;")
                .replace('"', "&quot;");
            parts.push_str(&format!(
                "<Part><PartNumber>{number}</PartNumber><ETag>{etag}</ETag></Part>"
            ));
        }
        parts.push_str("</CompleteMultipartUpload>");
        check_control(control)?;
        // 必须先合并 OSS 分片并执行回调，才能通知夸克文件上传完成。
        let request = self
            .client
            .post(&object_url)
            .query(&[("uploadId", upload_id)])
            .header("Content-Type", "application/xml")
            .header("Content-MD5", BASE64.encode(Md5::digest(parts.as_bytes())))
            .header(
                "x-oss-callback",
                BASE64.encode(serde_json::to_vec(callback).map_err(|e| e.to_string())?),
            )
            .body(parts);
        self.oss_request(
            data,
            request,
            &format!("/{bucket}/{key}?uploadId={upload_id}"),
            "合并分片",
            report,
        )?;
        self.upload_request(
            "/file/upload/finish",
            json!({"task_id":task,"obj_key":key}),
            report,
        )?;
        Ok(())
    }

    fn oss_request(
        &self,
        data: &Value,
        builder: RequestBuilder,
        resource: &str,
        stage: &str,
        report: &mut dyn FnMut(String),
    ) -> Result<(reqwest::header::HeaderMap, String), String> {
        let now = chrono::Utc::now()
            .format("%a, %d %b %Y %H:%M:%S GMT")
            .to_string();
        let mut request = builder
            .header("Referer", "https://pan.quark.cn/")
            .header("x-oss-date", &now)
            .header("x-oss-user-agent", UPLOAD_USER_AGENT)
            .build()
            .map_err(|e| format!("构造夸克上传请求失败: {e}"))?;
        // 从实际请求头生成待签名内容，避免签名与发送内容不一致造成 403。
        let headers = request.headers();
        let header = |name: &str| {
            headers
                .get(name)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
        };
        let mut oss_headers: Vec<_> = headers
            .iter()
            .filter(|(k, _)| k.as_str().starts_with("x-oss-"))
            .collect();
        oss_headers.sort_by_key(|(k, _)| k.as_str());
        let canonical: String = oss_headers
            .iter()
            .map(|(k, v)| format!("{}:{}\n", k.as_str(), v.to_str().unwrap_or("")))
            .collect();
        let auth_meta = format!(
            "{}\n{}\n{}\n{now}\n{canonical}{resource}",
            request.method(),
            header("content-md5"),
            header("content-type")
        );
        let task = data["task_id"].as_str().ok_or("夸克预上传缺少任务 ID")?;
        let auth_info = data["auth_info"].as_str().ok_or("夸克预上传缺少授权")?;
        let auth = self.upload_request(
            "/file/upload/auth",
            json!({"task_id":task,"auth_info":auth_info,"auth_meta":auth_meta}),
            report,
        )?;
        let authorization = auth["data"]["auth_key"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("夸克未返回上传签名")?;
        request.headers_mut().insert(
            "Authorization",
            authorization.parse().map_err(|_| "夸克上传签名无效")?,
        );
        let response = self
            .client
            .execute(request)
            .map_err(|e| format!("夸克{stage}失败: {}", e.without_url()))?;
        let status = response.status();
        let headers = response.headers().clone();
        let mut body = String::new();
        response
            .take(16 * 1024)
            .read_to_string(&mut body)
            .map_err(|_| format!("读取夸克{stage}响应失败"))?;
        if !status.is_success() || body.contains("<Error>") {
            return Err(oss_error(stage, status, &body));
        }
        Ok((headers, body))
    }
}

fn remote_md5(entry: &Value) -> Option<String> {
    ["md5", "file_md5", "fileMd5"]
        .iter()
        .find_map(|key| entry[*key].as_str())
        .filter(|hash| !hash.is_empty())
        .map(|hash| hash.to_ascii_lowercase())
}

struct Archive {
    _temp: tempfile::TempDir,
    path: PathBuf,
    size: u64,
    md5: String,
}

impl Archive {
    fn exists_remotely(&self, entries: &[Value]) -> bool {
        // 文件名包含整个 ZIP 的 SHA-256；列表不返回 MD5 时仍可识别同一份内容。
        entries.iter().any(|entry| {
            entry["dir"].as_bool() != Some(true)
                && entry["file_name"].as_str() == self.path.file_name().and_then(|s| s.to_str())
                && entry["size"].as_u64() == Some(self.size)
                && remote_md5(entry).is_none_or(|hash| hash == self.md5)
        })
    }
}

fn check_control(control: &mut dyn FnMut() -> bool) -> Result<(), String> {
    if control() { Ok(()) } else { Err(INTERRUPTED.into()) }
}

fn create_archive(
    source: &Path,
    excludes: &crate::backup::ExcludeRules,
    progress: &mut dyn FnMut(&Path, &'static str, bool),
    control: &mut dyn FnMut() -> bool,
) -> Result<Archive, String> {
    check_control(control)?;
    crate::backup::no_links(source).map_err(|e| format!("检查备份目录失败: {e}"))?;
    let source = fs::canonicalize(source).map_err(|e| format!("读取备份目录失败: {e}"))?;
    if !source.is_dir() {
        return Err("要上传的备份路径不是目录".into());
    }
    let temp = tempfile::Builder::new().prefix("backy-quark-").tempdir().map_err(|e| format!("创建临时目录失败: {e}"))?;
    if fs::canonicalize(temp.path()).map_err(|e| format!("读取临时目录失败: {e}"))?.starts_with(&source) {
        return Err("压缩包临时目录不能位于待上传目录内".into());
    }
    let path = temp.path().join("archive.zip");
    let mut zip = zip::ZipWriter::new(fs::File::create(&path).map_err(|e| format!("创建压缩包失败: {e}"))?);
    let root_name = source.file_name().and_then(|s| s.to_str()).unwrap_or("Backy");
    fn append(
        zip: &mut zip::ZipWriter<fs::File>,
        path: &Path,
        name: &str,
        excludes: &crate::backup::ExcludeRules,
        progress: &mut dyn FnMut(&Path, &'static str, bool),
        control: &mut dyn FnMut() -> bool,
    ) -> Result<(), String> {
        check_control(control)?;
        crate::backup::no_links(path).map_err(|e| e.to_string())?;
        let meta = fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
        // 固定时间、权限和排序，保证内容未变化时重新打包也得到相同摘要。
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .last_modified_time(zip::DateTime::default())
            .unix_permissions(0o755);
        progress(path, "packing", false);
        if meta.is_dir() {
            zip.add_directory(format!("{name}/"), options).map_err(|e| e.to_string())?;
            let mut entries = fs::read_dir(path).map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
            entries.sort_by_key(|entry| entry.file_name());
            for entry in entries {
                check_control(control)?;
                let child_name = entry.file_name().into_string().map_err(|_| "文件名不是有效 UTF-8")?;
                if excludes.matches(&child_name) { continue; }
                append(zip, &entry.path(), &format!("{name}/{child_name}"), excludes, progress, control)?;
            }
        } else if meta.is_file() {
            zip.start_file(name, options.unix_permissions(0o644).large_file(meta.len() >= u32::MAX as u64))
                .map_err(|e| e.to_string())?;
            let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
            let mut buffer = [0u8; 64 * 1024];
            loop {
                check_control(control)?;
                let n = file.read(&mut buffer).map_err(|e| format!("{}: {e}", path.display()))?;
                if n == 0 { break; }
                zip.write_all(&buffer[..n]).map_err(|e| format!("写入压缩包失败: {e}"))?;
            }
            let after = file.metadata().map_err(|e| e.to_string())?;
            if meta.len() != after.len() || meta.modified().ok() != after.modified().ok() {
                return Err(format!("打包期间文件发生变化，请重试: {}", path.display()));
            }
        } else {
            return Err(format!("不支持打包此类型的文件: {}", path.display()));
        }
        Ok(())
    }
    append(&mut zip, &source, root_name, excludes, progress, control)?;
    drop(zip.finish().map_err(|e| format!("完成压缩包失败: {e}"))?);
    let mut file = fs::File::open(&path).map_err(|e| format!("读取压缩包失败: {e}"))?;
    let (mut sha256, mut md5) = (Sha256::new(), Md5::new());
    let mut buffer = [0u8; 64 * 1024];
    loop {
        check_control(control)?;
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 { break; }
        sha256.update(&buffer[..n]);
        md5.update(&buffer[..n]);
    }
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    drop(file);
    let named = temp.path().join(format!("Backy-{:x}.zip", sha256.finalize()));
    fs::rename(&path, &named).map_err(|e| format!("重命名压缩包失败: {e}"))?;
    Ok(Archive { _temp: temp, path: named, size, md5: format!("{:x}", md5.finalize()) })
}

fn retry_delay(stage: &str, attempt: usize, error: &str, report: &mut dyn FnMut(String)) {
    let seconds = 2u64.pow(attempt as u32);
    report(format!(
        "夸克上传重试: {stage}，{seconds} 秒后第 {attempt}/{} 次重试，原因: {error}",
        UPLOAD_ATTEMPTS - 1
    ));
    #[cfg(not(test))]
    std::thread::sleep(Duration::from_secs(seconds));
}

fn upload_url(endpoint: &str, bucket: &str, key: &str) -> Result<String, String> {
    let mut url = url::Url::parse(endpoint).map_err(|_| "夸克存储地址无效")?;
    let host = url.host_str().ok_or("夸克存储地址缺少主机名")?;
    let host = format!("{bucket}.{host}");
    url.set_scheme("https")
        .map_err(|_| "夸克存储地址协议无效")?;
    url.set_host(Some(&host))
        .map_err(|_| "夸克存储桶地址无效")?;
    url.set_path(key);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.into())
}

fn oss_error(stage: &str, status: reqwest::StatusCode, body: &str) -> String {
    // OSS 的错误正文可能包含签名原文，只输出错误码，避免将授权信息写入日志。
    let code = body
        .split_once("<Code>")
        .and_then(|(_, s)| s.split_once("</Code>"))
        .map(|(code, _)| code)
        .filter(|code| {
            !code.is_empty() && code.len() < 80 && code.chars().all(|c| c.is_ascii_alphanumeric())
        });
    let hint = match code {
        Some("SignatureDoesNotMatch") => "，上传签名与请求不一致",
        Some("RequestTimeTooSkewed") => "，请校准系统时间",
        Some("AccessDenied") => "，存储服务拒绝访问",
        _ => "",
    };
    format!(
        "夸克{stage}失败: HTTP {status}{}{hint}",
        code.map(|c| format!(" ({c})")).unwrap_or_default()
    )
}

pub fn sync_dir(
    cookie: &str,
    source: &Path,
    root: &str,
    excludes: &crate::backup::ExcludeRules,
    report: &mut dyn FnMut(String),
    progress: &mut dyn FnMut(&Path, &'static str, bool),
    control: &mut dyn FnMut() -> bool,
) -> Result<(), String> {
    let drive = Drive::new(cookie.into())?;
    sync_archive(&drive, source, root, excludes, report, progress, control)
}

fn sync_archive(
    drive: &Drive,
    source: &Path,
    root: &str,
    excludes: &crate::backup::ExcludeRules,
    report: &mut dyn FnMut(String),
    progress: &mut dyn FnMut(&Path, &'static str, bool),
    control: &mut dyn FnMut() -> bool,
) -> Result<(), String> {
    report(format!("正在打包夸克上传文件: {}", source.display()));
    let archive = create_archive(source, excludes, progress, control)?;
    check_control(control)?;
    let name = source.file_name().and_then(|s| s.to_str()).unwrap_or("Backy");
    report(format!("压缩包已生成: {}（{} 字节）", archive.path.file_name().unwrap().to_string_lossy(), archive.size));
    progress(&archive.path, "uploading", false);
    let target = drive.child(root, name)?;
    check_control(control)?;
    let entries = drive.children(&target)?;
    if archive.exists_remotely(&entries) {
        report(format!("夸克跳过（已有相同压缩包）: {}", source.display()));
    } else {
        check_control(control)?;
        drive.upload(&archive.path, &target, report, control)?;
        report(format!("夸克压缩包上传完成: {}", source.display()));
    }
    progress(&archive.path, "uploading", true);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::BTreeMap,
        io::{BufRead, BufReader, Write},
        net::TcpListener,
        thread,
        time::Instant,
    };

    #[test]
    fn login_rejects_empty_or_failed_account_responses() {
        for body in [json!({}), json!({"data":null}), json!({"data":{}}),
            json!({"code":401,"data":{"member_id":"test"}}),
            json!({"status":401,"data":{"member_id":"test"}})] {
            assert!(!valid_account(&body));
        }
        assert!(valid_account(&json!({"code":0,"data":{"member_id":"test"}})));
    }

    fn upload_scenario(mode: &'static str) -> (Result<(), String>, Vec<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(15);
            let mut calls = Vec::new();
            let mut signed = String::new();
            let mut parts = Vec::new();
            let mut counts = BTreeMap::<String, usize>::new();
            loop {
                let (mut socket, _) = match listener.accept() {
                    Ok(pair) => pair,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "mock request timeout: {calls:?}");
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(e) => panic!("{e}"),
                };
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = BufReader::new(&mut socket);
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let mut request_line = line.split_whitespace();
                let method = request_line.next().unwrap().to_owned();
                let path = request_line.next().unwrap().to_owned();
                let mut headers = BTreeMap::new();
                loop {
                    line.clear();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    let (k, v) = line.trim().split_once(':').unwrap();
                    headers.insert(k.to_ascii_lowercase(), v.trim().to_owned());
                }
                let length = headers
                    .get("content-length")
                    .map(|s| s.parse::<usize>().unwrap())
                    .unwrap_or(0);
                let mut bytes = vec![0; length];
                reader.read_exact(&mut bytes).unwrap();
                let body = String::from_utf8(bytes.clone()).unwrap();
                calls.push(format!("{method} {path}"));
                let count = counts.entry(format!("{method} {path}")).or_default();
                *count += 1;
                let count = *count;
                let mut done = false;
                let mut status = "200 OK";
                let mut extra = String::new();
                let response = if path.starts_with("/file/") {
                    assert_eq!(headers["cookie"], "test-cookie");
                    let data: Value = serde_json::from_str(&body).unwrap();
                    match path.as_str() {
                        "/file/upload/pre?pr=ucpro&fr=pc&uc_param_str=" => {
                            assert_ne!(data["parallel_upload"], true);
                            if mode == "pre-lock" && count == 1 {
                                json!({"code":1,"message":"complete_upload_lock_timeout"})
                                    .to_string()
                            } else {
                                json!({"code":0,"data":{"task_id":"task","auth_info":"info","bucket":"bucket","obj_key":"object","upload_id":"upload","upload_url":"http://oss.example.com","callback":{"callbackUrl":"https://example.com/callback","callbackBody":"test"}},"metadata":{"part_size":4}}).to_string()
                            }
                        }
                        "/file/update/hash?pr=ucpro&fr=pc&uc_param_str=" => {
                            assert_eq!(data["md5"], "e80b5017098950fc58aad83c8c14978e");
                            assert_eq!(data["sha1"], "1f8ac10f23c5b5bc1167bda84b833e5c057a77d2");
                            assert_eq!(data["task_id"], "task");
                            if mode == "hash-lock" && count == 1 {
                                json!({"code":1,"message":"complete_upload_lock_timeout"})
                                    .to_string()
                            } else {
                                done =
                                    mode == "instant" || (mode == "context-finished" && count == 2);
                                json!({"code":0,"data":{"finish":done}}).to_string()
                            }
                        }
                        "/file/upload/auth?pr=ucpro&fr=pc&uc_param_str=" => {
                            signed = data["auth_meta"].as_str().unwrap().to_owned();
                            json!({"code":0,"data":{"auth_key":"OSS test-signature"}}).to_string()
                        }
                        "/file/upload/finish?pr=ucpro&fr=pc&uc_param_str=" => {
                            assert_eq!(parts.concat(), b"abcdef");
                            assert!(calls.iter().any(|c| c == "POST /object?uploadId=upload"));
                            assert_eq!(data["task_id"], "task");
                            if (mode == "finish-lock" && count < 3) || mode == "finish-locked" {
                                done = mode == "finish-locked" && count == UPLOAD_ATTEMPTS;
                                json!({"code":1,"message":"complete_upload_lock_timeout"})
                                    .to_string()
                            } else {
                                done = true;
                                json!({"code":0,"data":{}}).to_string()
                            }
                        }
                        _ => panic!("unexpected API {path}"),
                    }
                } else {
                    assert!(!headers.contains_key("cookie"));
                    assert_eq!(headers["authorization"], "OSS test-signature");
                    assert_eq!(headers["referer"], "https://pan.quark.cn/");
                    let canonical: String = headers
                        .iter()
                        .filter(|(k, _)| k.starts_with("x-oss-"))
                        .map(|(k, v)| format!("{k}:{v}\n"))
                        .collect();
                    let expected = format!(
                        "{method}\n{}\n{}\n{}\n{canonical}/bucket{path}",
                        headers.get("content-md5").map(String::as_str).unwrap_or(""),
                        headers["content-type"],
                        headers["x-oss-date"]
                    );
                    assert_eq!(
                        signed, expected,
                        "signature must match the HTTP request on the wire"
                    );
                    if method == "PUT" {
                        let missing_context = match mode {
                            "no-context" | "context-finished" => {
                                path.contains("partNumber=2") && count == 1
                            }
                            "context-missing" => true,
                            _ => false,
                        };
                        if missing_context {
                            assert_eq!(
                                bytes,
                                if mode == "context-missing" {
                                    b"abcd".as_slice()
                                } else {
                                    b"ef".as_slice()
                                }
                            );
                            status = "400 Bad Request";
                            done = mode == "context-missing" && count == UPLOAD_ATTEMPTS;
                            "<Error><Code>NoHashContext</Code></Error>".into()
                        } else if mode == "denied" {
                            status = "403 Forbidden";
                            done = true;
                            "<Error><Code>SignatureDoesNotMatch</Code><StringToSign>SECRET</StringToSign></Error>".into()
                        } else {
                            parts.push(bytes);
                            if mode == "no-etag" {
                                done = true;
                            } else {
                                extra = format!("ETag: \"etag{}\"\r\n", parts.len());
                            }
                            String::new()
                        }
                    } else {
                        assert_eq!(
                            headers["content-md5"],
                            BASE64.encode(Md5::digest(body.as_bytes()))
                        );
                        let callback: Value = serde_json::from_slice(
                            &BASE64.decode(&headers["x-oss-callback"]).unwrap(),
                        )
                        .unwrap();
                        assert_eq!(callback["callbackBody"], "test");
                        assert!(body
                            .contains("<PartNumber>1</PartNumber><ETag>&quot;etag1&quot;</ETag>"));
                        assert!(body
                            .contains("<PartNumber>2</PartNumber><ETag>&quot;etag2&quot;</ETag>"));
                        if mode == "commit-error" {
                            done = true;
                            "<Error><Code>InvalidPart</Code></Error>".into()
                        } else {
                            "<CompleteMultipartUploadResult/>".into()
                        }
                    }
                };
                write!(socket, "HTTP/1.1 {status}\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n{response}", response.len()).unwrap();
                if done {
                    return calls;
                }
            }
        });
        let mut drive = Drive::new("test-cookie".into()).unwrap();
        drive.client = Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        drive.api = origin.clone();
        drive.upload_origin = Some(origin);
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("sample.txt");
        fs::write(&file, "abcdef").unwrap();
        let mut retries = Vec::new();
        let result = drive.upload(&file, "0", &mut |text| retries.push(text), &mut || true);
        let expected_retries = match mode {
            "pre-lock" | "hash-lock" | "no-context" | "context-finished" => 1,
            "finish-lock" => 2,
            "finish-locked" | "context-missing" => UPLOAD_ATTEMPTS - 1,
            _ => 0,
        };
        assert_eq!(retries.len(), expected_retries);
        (result, server.join().unwrap())
    }

    #[test]
    fn multipart_upload_signs_actual_headers_and_commits_before_finish() {
        let (result, calls) = upload_scenario("normal");
        result.unwrap();
        assert_eq!(calls.len(), 9);
    }

    #[test]
    fn upload_failures_never_mark_file_finished() {
        for (mode, expected) in [
            ("denied", "SignatureDoesNotMatch"),
            ("no-etag", "ETag"),
            ("commit-error", "InvalidPart"),
        ] {
            let (result, calls) = upload_scenario(mode);
            let error = result.unwrap_err();
            assert!(error.contains(expected), "{error}");
            assert!(!error.contains("SECRET"));
            assert!(!calls.iter().any(|c| c.contains("/file/upload/finish")));
        }
    }

    #[test]
    fn instant_upload_stops_after_hash_confirmation() {
        let (result, calls) = upload_scenario("instant");
        result.unwrap();
        assert_eq!(calls.len(), 2);
    }

    #[test]
    fn lock_timeout_retries_only_the_failed_api_stage() {
        for mode in ["pre-lock", "hash-lock", "finish-lock"] {
            let (result, calls) = upload_scenario(mode);
            result.unwrap();
            assert_eq!(calls.iter().filter(|c| c.starts_with("PUT ")).count(), 2);
            assert_eq!(
                calls
                    .iter()
                    .filter(|c| c.starts_with("POST /object?"))
                    .count(),
                1
            );
            assert_eq!(
                calls
                    .iter()
                    .filter(|c| c.contains("/file/upload/pre?"))
                    .count(),
                if mode == "pre-lock" { 2 } else { 1 }
            );
        }
    }

    #[test]
    fn missing_hash_context_refreshes_same_task_and_retries_only_current_part() {
        let (result, calls) = upload_scenario("no-context");
        result.unwrap();
        let parts: Vec<_> = calls.iter().filter(|c| c.starts_with("PUT ")).collect();
        assert_eq!(parts.len(), 3);
        assert!(parts[0].contains("partNumber=1"));
        assert_eq!(parts[1], parts[2]);
        assert_eq!(
            calls
                .iter()
                .filter(|c| c.contains("/file/upload/pre?"))
                .count(),
            1
        );
        assert_eq!(
            calls
                .iter()
                .filter(|c| c.contains("/file/update/hash?"))
                .count(),
            2
        );
        let failed = calls.iter().position(|c| *c == *parts[1]).unwrap();
        assert!(calls[failed + 1].contains("/file/update/hash?"));
        assert!(calls[failed + 2].contains("/file/upload/auth?"));
    }

    #[test]
    fn repeated_transient_errors_are_bounded_and_still_fail() {
        for (mode, expected) in [
            ("finish-locked", "complete_upload_lock_timeout"),
            ("context-missing", "NoHashContext"),
        ] {
            let (result, calls) = upload_scenario(mode);
            assert!(result.unwrap_err().contains(expected));
            if mode == "context-missing" {
                assert_eq!(
                    calls.iter().filter(|c| c.starts_with("PUT ")).count(),
                    UPLOAD_ATTEMPTS
                );
                assert!(!calls.iter().any(|c| c.contains("/file/upload/finish")));
                assert!(!calls.iter().any(|c| c.starts_with("POST /object?")));
            } else {
                assert_eq!(
                    calls
                        .iter()
                        .filter(|c| c.contains("/file/upload/finish?"))
                        .count(),
                    UPLOAD_ATTEMPTS
                );
            }
        }
    }

    #[test]
    fn hash_refresh_can_confirm_completed_upload_without_resending() {
        let (result, calls) = upload_scenario("context-finished");
        result.unwrap();
        assert_eq!(calls.iter().filter(|c| c.starts_with("PUT ")).count(), 2);
        assert!(calls.last().unwrap().contains("/file/update/hash?"));
    }

    #[test]
    fn uses_returned_upload_endpoint_over_https() {
        assert_eq!(
            upload_url("http://oss-cn-shanghai.aliyuncs.com", "bucket", "dir/file").unwrap(),
            "https://bucket.oss-cn-shanghai.aliyuncs.com/dir/file"
        );
        assert!(upload_url("bad endpoint", "bucket", "key").is_err());
    }

    fn rules() -> crate::backup::ExcludeRules {
        crate::backup::ExcludeRules::from_config(&json!([])).unwrap()
    }

    #[test]
    fn syncing_twice_uploads_only_one_zip_and_cleans_temporary_files() {
        let source = tempfile::tempdir().unwrap();
        fs::create_dir(source.path().join("nested")).unwrap();
        fs::write(source.path().join("a.txt"), "a").unwrap();
        fs::write(source.path().join("nested/b.txt"), "b").unwrap();
        let folder_name = source.path().file_name().unwrap().to_str().unwrap().to_owned();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut uploaded = Vec::<Value>::new();
            let mut uploads = 0;
            for _ in 0..5 {
                let (mut socket, _) = loop {
                    match listener.accept() {
                        Ok(pair) => break pair,
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(Instant::now() < deadline, "等待 ZIP 同步请求超时");
                            thread::sleep(Duration::from_millis(5));
                        }
                        Err(e) => panic!("{e}"),
                    }
                };
                socket.set_nonblocking(false).unwrap();
                socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                let mut reader = BufReader::new(&mut socket);
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let request = line.clone();
                let mut length = 0;
                loop {
                    line.clear();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" { break; }
                    if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        length = value.trim().parse().unwrap();
                    }
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                let response = if request.starts_with("GET /file/sort?") {
                    if request.contains("pdir_fid=0&") {
                        json!({"code":0,"data":{"list":[{"dir":true,"file_name":folder_name,"fid":"folder"}]}})
                    } else {
                        assert!(request.contains("pdir_fid=folder&"));
                        json!({"code":0,"data":{"list":uploaded}})
                    }
                } else {
                    assert!(request.starts_with("POST /file/upload/pre?"));
                    let data: Value = serde_json::from_slice(&body).unwrap();
                    assert!(data["file_name"].as_str().unwrap().ends_with(".zip"));
                    assert_eq!(data["pdir_fid"], "folder");
                    uploaded.push(json!({"dir":false,"file_name":data["file_name"],"size":data["size"]}));
                    uploads += 1;
                    json!({"code":0,"data":{"finish":true}})
                }.to_string();
                write!(socket, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).unwrap();
            }
            uploads
        });
        let mut drive = Drive::new("test-cookie".into()).unwrap();
        drive.api = origin;
        drive.client = Client::builder().no_proxy().timeout(Duration::from_secs(3)).build().unwrap();
        let mut logs = Vec::new();
        for _ in 0..2 {
            let mut temporary = PathBuf::new();
            let mut completed = 0;
            sync_archive(&drive, source.path(), "0", &rules(), &mut |text| logs.push(text), &mut |path, stage, done| {
                if stage == "uploading" { temporary = path.to_owned(); }
                if done { completed += 1; }
            }, &mut || true).unwrap();
            assert_eq!(completed, 1);
            assert!(!temporary.exists());
        }
        assert_eq!(server.join().unwrap(), 1);
        assert!(logs.iter().any(|text| text.contains("已有相同压缩包")));
    }

    fn pack(source: &Path) -> Archive {
        create_archive(source, &rules(), &mut |_, _, _| {}, &mut || true).unwrap()
    }

    #[test]
    fn archive_round_trip_preserves_unicode_nested_files_and_empty_directories() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("备份");
        fs::create_dir_all(source.join("子目录/空目录")).unwrap();
        fs::write(source.join("子目录/内容.txt"), "测试内容").unwrap();
        fs::write(source.join("empty.txt"), "").unwrap();
        let archive = pack(&source);
        let mut zip = zip::ZipArchive::new(fs::File::open(&archive.path).unwrap()).unwrap();
        let mut content = String::new();
        zip.by_name("备份/子目录/内容.txt").unwrap().read_to_string(&mut content).unwrap();
        assert_eq!(content, "测试内容");
        assert!(zip.by_name("备份/子目录/空目录/").unwrap().is_dir());
        assert_eq!(zip.by_name("备份/empty.txt").unwrap().size(), 0);
        assert_eq!(zip.len(), 5);
        drop(zip);
        let path = archive.path.clone();
        drop(archive);
        assert!(!path.exists());
    }

    #[test]
    fn unchanged_content_has_identical_archive_even_if_timestamps_change() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("file.txt");
        fs::write(&file, "same").unwrap();
        let first = pack(dir.path());
        fs::File::options().write(true).open(&file).unwrap()
            .set_modified(std::time::UNIX_EPOCH + Duration::from_secs(1_700_000_000)).unwrap();
        let second = pack(dir.path());
        assert_eq!(first.path.file_name(), second.path.file_name());
        assert_eq!(fs::read(&first.path).unwrap(), fs::read(&second.path).unwrap());
        fs::write(&file, "edit").unwrap();
        assert_ne!(first.path.file_name(), pack(dir.path()).path.file_name());
        fs::rename(&file, dir.path().join("renamed.txt")).unwrap();
        assert_ne!(second.path.file_name(), pack(dir.path()).path.file_name());
    }

    #[test]
    fn archive_skip_uses_content_name_and_size_with_optional_md5() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("file.txt"), "abc").unwrap();
        let archive = pack(dir.path());
        let entry = json!({"file_name":archive.path.file_name().unwrap().to_str().unwrap(),"size":archive.size,"dir":false});
        assert!(archive.exists_remotely(&[entry.clone()]));
        for (key, value) in [("file_name", json!("other.zip")), ("size", json!(archive.size + 1)), ("dir", json!(true)), ("md5", json!("wrong"))] {
            let mut different = entry.clone();
            different[key] = value;
            assert!(!archive.exists_remotely(&[different]));
        }
        let mut hashed = entry;
        hashed["file_md5"] = json!(archive.md5.to_ascii_uppercase());
        assert!(archive.exists_remotely(&[hashed]));
    }

    #[test]
    fn archive_applies_exclusions_and_handles_empty_source() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("node_modules")).unwrap();
        fs::write(dir.path().join("node_modules/secret.txt"), "excluded").unwrap();
        fs::write(dir.path().join("debug.log"), "excluded").unwrap();
        let excludes = crate::backup::ExcludeRules::from_config(&json!(["node_modules", "*.log"])).unwrap();
        let archive = create_archive(dir.path(), &excludes, &mut |_, _, _| {}, &mut || true).unwrap();
        let mut zip = zip::ZipArchive::new(fs::File::open(&archive.path).unwrap()).unwrap();
        assert_eq!(zip.len(), 1);
        assert!(zip.by_index(0).unwrap().is_dir());
    }

    #[test]
    fn archive_stop_mid_file_never_returns_partial_package() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("large.txt"), vec![b'a'; 256 * 1024]).unwrap();
        let mut calls = 0;
        let result = create_archive(dir.path(), &rules(), &mut |_, _, _| {}, &mut || {
            calls += 1;
            calls < 7
        });
        assert_eq!(result.err().as_deref(), Some(INTERRUPTED));
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
        assert!(create_archive(&dir.path().join("missing"), &rules(), &mut |_, _, _| {}, &mut || true).is_err());
    }
}
