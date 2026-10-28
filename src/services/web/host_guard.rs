//! URL normalization and SSRF host/port policy for nyan WebFetch.
//!
//! @nyan: this is deliberately independent of the permission system. Permission
//! answers whether a user allowed a domain; this module answers whether a target
//! is ever safe to send to the network.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use reqwest::Url;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HostGuardConfig {
    pub allow_hosts: Vec<String>,
    pub deny_hosts: Vec<String>,
    pub allow_ports: Vec<u16>,
    /// Test-only seam for local mock servers. Production callers cannot set it.
    #[cfg(test)]
    pub allow_private_for_tests: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidatedUrl {
    pub url: Url,
    pub host: String,
    pub port: u16,
    pub ip: Option<IpAddr>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HostGuardError {
    InvalidUrl,
    Credentials,
    DeniedScheme,
    DeniedPort(u16),
    DeniedPrivateNetwork,
    DeniedHost,
}

impl HostGuardError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidUrl | Self::Credentials => "denied_host",
            Self::DeniedScheme => "denied_scheme",
            Self::DeniedPort(_) => "denied_port",
            Self::DeniedPrivateNetwork => "denied_private_network",
            Self::DeniedHost => "denied_host",
        }
    }
}

impl std::fmt::Display for HostGuardError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidUrl => f.write_str("denied_host: invalid URL"),
            Self::Credentials => f.write_str("denied_host: URL credentials are not allowed"),
            Self::DeniedScheme => f.write_str("denied_scheme"),
            Self::DeniedPort(port) => write!(f, "denied_port: {port}"),
            Self::DeniedPrivateNetwork => f.write_str("denied_private_network"),
            Self::DeniedHost => f.write_str("denied_host"),
        }
    }
}

impl std::error::Error for HostGuardError {}

/// Normalize and validate a model-supplied URL.
///
/// HTTP is upgraded before the scheme/port policy is applied. An explicit
/// non-443 port must be present in `allow_ports`; `443` is always allowed.
pub fn validate_url(raw: &str, config: &HostGuardConfig) -> Result<ValidatedUrl, HostGuardError> {
    let mut url = Url::parse(raw).map_err(|_| HostGuardError::InvalidUrl)?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(HostGuardError::Credentials);
    }
    if url.scheme() == "http" {
        url.set_scheme("https")
            .map_err(|_| HostGuardError::DeniedScheme)?;
    }
    if url.scheme() != "https" {
        return Err(HostGuardError::DeniedScheme);
    }

    let raw_host = url.host_str().ok_or(HostGuardError::InvalidUrl)?;
    let host = raw_host.trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() {
        return Err(HostGuardError::InvalidUrl);
    }
    let port = url.port().unwrap_or(443);
    if port != 443 && !config.allow_ports.contains(&port) {
        return Err(HostGuardError::DeniedPort(port));
    }

    let ip = parse_ip_literal(&host);
    #[cfg(test)]
    let private_allowed = config.allow_private_for_tests;
    #[cfg(not(test))]
    let private_allowed = false;
    if !private_allowed && (ip.as_ref().is_some_and(is_private_ip) || is_private_name(&host)) {
        return Err(HostGuardError::DeniedPrivateNetwork);
    }

    if matches_host_list(&config.deny_hosts, &host) {
        return Err(HostGuardError::DeniedHost);
    }
    if !config.allow_hosts.is_empty() && !matches_host_list(&config.allow_hosts, &host) {
        return Err(HostGuardError::DeniedHost);
    }

    Ok(ValidatedUrl {
        url,
        host,
        port,
        ip,
    })
}

pub fn is_private_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_private_ipv4(*ip),
        IpAddr::V6(ip) => is_private_ipv6(*ip),
    }
}

fn is_private_ipv4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    let first = octets[0];
    (first == 0)
        || (first == 10)
        || (first == 100 && (64..=127).contains(&octets[1]))
        || (first == 127)
        || (first == 169 && octets[1] == 254)
        || (first == 172 && (16..=31).contains(&octets[1]))
        || (first == 192 && octets[1] == 0 && octets[2] == 0)
        || (first == 192 && octets[1] == 168)
        || (first == 198 && (18..=19).contains(&octets[1]))
        || (224..=255).contains(&first)
}

fn is_private_ipv6(ip: Ipv6Addr) -> bool {
    let segments = ip.segments();
    let first = segments[0];
    let nat64 = segments[..6] == [0x0064, 0xff9b, 0, 0, 0, 0];
    let mapped = segments[0..5] == [0, 0, 0, 0, 0] && segments[5] == 0xffff;
    let compatible = segments[..6] == [0, 0, 0, 0, 0, 0];
    let six_to_four = first == 0x2002;

    ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_unique_local()
        || ip.is_unicast_link_local()
        || ip.is_multicast()
        || (first & 0xfe00) == 0xfc00
        || (first & 0xffc0) == 0xfe80
        || (first & 0xff00) == 0xff00
        || mapped
        || compatible
        || nat64
        || six_to_four
}

