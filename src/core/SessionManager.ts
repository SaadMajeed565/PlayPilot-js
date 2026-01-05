import { promises as fs } from 'fs';
import { join } from 'path';

export interface StorageState {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path?: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
  }>;
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
  // Metadata: Additional session data (geolocation, timezone, etc.)
  metadata?: {
    geolocation?: {
      latitude: number;
      longitude: number;
      capturedAt?: number; // Timestamp when location was captured
    };
    timezoneId?: string;
    userAgent?: string;
  };
}

export class SessionManager {
  private sessionsDir: string;

  constructor(sessionsDir: string = './data/sessions') {
    this.sessionsDir = sessionsDir;
    this.ensureSessionsDir();
  }

  private async ensureSessionsDir(): Promise<void> {
    try {
      await fs.mkdir(this.sessionsDir, { recursive: true });
    } catch {
      // Ignore errors
    }
  }

  async saveSession(siteId: string, storageState: StorageState): Promise<void> {
    const filePath = join(this.sessionsDir, `${siteId}.json`);
    await fs.writeFile(filePath, JSON.stringify(storageState, null, 2), 'utf-8');
  }

  async loadSession(siteId: string): Promise<StorageState | null> {
    try {
      const filePath = join(this.sessionsDir, `${siteId}.json`);
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content) as StorageState;
    } catch {
      return null;
    }
  }

  async deleteSession(siteId: string): Promise<boolean> {
    try {
      const filePath = join(this.sessionsDir, `${siteId}.json`);
      await fs.unlink(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async listSessions(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.sessionsDir);
      return files.filter(file => file.endsWith('.json')).map(file => file.replace('.json', ''));
    } catch {
      return [];
    }
  }
}

