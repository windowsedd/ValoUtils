# Riot Launch Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a normal Riot launch that never uses the local config proxy and make the existing proxied launch prove its local HTTP server is healthy before spawning Riot.

**Architecture:** Keep executable discovery, running-process detection, argument parsing, and spawning in `riot_launch.rs`. Add a dedicated loopback health route to `client_config.rs`; the proxied launch calls it after starting the relay and HTTP server, while the normal launch bypasses both services. Expose both commands through the existing colon-to-underscore Tauri bridge and render separate actions in `DummyBot.tsx`.

**Tech Stack:** Rust 2021, Tauri 2 commands, Tokio, Axum, Reqwest, React 19, TypeScript 6, i18next.

## Global Constraints

- Normal launch arguments are exactly `--launch-product=<product>` and `--launch-patchline=<patchline>` and never contain `--client-config-url`.
- Proxied launch uses `http://127.0.0.1:8000` only after the relay, config server, and health preflight succeed.
- Both launch modes refuse to spawn when `RiotClientServices.exe` is already running.
- A failed proxied startup or preflight stops both local services and does not spawn Riot.
- This plan does not change XMPP certificate trust or certificate loading.

---

### Task 1: Shared launch arguments and normal launch command

**Files:**
- Modify: `src-tauri/src/commands/riot_launch.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `fn launch_args(product: &str, patchline: &str, config_url: Option<&str>) -> Vec<String>`
- Produces: `#[tauri::command] pub async fn riot_launch_normal(args: Vec<Value>) -> Result<String, ()>`
- Consumes: existing `riot_client_exe()` and `riot_client_running()`.

- [ ] **Step 1: Write failing argument tests**

Add a `#[cfg(test)] mod tests` to `riot_launch.rs` with:

```rust
#[test]
fn normal_launch_arguments_omit_client_config() {
    let args = launch_args("valorant", "live", None);
    assert_eq!(args, ["--launch-product=valorant", "--launch-patchline=live"]);
    assert!(!args.iter().any(|arg| arg.starts_with("--client-config-url=")));
}

#[test]
fn proxied_launch_arguments_include_client_config() {
    let args = launch_args("valorant", "live", Some("http://127.0.0.1:8000"));
    assert_eq!(
        args,
        [
            "--client-config-url=http://127.0.0.1:8000",
            "--launch-product=valorant",
            "--launch-patchline=live",
        ]
    );
}
```

- [ ] **Step 2: Run tests and verify red**

Run: `cargo test commands::riot_launch::tests --lib`

Expected: compilation fails because `launch_args` does not exist.

- [ ] **Step 3: Add shared parsing, argument construction, and spawning**

Add:

```rust
fn parse_launch_target(args: &[Value]) -> (String, String) {
    let value = |index: usize, fallback: &str| {
        args.get(index)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(fallback)
            .to_string()
    };
    (value(0, "valorant"), value(1, "live"))
}

fn launch_args(product: &str, patchline: &str, config_url: Option<&str>) -> Vec<String> {
    let mut args = Vec::with_capacity(if config_url.is_some() { 3 } else { 2 });
    if let Some(url) = config_url {
        args.push(format!("--client-config-url={url}"));
    }
    args.push(format!("--launch-product={product}"));
    args.push(format!("--launch-patchline={patchline}"));
    args
}

fn spawn_riot(exe: &PathBuf, args: &[String]) -> Result<(), String> {
    Command::new(exe)
        .args(args)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Failed to launch the Riot Client: {error}"))
}
```

Refactor `riot_launch_with_config` to use these helpers and add `riot_launch_normal`. The normal command must check `riot_client_running`, resolve the executable, call `spawn_riot` with `launch_args(..., None)`, and return JSON containing `success`, `exe`, `product`, `patchline`, and `proxied: false`.

- [ ] **Step 4: Register the normal command**

Add `commands::riot_launch::riot_launch_normal` beside the existing launch command in `src-tauri/src/lib.rs`.

- [ ] **Step 5: Run focused tests**

Run: `cargo test commands::riot_launch::tests --lib`

Expected: two tests pass.

- [ ] **Step 6: Commit backend launch split**

```text
git add src-tauri/src/commands/riot_launch.rs src-tauri/src/lib.rs
git commit -m "feat: add normal Riot launch mode"
```

---

### Task 2: Config-server health preflight

**Files:**
- Modify: `src-tauri/src/client_config.rs`
- Modify: `src-tauri/src/commands/riot_launch.rs`

**Interfaces:**
- Produces: `pub const HEALTH_PATH: &str = "/__valoutils/health"`.
- Produces: `pub async fn verify_ready(port: u16) -> Result<(), String>`.
- Consumes: `client_config::start`, `client_config::stop`, `presence_proxy::start`, and `presence_proxy::stop`.

