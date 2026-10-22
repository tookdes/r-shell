import { describe, expect, it } from 'vitest';
import { folderPathFromArg } from '../lib/connection-folder';

describe('folderPathFromArg', () => {
  it('passes through non-empty folder paths', () => {
    expect(folderPathFromArg('Work')).toBe('Work');
    expect(folderPathFromArg('Work/ProjectA')).toBe('Work/ProjectA');
  });

  it('rejects click events and other non-string values', () => {
    expect(folderPathFromArg(new MouseEvent('click'))).toBeUndefined();
    expect(folderPathFromArg({ target: document.body })).toBeUndefined();
    expect(folderPathFromArg(undefined)).toBeUndefined();
    expect(folderPathFromArg('')).toBeUndefined();
  });
});
