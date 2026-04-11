use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{Emitter, Manager, Wry};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
struct SessionTab {
    id: String,
    title: String,
    path: Option<String>,
    serialized: String,
    is_dirty: bool,
    newline: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
struct SessionState {
    tabs: Vec<SessionTab>,
    active_tab_id: Option<String>,
}

#[derive(Debug, Serialize)]
struct FilePayload {
    content: String,
    newline: String,
}

struct CloseState {
    approved: Mutex<bool>,
    pending: Mutex<bool>,
}

fn session_path(app: &tauri::AppHandle<Wry>) -> Result<PathBuf, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&config_dir).map_err(|error| error.to_string())?;
    Ok(config_dir.join("session.json"))
}

fn detect_newline(content: &str) -> &'static str {
    if content.contains("\r\n") {
        "crlf"
    } else {
        "lf"
    }
}

#[tauri::command]
fn read_document(path: String) -> Result<FilePayload, String> {
    let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    Ok(FilePayload {
        newline: detect_newline(&content).to_string(),
        content,
    })
}

#[tauri::command]
fn write_document(path: String, content: String) -> Result<(), String> {
    let path_buf = Path::new(&path);
    if let Some(parent) = path_buf.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(path_buf, content).map_err(|error| error.to_string())
}

#[tauri::command]
fn save_session_state(app: tauri::AppHandle<Wry>, session: SessionState) -> Result<(), String> {
    let session_file = session_path(&app)?;
    let json = serde_json::to_string_pretty(&session).map_err(|error| error.to_string())?;
    fs::write(session_file, json).map_err(|error| error.to_string())
}

#[tauri::command]
fn load_session_state(app: tauri::AppHandle<Wry>) -> Result<Option<SessionState>, String> {
    let session_file = session_path(&app)?;
    if !session_file.exists() {
        return Ok(None);
    }

    let json = fs::read_to_string(session_file).map_err(|error| error.to_string())?;
    let session = serde_json::from_str::<SessionState>(&json).map_err(|error| error.to_string())?;
    Ok(Some(session))
}

#[tauri::command]
fn approve_window_close(app: tauri::AppHandle<Wry>) -> Result<(), String> {
    let state = app.state::<CloseState>();
    let mut approved = state.approved.lock().map_err(|error| error.to_string())?;
    let mut pending = state.pending.lock().map_err(|error| error.to_string())?;
    *approved = true;
    *pending = false;
    Ok(())
}

#[tauri::command]
fn cancel_window_close(app: tauri::AppHandle<Wry>) -> Result<(), String> {
    let state = app.state::<CloseState>();
    let mut approved = state.approved.lock().map_err(|error| error.to_string())?;
    let mut pending = state.pending.lock().map_err(|error| error.to_string())?;
    *approved = false;
    *pending = false;
    Ok(())
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle<Wry>) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(CloseState {
            approved: Mutex::new(false),
            pending: Mutex::new(false),
        })
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_document,
            write_document,
            save_session_state,
            load_session_state,
            approve_window_close,
            cancel_window_close,
            exit_app
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<CloseState>();
                let Ok(mut approved) = state.approved.lock() else {
                    api.prevent_close();
                    return;
                };
                let Ok(mut pending) = state.pending.lock() else {
                    api.prevent_close();
                    return;
                };

                if *approved {
                    *approved = false;
                    *pending = false;
                    return;
                }

                api.prevent_close();
                if *pending {
                    return;
                }
                *pending = true;
                let _ = window.emit("app-close-requested", ());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
