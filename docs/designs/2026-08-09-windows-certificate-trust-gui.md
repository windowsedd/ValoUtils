# Windows Certificate Trust GUI Design

## Goal

Add a Settings control that lets a user trust or untrust the ValoUtils local XMPP certificate in the Windows Current User trusted-root store. This resolves the Riot client's `UntrustedRoot` TLS failure without requiring administrator privileges.

## Scope

- Windows only.
- Use `Current User\\Trusted Root Certification Authorities` (`CERT_SYSTEM_STORE_CURRENT_USER`, store name `ROOT`).
- Read the certificate from `%APPDATA%\\ValoUtils\\localhostCert.pfx` using the same empty-by-default password resolution as the local XMPP TLS loader.
- Install only the public leaf certificate. Never copy its private key into the root store.
- Support status, install, and removal from the Settings page.
- Do not install into the Local Machine store and do not request elevation.

## Backend design

Create a focused Windows certificate-trust module behind three Tauri commands:

- `certificate_trust_status`: parse and identify the cached PFX leaf, open the Current User `ROOT` store, and report whether an exact certificate match is present.
- `certificate_trust_install`: parse the cached PFX, add its DER-encoded public certificate to the Current User `ROOT` store, then verify the exact match is present.
- `certificate_trust_remove`: locate the exact matching public certificate and remove it, then verify it is absent.

Identity is based on the complete DER certificate, with a SHA-256 fingerprint returned for display and diagnostics. Subject or hostname alone is not sufficient for deletion. Installation uses Windows certificate-store APIs directly from Rust; it does not invoke PowerShell or `certutil.exe`.

The PFX parser continues to require a matching private key, SAN `valoutils-tools.windowsed.me`, TLS server-auth usage, and valid dates before its public certificate can be trusted. The module will expose the selected leaf DER from the existing validation path so trust operations cannot accidentally select an intermediate certificate.

Expected command responses are JSON strings matching the repository IPC convention:

```json
{
  "success": true,
  "trusted": true,
  "subject": "CN=valoutils-tools.windowsed.me",
  "fingerprint": "..."
}
```

Expected failures return `{ "success": false, "error": "..." }` rather than rejecting the Tauri invocation.

## Frontend design

Add a `Local XMPP certificate` row to the existing Developer section of Settings. On page load it requests trust status and renders one of these states:

- `Checking...`
- `Trusted`
- `Not trusted`
- `Unavailable` with the backend error

When untrusted, the row shows `Trust certificate`. When trusted, it shows `Remove trust`. The action button has a loading state, calls the matching backend command, then refreshes status from Windows instead of assuming success. Success and failure use the existing app alert/modal patterns.

The description explicitly says the action affects only the current Windows user. Removing trust is limited to the exact displayed fingerprint.

## Security and error handling

- Never import the PFX or private key into the trusted-root store.
- Never select removal targets by subject name alone.
- Refuse trust actions if the PFX fails hostname, key, usage, or validity validation.
- Treat an already-installed certificate and an already-absent certificate as successful idempotent outcomes.
- Keep the Current User scope fixed in backend code; the frontend cannot request a broader store.
- Return actionable errors for missing PFX, invalid password, malformed PFX, store-open failure, access denial, and verification failure.

Trusting a self-signed certificate makes Windows accept that exact certificate as a root for the current user. The GUI must communicate that this is a security-sensitive action and provide the matching removal action.

## Testing

Backend unit tests cover exact-DER matching, fingerprint formatting, response serialization, and rejection of invalid PFX input. Windows-only ignored integration tests use an explicitly supplied test PFX and verify install/status/remove against the Current User root store, with cleanup guarded so the test does not leave trust behind.

Frontend tests, where practical in the existing setup, cover the four display states and action selection. Manual verification checks that:

1. The current self-signed certificate initially reports `Not trusted`.
2. `Trust certificate` changes Windows chain building to trusted and the GUI to `Trusted`.
3. Local XMPP TLS no longer reports `UntrustedRoot` after restarting the Riot/Valorant client connection.
4. `Remove trust` restores `Not trusted` and removes only the exact certificate.

