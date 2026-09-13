from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one match, found {count}: {old[:80]!r}")
    p.write_text(text.replace(old, new, 1))


def insert_after(path: str, anchor: str, addition: str) -> None:
    replace_once(path, anchor, anchor + addition)


# PTY frontend: never lose a resize while WS/StartPty is in flight, and recover
# a StartPty handshake that silently stalls. Preserve fork-specific ZMODEM,
# diagnostics, DOM renderer, generation guards, and flow control.
pty = "src/components/pty-terminal.tsx"
insert_after(
    pty,
    "    let isRunning = true;\n",
    "    // Last geometry known to have reached the PTY. A resize observed while\n"
    "    // the WebSocket is unavailable is kept pending rather than marked sent.\n"
    "    let lastSentCols = term.cols;\n"
    "    let lastSentRows = term.rows;\n"
    "    let pendingResize: { cols: number; rows: number } | null = null;\n",
)
insert_after(
    pty,
    "    let zmodemActive = false;\n",
    "\n    // If StartPty never confirms, escalate to the fork's full reconnect path\n"
    "    // instead of leaving the tab stuck indefinitely.\n"
    "    const START_PTY_WATCHDOG_MS = 8000;\n"
    "    let startPtyWatchdog: ReturnType<typeof setTimeout> | null = null;\n"
    "    let ptyHandshakeDone = false;\n",
)
insert_after(
    pty,
    "    const connectWebSocket = async () => {\n",
    "      // Geometry carried by the current StartPty request. PtyStarted uses\n"
    "      // this to detect a fit that raced the backend SSH-channel setup.\n"
    "      let startPtyDims: { cols: number; rows: number } | null = null;\n",
)
replace_once(
    pty,
    "        // Start PTY session\n"
    "        const startMsg = {\n"
    "          type: 'StartPty',\n"
    "          connection_id: connectionId,\n"
    "          cols: term.cols,\n"
    "          rows: term.rows,\n"
    "        };\n"
    "        console.log(`[PTY Terminal] [${connectionId}] Starting PTY connection with ${term.cols}x${term.rows}`);\n"
    "        ws.send(JSON.stringify(startMsg));\n",
    "        // Start PTY session with a stable geometry snapshot.\n"
    "        const startCols = term.cols;\n"
    "        const startRows = term.rows;\n"
    "        startPtyDims = { cols: startCols, rows: startRows };\n"
    "        const startMsg = {\n"
    "          type: 'StartPty',\n"
    "          connection_id: connectionId,\n"
    "          cols: startCols,\n"
    "          rows: startRows,\n"
    "        };\n"
    "        console.log(`[PTY Terminal] [${connectionId}] Starting PTY connection with ${startCols}x${startRows}`);\n"
    "        ws.send(JSON.stringify(startMsg));\n"
    "\n"
    "        ptyHandshakeDone = false;\n"
    "        if (startPtyWatchdog) clearTimeout(startPtyWatchdog);\n"
    "        startPtyWatchdog = setTimeout(() => {\n"
    "          startPtyWatchdog = null;\n"
    "          if (!isRunning || ptyHandshakeDone) return;\n"
    "          console.warn(`[PTY Terminal] [${connectionId}] StartPty handshake timed out; escalating to full reconnect`);\n"
    "          if (connectionStatusRef.current !== 'disconnected') {\n"
    "            connectionStatusRef.current = 'disconnected';\n"
    "            onConnectionStatusChange?.(connectionId, 'disconnected');\n"
    "          }\n"
    "          const fullReconnect = onReconnectTabRef.current;\n"
    "          if (fullReconnect) {\n"
    "            void fullReconnect(connectionId);\n"
    "          } else {\n"
    "            reconnectAttemptsRef.current = 0;\n"
    "            setReconnectKey((previous) => previous + 1);\n"
    "          }\n"
    "          if (ws.readyState === WebSocket.OPEN) ws.close();\n"
    "        }, START_PTY_WATCHDOG_MS);\n"
    "\n"
    "        // Flush the latest resize observed before this socket became OPEN.\n"
    "        if (pendingResize) {\n"
    "          const { cols, rows } = pendingResize;\n"
    "          pendingResize = null;\n"
    "          if (cols !== startCols || rows !== startRows) {\n"
    "            ws.send(JSON.stringify({ type: 'Resize', connection_id: connectionId, cols, rows }));\n"
    "          }\n"
    "          lastSentCols = cols;\n"
    "          lastSentRows = rows;\n"
    "        }\n",
)
replace_once(
    pty,
    "              if (msg.message.includes('PTY connection started')) {\n"
    "                reconnectAttemptsRef.current = 0;\n",
    "              if (msg.message.includes('PTY connection started')) {\n"
    "                ptyHandshakeDone = true;\n"
    "                if (startPtyWatchdog) { clearTimeout(startPtyWatchdog); startPtyWatchdog = null; }\n"
    "                reconnectAttemptsRef.current = 0;\n",
)
replace_once(
    pty,
    "                const INITIAL_WINDOW = 2;\n"
    "                grantCredits(INITIAL_WINDOW);\n",
    "                const INITIAL_WINDOW = 2;\n"
    "                grantCredits(INITIAL_WINDOW);\n"
    "                ptyHandshakeDone = true;\n"
    "                if (startPtyWatchdog) { clearTimeout(startPtyWatchdog); startPtyWatchdog = null; }\n"
    "\n"
    "                // A fit may have occurred after StartPty was sent but before\n"
    "                // the backend finished creating the PTY. Reconcile once the\n"
    "                // generation proves the session exists.\n"
    "                const needsResizeSync =\n"
    "                  startPtyDims !== null &&\n"
    "                  (term.cols !== startPtyDims.cols || term.rows !== startPtyDims.rows) &&\n"
    "                  (term.cols !== lastSentCols || term.rows !== lastSentRows);\n"
    "                if (needsResizeSync) {\n"
    "                  const liveWs = wsRef.current;\n"
    "                  if (liveWs && liveWs.readyState === WebSocket.OPEN) {\n"
    "                    liveWs.send(JSON.stringify({\n"
    "                      type: 'Resize',\n"
    "                      connection_id: connectionId,\n"
    "                      cols: term.cols,\n"
    "                      rows: term.rows,\n"
    "                    }));\n"
    "                    lastSentCols = term.cols;\n"
    "                    lastSentRows = term.rows;\n"
    "                  }\n"
    "                }\n"
    "                startPtyDims = null;\n",
)
replace_once(
    pty,
    "    let lastSentCols = term.cols;\n"
    "    let lastSentRows = term.rows;\n"
    "    const resizeDisposable = term.onResize(({ cols, rows }) => {\n"
    "      if (cols === lastSentCols && rows === lastSentRows) return;\n"
    "      lastSentCols = cols;\n"
    "      lastSentRows = rows;\n"
    "      checkScrollability(); // row count changed — re-evaluate scrollability\n"
    "\n"
    "      const ws = wsRef.current;\n"
    "      if (ws && ws.readyState === WebSocket.OPEN) {\n",
    "    const resizeDisposable = term.onResize(({ cols, rows }) => {\n"
    "      if (cols === lastSentCols && rows === lastSentRows) return;\n"
    "      checkScrollability(); // row count changed — re-evaluate scrollability\n"
    "\n"
    "      const ws = wsRef.current;\n"
    "      if (ws && ws.readyState === WebSocket.OPEN) {\n"
    "        lastSentCols = cols;\n"
    "        lastSentRows = rows;\n"
    "        pendingResize = null;\n",
)
replace_once(
    pty,
    "          outputWatermark: outputWatermarkRef.current,\n"
    "        });\n"
    "      }\n"
    "    });\n"
    "\n"
    "    // Debounced fit: coalesce rapid resize events into a single fit + PTY resize message.\n",
    "          outputWatermark: outputWatermarkRef.current,\n"
    "        });\n"
    "      } else {\n"
    "        pendingResize = { cols, rows };\n"
    "      }\n"
    "    });\n"
    "\n"
    "    // Debounced fit: coalesce rapid resize events into a single fit + PTY resize message.\n",
)
insert_after(
    pty,
    "      isRunning = false;\n",
    "      if (startPtyWatchdog) { clearTimeout(startPtyWatchdog); startPtyWatchdog = null; }\n",
)

