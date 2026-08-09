# Custom local chat certificate design

## Goal

Allow ValoUtils to use the locally tested `valoutils-tools.windowsed.me.pfx` identity for its loopback XMPP proxy without committing or uploading the PFX.

## Scope

- Change the local Riot chat hostname from `deceive-localhost.molenzwiebel.xyz` to `valoutils-tools.windowsed.me`.
- Continue requiring the hostname to resolve exclusively to IPv4 loopback (`127.0.0.1`).
- Keep the existing PFX validation, size limit, cache, expiry refresh, and TLS 1.2 minimum.
- Keep `VALOUTILS_PFX_URL` as the optional HTTPS download override.
- Do not add GitHub credentials, authentication tokens, or the PFX itself to the repository or application.

## Certificate flow

At startup, ValoUtils resolves `valoutils-tools.windowsed.me` and refuses to start the local proxy unless every result is IPv4 loopback. It then reads `localhostCert.pfx` from the ValoUtils user-data directory. The cached identity is accepted only when it has an empty password, a matching private key, a SAN for `valoutils-tools.windowsed.me`, TLS server-auth usage, and a valid date range.

For the first local test, the provided PFX is copied manually to the existing user-data cache location. Because the certificate is valid beyond the refresh window, no remote download is required. Later, an HTTPS URL may be supplied through `VALOUTILS_PFX_URL`; private GitHub downloads are outside this change because they require safely managing authentication credentials.

## Failure behavior

- A non-loopback DNS result stops proxy startup with the existing actionable DNS error.
- A missing SAN, private key, server-auth usage, or valid date produces the existing certificate validation error.
- An invalid cached identity falls back to the configured HTTPS download behavior.
- A refresh failure may use a still-valid cached identity and surfaces the existing warning.

## Verification

- Update hostname assertions in the client-configuration and certificate tests.
- Add or retain checks proving non-loopback and IPv6 results are rejected.
- Run the Rust library test suite.
- Perform a local smoke test using the ignored PFX copied into the ValoUtils user-data cache; confirm the proxy starts without downloading a certificate.

## Security constraints

The PFX remains ignored by Git and must never be committed. The dedicated hostname must not serve a real external application while this distributable private key is in use. DNS should expose only an A record for `127.0.0.1`, with no AAAA record.
