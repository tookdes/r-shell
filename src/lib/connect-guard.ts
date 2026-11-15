const connectInFlight = new Set<string>();

export function beginConnect(id: string): boolean {
  if (connectInFlight.has(id)) return false;
  connectInFlight.add(id);
  return true;
}

export function endConnect(id: string): void {
  connectInFlight.delete(id);
}

let duplicateCounter = 0;

export function nextDuplicateId(connectionId: string): string {
  return `${connectionId}-dup-${Date.now()}-${duplicateCounter++}`;
}
