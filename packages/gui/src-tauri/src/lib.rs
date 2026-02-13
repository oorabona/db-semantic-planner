mod sidecar;

use sidecar::{sidecar_kill, sidecar_send, sidecar_spawn, SidecarState};

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}!", name)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(SidecarState::new())
        .invoke_handler(tauri::generate_handler![
            greet,
            sidecar_spawn,
            sidecar_send,
            sidecar_kill,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
