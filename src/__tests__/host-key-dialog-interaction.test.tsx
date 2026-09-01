import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listener: undefined as undefined | ((event: { payload: unknown }) => void),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_event: string, listener: (event: { payload: unknown }) => void) => {
    mocks.listener = listener;
    return () => {};
  }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import { HostKeyDialog } from '../components/host-key-dialog';

describe('HostKeyDialog interaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listener = undefined;
    mocks.invoke.mockResolvedValue(undefined);
  });

  it('keeps reject and trust actions reachable for an unknown host key', async () => {
    render(<HostKeyDialog />);

    await waitFor(() => expect(mocks.listener).toBeTypeOf('function'));

    act(() => {
      mocks.listener?.({
        payload: {
          prompt_id: 'prompt-1',
          host: 'example.com',
          port: 22,
          algorithm: 'ssh-ed25519',
          fingerprint: 'SHA256:test-fingerprint',
          changed: false,
        },
      });
    });

    const rejectButton = screen.getByRole('button', { name: 'hostKey.reject' });
    expect(rejectButton).toBeTruthy();
    const trustButton = screen.getByRole('button', { name: 'hostKey.accept' });
    expect(trustButton).toBeTruthy();

    const content = document.querySelector('[data-slot="alert-dialog-content"]');
    const viewport = document.querySelector('[data-slot="alert-dialog-viewport"]');
    const positioner = document.querySelector('[data-slot="alert-dialog-positioner"]');
    expect(positioner?.getAttribute('class')).toContain('items-center');
    expect(positioner?.getAttribute('class')).toContain('justify-center');
    expect(positioner?.getAttribute('class')).toContain('overflow-hidden');
    expect(viewport?.getAttribute('class')).toContain('max-h-[calc(100dvh-2rem)]');
    expect(viewport?.getAttribute('class')).toContain('max-w-[calc(100dvw-2rem)]');
    expect(viewport?.getAttribute('class')).toContain('overflow-auto');
    expect(content?.getAttribute('class')).toContain('max-h-[calc(100dvh-2rem)]');

    fireEvent.click(trustButton);

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith('host_key_respond', {
        promptId: 'prompt-1',
        accept: true,
      });
    });
  });

  it('lets the user explicitly update and connect when the host key changed', async () => {
    render(<HostKeyDialog />);

    await waitFor(() => expect(mocks.listener).toBeTypeOf('function'));

    act(() => {
      mocks.listener?.({
        payload: {
          prompt_id: 'prompt-changed',
          host: '100.72.10.4',
          port: 22,
          algorithm: 'ssh-ed25519',
          fingerprint: 'SHA256:Lgb4XZMt+20PL7q/+QAs5xlJyp+rSvXZ1zPkataZqQ4',
          changed: true,
        },
      });
    });

    expect(screen.getByRole('button', { name: 'hostKey.reject' })).toBeTruthy();
    const updateButton = screen.getByRole('button', {
      name: 'connectionDialog.button.updateAndConnect',
    });
    expect(updateButton).toBeTruthy();

    fireEvent.click(updateButton);

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith('host_key_respond', {
        promptId: 'prompt-changed',
        accept: true,
      });
    });
  });
});
