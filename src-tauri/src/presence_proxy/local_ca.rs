use std::fs;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const CACHE_FILE: &str = "localhostCert.pfx";
const DEFAULT_PFX_URL: &str = "https://mln.cx/deceive/localhost.pfx";
const REFRESH_BEFORE_SECONDS: i64 = 20 * 24 * 60 * 60;
const MAX_PFX_BYTES: usize = 1024 * 1024;

struct ParsedPfx {
    identity: native_tls::Identity,
    expires_at: i64,
}

fn pfx_cache_path(user_data_dir: &Path) -> PathBuf {
    user_data_dir.join(CACHE_FILE)
}

fn needs_refresh(expires_at: i64, now: i64) -> bool {
    expires_at.saturating_sub(now) <= REFRESH_BEFORE_SECONDS
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

#[cfg(windows)]
fn pfx_leaf_expiry(bytes: &[u8], expected_host: &str, now: i64) -> Result<i64, String> {
    use schannel::cert_store::PfxImportOptions;
    use x509_parser::extensions::GeneralName;

    let store = PfxImportOptions::new()
        .password("")
        .import(bytes)
        .map_err(|error| format!("Could not open the PFX certificate: {error}"))?;
    for cert in store.certs() {
        if cert
            .private_key()
            .silent(true)
            .compare_key(true)
            .acquire()
            .is_err()
        {
            continue;
        }
        let (_, parsed) = x509_parser::parse_x509_certificate(cert.to_der())
            .map_err(|error| format!("Could not inspect the PFX certificate: {error}"))?;
        if parsed.validity().not_before.timestamp() > now {
            return Err("The PFX certificate is not valid yet".into());
        }
        let san = parsed
            .subject_alternative_name()
            .map_err(|error| format!("Could not inspect the PFX hostname: {error}"))?
            .ok_or_else(|| "The PFX certificate has no subject alternative name".to_string())?;
        let matches_host = san.value.general_names.iter().any(
            |name| matches!(name, GeneralName::DNSName(value) if value.eq_ignore_ascii_case(expected_host)),
        );
        if !matches_host {
            return Err(format!(
                "The PFX certificate is not valid for {expected_host}"
            ));
        }
        if let Some(usage) = parsed
            .extended_key_usage()
            .map_err(|error| format!("Could not inspect the PFX key usage: {error}"))?
        {
            if !usage.value.server_auth && !usage.value.any {
                return Err(
                    "The PFX certificate is not valid for TLS server authentication".into(),
                );
            }
        }
        return Ok(parsed.validity().not_after.timestamp());
    }
    Err("The PFX archive contains no certificate with a matching private key".into())
}

#[cfg(not(windows))]
fn pfx_leaf_expiry(_bytes: &[u8], _expected_host: &str, _now: i64) -> Result<i64, String> {
    Err("PFX identities are supported only on Windows".into())
}

fn parse_pfx_identity(bytes: &[u8]) -> Result<ParsedPfx, String> {
    if bytes.is_empty() || bytes.len() > MAX_PFX_BYTES {
        return Err("The PFX certificate is empty or larger than 1 MiB".into());
    }
    let identity = native_tls::Identity::from_pkcs12(bytes, "")
        .map_err(|error| format!("Could not parse the PFX certificate: {error}"))?;
    let expires_at = pfx_leaf_expiry(bytes, crate::client_config::LOCAL_CHAT_HOST, unix_now())?;
    Ok(ParsedPfx {
        identity,
        expires_at,
    })
}

fn build_acceptor(identity: native_tls::Identity) -> Result<tokio_native_tls::TlsAcceptor, String> {
    let acceptor = native_tls::TlsAcceptor::builder(identity)
        .min_protocol_version(Some(native_tls::Protocol::Tlsv12))
        .build()
        .map_err(|error| format!("Could not configure local XMPP TLS: {error}"))?;
    Ok(tokio_native_tls::TlsAcceptor::from(acceptor))
}

fn pfx_url() -> String {
    std::env::var("VALOUTILS_PFX_URL")
        .ok()
        .filter(|value| value.starts_with("https://"))
        .unwrap_or_else(|| DEFAULT_PFX_URL.to_string())
}

async fn download_pfx() -> Result<Vec<u8>, String> {
    let url = pfx_url();
    download_pfx_from(&url).await
}

async fn download_pfx_from(url: &str) -> Result<Vec<u8>, String> {
    let mut response = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| format!("Could not create the PFX download client: {error}"))?
        .get(url)
        .send()
        .await
        .map_err(|error| format!("Could not download the XMPP PFX from {url}: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Could not download the XMPP PFX from {url}: HTTP {}",
            response.status()
        ));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_PFX_BYTES as u64)
    {
        return Err("The downloaded XMPP PFX is larger than 1 MiB".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("Could not read the XMPP PFX response: {error}"))?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_PFX_BYTES {
            return Err("The downloaded XMPP PFX is larger than 1 MiB".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.is_empty() {
        return Err("The downloaded XMPP PFX is empty".into());
    }
    Ok(bytes)
}

#[cfg(windows)]
fn install_cache_file(temporary: &Path, path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source = temporary
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let succeeded = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if succeeded == 0 {
        return Err(format!(
            "Could not atomically install the cached PFX: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn install_cache_file(temporary: &Path, path: &Path) -> Result<(), String> {
    fs::rename(temporary, path)
        .map_err(|error| format!("Could not install the cached PFX: {error}"))
}

fn write_cache(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "The PFX cache path has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create the PFX cache directory: {error}"))?;
    let temporary = path.with_extension(format!("pfx.tmp-{}", std::process::id()));
    fs::write(&temporary, bytes)
        .map_err(|error| format!("Could not write the temporary PFX cache: {error}"))?;
    if let Err(error) = install_cache_file(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(())
}

fn resolves_only_to_loopback(addresses: &[IpAddr]) -> bool {
    !addresses.is_empty()
        && addresses
            .iter()
            .all(|address| matches!(address, IpAddr::V4(ip) if ip.is_loopback()))
}

async fn verify_loopback_hostname() -> Result<(), String> {
    let host = crate::client_config::LOCAL_CHAT_HOST;
    let addresses = tokio::net::lookup_host((host, 0))
        .await
        .map_err(|error| format!("Could not resolve {host}: {error}"))?
        .map(|address| address.ip())
        .collect::<Vec<_>>();
    if resolves_only_to_loopback(&addresses) {
        return Ok(());
    }
    let resolved = addresses
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    Err(format!(
        "{host} must resolve only to IPv4 loopback (127.0.0.1), but resolved to: {resolved}. Remove any AAAA record, set a DNS-only A record to 127.0.0.1, or add `127.0.0.1 {host}` to the Windows hosts file."
    ))
}

pub(super) async fn load_acceptor() -> Result<tokio_native_tls::TlsAcceptor, String> {
    verify_loopback_hostname().await?;
    let cache_path = pfx_cache_path(&crate::store::user_data_dir());
    let now = unix_now();
    let cached = fs::read(&cache_path)
        .ok()
        .and_then(|bytes| parse_pfx_identity(&bytes).ok());

    if let Some(cached) = cached.as_ref() {
        if !needs_refresh(cached.expires_at, now) {
            return build_acceptor(cached.identity.clone());
        }
    }

    match download_pfx().await.and_then(|bytes| {
        let parsed = parse_pfx_identity(&bytes)?;
        if parsed.expires_at <= now {
            return Err("The downloaded XMPP PFX certificate is expired".into());
        }
        write_cache(&cache_path, &bytes)?;
        Ok(parsed)
    }) {
        Ok(downloaded) => build_acceptor(downloaded.identity),
        Err(refresh_error) => {
            if let Some(cached) = cached {
                if cached.expires_at > now {
                    crate::presence_proxy::controller().set_warning(Some(format!(
                        "Could not refresh the XMPP certificate; using the cached certificate until it expires: {refresh_error}"
                    )));
                    return build_acceptor(cached.identity);
                }
            }
            Err(refresh_error)
        }
    }
}

#[cfg(test)]
pub(super) fn generate_test_acceptor() -> Result<tokio_rustls::TlsAcceptor, String> {
    use rcgen::{CertificateParams, DnType, ExtendedKeyUsagePurpose, KeyPair, KeyUsagePurpose};
    use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
    use std::sync::Arc;

    let key = KeyPair::generate().map_err(|error| error.to_string())?;
    let mut params = CertificateParams::new(vec!["localhost".into(), "127.0.0.1".into()])
        .map_err(|error| error.to_string())?;
    params
        .distinguished_name
        .push(DnType::CommonName, "ValoUtils Local XMPP Test");
    params.key_usages = vec![
        KeyUsagePurpose::DigitalSignature,
        KeyUsagePurpose::KeyEncipherment,
    ];
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    let certificate = params
        .self_signed(&key)
        .map_err(|error| error.to_string())?;
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|error| error.to_string())?
    .with_no_client_auth()
    .with_single_cert(
        vec![CertificateDer::from(certificate.der().to_vec())],
        PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der())),
    )
    .map_err(|error| error.to_string())?;
    Ok(tokio_rustls::TlsAcceptor::from(Arc::new(config)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refreshes_when_twenty_days_or_less_remain() {
        let now = 1_700_000_000_i64;
        assert!(!needs_refresh(now + 21 * 24 * 60 * 60, now));
        assert!(needs_refresh(now + 20 * 24 * 60 * 60, now));
        assert!(needs_refresh(now - 1, now));
    }

    #[test]
    fn pfx_cache_is_kept_in_valoutils_user_data() {
        let base = PathBuf::from(r"C:\Users\tester\AppData\Roaming\ValoUtils");
        assert_eq!(pfx_cache_path(&base), base.join("localhostCert.pfx"));
    }

    #[test]
    fn rejects_bytes_that_are_not_a_pkcs12_identity() {
        assert!(parse_pfx_identity(b"not a pfx").is_err());
    }

    #[test]
    fn builds_a_tls_acceptor_for_tests() {
        assert!(generate_test_acceptor().is_ok());
    }

    #[test]
    fn requires_every_resolved_address_to_be_loopback() {
        use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

        assert!(resolves_only_to_loopback(&[IpAddr::V4(
            Ipv4Addr::LOCALHOST
        )]));
        assert!(!resolves_only_to_loopback(&[
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1)),
        ]));
        assert!(!resolves_only_to_loopback(&[IpAddr::V6(
            Ipv6Addr::LOCALHOST
        )]));
        assert!(!resolves_only_to_loopback(&[]));
    }

    #[tokio::test]
    #[ignore = "requires the public Deceive certificate service"]
    async fn downloads_and_parses_the_default_pfx() {
        let bytes = download_pfx_from(DEFAULT_PFX_URL).await.unwrap();
        let parsed = parse_pfx_identity(&bytes).unwrap();
        assert!(parsed.expires_at > unix_now());
    }
}
