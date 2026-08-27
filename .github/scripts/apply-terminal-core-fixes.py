from pathlib import Path
import sys

ROOT = Path(sys.argv[1]).resolve()


def patch(relative_path: str, old: str, new: str, marker: str) -> None:
    path = ROOT / relative_path
    source = path.read_text()
    count = source.count(old)
    if count == 1:
        path.write_text(source.replace(old, new, 1))
        return
    if count == 0 and marker in source:
        return
    raise SystemExit(
        f"{relative_path}: expected exactly one old block, found {count}; "
        f"already-patched marker={marker!r}"
    )


# Restore encryption for the edit-without-connect Save path.
patch(
    "src/components/connection-dialog.tsx",
    """    const secretsForStorage = {
      password: config.password,
      passphrase: config.passphrase,
      privateKeyData: config.privateKeyData,
      proxyPassword: config.proxyPassword,
    };""",
    """    const secretsForStorage = await encryptConnectionSecrets({
      password: config.password,
      passphrase: config.passphrase,
      privateKeyData: config.privateKeyData,
      proxyPassword: config.proxyPassword,
    });""",
    """const secretsForStorage = await encryptConnectionSecrets({
      password: config.password,
      passphrase: config.passphrase,
      privateKeyData: config.privateKeyData,
      proxyPassword: config.proxyPassword,
    });""",
)

# Register privacy-safe terminal diagnostics with Tauri.
patch(
    "src-tauri/src/lib.rs",
    "mod ssh;\nmod vnc_client;",
    "mod ssh;\nmod terminal_diagnostics;\nmod vnc_client;",
    "mod terminal_diagnostics;",
)
patch(
    "src-tauri/src/lib.rs",
    "            commands::secrets_decrypt,\n            commands::abort_connection_transfers,",
    "            commands::secrets_decrypt,\n            terminal_diagnostics::append_terminal_diagnostics,\n            commands::abort_connection_transfers,",
    "terminal_diagnostics::append_terminal_diagnostics,",
)

