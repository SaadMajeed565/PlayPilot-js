import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { Page } from 'playwright';
import { loginSessionManager } from './server.js';

interface BrowserStreamSession {
  sessionId: string;
  page: Page;
  ws: WebSocket;
  isActive: boolean;
  intervalId?: NodeJS.Timeout;
}

const activeStreams = new Map<string, BrowserStreamSession>();

/**
 * Find the login page in a session
 */
function findLoginPage(session: { context: any; loginUrl?: string; loginPage?: Page }): Page | null {
  // First, try to use the stored loginPage reference
  if (session.loginPage) {
    try {
      if (!session.loginPage.isClosed()) {
        return session.loginPage;
      }
    } catch {
      // Page might be closed, continue to find it
    }
  }

  const pages = session.context.pages();
  if (pages.length === 0) {
    return null;
  }

  if (!session.loginUrl) {
    return pages[0];
  }

  try {
    const loginUrl = new URL(session.loginUrl);
    const loginHostname = loginUrl.hostname;
    const loginPathname = loginUrl.pathname;
    
    // Find page that matches the login URL
    for (const page of pages) {
      try {
        if (page.isClosed()) continue;
        
        const pageUrl = page.url();
        if (pageUrl && pageUrl !== 'about:blank') {
          const pageUrlObj = new URL(pageUrl);
          if (pageUrlObj.hostname === loginHostname && 
              pageUrlObj.pathname === loginPathname) {
            return page;
          }
        }
      } catch {
        continue;
      }
    }

    // Fallback: find page with same hostname
    for (const page of pages) {
      try {
        if (page.isClosed()) continue;
        
        const pageUrl = page.url();
        if (pageUrl && pageUrl !== 'about:blank') {
          const pageUrlObj = new URL(pageUrl);
          if (pageUrlObj.hostname === loginHostname) {
            return page;
          }
        }
      } catch {
        continue;
      }
    }
  } catch {
    // If loginUrl is invalid, fall back to first page
  }

  // Fallback: return first non-closed page
  for (const page of pages) {
    try {
      if (!page.isClosed()) {
        return page;
      }
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Start streaming browser screenshots to WebSocket client
 */
async function startStreaming(sessionId: string, ws: WebSocket): Promise<void> {
  console.log(`Starting browser stream for session: ${sessionId}`);
  
  const session = loginSessionManager.getSession(sessionId);
  if (!session) {
    console.error(`Session not found: ${sessionId}`);
    ws.close(1008, 'Session not found');
    return;
  }

  const page = findLoginPage(session);
  if (!page) {
    console.error(`Login page not found for session: ${sessionId}`);
    ws.close(1008, 'Login page not found');
    return;
  }

  const pageUrl = page.url();
  console.log(`Found login page for session: ${sessionId}, URL: ${pageUrl}`);
  
  // Wait for page to be ready and check if it has content
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 });
    const hasContent = await page.evaluate(() => {
      return document.body && document.body.innerHTML.trim().length > 0;
    });
    console.log(`Page has content: ${hasContent}`);
    
    if (!hasContent) {
      console.warn('Page appears to be empty, waiting a bit more...');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch (error) {
    console.warn('Error checking page content:', error);
  }

  const streamSession: BrowserStreamSession = {
    sessionId,
    page,
    ws,
    isActive: true,
  };

  activeStreams.set(sessionId, streamSession);

  // Send screenshots at regular intervals
  const sendFrame = async () => {
    if (!streamSession.isActive) return;

    try {
      // Re-fetch session and page on each frame to get the latest references
      // This ensures we use the new tab after reload
      const currentSession = loginSessionManager.getSession(sessionId);
      if (!currentSession) {
        console.error('Session not found, stopping stream');
        streamSession.isActive = false;
        ws.close(1008, 'Session not found');
        return;
      }
      
      const currentPage = findLoginPage(currentSession);
      if (!currentPage) {
        console.error('Login page not found, stopping stream');
        streamSession.isActive = false;
        ws.close(1008, 'Login page not found');
        return;
      }
      
      // Update the cached page reference
      streamSession.page = currentPage;
      
      // Ensure page is ready
      if (currentPage.isClosed()) {
        console.error('Page is closed, stopping stream');
        streamSession.isActive = false;
        return;
      }

      // Wait for stable rendering - multiple strategies for accuracy
      await Promise.all([
        // Wait for layout stability
        currentPage.evaluate(() => {
          return new Promise<void>(resolve => {
            // Wait for multiple animation frames to ensure all rendering is complete
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                  resolve();
                });
              });
            });
          });
        }).catch(() => {}),
        
        // Wait for fonts to load if possible
        currentPage.evaluate(() => {
          return document.fonts ? document.fonts.ready.then(() => undefined) : Promise.resolve();
        }).catch(() => {}),
        
        // Small delay to ensure all paints are complete
        new Promise(resolve => setTimeout(resolve, 16)), // ~1 frame at 60fps
      ]);

      // Ensure page is in a stable state before screenshot
      await currentPage.waitForLoadState('networkidle', { timeout: 500 }).catch(() => {
        // Ignore if networkidle timeout - page might still be loading assets
      });

      const screenshot = await currentPage.screenshot({
        type: 'png',
        fullPage: false,
        timeout: 3000,
        // Capture at exact viewport size for accuracy
        clip: undefined, // Let Playwright use full viewport
      });

      // Check if screenshot is valid (not empty/white)
      if (screenshot.length < 1000) {
        console.warn('Screenshot seems too small, might be empty:', screenshot.length);
        // Still send it, but log warning
      }

      // Send binary frame
      if (streamSession.isActive && ws.readyState === WebSocket.OPEN) {
        ws.send(screenshot);
      } else {
        console.warn('WebSocket not open, readyState:', ws.readyState);
      }
    } catch (error) {
      console.error('Screenshot error:', error);
      if (streamSession.isActive && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({
            type: 'error',
            message: error instanceof Error ? error.message : 'Screenshot failed',
          }));
        } catch (sendError) {
          console.error('Failed to send error message:', sendError);
        }
      }
    }

    if (streamSession.isActive) {
      streamSession.intervalId = setTimeout(sendFrame, 50); // 20 FPS for smooth experience
    }
  };

  // Start streaming
  sendFrame();

  // Handle WebSocket close
  ws.on('close', () => {
    streamSession.isActive = false;
    if (streamSession.intervalId) {
      clearTimeout(streamSession.intervalId);
    }
    activeStreams.delete(sessionId);
  });

  // Handle WebSocket errors
  ws.on('error', () => {
    streamSession.isActive = false;
    if (streamSession.intervalId) {
      clearTimeout(streamSession.intervalId);
    }
    activeStreams.delete(sessionId);
  });
}

