use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};

struct ServerProcess(Mutex<Option<Child>>);

const NEXT_SERVER_LOG_MAX_BYTES: u64 = 8 * 1024 * 1024;
const HOST_LOG_MAX_BYTES: u128 = 2 * 1024 * 1024;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(ServerProcess(Mutex::new(None)))
    .setup(|app| {
      let is_release = !cfg!(debug_assertions);
      let boot_id = generate_boot_id();
      let host_log_target = match app_data_root(app) {
        Some(root) => Target::new(TargetKind::Folder {
          path: root.join("finance-agent").join("logs"),
          file_name: Some("tauri-host".into()),
        }),
        None => Target::new(TargetKind::LogDir {
          file_name: Some("tauri-host".into()),
        }),
      };
      let mut host_logger = tauri_plugin_log::Builder::default()
        .clear_targets()
        .target(host_log_target)
        .level(log::LevelFilter::Info)
        .max_file_size(HOST_LOG_MAX_BYTES)
        .rotation_strategy(RotationStrategy::KeepSome(3));
      if cfg!(debug_assertions) {
        host_logger = host_logger.target(Target::new(TargetKind::Stdout));
      }
      app.handle().plugin(host_logger.build())?;
      log::info!(
        "host_start bootId={} mode={}",
        boot_id,
        if is_release { "release" } else { "debug" }
      );

      // 端口只解析一次,setup 与下面的就绪轮询线程复用同一个值。生产态探测空闲端口(见
      // resolve_server_port):上次 app 崩溃/异常退出残留的 next-server 子进程仍占着固定端口时,
      // 新实例不再 listen EADDRINUSE 起不来(此前表现为整体"网络错误")。
      let server_port = if is_release { resolve_server_port() } else { 3000 };
      let url = if is_release {
        start_next_server(app, server_port, &boot_id).map_err(|error| {
          log::error!("next_server_start_failed bootId={} error={error}", boot_id);
          error
        })?;
        format!("http://127.0.0.1:{server_port}")
      } else {
        "http://127.0.0.1:3000".to_string()
      };

      app.handle().plugin(tauri_plugin_dialog::init())?;
      app.handle().plugin(tauri_plugin_fs::init())?;
      app.handle().plugin(tauri_plugin_shell::init())?;
      app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;

      // 生产态:先把窗口加载到内置 loading 占位页(数据 URL,瞬时可见),等内置 Next 服务真正
      // 就绪后再 navigate 到真实地址,消除"服务没起来就加载 → 白屏/连接错误页"。
      // 开发态:Next 由 beforeDevCommand 先起好,直接加载真实地址即可。
      let initial_url = if is_release { SPLASH_URL.to_string() } else { url.clone() };

      let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(initial_url.parse()?))
        .title("")
        .inner_size(1280.0, 860.0)
        .min_inner_size(1024.0, 720.0)
        .resizable(true);

      #[cfg(target_os = "macos")]
      let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(12.0, 24.0));

      let window = builder.build()?;

      if is_release {
        let port = server_port;
        let win = window.clone();
        let real_url = url.clone();
        let ready_boot_id = boot_id.clone();
        std::thread::spawn(move || {
          if wait_for_server_ready(port, Duration::from_secs(60)) {
            log::info!("next_server_ready bootId={} port={}", ready_boot_id, port);
          } else {
            log::warn!("next_server_ready_timeout bootId={} port={}", ready_boot_id, port);
          }
          if let Err(error) = win.eval(&format!("window.location.replace('{real_url}')")) {
            log::error!("next_server_navigation_failed bootId={} error={error}", ready_boot_id);
          }
        });
      }
      Ok(())
    })
    .on_window_event(|window, event| {
      if matches!(event, WindowEvent::CloseRequested { .. }) {
        let state = window.app_handle().state::<ServerProcess>();
        let child = state.0.lock().expect("server process lock poisoned").take();
        if let Some(mut child) = child {
          let _ = child.kill();
        }
      }
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

fn start_next_server(
  app: &mut tauri::App,
  port: u16,
  boot_id: &str,
) -> Result<(), Box<dyn std::error::Error>> {
  let resource_dir = app.path().resource_dir()?;
  let server_dir = resource_dir.join("next-server");
  let bundled_plugin_dir = server_dir.join("agent-skills");
  let node_binary = resource_dir
    .join("node")
    .join(if cfg!(windows) { "node.exe" } else { "node" });
  let node_command = if node_binary.exists() {
    node_binary
  } else {
    "node".into()
  };
  // 子进程 stdout/stderr 重定向到 <appData>/finance-agent/logs/next-server.log,与 JS 端
  // server-<date>.log 同目录。以 append 保留跨启动历史,超过上限时滚动为单个 .1 归档,
  // 避免历史丢失与无限增长。打不开文件则回退 null(best-effort,绝不阻塞启动)。
  let (stdout_cfg, stderr_cfg) = match open_next_server_log(app, boot_id) {
    Some(file) => match file.try_clone() {
      Ok(clone) => (Stdio::from(file), Stdio::from(clone)),
      Err(_) => (Stdio::from(file), Stdio::null()),
    },
    None => (Stdio::null(), Stdio::null()),
  };
  let mut command = Command::new(node_command);
  command
    .arg("server.js")
    .current_dir(&server_dir)
    .env("HOSTNAME", "127.0.0.1")
    .env("PORT", port.to_string())
    .env("FINANCE_AGENT_BOOT_ID", boot_id)
    .env("FINANCE_AGENT_PROJECT_ROOT", &server_dir)
    .env("FINANCE_AGENT_BUNDLED_PLUGIN_DIR", bundled_plugin_dir)
    .stdout(stdout_cfg)
    .stderr(stderr_cfg);

  // Windows:node 是控制台程序,GUI 应用(windows_subsystem="windows")里直接 spawn 会给它弹一个
  // 独立控制台黑窗(Windows Terminal 标签标题取 node 的 process.title = "next-server (vX.Y.Z)"),
  // 盖在真正的 app 窗前 → 用户只看到「黑屏 next-server 窗口」。CREATE_NO_WINDOW(0x0800_0000)
  // 抑制该窗口;stdout/stderr 已重定向到 next-server.log(见上),不再丢输出。仅 Windows 需要,其它平台无此问题。
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
  }

  // 镜像/代理占位:默认从系统环境透传给 node 子进程(未设则不传,JS 端回退默认值,
  // 如 pip 默认清华镜像)。要为发行版内置默认镜像,把对应行改成 .env(KEY, "https://…") 即可。
  // - FINANCE_AGENT_PIP_INDEX_URL:pip 镜像(默认清华)
  // - FINANCE_AGENT_PYTHON_ASSET_URL:CPython 自托管整条 URL
  // - FINANCE_AGENT_GH_PROXY:GitHub 代理前缀
  for key in [
    "FINANCE_AGENT_PIP_INDEX_URL",
    "FINANCE_AGENT_PYTHON_ASSET_URL",
    "FINANCE_AGENT_GH_PROXY",
  ] {
    if let Ok(value) = std::env::var(key) {
      command.env(key, value);
    }
  }

  // 遥测编译期内置(§17.1):endpoint/token 在 CI 打包时经 option_env! 烧进原生二进制,
  // 运行期再注入给 next-server 子进程。空串表示未内置(dev 构建),reporter 在无 endpoint 时 no-op。
  // 绝不写死任何真实地址/token——值从 CI secret 通过 TELEMETRY_ENDPOINT/TELEMETRY_TOKEN env 传入。
  let builtin_endpoint = option_env!("TELEMETRY_ENDPOINT").unwrap_or("");
  let builtin_token = option_env!("TELEMETRY_TOKEN").unwrap_or("");
  if !builtin_endpoint.is_empty() {
    command.env("TELEMETRY_ENDPOINT", builtin_endpoint);
  }
  if !builtin_token.is_empty() {
    command.env("TELEMETRY_TOKEN", builtin_token);
  }

  let child = command.spawn()?;
  log::info!(
    "next_server_started bootId={} pid={} port={}",
    boot_id,
    child.id(),
    port
  );

  // Windows:把子进程绑进 KILL_ON_JOB_CLOSE 的 Job Object。CloseRequested 时已显式 kill(见 on_window_event),
  // 但崩溃/被强杀/异常退出兜不住 → 残留 node 占内存(端口已靠动态选避开)。Job Object 让父进程一旦消失(含崩溃),
  // OS 关闭 job 句柄即连带杀掉子进程,彻底回收。仅 Windows 需要。
  #[cfg(windows)]
  confine_child_to_job(&child);

  let state = app.state::<ServerProcess>();
  *state.0.lock().expect("server process lock poisoned") = Some(child);
  Ok(())
}

/// 把子进程绑到一个 KILL_ON_JOB_CLOSE 的 Job Object:父进程(本 app)退出/崩溃时,OS 关闭最后一个 job 句柄,
/// 触发该限制 → job 内所有进程(即内置 next-server)被一并终止。故意不关闭 job 句柄,让它随本进程生命周期存活。
#[cfg(windows)]
fn confine_child_to_job(child: &Child) {
  use std::os::windows::io::AsRawHandle;
  use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
  };
  unsafe {
    let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
    if job.is_null() {
      return;
    }
    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    SetInformationJobObject(
      job,
      JobObjectExtendedLimitInformation,
      &info as *const _ as *const core::ffi::c_void,
      std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
    );
    AssignProcessToJobObject(job, child.as_raw_handle() as _);
    // 不 CloseHandle(job):句柄是裸指针、无 Drop,随本进程存活保持打开;进程退出时 OS 自动关闭并触发杀子进程。
  }
}

