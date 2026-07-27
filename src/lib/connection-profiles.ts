/**
 * Connection Profile Management
 *
 * Profiles contain connection metadata only. Authentication secrets belong to
 * the encrypted connection store or the in-memory session cache and are never
 * persisted in this legacy profile store.
 */

export interface ConnectionProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: 'password' | 'key';
  /** Legacy input only. It is stripped before profiles are read or written. */
  password?: string;
  privateKey?: string;
  createdAt: string;
  updatedAt: string;
  favorite?: boolean;
  color?: string;
  tags?: string[];
}

const STORAGE_KEY = 'r-shell-connection-profiles';

function withoutPassword(profile: ConnectionProfile): ConnectionProfile {
  const { password: _password, ...safeProfile } = profile;
  return safeProfile;
}

function sanitizeProfiles(profiles: ConnectionProfile[]): ConnectionProfile[] {
  return profiles.map(withoutPassword);
}

export class ConnectionProfileManager {
  /** Get all saved connection profiles and scrub any legacy plaintext password. */
  static getProfiles(): ConnectionProfile[] {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (!stored) return [];

      const parsed = JSON.parse(stored) as unknown;
      if (!Array.isArray(parsed)) return [];

      const profiles = sanitizeProfiles(parsed as ConnectionProfile[]);
      const sanitized = JSON.stringify(profiles);
      if (sanitized !== stored) {
        localStorage.setItem(STORAGE_KEY, sanitized);
      }
      return profiles;
    } catch (error) {
      console.error('Failed to load connection profiles:', error);
      return [];
    }
  }

  static getProfile(id: string): ConnectionProfile | undefined {
    return this.getProfiles().find((profile) => profile.id === id);
  }

  static saveProfile(
    profile: Omit<ConnectionProfile, 'id' | 'createdAt' | 'updatedAt'>,
  ): ConnectionProfile {
    const profiles = this.getProfiles();
    const newProfile = withoutPassword({
      ...profile,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    profiles.push(newProfile);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
    return newProfile;
  }

  static updateProfile(
    id: string,
    updates: Partial<Omit<ConnectionProfile, 'id' | 'createdAt'>>,
  ): ConnectionProfile | null {
    const profiles = this.getProfiles();
    const index = profiles.findIndex((profile) => profile.id === id);
    if (index === -1) return null;

    profiles[index] = withoutPassword({
      ...profiles[index],
      ...updates,
      updatedAt: new Date().toISOString(),
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
    return profiles[index];
  }

  static deleteProfile(id: string): boolean {
    const profiles = this.getProfiles();
    const filtered = profiles.filter((profile) => profile.id !== id);
    if (filtered.length === profiles.length) return false;

    localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
    return true;
  }

  static exportProfiles(): string {
    return JSON.stringify(this.getProfiles(), null, 2);
  }

  static importProfiles(json: string, merge = false): number {
    try {
      const imported = JSON.parse(json) as unknown;
      if (!Array.isArray(imported)) {
        throw new Error('Invalid JSON format');
      }

      const profiles = merge ? this.getProfiles() : [];
      for (const profile of imported as ConnectionProfile[]) {
        profiles.push(
          withoutPassword({
            ...profile,
            id: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
        );
      }

      localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
      return imported.length;
    } catch (error) {
      console.error('Failed to import profiles:', error);
      throw error;
    }
  }

  static getFavorites(): ConnectionProfile[] {
    return this.getProfiles().filter((profile) => profile.favorite);
  }

  static getProfilesByTag(tag: string): ConnectionProfile[] {
    return this.getProfiles().filter((profile) => profile.tags?.includes(tag));
  }

  static getAllTags(): string[] {
    const tags = new Set<string>();
    for (const profile of this.getProfiles()) {
      profile.tags?.forEach((tag) => tags.add(tag));
    }
    return Array.from(tags).sort();
  }

  static clearAll(): void {
    localStorage.removeItem(STORAGE_KEY);
  }
}
