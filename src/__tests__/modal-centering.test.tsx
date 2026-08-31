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

function expectViewportCentered(positioner: Element | null, content: Element | null) {
  expect(positioner).not.toBeNull();
  expect(content).not.toBeNull();

  const positionerClass = positioner?.getAttribute('class') ?? '';
  expect(positionerClass).toContain('fixed');
  expect(positionerClass).toContain('inset-0');
  expect(positionerClass).toContain('items-center');
  expect(positionerClass).toContain('justify-center');
  expect(positionerClass).toContain('p-4');

  const contentClass = content?.getAttribute('class') ?? '';
  expect(contentClass).toContain('max-h-[calc(100vh-2rem)]');
  expect(contentClass).toContain('overflow-y-auto');
  expect(contentClass).toContain('max-w-[calc(100vw-2rem)]');
  expect(contentClass).not.toContain('fixed');
  expect(contentClass).not.toContain('inset-0');
  expect(contentClass).not.toContain('translate-x-[-50%]');
  expect(contentClass).not.toContain('translate-y-[-50%]');
}

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

    expectViewportCentered(
      document.querySelector('[data-slot="dialog-positioner"]'),
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

    expectViewportCentered(
      document.querySelector('[data-slot="alert-dialog-positioner"]'),
      document.querySelector('[data-slot="alert-dialog-content"]'),
    );
  });
});
