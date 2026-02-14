use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread;
use tauri::{AppHandle, Emitter, Manager};

/// Sidecar state managed by Tauri.
/// The Node.js sidecar is spawned directly via std::process::Command —
/// no platform-specific shell scripts or externalBin required.
pub struct SidecarState {
    inner: Mutex<Option<SidecarInner>>,
}

struct SidecarInner {
    stdin: std::process::ChildStdin,
    pid: u32,
}

impl SidecarState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }
}

/// Resolve tsx binary and sidecar script paths.
///
/// Walks up from CWD to find the gui package root (directory containing both
/// `sidecar/index.ts` and `node_modules/.bin/tsx`). Works regardless of whether
/// CWD is the gui package root, src-tauri/, or target/debug/.
fn resolve_sidecar_paths() -> Result<(PathBuf, PathBuf), String> {
    let cwd = std::env::current_dir().map_err(|e| format!("Cannot get CWD: {e}"))?;

    let mut dir = cwd.as_path();
    loop {
        let tsx = dir.join("node_modules/.bin/tsx");
        let script = dir.join("sidecar/index.ts");
        if script.exists() && tsx.exists() {
            return Ok((tsx, script));
        }
        dir = dir.parent().ok_or_else(|| {
            format!(
                "Cannot find gui package root from {}: need sidecar/index.ts + node_modules/.bin/tsx",
                cwd.display()
            )
        })?;
    }
}

/// Kill a process by PID (cross-platform).
fn kill_pid(pid: u32) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill").arg(pid.to_string()).status();
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .status();
    }
}

/// Spawn the sidecar process (tsx sidecar/index.ts) and return its PID.
#[tauri::command]
pub async fn sidecar_spawn(app: AppHandle) -> Result<u32, String> {
    let state = app.state::<SidecarState>();
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;

    // Kill existing sidecar if any
    if let Some(existing) = guard.take() {
        kill_pid(existing.pid);
        drop(existing.stdin);
    }

    let (tsx, script) = resolve_sidecar_paths()?;

    let mut child = Command::new(&tsx)
        .arg(&script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            format!(
                "Failed to spawn sidecar ({} {}): {e}",
                tsx.display(),
                script.display()
            )
        })?;

    let pid = child.id();
    let stdin = child
        .stdin
        .take()
        .ok_or("Failed to capture sidecar stdin")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Failed to capture sidecar stdout")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("Failed to capture sidecar stderr")?;

    // Forward stdout line by line to frontend
    let app_stdout = app.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            let _ = app_stdout.emit("sidecar-stdout", &line);
        }
    });

    // Forward stderr line by line to frontend
    let app_stderr = app.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            let _ = app_stderr.emit("sidecar-stderr", &line);
        }
    });

    // Monitor thread: wait for child to exit, then emit exit event
    let app_exit = app.clone();
    thread::spawn(move || {
        let status = child.wait();
        let code = status.ok().and_then(|s| s.code());
        let _ = app_exit.emit("sidecar-exit", code);
    });

    *guard = Some(SidecarInner { stdin, pid });
    Ok(pid)
}

/// Send a message to the sidecar's stdin.
#[tauri::command]
pub async fn sidecar_send(app: AppHandle, message: String) -> Result<(), String> {
    let state = app.state::<SidecarState>();
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;

    match guard.as_mut() {
        Some(inner) => {
            inner
                .stdin
                .write_all(message.as_bytes())
                .map_err(|e| format!("Failed to write to sidecar: {e}"))?;
            inner
                .stdin
                .flush()
                .map_err(|e| format!("Failed to flush sidecar stdin: {e}"))
        }
        None => Err("Sidecar is not running".into()),
    }
}

/// Kill the sidecar process.
#[tauri::command]
pub async fn sidecar_kill(app: AppHandle) -> Result<(), String> {
    let state = app.state::<SidecarState>();
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;

    if let Some(existing) = guard.take() {
        kill_pid(existing.pid);
        drop(existing.stdin);
    }

    Ok(())
}