# Disable WebGL by default on the affected stable xterm stack and use the
# default DOM renderer. Keep Unicode11 and all existing terminal options.
patch(
    "src/components/pty-terminal.tsx",
    "import { WebglAddon } from '@xterm/addon-webgl';\n",
    "",
    "import { routePtyOutputFrame } from '../lib/pty-output-frame';",
)
patch(
    "src/components/pty-terminal.tsx",
    "import { buildPtyInputFrame, encodeModifiedEnterCsiU, normalizePtyInput } from '../lib/pty-input';\n",
    """import { buildPtyInputFrame, encodeModifiedEnterCsiU, normalizePtyInput } from '../lib/pty-input';
import { routePtyOutputFrame } from '../lib/pty-output-frame';
import {
  configureTerminalDiagnostics,
  flushTerminalDiagnostics,
  recordTerminalDiagnostic,
  shortConnectionHash,
} from '../lib/terminal-diagnostics';
""",
    "configureTerminalDiagnostics,",
)
patch(
    "src/components/pty-terminal.tsx",
    """  const rendererRef = React.useRef<string>('canvas');
  const webglAddonRef = React.useRef<WebglAddon | null>(null);
""",
    "  const rendererRef = React.useRef<string>('dom');\n",
    "const rendererRef = React.useRef<string>('dom');",
)
patch(
    "src/components/pty-terminal.tsx",
    "  const onOutputRef = React.useRef(onOutput);\n",
    """  const onOutputRef = React.useRef(onOutput);
  const activeRef = React.useRef(isActive);
  const framesReceivedRef = React.useRef(0);
  const bytesReceivedRef = React.useRef(0);
  const wrongConnectionFramesDroppedRef = React.useRef(0);
  const outputWatermarkRef = React.useRef(0);
""",
    "wrongConnectionFramesDroppedRef",
)
patch(
    "src/components/pty-terminal.tsx",
    """  React.useEffect(() => {
    onOutputRef.current = onOutput;
  }, [onOutput]);
  
  // PTY session generation — used in Close to avoid stale-close races
""",
    """  React.useEffect(() => {
    onOutputRef.current = onOutput;
  }, [onOutput]);

  React.useEffect(() => {
    activeRef.current = isActive;
  }, [isActive]);

  React.useEffect(() => {
    configureTerminalDiagnostics((events) =>
      invoke<void>('append_terminal_diagnostics', { events }),
    );

    const connectionHash = shortConnectionHash(connectionId);
    const snapshot = (
      event: string,
      flags: { fit?: boolean; resize?: boolean; dispose?: boolean; reconnect?: boolean } = {},
    ) => {
      const term = xtermRef.current;
      const ws = wsRef.current;
      const websocketState = ws
        ? ['connecting', 'open', 'closing', 'closed'][ws.readyState] ?? `unknown-${ws.readyState}`
        : 'none';
      recordTerminalDiagnostic({
        event,
        connectionHash,
        renderer: rendererRef.current,
        active: activeRef.current,
        cols: term?.cols,
        rows: term?.rows,
        websocketState,
        ptyGeneration: ptyGenerationRef.current ?? undefined,
        framesReceived: framesReceivedRef.current,
        bytesReceived: bytesReceivedRef.current,
        wrongConnectionFramesDropped: wrongConnectionFramesDroppedRef.current,
        outputWatermark: outputWatermarkRef.current,
        ...flags,
      });
    };

    snapshot('component_mounted');
    const heartbeat = window.setInterval(() => snapshot('heartbeat'), 5000);
    const flush = () => { void flushTerminalDiagnostics(); };
    const flushWhenHidden = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', flushWhenHidden);

    return () => {
      window.clearInterval(heartbeat);
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', flushWhenHidden);
      snapshot('component_disposed', { dispose: true });
      flush();
    };
  }, [connectionId]);
  
  // PTY session generation — used in Close to avoid stale-close races
""",
    "snapshot('component_mounted')",
)
patch(
    "src/components/pty-terminal.tsx",
    """    // Load WebGL renderer for better performance
    // NOTE: WebGL doesn't support transparency, so skip it when background image is set
    if (!appearance.backgroundImage) {
      try {
        const webglAddon = new WebglAddon();
        // Dispose listener — xterm calls this when the addon is disposed
        webglAddon.onContextLoss(() => {
          webglAddon.dispose();
          webglAddonRef.current = null;
          rendererRef.current = 'canvas';
          console.warn('[PTY Terminal] WebGL context lost, falling back to canvas');
        });
        term.loadAddon(webglAddon);
        webglAddonRef.current = webglAddon;
        rendererRef.current = 'webgl';
        console.log('[PTY Terminal] WebGL renderer loaded');
      } catch (e) {
        rendererRef.current = 'canvas';
        console.warn('[PTY Terminal] WebGL not supported, falling back to canvas:', e);
      }
    } else {
      rendererRef.current = 'canvas';
      console.log('[PTY Terminal] Using canvas renderer (background image requires transparency)');
    }
    
    fitAddon.fit();
""",
    """    // WebGL is intentionally disabled on the current stable xterm stack.
    // Equal Terminal instances can share a WebGL texture atlas; clearing that
    // atlas from one tab can corrupt glyph rendering in sibling tabs. The xterm
    // default DOM renderer does not share that GPU atlas and is the safe fallback.
    rendererRef.current = 'dom';
    recordTerminalDiagnostic({
      event: 'renderer_ready',
      connectionHash: shortConnectionHash(connectionId),
      renderer: 'dom',
      active: activeRef.current,
      cols: term.cols,
      rows: term.rows,
    });

    fitAddon.fit();
    recordTerminalDiagnostic({
      event: 'fit',
      connectionHash: shortConnectionHash(connectionId),
      renderer: 'dom',
      active: activeRef.current,
      cols: term.cols,
      rows: term.rows,
      fit: true,
    });
""",
    "event: 'renderer_ready'",
)
patch(
    "src/components/pty-terminal.tsx",
    """      // Dispose WebGL addon FIRST so GPU textures are released before the
      // terminal canvas is removed from the DOM.
      if (webglAddonRef.current) {
        try { webglAddonRef.current.dispose(); } catch (_e) { /* already disposed */ }
        webglAddonRef.current = null;
      }
""",
    "",
    "WebGL is intentionally disabled on the current stable xterm stack.",
)