fn is_private_name(host: &str) -> bool {
    host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host.ends_with(".lan")
        || host.ends_with(".home.arpa")
        || host.ends_with(".ts.net")
        || !host.contains('.')
}

fn matches_host_list(entries: &[String], host: &str) -> bool {
    entries.iter().any(|entry| {
        let entry = entry.trim().trim_end_matches('.').to_ascii_lowercase();
        if let Some(suffix) = entry.strip_prefix('.') {
            host == suffix || host.ends_with(&entry)
        } else {
            host == entry
        }
    })
}

fn parse_ip_literal(host: &str) -> Option<IpAddr> {
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Some(ip);
    }
    parse_legacy_ipv4(host).map(IpAddr::V4)
}

/// Parse the non-canonical IPv4 spellings accepted by WHATWG URL parsing:
/// decimal/hex/octal components, omitted components, and a single 32-bit word.
fn parse_legacy_ipv4(host: &str) -> Option<Ipv4Addr> {
    if host.is_empty() || host.contains(':') {
        return None;
    }
    let parts = host.split('.').collect::<Vec<_>>();
    if !(1..=4).contains(&parts.len()) {
        return None;
    }
    let mut values = Vec::with_capacity(parts.len());
    for part in parts {
        if part.is_empty() {
            return None;
        }
        let (digits, radix) = if part.starts_with("0x") || part.starts_with("0X") {
            (&part[2..], 16)
        } else if part.len() > 1 && part.starts_with('0') {
            (&part[1..], 8)
        } else {
            (part, 10)
        };
        let value = u32::from_str_radix(digits, radix).ok()?;
        values.push(value);
    }
    let maxes = match values.len() {
        1 => vec![u32::MAX],
        2 => vec![u8::MAX as u32, 0x00ff_ffff],
        3 => vec![u8::MAX as u32, u8::MAX as u32, 0xffff],
        4 => vec![u8::MAX as u32; 4],
        _ => return None,
    };
    if values.iter().zip(maxes).any(|(value, max)| *value > max) {
        return None;
    }
    let address = match values.len() {
        1 => values[0],
        2 => (values[0] << 24) | values[1],
        3 => (values[0] << 24) | (values[1] << 16) | values[2],
        4 => (values[0] << 24) | (values[1] << 16) | (values[2] << 8) | values[3],
        _ => unreachable!(),
    };
    Some(Ipv4Addr::from(address))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> HostGuardConfig {
        HostGuardConfig {
            allow_hosts: Vec::new(),
            deny_hosts: Vec::new(),
            allow_ports: vec![8443],
            allow_private_for_tests: false,
        }
    }

    #[test]
    fn rejects_private_ipv4_spellings_and_names() {
        for host in [
            "127.0.0.1",
            "0x7f.1",
            "2130706433",
            "127.1",
            "0.0.0.0",
            "169.254.169.254",
            "100.80.19.12",
            "localhost",
            "localhost.",
            "foo.local.",
            "x.ts.net",
            "singlelabel",
        ] {
            let error = validate_url(&format!("http://{host}"), &config()).unwrap_err();
            assert_eq!(error, HostGuardError::DeniedPrivateNetwork, "{host}");
        }
    }

    #[test]
    fn rejects_private_ipv6_wrappers() {
        for host in [
            "[::1]",
            "[::ffff:127.0.0.1]",
            "[64:ff9b::7f00:1]",
            "[2002:7f00:1::]",
            "[fd7a:115c:a1e0::1]",
            "[::8.8.8.8]",
            "[64:ff9b::8.8.8.8]",
            "[2002:0808:0808::]",
        ] {
            let error = validate_url(&format!("https://{host}"), &config()).unwrap_err();
            assert_eq!(error, HostGuardError::DeniedPrivateNetwork, "{host}");
        }
    }

    #[test]
    fn upgrades_http_but_requires_allowed_non_default_port() {
        let validated = validate_url("http://example.com/path", &config()).unwrap();
        assert_eq!(validated.url.scheme(), "https");
        assert_eq!(validated.port, 443);
        assert_eq!(
            validate_url("https://example.com:8443", &config())
                .unwrap()
                .port,
            8443
        );
        assert_eq!(
            validate_url("https://example.com:9443", &config()),
            Err(HostGuardError::DeniedPort(9443))
        );
    }

    #[test]
    fn allow_and_deny_hosts_are_exact_or_explicit_suffixes() {
        let mut guarded = config();
        guarded.allow_hosts = vec![".example.com".to_string()];
        assert!(validate_url("https://example.com", &guarded).is_ok());
        assert!(validate_url("https://docs.example.com", &guarded).is_ok());
        assert_eq!(
            validate_url("https://notexample.com", &guarded),
            Err(HostGuardError::DeniedHost)
        );
        guarded.deny_hosts = vec![".example.com".to_string()];
        assert_eq!(
            validate_url("https://docs.example.com", &guarded),
            Err(HostGuardError::DeniedHost)
        );
    }

    #[test]
    fn private_host_test_seam_is_explicit() {
        let mut guarded = config();
        guarded.allow_private_for_tests = true;
        assert!(validate_url("http://127.0.0.1", &guarded).is_ok());
    }
}
