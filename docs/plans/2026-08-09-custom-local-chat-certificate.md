# Custom Local Chat Certificate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ValoUtils use `valoutils-tools.windowsed.me` as its loopback Riot chat hostname and validate the user's ignored PFX against that hostname.

**Architecture:** Keep the existing client-config patcher and PFX loader intact, changing only their shared `LOCAL_CHAT_HOST` constant. Add an ignored, opt-in certificate test that accepts a path through an environment variable so the real PFX stays outside Git while exercising the same production parser.

**Tech Stack:** Rust, Tauri, `native-tls`, `schannel`, `x509-parser`, Cargo tests, Windows PowerShell

## Global Constraints

- `valoutils-tools.windowsed.me` must resolve exclusively to IPv4 loopback (`127.0.0.1`), with no AAAA record.
- The PFX must remain ignored by Git and must never be committed.
- Preserve the empty PFX password, 1 MiB size limit, TLS 1.2 minimum, cache/refresh behavior, and `VALOUTILS_PFX_URL` HTTPS override.
- Do not add GitHub credentials or authentication tokens.
- Do not modify or stage the unrelated parser and golden-fixture deletions already present in the working tree.

---

### Task 1: Switch the loopback chat hostname

**Files:**
- Modify: `src-tauri/src/client_config.rs:28`
- Test: `src-tauri/src/client_config.rs:316-353`

**Interfaces:**
- Consumes: `LOCAL_CHAT_HOST: &str`, used by the client-config patcher and PFX validator.
- Produces: `LOCAL_CHAT_HOST == "valoutils-tools.windowsed.me"` for both Riot chat configuration and certificate SAN validation.

- [ ] **Step 1: Change the client-config expectations first**

Replace both old hostname literals in `patches_chat_config_and_selects_affinity`:

