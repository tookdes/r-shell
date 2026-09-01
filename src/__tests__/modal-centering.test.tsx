import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../components/ui/dialog';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '../components/ui/alert-dialog';

function expectViewportContainedAndCentered(
  positioner: Element | null,
  viewport: Element | null,
  content: Element | null,
) {
  expect(positioner).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(content).not.toBeNull();

  const positionerClass = positioner?.getAttribute('class') ?? '';
  expect(positionerClass).toContain('fixed');
  expect(positionerClass).toContain('inset-0');
  expect(positionerClass).toContain('items-center');
  expect(positionerClass).toContain('justify-center');
  expect(positionerClass).toContain('overflow-hidden');
  expect(positionerClass).toContain('p-4');

  const viewportClass = viewport?.getAttribute('class') ?? '';
  expect(viewportClass).toContain('max-h-[calc(100dvh-2rem)]');
  expect(viewportClass).toContain('max-w-[calc(100dvw-2rem)]');
  expect(viewportClass).toContain('overflow-auto');
  expect(viewportClass).toContain('overscroll-contain');

  const contentClass = content?.getAttribute('class') ?? '';
  expect(contentClass).toContain('max-h-[calc(100dvh-2rem)]');
  expect(contentClass).toContain('overflow-y-auto');
  expect(contentClass).toContain('max-w-[calc(100dvw-2rem)]');
  expect(contentClass).toContain('!relative');
  expect(contentClass).toContain('!inset-auto');
  expect(contentClass).toContain('!m-0');
  expect(contentClass).toContain('!translate-x-0');
  expect(contentClass).toContain('!translate-y-0');
}

const legacyPositioning =
  'fixed !inset-0 !m-auto top-[50%] left-[50%] -translate-x-1/2 -translate-y-1/2';

describe('modal viewport positioning', () => {
  it('keeps regular dialogs centered and scrollable inside the viewport', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Dialog title</DialogTitle>
          <DialogDescription>Dialog description</DialogDescription>
        </DialogContent>
      </Dialog>,
    );

    expectViewportContainedAndCentered(
      document.querySelector('[data-slot="dialog-positioner"]'),
      document.querySelector('[data-slot="dialog-viewport"]'),
      document.querySelector('[data-slot="dialog-content"]'),
    );
  });

  it('keeps alert dialogs centered and scrollable inside the viewport', () => {
    render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogTitle>Alert title</AlertDialogTitle>
          <AlertDialogDescription>Alert description</AlertDialogDescription>
        </AlertDialogContent>
      </AlertDialog>,
    );

    expectViewportContainedAndCentered(
      document.querySelector('[data-slot="alert-dialog-positioner"]'),
      document.querySelector('[data-slot="alert-dialog-viewport"]'),
      document.querySelector('[data-slot="alert-dialog-content"]'),
    );
  });

  it('ignores legacy business-level positioning overrides', () => {
    render(
      <>
        <Dialog open>
          <DialogContent className={legacyPositioning}>
            <DialogTitle>Legacy dialog</DialogTitle>
            <DialogDescription>Legacy positioning must not move this dialog.</DialogDescription>
          </DialogContent>
        </Dialog>
        <AlertDialog open>
          <AlertDialogContent className={legacyPositioning}>
            <AlertDialogTitle>Legacy alert</AlertDialogTitle>
            <AlertDialogDescription>Legacy positioning must not move this alert.</AlertDialogDescription>
          </AlertDialogContent>
        </AlertDialog>
      </>,
    );

    expectViewportContainedAndCentered(
      document.querySelector('[data-slot="dialog-positioner"]'),
      document.querySelector('[data-slot="dialog-viewport"]'),
      document.querySelector('[data-slot="dialog-content"]'),
    );
    expectViewportContainedAndCentered(
      document.querySelector('[data-slot="alert-dialog-positioner"]'),
      document.querySelector('[data-slot="alert-dialog-viewport"]'),
      document.querySelector('[data-slot="alert-dialog-content"]'),
    );
  });
});
