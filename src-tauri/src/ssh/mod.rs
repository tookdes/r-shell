use anyhow::Result;
use russh::*;
use russh_keys::*;
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Preferred host-key algorithms advertised to the server, ordered from most to
/// least preferred.  RSA variants (including the legacy `ssh-rsa` / SHA-1) are
/// included so that older servers that only offer RSA host keys are still
/// reachable.  The `openssl` feature on `russh` / `russh-keys` must be enabled
/// for the RSA entries to have any effect.
pub static PREFERRED_HOST_KEY_ALGOS: &[russh_keys::key::Name] = &[
    russh_keys::key::ED25519,
    russh_keys::key::ECDSA_SHA2_NISTP256,
    russh_keys::key::ECDSA_SHA2_NISTP521,
    russh_keys::key::RSA_SHA2_256,
    russh_keys::key::RSA_SHA2_512,
    russh_keys::key::SSH_RSA,
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: AuthMethod,
    /// TCP/SSH handshake timeout in seconds. Defaults to 30 when None/0.
    #[serde(default)]
    pub connection_timeout_secs: Option<u64>,
    /// SSH keepalive interval in seconds. None uses 60; Some(0) disables.
    #[serde(default)]
    pub keepalive_interval_secs: Option<u64>,
    /// When true (default), use TOFU known_hosts verification.
    #[serde(default = "default_verify_host_key")]
    pub verify_host_key: bool,
    /// Optional proxy (HTTP CONNECT / SOCKS5).
    #[serde(default)]
    pub proxy: Option<crate::proxy_stream::ProxyConfig>,
    /// Commands to send once the interactive shell is ready (joined with \n).
    #[serde(default)]
    pub startup_command: Option<String>,
}

fn default_verify_host_key() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AuthMethod {
    Password {
        password: String,
    },
    PublicKey {
        /// Filesystem path to a private key (optional if key_data is set).
        #[serde(default)]
        key_path: Option<String>,
        /// Inline PEM / OpenSSH private key content (optional if key_path is set).
        #[serde(default)]
        key_data: Option<String>,
        passphrase: Option<String>,
    },
}

pub struct SshClient {
    session: Option<Arc<client::Handle<Client>>>,
    /// Startup commands to inject after the interactive shell is ready.
    startup_command: Option<String>,
}

// PTY session handle for interactive shell
pub struct PtySession {
    pub input_tx: mpsc::Sender<Vec<u8>>,
    pub output_rx: Arc<tokio::sync::Mutex<mpsc::Receiver<Vec<u8>>>>,
    /// Sender for resize requests (cols, rows) — forwarded to the SSH channel
    pub resize_tx: mpsc::Sender<(u32, u32)>,
    /// Cancellation token — cancelled when this session is torn down.
    /// The WebSocket reader task should select on this to stop promptly.
    pub cancel: CancellationToken,
}

/// russh client handler. Carries host identity so check_server_key can
/// consult the known_hosts store (meatshell-inspired TOFU).
pub struct Client {
    pub host: String,
    pub port: u16,
    pub verify_host_key: bool,
}

impl Client {
    pub fn new(host: impl Into<String>, port: u16, verify_host_key: bool) -> Self {
        Self {
            host: host.into(),
            port,
            verify_host_key,
        }
    }
}

#[async_trait::async_trait]
impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(crate::known_hosts::check_or_prompt(
            &self.host,
            self.port,
            server_public_key,
            self.verify_host_key,
        )
        .await)
    }
}

