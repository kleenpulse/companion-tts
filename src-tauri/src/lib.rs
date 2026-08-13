mod attention;
mod audio_cache;
mod local_tts;
mod parser;
mod piper_tts;
mod sessions;
mod settings;
mod shortcuts;
mod synth;
mod tail;
mod tailer;
mod tray;
mod watcher;
mod windows;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Single-instance MUST be first: a second launch focuses the existing FAB.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Focus whichever face of the companion is currently showing.
            if let Some(panel) = app.get_webview_window("panel") {
                if panel.is_visible().unwrap_or(false) {
                    let _ = panel.set_focus();
                    return;
                }
            }
            if let Some(fab) = app.get_webview_window("fab") {
                let _ = fab.show();
                let _ = fab.set_focus();
            }
        }))
        .plugin(shortcuts::plugin())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .setup(|app| {
            let handle = app.handle().clone();

            // espeak-ng (piper phonemization) finds its data via this env var —
            // point it at the bundled copy before anything can synthesize.
            if let Ok(res_dir) = handle.path().resource_dir() {
                // resource_dir comes back as an extended-length path (\\?\D:\…).
                // Rust fs is fine with it; espeak-ng's C fopen is NOT — the
                // prefix disables normalization and its '/'-joined subpaths
                // stop resolving. Hand the C side a plain path.
                let data_parent = res_dir.join("resources");
                let plain = data_parent
                    .to_string_lossy()
                    .trim_start_matches(r"\\?\")
                    .to_string();
                eprintln!(
                    "[piper] espeak data parent: {plain} (espeak-ng-data exists: {})",
                    data_parent.join("espeak-ng-data").exists()
                );
                std::env::set_var(piper_tts::ESPEAK_DATA_ENV, plain);
            }

            let loaded = settings::load(&handle);
            app.manage(settings::SettingsState(std::sync::Mutex::new(loaded.clone())));
            app.manage(synth::SynthState::default());
            app.manage(sessions::SessionsState::default());
            app.manage(shortcuts::ShortcutBindings::default());

            windows::restore_fab_position(&handle);
            windows::apply_fab_scale(&handle, loaded.fab_scale);
            tray::init(app)?;
            shortcuts::apply(&handle, &loaded);
            windows::apply_autostart(&handle, loaded.autostart);
            // The Claude Code hooks are the attention feature's plumbing —
            // managed like autostart. Idempotent, so an install predating the
            // PermissionRequest hook is upgraded here; backs up the original once.
            if loaded.features.attention {
                if let Err(e) = attention::ensure_hook(&handle) {
                    eprintln!("[attention] hook install failed: {e}");
                }
            }
            attention::spawn(handle.clone());
            watcher::spawn(handle);
            Ok(())
        })
        .on_window_event(|window, event| windows::handle_window_event(window, event))
        .invoke_handler(tauri::generate_handler![
            settings::get_settings,
            settings::set_settings,
            sessions::list_sessions,
            sessions::tail_backfill,
            sessions::hide_session,
            synth::synthesize,
            synth::provider_status,
            local_tts::list_windows_voices,
            piper_tts::list_piper_voices,
            piper_tts::download_piper_voice,
            piper_tts::remove_piper_voice,
            windows::toggle_panel,
            windows::quit_app,
            windows::report_audio_unlocked,
            windows::preview_fab_scale,
            windows::end_fab_preview,
            attention::attention_hook_status,
            attention::install_attention_hook,
        ])
        .run(tauri::generate_context!())
        .expect("error while running companion-tts");
}
