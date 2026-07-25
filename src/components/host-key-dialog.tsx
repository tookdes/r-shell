import { useEffect, useState } from 'react';
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
 * Listens for backend `host-key-prompt` events emitted mid-ssh_connect.
 */
export function HostKeyDialog() {
  const { t } = useTranslation();
  const [prompt, setPrompt] = useState<HostKeyPromptPayload | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<HostKeyPromptPayload>('host-key-prompt', (event) => {
      setPrompt(event.payload);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  const respond = async (accept: boolean) => {
    if (!prompt) return;
    const promptId = prompt.prompt_id;
    setPrompt(null);
    try {
      await invoke('host_key_respond', { promptId, accept });
    } catch (error) {
      console.error('host_key_respond failed', error);
    }
  };

  return (
    <AlertDialog open={!!prompt} onOpenChange={(open) => { if (!open) void respond(false); }}>
      <AlertDialogContent className="!inset-0 !m-auto max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {prompt?.changed ? t('hostKey.titleChanged') : t('hostKey.title')}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-sm text-muted-foreground">
              <p>{prompt?.changed ? t('hostKey.changedDesc') : t('hostKey.unknownDesc')}</p>
              {prompt && (
                <div className="rounded-md border bg-muted/40 p-3 font-mono text-xs text-foreground space-y-1">
                  <div><span className="text-muted-foreground">{t('hostKey.host')}: </span>{prompt.host}:{prompt.port}</div>
                  <div><span className="text-muted-foreground">{t('hostKey.algorithm')}: </span>{prompt.algorithm}</div>
                  <div className="break-all"><span className="text-muted-foreground">{t('hostKey.fingerprint')}: </span>{prompt.fingerprint}</div>
                </div>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => void respond(false)}>
            {t('hostKey.reject')}
          </AlertDialogCancel>
          <AlertDialogAction onClick={() => void respond(true)}>
            {prompt?.changed ? t('hostKey.acceptReplace') : t('hostKey.accept')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