/// next-server 子进程日志文件(<appData>/finance-agent/logs/next-server.log)。
/// 每次宿主启动时检查大小:跨启动追加,达到 8 MiB 时保留一个 `.1` 归档。
/// 单次长运行可暂时超过阈值,下次启动时收敛;打开失败返回 None → 调用方回退 Stdio::null()。
fn open_next_server_log(app: &tauri::App, boot_id: &str) -> Option<File> {
  let dir = app_data_root(app)?.join("finance-agent").join("logs");
  std::fs::create_dir_all(&dir).ok()?;
  open_next_server_log_path(&dir.join("next-server.log"), boot_id).ok()
}

fn open_next_server_log_path(path: &Path, boot_id: &str) -> std::io::Result<File> {
  if let Err(error) = rotate_next_server_log_if_needed(path) {
    // 轮转失败时仍尝试 append,优先保住本次诊断信息。
    log::warn!("next_server_log_rotation_failed path={} error={error}", path.display());
  }
  let mut file = OpenOptions::new().create(true).append(true).open(path)?;
  let marker_result = writeln!(
    file,
    "[host] startup bootId={} pid={} timestampMs={}",
    boot_id,
    std::process::id(),
    unix_timestamp_millis()
  )
  .and_then(|_| file.flush());
  if let Err(error) = marker_result {
    // 标记失败不能让 stdout/stderr 整体退化到 null;仍把已打开的句柄交给子进程。
    log::warn!("next_server_startup_marker_failed path={} error={error}", path.display());
  }
  Ok(file)
}