/// Load a private key from inline PEM content or a filesystem path.
pub fn load_private_key(
    key_path: Option<&str>,
    key_data: Option<&str>,
    passphrase: Option<&str>,
) -> Result<key::KeyPair> {
    if let Some(data) = key_data.map(str::trim).filter(|s| !s.is_empty()) {
        let normalized = data.replace("\r\n", "\n");
        return decode_secret_key(&normalized, passphrase)
            .map_err(|e| anyhow::anyhow!("Failed to parse inline private key: {}", e));
    }

    let key_path = key_path
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("Private key path or key content is required"))?;

    if key_path.contains("BEGIN") && key_path.contains("PRIVATE KEY") {
        let normalized = key_path.replace("\r\n", "\n");
        return decode_secret_key(&normalized, passphrase)
            .map_err(|e| anyhow::anyhow!("Failed to parse pasted private key: {}", e));
    }

    let expanded_path = if key_path.starts_with("~/") || key_path.starts_with("~\\") {
        if let Some(home) = dirs::home_dir() {
            let home_str = home.to_string_lossy();
            key_path.replacen('~', &home_str, 1)
        } else {
            key_path.to_string()
        }
    } else {
        key_path.to_string()
    };

    if !std::path::Path::new(&expanded_path).exists() {
        return Err(anyhow::anyhow!(
            "SSH key file not found: {}. Please check the file path and try again.",
            key_path
        ));
    }

    let key_content = std::fs::read_to_string(&expanded_path)
        .map_err(|e| anyhow::anyhow!("Failed to read SSH key file {}: {}", key_path, e))?;
    let key_content = key_content.replace("\r\n", "\n");
    decode_secret_key(&key_content, passphrase).map_err(|e| {
        if e.to_string().contains("encrypted") || e.to_string().contains("passphrase") {
            anyhow::anyhow!(
                "Failed to decrypt SSH key. The key may be encrypted. Please provide the correct passphrase."
            )
        } else {
            anyhow::anyhow!(
                "Failed to load SSH key from {}: {}. Ensure the file is a valid SSH private key.",
                key_path, e
            )
        }
    })
}

impl SshClient {
    pub fn new() -> Self {
        Self {
            session: None,
            startup_command: None,
        }
    }

    pub async fn connect(&mut self, config: &SshConfig) -> Result<()> {
        let keepalive_interval_secs = config.keepalive_interval_secs.unwrap_or(60);
        let keepalive_interval = if keepalive_interval_secs == 0 {
            None
        } else {
            Some(Duration::from_secs(keepalive_interval_secs))
        };

        let ssh_config = client::Config {
            preferred: russh::Preferred {
                key: std::borrow::Cow::Borrowed(PREFERRED_HOST_KEY_ALGOS),
                ..russh::Preferred::DEFAULT
            },
            // Keepalive interval comes from app settings (default 60 s).
            // After 3 missed replies russh closes a dead connection.
            keepalive_interval,
            keepalive_max: 3,
            ..client::Config::default()
        };

        let timeout_secs = config
            .connection_timeout_secs
            .filter(|value| *value > 0)
            .unwrap_or(30);
        let connection_timeout = Duration::from_secs(timeout_secs);

        let handler = Client::new(config.host.clone(), config.port, config.verify_host_key);
        let proxy = config.proxy.clone();
        let host = config.host.clone();
        let port = config.port;
        let ssh_config = Arc::new(ssh_config);

        let mut ssh_session = tokio::time::timeout(connection_timeout, async {
            let stream = crate::proxy_stream::connect_tcp(&host, port, proxy.as_ref())
                .await
                .map_err(std::io::Error::other)?;
            client::connect_stream(ssh_config, stream, handler).await
        })
        .await
            .map_err(|_| anyhow::anyhow!(
                "Connection timed out after {} seconds. Please check the host address, proxy, and network connectivity.",
                timeout_secs
            ))?
            .map_err(|e| {
                let message = e.to_string().to_lowercase();
                if message.contains("key") || message.contains("host") {
                    anyhow::anyhow!(
                        "Failed to connect to {}:{}: {}. If the host key changed, clear the known_hosts entry after verifying the server.",
                        config.host, config.port, e
                    )
                } else {
                    anyhow::anyhow!("Failed to connect to {}:{}: {}", config.host, config.port, e)
                }
            })?;

        let authenticated = match &config.auth_method {
            AuthMethod::Password { password } => ssh_session
                .authenticate_password(&config.username, password)
                .await
                .map_err(|e| anyhow::anyhow!("Password authentication failed: {}", e))?,
            AuthMethod::PublicKey {
                key_path,
                key_data,
                passphrase,
            } => {
                let key = load_private_key(
                    key_path.as_deref(),
                    key_data.as_deref(),
                    passphrase.as_deref(),
                )?;
                ssh_session
                    .authenticate_publickey(&config.username, Arc::new(key))
                    .await
                    .map_err(|e| anyhow::anyhow!("Public key authentication failed: {}. The key may not be authorized on the server.", e))?
            }
        };

        if !authenticated {
            return Err(anyhow::anyhow!(
                "Authentication failed. Please check your credentials and try again."
            ));
        }

        self.startup_command = config.startup_command.clone();
        self.session = Some(Arc::new(ssh_session));
        Ok(())
    }

