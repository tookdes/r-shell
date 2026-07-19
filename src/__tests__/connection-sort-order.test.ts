/**
 * Connection tree ordering and manual reorder.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ConnectionStorageManager,
  compareConnectionTreeItems,
} from '@/lib/connection-storage';

const FOLDERS_KEY = 'r-shell-connection-folders';

function seedFolderTree() {
  localStorage.setItem(
    FOLDERS_KEY,
    JSON.stringify([
      { id: 'root', name: 'All Connections', path: 'All Connections', createdAt: '2020-01-01T00:00:00.000Z' },
      {
        id: 'work',
        name: 'Work',
        path: 'All Connections/Work',
        parentPath: 'All Connections',
        createdAt: '2020-01-01T00:00:00.000Z',
      },
    ]),
  );
}

function saveNamed(name: string, folder = 'All Connections/Work', sortOrder?: number) {
  return ConnectionStorageManager.saveConnection({
    name,
    host: `${name}.example.com`,
    port: 22,
    username: 'root',
    protocol: 'SSH',
    folder,
    sortOrder,
  });
}

describe('connection sort order', () => {
  beforeEach(() => {
    localStorage.clear();
    seedFolderTree();
  });

  it('compares sortOrder before name', () => {
    expect(
      compareConnectionTreeItems(
        { name: 'zeta', sortOrder: 0 },
        { name: 'alpha', sortOrder: 1 },
      ),
    ).toBeLessThan(0);
    expect(
      compareConnectionTreeItems({ name: 'beta' }, { name: 'alpha' }),
    ).toBeGreaterThan(0);
  });

  it('assigns increasing sortOrder when saving connections', () => {
    const first = saveNamed('charlie');
    const second = saveNamed('alpha');
    const third = saveNamed('bravo');

    expect(first.sortOrder).toBe(0);
    expect(second.sortOrder).toBe(1);
    expect(third.sortOrder).toBe(2);
  });

  it('builds the tree using manual order instead of creation name order', () => {
    saveNamed('charlie', 'All Connections/Work', 2);
    saveNamed('alpha', 'All Connections/Work', 0);
    saveNamed('bravo', 'All Connections/Work', 1);

    const tree = ConnectionStorageManager.buildConnectionTree();
    const work = tree[0].children?.find((node) => node.name === 'Work');
    const names = work?.children
      ?.filter((node) => node.type === 'connection')
      .map((node) => node.name);

    expect(names).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('reorders a connection before another sibling', () => {
    const charlie = saveNamed('charlie');
    const alpha = saveNamed('alpha');
    const bravo = saveNamed('bravo');

    expect(
      ConnectionStorageManager.placeConnection(bravo.id, 'All Connections/Work', alpha.id),
    ).toBe(true);

    const ordered = ConnectionStorageManager.getConnectionsByFolder('All Connections/Work')
      .sort(compareConnectionTreeItems)
      .map((connection) => connection.name);

    expect(ordered).toEqual(['charlie', 'bravo', 'alpha']);
    expect(ConnectionStorageManager.getConnection(charlie.id)?.sortOrder).toBe(0);
    expect(ConnectionStorageManager.getConnection(bravo.id)?.sortOrder).toBe(1);
    expect(ConnectionStorageManager.getConnection(alpha.id)?.sortOrder).toBe(2);
  });

  it('moves a connection into another folder at the end', () => {
    const home = saveNamed('home', 'All Connections', 0);
    saveNamed('remote', 'All Connections/Work', 0);

    expect(ConnectionStorageManager.placeConnection(home.id, 'All Connections/Work', null)).toBe(true);

    const ordered = ConnectionStorageManager.getConnectionsByFolder('All Connections/Work')
      .sort(compareConnectionTreeItems)
      .map((connection) => connection.name);

    expect(ordered).toEqual(['remote', 'home']);
    expect(ConnectionStorageManager.getConnection(home.id)?.folder).toBe('All Connections/Work');
  });

  it('sorts a folder alphabetically and persists the order', () => {
    saveNamed('charlie');
    saveNamed('alpha');
    saveNamed('bravo');

    expect(ConnectionStorageManager.sortConnectionsInFolderByName('All Connections/Work')).toBe(true);

    const ordered = ConnectionStorageManager.getConnectionsByFolder('All Connections/Work')
      .sort(compareConnectionTreeItems)
      .map((connection) => connection.name);

    expect(ordered).toEqual(['alpha', 'bravo', 'charlie']);
  });
});

  it('sorts an empty folder without failing', () => {
    expect(ConnectionStorageManager.sortConnectionsInFolderByName('All Connections/Work')).toBe(true);
  });

  it('sorts child folders by name as well as connections', () => {
    ConnectionStorageManager.createFolder('Zed', 'All Connections');
    ConnectionStorageManager.createFolder('Alpha', 'All Connections');
    expect(ConnectionStorageManager.sortConnectionsInFolderByName('All Connections')).toBe(true);
    const tree = ConnectionStorageManager.buildConnectionTree();
    const rootKids = tree[0].children?.filter((n) => n.type === 'folder').map((n) => n.name) ?? [];
    // Personal/Work may also exist from seed — check Alpha before Zed among created
    const alphaIdx = rootKids.indexOf('Alpha');
    const zedIdx = rootKids.indexOf('Zed');
    expect(alphaIdx).toBeGreaterThanOrEqual(0);
    expect(zedIdx).toBeGreaterThanOrEqual(0);
    expect(alphaIdx).toBeLessThan(zedIdx);
  });