fn rotate_next_server_log_if_needed(path: &Path) -> std::io::Result<()> {
  let size = match std::fs::metadata(path) {
    Ok(metadata) => metadata.len(),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
    Err(error) => return Err(error),
  };
  if size < NEXT_SERVER_LOG_MAX_BYTES {
    return Ok(());
  }

  let archive = next_server_log_archive_path(path);
  if archive.exists() {
    std::fs::remove_file(&archive)?;
  }
  std::fs::rename(path, archive)
}

fn next_server_log_archive_path(path: &Path) -> PathBuf {
  let mut archive = path.as_os_str().to_owned();
  archive.push(".1");
  PathBuf::from(archive)
}

fn unix_timestamp_millis() -> u128 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or_default()
    .as_millis()
}

fn generate_boot_id() -> String {
  let timestamp_nanos = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or_default()
    .as_nanos();
  format!("{timestamp_nanos:032x}-{:08x}", std::process::id())
}

/// 复刻 JS 端 paths.ts::getDefaultAppDataRoot 的平台默认根,确保原生日志与 JS 日志落同一目录。
/// 故意不走 Tauri app_data_dir()(那会带 bundle identifier 子目录,与 JS 的 finance-agent 不一致)。
fn app_data_root(app: &tauri::App) -> Option<PathBuf> {
  let home = app.path().home_dir().ok();
  #[cfg(windows)]
  {
    if let Ok(appdata) = std::env::var("APPDATA") {
      if !appdata.is_empty() {
        return Some(PathBuf::from(appdata));
      }
    }
    return home.map(|h| h.join("AppData").join("Roaming"));
  }
  #[cfg(target_os = "macos")]
  {
    return home.map(|h| h.join("Library").join("Application Support"));
  }
  #[cfg(all(unix, not(target_os = "macos")))]
  {
    if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
      if !xdg.is_empty() {
        return Some(PathBuf::from(xdg));
      }
    }
    return home.map(|h| h.join(".local").join("share"));
  }
}

/// 解析内置 next-server 要监听的端口。env `FINANCE_AGENT_DESKTOP_PORT` 显式指定时直接用(尊重配置);
/// 否则从默认端口起探测一个**当前空闲**的端口——绑定成功即空闲(随即释放),避免上次残留的 next-server
/// 子进程仍占着固定端口时,新实例 `listen EADDRINUSE` 起不来(此前表现为整体"网络错误")。
/// 注意:必须只调一次、结果复用;重复调用可能因竞态返回不同端口。
fn resolve_server_port() -> u16 {
  const DEFAULT_PORT: u16 = 39211;
  if let Ok(value) = std::env::var("FINANCE_AGENT_DESKTOP_PORT") {
    if let Ok(port) = value.parse::<u16>() {
      return port;
    }
  }
  for offset in 0..64u16 {
    let port = DEFAULT_PORT + offset;
    // 绑定成功 = 端口空闲;TcpListener 临时值在本条件求值结束即 drop,端口随之释放,供 node 接管。
    if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
      return port;
    }
  }
  DEFAULT_PORT
}

