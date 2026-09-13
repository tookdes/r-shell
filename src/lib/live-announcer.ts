/** Screen-reader announcements for tab reordering. */
let region: HTMLElement | null = null;

function ensureRegion(): HTMLElement {
  if (region?.isConnected) return region;
  region = document.createElement('div');
  region.setAttribute('role', 'status');
  region.setAttribute('aria-live', 'polite');
  region.className = 'sr-only';
  document.body.appendChild(region);
  return region;
}

export function announce(message: string): void {
  const el = ensureRegion();
  el.textContent = '';
  window.requestAnimationFrame(() => {
    el.textContent = message;
  });
}
