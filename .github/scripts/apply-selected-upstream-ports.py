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


# Upstream #66, semantic port: the backend spends one credit per output frame,
# so a RAF batch must return exactly the number of frames it coalesced. Keep the
# fork's byte watermark for privacy-safe diagnostics and keep ZMODEM frames from
# returning the same credit twice.
patch(
    "src/components/pty-terminal.tsx",
    """    let writeBuffer = '';
    let watermark = 0;
    let rafId: number | null = null;
""",
    """    let writeBuffer = '';
    let watermark = 0;
    let bufferedFrameCredits = 0;
    let rafId: number | null = null;
""",
    "let bufferedFrameCredits = 0;",
)
patch(
    "src/components/pty-terminal.tsx",
    """      // 3. Use watermark-based flow control: send Resume credits only when the
      //    pending byte count drops below LOW_WATER, avoiding per-frame ACKs.
      // =========================================================================

      /** Low watermark (bytes): below this, we grant a credit to the backend so
       *  it can send more data. */
      const LOW_WATER = 16 * 1024;
""",
    """      // 3. Return exactly one Resume credit per backend output frame after
      //    xterm processes the RAF batch. This keeps the backend semaphore bounded
      //    without shrinking the window when several frames coalesce into one write.
      // =========================================================================
""",
    "Return exactly one Resume credit per backend output frame",
)
patch(
    "src/components/pty-terminal.tsx",
    """        const data = writeBuffer;
        writeBuffer = '';

        // Single write per animation frame — the key optimisation.
        // Reduces term.write() calls from hundreds/s to ~60/s.
        term.write(data, () => {
          // xterm finished processing this batch — update watermark
          watermark = Math.max(watermark - data.length, 0);
          outputWatermarkRef.current = watermark;
          // One completed frontend write returns at most one credit, keeping
          // outstanding permits bounded (backend spends 1 permit per frame).
          if (watermark < LOW_WATER) {
            // Return one permit per drained write batch (backend spends one per frame).
            grantCredits(1);
          }
        });
""",
    """        const data = writeBuffer;
        const creditsToReturn = bufferedFrameCredits;
        writeBuffer = '';
        bufferedFrameCredits = 0;

        // Single write per animation frame — the key optimisation.
        // Reduces term.write() calls from hundreds/s to ~60/s.
        term.write(data, () => {
          // xterm finished processing this batch — update the diagnostic byte
          // watermark, then return one backend permit for every frame batched.
          watermark = Math.max(watermark - data.length, 0);
          outputWatermarkRef.current = watermark;
          grantCredits(creditsToReturn);
        });
""",
    "const creditsToReturn = bufferedFrameCredits;",
)
patch(
    "src/components/pty-terminal.tsx",
    """      const enqueueOutput = (text: string) => {
        writeBuffer += text;
        watermark += text.length;
        outputWatermarkRef.current = watermark;
        if (rafId === null) {
          rafId = requestAnimationFrame(flushWriteBuffer);
        }
      };
""",
    """      const enqueueOutput = (text: string, creditsToReturn = 1) => {
        // A streaming TextDecoder can retain an incomplete UTF-8 sequence and
        // produce no text for a consumed frame. Return that frame's permit now
        // or the two-credit pipeline can stall on a split multibyte character.
        if (!text) {
          grantCredits(creditsToReturn);
          return;
        }
        writeBuffer += text;
        watermark += text.length;
        bufferedFrameCredits += creditsToReturn;
        outputWatermarkRef.current = watermark;
        if (rafId === null) {
          rafId = requestAnimationFrame(flushWriteBuffer);
        }
      };
""",
    "bufferedFrameCredits += creditsToReturn;",
)
patch(
    "src/components/pty-terminal.tsx",
    """            enqueueOutput(outputDecoder.decode(bytes, { stream: true }));
""",
    """            enqueueOutput(outputDecoder.decode(bytes, { stream: true }), 0);
""",
    "enqueueOutput(outputDecoder.decode(bytes, { stream: true }), 0);",
)
patch(
    "src/components/pty-terminal.tsx",
    """                // Never lose terminal output: recover this frame directly.
                enqueueOutput(outputDecoder.decode(payload, { stream: true }));
""",
    """                // Never lose terminal output: recover this frame directly.
                // The active-ZMODEM path returns this frame's credit below.
                enqueueOutput(outputDecoder.decode(payload, { stream: true }), 0);
""",
    "The active-ZMODEM path returns this frame's credit below.",
)
patch(
    "src/components/pty-terminal.tsx",
    """      writeBuffer = '';
      watermark = 0;
      outputWatermarkRef.current = 0;
""",
    """      writeBuffer = '';
      watermark = 0;
      bufferedFrameCredits = 0;
      outputWatermarkRef.current = 0;
""",
    "bufferedFrameCredits = 0;\n      outputWatermarkRef.current = 0;",
)