/**
 * Initialize WebSocket server for browser streaming
 */
export function initBrowserStreamServer(server: Server): void {
  const wss = new WebSocketServer({
    server,
    path: '/api/browser-stream',
  });

  wss.on('connection', (ws: WebSocket, req) => {
    console.log('New WebSocket connection attempt');
    
    // Extract sessionId from query params
    const url = new URL(req.url || '', `http://${req.headers.host || 'localhost:3000'}`);
    const sessionId = url.searchParams.get('sessionId');

    console.log('WebSocket connection - sessionId:', sessionId);

    if (!sessionId) {
      console.error('WebSocket connection rejected: Session ID required');
      ws.close(1008, 'Session ID required');
      return;
    }

    startStreaming(sessionId, ws).catch((error) => {
      console.error('Failed to start browser stream:', error);
      ws.close(1011, 'Failed to start stream');
    });
  });

  wss.on('error', (error) => {
    console.error('WebSocket server error:', error);
  });

  console.log('✓ Browser WebSocket stream server initialized at /api/browser-stream');
}

/**
 * Stop streaming for a session
 */
export function stopStreaming(sessionId: string): void {
  const stream = activeStreams.get(sessionId);
  if (stream) {
    stream.isActive = false;
    if (stream.intervalId) {
      clearTimeout(stream.intervalId);
    }
    if (stream.ws.readyState === WebSocket.OPEN) {
      stream.ws.close();
    }
    activeStreams.delete(sessionId);
  }
}

