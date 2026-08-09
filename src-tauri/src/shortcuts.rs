use std::str::FromStr;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::settings::Settings;

#[derive(Default)]
pub struct ShortcutBindings(pub Mutex<Bindings>);

#[derive(Default)]
pub struct Bindings {
    pub mute: Option<Shortcut>,
    pub pause: Option<Shortcut>,
}

pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            let cmd = {
                let bindings = app.state::<ShortcutBindings>();
                let guard = bindings.0.lock().unwrap();
                if guard.mute.as_ref() == Some(shortcut) {
                    Some("toggle-mute")
                } else if guard.pause.as_ref() == Some(shortcut) {
                    Some("pause-resume")
                } else {
                    None
                }
            };
            if let Some(cmd) = cmd {
                let _ = app.emit_to("fab", "engine-cmd", serde_json::json!({ "cmd": cmd }));
            }
        })
        .build()
}

/// (Re)register both shortcuts from settings. Called at setup and on every settings save.
pub fn apply(app: &AppHandle, settings: &Settings) {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();

    let mute = Shortcut::from_str(&settings.shortcuts.mute).ok();
    let pause = Shortcut::from_str(&settings.shortcuts.pause_resume).ok();

    if let Some(sc) = mute {
        if let Err(e) = gs.register(sc) {
            eprintln!("[shortcuts] mute register failed: {e}");
        }
    }
    if let Some(sc) = pause {
        if let Err(e) = gs.register(sc) {
            eprintln!("[shortcuts] pause register failed: {e}");
        }
    }

    let bindings = app.state::<ShortcutBindings>();
    let mut guard = bindings.0.lock().unwrap();
    guard.mute = mute;
    guard.pause = pause;
}
