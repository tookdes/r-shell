/**
 * Connection Storage Management
 * Handles saving, loading, and managing SSH connections with hierarchical organization
 */

export interface ConnectionData {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  protocol: string;
  folder?: string; // Path to parent folder (e.g., 'All Connections/Work')
  profileId?: string; // Link to connection profile if created from one
  /** Manual order within the parent folder. Lower values appear first. */
  sortOrder?: number;
  createdAt: string;
  lastConnected?: string;
  favorite?: boolean;
  color?: string;
  tags?: string[];
  description?: string;
  // Authentication details
  authMethod?: 'password' | 'publickey' | 'keyboard-interactive' | 'anonymous';
  password?: string; // Note: In production, this should be encrypted
  privateKeyPath?: string;
  /** Inline PEM private key (encrypted at rest when savePasswords is on). */
  privateKeyData?: string;
  passphrase?: string;
  // FTP-specific
  ftpsEnabled?: boolean;
  // Proxy
  proxyType?: 'none' | 'http' | 'socks4' | 'socks5';
  proxyHost?: string;
  proxyPort?: number;
  proxyUsername?: string;
  proxyPassword?: string;
  // SSH-specific advanced
  compression?: boolean;
  keepAlive?: boolean;
  keepAliveInterval?: number;
  serverAliveCountMax?: number;
  // RDP-specific
  domain?: string;
  rdpResolution?: string;
  // VNC-specific
  vncColorDepth?: string;
  vncPassword?: string;
  /** Commands run after SSH PTY is ready (newline-separated). */
  startupCommand?: string;
}

export interface ConnectionFolder {
  id: string;
  name: string;
  path: string; // Full path (e.g., 'All Connections/Work/Production')
  parentPath?: string; // Parent folder path
  /** Manual order among sibling folders. Lower values appear first. */
  sortOrder?: number;
  createdAt: string;
}


function shouldPersistPasswords(): boolean {
  try {
    const raw = localStorage.getItem('sshClientSettings');
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { savePasswords?: unknown };
    // Secrets are persisted only after the user explicitly enables the setting.
    return parsed.savePasswords === true;
  } catch {
    return false;
  }
}

function maybeStripSecrets<T extends {
  password?: string;
  passphrase?: string;
  vncPassword?: string;
  privateKeyData?: string;
  proxyPassword?: string;
}>(connection: T): T {
  if (shouldPersistPasswords()) {
    return connection;
  }
  return {
    ...connection,
    password: undefined,
    passphrase: undefined,
    vncPassword: undefined,
    privateKeyData: undefined,
    proxyPassword: undefined,
  };
}

const CONNECTIONS_STORAGE_KEY = 'r-shell-connections';
const FOLDERS_STORAGE_KEY = 'r-shell-connection-folders';

// Legacy keys for migration
const LEGACY_SESSIONS_STORAGE_KEY = 'r-shell-sessions';
const LEGACY_FOLDERS_STORAGE_KEY = 'r-shell-session-folders';

/** Stable ordering: explicit sortOrder first, then case-insensitive name. */
export function compareConnectionTreeItems(
  left: { sortOrder?: number; name: string; createdAt?: string },
  right: { sortOrder?: number; name: string; createdAt?: string },
): number {
  const leftOrder = left.sortOrder ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = right.sortOrder ?? Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }

  const nameCompare = left.name.localeCompare(right.name, undefined, {
    sensitivity: 'base',
    numeric: true,
  });
  if (nameCompare !== 0) {
    return nameCompare;
  }

  const leftCreated = left.createdAt ?? '';
  const rightCreated = right.createdAt ?? '';
  return leftCreated.localeCompare(rightCreated);
}

