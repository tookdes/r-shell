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
/// least preferred. RSA keys remain supported through rsa-sha2-256/512; the
/// legacy `ssh-rsa` signature algorithm is intentionally excluded because it
/// relies on SHA-1. The `openssl` feature on `russh` / `russh-keys` must be
/// enabled for the RSA-SHA2 entries to have any effect.
pub static PREFERRED_HOST_KEY_ALGOS: &[russh_keys::key::Name] = &[
    russh_keys::key::ED25519,
    russh_keys::key::ECDSA_SHA2_NISTP256,
    russh_keys::key::ECDSA_SHA2_NISTP521,
    russh_keys::key::RSA_SHA2_256,
    russh_keys::key::RSA_SHA2_512,
];

const LOGIN_SHELL_PROBE: &str = r#"/bin/sh -c 'printf "__RSHELL_LOGIN_SHELL__%s" "${SHELL-}"'"#;
const BASH_VERSION_PROBE: &str = r#"printf '__RSHELL_BASH_VERSION__%s' "${BASH_VERSION-}""#;
const LOGIN_SHELL_MARKER: &str = "__RSHELL_LOGIN_SHELL__";
const BASH_VERSION_MARKER: &str = "__RSHELL_BASH_VERSION__";
const BASH_SHELL_INTEGRATION_PREFIX: &str = r#" stty echo; __rshell_report_cwd(){ local p=${PWD//%/%25}; p=${p// /%20}; p=${p//#/%23}; p=${p//\?/%3F}; printf '\033]7;file://%s%s\033\\' "${HOSTNAME:-localhost}" "$p"; }; "#;
const BASH_SHELL_INTEGRATION_SUFFIX: &str = "printf '\\r\\033[2K'\n";

const PTY_LOOP_STATS_INTERVAL: Duration = Duration::from_secs(10);
const PTY_NON_DATA_WAKEUP_WARN_THRESHOLD: u64 = 1_000;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct PtyLoopStats {
    wait_wakeups: u64,
    data_messages: u64,
    data_bytes: u64,
    extended_messages: u64,
    extended_bytes: u64,
    exit_status_messages: u64,
    window_adjusted_messages: u64,
    success_messages: u64,
    failure_messages: u64,
    other_messages: u64,
    terminal_events: u64,
    resize_events: u64,
}

impl PtyLoopStats {
    fn non_data_wakeups(&self) -> u64 {
        self.exit_status_messages
            .saturating_add(self.window_adjusted_messages)
            .saturating_add(self.success_messages)
            .saturating_add(self.failure_messages)
            .saturating_add(self.other_messages)
            .saturating_add(self.terminal_events)
    }

    fn has_activity(&self) -> bool {
        self.wait_wakeups != 0 || self.resize_events != 0
    }

    fn suspicious_non_data_loop(&self) -> bool {
        self.non_data_wakeups() >= PTY_NON_DATA_WAKEUP_WARN_THRESHOLD
            && self.data_messages == 0
            && self.extended_messages == 0
    }

    fn record_data(&mut self, bytes: usize) {
        self.wait_wakeups = self.wait_wakeups.saturating_add(1);
        self.data_messages = self.data_messages.saturating_add(1);
        self.data_bytes = self.data_bytes.saturating_add(bytes as u64);
    }

    fn record_extended_data(&mut self, bytes: usize) {
        self.wait_wakeups = self.wait_wakeups.saturating_add(1);
        self.extended_messages = self.extended_messages.saturating_add(1);
        self.extended_bytes = self.extended_bytes.saturating_add(bytes as u64);
    }

    fn reset(&mut self) {
        *self = Self::default();
    }
}

