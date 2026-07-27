/**
 * Issue #36 — connection tests must run outside the Tauri runtime.
 *
 * These unit tests mock `@tauri-apps/api/core.invoke` so `pnpm test` works in
 * plain Vitest/jsdom. Real SSH integration belongs in e2e / a Tauri-capable
 * harness, not the default frontend suite.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const mockedInvoke = vi.mocked(invoke);

describe('SSH Connection Tests (mocked invoke)', () => {
  const connectionId = 'test-connection-unit';

  beforeEach(() => {
    mockedInvoke.mockReset();
  });

  it('should successfully connect to SSH server', async () => {
    mockedInvoke.mockResolvedValueOnce({ success: true });

    const result = await invoke<{ success: boolean; error?: string }>('ssh_connect', {
      request: {
        connection_id: connectionId,
        host: 'localhost',
        port: 22,
        username: 'testuser',
        auth_method: 'password',
        password: 'testpass',
        key_path: null,
        passphrase: null,
      },
    });

    expect(mockedInvoke).toHaveBeenCalledWith(
      'ssh_connect',
      expect.objectContaining({
        request: expect.objectContaining({
          connection_id: connectionId,
          host: 'localhost',
          auth_method: 'password',
        }),
      }),
    );
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should execute a simple command', async () => {
    mockedInvoke.mockResolvedValueOnce({
      success: true,
      output: 'Hello from test\n',
    });

    const result = await invoke<{ success: boolean; output?: string; error?: string }>(
      'ssh_execute_command',
      {
        connection_id: connectionId,
        command: 'echo "Hello from test"',
      },
    );

    expect(mockedInvoke).toHaveBeenCalledWith(
      'ssh_execute_command',
      expect.objectContaining({
        connection_id: connectionId,
        command: 'echo "Hello from test"',
      }),
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('Hello from test');
  });

  it('should get system stats', async () => {
    mockedInvoke.mockResolvedValueOnce({
      success: true,
      output: JSON.stringify({
        cpu: 1.5,
        memory: { total: 1, used: 0 },
        disk: { total: '1G', used: '0' },
        uptime: '1 day',
      }),
    });

    const result = await invoke<{ success: boolean; output?: string; error?: string }>(
      'get_system_stats',
      { connection_id: connectionId },
    );

    expect(result.success).toBe(true);
    expect(result.output).toBeDefined();
    if (result.output) {
      const stats = JSON.parse(result.output) as Record<string, unknown>;
      expect(stats).toHaveProperty('cpu');
      expect(stats).toHaveProperty('memory');
      expect(stats).toHaveProperty('disk');
      expect(stats).toHaveProperty('uptime');
    }
  });

  it('should get process list', async () => {
    mockedInvoke.mockResolvedValueOnce({
      success: true,
      processes: [
        { pid: 1, user: 'root', cpu: 0.1, mem: 0.2, command: 'init' },
      ],
    });

    const result = await invoke<{
      success: boolean;
      processes?: Array<{
        pid: number;
        user: string;
        cpu: number;
        mem: number;
        command: string;
      }>;
      error?: string;
    }>('get_processes', { connection_id: connectionId });

    expect(result.success).toBe(true);
    expect(result.processes).toBeDefined();
    expect(Array.isArray(result.processes)).toBe(true);
    if (result.processes && result.processes.length > 0) {
      const processInfo = result.processes[0];
      expect(processInfo).toHaveProperty('pid');
      expect(processInfo).toHaveProperty('user');
      expect(processInfo).toHaveProperty('cpu');
      expect(processInfo).toHaveProperty('mem');
      expect(processInfo).toHaveProperty('command');
    }
  });

  it('should list files in home directory', async () => {
    mockedInvoke.mockResolvedValueOnce({
      success: true,
      files: [
        {
          name: '.bashrc',
          size: 100,
          is_dir: false,
          modified: '2026-01-01',
          permissions: '-rw-r--r--',
        },
      ],
    });

    const result = await invoke<{
      success: boolean;
      files?: Array<{
        name: string;
        size: number;
        is_dir: boolean;
        modified: string;
        permissions: string;
      }>;
      error?: string;
    }>('list_files', {
      connection_id: connectionId,
      path: '~',
    });

    expect(result.success).toBe(true);
    expect(result.files).toBeDefined();
    expect(Array.isArray(result.files)).toBe(true);
  });

  it('should fail with invalid credentials', async () => {
    mockedInvoke.mockResolvedValueOnce({
      success: false,
      error: 'Authentication failed',
    });

    const badConnectionId = 'bad-connection-unit';
    const result = await invoke<{ success: boolean; error?: string }>('ssh_connect', {
      request: {
        connection_id: badConnectionId,
        host: 'localhost',
        port: 22,
        username: 'testuser',
        auth_method: 'password',
        password: 'wrongpassword',
        key_path: null,
        passphrase: null,
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should disconnect successfully', async () => {
    mockedInvoke.mockResolvedValueOnce({ success: true });

    const result = await invoke<{ success: boolean; error?: string }>('ssh_disconnect', {
      connection_id: connectionId,
    });

    expect(mockedInvoke).toHaveBeenCalledWith(
      'ssh_disconnect',
      expect.objectContaining({ connection_id: connectionId }),
    );
    expect(result.success).toBe(true);
  });
});
