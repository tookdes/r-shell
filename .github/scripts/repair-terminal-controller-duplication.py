from pathlib import Path
import sys

root = Path(sys.argv[1]).resolve()


def collapse_duplicate(relative_path: str, block: str) -> None:
    path = root / relative_path
    source = path.read_text()
    count = source.count(block)
    if count == 1:
        return
    if count != 2:
        raise SystemExit(f"{relative_path}: expected duplicate count 1 or 2, got {count}")
    first = source.find(block)
    second = source.find(block, first + len(block))
    source = source[:second] + source[second + len(block):]
    path.write_text(source)


collapse_duplicate(
    "src/components/pty-terminal.tsx",
    """import { routePtyOutputFrame } from '../lib/pty-output-frame';
import {
  configureTerminalDiagnostics,
  flushTerminalDiagnostics,
  recordTerminalDiagnostic,
  shortConnectionHash,
} from '../lib/terminal-diagnostics';
""",
)

collapse_duplicate(
    "src/components/pty-terminal.tsx",
    """  const activeRef = React.useRef(isActive);
  const framesReceivedRef = React.useRef(0);
  const bytesReceivedRef = React.useRef(0);
  const wrongConnectionFramesDroppedRef = React.useRef(0);
  const outputWatermarkRef = React.useRef(0);
""",
)

collapse_duplicate(
    "src/components/pty-terminal.tsx",
    """        recordTerminalDiagnostic({
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
)

collapse_duplicate(
    "src-tauri/src/ssh/mod.rs",
    """#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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
)

print("controller duplicate insertions repaired")
