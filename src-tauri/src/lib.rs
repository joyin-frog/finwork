use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

struct ServerProcess(Mutex<Option<Child>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(ServerProcess(Mutex::new(None)))
    .setup(|app| {
      let url = if cfg!(debug_assertions) {
        "http://127.0.0.1:3000".to_string()
      } else {
        let port = desktop_server_port();
        start_next_server(app, port)?;
        format!("http://127.0.0.1:{port}")
      };

      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      app.handle().plugin(tauri_plugin_dialog::init())?;
      app.handle().plugin(tauri_plugin_fs::init())?;
      app.handle().plugin(tauri_plugin_shell::init())?;
      app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;

      // 生产态:先把窗口加载到内置 loading 占位页(数据 URL,瞬时可见),等内置 Next 服务真正
      // 就绪后再 navigate 到真实地址,消除"服务没起来就加载 → 白屏/连接错误页"。
      // 开发态:Next 由 beforeDevCommand 先起好,直接加载真实地址即可。
      let is_release = !cfg!(debug_assertions);
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
        let port = desktop_server_port();
        let win = window.clone();
        let real_url = url.clone();
        std::thread::spawn(move || {
          wait_for_server_ready(port, Duration::from_secs(60));
          let _ = win.eval(&format!("window.location.replace('{real_url}')"));
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

fn start_next_server(app: &mut tauri::App, port: u16) -> Result<(), Box<dyn std::error::Error>> {
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
  let mut command = Command::new(node_command);
  command
    .arg("server.js")
    .current_dir(&server_dir)
    .env("HOSTNAME", "127.0.0.1")
    .env("PORT", port.to_string())
    .env("FINANCE_AGENT_PROJECT_ROOT", &server_dir)
    .env("FINANCE_AGENT_BUNDLED_PLUGIN_DIR", bundled_plugin_dir)
    .stdout(Stdio::null())
    .stderr(Stdio::null());

  // Windows:node 是控制台程序,GUI 应用(windows_subsystem="windows")里直接 spawn 会给它弹一个
  // 独立控制台黑窗(Windows Terminal 标签标题取 node 的 process.title = "next-server (vX.Y.Z)"),
  // 盖在真正的 app 窗前 → 用户只看到「黑屏 next-server 窗口」。CREATE_NO_WINDOW(0x0800_0000)
  // 抑制该窗口;stdout/stderr 已 null,无输出丢失。仅 Windows 需要,其它平台无此问题。
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

  let state = app.state::<ServerProcess>();
  *state.0.lock().expect("server process lock poisoned") = Some(child);
  Ok(())
}

fn desktop_server_port() -> u16 {
  std::env::var("FINANCE_AGENT_DESKTOP_PORT")
    .ok()
    .and_then(|value| value.parse::<u16>().ok())
    .unwrap_or(39211)
}

// 内置 loading 占位页:纯 CSS 旋转指示器,无外部资源/脚本。
// 写成非 base64 数据 URL,故刻意回避 `#`(片段符)与 `%`(转义符):颜色用 rgb()、圆角用 999px、
// keyframes 用 from/to 而非百分比。
const SPLASH_URL: &str = "data:text/html,<!doctype html><html><head><meta charset='utf-8'><style>html,body{margin:0;height:100%;background:rgb(250,250,250)}.wrap{height:100%;display:flex;align-items:center;justify-content:center}.spin{width:28px;height:28px;border:3px solid rgb(225,225,228);border-top-color:rgb(90,90,100);border-radius:999px;animation:r 0.8s linear infinite}@keyframes r{from{transform:rotate(0)}to{transform:rotate(360deg)}}</style></head><body><div class='wrap'><div class='spin'></div></div></body></html>";

/// 轮询内置 Next 服务,直到 /api/health 返回 200 或超时。
/// 超时也放行(navigate 过去让用户看到真实状态),避免无限转圈。
fn wait_for_server_ready(port: u16, timeout: Duration) {
  let addr = format!("127.0.0.1:{port}");
  let deadline = Instant::now() + timeout;
  loop {
    if http_health_ok(&addr) {
      return;
    }
    if Instant::now() >= deadline {
      return;
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
