use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, WebviewWindow, Window, WindowEvent};
use tauri_plugin_autostart::ManagerExt;

use crate::settings::PanelBounds;

const GAP_LOGICAL: f64 = 12.0;
const FAB_BASE_LOGICAL: f64 = 64.0;
/// Mirror of tauri.conf.json panel minWidth/minHeight — parked bounds saved
/// before a min bump would otherwise restore a too-small window.
const PANEL_MIN_W_LOGICAL: f64 = 360.0;
const PANEL_MIN_H_LOGICAL: f64 = 560.0;
/// Moved/Resized events inside this window after a programmatic placement are ours, not the user's.
const SUPPRESS_MS: u64 = 800;

static FAB_SUPPRESS_UNTIL: AtomicU64 = AtomicU64::new(0);
static PANEL_SUPPRESS_UNTIL: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn suppress(which: &AtomicU64) {
    which.store(now_ms() + SUPPRESS_MS, Ordering::Relaxed);
}

fn suppressed(which: &AtomicU64) -> bool {
    now_ms() < which.load(Ordering::Relaxed)
}

fn fab_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("fab")
}

fn panel_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("panel")
}

fn point_on_some_monitor(app: &AppHandle, x: i32, y: i32) -> bool {
    app.available_monitors().unwrap_or_default().iter().any(|m| {
        let p = m.position();
        let s = m.size();
        x >= p.x && y >= p.y && x < p.x + s.width as i32 && y < p.y + s.height as i32
    })
}

/// The one way to die: flush the settings snapshot (geometry saves are
/// throttled to 1s — an unflushed drag would be lost), then exit. Shared by
/// the tray's Quit item and the panel's × command.
pub fn quit(app: &AppHandle) {
    let state = app.state::<crate::settings::SettingsState>();
    let snapshot = state.0.lock().unwrap().clone();
    crate::settings::save(app, &snapshot);
    app.exit(0);
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    quit(&app);
}

/// Show the panel where the user parked it, else anchored beside the FAB.
#[tauri::command]
pub fn toggle_panel(app: AppHandle) -> Result<bool, String> {
    let panel = panel_window(&app).ok_or("no panel window")?;
    if panel.is_visible().map_err(|e| e.to_string())? {
        panel.hide().map_err(|e| e.to_string())?;
        // The dial returns when the panel folds away.
        if let Some(fab) = fab_window(&app) {
            let _ = fab.show();
        }
        return Ok(false);
    }

    let parked = {
        let state = app.state::<crate::settings::SettingsState>();
        let guard = state.0.lock().unwrap();
        guard.panel_bounds
    };

    suppress(&PANEL_SUPPRESS_UNTIL);
    match parked {
        // Validate against the monitor layout — a parked spot on an unplugged
        // monitor falls back to anchoring.
        Some(b) if point_on_some_monitor(&app, b.x + 20, b.y + 20) => {
            let scale = panel.scale_factor().unwrap_or(1.0);
            let min_w = (PANEL_MIN_W_LOGICAL * scale) as u32;
            let min_h = (PANEL_MIN_H_LOGICAL * scale) as u32;
            panel
                .set_size(PhysicalSize::new(b.width.max(min_w), b.height.max(min_h)))
                .map_err(|e| e.to_string())?;
            panel
                .set_position(PhysicalPosition::new(b.x, b.y))
                .map_err(|e| e.to_string())?;
        }
        _ => position_panel_beside_fab(&app)?,
    }

    panel.show().map_err(|e| e.to_string())?;
    panel.set_focus().ok();
    // The webview stays alive while hidden, so document.visibilitychange never
    // fires on show — the panel needs an explicit cue to re-sync its scrollers.
    let _ = app.emit_to("panel", "panel-shown", ());
    // Panel open = the companion lives inline; the floating dial steps into the shadows.
    // (Engine keeps running in the hidden fab webview — throttling disabled via browser args.)
    if let Some(fab) = fab_window(&app) {
        let _ = fab.hide();
    }
    Ok(true)
}

pub fn hide_panel(app: &AppHandle) {
    if let Some(panel) = panel_window(app) {
        let _ = panel.hide();
    }
}