fn log_pty_loop_stats(
    connection_id: &str,
    generation: u64,
    stats: &PtyLoopStats,
    final_sample: bool,
) {
    if !stats.has_activity() {
        return;
    }

    let non_data_wakeups = stats.non_data_wakeups();
    if stats.suspicious_non_data_loop() {
        tracing::warn!(
            "[PTY-STATS] id={} gen={} final={} wait_wakeups={} data_msgs={} data_bytes={} extended_msgs={} extended_bytes={} non_data_wakeups={} window_adjusted={} success={} failure={} exit_status={} other={} terminal_events={} resize_events={} suspicious_non_data_loop=true",
            connection_id,
            generation,
            final_sample,
            stats.wait_wakeups,
            stats.data_messages,
            stats.data_bytes,
            stats.extended_messages,
            stats.extended_bytes,
            non_data_wakeups,
            stats.window_adjusted_messages,
            stats.success_messages,
            stats.failure_messages,
            stats.exit_status_messages,
            stats.other_messages,
            stats.terminal_events,
            stats.resize_events,
        );
    } else {
        tracing::info!(
            "[PTY-STATS] id={} gen={} final={} wait_wakeups={} data_msgs={} data_bytes={} extended_msgs={} extended_bytes={} non_data_wakeups={} window_adjusted={} success={} failure={} exit_status={} other={} terminal_events={} resize_events={}",
            connection_id,
            generation,
            final_sample,
            stats.wait_wakeups,
            stats.data_messages,
            stats.data_bytes,
            stats.extended_messages,
            stats.extended_bytes,
            non_data_wakeups,
            stats.window_adjusted_messages,
            stats.success_messages,
            stats.failure_messages,
            stats.exit_status_messages,
            stats.other_messages,
            stats.terminal_events,
            stats.resize_events,
        );
    }
}


#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct BashVersion {
    pub(crate) major: u32,
    pub(crate) minor: u32,
}

pub(crate) fn bash_version_from_probe(output: &str) -> Option<BashVersion> {
    let version = output.rsplit_once(BASH_VERSION_MARKER)?.1.trim();
    let mut parts = version.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    Some(BashVersion { major, minor })
}

pub(crate) fn login_shell_from_probe(output: &str) -> Option<&str> {
    let shell = output
        .rsplit_once(LOGIN_SHELL_MARKER)?
        .1
        .lines()
        .next()?
        .trim();
    if !is_safe_unix_login_shell(shell) {
        return None;
    }
    Some(shell)
}

fn is_safe_unix_login_shell(shell: &str) -> bool {
    if shell.len() < 2 || !shell.starts_with('/') {
        return false;
    }

    // The value is interpolated into a POSIX /bin/sh command without further
    // quoting. Real login-shell executables use a small set of path characters,
    // so reject anything that could alter command syntax instead.
    shell.bytes().all(|byte| {
        byte.is_ascii_alphanumeric() || byte == b'/' || byte == b'.' || byte == b'_' || byte == b'-'
    })
}

