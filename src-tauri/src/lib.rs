use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{
  atomic::{AtomicBool, Ordering},
  Mutex,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};

#[derive(Default)]
struct ServerProcess {
  child: Mutex<Option<Child>>,
  shutting_down: AtomicBool,
}

struct WorkspaceAuthToken(String);

#[tauri::command]
fn workspace_auth_token(state: tauri::State<'_, WorkspaceAuthToken>) -> String {
  state.0.clone()
}

#[derive(Clone)]
struct NextServerConfig {
  resource_dir: PathBuf,
  port: u16,
  boot_id: String,
  app_data_dir: Option<PathBuf>,
}

#[derive(Debug, PartialEq, Eq)]
enum NextServerExitAction {
  Stop,
  Restart,
  ShowError,
}

fn next_server_exit_action(shutting_down: bool, restarted: bool) -> NextServerExitAction {
  if shutting_down {
    NextServerExitAction::Stop
  } else if restarted {
    NextServerExitAction::ShowError
  } else {
    NextServerExitAction::Restart
  }
}

#[derive(Debug, PartialEq, Eq)]
enum WindowShutdownEvent {
  CloseRequested,
  Destroyed,
}

fn should_shutdown_for_window_event(event: WindowShutdownEvent) -> bool {
  matches!(event, WindowShutdownEvent::Destroyed)
}