# Route every binary output frame through one tested parser and keep only
# metadata counters for wrong-connection drops.
patch(
    "src/components/pty-terminal.tsx",
    """          const data = new Uint8Array(event.data);
          if (data.length < 3 || data[0] !== 0x01) return;
          const idLen = (data[1] << 8) | data[2];
          const payloadOffset = 3 + idLen;
          if (data.length < payloadOffset) return;
          const frameConnectionId = new TextDecoder().decode(data.subarray(3, payloadOffset));
          if (frameConnectionId !== connectionId) return;
          const payload = data.subarray(payloadOffset);
          if (payload.length === 0) return;
""",
    """          const routed = routePtyOutputFrame(event.data, connectionId);
          if (routed.wrongConnection) {
            wrongConnectionFramesDroppedRef.current += 1;
            recordTerminalDiagnostic({
              event: 'wrong_connection_frame_dropped',
              connectionHash: shortConnectionHash(connectionId),
              renderer: rendererRef.current,
              active: activeRef.current,
              cols: term.cols,
              rows: term.rows,
              websocketState: 'open',
              ptyGeneration: ptyGenerationRef.current ?? undefined,
              framesReceived: framesReceivedRef.current,
              bytesReceived: bytesReceivedRef.current,
              wrongConnectionFramesDropped: wrongConnectionFramesDroppedRef.current,
              outputWatermark: outputWatermarkRef.current,
            });
            return;
          }
          const payload = routed.payload;
          if (!payload || payload.length === 0) return;
          framesReceivedRef.current += 1;
          bytesReceivedRef.current += routed.payloadBytes;
""",
    "event: 'wrong_connection_frame_dropped'",
)
patch(
    "src/components/pty-terminal.tsx",
    """          watermark = Math.max(watermark - data.length, 0);
          // One completed frontend write returns at most one credit, keeping
""",
    """          watermark = Math.max(watermark - data.length, 0);
          outputWatermarkRef.current = watermark;
          // One completed frontend write returns at most one credit, keeping
""",
    "outputWatermarkRef.current = watermark;",
)
patch(
    "src/components/pty-terminal.tsx",
    """        writeBuffer += text;
        watermark += text.length;
        if (rafId === null) {
""",
    """        writeBuffer += text;
        watermark += text.length;
        outputWatermarkRef.current = watermark;
        if (rafId === null) {
""",
    "watermark += text.length;\n        outputWatermarkRef.current = watermark;",
)
patch(
    "src/components/pty-terminal.tsx",
    """      ws.onopen = () => {
        console.log(`[PTY Terminal] [${connectionId}] WebSocket connected`);
        term.writeln('\\x1b[32m✓ WebSocket connected\\x1b[0m');
""",
    """      ws.onopen = () => {
        console.log(`[PTY Terminal] [${connectionId}] WebSocket connected`);
        recordTerminalDiagnostic({
          event: 'websocket_open',
          connectionHash: shortConnectionHash(connectionId),
          renderer: rendererRef.current,
          active: activeRef.current,
          cols: term.cols,
          rows: term.rows,
          websocketState: 'open',
          ptyGeneration: ptyGenerationRef.current ?? undefined,
          framesReceived: framesReceivedRef.current,
          bytesReceived: bytesReceivedRef.current,
          wrongConnectionFramesDropped: wrongConnectionFramesDroppedRef.current,
          outputWatermark: outputWatermarkRef.current,
        });
        term.writeln('\\x1b[32m✓ WebSocket connected\\x1b[0m');
""",
    "event: 'websocket_open'",
)
patch(
    "src/components/pty-terminal.tsx",
    """                ptyGenerationRef.current = msg.generation;
                console.log(`[PTY Terminal] [${connectionId}] PTY generation: ${msg.generation}`);
                signalReady(connectionId);
""",
    """                ptyGenerationRef.current = msg.generation;
                console.log(`[PTY Terminal] [${connectionId}] PTY generation: ${msg.generation}`);
                recordTerminalDiagnostic({
                  event: 'pty_started',
                  connectionHash: shortConnectionHash(connectionId),
                  renderer: rendererRef.current,
                  active: activeRef.current,
                  cols: term.cols,
                  rows: term.rows,
                  websocketState: 'open',
                  ptyGeneration: msg.generation,
                  framesReceived: framesReceivedRef.current,
                  bytesReceived: bytesReceivedRef.current,
                  wrongConnectionFramesDropped: wrongConnectionFramesDroppedRef.current,
                  outputWatermark: outputWatermarkRef.current,
                });
                signalReady(connectionId);
""",
    "event: 'pty_started'",
)
patch(
    "src/components/pty-terminal.tsx",
    """      ws.onclose = (event) => {
        console.log('[PTY Terminal] WebSocket closed', {
          code: event?.code,
          reason: event?.reason,
          wasClean: event?.wasClean,
          hadEverConnected: hasEverConnected,
        });
""",
    """      ws.onclose = (event) => {
        console.log('[PTY Terminal] WebSocket closed', {
          code: event?.code,
          reason: event?.reason,
          wasClean: event?.wasClean,
          hadEverConnected: hasEverConnected,
        });
        recordTerminalDiagnostic({
          event: 'websocket_closed',
          connectionHash: shortConnectionHash(connectionId),
          renderer: rendererRef.current,
          active: activeRef.current,
          cols: term.cols,
          rows: term.rows,
          websocketState: 'closed',
          ptyGeneration: ptyGenerationRef.current ?? undefined,
          framesReceived: framesReceivedRef.current,
          bytesReceived: bytesReceivedRef.current,
          wrongConnectionFramesDropped: wrongConnectionFramesDroppedRef.current,
          reconnect: isRunning && isAutoReconnectEnabled(),
          outputWatermark: outputWatermarkRef.current,
        });
""",
    "event: 'websocket_closed'",
)
patch(
    "src/components/pty-terminal.tsx",
    """        ws.send(JSON.stringify(resizeMsg));
      }
    });
""",
    """        ws.send(JSON.stringify(resizeMsg));
        recordTerminalDiagnostic({
          event: 'resize',
          connectionHash: shortConnectionHash(connectionId),
          renderer: rendererRef.current,
          active: activeRef.current,
          cols,
          rows,
          websocketState: 'open',
          ptyGeneration: ptyGenerationRef.current ?? undefined,
          framesReceived: framesReceivedRef.current,
          bytesReceived: bytesReceivedRef.current,
          wrongConnectionFramesDropped: wrongConnectionFramesDroppedRef.current,
          resize: true,
          outputWatermark: outputWatermarkRef.current,
        });
      }
    });
""",
    "event: 'resize'",
)
patch(
    "src/components/pty-terminal.tsx",
    """      writeBuffer = '';
      watermark = 0;
      zmodemController?.abort();
""",
    """      writeBuffer = '';
      watermark = 0;
      outputWatermarkRef.current = 0;
      zmodemController?.abort();
""",
    "outputWatermarkRef.current = 0;",
)
patch(
    "src/components/pty-terminal.tsx",
    """        ws.send(JSON.stringify(closeMsg));
        ws.close();
      }
      ptyGenerationRef.current = null;
""",
    """        ws.send(JSON.stringify(closeMsg));
        ws.close();
      }
      recordTerminalDiagnostic({
        event: 'terminal_dispose',
        connectionHash: shortConnectionHash(connectionId),
        renderer: rendererRef.current,
        active: activeRef.current,
        cols: term.cols,
        rows: term.rows,
        websocketState: ws ? ['connecting', 'open', 'closing', 'closed'][ws.readyState] ?? 'unknown' : 'none',
        ptyGeneration: ptyGenerationRef.current ?? undefined,
        framesReceived: framesReceivedRef.current,
        bytesReceived: bytesReceivedRef.current,
        wrongConnectionFramesDropped: wrongConnectionFramesDroppedRef.current,
        dispose: true,
        outputWatermark: outputWatermarkRef.current,
      });
      void flushTerminalDiagnostics();
      ptyGenerationRef.current = null;
""",
    "event: 'terminal_dispose'",
)
patch(
    "src/components/pty-terminal.tsx",
    """      fitAddon.fit();
      if (term.rows > 0) {
""",
    """      fitAddon.fit();
      recordTerminalDiagnostic({
        event: 'fit_active_tab',
        connectionHash: shortConnectionHash(connectionId),
        renderer: rendererRef.current,
        active: true,
        cols: term.cols,
        rows: term.rows,
        fit: true,
      });
      if (term.rows > 0) {
""",
    "event: 'fit_active_tab'",
)