# Upstream #105, semantic port: keep the deterministic activation repair but
# deliberately omit all WebGL lifecycle code. Only consume the activation latch
# after the pane has non-zero geometry; retry for ~2 seconds and let
# ResizeObserver complete a late 0x0 -> visible transition at any non-zero size.
patch(
    "src/components/pty-terminal.tsx",
    "  const wasActiveRef = React.useRef(isActive);\n",
    "  const wasActiveRef = React.useRef(false);\n",
    "const wasActiveRef = React.useRef(false);",
)
patch(
    "src/components/pty-terminal.tsx",
    """  const appearance = React.useMemo(() => loadAppearanceSettings(), [appearanceKey]);
  
  React.useEffect(() => {
""",
    """  const appearance = React.useMemo(() => loadAppearanceSettings(), [appearanceKey]);

  const completeVisibleActivation = React.useCallback((): boolean => {
    if (!activeRef.current) return false;
    if (wasActiveRef.current) return true;

    const term = xtermRef.current;
    const fitAddon = fitRef.current;
    const container = containerRef.current;
    if (!term || !fitAddon || !container) return false;
    if (container.offsetWidth <= 0 || container.offsetHeight <= 0) return false;

    fitAddon.fit();
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
      term.refresh(0, term.rows - 1);
    }
    term.focus();
    wasActiveRef.current = true;
    return true;
  }, [connectionId]);
  
  React.useEffect(() => {
""",
    "const completeVisibleActivation = React.useCallback",
)
patch(
    "src/components/pty-terminal.tsx",
    """    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // Only refit if the container has a reasonable size
        if (entry.contentRect.width > 100 && entry.contentRect.height > 100) {
          debouncedFit();
        }
      }
    });
""",
    """    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // Activation repair must accept any non-zero pane size. Deeply split
        // panes can legitimately be smaller than the normal debounced-fit gate.
        if (
          entry.contentRect.width > 0 &&
          entry.contentRect.height > 0 &&
          activeRef.current &&
          !wasActiveRef.current
        ) {
          completeVisibleActivation();
        }
        // Ordinary resize fits keep the existing noise-reduction threshold.
        if (entry.contentRect.width > 100 && entry.contentRect.height > 100) {
          debouncedFit();
        }
      }
    });
""",
    "Activation repair must accept any non-zero pane size.",
)
patch(
    "src/components/pty-terminal.tsx",
    """  }, [connectionId, host, username, reconnectKey, sendInputToPty, sendRawInputToPty, onWorkingDirectoryChange]);
""",
    """  }, [connectionId, host, username, reconnectKey, sendInputToPty, sendRawInputToPty, onWorkingDirectoryChange, completeVisibleActivation]);
""",
    "onWorkingDirectoryChange, completeVisibleActivation]);",
)
patch(
    "src/components/pty-terminal.tsx",
    """  React.useEffect(() => {
    if (!isActive) {
      wasActiveRef.current = false;
      return;
    }

    if (wasActiveRef.current) {
      return;
    }

    wasActiveRef.current = true;

    const frameId = window.requestAnimationFrame(() => {
      const term = xtermRef.current;
      const fitAddon = fitRef.current;
      const container = containerRef.current;
      if (!term || !fitAddon || !container) return;
      if (container.offsetWidth <= 0 || container.offsetHeight <= 0) return;

      fitAddon.fit();
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
        term.refresh(0, term.rows - 1);
      }
      term.focus();
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [isActive]);
""",
    """  React.useEffect(() => {
    if (!isActive) {
      wasActiveRef.current = false;
      return;
    }

    if (wasActiveRef.current) return;

    let cancelled = false;
    let frameId = 0;
    let attempts = 0;
    const MAX_ACTIVATION_FRAMES = 120;

    const tryActivate = () => {
      if (cancelled) return;
      if (completeVisibleActivation()) return;
      attempts += 1;
      if (attempts < MAX_ACTIVATION_FRAMES) {
        frameId = window.requestAnimationFrame(tryActivate);
      }
      // If the retry budget expires while the pane remains 0x0, deliberately
      // leave wasActiveRef false. ResizeObserver is the late-visibility backstop.
    };

    frameId = window.requestAnimationFrame(tryActivate);
    return () => {
      cancelled = true;
      if (frameId) window.cancelAnimationFrame(frameId);
    };
  }, [isActive, completeVisibleActivation]);
""",
    "const MAX_ACTIVATION_FRAMES = 120;",
)

