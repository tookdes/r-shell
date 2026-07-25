//! Open a TCP stream to an SSH target, optionally via SOCKS5 / HTTP CONNECT.

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
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
            ProxyType::Http | ProxyType::Https => {
                connect_http_proxy(p, target_host, target_port).await
            }
            ProxyType::Socks5 => connect_socks5(p, target_host, target_port).await,
            ProxyType::Socks4 => Err(anyhow!("SOCKS4 proxy is not supported; use SOCKS5 or HTTP")),
            ProxyType::None => {
                TcpStream::connect((target_host, target_port))
                    .await
                    .with_context(|| format!("direct connect {target_host}:{target_port}"))
            }
        },
        _ => TcpStream::connect((target_host, target_port))
            .await
            .with_context(|| format!("direct connect {target_host}:{target_port}")),
    }
}

async fn connect_http_proxy(
    proxy: &ProxyConfig,
    target_host: &str,
    target_port: u16,
) -> Result<TcpStream> {
    let mut stream = TcpStream::connect((proxy.host.as_str(), proxy.port))
        .await
        .with_context(|| format!("proxy connect {}:{}", proxy.host, proxy.port))?;

    let mut req = format!(
        "CONNECT {target_host}:{target_port} HTTP/1.1\r\nHost: {target_host}:{target_port}\r\n"
    );
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

    // Read HTTP response headers until \r\n\r\n
    let mut buf = Vec::with_capacity(512);
    let mut tmp = [0u8; 256];
    loop {
        let n = stream.read(&mut tmp).await?;
        if n == 0 {
            return Err(anyhow!("proxy closed during CONNECT handshake"));
        }
        buf.extend_from_slice(&tmp[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        if buf.len() > 8192 {
            return Err(anyhow!("proxy CONNECT response too large"));
        }
    }
    let header = String::from_utf8_lossy(&buf);
    let status_line = header.lines().next().unwrap_or("");
    if !status_line.contains(" 200 ") && !status_line.ends_with(" 200") {
        // Also accept "HTTP/1.1 200 Connection established"
        if !status_line.contains("200") {
            return Err(anyhow!("proxy CONNECT failed: {status_line}"));
        }
    }
    Ok(stream)
}

async fn connect_socks5(
    proxy: &ProxyConfig,
    target_host: &str,
    target_port: u16,
) -> Result<TcpStream> {
    let mut stream = TcpStream::connect((proxy.host.as_str(), proxy.port))
        .await
        .with_context(|| format!("socks5 connect {}:{}", proxy.host, proxy.port))?;

    let use_auth = proxy
        .username
        .as_ref()
        .map(|u| !u.is_empty())
        .unwrap_or(false);

    // greeting
    if use_auth {
        stream.write_all(&[0x05, 0x01, 0x02]).await?; // user/pass only
    } else {
        stream.write_all(&[0x05, 0x01, 0x00]).await?; // no auth
    }
    let mut resp = [0u8; 2];
    stream.read_exact(&mut resp).await?;
    if resp[0] != 0x05 {
        return Err(anyhow!("invalid SOCKS5 version from proxy"));
    }
    if resp[1] == 0x02 && use_auth {
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
        let mut auth_resp = [0u8; 2];
        stream.read_exact(&mut auth_resp).await?;
        if auth_resp[1] != 0x00 {
            return Err(anyhow!("SOCKS5 authentication failed"));
        }
    } else if resp[1] != 0x00 {
        return Err(anyhow!("SOCKS5 proxy requires unsupported auth method"));
    }

    // CONNECT request — domain name form
    if target_host.len() > 255 {
        return Err(anyhow!("target host name too long for SOCKS5"));
    }
    let mut req = Vec::with_capacity(7 + target_host.len());
    req.extend_from_slice(&[0x05, 0x01, 0x00, 0x03]);
    req.push(target_host.len() as u8);
    req.extend_from_slice(target_host.as_bytes());
    req.push((target_port >> 8) as u8);
    req.push((target_port & 0xff) as u8);
    stream.write_all(&req).await?;

    let mut hdr = [0u8; 4];
    stream.read_exact(&mut hdr).await?;
    if hdr[0] != 0x05 || hdr[1] != 0x00 {
        return Err(anyhow!("SOCKS5 CONNECT failed (code {})", hdr[1]));
    }
    // consume bind address
    match hdr[3] {
        0x01 => {
            let mut skip = [0u8; 4 + 2];
            stream.read_exact(&mut skip).await?;
        }
        0x03 => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).await?;
            let mut skip = vec![0u8; len[0] as usize + 2];
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
