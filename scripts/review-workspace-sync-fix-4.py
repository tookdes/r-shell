#!/usr/bin/env python3
"""Apply transport-security fixes and focused proxy tests."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: str, old: str, new: str) -> None:
    file_path = ROOT / path
    text = file_path.read_text(encoding="utf-8")
    if new in text:
        return
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one match, found {count}")
    file_path.write_text(text.replace(old, new, 1), encoding="utf-8")


# Never silently disable FTPS certificate validation.
replace_once(
    "src-tauri/src/ftp_client.rs",
    """            let tls_connector =
                suppaftp::async_native_tls::TlsConnector::new().danger_accept_invalid_certs(true);""",
    """            let tls_connector = suppaftp::async_native_tls::TlsConnector::new();""",
)

# Add pure unit coverage for proxy authority formatting and request validation.
proxy_path = ROOT / "src-tauri/src/proxy_stream.rs"
proxy_text = proxy_path.read_text(encoding="utf-8")
marker = "#[cfg(test)]\nmod tests {\n"
if marker not in proxy_text:
    proxy_text += """

#[cfg(test)]
mod tests {
    use super::{authority, validate_host, ProxyType};

    #[test]
    fn formats_ipv6_authority_with_brackets() {
        assert_eq!(authority("2001:db8::1", 22), "[2001:db8::1]:22");
    }

    #[test]
    fn formats_dns_authority_without_brackets() {
        assert_eq!(authority("example.com", 22), "example.com:22");
    }

    #[test]
    fn rejects_header_injection_in_target_host() {
        assert!(validate_host("example.com\\r\\nInjected: true").is_err());
        assert!(validate_host("").is_err());
    }

    #[test]
    fn parses_supported_proxy_types_without_treating_unknown_values_as_enabled() {
        assert!(matches!(ProxyType::from_str_loose("http"), ProxyType::Http));
        assert!(matches!(ProxyType::from_str_loose("socks"), ProxyType::Socks5));
        assert!(matches!(ProxyType::from_str_loose("unknown"), ProxyType::None));
    }
}
"""
    proxy_path.write_text(proxy_text, encoding="utf-8")

print("workspace-sync transport security fixes applied")