export class ConnectionStorageManager {
  /**
   * Migrate data from old session storage to new connection storage
   */
  private static migrateFromSessionStorage(): void {
    try {
      // Check if migration is needed
      const hasNewData = localStorage.getItem(CONNECTIONS_STORAGE_KEY);
      const hasLegacyData = localStorage.getItem(LEGACY_SESSIONS_STORAGE_KEY);
      
      if (!hasNewData && hasLegacyData) {
        console.log('[Migration] Migrating session data to connection data...');
        
        // Migrate sessions to connections
        const legacySessions = localStorage.getItem(LEGACY_SESSIONS_STORAGE_KEY);
        if (legacySessions) {
          const sessions = JSON.parse(legacySessions);
          // Update folder paths from "All Sessions" to "All Connections"
          const connections = sessions.map((session: any) => ({
            ...session,
            folder: session.folder?.replace(/All Sessions/g, 'All Connections')
          }));
          localStorage.setItem(CONNECTIONS_STORAGE_KEY, JSON.stringify(connections));
          console.log(`[Migration] Migrated ${connections.length} sessions to connections`);
        }
        
        // Migrate folders
        const legacyFolders = localStorage.getItem(LEGACY_FOLDERS_STORAGE_KEY);
        if (legacyFolders) {
          const folders = JSON.parse(legacyFolders);
          // Update folder names and paths
          const connectionFolders = folders.map((folder: any) => ({
            ...folder,
            name: folder.name.replace(/All Sessions/g, 'All Connections'),
            path: folder.path.replace(/All Sessions/g, 'All Connections'),
            parentPath: folder.parentPath?.replace(/All Sessions/g, 'All Connections')
          }));
          localStorage.setItem(FOLDERS_STORAGE_KEY, JSON.stringify(connectionFolders));
          console.log(`[Migration] Migrated ${connectionFolders.length} session folders to connection folders`);
        }
        
        console.log('[Migration] Migration completed successfully');
      }
    } catch (error) {
      console.error('[Migration] Failed to migrate session data:', error);
    }
  }

  /**
   * Initialize default folder structure if not exists
   */
  static initialize(): void {
    // First, try to migrate legacy data
    this.migrateFromSessionStorage();
    
    const folders = this.getFolders();
    if (folders.length === 0) {
      // Create default folder structure
      this.createFolder('All Connections', undefined);
      this.createFolder('Personal', 'All Connections');
      this.createFolder('Work', 'All Connections');
    }
  }

  /**
   * Get all saved connections
   */
  static getConnections(): ConnectionData[] {
    try {
      const stored = localStorage.getItem(CONNECTIONS_STORAGE_KEY);
      if (!stored) return [];
      return JSON.parse(stored) as ConnectionData[];
    } catch (error) {
      console.error('Failed to load connections:', error);
      return [];
    }
  }

  /**
   * Get a single connection by ID
   */
  static getConnection(id: string): ConnectionData | undefined {
    const connections = this.getConnections();
    return connections.find(c => c.id === id);
  }

  /** Remove all persisted authentication material from existing connections. */
  static stripStoredSecrets(): void {
    const connections = this.getConnections().map((connection) => ({
      ...connection,
      password: undefined,
      passphrase: undefined,
      vncPassword: undefined,
      privateKeyData: undefined,
      proxyPassword: undefined,
    }));
    localStorage.setItem(CONNECTIONS_STORAGE_KEY, JSON.stringify(connections));
  }

  /**
   * Get connections by folder path
   */
  static getConnectionsByFolder(folderPath: string): ConnectionData[] {
    const connections = this.getConnections();
    return connections.filter(c => c.folder === folderPath);
  }

  /**
   * Get all connections in a folder and its subfolders (recursive)
   */
  static getConnectionsByFolderRecursive(folderPath: string): ConnectionData[] {
    const connections = this.getConnections();
    return connections.filter(c => c.folder === folderPath || c.folder?.startsWith(folderPath + '/'));
  }

  /**
   * Get all subfolders recursively
   */
  static getSubfoldersRecursive(folderPath: string): ConnectionFolder[] {
    const folders = this.getFolders();
    return folders.filter(f => f.path.startsWith(folderPath + '/'));
  }

  /**
   * Save a new connection
   */
  static saveConnection(connection: Omit<ConnectionData, 'id' | 'createdAt'>): ConnectionData {
    const connections = this.getConnections();
    const folderPath = connection.folder || 'All Connections';
    const sortOrder =
      connection.sortOrder ?? this.getNextConnectionSortOrder(folderPath, connections);

    const newConnection: ConnectionData = maybeStripSecrets({
      ...connection,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      folder: folderPath,
      sortOrder,
    });

    connections.push(newConnection);
    localStorage.setItem(CONNECTIONS_STORAGE_KEY, JSON.stringify(connections));

    return newConnection;
  }