# On wrapper exec failure, throw away the affected channel and reopen a fresh
# shell channel. Never try request_shell on the failed exec channel.
patch(
    "src-tauri/src/ssh/mod.rs",
    """pub(crate) fn truecolor_login_shell_command(login_shell: &str) -> Option<Vec<u8>> {
    if !is_safe_unix_login_shell(login_shell) {
        return None;
    }

    format!(
        "/bin/sh -c 'exec env TERM=xterm-256color COLORTERM=truecolor RUNEWIDTH_EASTASIAN=0 {login_shell} -l'"
    )
    .into_bytes()
    .into()
}
""",
    """pub(crate) fn truecolor_login_shell_command(login_shell: &str) -> Option<Vec<u8>> {
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
""",
    "enum TruecolorExecAction",
)
patch(
    "src-tauri/src/ssh/mod.rs",
    """            if let Some(command) = login_shell
                .as_deref()
                .and_then(truecolor_login_shell_command)
            {
                channel.exec(true, String::from_utf8(command)?).await?;
            } else {
                // Best effort only: some servers may accept it even though this
                // is not guaranteed without the wrapper above.
                let _ = channel.set_env(false, "COLORTERM", "truecolor").await;
                let _ = channel.set_env(false, "RUNEWIDTH_EASTASIAN", "0").await;
                channel.request_shell(true).await?;
            }
""",
    """            if let Some(command) = login_shell
                .as_deref()
                .and_then(truecolor_login_shell_command)
            {
                let exec_result = channel.exec(true, String::from_utf8(command)?).await;
                if truecolor_exec_action(&exec_result) == TruecolorExecAction::ReopenAndRequestShell {
                    tracing::warn!(
                        "[PTY] TrueColor login-shell exec wrapper rejected; reopening a fresh channel for request_shell"
                    );
                    let _ = channel.close().await;
                    channel = session.channel_open_session().await?;
                    channel
                        .request_pty(
                            true,
                            "xterm-256color",
                            cols,
                            rows,
                            0,
                            0,
                            terminal_modes,
                        )
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
""",
    "TrueColor login-shell exec wrapper rejected",
)

print("controlled terminal core patches applied")