# Upstream #106, semantic port: binary input is already length-prefixed in this
# fork; port only the event-driven PTY read so idle tabs stop waking at 1 kHz.
patch(
    "src-tauri/src/connection_manager.rs",
    """    /// Read data from PTY (output for display)
    /// OPTIMIZED: Use try_recv first for immediate data, then short timeout
    pub async fn read_from_pty(&self, connection_id: &str) -> Result<Vec<u8>> {
        let pty_sessions = self.pty_sessions.read().await;
        let pty = pty_sessions
            .get(connection_id)
            .ok_or_else(|| anyhow::anyhow!("PTY connection not found"))?;

        let mut rx = pty.output_rx.lock().await;

        // Try immediate read first (non-blocking)
        match rx.try_recv() {
            Ok(data) => return Ok(data),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty) => {
                // No immediate data, use short timeout
            }
            Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => {
                return Err(anyhow::anyhow!("PTY connection closed"));
            }
        }

        // Fall back to short timeout wait (1ms for ultra-low latency)
        match tokio::time::timeout(tokio::time::Duration::from_millis(1), rx.recv()).await {
            Ok(Some(data)) => Ok(data),
            Ok(None) => Err(anyhow::anyhow!("PTY connection closed")),
            Err(_) => Ok(Vec::new()), // Timeout - no data available
        }
    }
""",
    """    /// Read data from PTY (output for display), event-driven with no idle polling.
    /// With no deadline this blocks until output arrives. A deadline is used only
    /// while the WebSocket reader already has pending bytes to preserve the 10ms
    /// small-output flush cadence.
    pub async fn read_from_pty(
        &self,
        connection_id: &str,
        max_wait: Option<std::time::Duration>,
    ) -> Result<Option<Vec<u8>>> {
        let pty_sessions = self.pty_sessions.read().await;
        let pty = pty_sessions
            .get(connection_id)
            .ok_or_else(|| anyhow::anyhow!("PTY connection not found"))?;

        let mut rx = pty.output_rx.lock().await;
        match max_wait {
            None => match rx.recv().await {
                Some(data) => Ok(Some(data)),
                None => Err(anyhow::anyhow!("PTY connection closed")),
            },
            Some(duration) => match tokio::time::timeout(duration, rx.recv()).await {
                Ok(Some(data)) => Ok(Some(data)),
                Ok(None) => Err(anyhow::anyhow!("PTY connection closed")),
                Err(_) => Ok(None),
            },
        }
    }
""",
    "event-driven with no idle polling.",
)
patch(
    "src-tauri/src/connection_manager.rs",
    """    #[tokio::test]
    async fn test_new_manager_has_no_connections() {
        let mgr = ConnectionManager::new();
        let connections = mgr.list_connections().await;
        assert!(connections.is_empty());
    }
""",
    """    #[tokio::test]
    async fn test_new_manager_has_no_connections() {
        let mgr = ConnectionManager::new();
        let connections = mgr.list_connections().await;
        assert!(connections.is_empty());
    }

    #[tokio::test]
    async fn test_read_from_pty_is_event_driven_and_honors_flush_deadline() {
        let mgr = ConnectionManager::new();
        let (input_tx, _input_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(1);
        let (output_tx, output_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(8);
        let (resize_tx, _resize_rx) = tokio::sync::mpsc::channel::<(u32, u32)>(1);
        let session = PtySession {
            input_tx,
            output_rx: Arc::new(tokio::sync::Mutex::new(output_rx)),
            resize_tx,
            cancel: CancellationToken::new(),
        };
        mgr.pty_sessions
            .write()
            .await
            .insert("event-read".to_string(), Arc::new(session));

        output_tx.send(b"hello".to_vec()).await.unwrap();
        let data = mgr
            .read_from_pty("event-read", None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(data, b"hello");

        let deadline_result = mgr
            .read_from_pty(
                "event-read",
                Some(std::time::Duration::from_millis(10)),
            )
            .await
            .unwrap();
        assert!(deadline_result.is_none());

        drop(output_tx);
        assert!(mgr.read_from_pty("event-read", None).await.is_err());
    }
""",
    "test_read_from_pty_is_event_driven_and_honors_flush_deadline",
)
patch(
    "src-tauri/src/websocket_server.rs",
    """                tokio::spawn(async move {
                    let mut accumulated = Vec::with_capacity(OUTPUT_FLUSH_BYTES);
                    let mut last_flush = tokio::time::Instant::now();

                    loop {
                        // --- Read from PTY (1 ms poll) ---
                        let read_result = tokio::select! {
                            biased;
                            _ = cancel_token.cancelled() => {
                                tracing::info!(
                                    "PTY reader task cancelled for {}",
                                    connection_id_clone
                                );
                                // Flush any remaining data before exiting.
                                let _ = flush_output(
                                    &tx_clone,
                                    &connection_id_clone,
                                    &mut accumulated,
                                    &cancel_token,
                                ).await;
                                return;
                            }
                            result = connection_manager.read_from_pty(&connection_id_clone) => result,
                        };

                        match read_result {
                            Ok(data) if data.is_empty() => {
                                // 1 ms poll returned nothing — flush if interval elapsed.
                                if !accumulated.is_empty()
                                    && last_flush.elapsed().as_millis() >= OUTPUT_FLUSH_INTERVAL_MS
                                {
                                    // Wait for 1 frontend ACK before sending.
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
                                    last_flush = tokio::time::Instant::now();
                                }
                            }
                            Ok(data) => {
                                accumulated.extend_from_slice(&data);
                                if accumulated.len() >= OUTPUT_FLUSH_BYTES
                                    || last_flush.elapsed().as_millis() >= OUTPUT_FLUSH_INTERVAL_MS
                                {
                                    // Wait for 1 frontend ACK before sending.
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
                                    last_flush = tokio::time::Instant::now();
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
    "Event-driven: block when idle; arm the 10ms deadline only",
)

print("selected upstream terminal ports applied")