  /**
   * Save a new connection with a specific ID
   * This is used to ensure the connection ID matches the tab ID for proper tracking
   */
  static saveConnectionWithId(id: string, connection: Omit<ConnectionData, 'id' | 'createdAt'>): ConnectionData {
    const connections = this.getConnections();

    // Check if connection with this ID already exists
    const existingIndex = connections.findIndex(c => c.id === id);
    const folderPath = connection.folder || 'All Connections';
    const existingConnection = existingIndex !== -1 ? connections[existingIndex] : undefined;
    const sortOrder =
      connection.sortOrder ??
      existingConnection?.sortOrder ??
      this.getNextConnectionSortOrder(folderPath, connections);

    const newConnection: ConnectionData = maybeStripSecrets({
      ...connection,
      id,
      createdAt: new Date().toISOString(),
      lastConnected: new Date().toISOString(),
      folder: folderPath,
      sortOrder,
    });

    if (existingIndex !== -1) {
      // Update existing connection
      connections[existingIndex] = newConnection;
    } else {
      // Add new connection
      connections.push(newConnection);
    }

    localStorage.setItem(CONNECTIONS_STORAGE_KEY, JSON.stringify(connections));

    return newConnection;
  }

  /**
   * Update an existing connection
   */
  static updateConnection(id: string, updates: Partial<Omit<ConnectionData, 'id' | 'createdAt'>>): ConnectionData | null {
    const connections = this.getConnections();
    const index = connections.findIndex(c => c.id === id);

    if (index === -1) return null;

    connections[index] = maybeStripSecrets({
      ...connections[index],
      ...updates,
    });

    localStorage.setItem(CONNECTIONS_STORAGE_KEY, JSON.stringify(connections));
    return connections[index];
  }

  /**
   * Update last connected timestamp
   */
  static updateLastConnected(id: string): void {
    this.updateConnection(id, {
      lastConnected: new Date().toISOString(),
    });
  }

  /**
   * Delete a connection
   */
  static deleteConnection(id: string): boolean {
    const connections = this.getConnections();
    const filtered = connections.filter(c => c.id !== id);

    if (filtered.length === connections.length) return false;

    localStorage.setItem(CONNECTIONS_STORAGE_KEY, JSON.stringify(filtered));
    return true;
  }

  /**
   * Move connection to a different folder
   */
  static moveConnection(connectionId: string, newFolderPath: string): boolean {
    const connections = this.getConnections();
    const connectionIndex = connections.findIndex((connection) => connection.id === connectionId);
    if (connectionIndex === -1) {
      return false;
    }

    const currentFolder = connections[connectionIndex].folder || 'All Connections';
    if (currentFolder === newFolderPath) {
      return true;
    }

    connections[connectionIndex] = {
      ...connections[connectionIndex],
      folder: newFolderPath,
      sortOrder: this.getNextConnectionSortOrder(newFolderPath, connections, connectionId),
    };

    localStorage.setItem(CONNECTIONS_STORAGE_KEY, JSON.stringify(connections));
    return true;
  }

  /**
   * Place a connection in a folder at a specific position.
   * When `beforeConnectionId` is null, append to the end of the folder.
   */
  static placeConnection(
    connectionId: string,
    targetFolderPath: string,
    beforeConnectionId: string | null = null,
  ): boolean {
    const connections = this.getConnections();
    const movingConnection = connections.find((connection) => connection.id === connectionId);
    if (!movingConnection) {
      return false;
    }

    if (beforeConnectionId === connectionId) {
      return true;
    }

    const orderedInFolder = connections
      .filter(
        (connection) =>
          connection.id !== connectionId &&
          (connection.folder || 'All Connections') === targetFolderPath,
      )
      .sort(compareConnectionTreeItems);

    const insertIndex =
      beforeConnectionId === null
        ? orderedInFolder.length
        : orderedInFolder.findIndex((connection) => connection.id === beforeConnectionId);

    if (beforeConnectionId !== null && insertIndex === -1) {
      return false;
    }

    const nextOrder = [...orderedInFolder];
    nextOrder.splice(insertIndex === -1 ? nextOrder.length : insertIndex, 0, {
      ...movingConnection,
      folder: targetFolderPath,
    });

    const orderById = new Map(nextOrder.map((connection, index) => [connection.id, index]));
    const updatedConnections = connections.map((connection) => {
      const nextSortOrder = orderById.get(connection.id);
      if (nextSortOrder === undefined) {
        return connection;
      }
      return {
        ...connection,
        folder: targetFolderPath,
        sortOrder: nextSortOrder,
      };
    });

    localStorage.setItem(CONNECTIONS_STORAGE_KEY, JSON.stringify(updatedConnections));
    return true;
  }