// 内置 loading 占位页:纯 CSS 旋转指示器,无外部资源/脚本。
// 写成非 base64 数据 URL,故刻意回避 `#`(片段符)与 `%`(转义符):颜色用 rgb()、圆角用 999px、
// keyframes 用 from/to 而非百分比。
const SPLASH_URL: &str = "data:text/html,<!doctype html><html><head><meta charset='utf-8'><style>html,body{margin:0;height:100%;background:rgb(250,250,250)}.wrap{height:100%;display:flex;align-items:center;justify-content:center}.spin{width:28px;height:28px;border:3px solid rgb(225,225,228);border-top-color:rgb(90,90,100);border-radius:999px;animation:r 0.8s linear infinite}@keyframes r{from{transform:rotate(0)}to{transform:rotate(360deg)}}</style></head><body><div class='wrap'><div class='spin'></div></div></body></html>";

/// 轮询内置 Next 服务,直到 /api/health 返回 200 或超时。
/// 超时也放行(navigate 过去让用户看到真实状态),避免无限转圈。
fn wait_for_server_ready(port: u16, timeout: Duration) -> bool {
  let addr = format!("127.0.0.1:{port}");
  let deadline = Instant::now() + timeout;
  loop {
    if http_health_ok(&addr) {
      return true;
    }
    if Instant::now() >= deadline {
      return false;
    }
    std::thread::sleep(Duration::from_millis(150));
  }
}

/// 裸 HTTP/1.0 `GET /api/health`,免引第三方 HTTP 依赖;状态行含 "200" 即视为就绪。
fn http_health_ok(addr: &str) -> bool {
  let sock: SocketAddr = match addr.parse() {
    Ok(value) => value,
    Err(_) => return false,
  };
  let mut stream = match TcpStream::connect_timeout(&sock, Duration::from_millis(400)) {
    Ok(value) => value,
    Err(_) => return false,
  };
  let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
  let _ = stream.set_write_timeout(Some(Duration::from_millis(800)));
  let request = "GET /api/health HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
  if stream.write_all(request.as_bytes()).is_err() {
    return false;
  }
  let mut buf = [0u8; 64];
  match stream.read(&mut buf) {
    Ok(n) => String::from_utf8_lossy(&buf[..n]).contains("200"),
    Err(_) => false,
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn test_log_dir(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("finance-agent-{name}-{}", generate_boot_id()))
  }

  #[test]
  fn next_server_log_appends_startup_markers_without_losing_history() {
    let dir = test_log_dir("append-log");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("next-server.log");
    std::fs::write(&path, "previous-run\n").unwrap();

    let mut first = open_next_server_log_path(&path, "boot-one").unwrap();
    writeln!(first, "first-child-output").unwrap();
    drop(first);
    let second = open_next_server_log_path(&path, "boot-two").unwrap();
    drop(second);

    let content = std::fs::read_to_string(&path).unwrap();
    assert!(content.contains("previous-run"));
    assert!(content.contains("startup bootId=boot-one"));
    assert!(content.contains("first-child-output"));
    assert!(content.contains("startup bootId=boot-two"));

    std::fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn next_server_log_below_limit_stays_in_active_file() {
    let dir = test_log_dir("below-limit-log");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("next-server.log");
    std::fs::write(&path, "kept-history\n").unwrap();

    let active = open_next_server_log_path(&path, "current-boot").unwrap();
    drop(active);

    let content = std::fs::read_to_string(&path).unwrap();
    assert!(content.contains("kept-history"));
    assert!(content.contains("startup bootId=current-boot"));
    assert!(!next_server_log_archive_path(&path).exists());

    std::fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn next_server_log_rotation_keeps_one_bounded_archive() {
    let dir = test_log_dir("rotate-log");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("next-server.log");
    let archive = next_server_log_archive_path(&path);
    std::fs::write(&archive, "stale-archive").unwrap();
    let oversized = File::create(&path).unwrap();
    oversized.set_len(NEXT_SERVER_LOG_MAX_BYTES).unwrap();
    drop(oversized);

    let active = open_next_server_log_path(&path, "rotated-boot").unwrap();
    drop(active);

    assert_eq!(std::fs::metadata(&archive).unwrap().len(), NEXT_SERVER_LOG_MAX_BYTES);
    let content = std::fs::read_to_string(&path).unwrap();
    assert!(content.contains("startup bootId=rotated-boot"));
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 2);

    std::fs::remove_dir_all(dir).unwrap();
  }
}
