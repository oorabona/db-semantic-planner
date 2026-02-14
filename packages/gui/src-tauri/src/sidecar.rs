use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::{process::CommandChild, ShellExt};

/// Sidecar state managed by Tauri.
pub struct SidecarState {
    child: Mutex<Option<CommandChild>>,
}

impl SidecarState {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
        }
    }
}

/// Spawn the sidecar process and return its PID.
#[tauri::command]
pub async fn sidecar_spawn(app: AppHandle) -> Result<u32, String> {
    let state = app.state::<SidecarState>();
    let mut child_guard = state.child.lock().map_err(|e| e.to_string())?;

    // Kill existing sidecar if any
    if let Some(existing) = child_guard.take() {
        let _ = existing.kill();
    }

    let (mut rx, child) = app
        .shell()
        .sidecar("dbsp-sidecar")
        .map_err(|e| format!("Failed to create sidecar command: {e}"))?
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar: {e}"))?;

    let pid = child.pid();

    // Forward sidecar events to the frontend
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let _ = app_handle.emit("sidecar-stdout", String::from_utf8_lossy(&line).to_string());
                }
                CommandEvent::Stderr(line) => {
                    let _ = app_handle.emit("sidecar-stderr", String::from_utf8_lossy(&line).to_string());
                }
                CommandEvent::Terminated(status) => {
                    let _ = app_handle.emit("sidecar-exit", status.code);
                    break;
                }
                _ => {}
            }
        }
    });

    *child_guard = Some(child);
    Ok(pid)
}

/// Send a message to the sidecar's stdin.
#[tauri::command]
pub async fn sidecar_send(app: AppHandle, message: String) -> Result<(), String> {
    let state = app.state::<SidecarState>();
    let mut child_guard = state.child.lock().map_err(|e| e.to_string())?;

    match child_guard.as_mut() {
        Some(child) => child
            .write(message.as_bytes())
            .map_err(|e| format!("Failed to write to sidecar: {e}")),
        None => Err("Sidecar is not running".into()),
    }
}

/// Kill the sidecar process.
#[tauri::command]
pub async fn sidecar_kill(app: AppHandle) -> Result<(), String> {
    let state = app.state::<SidecarState>();
    let mut child_guard = state.child.lock().map_err(|e| e.to_string())?;

    if let Some(child) = child_guard.take() {
        child.kill().map_err(|e| format!("Failed to kill sidecar: {e}"))?;
    }

    Ok(())
}
