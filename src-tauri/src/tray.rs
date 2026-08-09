use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{App, Emitter, Listener, Manager};
use tauri_plugin_autostart::ManagerExt;

pub fn init(app: &App) -> tauri::Result<()> {
    let handle = app.handle();

    let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);

    let toggle_fab = MenuItem::with_id(app, "toggle-fab", "Show / hide companion", true, None::<&str>)?;
    let mute = CheckMenuItem::with_id(app, "mute", "Mute", true, false, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(app, "autostart", "Start with Windows", true, autostart_on, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Companion", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(app, &[&toggle_fab, &mute, &autostart, &sep, &quit])?;

    let autostart_item = autostart.clone();
    let tray = TrayIconBuilder::with_id("companion")
        .icon(app.default_window_icon().expect("app icon").clone())
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("Companion — idle")
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "toggle-fab" => {
                if let Some(fab) = app.get_webview_window("fab") {
                    if fab.is_visible().unwrap_or(false) {
                        let _ = fab.hide();
                        crate::windows::hide_panel(app);
                    } else {
                        let _ = fab.show();
                    }
                }
            }
            "mute" => {
                // Engine owns mute state; the check syncs back via engine-state.
                let _ = app.emit_to("fab", "engine-cmd", serde_json::json!({ "cmd": "toggle-mute" }));
            }
            "autostart" => {
                let manager = app.autolaunch();
                let enabled = manager.is_enabled().unwrap_or(false);
                let _ = if enabled { manager.disable() } else { manager.enable() };
                let _ = autostart_item.set_checked(!enabled);
            }
            "quit" => {
                // Flush the latest settings snapshot before dying.
                let state = app.state::<crate::settings::SettingsState>();
                let snapshot = state.0.lock().unwrap().clone();
                crate::settings::save(app, &snapshot);
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    // Keep the tray honest: fab's engine broadcasts its state, tray mirrors it.
    let mute_item = mute.clone();
    let tray_handle = tray.clone();
    handle.listen("engine-state", move |event| {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(event.payload()) else {
            return;
        };
        let mode = v["mode"].as_str().unwrap_or("idle");
        let queued = v["queue"].as_array().map(|a| a.len()).unwrap_or(0);
        let _ = mute_item.set_checked(mode == "muted");
        let tooltip = match mode {
            "speaking" => format!("Companion — speaking ({queued} queued)"),
            "watching" => "Companion — watching".to_string(),
            "paused" => "Companion — paused".to_string(),
            "muted" => "Companion — muted".to_string(),
            "error" => "Companion — error".to_string(),
            _ => "Companion — idle".to_string(),
        };
        let _ = tray_handle.set_tooltip(Some(tooltip));
    });

    Ok(())
}