# Tab drag robustness from upstream #133 + close-button follow-up #136.
tabs = "src/components/terminal/group-tab-bar.tsx"
replace_once(
    tabs,
    "import React, { useState, useCallback, useRef, useEffect } from 'react';",
    "import React, { useState, useCallback, useLayoutEffect, useRef, useEffect } from 'react';",
)
insert_after(
    tabs,
    "  // ── Pointer-based custom drag ──\n",
    "\n  // FLIP animation smooths reorder/close commits instead of jumping tabs.\n"
    "  const tabOrderRef = useRef<{ order: string; lefts: Map<string, number> } | null>(null);\n"
    "  useLayoutEffect(() => {\n"
    "    const container = tabBarRef.current;\n"
    "    if (!container) return;\n"
    "    const lefts = new Map<string, number>();\n"
    "    for (const node of container.querySelectorAll<HTMLElement>('[data-tab-id]')) {\n"
    "      lefts.set(node.dataset.tabId ?? '', node.getBoundingClientRect().left);\n"
    "    }\n"
    "    const order = tabs.map((tab) => tab.id).join('\\u0000');\n"
    "    const prev = tabOrderRef.current;\n"
    "    tabOrderRef.current = { order, lefts };\n"
    "    if (!prev || prev.order === order) return;\n"
    "    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;\n"
    "    for (const node of container.querySelectorAll<HTMLElement>('[data-tab-id]')) {\n"
    "      const id = node.dataset.tabId ?? '';\n"
    "      const prevLeft = prev.lefts.get(id);\n"
    "      const nextLeft = lefts.get(id);\n"
    "      if (prevLeft === undefined || nextLeft === undefined) continue;\n"
    "      const delta = prevLeft - nextLeft;\n"
    "      if (Math.abs(delta) < 1) continue;\n"
    "      node.style.transform = `translateX(${delta}px)`;\n"
    "      node.style.transition = 'none';\n"
    "      void node.offsetWidth;\n"
    "      node.style.transition = 'transform 150ms ease';\n"
    "      node.style.transform = '';\n"
    "    }\n"
    "  }, [tabs]);\n",
)
replace_once(
    tabs,
    "      const startX = e.clientX;\n"
    "      const startY = e.clientY;\n",
    "      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* jsdom / old WebKit */ }\n"
    "      const pointerId = e.pointerId;\n"
    "      const startX = e.clientX;\n"
    "      const startY = e.clientY;\n",
)
replace_once(
    tabs,
    "      const onMove = (ev: PointerEvent) => {\n"
    "        const dx = ev.clientX - startX;\n"
    "        const dy = ev.clientY - startY;\n"
    "\n"
    "        if (!dragging) {\n"
    "          if (Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;\n",
    "      const onMove = (ev: PointerEvent) => {\n"
    "        if (ev.pointerId !== pointerId) return;\n"
    "        if (ev.buttons === 0) { onUp(ev); return; }\n"
    "        const dx = ev.clientX - startX;\n"
    "        const dy = ev.clientY - startY;\n"
    "\n"
    "        if (!dragging) {\n"
    "          if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;\n",
)
replace_once(
    tabs,
    "                      className=\"p-0 h-4 w-4 opacity-0 group-hover:opacity-100\"\n"
    "                      onClick={(e) => {\n",
    "                      className=\"p-0 h-4 w-4 opacity-0 group-hover:opacity-100\"\n"
    "                      onPointerDown={(e) => e.stopPropagation()}\n"
    "                      onClick={(e) => {\n",
)

