mod api_docs;
mod aptabase;
mod commands;
mod replay;
mod riot;
mod settings_decoder;
mod share;
mod store;
mod translate;
mod updater;
mod util_time;
mod xmpp;

use riot::client::RiotState;
use serde_json::json;
use store::{ConfigStore, ProfilesStore, Store};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let mut config_defaults = serde_json::Map::new();
            config_defaults.insert("openDevTools".into(), json!(false));
            config_defaults.insert("autoUpdate".into(), json!(true));
            config_defaults.insert("translatorProvider".into(), json!("google"));
            config_defaults.insert("translatorTargetLanguage".into(), json!("en"));
            config_defaults.insert("deeplApiKey".into(), json!(""));
            let config_store = Store::new("config", config_defaults);

            let open_dev_tools = matches!(config_store.get("openDevTools"), Some(v) if v == json!(true));
            if open_dev_tools {
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                }
            }

            let mut profiles_defaults = serde_json::Map::new();
            profiles_defaults.insert("profiles".into(), json!([]));
            let profiles_store = Store::new("profiles", profiles_defaults);

            let auto_update = matches!(config_store.get("autoUpdate"), Some(v) if v == json!(true)) || config_store.get("autoUpdate").is_none();

            app.manage(ConfigStore(config_store));
            app.manage(ProfilesStore(profiles_store));
            app.manage(RiotState::default());
            app.manage(commands::live::LiveCache::default());
            app.manage(commands::matches::MatchCache::default());

            if auto_update {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    updater::check_for_updates(&app_handle, true).await;
                    let mut interval = tokio::time::interval(std::time::Duration::from_secs(60 * 60));
                    interval.tick().await; // first tick fires immediately; already checked above
                    loop {
                        interval.tick().await;
                        updater::check_for_updates(&app_handle, true).await;
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app::open_url,
            commands::app::version,
            commands::app::clipboard_get,
            commands::app::clipboard_set,
            commands::app::debug_save_json,
            commands::app::analytics_track,
            commands::app::update_check,
            commands::app::config_get_all,
            commands::app::config_set,
            commands::riot::client_info_get,
            commands::riot::tokens_get,
            commands::riot::tokens_refresh,
            commands::riot::userinfo_get,
            commands::riot::swagger_spec_get,
            commands::riot::swagger_open,
            commands::profiles::settings_get,
            commands::profiles::settings_profile_list,
            commands::profiles::settings_profile_add,
            commands::profiles::settings_profile_remove,
            commands::profiles::settings_profile_rename,
            commands::profiles::settings_profile_duplicate,
            commands::profiles::settings_profile_load,
            commands::profiles::settings_profile_view,
            commands::profiles::settings_current_view,
            commands::profiles::settings_profile_share,
            commands::profiles::share_get_data,
            commands::career::career_get,
            commands::live::live_game_fetch,
            commands::live::live_game_dump,
            commands::replays::replay_list,
            commands::replays::replay_delete,
            commands::replays::replay_export_json,
            commands::replays::replay_export_raw,
            commands::replays::replay_process,
            commands::friends::friends_get,
            commands::matches::match_list,
            commands::matches::match_details,
            commands::matches::match_summaries,
            commands::chat::chat_get,
            commands::chat::chat_translate,
            commands::chat::chat_send,
            commands::chat::chat_friend_action,
            commands::chat::chat_disconnect,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