pub(crate) fn truecolor_login_shell_command(login_shell: &str) -> Option<Vec<u8>> {
    if !is_safe_unix_login_shell(login_shell) {
        return None;
    }

    format!(
        "/bin/sh -c 'exec env TERM=xterm-256color COLORTERM=truecolor RUNEWIDTH_EASTASIAN=0 {login_shell} -l'"
    )
    .into_bytes()
    .into()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TruecolorExecAction {
    KeepCurrentChannel,
    ReopenAndRequestShell,
}

fn truecolor_exec_action<T, E>(result: &std::result::Result<T, E>) -> TruecolorExecAction {
    if result.is_ok() {
        TruecolorExecAction::KeepCurrentChannel
    } else {
        TruecolorExecAction::ReopenAndRequestShell
    }
}

#[cfg(test)]
mod truecolor_exec_fallback_tests {
    use super::{truecolor_exec_action, TruecolorExecAction};

    #[test]
    fn exec_failure_requires_a_fresh_shell_channel() {
        let accepted = Ok::<(), &'static str>(());
        let rejected = Err::<(), &'static str>("exec rejected");
        assert_eq!(
            truecolor_exec_action(&accepted),
            TruecolorExecAction::KeepCurrentChannel
        );
        assert_eq!(
            truecolor_exec_action(&rejected),
            TruecolorExecAction::ReopenAndRequestShell
        );
    }
}

pub(crate) fn bash_shell_integration_command(version: BashVersion) -> Vec<u8> {
    let prompt_command = if version >= (BashVersion { major: 5, minor: 1 }) {
        r#"if declare -p PROMPT_COMMAND &>/dev/null; then PROMPT_COMMAND=("${PROMPT_COMMAND[@]}" __rshell_report_cwd); else PROMPT_COMMAND=(__rshell_report_cwd); fi; "#
    } else {
        r#"if [[ -n ${PROMPT_COMMAND-} ]]; then PROMPT_COMMAND+=$'\n__rshell_report_cwd'; else PROMPT_COMMAND=__rshell_report_cwd; fi; "#
    };

    format!(
        "{}{}{}",
        BASH_SHELL_INTEGRATION_PREFIX, prompt_command, BASH_SHELL_INTEGRATION_SUFFIX
    )
    .into_bytes()
}

/// Compression algorithms to advertise, ordered so zlib is preferred over none.
///
/// Order matters: russh negotiates the first algorithm that the server also
/// lists, so zlib must come before none for compression to actually take
/// effect. `zlib@openssh.com` covers servers using OpenSSH's "delayed"
/// compression. Requires russh's `flate2` feature, which is enabled by default.
pub fn compression_preferences(enabled: bool) -> &'static [russh::compression::Name] {
    if enabled {
        &[
            russh::compression::ZLIB,
            russh::compression::ZLIB_LEGACY,
            russh::compression::NONE,
        ]
    } else {
        &[russh::compression::NONE]
    }
}

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
    /// Enable zlib compression negotiation (default: true, matching the UI).
    #[serde(default = "default_compression")]
    pub compression: bool,
    /// Max missed keepalive replies before the connection is closed.
    #[serde(default)]
    pub keepalive_max: Option<u32>,
}

fn default_verify_host_key() -> bool {
    true
}

