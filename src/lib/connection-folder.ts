/**
 * Normalize a new-connection folder argument.
 *
 * Some callbacks are wired directly to React/Radix onClick handlers, which can
 * pass a MouseEvent as the first argument. Only a non-empty string is a folder.
 */
export function folderPathFromArg(arg: unknown): string | undefined {
  return typeof arg === 'string' && arg.length > 0 ? arg : undefined;
}
