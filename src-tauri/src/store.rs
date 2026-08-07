use serde_json::{Map, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

/// Reimplementation of electron/util/store.ts: a whole-file JSON blob keyed
/// by top-level property names, synchronously rewritten on every `set`.
/// Uses the same on-disk location Electron's `app.getPath('userData')`
/// resolved to (`%APPDATA%\ValoUtils\<name>.json` on Windows) so existing
/// users' config.json/profiles.json are picked up unchanged.
pub struct Store {
    path: PathBuf,
    data: Mutex<Map<String, Value>>,
}

pub fn user_data_dir() -> PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(base).join("ValoUtils")
}

impl Store {
    pub fn new(config_name: &str, defaults: Map<String, Value>) -> Self {
        let dir = user_data_dir();
        let _ = fs::create_dir_all(&dir);
        let path = dir.join(format!("{config_name}.json"));

        let data = fs::read_to_string(&path)
            .ok()
            .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or(defaults);

        Store {
            path,
            data: Mutex::new(data),
        }
    }

    pub fn get(&self, key: &str) -> Option<Value> {
        self.data.lock().unwrap().get(key).cloned()
    }

    pub fn set(&self, key: &str, value: Value) {
        let mut data = self.data.lock().unwrap();
        data.insert(key.to_string(), value);
        let _ = fs::write(&self.path, serde_json::to_string(&*data).unwrap_or_default());
    }
}

/// Tauri's managed state is keyed by type, so the app's two JSON stores
/// (config.json, profiles.json) need distinct wrapper types to both be
/// `app.manage()`d at once.
pub struct ConfigStore(pub Store);
pub struct ProfilesStore(pub Store);

impl std::ops::Deref for ConfigStore {
    type Target = Store;
    fn deref(&self) -> &Store {
        &self.0
    }
}

impl std::ops::Deref for ProfilesStore {
    type Target = Store;
    fn deref(&self) -> &Store {
        &self.0
    }
}