fn default_compression() -> bool {
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

    /// Captures WHY an established SSH connection ended. Without this the
    /// terminal only ever sees a generic "PTY connection closed", which hides
    /// the root cause (keepalive timeout, socket error, server disconnect...).
    /// The reason is logged to the file logger so idle-drop reconnects can be
    /// diagnosed from `%LOCALAPPDATA%\com.aiden.r-shell\logs\r-shell.log.*`.
    async fn disconnected(
        &mut self,
        reason: russh::client::DisconnectReason<Self::Error>,
    ) -> Result<(), Self::Error> {
        match &reason {
            russh::client::DisconnectReason::ReceivedDisconnect(info) => {
                tracing::warn!(
                    "[SSH] {}:{} disconnected by server: {:?}",
                    self.host,
                    self.port,
                    info
                );
            }
            russh::client::DisconnectReason::Error(error) => {
                tracing::error!(
                    "[SSH] {}:{} connection lost (this triggers the terminal reconnect): {:?}",
                    self.host,
                    self.port,
                    error
                );
            }
        }
        match reason {
            russh::client::DisconnectReason::ReceivedDisconnect(_) => Ok(()),
            russh::client::DisconnectReason::Error(error) => Err(error),
        }
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

    let configured_key_path = key_path.map(str::trim).filter(|s| !s.is_empty());

    // Compatibility: older profiles may contain pasted PEM text in key_path.
    if let Some(pasted_key) =
        configured_key_path.filter(|value| value.contains("BEGIN") && value.contains("PRIVATE KEY"))
    {
        let normalized = pasted_key.replace("\r\n", "\n");
        return decode_secret_key(&normalized, passphrase)
            .map_err(|e| anyhow::anyhow!("Failed to parse pasted private key: {}", e));
    }

    let expanded_path = crate::os_keypath::resolve_private_key_path(configured_key_path)
        .map_err(anyhow::Error::msg)?;

    if !std::path::Path::new(&expanded_path).exists() {
        return Err(anyhow::anyhow!(
            "SSH key file not found: {}. Please check the file path and try again.",
            expanded_path
        ));
    }

    let key_content = std::fs::read_to_string(&expanded_path)
        .map_err(|e| anyhow::anyhow!("Failed to read SSH key file {}: {}", expanded_path, e))?;
    let key_content = key_content.replace("\r\n", "\n");
    decode_secret_key(&key_content, passphrase).map_err(|e| {
        if e.to_string().contains("encrypted") || e.to_string().contains("passphrase") {
            anyhow::anyhow!(
                "Failed to decrypt SSH key. The key may be encrypted. Please provide the correct passphrase."
            )
        } else {
            anyhow::anyhow!(
                "Failed to load SSH key from {}: {}. Ensure the file is a valid SSH private key.",
                expanded_path, e
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
                compression: std::borrow::Cow::Borrowed(compression_preferences(
                    config.compression,
                )),
                ..russh::Preferred::DEFAULT
            },
            // Send a keepalive on the user-configured interval. After the
            // configured number of missed replies russh closes the connection,
            // preventing the server from silently dropping idle sessions.
            keepalive_interval,
            keepalive_max: config.keepalive_max.unwrap_or(3) as usize,
            // russh's default rekey_time_limit is 1 hour: after an hour the
            // client *initiates* a key re-exchange. Some LAN appliances
            // (NAS/routers, e.g. 192.168.1.61) drop the session when they
            // receive that KEXINIT — the log shows "Re-exchanging keys" then
            // "early eof" exactly 60 minutes after connect. Disable the
            // client-initiated time-based rekey (the server can still request
            // a rekey itself, and we will answer it normally).
            limits: russh::Limits::new(
                // Keep the 1 GiB write/read rekey limits (russh defaults).
                1 << 30,
                1 << 30,
                // Effectively disable time-based rekey (~100 years).
                Duration::from_secs(60 * 60 * 24 * 365 * 100),
            ),
            ..client::Config::default()
        };

        let timeout_secs = config
            .connection_timeout_secs
            .filter(|value| *value > 0)
            .unwrap_or(30);
        let connection_timeout = Duration::from_secs(timeout_secs);

        // Load key material before opening the network session so bad local
        // credentials fail immediately instead of surfacing as a host timeout.
        let preloaded_key = match &config.auth_method {
            AuthMethod::PublicKey {
                key_path,
                key_data,
                passphrase,
            } => Some(load_private_key(
                key_path.as_deref(),
                key_data.as_deref(),
                passphrase.as_deref(),
            )?),
            AuthMethod::Password { .. } => None,
        };
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
            AuthMethod::Password { password } => {
                let mut authenticated = ssh_session
                    .authenticate_password(&config.username, password)
                    .await
                    .map_err(|e| anyhow::anyhow!("Password authentication failed: {}", e))?;
                if !authenticated && password.is_empty() {
                    authenticated = ssh_session
                        .authenticate_none(&config.username)
                        .await
                        .map_err(|e| {
                            anyhow::anyhow!("Passwordless authentication failed: {}", e)
                        })?;
                }
                authenticated
            }
            AuthMethod::PublicKey {
                key_path: _key_path,
                key_data: _key_data,
                passphrase: _passphrase,
            } => {
                let key = preloaded_key.expect("public-key material is loaded before connecting");
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
    pub async fn create_pty_session(
        &self,
        connection_id: &str,
        generation: u64,
        cols: u32,
        rows: u32,
    ) -> Result<PtySession> {
        if let Some(session) = &self.session {
            // Run the probes on separate exec channels: `BASH_VERSION` is an
            // unexported shell variable, while the POSIX login-shell probe must
            // also work when the account's remote shell is fish/csh/etc.
            let (login_probe_result, bash_probe_result) = tokio::join!(
                tokio::time::timeout(
                    Duration::from_secs(2),
                    self.execute_command(LOGIN_SHELL_PROBE)
                ),
                tokio::time::timeout(
                    Duration::from_secs(2),
                    self.execute_command(BASH_VERSION_PROBE)
                )
            );
            let login_shell = login_probe_result
                .ok()
                .and_then(Result::ok)
                .as_deref()
                .and_then(login_shell_from_probe)
                .map(str::to_owned);
            let bash_version = bash_probe_result
                .ok()
                .and_then(Result::ok)
                .as_deref()
                .and_then(bash_version_from_probe);

            // Open a new SSH channel
            let mut channel = session.channel_open_session().await?;
            let bash_terminal_modes = [(Pty::ECHO, 0), (Pty::ECHONL, 0)];
            let terminal_modes = if bash_version.is_some() {
                bash_terminal_modes.as_slice()
            } else {
                &[]
            };

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
                    terminal_modes,
                )
                .await?;

            // Prefer launching the login shell through `env`, so modern TUIs see
            // TrueColor before their startup color-profile detection runs. SSH
            // `env` requests are often filtered by AcceptEnv, while writing an
            // export into the PTY can race with the prompt and pollute input.
            if let Some(command) = login_shell
                .as_deref()
                .and_then(truecolor_login_shell_command)
            {
                let exec_result = channel.exec(true, String::from_utf8(command)?).await;
                if truecolor_exec_action(&exec_result) == TruecolorExecAction::ReopenAndRequestShell
                {
                    tracing::warn!(
                        "[PTY] TrueColor login-shell exec wrapper rejected; reopening a fresh channel for request_shell"
                    );
                    let _ = channel.close().await;
                    channel = session.channel_open_session().await?;
                    channel
                        .request_pty(true, "xterm-256color", cols, rows, 0, 0, terminal_modes)
                        .await?;
                    let _ = channel.set_env(false, "COLORTERM", "truecolor").await;
                    let _ = channel.set_env(false, "RUNEWIDTH_EASTASIAN", "0").await;
                    channel.request_shell(true).await?;
                }
            } else {
                // Best effort only: some servers may accept it even though this
                // is not guaranteed without the wrapper above.
                let _ = channel.set_env(false, "COLORTERM", "truecolor").await;
                let _ = channel.set_env(false, "RUNEWIDTH_EASTASIAN", "0").await;
                channel.request_shell(true).await?;
            }

            // Create channels for bidirectional communication (like ttyd's pty_buf)
            // Increased capacity for better buffering during fast input
            let (input_tx, mut input_rx) = mpsc::channel::<Vec<u8>>(1000); // Increased from 100
            let (output_tx, output_rx) = mpsc::channel::<Vec<u8>>(128); // Bounded: back-pressure to SSH window

            // Clone channel for input task
            let mut input_channel = channel.make_writer();
            if let Some(version) = bash_version {
                let integration_command = bash_shell_integration_command(version);
                input_channel.write_all(&integration_command).await?;
                input_channel.flush().await?;
            }

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
                        tracing::warn!("[PTY] Failed to send data to SSH: {}", e);
                        break;
                    }
                    // Critical: flush immediately after write (like ttyd)
                    // This ensures data is sent to PTY without buffering delay
                    if let Err(e) = writer.flush().await {
                        tracing::warn!("[PTY] Failed to flush data to SSH: {}", e);
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

            // Spawn task to handle output (SSH → frontend), resize requests, and
            // low-overhead PTY wakeup diagnostics. Counters stay local to this
            // task, so the hot path only performs integer increments.
            let diagnostic_connection_id = connection_id.to_string();
            tokio::spawn(async move {
                let mut pending_startup = startup_bytes;
                let mut stats = PtyLoopStats::default();
                let mut stats_interval = tokio::time::interval_at(
                    tokio::time::Instant::now() + PTY_LOOP_STATS_INTERVAL,
                    PTY_LOOP_STATS_INTERVAL,
                );
                stats_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

                tracing::info!(
                    "[PTY-STATS] armed id={} gen={} interval_secs={} non_data_warn_threshold={}",
                    diagnostic_connection_id,
                    generation,
                    PTY_LOOP_STATS_INTERVAL.as_secs(),
                    PTY_NON_DATA_WAKEUP_WARN_THRESHOLD,
                );

                loop {
                    tokio::select! {
                        msg = channel.wait() => {
                            match msg {
                                Some(ChannelMsg::Data { data }) => {
                                    stats.record_data(data.len());
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
                                    stats.record_extended_data(data.len());
                                    if output_tx.send(data.to_vec()).await.is_err() {
                                        break;
                                    }
                                }
                                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                                    stats.wait_wakeups = stats.wait_wakeups.saturating_add(1);
                                    stats.terminal_events = stats.terminal_events.saturating_add(1);
                                    tracing::warn!(
                                        "[PTY] Channel closed id={} gen={} (remote shell ended or SSH connection lost)",
                                        diagnostic_connection_id,
                                        generation,
                                    );
                                    break;
                                }
                                Some(ChannelMsg::ExitStatus { exit_status }) => {
                                    stats.wait_wakeups = stats.wait_wakeups.saturating_add(1);
                                    stats.exit_status_messages = stats.exit_status_messages.saturating_add(1);
                                    tracing::info!(
                                        "[PTY] Process exited id={} gen={} status={}",
                                        diagnostic_connection_id,
                                        generation,
                                        exit_status,
                                    );
                                }
                                Some(ChannelMsg::WindowAdjusted { .. }) => {
                                    stats.wait_wakeups = stats.wait_wakeups.saturating_add(1);
                                    stats.window_adjusted_messages = stats.window_adjusted_messages.saturating_add(1);
                                }
                                Some(ChannelMsg::Success) => {
                                    stats.wait_wakeups = stats.wait_wakeups.saturating_add(1);
                                    stats.success_messages = stats.success_messages.saturating_add(1);
                                }
                                Some(ChannelMsg::Failure) => {
                                    stats.wait_wakeups = stats.wait_wakeups.saturating_add(1);
                                    stats.failure_messages = stats.failure_messages.saturating_add(1);
                                }
                                Some(_) => {
                                    stats.wait_wakeups = stats.wait_wakeups.saturating_add(1);
                                    stats.other_messages = stats.other_messages.saturating_add(1);
                                }
                            }
                        }
                        resize = resize_rx.recv() => {
                            match resize {
                                Some((cols, rows)) => {
                                    stats.resize_events = stats.resize_events.saturating_add(1);
                                    if let Err(e) = channel.window_change(cols, rows, 0, 0).await {
                                        tracing::warn!("[PTY] Failed to send window change: {}", e);
                                    } else {
                                        tracing::debug!("[PTY] Window changed to {}x{}", cols, rows);
                                    }
                                }
                                None => {
                                    break;
                                }
                            }
                        }
                        _ = stats_interval.tick() => {
                            log_pty_loop_stats(
                                &diagnostic_connection_id,
                                generation,
                                &stats,
                                false,
                            );
                            stats.reset();
                        }
                    }
                }

                log_pty_loop_stats(
                    &diagnostic_connection_id,
                    generation,
                    &stats,
                    true,
                );
                tracing::info!(
                    "[PTY-STATS] task exited id={} gen={}",
                    diagnostic_connection_id,
                    generation,
                );
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

    pub(crate) async fn open_sftp_session(&self) -> Result<SftpSession> {
        let session = self
            .session
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Not connected"))?;
        let channel = session.channel_open_session().await?;
        channel.request_subsystem(true, "sftp").await?;
        Ok(SftpSession::new(channel.into_stream()).await?)
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
            let channel = session.channel_open_session().await?;
            channel.request_subsystem(true, "sftp").await?;
            let sftp = SftpSession::new(channel.into_stream()).await?;
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