```rust
assert_eq!(
    result.json["chat.host"],
    "valoutils-tools.windowsed.me"
);
assert_eq!(result.json["chat.port"], 43123);
assert_eq!(
    result.json["chat.affinities"]["na1"],
    "valoutils-tools.windowsed.me"
);
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run from `src-tauri`:

```powershell
cargo test --lib client_config::tests::patches_chat_config_and_selects_affinity -- --exact
```

Expected: FAIL because the produced hostname is still `deceive-localhost.molenzwiebel.xyz`.

- [ ] **Step 3: Change the shared hostname constant**

Replace the constant in `src-tauri/src/client_config.rs`:

```rust
pub const LOCAL_CHAT_HOST: &str = "valoutils-tools.windowsed.me";
```

- [ ] **Step 4: Run the focused test and verify it passes**

```powershell
cargo test --lib client_config::tests::patches_chat_config_and_selects_affinity -- --exact
```

Expected: PASS with `1 passed; 0 failed`.

- [ ] **Step 5: Commit the hostname change**

```powershell
git add -- src-tauri/src/client_config.rs
git diff --cached --check
git commit -m "feat: use ValoUtils local chat certificate host"
```

Expected: the commit contains only `src-tauri/src/client_config.rs`.

---

### Task 2: Validate a user-provided PFX without tracking it

**Files:**
- Modify: `src-tauri/src/presence_proxy/local_ca.rs:319-363`
- Local-only input: `valoutils-tools.windowsed.me.pfx` (ignored; never stage)

**Interfaces:**
- Consumes: `VALOUTILS_TEST_PFX_PATH`, an opt-in test-only environment variable containing an absolute or relative PFX path.
- Produces: ignored test `presence_proxy::local_ca::tests::validates_user_supplied_pfx` using production `parse_pfx_identity(bytes: &[u8]) -> Result<ParsedPfx, String>`.

- [ ] **Step 1: Add the ignored opt-in validation test**

Add this test beside `downloads_and_parses_the_default_pfx`:

```rust
#[test]
#[ignore = "requires VALOUTILS_TEST_PFX_PATH to point to a local PFX"]
fn validates_user_supplied_pfx() {
    let path = std::env::var("VALOUTILS_TEST_PFX_PATH")
        .expect("VALOUTILS_TEST_PFX_PATH must point to a local PFX");
    let bytes = fs::read(path).expect("the local PFX must be readable");
    let parsed = parse_pfx_identity(&bytes).expect("the local PFX must pass production checks");
    assert!(parsed.expires_at > unix_now(), "the local PFX must not be expired");
}
```

- [ ] **Step 2: Run the opt-in test against the ignored PFX**

Run from `src-tauri`:

```powershell
$env:VALOUTILS_TEST_PFX_PATH = (Resolve-Path '..\valoutils-tools.windowsed.me.pfx').Path
cargo test --lib presence_proxy::local_ca::tests::validates_user_supplied_pfx -- --ignored --exact
Remove-Item Env:VALOUTILS_TEST_PFX_PATH
```

Expected: PASS with `1 passed; 0 failed`. This proves empty-password import, matching private key, SAN `valoutils-tools.windowsed.me`, server-auth EKU, validity dates, and the 1 MiB limit all pass the production parser.

- [ ] **Step 3: Confirm the PFX remains outside Git**

```powershell
git check-ignore -v -- '..\valoutils-tools.windowsed.me.pfx'
git status --short -- '..\valoutils-tools.windowsed.me.pfx'
```

Expected: `git check-ignore` reports the `**/*.pfx` rule and `git status` prints nothing.

- [ ] **Step 4: Commit only the reusable opt-in test**

```powershell
git add -- src-tauri/src/presence_proxy/local_ca.rs
git diff --cached --check
git commit -m "test: validate custom local chat PFX"
```

Expected: the commit contains only `src-tauri/src/presence_proxy/local_ca.rs`; no `.pfx` path appears in `git diff-tree --name-only -r HEAD`.

---

### Task 3: Verify DNS, regression tests, and local startup

**Files:**
- No tracked file changes.
- Local cache input: `%APPDATA%\ValoUtils\localhostCert.pfx`

**Interfaces:**
- Consumes: the new `LOCAL_CHAT_HOST`, existing `verify_loopback_hostname()`, and the validated ignored PFX.
- Produces: verification evidence that DNS is loopback-only, all Rust library tests pass, and the proxy can load the cached custom identity.

- [ ] **Step 1: Verify every DNS answer is IPv4 loopback**

```powershell
$addresses = [System.Net.Dns]::GetHostAddresses('valoutils-tools.windowsed.me')
$addresses | ForEach-Object { $_.ToString() }
if (-not $addresses -or ($addresses | Where-Object { $_.AddressFamily -ne 'InterNetwork' -or -not [System.Net.IPAddress]::IsLoopback($_) })) {
    throw 'valoutils-tools.windowsed.me must resolve only to IPv4 loopback'
}
```

Expected: every printed address is `127.0.0.1`; the command exits successfully.

- [ ] **Step 2: Run the complete Rust library suite**

Run from `src-tauri`:

```powershell
cargo test --lib
```

Expected: all non-ignored tests pass. Existing compiler warnings are acceptable; any failed test is not.

- [ ] **Step 3: Install the PFX into an empty local cache slot**

Run from `src-tauri`:

```powershell
$cacheDirectory = Join-Path $env:APPDATA 'ValoUtils'
$cachePath = Join-Path $cacheDirectory 'localhostCert.pfx'
if (Test-Path -LiteralPath $cachePath) {
    throw "Existing certificate cache found at $cachePath; preserve or move it before this smoke test"
}
New-Item -ItemType Directory -Force -Path $cacheDirectory | Out-Null
Copy-Item -LiteralPath '..\valoutils-tools.windowsed.me.pfx' -Destination $cachePath
```

Expected: the ignored source PFX is copied to the user-data cache without overwriting an existing certificate.

- [ ] **Step 4: Run the application and start the presence relay**

Run from the repository root:

```powershell
bun run dev
```

Expected: ValoUtils starts, launching Valorant starts the presence relay, and no certificate SAN, expiry, download, or non-loopback DNS error appears. Stop the development process after confirming the relay is ready.

- [ ] **Step 5: Audit the branch before any later push**

```powershell
$forbidden = git diff-tree --no-commit-id --name-only -r HEAD~2..HEAD | Select-String -Pattern '(^|/)(\.superpowers|docs/superpowers|tools)(/|$)|\.(pfx|p12|pem|key)$'
if ($forbidden) { $forbidden; throw 'Forbidden certificate or Superpowers path found in commits' }
git status --short
```

Expected: the audit prints no forbidden path. Existing unrelated unstaged deletions and ignored/untracked local tooling may remain and must not be staged.
