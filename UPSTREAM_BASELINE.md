# Upstream Maintenance Baseline

This fork intentionally tracks upstream selectively. The goal is stability for personal use, not feature parity.

## Reviewed baselines

- Primary upstream: `GOODBOY008/r-shell`, reviewed through v3.0.3 (2026-10-09).
- Architecture/reference project: `since2006/shell-rs`, reviewed through the 2026-10-10 state used for this maintenance pass.
- Fork baseline before this pass: `2a26bbb2e66dda5f30dc47d56597544a786308ab`.

## Absorbed in this maintenance pass

- Upstream #193: lazily mount right-sidebar panels and suspend hidden monitor/log polling while preserving panel state.
- Upstream #192: macOS CPU, memory, and network-bandwidth corrections, including naming-agnostic interface selection.
- Upstream #197: larger async test budget for the integrated file-browser keyboard test.
- Local hardening: consistent POSIX single-quote escaping for log paths/source identifiers and numeric validation for remote process kill arguments.

## Intentionally not absorbed

- Settings redesign and self-service keybinding editor.
- Major frontend dependency migrations.
- russh/SFTP engine migration, segmented transfer architecture, and large transfer-pipeline rewrites.
- Storage migration away from the current encrypted-secret/localStorage model.
- Native-GUI/GPUI architectural changes from `shell-rs`.
- Keyboard-interactive authentication changes unless a concrete compatibility need appears.

## Maintenance rule

Prefer small, independently reviewable fixes with regression coverage. Do not update major dependencies, SSH/session semantics, PTY/WebSocket flow control, credential storage, or transfer architecture solely to match upstream. Revisit those areas only for a concrete bug, compatibility issue, security requirement, or measured performance problem.
