import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';

interface HostKeyPromptPayload {
  prompt_id: string;
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
  changed: boolean;
}

/**
 * Global host-key confirmation dialog.
 *
 * Prompts are queued because several connections may start concurrently during
 * workspace restoration. Keeping only one prompt would orphan the earlier
 * backend request until its timeout expires.
 */
export function HostKeyDialog() {
  const { t } = useTranslation();
  const [prompts, setPrompts] = useState<HostKeyPromptPayload[]>([]);
  const respondingIds = useRef(new Set<string>());
  const prompt = prompts[0] ?? null;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<HostKeyPromptPayload>('host-key-prompt', (event) => {
      setPrompts((current) => {
        if (current.some((item) => item.prompt_id === event.payload.prompt_id)) {
          return current;
        }
        return [...current, event.payload];
      });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  const respond = async (accept: boolean) => {
    if (!prompt || respondingIds.current.has(prompt.prompt_id)) return;

    const promptId = prompt.prompt_id;
    respondingIds.current.add(promptId);
    setPrompts((current) => current.filter((item) => item.prompt_id !== promptId));

    try {
      await invoke('host_key_respond', { promptId, accept });
    } catch (error) {
      console.error('host_key_respond failed', error);
    } finally {
      respondingIds.current.delete(promptId);
    }
  };

  return (
    <AlertDialog
      open={!!prompt}
      onOpenChange={(open) => {
        if (!open) void respond(false);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {prompt?.changed ? t('hostKey.titleChanged') : t('hostKey.title')}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-sm text-muted-foreground">
              <p>{prompt?.changed ? t('hostKey.changedDesc') : t('hostKey.unknownDesc')}</p>
              {prompt && (
                <div className="space-y-1 rounded-md border bg-muted/40 p-3 font-mono text-xs text-foreground">
                  <div>
                    <span className="text-muted-foreground">{t('hostKey.host')}: </span>
                    {prompt.host}:{prompt.port}
                  </div>
                  <div>
                    <span className="text-muted-foreground">{t('hostKey.algorithm')}: </span>
                    {prompt.algorithm}
                  </div>
                  <div className="break-all">
                    <span className="text-muted-foreground">{t('hostKey.fingerprint')}: </span>
                    {prompt.fingerprint}
                  </div>
                </div>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('hostKey.reject')}</AlertDialogCancel>
          {!prompt?.changed && (
            <AlertDialogAction onClick={() => void respond(true)}>
              {t('hostKey.accept')}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
