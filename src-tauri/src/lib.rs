// Minimal test shell: serves the same static spike page, no plugins, no commands, no capabilities.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running Graphite spike shell");
}
