import { useCallback, useState } from 'react';

/**
 * Mount each force-mounted tab panel only after its first activation, then keep
 * it mounted so panel-local state survives later tab switches.
 */
export function useLazyTabs(initial: string) {
  const [active, setActive] = useState(initial);
  const [mounted, setMounted] = useState<ReadonlySet<string>>(() => new Set([initial]));

  const select = useCallback((value: string) => {
    setActive(value);
    setMounted(prev => (prev.has(value) ? prev : new Set(prev).add(value)));
  }, []);

  return { active, select, mounted };
}