  /**
   * Sort direct children of a folder alphabetically and persist the new order.
   * - Connections whose `folder` equals `folderPath`
   * - Immediate subfolders whose `parentPath` equals `folderPath`
   * Returns true when the folder exists (even if it had nothing to reorder).
   */
  static sortConnectionsInFolderByName(folderPath: string): boolean {
    const folders = this.getFolders();
    const folderExists =
      folderPath === 'All Connections' || folders.some((folder) => folder.path === folderPath);
    if (!folderExists) {
      return false;
    }

    const connections = this.getConnections();
    const orderedConnections = connections
      .filter((connection) => (connection.folder || 'All Connections') === folderPath)
      .sort((left, right) =>
        left.name.localeCompare(right.name, undefined, {
          sensitivity: 'base',
          numeric: true,
        }),
      );

    const orderedSubfolders = folders
      .filter((folder) => folder.parentPath === folderPath)
      .sort((left, right) =>
        left.name.localeCompare(right.name, undefined, {
          sensitivity: 'base',
          numeric: true,
        }),
      );

    const connectionOrderById = new Map(
      orderedConnections.map((connection, index) => [connection.id, index]),
    );
    const folderOrderById = new Map(
      orderedSubfolders.map((folder, index) => [folder.id, index]),
    );

    const updatedConnections = connections.map((connection) => {
      const nextSortOrder = connectionOrderById.get(connection.id);
      if (nextSortOrder === undefined) {
        return connection;
      }
      return { ...connection, sortOrder: nextSortOrder };
    });

    const updatedFolders = folders.map((folder) => {
      const nextSortOrder = folderOrderById.get(folder.id);
      if (nextSortOrder === undefined) {
        return folder;
      }
      return { ...folder, sortOrder: nextSortOrder };
    });

    localStorage.setItem(CONNECTIONS_STORAGE_KEY, JSON.stringify(updatedConnections));
    localStorage.setItem(FOLDERS_STORAGE_KEY, JSON.stringify(updatedFolders));
    return true;
  }