const NEXT_SERVER_LOG_MAX_BYTES: u64 = 8 * 1024 * 1024;
const HOST_LOG_MAX_BYTES: u128 = 2 * 1024 * 1024;
const APP_DIRECTORY_NAME: &str = "Finwork";
const WINDOWS_RELEASE_DATA_DIRECTORY_NAME: &str = "Finwork Data";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let startup_workspace_token = generate_workspace_auth_token();
  tauri::Builder::default()
    .manage(ServerProcess::default())
    .manage(WorkspaceAuthToken(startup_workspace_token))
    // single-instance 守卫必须在 Builder 链上、.setup() 之前注册，
    // 应用启动前挂钩；第二实例启动时聚焦已有主窗口。
    .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
      if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_focus();
      }
    }))
    .setup(|app| {
      let is_release = !cfg!(debug_assertions);
      let boot_id = generate_boot_id();
      let app_data_dir = resolve_app_data_dir(app, is_release);
      if let Some(dir) = app_data_dir.as_ref() {
        std::fs::create_dir_all(dir)?;
        let token = app.state::<WorkspaceAuthToken>().0.clone();
        write_workspace_auth_token(&dir.join("workspace-auth-token"), &token)?;
      }
      let host_log_target = match app_data_dir.as_ref() {
        Some(dir) => Target::new(TargetKind::Folder {
          path: dir.join("logs"),
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
      let server_config = if is_release {
        Some(
          start_next_server(app, server_port, &boot_id, app_data_dir.as_deref()).map_err(|error| {
            log::error!("next_server_start_failed bootId={} error={error}", boot_id);
            error
          })?,
        )
      } else {
        None
      };
      let url = format!("http://127.0.0.1:{server_port}");

      app.handle().plugin(tauri_plugin_dialog::init())?;
      app.handle().plugin(tauri_plugin_fs::init())?;
      app.handle().plugin(tauri_plugin_shell::init())?;
      app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;

      // 生产态:先把窗口加载到内置 loading 占位页(数据 URL,瞬时可见),等内置 Next 服务真正
      // 就绪后再 navigate 到真实地址,消除"服务没起来就加载 → 白屏/连接错误页"。
      // 开发态:Next 由 beforeDevCommand 先起好,直接加载真实地址即可。
      let initial_url = if is_release { SPLASH_URL.to_string() } else { url.clone() };

      // 原生标题供 Windows Alt-Tab/任务栏悬停与 mac Mission Control 使用;
      // mac 标题栏文本仍被 hidden_title(true) 隐藏。conf 里 windows[0].title 因 create:false 不生效。
      let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(initial_url.parse()?))
        .title("Finwork")
        .inner_size(1280.0, 860.0)
        .min_inner_size(1024.0, 720.0)
        .resizable(true);

      #[cfg(target_os = "macos")]
      let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(12.0, 24.0));

      // Windows:去系统标题栏(无边框),改由 Web 自绘三键(见 window-controls.tsx 的 WindowControls)。
      // 仍 resizable(true) → tao 保留 WS_THICKFRAME,可从窗口边缘缩放。Linux 保持原生框不动。
      #[cfg(target_os = "windows")]
      let builder = builder.decorations(false);

      let window = builder.build()?;

      if let Some(config) = server_config {
        start_next_server_supervisor(window, config, url);
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![workspace_auth_token])
    .on_window_event(|window, event| {
      let shutdown_event = match event {
        WindowEvent::CloseRequested { .. } => WindowShutdownEvent::CloseRequested,
        WindowEvent::Destroyed => WindowShutdownEvent::Destroyed,
        _ => return,
      };
      if should_shutdown_for_window_event(shutdown_event) {
        let state = window.app_handle().state::<ServerProcess>();
        state.shutting_down.store(true, Ordering::SeqCst);
        log::info!("next_server_window_destroyed_shutdown");
        let child = state
          .child
          .lock()
          .expect("server process lock poisoned")
          .take();
        if let Some(mut child) = child {
          log::info!("next_server_window_destroyed_killing pid={}", child.id());
          let _ = child.kill();
        }
      }
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

fn generate_workspace_auth_token() -> String {
  let mut bytes = [0u8; 32];
  getrandom::getrandom(&mut bytes).expect("secure random source unavailable");
  bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn write_workspace_auth_token(path: &Path, token: &str) -> std::io::Result<()> {
  let mut options = OpenOptions::new();
  options.create(true).truncate(true).write(true);
  #[cfg(unix)]
  {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
  }
  let mut file = options.open(path)?;
  file.write_all(token.as_bytes())?;
  file.flush()
}

fn start_next_server(
  app: &mut tauri::App,
  port: u16,
  boot_id: &str,
  app_data_dir: Option<&Path>,
) -> Result<NextServerConfig, Box<dyn std::error::Error>> {
  let config = NextServerConfig {
    resource_dir: app.path().resource_dir()?,
    port,
    boot_id: boot_id.to_string(),
    app_data_dir: app_data_dir.map(Path::to_path_buf),
  };
  let child = spawn_next_server(&config)?;
  let state = app.state::<ServerProcess>();
  *state.child.lock().expect("server process lock poisoned") = Some(child);
  Ok(config)
}

fn spawn_next_server(config: &NextServerConfig) -> Result<Child, Box<dyn std::error::Error>> {
  let server_dir = config.resource_dir.join("next-server");
  let bundled_plugin_dir = server_dir.join("agent-skills");
  let node_binary = config
    .resource_dir
    .join("node")
    .join(if cfg!(windows) { "node.exe" } else { "node" });
  let node_command = if node_binary.exists() {
    node_binary
  } else {
    "node".into()
  };
  // 子进程 stdout/stderr 重定向到 <resolvedDataDir>/logs/next-server.log,与 JS 端
  // server-<date>.log 同目录。以 append 保留跨启动历史,超过上限时滚动为单个 .1 归档,
  // 避免历史丢失与无限增长。打不开文件则回退 null(best-effort,绝不阻塞启动)。
  let (stdout_cfg, stderr_cfg) = match open_next_server_log(config.app_data_dir.as_deref(), &config.boot_id) {
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
    .env("PORT", config.port.to_string())
    .env("FINANCE_AGENT_BOOT_ID", &config.boot_id)
    .env("FINANCE_AGENT_PROJECT_ROOT", &server_dir)
    .env("FINANCE_AGENT_BUNDLED_PLUGIN_DIR", bundled_plugin_dir)
    .stdout(stdout_cfg)
    .stderr(stderr_cfg);
  if let Some(dir) = &config.app_data_dir {
    command.env("FINANCE_AGENT_APP_DATA_DIR", dir);
  }

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
    config.boot_id,
    child.id(),
    config.port
  );

  // Windows:把子进程绑进 KILL_ON_JOB_CLOSE 的 Job Object。窗口 Destroyed 时已显式 kill(见 on_window_event),
  // 但崩溃/被强杀/异常退出兜不住 → 残留 node 占内存(端口已靠动态选避开)。Job Object 让父进程一旦消失(含崩溃),
  // OS 关闭 job 句柄即连带杀掉子进程,彻底回收。仅 Windows 需要。
  #[cfg(windows)]
  confine_child_to_job(&child);

  Ok(child)
}

fn start_next_server_supervisor(
  window: tauri::WebviewWindow,
  config: NextServerConfig,
  real_url: String,
) {
  std::thread::spawn(move || {
    let state = window.app_handle().state::<ServerProcess>();
    let mut restarted = false;
    let mut ready = false;
    let mut ready_deadline = Instant::now() + Duration::from_secs(60);

    loop {
      if state.shutting_down.load(Ordering::SeqCst) {
        return;
      }

      let exited_child = {
        let mut child = state.child.lock().expect("server process lock poisoned");
        let status = match child.as_mut() {
          Some(child) => {
            let pid = child.id();
            match child.try_wait() {
              Ok(status) => status.map(|status| (pid, status)),
              Err(error) => {
                log::error!(
                  "next_server_status_check_failed bootId={} error={error}",
                  config.boot_id
                );
                None
              }
            }
          },
          None => return,
        };
        if status.is_some() {
          child.take();
        }
        status
      };

      if let Some((pid, status)) = exited_child {
        log::error!(
          "next_server_exited bootId={} pid={} port={} {} restartAttempted={}",
          config.boot_id,
          pid,
          config.port,
          describe_exit_status(&status),
          restarted
        );
        match next_server_exit_action(state.shutting_down.load(Ordering::SeqCst), restarted) {
          NextServerExitAction::Stop => return,
          NextServerExitAction::ShowError => {
            log::error!(
              "next_server_unrecoverable bootId={} reason=exited_after_restart",
              config.boot_id
            );
            show_next_server_error(&window, &config.boot_id);
            return;
          }
          NextServerExitAction::Restart => {}
        }
        log::warn!("next_server_restarting bootId={} attempt=1", config.boot_id);
        match spawn_next_server(&config) {
          Ok(mut child) => {
            if state.shutting_down.load(Ordering::SeqCst) {
              let _ = child.kill();
              return;
            }
            *state.child.lock().expect("server process lock poisoned") = Some(child);
            restarted = true;
            ready = false;
            ready_deadline = Instant::now() + Duration::from_secs(60);
            continue;
          }
          Err(error) => {
            log::error!(
              "next_server_restart_failed bootId={} attempt=1 error={error}",
              config.boot_id
            );
            show_next_server_error(&window, &config.boot_id);
            return;
          }
        }
      }

      if !ready && http_health_ok(&format!("127.0.0.1:{}", config.port)) {
        ready = true;
        if restarted {
          log::info!(
            "next_server_recovered bootId={} port={} attempt=1",
            config.boot_id,
            config.port
          );
        } else {
          log::info!(
            "next_server_ready bootId={} port={}",
            config.boot_id,
            config.port
          );
        }
        navigate_next_server(&window, &real_url, &config.boot_id);
      } else if !ready && Instant::now() >= ready_deadline {
        if restarted {
          log::error!(
            "next_server_restart_ready_timeout bootId={} port={} attempt=1",
            config.boot_id,
            config.port
          );
          show_next_server_error(&window, &config.boot_id);
          return;
        }
        log::warn!(
          "next_server_ready_timeout bootId={} port={}",
          config.boot_id,
          config.port
        );
        ready = true;
        navigate_next_server(&window, &real_url, &config.boot_id);
      }

      std::thread::sleep(Duration::from_millis(150));
    }
  });
}

fn describe_exit_status(status: &ExitStatus) -> String {
  if let Some(code) = status.code() {
    return format!("exitCode={code}");
  }
  #[cfg(unix)]
  {
    use std::os::unix::process::ExitStatusExt;
    if let Some(signal) = status.signal() {
      return format!("signal={signal}");
    }
  }
  format!("exitCode=unavailable status={status}")
}

fn navigate_next_server(window: &tauri::WebviewWindow, url: &str, boot_id: &str) {
  if let Err(error) = window.eval(&format!("window.location.replace('{url}')")) {
    log::error!(
      "next_server_navigation_failed bootId={} error={error}",
      boot_id
    );
  }
}

fn show_next_server_error(window: &tauri::WebviewWindow, boot_id: &str) {
  let error_url = match SERVER_ERROR_URL.parse() {
    Ok(url) => url,
    Err(error) => {
      log::error!(
        "next_server_error_url_invalid bootId={} error={error}",
        boot_id
      );
      return;
    }
  };
  if let Err(error) = window.navigate(error_url) {
    log::error!(
      "next_server_error_page_failed bootId={} error={error}",
      boot_id
    );
  }
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

/// next-server 子进程日志文件(<resolvedDataDir>/logs/next-server.log)。
/// 每次宿主启动时检查大小:跨启动追加,达到 8 MiB 时保留一个 `.1` 归档。
/// 单次长运行可暂时超过阈值,下次启动时收敛;打开失败返回 None → 调用方回退 Stdio::null()。
fn open_next_server_log(app_data_dir: Option<&Path>, boot_id: &str) -> Option<File> {
  let dir = app_data_dir?.join("logs");
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

/// 解析宿主和内置 Node 共用的数据目录。Windows release 默认跟随安装盘但位于安装目录外，
/// 以免卸载程序删除用户数据；开发态及其它平台继续使用标准系统应用数据目录。
fn resolve_app_data_dir(app: &tauri::App, is_release: bool) -> Option<PathBuf> {
  for key in ["FINANCE_AGENT_APP_DATA_DIR", "FINANCE_AGENT_DATA_DIR"] {
    if let Ok(value) = std::env::var(key) {
      if !value.is_empty() {
        return Some(PathBuf::from(value));
      }
    }
  }
  let standard_dir = app_data_root(app).map(|root| root.join(APP_DIRECTORY_NAME));
  #[cfg(windows)]
  if is_release {
    if let Ok(executable) = std::env::current_exe() {
      let protected_roots = windows_program_files_roots();
      if let Some(dir) = release_windows_app_data_dir(
        &executable,
        &protected_roots,
        standard_dir.as_deref(),
      ) {
        return Some(dir);
      }
    }
  }
  let _ = is_release;
  standard_dir
}

#[cfg(windows)]
fn windows_program_files_roots() -> Vec<PathBuf> {
  ["PROGRAMFILES", "PROGRAMFILES(X86)", "ProgramW6432"]
    .iter()
    .filter_map(|key| std::env::var(key).ok())
    .filter(|value| !value.is_empty())
    .map(PathBuf::from)
    .collect()
}

/// `D:\\Finwork\\Finwork.exe` -> `D:\\Finwork Data`；若安装目录位于 Program Files，
/// 则回落到可写的标准用户数据目录。
fn release_windows_app_data_dir(
  executable: &Path,
  protected_roots: &[PathBuf],
  protected_fallback: Option<&Path>,
) -> Option<PathBuf> {
  let install_dir = executable.parent()?;
  if protected_roots
    .iter()
    .any(|root| windows_path_is_within(install_dir, root))
  {
    return protected_fallback.map(Path::to_path_buf);
  }
  install_dir
    .parent()
    .map(|root| root.join(WINDOWS_RELEASE_DATA_DIRECTORY_NAME))
}

fn windows_path_is_within(candidate: &Path, root: &Path) -> bool {
  let candidate = normalized_windows_path(candidate);
  let root = normalized_windows_path(root);
  !root.is_empty()
    && (candidate == root
    || candidate
      .strip_prefix(&root)
      .is_some_and(|suffix| suffix.starts_with('\\')))
}

fn normalized_windows_path(path: &Path) -> String {
  let normalized = path
    .to_string_lossy()
    .replace('/', "\\")
    .trim_end_matches('\\')
    .to_lowercase();
  normalized
    .strip_prefix("\\\\?\\")
    .unwrap_or(&normalized)
    .to_string()
}

/// 复刻 JS 端 paths.ts::getDefaultAppDataDir 所用的平台默认根。
/// 故意不走 Tauri app_data_dir()(它会额外带 bundle identifier 子目录)。
fn app_data_root(app: &tauri::App) -> Option<PathBuf> {
  let home = app.path().home_dir().ok();
  #[cfg(windows)]
  {
    if let Ok(appdata) = std::env::var("LOCALAPPDATA") {
      if !appdata.is_empty() {
        return Some(PathBuf::from(appdata));
      }
    }
    return home.map(|h| h.join("AppData").join("Local"));
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

const SERVER_ERROR_URL: &str = "data:text/html,<!doctype html><html><head><meta charset='utf-8'><style>html,body{margin:0;height:100%;background:rgb(250,250,250);font-family:system-ui;color:rgb(45,45,50)}.wrap{height:100%;display:flex;align-items:center;justify-content:center}.card{text-align:center;max-width:460px;padding:32px}.title{font-size:20px;font-weight:600;margin-bottom:12px}.body{font-size:14px;line-height:1.7;color:rgb(95,95,105)}</style></head><body><div class='wrap'><div class='card'><div class='title'>Finwork 服务未能恢复</div><div class='body'>请完全退出 Finwork 后重新打开。诊断信息已写入应用日志。</div></div></div></body></html>";

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
  fn release_windows_data_directory_is_a_sibling_of_the_install_directory() {
    let executable = Path::new("/Volumes/D/Finwork/Finwork.exe");
    assert_eq!(
      release_windows_app_data_dir(executable, &[], None),
      Some(PathBuf::from("/Volumes/D/Finwork Data"))
    );
    assert_eq!(
      release_windows_app_data_dir(Path::new("Finwork.exe"), &[], None),
      None
    );
  }

  #[test]
  fn release_windows_data_directory_falls_back_for_program_files_install() {
    let executable = Path::new("/System/Program Files/Finwork/Finwork.exe");
    let protected_roots = [PathBuf::from("/SYSTEM/PROGRAM FILES")];
    let fallback = Path::new("/Users/test/AppData/Local/Finwork");
    assert_eq!(
      release_windows_app_data_dir(executable, &protected_roots, Some(fallback)),
      Some(fallback.to_path_buf())
    );
    assert!(!windows_path_is_within(
      Path::new("/System/Program Files Portable/Finwork"),
      &protected_roots[0]
    ));
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

  #[cfg(unix)]
  #[test]
  fn next_server_exit_diagnostic_includes_the_exit_code() {
    let status = Command::new("sh")
      .arg("-c")
      .arg("exit 23")
      .status()
      .unwrap();

    assert_eq!(describe_exit_status(&status), "exitCode=23");
  }

  #[cfg(windows)]
  #[test]
  fn next_server_exit_diagnostic_includes_the_windows_exit_code() {
    use std::os::windows::process::ExitStatusExt;

    let status = ExitStatus::from_raw(23);

    assert_eq!(describe_exit_status(&status), "exitCode=23");
  }

  #[test]
  fn first_unexpected_next_server_exit_requests_one_restart() {
    assert_eq!(
      next_server_exit_action(false, false),
      NextServerExitAction::Restart
    );
  }

  #[test]
  fn next_server_exit_after_restart_is_unrecoverable() {
    assert_eq!(
      next_server_exit_action(false, true),
      NextServerExitAction::ShowError
    );
  }

  #[test]
  fn requested_shutdown_never_restarts_next_server() {
    assert_eq!(
      next_server_exit_action(true, false),
      NextServerExitAction::Stop
    );
  }

  #[test]
  fn close_requested_does_not_shutdown_the_next_server() {
    assert!(!should_shutdown_for_window_event(
      WindowShutdownEvent::CloseRequested
    ));
  }

  #[test]
  fn destroyed_window_shuts_down_the_next_server() {
    assert!(should_shutdown_for_window_event(
      WindowShutdownEvent::Destroyed
    ));
  }
}