- [ ] **Step 1: Write a failing health-route test**

Add a Tokio test in `client_config.rs` that starts the server on an ephemeral test port, requests `http://127.0.0.1:<port>/__valoutils/health`, asserts status `204`, and stops the server. Serialize this test with the module's existing server state so it cannot overlap another server test.

- [ ] **Step 2: Run the test and verify red**

Run: `cargo test client_config::tests::serves_local_health_check --lib`

Expected: request returns the fallback proxy result rather than `204`.

- [ ] **Step 3: Implement the route and verifier**

Change router construction to:

```rust
let app = Router::new()
    .route(HEALTH_PATH, axum::routing::get(|| async { axum::http::StatusCode::NO_CONTENT }))
    .fallback(proxy);
```

Add:

```rust
pub async fn verify_ready(port: u16) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{port}{HEALTH_PATH}");
    let response = reqwest::Client::new()
        .get(url)
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await
        .map_err(|error| format!("Local client-config health check failed: {error}"))?;
    if response.status() == reqwest::StatusCode::NO_CONTENT {
        Ok(())
    } else {
        Err(format!("Local client-config health check returned {}", response.status()))
    }
}
```

- [ ] **Step 4: Gate proxied spawning on the preflight**

After `client_config::start`, call `verify_ready(DEFAULT_PORT)`. On failure, call `client_config::stop()` and `presence_proxy::stop().await`, then return the health-check error. Only construct arguments and call `spawn_riot` after this succeeds.

- [ ] **Step 5: Run focused backend tests**

Run: `cargo test client_config::tests --lib`

Then run: `cargo test commands::riot_launch::tests --lib`

Expected: health and launch-argument tests pass.

- [ ] **Step 6: Commit preflight**

```text
git add src-tauri/src/client_config.rs src-tauri/src/commands/riot_launch.rs
git commit -m "fix: preflight Riot client config server"
```

---

### Task 3: Separate launch actions in the Dummy Bot UI

**Files:**
- Modify: `src/pages/DummyBot.tsx`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/zh-TW.json`
- Modify: `src/i18n/locales/ko.json`

**Interfaces:**
- Consumes IPC channel `riot:launch-normal`, mapped by `tauri-bridge.ts` to `riot_launch_normal`.
- Continues to consume `riot:launch-with-config`.

- [ ] **Step 1: Add shared launch-result handling**

In the launch-status effect, register the same handler for both `riot:launch-normal` and `riot:launch-with-config`. The handler parses the result, updates `launchError`, and refreshes `client:config-status`. Remove both listeners during cleanup.

- [ ] **Step 2: Render two labeled actions**

Replace the single launch row with:

- a **Normal Launch** action that displays `--launch-product=valorant --launch-patchline=live` and sends `riot:launch-normal`;
- a **Presence Proxy Launch** action that displays the existing client-config arguments and sends `riot:launch-with-config`.

Both buttons use `disabled={launch?.riotClientRunning !== false}`. The proxied button retains the cyan styling; the normal button uses the existing neutral border/text palette so their purposes remain visually distinct.

- [ ] **Step 3: Add localized copy**

Add these keys to each `dummyBot` locale object with natural translations:

```json
{
  "normalLaunch": "Normal launch",
  "normalLaunchLabel": "Start Riot without the local presence proxy",
  "proxyLaunch": "Launch with presence proxy",
  "proxyLaunchLabel": "Start Riot through the local client-config and XMPP relay"
}
```

- [ ] **Step 4: Verify the frontend**

Run: `bun run build:vite`

Expected: TypeScript and Vite build exit successfully.

- [ ] **Step 5: Commit UI changes**

```text
git add src/pages/DummyBot.tsx src/i18n/locales/en.json src/i18n/locales/zh-TW.json src/i18n/locales/ko.json
git commit -m "feat: expose normal and proxied Riot launches"
```

---

### Task 4: Final verification

**Files:**
- Verify only; no planned source changes.

**Interfaces:**
- Verifies the complete launch-mode feature.

- [ ] **Step 1: Run all targeted Rust tests**

Run: `cargo test commands::riot_launch::tests --lib`

Then run: `cargo test client_config::tests --lib`

Expected: all selected tests pass with zero failures.

- [ ] **Step 2: Compile the production backend**

Run: `cargo check`

Expected: exit code `0`; existing unrelated warnings are allowed.

- [ ] **Step 3: Build the frontend**

Run: `bun run build:vite`

Expected: exit code `0`.

- [ ] **Step 4: Manual smoke test**

With Riot fully closed, click **Normal Launch**. Verify Riot starts and the config proxy remains stopped. Close Riot completely, then click **Launch with Presence Proxy**. Verify ValoUtils reports the config proxy running before Riot starts; if local startup fails, verify Riot is not spawned and the specific error is shown.
