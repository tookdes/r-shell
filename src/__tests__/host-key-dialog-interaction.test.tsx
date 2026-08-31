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

    expect(screen.getByRole('button', { name: 'hostKey.reject' })).toBeVisible();
    const trustButton = screen.getByRole('button', { name: 'hostKey.accept' });
    expect(trustButton).toBeVisible();

    const content = document.querySelector('[data-slot="alert-dialog-content"]');
    const positioner = document.querySelector('[data-slot="alert-dialog-positioner"]');
    expect(positioner?.getAttribute('class')).toContain('items-center');
    expect(positioner?.getAttribute('class')).toContain('justify-center');
    expect(content?.getAttribute('class')).toContain('max-h-[calc(100vh-2rem)]');

    fireEvent.click(trustButton);

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith('host_key_respond', {
        promptId: 'prompt-1',
        accept: true,
      });
    });
  });
});