  /**
   * Reorder an item (folder or connection) to a specific position among same-type
   * siblings in the target parent. Also handles moving between parents.
   * The tree renders folders first, then connections — each group ordered by sortOrder.
   * @param itemId - ID of the folder or connection
   * @param itemType - 'folder' or 'connection'
   * @param targetParentPath - Parent folder path for the new position (undefined = root level)
   * @param newIndex - Position among same-type siblings in the target parent
   */
  static reorderItem(
    itemId: string,
    itemType: 'folder' | 'connection',
    targetParentPath: string | undefined,
    newIndex: number
  ): boolean {
    const folders = this.getFolders();
    const connections = this.getConnections();

    // Find the dragged item
    const folderIndex = itemType === 'folder' ? folders.findIndex(f => f.id === itemId) : -1;
    const connectionIndex = itemType === 'connection' ? connections.findIndex(c => c.id === itemId) : -1;

    if (folderIndex === -1 && connectionIndex === -1) return false;

    // Determine current parent path
    const currentParentPath = itemType === 'folder'
      ? folders[folderIndex].parentPath
      : connections[connectionIndex].folder || 'All Connections';

    const sameParent = currentParentPath === targetParentPath;

    // Get same-type siblings at a parent, sorted by sortOrder, optionally excluding an item
    const getTypeSiblings = (parentPath: string | undefined, type: 'folder' | 'connection', excludeId?: string) => {
      if (type === 'folder') {
        return folders
          .filter(f => f.parentPath === parentPath && f.id !== excludeId)
          .sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity));
      }
      return connections
        .filter(c => (c.folder || 'All Connections') === (parentPath ?? 'All Connections') && c.id !== excludeId)
        .sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity));
    };

    // Re-assign sortOrder 0..n for a list of items
    const reindex = (items: { id: string }[], type: 'folder' | 'connection') => {
      items.forEach((entry, index) => {
        if (type === 'folder') {
          const f = folders.find(fo => fo.id === entry.id);
          if (f) f.sortOrder = index;
        } else {
          const c = connections.find(co => co.id === entry.id);
          if (c) c.sortOrder = index;
        }
      });
    };

    // Build target sibling list (excluding dragged item if same parent) and insert
    const siblings = getTypeSiblings(targetParentPath, itemType, sameParent ? itemId : undefined);
    const clampedIndex = Math.max(0, Math.min(newIndex, siblings.length));
    const ordered: { id: string }[] = [...siblings];
    ordered.splice(clampedIndex, 0, { id: itemId });
    reindex(ordered, itemType);

    // Update the dragged item's parent reference
    if (itemType === 'folder') {
      const folderName = folders[folderIndex].name;
      folders[folderIndex].parentPath = targetParentPath;
      folders[folderIndex].path = targetParentPath ? `${targetParentPath}/${folderName}` : folderName;
    } else {
      connections[connectionIndex].folder = targetParentPath ?? 'All Connections';
    }

    // If moved between parents, re-index the source parent's same-type group
    if (!sameParent) {
      const sourceSiblings = getTypeSiblings(currentParentPath, itemType, itemId);
      reindex(sourceSiblings, itemType);
    }

    localStorage.setItem(FOLDERS_STORAGE_KEY, JSON.stringify(folders));
    localStorage.setItem(CONNECTIONS_STORAGE_KEY, JSON.stringify(connections));
    return true;
  }

  /**
   * Move a folder (with all subfolders and nested connections) to a new parent.
   * @param folderPath - Current full path of the folder to move
   * @param newParentPath - New parent folder path (undefined = root level)
   * @returns true if the move succeeded
   */
  static moveFolderRecursive(folderPath: string, newParentPath: string | undefined): boolean {
    // Cannot move root folder
    if (folderPath === 'All Connections') return false;

    // Cannot move into itself or own subtree
    if (newParentPath === folderPath || newParentPath?.startsWith(folderPath + '/')) return false;

    const folders = this.getFolders();
    const connections = this.getConnections();

    const folder = folders.find(f => f.path === folderPath);
    if (!folder) return false;

    const newPath = newParentPath ? `${newParentPath}/${folder.name}` : folder.name;

    // No-op if already in the target parent
    if (folder.parentPath === newParentPath) return true;

    // Rewrite paths for all subfolders
    for (const f of folders) {
      if (f.path === folderPath) {
        f.path = newPath;
        f.parentPath = newParentPath;
      } else if (f.path.startsWith(folderPath + '/')) {
        f.path = newPath + f.path.substring(folderPath.length);
        if (f.parentPath === folderPath) {
          f.parentPath = newPath;
        } else if (f.parentPath?.startsWith(folderPath + '/')) {
          f.parentPath = newPath + f.parentPath.substring(folderPath.length);
        }
      }
    }

    // Rewrite folder references for all nested connections
    for (const c of connections) {
      if (c.folder === folderPath) {
        c.folder = newPath;
      } else if (c.folder?.startsWith(folderPath + '/')) {
        c.folder = newPath + c.folder.substring(folderPath.length);
      }
    }

    localStorage.setItem(FOLDERS_STORAGE_KEY, JSON.stringify(folders));
    localStorage.setItem(CONNECTIONS_STORAGE_KEY, JSON.stringify(connections));
    return true;
  }

  /**
   * Get all folders
   */
  static getFolders(): ConnectionFolder[] {
    try {
      const stored = localStorage.getItem(FOLDERS_STORAGE_KEY);
      if (!stored) return [];
      return JSON.parse(stored) as ConnectionFolder[];
    } catch (error) {
      console.error('Failed to load folders:', error);
      return [];
    }
  }

  /**
   * Create a new folder
   */
  static createFolder(name: string, parentPath?: string): ConnectionFolder {
    const folders = this.getFolders();

    const path = parentPath ? `${parentPath}/${name}` : name;

    // Check if folder already exists
    const existing = folders.find(f => f.path === path);
    if (existing) return existing;

    const newFolder: ConnectionFolder = {
      id: crypto.randomUUID(),
      name,
      path,
      parentPath,
      sortOrder: this.getNextFolderSortOrder(parentPath, folders),
      createdAt: new Date().toISOString(),
    };

    folders.push(newFolder);
    localStorage.setItem(FOLDERS_STORAGE_KEY, JSON.stringify(folders));

    return newFolder;
  }

  /**
   * Delete a folder and all its connections
   */
  static deleteFolder(path: string, deleteSubfolders: boolean = false): boolean {
    // Don't allow deleting root folder
    if (path === 'All Connections') return false;

    const folders = this.getFolders();
    const connections = this.getConnections();

    // Filter out the folder and optionally subfolders
    const filteredFolders = folders.filter(f => {
      if (f.path === path) return false;
      if (deleteSubfolders && f.path.startsWith(path + '/')) return false;
      return true;
    });

    // Filter out connections in the folder and optionally subfolders
    const filteredConnections = connections.filter(c => {
      if (c.folder === path) return false;
      if (deleteSubfolders && c.folder?.startsWith(path + '/')) return false;
      return true;
    });

    if (filteredFolders.length === folders.length) return false;

    localStorage.setItem(FOLDERS_STORAGE_KEY, JSON.stringify(filteredFolders));
    localStorage.setItem(CONNECTIONS_STORAGE_KEY, JSON.stringify(filteredConnections));

    return true;
  }

  /**
   * Get subfolders of a parent path
   */
  static getSubfolders(parentPath: string): ConnectionFolder[] {
    const folders = this.getFolders();
    return folders.filter(f => f.parentPath === parentPath);
  }

  /**
   * Get all valid folders that are part of the tree hierarchy
   * This excludes orphaned folders that don't have a valid parent chain
   */
  static getValidFolders(): ConnectionFolder[] {
    const allFolders = this.getFolders();
    const validPaths = new Set<string>();

    // Recursively collect valid folder paths starting from root
    const collectValidPaths = (parentPath?: string) => {
      const children = allFolders.filter(f => f.parentPath === parentPath);
      for (const child of children) {
        validPaths.add(child.path);
        collectValidPaths(child.path);
      }
    };

    collectValidPaths(undefined);

    return allFolders.filter(f => validPaths.has(f.path));
  }

  /**
   * Build hierarchical connection tree
   */
  static buildConnectionTree(activeConnections: Set<string> = new Set()): ConnectionTreeNode[] {
    const folders = this.getFolders();
    const connections = this.getConnections();

    // Build folder hierarchy
    const buildFolderTree = (parentPath?: string): ConnectionTreeNode[] => {
      const result: ConnectionTreeNode[] = [];

      // Get direct subfolders
      const subfolders = folders
        .filter((folder) => folder.parentPath === parentPath)
        .sort(compareConnectionTreeItems);

      for (const folder of subfolders) {
        const folderNode: ConnectionTreeNode = {
          id: folder.id,
          name: folder.name,
          type: 'folder',
          path: folder.path,
          isExpanded: true,
          children: [
            ...buildFolderTree(folder.path),
            ...connections
              .filter(c => c.folder === folder.path)
              .sort(compareConnectionTreeItems)
              .map(c => ({
                id: c.id,
                name: c.name,
                type: 'connection' as const,
                protocol: c.protocol,
                host: c.host,
                username: c.username,
                port: c.port,
                profileId: c.profileId,
                lastConnected: c.lastConnected,
                isConnected: activeConnections.has(c.id),
                favorite: c.favorite,
                color: c.color,
                tags: c.tags,
              }))
          ],
        };
        result.push(folderNode);
      }

      return result;
    };

    // Start from root
    return buildFolderTree(undefined);
  }

  /**
   * Get favorite connections
   */
  static getFavorites(): ConnectionData[] {
    return this.getConnections().filter(c => c.favorite);
  }

  /**
   * Get recent connections (sorted by lastConnected)
   */
  static getRecentConnections(limit: number = 10): ConnectionData[] {
    const connections = this.getConnections();
    return connections
      .filter(c => c.lastConnected)
      .sort((a, b) => {
        const dateA = a.lastConnected ? new Date(a.lastConnected).getTime() : 0;
        const dateB = b.lastConnected ? new Date(b.lastConnected).getTime() : 0;
        return dateB - dateA;
      })
      .slice(0, limit);
  }

  /**
   * Export connections as JSON
   */
  static exportConnections(): string {
    const connections = this.getConnections();
    const folders = this.getFolders();
    return JSON.stringify({ connections, folders }, null, 2);
  }

  /**
   * Import connections from JSON
   */
  static importConnections(json: string, merge: boolean = false): number {
    try {
      const imported = JSON.parse(json) as {
        connections: ConnectionData[];
        folders?: ConnectionFolder[];
      };

      if (!imported.connections || !Array.isArray(imported.connections)) {
        throw new Error('Invalid JSON format');
      }

      const connections = merge ? this.getConnections() : [];
      const folders = merge ? this.getFolders() : [];

      // Import folders with new IDs
      if (imported.folders) {
        imported.folders.forEach(folder => {
          if (!folders.find(f => f.path === folder.path)) {
            folders.push({
              ...folder,
              id: crypto.randomUUID(),
              createdAt: new Date().toISOString(),
            });
          }
        });
      }

      // Import connections with new IDs
      imported.connections.forEach(connection => {
        connections.push({
          ...connection,
          id: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
        });
      });

      localStorage.setItem(CONNECTIONS_STORAGE_KEY, JSON.stringify(connections));
      localStorage.setItem(FOLDERS_STORAGE_KEY, JSON.stringify(folders));

      return imported.connections.length;
    } catch (error) {
      console.error('Failed to import connections:', error);
      throw error;
    }
  }

  /**
   * Clear all connections and folders (use with caution!)
   */
  static clearAll(): void {
    localStorage.removeItem(CONNECTIONS_STORAGE_KEY);
    localStorage.removeItem(FOLDERS_STORAGE_KEY);
    this.initialize();
  }

  /**
   * Move a folder (and all nested folders/connections) under a new parent path.
   */
  static moveFolder(sourcePath: string, targetParentPath: string): boolean {
    if (sourcePath === 'All Connections') {
      return false;
    }
    if (targetParentPath === sourcePath || targetParentPath.startsWith(sourcePath + '/')) {
      return false;
    }

    const folders = this.getFolders();
    const connections = this.getConnections();
    const sourceFolder = folders.find((folder) => folder.path === sourcePath);
    if (!sourceFolder) {
      return false;
    }

    const folderName = sourceFolder.name;
    const newPath = `${targetParentPath}/${folderName}`;
    if (folders.some((folder) => folder.path === newPath)) {
      return false;
    }

    const rewritePath = (path: string): string => {
      if (path === sourcePath) {
        return newPath;
      }
      if (path.startsWith(sourcePath + '/')) {
        return newPath + path.slice(sourcePath.length);
      }
      return path;
    };

    const updatedFolders = folders.map((folder) => {
      if (folder.path !== sourcePath && !folder.path.startsWith(sourcePath + '/')) {
        return folder;
      }
      const nextPath = rewritePath(folder.path);
      const nextParent =
        folder.path === sourcePath
          ? targetParentPath
          : folder.parentPath
            ? rewritePath(folder.parentPath)
            : folder.parentPath;
      return {
        ...folder,
        path: nextPath,
        parentPath: nextParent,
      };
    });

    const updatedConnections = connections.map((connection) => {
      if (!connection.folder) {
        return connection;
      }
      if (connection.folder !== sourcePath && !connection.folder.startsWith(sourcePath + '/')) {
        return connection;
      }
      return {
        ...connection,
        folder: rewritePath(connection.folder),
      };
    });

    localStorage.setItem(FOLDERS_STORAGE_KEY, JSON.stringify(updatedFolders));
    localStorage.setItem(CONNECTIONS_STORAGE_KEY, JSON.stringify(updatedConnections));
    return true;
  }

    private static getNextConnectionSortOrder(
    folderPath: string,
    connections: ConnectionData[] = this.getConnections(),
    excludeConnectionId?: string,
  ): number {
    const sortOrders = connections
      .filter(
        (connection) =>
          connection.id !== excludeConnectionId &&
          (connection.folder || 'All Connections') === folderPath,
      )
      .map((connection) => connection.sortOrder)
      .filter((sortOrder): sortOrder is number => typeof sortOrder === 'number');

    if (sortOrders.length === 0) {
      return 0;
    }

    return Math.max(...sortOrders) + 1;
  }

  private static getNextFolderSortOrder(
    parentPath: string | undefined,
    folders: ConnectionFolder[] = this.getFolders(),
  ): number {
    const sortOrders = folders
      .filter((folder) => folder.parentPath === parentPath)
      .map((folder) => folder.sortOrder)
      .filter((sortOrder): sortOrder is number => typeof sortOrder === 'number');

    if (sortOrders.length === 0) {
      return 0;
    }

    return Math.max(...sortOrders) + 1;
  }
}

