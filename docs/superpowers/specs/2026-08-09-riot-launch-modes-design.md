# Riot launch modes design

## Goal

Prevent Riot Client's misleading "no internet" state when the local client-config server is unavailable, while preserving an explicit path for launching with the ValoUtils presence proxy.

## User experience

The Dummy Bot page exposes two distinct actions:

- **Normal Launch** starts Riot Client with `--launch-product=valorant --launch-patchline=live`. It does not start the client-config server or XMPP relay and does not pass `--client-config-url`.
- **Launch with Presence Proxy** starts the XMPP relay and client-config server, verifies that `http://127.0.0.1:8000` is reachable, and only then starts Riot Client with `--client-config-url=http://127.0.0.1:8000` plus the product and patchline arguments.

Both actions continue to refuse launch when Riot Client is already running, because its startup arguments cannot be changed after launch.

## Backend design

Add a normal-launch Tauri command alongside `riot_launch_with_config`. Share product, patchline, executable discovery, running-process detection, argument construction, and process spawning so the two paths cannot drift.

The proxied path adds a loopback HTTP preflight after starting both local services. A failed preflight stops the services, returns the real error, and never spawns Riot Client. The normal path never touches either local service.

## Error handling

- Missing Riot executable: return the existing installation error.
- Riot already running: return the existing close-the-tray-process instruction.
- Relay/config startup or preflight failure: stop any service started by this attempt and report the failing boundary.
- Process spawn failure: stop proxy services only for the proxied path and return the OS error.

## Testing

- Unit-test argument construction for normal and proxied launches.
- Verify the normal arguments never contain `--client-config-url`.
- Verify the proxied arguments contain the exact loopback URL.
- Verify a failed config preflight prevents spawning through an injectable launch helper or an equivalent isolated test seam.
- Run the targeted Rust command tests and `cargo check`.

## Non-goals

This change does not solve XMPP certificate trust, alter the certificate strategy, or make presence interception available during a normal launch.
