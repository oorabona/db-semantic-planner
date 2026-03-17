mod sidecar;

use sidecar::{sidecar_kill, sidecar_send, sidecar_spawn, SidecarState};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder},
    Emitter, Manager,
};

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}!", name)
}

/// Enable or disable a native menu item by its id.
/// Called from the frontend to keep menu state in sync with app state.
#[tauri::command]
fn update_menu_item(app: tauri::AppHandle, id: String, enabled: bool) -> Result<(), String> {
    let menu = app.menu().ok_or("No menu set on application")?;
    let item = menu
        .get(&id)
        .ok_or_else(|| format!("Menu item '{}' not found", id))?;
    item.as_menuitem()
        .ok_or_else(|| format!("'{}' is not a menu item", id))?
        .set_enabled(enabled)
        .map_err(|e| e.to_string())
}

fn build_file_submenu(app: &tauri::App) -> tauri::Result<tauri::menu::Submenu<tauri::Wry>> {
    let new_query_sub = SubmenuBuilder::new(app, "New Query")
        .item(&MenuItemBuilder::with_id("file.new_query_sql", "SQL").accelerator("CmdOrCtrl+N").build(app)?)
        .item(&MenuItemBuilder::with_id("file.new_query_nql", "NQL / DBSP").accelerator("CmdOrCtrl+Shift+N").build(app)?)
        .build()?;

    SubmenuBuilder::new(app, "File")
        .item(&MenuItemBuilder::with_id("file.new_project", "New Project...").build(app)?)
        .item(&new_query_sub)
        .separator()
        .item(&MenuItemBuilder::with_id("file.open_file", "Open File...").accelerator("CmdOrCtrl+O").build(app)?)
        .item(&MenuItemBuilder::with_id("file.open_folder", "Open Project...").accelerator("CmdOrCtrl+Shift+O").build(app)?)
        .item(&MenuItemBuilder::with_id("file.recent_projects", "Recent Projects...").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("file.save", "Save").accelerator("CmdOrCtrl+S").enabled(false).build(app)?)
        .item(&MenuItemBuilder::with_id("file.save_as", "Save As...").accelerator("CmdOrCtrl+Shift+S").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("file.export_csv", "Export Results (CSV)").accelerator("CmdOrCtrl+E").enabled(false).build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("file.close_tab", "Close Tab").accelerator("CmdOrCtrl+W").build(app)?)
        .item(&MenuItemBuilder::with_id("file.preferences", "Preferences...").accelerator("CmdOrCtrl+,").build(app)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()
}

fn build_edit_submenu(app: &tauri::App) -> tauri::Result<tauri::menu::Submenu<tauri::Wry>> {
    SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .separator()
        .item(&MenuItemBuilder::with_id("edit.find", "Find").accelerator("CmdOrCtrl+F").build(app)?)
        .item(&MenuItemBuilder::with_id("edit.replace", "Replace").accelerator("CmdOrCtrl+H").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("edit.format", "Format Document").accelerator("CmdOrCtrl+Shift+F").build(app)?)
        .build()
}

fn build_view_submenu(app: &tauri::App) -> tauri::Result<tauri::menu::Submenu<tauri::Wry>> {
    SubmenuBuilder::new(app, "View")
        .item(&MenuItemBuilder::with_id("view.command_palette", "Command Palette").accelerator("CmdOrCtrl+K").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("view.toggle_sidebar", "Toggle Sidebar").accelerator("CmdOrCtrl+B").build(app)?)
        .item(&MenuItemBuilder::with_id("view.toggle_results", "Toggle Results Panel").accelerator("CmdOrCtrl+J").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("view.zoom_in", "Zoom In").accelerator("CmdOrCtrl+=").build(app)?)
        .item(&MenuItemBuilder::with_id("view.zoom_out", "Zoom Out").accelerator("CmdOrCtrl+-").build(app)?)
        .item(&MenuItemBuilder::with_id("view.zoom_reset", "Reset Zoom").accelerator("CmdOrCtrl+0").build(app)?)
        .build()
}

fn build_connection_submenu(app: &tauri::App) -> tauri::Result<tauri::menu::Submenu<tauri::Wry>> {
    SubmenuBuilder::new(app, "Connection")
        .item(&MenuItemBuilder::with_id("connection.new", "New Connection...").build(app)?)
        .item(&MenuItemBuilder::with_id("connection.disconnect", "Disconnect").enabled(false).build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("connection.manage", "Manage Profiles...").build(app)?)
        .build()
}

fn build_help_submenu(app: &tauri::App) -> tauri::Result<tauri::menu::Submenu<tauri::Wry>> {
    SubmenuBuilder::new(app, "Help")
        .item(&MenuItemBuilder::with_id("help.shortcuts", "Keyboard Shortcuts").accelerator("CmdOrCtrl+?").build(app)?)
        .item(&MenuItemBuilder::with_id("help.docs", "Documentation").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("help.about", "About DBSP Explorer").build(app)?)
        .item(&MenuItemBuilder::with_id("help.updates", "Check for Updates").build(app)?)
        .build()
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .manage(SidecarState::new())
        .setup(|app| {
            let menu = MenuBuilder::new(app)
                .item(&build_file_submenu(app)?)
                .item(&build_edit_submenu(app)?)
                .item(&build_view_submenu(app)?)
                .item(&build_connection_submenu(app)?)
                .item(&build_help_submenu(app)?)
                .build()?;
            app.set_menu(menu)?;

            // Forward menu events to the frontend as "menu://[id]"
            let handle = app.handle().clone();
            app.on_menu_event(move |_app, event| {
                let id = event.id().0.clone();
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.emit("menu-event", &id);
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            sidecar_spawn,
            sidecar_send,
            sidecar_kill,
            update_menu_item,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