    // Changed to &self instead of &mut self to allow concurrent access
    pub async fn execute_command(&self, command: &str) -> Result<String> {
        if let Some(session) = &self.session {
            let mut channel = session.channel_open_session().await?;
            channel.exec(true, command).await?;

            let mut output = String::new();
            let mut code = None;
            let mut eof_received = false;
            let mut server_closed = false;

            loop {
                let msg = channel.wait().await;
                match msg {
                    Some(ChannelMsg::Data { ref data }) => {
                        output.push_str(&String::from_utf8_lossy(data));
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        code = Some(exit_status);
                        if eof_received {
                            break;
                        }
                    }
                    Some(ChannelMsg::Eof) => {
                        eof_received = true;
                        if code.is_some() {
                            break;
                        }
                    }
                    Some(ChannelMsg::Close) => {
                        server_closed = true;
                        break;
                    }
                    None => {
                        server_closed = true;
                        break;
                    }
                    _ => {}
                }
            }

            // Send SSH_MSG_CHANNEL_CLOSE if the server hasn't already closed the channel.
            // Without this, russh's session keeps the channel in its internal map until
            // the session is torn down, causing per-poll memory growth.
            if !server_closed {
                let _ = channel.close().await;
            }

            // Consider success if we got output and no explicit error code, or code 0
            match code {
                Some(0) => Ok(output),
                None if !output.is_empty() => Ok(output), // No exit code but got output = success
                _ => Err(anyhow::anyhow!("Command failed with code: {:?}", code)),
            }
        } else {
            Err(anyhow::anyhow!("Not connected"))
        }
    }

    pub async fn disconnect(&mut self) -> Result<()> {
        if let Some(session) = self.session.take() {
            // Try to unwrap Arc, if we're the only owner
            match Arc::try_unwrap(session) {
                Ok(session) => {
                    session
                        .disconnect(Disconnect::ByApplication, "", "English")
                        .await?;
                }
                Err(arc_session) => {
                    // Other references exist, just drop our reference
                    drop(arc_session);
                }
            }
        }
        Ok(())
    }

