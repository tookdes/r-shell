export const COLLAPSED_FOLDERS_STORAGE_KEY = 'r-shell-collapsed-folders';

export interface ExpandableNode {
  id: string;
  type: 'folder' | 'connection';
  isExpanded?: boolean;
  children?: ExpandableNode[];
}

export function loadCollapsedFolderIds(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_FOLDERS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === 'string'));
  } catch {
    return new Set();
  }
}

export function saveCollapsedFolderIds(ids: Iterable<string>): void {
  try {
    localStorage.setItem(COLLAPSED_FOLDERS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch (error) {
    console.warn('Could not persist folder expansion state:', error);
  }
}

export function applyCollapsedState<T extends ExpandableNode>(nodes: T[], collapsed: Set<string>): T[] {
  return nodes.map((node) => {
    if (node.type !== 'folder') return node;
    const next: T = { ...node, isExpanded: !collapsed.has(node.id) };
    if (node.children) next.children = applyCollapsedState(node.children, collapsed);
    return next;
  });
}

export function collectCollapsedFolderIds(nodes: ExpandableNode[]): string[] {
  const ids: string[] = [];
  const walk = (list: ExpandableNode[]) => {
    for (const node of list) {
      if (node.type !== 'folder') continue;
      if (node.isExpanded === false) ids.push(node.id);
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return ids;
}
