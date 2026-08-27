from pathlib import Path
import sys

root = Path(sys.argv[1]).resolve()


def patch(relative_path: str, old: str, new: str, marker: str) -> None:
    path = root / relative_path
    source = path.read_text()
    if marker in source:
        return
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{relative_path}: expected one source block for {marker!r}, found {count}")
    path.write_text(source.replace(old, new, 1))


# Do not hold the PTY registry read lock across an unbounded recv(). Closing or
# replacing a PTY needs the registry write lock; clone the Arc and drop the map
# guard before waiting on the output channel.
patch(
    "src-tauri/src/connection_manager.rs",
    """        let pty_sessions = self.pty_sessions.read().await;
        let pty = pty_sessions
            .get(connection_id)
            .ok_or_else(|| anyhow::anyhow!("PTY connection not found"))?;

        let mut rx = pty.output_rx.lock().await;
""",
    """        let pty = {
            let pty_sessions = self.pty_sessions.read().await;
            pty_sessions
                .get(connection_id)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("PTY connection not found"))?
        };

        let mut rx = pty.output_rx.lock().await;
""",
    ".get(connection_id)\n                .cloned()",
)

# Keep the 10 ms cadence measured from the first pending byte, not from the most
# recent receive. Otherwise a continuous trickle below OUTPUT_FLUSH_BYTES can
# postpone a flush indefinitely by resetting the timeout on every chunk.
patch(
    "src-tauri/src/websocket_server.rs",
    """                tokio::spawn(async move {
                    let mut accumulated = Vec::with_capacity(OUTPUT_FLUSH_BYTES);

                    loop {
                        // Event-driven: block when idle; arm the 10ms deadline only
                        // while bytes are pending so idle tabs consume no 1ms wakeups.
                        let read_result = tokio::select! {
                            biased;
                            _ = cancel_token.cancelled() => {
                                tracing::info!(
                                    "PTY reader task cancelled for {}",
                                    connection_id_clone
                                );
                                let _ = flush_output(
                                    &tx_clone,
                                    &connection_id_clone,
                                    &mut accumulated,
                                    &cancel_token,
                                ).await;
                                return;
                            }
                            result = connection_manager.read_from_pty(
                                &connection_id_clone,
                                if accumulated.is_empty() {
                                    None
                                } else {
                                    Some(Duration::from_millis(OUTPUT_FLUSH_INTERVAL_MS as u64))
                                },
                            ) => result,
                        };

                        match read_result {
                            Ok(None) => {
                                let ok = tokio::select! {
                                    biased;
                                    _ = cancel_token.cancelled() => false,
                                    r = credits.acquire() => r.map(|p| { p.forget(); true }).unwrap_or(false),
                                };
                                if !ok {
                                    break;
                                }
                                if flush_output(
                                    &tx_clone,
                                    &connection_id_clone,
                                    &mut accumulated,
                                    &cancel_token,
                                )
                                .await
                                    == SendOutcome::Closed
                                {
                                    break;
                                }
                            }
                            Ok(Some(data)) => {
                                accumulated.extend_from_slice(&data);
                                if accumulated.len() < OUTPUT_FLUSH_BYTES {
                                    continue;
                                }
                                let ok = tokio::select! {
                                    biased;
                                    _ = cancel_token.cancelled() => false,
                                    r = credits.acquire() => r.map(|p| { p.forget(); true }).unwrap_or(false),
                                };
                                if !ok {
                                    break;
                                }
                                if flush_output(
                                    &tx_clone,
                                    &connection_id_clone,
                                    &mut accumulated,
                                    &cancel_token,
                                )
                                .await
                                    == SendOutcome::Closed
                                {
                                    break;
                                }
                            }
                            Err(e) => {
                                tracing::error!(
                                    "Error reading from PTY {}: {}",
                                    connection_id_clone,
                                    e
                                );
                                let error_msg = WsMessage::Error {
                                    message: format!("Connection lost: {}", e),
                                };
                                let _ = send_control(&tx_clone, &error_msg).await;
                                break;
                            }
                        }
                    }

                    tracing::info!("PTY reader task exiting for {}", connection_id_clone);
                });
""",
    """                tokio::spawn(async move {
                    let mut accumulated = Vec::with_capacity(OUTPUT_FLUSH_BYTES);
                    let mut flush_deadline: Option<tokio::time::Instant> = None;

                    loop {
                        // Event-driven: block when idle. Once the first byte of a
                        // batch arrives, preserve one absolute 10 ms deadline so a
                        // continuous trickle cannot postpone the flush forever.
                        let max_wait = flush_deadline.map(|deadline| {
                            deadline.saturating_duration_since(tokio::time::Instant::now())
                        });
                        let read_result = tokio::select! {
                            biased;
                            _ = cancel_token.cancelled() => {
                                tracing::info!(
                                    "PTY reader task cancelled for {}",
                                    connection_id_clone
                                );
                                let _ = flush_output(
                                    &tx_clone,
                                    &connection_id_clone,
                                    &mut accumulated,
                                    &cancel_token,
                                ).await;
                                return;
                            }
                            result = connection_manager.read_from_pty(
                                &connection_id_clone,
                                max_wait,
                            ) => result,
                        };

                        match read_result {
                            Ok(None) => {
                                let ok = tokio::select! {
                                    biased;
                                    _ = cancel_token.cancelled() => false,
                                    r = credits.acquire() => r.map(|p| { p.forget(); true }).unwrap_or(false),
                                };
                                if !ok {
                                    break;
                                }
                                if flush_output(
                                    &tx_clone,
                                    &connection_id_clone,
                                    &mut accumulated,
                                    &cancel_token,
                                )
                                .await
                                    == SendOutcome::Closed
                                {
                                    break;
                                }
                                flush_deadline = None;
                            }
                            Ok(Some(data)) => {
                                if accumulated.is_empty() {
                                    flush_deadline = Some(
                                        tokio::time::Instant::now()
                                            + Duration::from_millis(OUTPUT_FLUSH_INTERVAL_MS as u64),
                                    );
                                }
                                accumulated.extend_from_slice(&data);
                                if accumulated.len() < OUTPUT_FLUSH_BYTES {
                                    continue;
                                }
                                let ok = tokio::select! {
                                    biased;
                                    _ = cancel_token.cancelled() => false,
                                    r = credits.acquire() => r.map(|p| { p.forget(); true }).unwrap_or(false),
                                };
                                if !ok {
                                    break;
                                }
                                if flush_output(
                                    &tx_clone,
                                    &connection_id_clone,
                                    &mut accumulated,
                                    &cancel_token,
                                )
                                .await
                                    == SendOutcome::Closed
                                {
                                    break;
                                }
                                flush_deadline = None;
                            }
                            Err(e) => {
                                tracing::error!(
                                    "Error reading from PTY {}: {}",
                                    connection_id_clone,
                                    e
                                );
                                let error_msg = WsMessage::Error {
                                    message: format!("Connection lost: {}", e),
                                };
                                let _ = send_control(&tx_clone, &error_msg).await;
                                break;
                            }
                        }
                    }

                    tracing::info!("PTY reader task exiting for {}", connection_id_clone);
                });
""",
    "let mut flush_deadline: Option<tokio::time::Instant> = None;",
)

print("event-driven PTY read hardening applied")
