import type { Browser, BrowserContext, Page } from 'playwright';
import type { StorageState } from './SessionManager.js';

export interface LoginSession {
  sessionId: string;
  siteId: string;
  browser: Browser;
  context: BrowserContext;
  status: 'waiting' | 'logged_in' | 'captured' | 'cancelled';
  createdAt: number;
  loginUrl?: string;
  loginPage?: Page; // Store reference to the actual login page
}

export class LoginSessionManager {
  private activeSessions: Map<string, LoginSession> = new Map();

  createSession(sessionId: string, siteId: string, browser: Browser, context: BrowserContext, loginUrl?: string, loginPage?: Page): void {
    this.activeSessions.set(sessionId, {
      sessionId,
      siteId,
      browser,
      context,
      status: 'waiting',
      createdAt: Date.now(),
      loginUrl,
      loginPage,
    });
  }

  getSession(sessionId: string): LoginSession | undefined {
    return this.activeSessions.get(sessionId);
  }

  async captureSession(sessionId: string): Promise<{ storageState: StorageState; cookies: StorageState['cookies'] } | null> {
    const session = this.activeSessions.get(sessionId);
    if (!session || session.status === 'captured') {
      return null;
    }

    try {
      const storageState = await session.context.storageState() as StorageState;
      session.status = 'captured';
      return {
        storageState,
        cookies: storageState.cookies || [],
      };
    } catch {
      return null;
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    try {
      await session.browser.close();
    } catch {
      // Ignore errors
    }

    this.activeSessions.delete(sessionId);
  }

  updateStatus(sessionId: string, status: LoginSession['status']): void {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.status = status;
    }
  }

  getAllSessions(): LoginSession[] {
    return Array.from(this.activeSessions.values());
  }

  getSessionsBySite(siteId: string): LoginSession[] {
    return Array.from(this.activeSessions.values()).filter(s => s.siteId === siteId);
  }
}