/// Left flank of the FAB; flip right at the monitor edge; clamp vertically.
fn position_panel_beside_fab(app: &AppHandle) -> Result<(), String> {
    let fab = fab_window(app).ok_or("no fab window")?;
    let panel = panel_window(app).ok_or("no panel window")?;

    let fab_pos = fab.outer_position().map_err(|e| e.to_string())?;
    let fab_size = fab.outer_size().map_err(|e| e.to_string())?;
    let panel_size = panel.outer_size().map_err(|e| e.to_string())?;

    let monitor = fab
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("fab has no monitor")?;
    let scale = monitor.scale_factor();
    let gap = (GAP_LOGICAL * scale).round() as i32;

    let mon_pos = monitor.position();
    let mon_size = monitor.size();
    let (wa_left, wa_top) = (mon_pos.x, mon_pos.y);
    let (wa_right, wa_bottom) = (
        mon_pos.x + mon_size.width as i32,
        mon_pos.y + mon_size.height as i32,
    );

    let mut x = fab_pos.x - gap - panel_size.width as i32;
    if x < wa_left {
        x = fab_pos.x + fab_size.width as i32 + gap;
    }
    if x + panel_size.width as i32 > wa_right {
        x = wa_right - panel_size.width as i32;
    }

    let mut y = fab_pos.y + (fab_size.height as i32 / 2) - (panel_size.height as i32 / 2);
    y = y.clamp(wa_top, (wa_bottom - panel_size.height as i32).max(wa_top));

    panel
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())
}

/// Restore the FAB where the user left it; default to lower-right of primary.
pub fn restore_fab_position(app: &AppHandle) {
    let Some(fab) = fab_window(app) else { return };
    let saved = {
        let state = app.state::<crate::settings::SettingsState>();
        let guard = state.0.lock().unwrap();
        guard.fab_position
    };

    suppress(&FAB_SUPPRESS_UNTIL);
    if let Some(pos) = saved {
        if point_on_some_monitor(app, pos.x, pos.y) {
            let _ = fab.set_position(PhysicalPosition::new(pos.x, pos.y));
            return;
        }
    }

    // Default roost: primary monitor, near the right edge, above the taskbar zone.
    if let Ok(Some(primary)) = app.primary_monitor() {
        let p = primary.position();
        let s = primary.size();
        let scale = primary.scale_factor();
        let fab_px = (64.0 * scale).round() as i32;
        let margin = (24.0 * scale).round() as i32;
        let x = p.x + s.width as i32 - fab_px - margin;
        let y = p.y + s.height as i32 - fab_px - (120.0 * scale).round() as i32;
        let _ = fab.set_position(PhysicalPosition::new(x, y));
    }
}

/// Resize the fab window to 64×scale logical, keeping the dial's center put.
/// This is the ONE sanctioned fab resize — programmatic, suppressed, and
/// center-preserving; the "windows are static" doctrine otherwise stands.
pub fn apply_fab_scale(app: &AppHandle, scale: f64) {
    let Some(fab) = fab_window(app) else { return };
    // Ceiling tracks the size slider's L10 = ×3.0 (window is 64×scale logical).
    let scale = scale.clamp(0.5, 3.0);
    let target_logical = FAB_BASE_LOGICAL * scale;

    let dpr = fab.scale_factor().unwrap_or(1.0);
    let target_px = (target_logical * dpr).round() as i32;

    let (Ok(pos), Ok(size)) = (fab.outer_position(), fab.outer_size()) else {
        return;
    };
    if size.width as i32 == target_px {
        return;
    }

    suppress(&FAB_SUPPRESS_UNTIL);
    let delta = (size.width as i32 - target_px) / 2;
    let _ = fab.set_size(LogicalSize::new(target_logical, target_logical));
    let _ = fab.set_position(PhysicalPosition::new(pos.x + delta, pos.y + delta));
}