/**
 * Connection tree node structure for UI rendering
 */
export interface ConnectionTreeNode {
  id: string;
  name: string;
  type: 'folder' | 'connection';
  path?: string;
  protocol?: string;
  host?: string;
  port?: number;
  username?: string;
  profileId?: string;
  lastConnected?: string;
  isConnected?: boolean;
  isExpanded?: boolean;
  favorite?: boolean;
  color?: string;
  tags?: string[];
  children?: ConnectionTreeNode[];
}

/**
 * Active Connections Manager
 * Tracks currently open tabs for connection persistence
 */
const ACTIVE_CONNECTIONS_KEY = 'r-shell-active-connections';
const LEGACY_ACTIVE_SESSIONS_KEY = 'r-shell-active-sessions';

export interface ActiveConnectionState {
  tabId: string;
  connectionId: string;
  order: number;
  originalConnectionId?: string; // For duplicated tabs, reference to the original connection
  tabType?: 'terminal' | 'file-browser' | 'desktop' | 'editor'; // Tab type for SFTP/FTP, RDP/VNC, SSH, or remote file editing
  protocol?: string; // Protocol used (SSH, SFTP, FTP)
}

export class ActiveConnectionsManager {
  /**
   * Migrate active sessions to active connections
   */
  private static migrateFromActiveSessions(): void {
    try {
      const hasNewData = localStorage.getItem(ACTIVE_CONNECTIONS_KEY);
      const hasLegacyData = localStorage.getItem(LEGACY_ACTIVE_SESSIONS_KEY);
      
      if (!hasNewData && hasLegacyData) {
        console.log('[Migration] Migrating active sessions to active connections...');
        const legacySessions = JSON.parse(hasLegacyData);
        
        // Convert old ActiveSessionState to new ActiveConnectionState
        const activeConnections = legacySessions.map((session: any) => ({
          tabId: session.tabId,
          connectionId: session.sessionId,
          order: session.order,
          originalConnectionId: session.originalSessionId
        }));
        
        localStorage.setItem(ACTIVE_CONNECTIONS_KEY, JSON.stringify(activeConnections));
        console.log(`[Migration] Migrated ${activeConnections.length} active sessions to active connections`);
      }
    } catch (error) {
      console.error('[Migration] Failed to migrate active sessions:', error);
    }
  }

  /**
   * Get active connection states
   */
  static getActiveConnections(): ActiveConnectionState[] {
    try {
      // Try migration first
      this.migrateFromActiveSessions();
      
      const stored = localStorage.getItem(ACTIVE_CONNECTIONS_KEY);
      if (!stored) return [];
      return JSON.parse(stored) as ActiveConnectionState[];
    } catch (error) {
      console.error('Failed to load active connections:', error);
      return [];
    }
  }

  /**
   * Save active connection states
   */
  static saveActiveConnections(connections: ActiveConnectionState[]): void {
    localStorage.setItem(ACTIVE_CONNECTIONS_KEY, JSON.stringify(connections));
  }

  /**
   * Clear active connections
   */
  static clearActiveConnections(): void {
    localStorage.removeItem(ACTIVE_CONNECTIONS_KEY);
  }
}

// Initialize on module load
ConnectionStorageManager.initialize();
