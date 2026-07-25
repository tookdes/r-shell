//! Open a TCP stream to an SSH target, optionally via SOCKS5 / HTTP CONNECT.

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::net::IpAddr;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ProxyType {
    #[default]
    None,
    Http,
    Https,
    Socks4,
    Socks5,
}

impl ProxyType {
    pub fn from_str_loose(s: &str) -> Self {
        match s.to_ascii_lowercase().as_str() {
            "http" => ProxyType::Http,
            "https" => ProxyType::Https,
            "socks4" => ProxyType::Socks4,
            "socks5" | "socks" => ProxyType::Socks5,
            _ => ProxyType::None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProxyConfig {
    #[serde(default)]
    pub proxy_type: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
}

impl ProxyConfig {
    pub fn is_enabled(&self) -> bool {
        !matches!(ProxyType::from_str_loose(&self.proxy_type), ProxyType::None)
            && !self.host.is_empty()
            && self.port > 0
    }
}

/// Connect to `target_host:target_port`, optionally through a proxy.
pub async fn connect_tcp(
    target_host: &str,
    target_port: u16,
    proxy: Option<&ProxyConfig>,
) -> Result<TcpStream> {
    match proxy {
        Some(p) if p.is_enabled() => match ProxyType::from_str_loose(&p.proxy_type) {
            ProxyType::Http => connect_http_proxy(p, target_host, target_port).await,
            ProxyType::Https => Err(anyhow!(
                "HTTPS proxy transport is not implemented; use HTTP CONNECT or SOCKS5"
            )),
            ProxyType::Socks5 => connect_socks5(p, target_host, target_port).await,
            ProxyType::Socks4 => Err(anyhow!("SOCKS4 proxy is not supported; use SOCKS5 or HTTP")),
            ProxyType::None => direct_connect(target_host, target_port).await,
        },
        _ => direct_connect(target_host, target_port).await,
    }
}

async fn direct_connect(target_host: &str, target_port: u16) -> Result<TcpStream> {
    TcpStream::connect((target_host, target_port))
        .await
        .with_context(|| format!("direct connect {target_host}:{target_port}"))
}

fn validate_host(host: &str) -> Result<()> {
    if host.is_empty() {
        return Err(anyhow!("target host is empty"));
    }
    if host.contains(['\r', '\n']) {
        return Err(anyhow!("target host contains invalid characters"));
    }
    Ok(())
}

fn authority(host: &str, port: u16) -> String {
    if host.parse::<std::net::Ipv6Addr>().is_ok() {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

async fn connect_http_proxy(
    proxy: &ProxyConfig,
    target_host: &str,
    target_port: u16,
) -> Result<TcpStream> {
    validate_host(target_host)?;
    let mut stream = TcpStream::connect((proxy.host.as_str(), proxy.port))
        .await
        .with_context(|| format!("proxy connect {}:{}", proxy.host, proxy.port))?;

    let target = authority(target_host, target_port);
    let mut req = format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n");
    if let (Some(user), Some(pass)) = (&proxy.username, &proxy.password) {
        if !user.is_empty() {
            let token = base64::Engine::encode(
                &base64::engine::general_purpose::STANDARD,
                format!("{user}:{pass}"),
            );
            req.push_str(&format!("Proxy-Authorization: Basic {token}\r\n"));
        }
    }
    req.push_str("Proxy-Connection: Keep-Alive\r\n\r\n");
    stream.write_all(req.as_bytes()).await?;

    // Read exactly through the header terminator. Reading larger chunks can consume
    // bytes from the tunneled SSH banner that immediately follows the HTTP response.
    let mut header_bytes = Vec::with_capacity(512);
    while !header_bytes.ends_with(b"\r\n\r\n") {
        if header_bytes.len() >= 8192 {
            return Err(anyhow!("proxy CONNECT response too large"));
        }
        let mut byte = [0u8; 1];
        let n = stream.read(&mut byte).await?;
        if n == 0 {
            return Err(anyhow!("proxy closed during CONNECT handshake"));
        }
        header_bytes.push(byte[0]);
    }

    let header = String::from_utf8_lossy(&header_bytes);
    let status_line = header.lines().next().unwrap_or("");
    let status_code = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| anyhow!("invalid proxy CONNECT response: {status_line}"))?;
    if status_code != 200 {
        return Err(anyhow!("proxy CONNECT failed: {status_line}"));
    }

    Ok(stream)
}

async fn connect_socks5(
    proxy: &ProxyConfig,
    target_host: &str,
    target_port: u16,
) -> Result<TcpStream> {
    validate_host(target_host)?;
    let mut stream = TcpStream::connect((proxy.host.as_str(), proxy.port))
        .await
        .with_context(|| format!("socks5 connect {}:{}", proxy.host, proxy.port))?;

    let use_auth = proxy
        .username
        .as_ref()
        .map(|username| !username.is_empty())
        .unwrap_or(false);

    if use_auth {
        stream.write_all(&[0x05, 0x01, 0x02]).await?;
    } else {
        stream.write_all(&[0x05, 0x01, 0x00]).await?;
    }

    let mut response = [0u8; 2];
    stream.read_exact(&mut response).await?;
    if response[0] != 0x05 {
        return Err(anyhow!("invalid SOCKS5 version from proxy"));
    }

    match response[1] {
        0x00 => {}
        0x02 if use_auth => {
            let user = proxy.username.as_deref().unwrap_or("");
            let pass = proxy.password.as_deref().unwrap_or("");
            if user.len() > 255 || pass.len() > 255 {
                return Err(anyhow!("SOCKS5 credentials too long"));
            }

            let mut auth = Vec::with_capacity(3 + user.len() + pass.len());
            auth.push(0x01);
            auth.push(user.len() as u8);
            auth.extend_from_slice(user.as_bytes());
            auth.push(pass.len() as u8);
            auth.extend_from_slice(pass.as_bytes());
            stream.write_all(&auth).await?;

            let mut auth_response = [0u8; 2];
            stream.read_exact(&mut auth_response).await?;
            if auth_response[0] != 0x01 || auth_response[1] != 0x00 {
                return Err(anyhow!("SOCKS5 authentication failed"));
            }
        }
        0xff => return Err(anyhow!("SOCKS5 proxy rejected all authentication methods")),
        method => return Err(anyhow!("SOCKS5 proxy selected unsupported auth method {method}")),
    }

    let mut request = Vec::with_capacity(22 + target_host.len());
    request.extend_from_slice(&[0x05, 0x01, 0x00]);
    match target_host.parse::<IpAddr>() {
        Ok(IpAddr::V4(address)) => {
            request.push(0x01);
            request.extend_from_slice(&address.octets());
        }
        Ok(IpAddr::V6(address)) => {
            request.push(0x04);
            request.extend_from_slice(&address.octets());
        }
        Err(_) => {
            if target_host.len() > 255 {
                return Err(anyhow!("target host name too long for SOCKS5"));
            }
            request.push(0x03);
            request.push(target_host.len() as u8);
            request.extend_from_slice(target_host.as_bytes());
        }
    }
    request.extend_from_slice(&target_port.to_be_bytes());
    stream.write_all(&request).await?;

    let mut header = [0u8; 4];
    stream.read_exact(&mut header).await?;
    if header[0] != 0x05 {
        return Err(anyhow!("invalid SOCKS5 response version"));
    }
    if header[1] != 0x00 {
        return Err(anyhow!("SOCKS5 CONNECT failed (code {})", header[1]));
    }

    match header[3] {
        0x01 => {
            let mut skip = [0u8; 4 + 2];
            stream.read_exact(&mut skip).await?;
        }
        0x03 => {
            let mut length = [0u8; 1];
            stream.read_exact(&mut length).await?;
            let mut skip = vec![0u8; length[0] as usize + 2];
            stream.read_exact(&mut skip).await?;
        }
        0x04 => {
            let mut skip = [0u8; 16 + 2];
            stream.read_exact(&mut skip).await?;
        }
        _ => return Err(anyhow!("SOCKS5 unknown address type")),
    }

    Ok(stream)
}