/// Live preview while the user drags the Fab-size slider: the REAL fab window
/// appears beside the panel at the requested scale. Position moves are
/// suppressed, so the dial's saved roost is untouched.
#[tauri::command]
pub fn preview_fab_scale(app: AppHandle, scale: f64) -> Result<(), String> {
    let fab = fab_window(&app).ok_or("no fab window")?;
    let panel = panel_window(&app).ok_or("no panel window")?;
    if !panel.is_visible().unwrap_or(false) {
        // No panel on screen — the dial is already visible; just scale it.
        apply_fab_scale(&app, scale);
        return Ok(());
    }

    apply_fab_scale(&app, scale);

    let panel_pos = panel.outer_position().map_err(|e| e.to_string())?;
    let panel_size = panel.outer_size().map_err(|e| e.to_string())?;
    let fab_size = fab.outer_size().map_err(|e| e.to_string())?;
    let monitor = panel.current_monitor().map_err(|e| e.to_string())?;
    let gap = monitor
        .as_ref()
        .map(|m| (GAP_LOGICAL * m.scale_factor()).round() as i32)
        .unwrap_or(12);

    // Right flank of the panel, vertically centered; flip left at the edge.
    let mut x = panel_pos.x + panel_size.width as i32 + gap;
    if let Some(m) = &monitor {
        let right = m.position().x + m.size().width as i32;
        if x + fab_size.width as i32 > right {
            x = panel_pos.x - gap - fab_size.width as i32;
        }
    }
    let y = panel_pos.y + (panel_size.height as i32 / 2) - (fab_size.height as i32 / 2);

    suppress(&FAB_SUPPRESS_UNTIL);
    let _ = fab.set_position(PhysicalPosition::new(x, y));
    let _ = fab.show();
    Ok(())
}

/// Preview over: send the dial back to its roost; re-hide it if the panel owns
/// the stage.
#[tauri::command]
pub fn end_fab_preview(app: AppHandle) {
    restore_fab_position(&app);
    if let (Some(fab), Some(panel)) = (fab_window(&app), panel_window(&app)) {
        if panel.is_visible().unwrap_or(false) {
            let _ = fab.hide();
        }
    }
}

pub fn apply_autostart(app: &AppHandle, enabled: bool) {
    let manager = app.autolaunch();
    let _ = if enabled { manager.enable() } else { manager.disable() };
}

fn persist_panel_geometry(app: &AppHandle, panel: &Window) {
    if suppressed(&PANEL_SUPPRESS_UNTIL) {
        return;
    }
    if !panel.is_visible().unwrap_or(false) {
        return;
    }
    let (Ok(pos), Ok(size)) = (panel.outer_position(), panel.outer_size()) else {
        return;
    };
    crate::settings::update_panel_bounds(
        app,
        PanelBounds { x: pos.x, y: pos.y, width: size.width, height: size.height },
    );
}

pub fn handle_window_event(window: &Window, event: &WindowEvent) {
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            // The app lives in the tray; closing a window only hides it.
            api.prevent_close();
            let _ = window.hide();
            // Closing the panel brings the floating dial back.
            if window.label() == "panel" {
                if let Some(fab) = fab_window(window.app_handle()) {
                    let _ = fab.show();
                }
            }
        }
        WindowEvent::Moved(pos) => {
            let app = window.app_handle();
            match window.label() {
                "fab" => {
                    if suppressed(&FAB_SUPPRESS_UNTIL) {
                        return;
                    }
                    crate::settings::update_fab_position(app, pos.x, pos.y);
                    // Moving the anchor: close the panel and forget its parked spot.
                    crate::settings::clear_panel_bounds(app);
                    if let Some(panel) = panel_window(app) {
                        if panel.is_visible().unwrap_or(false) {
                            let _ = panel.hide();
                        }
                    }
                }
                "panel" => persist_panel_geometry(app, window),
                _ => {}
            }
        }
        WindowEvent::Resized(_) => {
            if window.label() == "panel" {
                persist_panel_geometry(window.app_handle(), window);
            }
        }
        _ => {}
    }
}

/// Fired by the fab webview after its silent autoplay probe.
#[tauri::command]
pub fn report_audio_unlocked(app: AppHandle, unlocked: bool) {
    if !unlocked {
        eprintln!("[audio] autoplay probe FAILED — narration will not start automatically");
    }
    let _ = app.emit("audio-unlocked", unlocked);
}