# Persist collapsed connection folders across restarts.
folder_lib = Path("src/lib/folder-expansion.ts")
folder_lib.write_text("""export const COLLAPSED_FOLDERS_STORAGE_KEY = 'r-shell-collapsed-folders';

export interface ExpandableNode {
  id: string;
  type: 'folder' | 'connection';
  isExpanded?: boolean;
  children?: ExpandableNode[];
}

export function loadCollapsedFolderIds(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_FOLDERS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === 'string'));
  } catch {
    return new Set();
  }
}

export function saveCollapsedFolderIds(ids: Iterable<string>): void {
  try {
    localStorage.setItem(COLLAPSED_FOLDERS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch (error) {
    console.warn('Could not persist folder expansion state:', error);
  }
}

export function applyCollapsedState<T extends ExpandableNode>(nodes: T[], collapsed: Set<string>): T[] {
  return nodes.map((node) => {
    if (node.type !== 'folder') return node;
    const next: T = { ...node, isExpanded: !collapsed.has(node.id) };
    if (node.children) next.children = applyCollapsedState(node.children, collapsed);
    return next;
  });
}

export function collectCollapsedFolderIds(nodes: ExpandableNode[]): string[] {
  const ids: string[] = [];
  const walk = (list: ExpandableNode[]) => {
    for (const node of list) {
      if (node.type !== 'folder') continue;
      if (node.isExpanded === false) ids.push(node.id);
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return ids;
}
""")

cm = "src/components/connection-manager.tsx"
insert_after(
    cm,
    "import { ConnectionStorageManager } from '../lib/connection-storage';\n",
    "import { applyCollapsedState, collectCollapsedFolderIds, loadCollapsedFolderIds, saveCollapsedFolderIds } from '../lib/folder-expansion';\n",
)
replace_once(
    cm,
    "    return tree.length > 0 ? tree : [];\n",
    "    return tree.length > 0 ? applyCollapsedState(tree, loadCollapsedFolderIds()) : [];\n",
)
replace_once(
    cm,
    "    setConnections(updateNode(connections));\n"
    "  };\n\n  const getIcon = (node: ConnectionNode) => {\n",
    "    const next = updateNode(connections);\n"
    "    saveCollapsedFolderIds(collectCollapsedFolderIds(next));\n"
    "    setConnections(next);\n"
    "  };\n\n  const getIcon = (node: ConnectionNode) => {\n",
)

# Transfer queue viewport constraint/divider polish from upstream #149.
transfer = "src/components/transfer-queue.tsx"
replace_once(transfer, '<ScrollArea className="max-h-40">', '<ScrollArea className="max-h-40 overflow-hidden [&>[data-slot=scroll-area-viewport]]:max-h-40">')
replace_once(transfer, '<div className="divide-y divide-border/40">', '<div className="divide-y divide-border">')

# Temporary runner removes itself and the temporary workflow before committing,
# so only product changes remain in the branch tree.
Path("scripts/apply-upstream-2.9.2-selected.py").unlink(missing_ok=True)
Path(".github/workflows/apply-upstream-selected.yml").unlink(missing_ok=True)