    /// Create a persistent PTY shell session (like ttyd)
    /// This enables interactive commands like vim, less, more, top, etc.
    pub async fn create_pty_session(&self, cols: u32, rows: u32) -> Result<PtySession> {
        if let Some(session) = &self.session {
            // Open a new SSH channel
            let mut channel = session.channel_open_session().await?;

            // Request PTY with terminal type and dimensions
            // Similar to ttyd's approach: xterm-256color terminal
            channel
                .request_pty(
                    true,             // want_reply
                    "xterm-256color", // terminal type (like ttyd)
                    cols,             // columns
                    rows,             // rows
                    0,                // pixel_width (not used)
                    0,                // pixel_height (not used)
                    &[],              // terminal modes
                )
                .await?;

            // Start interactive shell
            channel.request_shell(true).await?;

            // Create channels for bidirectional communication (like ttyd's pty_buf)
            // Increased capacity for better buffering during fast input
            let (input_tx, mut input_rx) = mpsc::channel::<Vec<u8>>(1000); // Increased from 100
            let (output_tx, output_rx) = mpsc::channel::<Vec<u8>>(128); // Bounded: back-pressure to SSH window

            // Clone channel for input task
            let input_channel = channel.make_writer();

            // Create a channel for resize requests
            let (resize_tx, mut resize_rx) = mpsc::channel::<(u32, u32)>(16);

            // Spawn task to handle input (frontend → SSH)
            // This is similar to ttyd's pty_write and INPUT command handling
            // Key: immediate write + flush for responsiveness
            tokio::spawn(async move {
                let mut writer = input_channel;
                while let Some(data) = input_rx.recv().await {
                    // Write data immediately
                    if let Err(e) = writer.write_all(&data).await {
                        eprintln!("[PTY] Failed to send data to SSH: {}", e);
                        break;
                    }
                    // Critical: flush immediately after write (like ttyd)
                    // This ensures data is sent to PTY without buffering delay
                    if let Err(e) = writer.flush().await {
                        eprintln!("[PTY] Failed to flush data to SSH: {}", e);
                        break;
                    }
                }
            });

            // Optional startup command. Injected the first time the shell produces
            // output (a much more reliable "shell ready" signal than a fixed sleep:
            // slow logins no longer race, fast shells don't wait the full delay).
            let startup_bytes = self.startup_command.as_deref().and_then(|cmd| {
                let cmd = cmd.trim();
                if cmd.is_empty() {
                    None
                } else {
                    let mut payload = cmd.replace("\r\n", "\n").replace('\r', "\n");
                    if !payload.ends_with('\n') {
                        payload.push('\n');
                    }
                    // SSH PTY expects CR as line terminator for most shells.
                    Some(payload.replace('\n', "\r").into_bytes())
                }
            });
            let startup_input_tx = input_tx.clone();

            // Spawn task to handle output (SSH → frontend) AND resize requests.
            // The channel must stay in this task because `wait()` requires `&mut self`,
            // but we also need `window_change()` which only requires `&self`.
            // We use `tokio::select!` to multiplex between output reading and resize.
            tokio::spawn(async move {
                let mut pending_startup = startup_bytes;
                loop {
                    tokio::select! {
                        msg = channel.wait() => {
                            match msg {
                                Some(ChannelMsg::Data { data }) => {
                                    // First shell output: inject the startup command now.
                                    if let Some(bytes) = pending_startup.take() {
                                        if startup_input_tx.send(bytes).await.is_err() {
                                            break;
                                        }
                                    }
                                    if output_tx.send(data.to_vec()).await.is_err() {
                                        break;
                                    }
                                }
                                Some(ChannelMsg::ExtendedData { data, .. }) => {
                                    // stderr data (also send to output)
                                    if output_tx.send(data.to_vec()).await.is_err() {
                                        break;
                                    }
                                }
                                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                                    eprintln!("[PTY] Channel closed");
                                    break;
                                }
                                Some(ChannelMsg::ExitStatus { exit_status }) => {
                                    eprintln!("[PTY] Process exited with status: {}", exit_status);
                                }
                                _ => {}
                            }
                        }
                        resize = resize_rx.recv() => {
                            match resize {
                                Some((cols, rows)) => {
                                    if let Err(e) = channel.window_change(cols, rows, 0, 0).await {
                                        eprintln!("[PTY] Failed to send window change: {}", e);
                                    } else {
                                        eprintln!("[PTY] Window changed to {}x{}", cols, rows);
                                    }
                                }
                                None => {
                                    // resize channel closed, session is being torn down
                                    break;
                                }
                            }
                        }
                    }
                }
            });

            Ok(PtySession {
                input_tx,
                output_rx: Arc::new(tokio::sync::Mutex::new(output_rx)),
                resize_tx,
                cancel: CancellationToken::new(),
            })
        } else {
            Err(anyhow::anyhow!("Not connected"))
        }
    }

    /// Download a remote file to a local path, streaming chunk-by-chunk so
    /// memory use stays bounded for large files. `on_progress(bytes_so_far)`
    /// is invoked after every chunk; returning `false` aborts the transfer.
    /// The `cancel` token is polled so an in-flight transfer stops promptly.
    pub async fn download_file_progress<F>(
        &self,
        remote_path: &str,
        local_path: &str,
        cancel: &CancellationToken,
        on_progress: &mut F,
    ) -> Result<u64>
    where
        F: FnMut(u64) -> bool + Send,
    {
        if let Some(session) = &self.session {
            // Open SFTP subsystem
            let channel = session.channel_open_session().await?;
            channel.request_subsystem(true, "sftp").await?;
            let sftp = SftpSession::new(channel.into_stream()).await?;

            // Open remote file for reading
            let mut remote_file = sftp.open(remote_path).await?;
            let mut local_file = tokio::fs::File::create(local_path).await?;

            let mut temp_buf = vec![0u8; 32768];
            let mut total_bytes = 0u64;

            loop {
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => {
                        let _ = local_file.flush().await;
                        return Err(anyhow::anyhow!("Transfer cancelled"));
                    }
                    result = remote_file.read(&mut temp_buf) => {
                        let n = result?;
                        if n == 0 {
                            break;
                        }
                        local_file.write_all(&temp_buf[..n]).await?;
                        total_bytes += n as u64;
                        if !on_progress(total_bytes) {
                            let _ = local_file.flush().await;
                            return Err(anyhow::anyhow!("Transfer cancelled"));
                        }
                    }
                }
            }

            local_file.flush().await?;
            Ok(total_bytes)
        } else {
            Err(anyhow::anyhow!("Not connected"))
        }
    }

    /// Backward-compatible download (whole-file buffering) for callers that
    /// don't need progress or cancellation.
    pub async fn download_file(&self, remote_path: &str, local_path: &str) -> Result<u64> {
        let cancel = CancellationToken::new();
        let mut noop = |_: u64| true;
        self.download_file_progress(remote_path, local_path, &cancel, &mut noop)
            .await
    }

    pub async fn download_file_to_memory(&self, remote_path: &str) -> Result<Vec<u8>> {
        if let Some(session) = &self.session {
            // Open SFTP subsystem
            let channel = session.channel_open_session().await?;
            channel.request_subsystem(true, "sftp").await?;
            let sftp = SftpSession::new(channel.into_stream()).await?;

            // Open remote file for reading
            let mut remote_file = sftp.open(remote_path).await?;

            // Read file content
            let mut buffer = Vec::new();
            let mut temp_buf = vec![0u8; 8192];

            loop {
                let n = remote_file.read(&mut temp_buf).await?;
                if n == 0 {
                    break;
                }
                buffer.extend_from_slice(&temp_buf[..n]);
            }

            Ok(buffer)
        } else {
            Err(anyhow::anyhow!("Not connected"))
        }
    }

    /// Upload a local file to a remote path, streaming chunk-by-chunk so
    /// memory use stays bounded for large files. `on_progress(bytes_sent)` is
    /// invoked after every chunk; returning `false` aborts the transfer.
    /// The `cancel` token is polled so an in-flight transfer stops promptly.
    pub async fn upload_file_progress<F>(
        &self,
        local_path: &str,
        remote_path: &str,
        cancel: &CancellationToken,
        on_progress: &mut F,
    ) -> Result<u64>
    where
        F: FnMut(u64) -> bool + Send,
    {
        if let Some(session) = &self.session {
            let mut local_file = tokio::fs::File::open(local_path).await?;

            // Open SFTP subsystem
            let channel = session.channel_open_session().await?;
            channel.request_subsystem(true, "sftp").await?;
            let sftp = SftpSession::new(channel.into_stream()).await?;

            // Create remote file for writing
            let mut remote_file = sftp.create(remote_path).await?;

            // Write data in chunks
            let mut buf = vec![0u8; 32768];
            let mut sent = 0u64;

            loop {
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => {
                        return Err(anyhow::anyhow!("Transfer cancelled"));
                    }
                    result = local_file.read(&mut buf) => {
                        let n = result?;
                        if n == 0 {
                            break;
                        }
                        remote_file.write_all(&buf[..n]).await?;
                        sent += n as u64;
                        if !on_progress(sent) {
                            return Err(anyhow::anyhow!("Transfer cancelled"));
                        }
                    }
                }
            }

            remote_file.flush().await?;
            Ok(sent)
        } else {
            Err(anyhow::anyhow!("Not connected"))
        }
    }

    /// Backward-compatible upload (whole-file buffering) for callers that
    /// don't need progress or cancellation.
    pub async fn upload_file(&self, local_path: &str, remote_path: &str) -> Result<u64> {
        let cancel = CancellationToken::new();
        let mut noop = |_: u64| true;
        self.upload_file_progress(local_path, remote_path, &cancel, &mut noop)
            .await
    }

    pub async fn upload_file_from_bytes(&self, data: &[u8], remote_path: &str) -> Result<u64> {
        if let Some(session) = &self.session {
            let total_bytes = data.len() as u64;

            // Open SFTP subsystem
            let channel = session.channel_open_session().await?;
            channel.request_subsystem(true, "sftp").await?;
            let sftp = SftpSession::new(channel.into_stream()).await?;

            // Create remote file for writing
            let mut remote_file = sftp.create(remote_path).await?;

            // Write data in chunks
            let mut offset = 0;
            let chunk_size = 8192;

            while offset < data.len() {
                let end = std::cmp::min(offset + chunk_size, data.len());
                remote_file.write_all(&data[offset..end]).await?;
                offset = end;
            }

            remote_file.flush().await?;

            Ok(total_bytes)
        } else {
            Err(anyhow::anyhow!("Not connected"))
        }
    }
}

#[cfg(test)]
mod tests;
