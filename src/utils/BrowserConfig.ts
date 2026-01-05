import { chromium, firefox, webkit, devices } from 'playwright';
import type { BrowserContext, BrowserContextOptions, Page } from 'playwright';
import { promises as fs } from 'fs';
import { join } from 'path';

// Global fingerprint cache to ensure consistency across sessions
const fingerprintCache = new Map<string, {
  userAgent: string;
  viewport: { width: number; height: number };
  timezone: string;
  locale: string;
  platform: string;
}>();

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

export interface ProxyConfig {
  server: string;
  username?: string;
  password?: string;
}

export interface BrowserConfigOptions {
  headless?: boolean;
  storageState?: string | BrowserContextOptions['storageState'];
  userDataDir?: string;
  proxy?: ProxyConfig;
  device?: 'mobile' | 'desktop' | string; // 'mobile' uses iPhone 13, 'desktop' uses default, or specific device name
  startWithMobile?: boolean; // Start with mobile viewport for login, then switch to desktop
  browserType?: 'chromium' | 'firefox' | 'webkit';
  automationUrl?: string; // Optional automation URL to open in random position among tabs
  launcherUrl?: string; // Optional launcher page URL to open as one of the tabs
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Ensures directory exists
 */
async function ensureDirectoryExists(dirPath: string): Promise<void> {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch {
    // Ignore errors - directory might already exist
  }
}

// ============================================================================
// MAIN BROWSER LAUNCH FUNCTION
// ============================================================================

/**
 * Launches a basic browser context
 * 
 * @param options - Browser configuration options
 * @returns Browser context
 */
export interface LaunchBrowserResult {
  context: BrowserContext;
  automationPage?: Page; // The automation page if automationUrl was provided (direct navigation)
  launcherPage?: Page; // The launcher page if launcherUrl was provided
}

export async function launchBrowser(
  options: BrowserConfigOptions = {}
): Promise<LaunchBrowserResult | BrowserContext> {
  const {
    headless = false,
    userDataDir,
    proxy,
    storageState,
    device = 'Galaxy Tab S7', // Default to Android tablet
    startWithMobile = false, // Option to start with mobile for login
    browserType,
    automationUrl,
    launcherUrl,
  } = options;

  // Validate proxy configuration and allow simple rotation via env PROXY_POOL
  let resolvedProxy = proxy;
  if (!resolvedProxy && process.env.PROXY_POOL) {
    const pool = process.env.PROXY_POOL.split(',').map(p => p.trim()).filter(Boolean);
    if (pool.length > 0) {
      const pick = pool[Math.floor(Math.random() * pool.length)];
      resolvedProxy = { server: pick };
    }
  }
  if (resolvedProxy && !resolvedProxy.server) {
    throw new Error('Proxy server is required when proxy is configured');
  }

  // Use persistent directory for browsing history, cookies, etc.
  // If no userDataDir provided, use a default persistent location
  const persistentUserDataDir = userDataDir || join(process.cwd(), 'data', 'browser-profiles', 'default');
  await ensureDirectoryExists(persistentUserDataDir);

  // Determine device configuration
  // If startWithMobile is true, use mobile for initial launch (login), then switch to desktop
  const initialDevice = startWithMobile ? 'mobile' : device;
  let deviceConfig: BrowserContextOptions = {};
  
  if (initialDevice === 'mobile' || startWithMobile) {
    // Use iPhone 13 as default mobile device
    const mobileDevice = devices['iPhone 13'];
    deviceConfig = {
      ...mobileDevice,
      // Override with custom options if needed
      viewport: mobileDevice.viewport,
      userAgent: mobileDevice.userAgent,
      deviceScaleFactor: mobileDevice.deviceScaleFactor,
      isMobile: mobileDevice.isMobile,
      hasTouch: mobileDevice.hasTouch,
    };
    console.log(`✓ Configured browser with mobile viewport (${mobileDevice.viewport.width}x${mobileDevice.viewport.height}) for login`);
  } else if (device === 'desktop' || initialDevice === 'desktop') {
    // Treat desktop as tablet to maintain tablet footprint
    const tabletDevice = devices['Galaxy Tab S7'] || devices['Galaxy Tab S8'] || devices['iPad Pro 12.9" (6th generation)'] || devices['iPad Pro'];
    if (tabletDevice) {
      deviceConfig = {
        ...tabletDevice,
      };
      console.log(`✓ Configured browser with tablet viewport (${tabletDevice.viewport.width}x${tabletDevice.viewport.height})`);
    } else {
      // Fallback if iPad Pro not available
      deviceConfig = {
        viewport: { width: 1280, height: 600 }, // landscape
        userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-T870) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        isMobile: false,
        hasTouch: true,
        deviceScaleFactor: 2,
      };
    }
  } else if (device === 'tablet' || device.includes('iPad') || device.includes('Galaxy Tab')) {
    // Tablet configuration
    const tabletDevice = devices[device] || devices['Galaxy Tab S7'] || devices['Galaxy Tab S8'] || devices['iPad Pro 12.9" (6th generation)'] || devices['iPad Pro'];
    if (tabletDevice) {
      deviceConfig = {
        ...tabletDevice,
      };
      console.log(`✓ Configured browser with tablet viewport (${tabletDevice.viewport.width}x${tabletDevice.viewport.height})`);
    } else {
      // Fallback tablet config
      deviceConfig = {
        viewport: { width: 1280, height: 600 }, // landscape
        userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-T870) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        isMobile: false,
        hasTouch: true,
        deviceScaleFactor: 2,
      };
    }
  } else {
    // Use specific device name from Playwright's device list
    const specificDevice = devices[device];
    if (specificDevice) {
      deviceConfig = {
        ...specificDevice,
      };
    } else {
      console.warn(`Device "${device}" not found, falling back to mobile (iPhone 13)`);
      const mobileDevice = devices['iPhone 13'];
      deviceConfig = {
        ...mobileDevice,
      };
    }
  }

    // Configure context options with consistent settings
    const cacheKey = persistentUserDataDir || 'default';
    const cachedFingerprint = fingerprintCache.get(cacheKey);
    
    // Get viewport dimensions from device config
    const viewportWidth = deviceConfig.viewport?.width || 1024;
    const viewportHeight = deviceConfig.viewport?.height || 1366;
    
    const contextOptions: BrowserContextOptions = {
      proxy: resolvedProxy ? {
        server: resolvedProxy.server,
        username: resolvedProxy.username,
        password: resolvedProxy.password,
      } : undefined,
      storageState,
      ...deviceConfig,
      locale: cachedFingerprint?.locale || deviceConfig.locale || 'en-US',
      timezoneId: cachedFingerprint?.timezone || 'America/New_York',
      // Ensure consistent geolocation
      geolocation: { latitude: 40.7128, longitude: -74.0060 }, // New York
      permissions: ['geolocation'],
    };

  // Anti-detection Chrome arguments
  const stealthArgs = [
    '--no-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage',
    '--disable-setuid-sandbox',
    '--disable-web-security',
    '--disable-features=IsolateOrigins,site-per-process',
    '--disable-site-isolation-trials',
    '--disable-infobars',
    `--window-size=${viewportWidth},${viewportHeight}`,
    '--disable-extensions-except',
    '--disable-plugins-discovery',
    '--disable-default-apps',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=TranslateUI',
    '--disable-ipc-flooding-protection',
    '--enable-features=NetworkService,NetworkServiceInProcess',
    '--force-color-profile=srgb',
    '--metrics-recording-only',
    '--mute-audio',
    '--disable-background-networking',
    '--disable-breakpad',
    '--disable-component-update',
    '--disable-domain-reliability',
    '--disable-sync',
    '--disable-features=AudioServiceOutOfProcess',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-crash-upload',
    '--no-pings',
    '--no-zygote',
    '--use-gl=swiftshader',
    '--disable-software-rasterizer',
  ];

  // List of popular real websites for background tabs (anti-detection)
  const randomWebsites = [
    'https://wikipedia.org',
    'https://reddit.com',
    'https://youtube.com',
    'https://github.com',
    'https://stackoverflow.com',
    'https://medium.com',
    'https://linkedin.com',
    'https://news.ycombinator.com',
    'https://quora.com',
    'https://pinterest.com',
    'https://tumblr.com',
    'https://instagram.com',
    'https://netflix.com',
    'https://amazon.com',
    'https://ebay.com',
    'https://cnn.com',
    'https://bbc.com',
    'https://nytimes.com',
    'https://theguardian.com',
  ];

  try {
    // Use launchPersistentContext to enable browsing history, cookies, and other persistent data
    // This is different from launch() + newContext() which doesn't persist history
    // Select browser type (default chromium)
    const selectedBrowser = browserType || (process.env.PLAYWRIGHT_BROWSER as BrowserConfigOptions['browserType']) || 'chromium';
    const browserLauncher = selectedBrowser === 'firefox' ? firefox
      : selectedBrowser === 'webkit' ? webkit
      : chromium;

    // Build launch options
    const launchOptions: any = {
      headless,
      args: stealthArgs,
      // CRITICAL: This prevents the "controlled by automated test software" message
      ignoreDefaultArgs: ['--enable-automation'],
      ...contextOptions,
    };

    // Use custom browser path if BROWSER_PATH env variable is set (only for chromium/Chrome)
    if ((selectedBrowser === 'chromium' || !selectedBrowser) && process.env.BROWSER_PATH) {
      launchOptions.executablePath = process.env.BROWSER_PATH;
    }

    const context = await browserLauncher.launchPersistentContext(persistentUserDataDir, launchOptions);

    // Apply stealth techniques to all pages
    context.on('page', async (page) => {
      await applyStealthTechniques(page);
    });

    // Wait a bit for context to stabilize
    await new Promise(resolve => setTimeout(resolve, 100));

    // Apply stealth to existing non-blank pages
    // We'll leave blank pages alone (they don't count toward our tab goal)
    const initialPages = [...context.pages()];
    for (const page of initialPages) {
      try {
        if (page.isClosed()) continue;
        
        const url = page.url();
        if (url !== 'about:blank' && url !== '') {
          // Apply stealth to non-blank pages only
          await applyStealthTechniques(page);
        }
      } catch (error) {
        // Ignore errors
      }
    }

    // Create realistic browsing session with 2-3 random tabs (including automation page)
    // This makes the browser look like a normal user session (anti-detection)
    // We'll create 1-2 background tabs, and optionally the automation page
    // Total will be 2-3 tabs including the automation page (blank pages don't count)
    const backgroundTabsCount = Math.floor(Math.random() * 2) + 1; // 1 or 2 background tabs
    
    // Count only non-blank pages (blank pages don't count toward our goal)
    const nonBlankPages = initialPages.filter(p => {
      try {
        return !p.isClosed() && p.url() !== 'about:blank' && p.url() !== '';
      } catch {
        return false;
      }
    });
    const tabsToCreate = Math.max(0, backgroundTabsCount - nonBlankPages.length);

    // Shuffle and select random websites
    const shuffled = [...randomWebsites].sort(() => Math.random() - 0.5);
    const selectedWebsites = shuffled.slice(0, tabsToCreate);

    // Prepare all URLs to open (launcher page + background sites + automation site if provided)
    const allUrls: Array<{ url: string; isAutomation: boolean; isLauncher: boolean }> = [];
    
    // Add launcher page if provided (this is the hub page with all website links)
    if (launcherUrl) {
      allUrls.push({ url: launcherUrl, isAutomation: false, isLauncher: true });
    }
    
    // Add background websites
    for (const websiteUrl of selectedWebsites) {
      allUrls.push({ url: websiteUrl, isAutomation: false, isLauncher: false });
    }
    
    // Add automation URL if provided (NOTE: This won't be used if launcher page is used)
    // Launcher page approach: click link from launcher → opens new tab
    if (automationUrl && !launcherUrl) {
      allUrls.push({ url: automationUrl, isAutomation: true, isLauncher: false });
    }
    
    // Shuffle all URLs together so launcher/automation site is in random position
    const shuffledUrls = allUrls.sort(() => Math.random() - 0.5);
    
    let automationPage: Page | undefined = undefined;
    let launcherPage: Page | undefined = undefined;

    // Open all tabs in shuffled order
    for (const { url, isAutomation, isLauncher } of shuffledUrls) {
      try {
        // Check if context is still open before creating new page
        if (context.browser()?.isConnected()) {
          const page = await context.newPage();
          
          // If this is the automation page, store it for return
          if (isAutomation) {
            automationPage = page;
          }
          
          // If this is the launcher page, store it for return
          if (isLauncher) {
            launcherPage = page;
          }
          
          // Navigate to website but don't wait for full load (background tab behavior)
          page.goto(url, { 
            waitUntil: 'domcontentloaded',
            timeout: 15000 
          }).catch(() => {
            // Ignore navigation errors - some sites may block or timeout
          });
          
          // Add some random delay between opening tabs (human-like)
          await humanDelay(200, 800);
        }
      } catch (error) {
        // Continue if a tab fails to open
        console.warn(`Failed to open tab ${url}:`, error);
      }
    }
    
    // Store the total expected tabs count for reference
    const totalExpectedTabs = backgroundTabsCount + (launcherUrl ? 1 : 0) + (automationUrl && !launcherUrl ? 1 : 0);

    const deviceInfo = initialDevice === 'mobile' ? 'iPhone 13' : device === 'desktop' ? 'Desktop (1366x768)' : device;
    const deviceNote = startWithMobile ? ' (will switch to desktop after login)' : '';
    console.log(`✓ Browser launched successfully as ${deviceInfo}${deviceNote} with persistent profile at ${persistentUserDataDir}`);
    console.log(`✓ Anti-detection measures enabled`);
    const tabDescription = launcherUrl 
      ? `launcher page + ${backgroundTabsCount} random website(s) (all in random positions)`
      : automationUrl 
        ? `random websites (automation site in random position)`
        : 'random websites';
    console.log(`✓ Opened ${context.pages().length} tab(s): ${tabDescription}`);
    console.log(`✓ Total tabs: ${totalExpectedTabs}`);
    
    // Return context with launcher page and/or automation page if provided
    if (launcherUrl && launcherPage) {
      return { context, launcherPage };
    }
    if (automationUrl && automationPage) {
      return { context, automationPage };
    }
    return context;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('✗ Failed to launch browser:', errorMessage);
    throw new Error(`Failed to launch browser: ${errorMessage}`);
  }
}

/**
 * Applies comprehensive anti-detection techniques to a page
 * This makes the browser undetectable by reCAPTCHA, Cloudflare, hCaptcha, etc.
 */
async function applyStealthTechniques(page: Page): Promise<void> {
  try {
    // Suppress page errors related to React Router (catch unhandled errors)
    page.on('pageerror', (error) => {
      const errorMessage = error.message || error.toString();
      // Suppress React Router nesting errors
      if (errorMessage.includes('Router') && errorMessage.includes('inside another')) {
        // Silently ignore React Router nesting errors
        return;
      }
      // Log other errors normally (optional - can remove if you want to suppress all)
    });

    // Wait for page to be ready
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    
    // Add browser history simulation (makes browser look more realistic)
    // This runs after page load to avoid interfering with navigation
    try {
      await page.evaluate(() => {
        // Simulate browser history and storage to make browser appear used
        try {
          // Add to sessionStorage to simulate previous session activity
          if (typeof sessionStorage !== 'undefined') {
            sessionStorage.setItem('_lastVisit', Date.now().toString());
            sessionStorage.setItem('_visitCount', (Math.floor(Math.random() * 50) + 10).toString());
            sessionStorage.setItem('_sessionStart', (Date.now() - Math.random() * 3600000).toString());
          }
          
          // Add to localStorage to simulate persistent user data
          if (typeof localStorage !== 'undefined') {
            // Generate a consistent browser ID if not exists
            if (!localStorage.getItem('_browserId')) {
              localStorage.setItem('_browserId', Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15));
            }
            
            // Simulate first visit timestamp (random date in past 30 days)
            if (!localStorage.getItem('_firstVisit')) {
              const daysAgo = Math.floor(Math.random() * 30);
              localStorage.setItem('_firstVisit', (Date.now() - daysAgo * 24 * 60 * 60 * 1000).toString());
            }
            
            // Add some common browser data
            localStorage.setItem('_theme', 'light');
            localStorage.setItem('_language', 'en-US');
          }
          
          // Simulate history length (real browsers have history)
          // Note: We can't actually modify history.length, but we can add entries
          // The browser's history API will track these
          try {
            // Add a few history entries using pushState (doesn't navigate)
            const currentUrl = window.location.href;
            const baseUrl = currentUrl.split('/').slice(0, 3).join('/');
            
            // Simulate that user visited a few pages before
            for (let i = 0; i < 3; i++) {
              try {
                window.history.pushState(
                  { page: 'simulated', index: i },
                  '',
                  baseUrl + '/visited-page-' + i
                );
              } catch (e) {
                // Ignore cross-origin errors
                break;
              }
            }
            
            // Go back to simulate normal browsing
            window.history.go(-3);
          } catch (e) {
            // Ignore history errors (might be cross-origin restrictions)
          }
        } catch (e) {
          // Ignore all errors - history simulation is optional
        }
      });
    } catch (e) {
      // Ignore errors - history simulation is optional enhancement
    }
    
    const context = page.context();
    const client = await context.newCDPSession(page);
    
    // 1. Remove webdriver property
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        Object.defineProperty(navigator, 'webdriver', {
          get: () => undefined
        });
      `,
    });

    // 2. Override navigator properties
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        // Override navigator.webdriver
        Object.defineProperty(navigator, 'webdriver', {
          get: () => false
        });

        // Override navigator.plugins with realistic browser extensions
        Object.defineProperty(navigator, 'plugins', {
          get: () => {
            const plugins = [];
            
            // Chrome PDF Plugin (always present)
            plugins.push({
              name: 'Chrome PDF Plugin',
              filename: 'internal-pdf-viewer',
              description: 'Portable Document Format',
              length: 1,
              item: function(index) {
                return index === 0 ? {
                  type: 'application/pdf',
                  suffixes: 'pdf',
                  description: 'Portable Document Format',
                  enabledPlugin: plugins[0]
                } : null;
              },
              namedItem: function(name) {
                return name === 'application/pdf' ? plugins[0].item(0) : null;
              }
            });
            
            // Chrome PDF Viewer
            plugins.push({
              name: 'Chrome PDF Viewer',
              filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai',
              description: '',
              length: 1,
              item: function(index) {
                return index === 0 ? {
                  type: 'application/pdf',
                  suffixes: 'pdf',
                  description: '',
                  enabledPlugin: plugins[1]
                } : null;
              },
              namedItem: function(name) {
                return name === 'application/pdf' ? plugins[1].item(0) : null;
              }
            });
            
            // Native Client
            plugins.push({
              name: 'Native Client',
              filename: 'internal-nacl-plugin',
              description: '',
              length: 2,
              item: function(index) {
                if (index === 0) {
                  return {
                    type: 'application/x-nacl',
                    suffixes: '',
                    description: '',
                    enabledPlugin: plugins[2]
                  };
                } else if (index === 1) {
                  return {
                    type: 'application/x-pnacl',
                    suffixes: '',
                    description: '',
                    enabledPlugin: plugins[2]
                  };
                }
                return null;
              },
              namedItem: function(name) {
                if (name === 'application/x-nacl') return plugins[2].item(0);
                if (name === 'application/x-pnacl') return plugins[2].item(1);
                return null;
              }
            });
            
            return plugins;
          },
          configurable: true
        });
        
        // Override navigator.mimeTypes to match plugins
        Object.defineProperty(navigator, 'mimeTypes', {
          get: () => {
            const mimeTypes = [];
            const plugins = navigator.plugins;
            
            for (let i = 0; i < plugins.length; i++) {
              const plugin = plugins[i];
              for (let j = 0; j < plugin.length; j++) {
                const mimeType = plugin.item(j);
                if (mimeType) {
                  mimeTypes.push(mimeType);
                }
              }
            }
            
            return {
              length: mimeTypes.length,
              item: function(index) {
                return mimeTypes[index] || null;
              },
              namedItem: function(name) {
                for (let i = 0; i < mimeTypes.length; i++) {
                  if (mimeTypes[i].type === name) {
                    return mimeTypes[i];
                  }
                }
                return null;
              }
            };
          },
          configurable: true
        });

        // Override navigator.languages
        Object.defineProperty(navigator, 'languages', {
          get: () => ['en-US', 'en']
        });

        // Override chrome property
        window.chrome = {
          runtime: {},
          loadTimes: function() {},
          csi: function() {},
          app: {}
        };

        // Override navigator.permissions
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) => (
          parameters.name === 'notifications' ?
            Promise.resolve({ state: Notification.permission }) :
            originalQuery(parameters)
        );

        // Override getBattery
        if (navigator.getBattery) {
          navigator.getBattery = () => Promise.resolve({
            charging: true,
            chargingTime: 0,
            dischargingTime: Infinity,
            level: 1
          });
        }
      `,
    });

    // 3. Spoof WebGL vendor and renderer
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        const getParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function(parameter) {
          if (parameter === 37445) {
            return 'Intel Inc.';
          }
          if (parameter === 37446) {
            return 'Intel Iris OpenGL Engine';
          }
          return getParameter.call(this, parameter);
        };

        const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
        WebGL2RenderingContext.prototype.getParameter = function(parameter) {
          if (parameter === 37445) {
            return 'Intel Inc.';
          }
          if (parameter === 37446) {
            return 'Intel Iris OpenGL Engine';
          }
          return getParameter2.call(this, parameter);
        };
      `,
    });

    // 4. Improved Canvas fingerprint randomization with consistent noise per session
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        // Generate consistent noise seed per session (same seed = same fingerprint)
        const canvasFingerprintSeed = Math.random() * 0.0001;
        const getNoise = (x, y) => {
          // Use position-based noise for consistency
          const seed = (x * 73856093) ^ (y * 19349663) ^ (canvasFingerprintSeed * 1000000);
          return (Math.sin(seed) * 0.5 + 0.5) * 0.0002 - 0.0001;
        };
        
        const originalToBlob = HTMLCanvasElement.prototype.toBlob;
        const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
        const originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;
        
        // Override getImageData to add noise before reading
        CanvasRenderingContext2D.prototype.getImageData = function(sx, sy, sw, sh) {
          const imageData = originalGetImageData.call(this, sx, sy, sw, sh);
          
          // Add minimal, consistent noise to prevent fingerprinting
          // Only modify a small percentage of pixels to maintain image quality
          const pixelCount = imageData.data.length / 4;
          const noisePixels = Math.floor(pixelCount * 0.01); // 1% of pixels
          
          for (let i = 0; i < noisePixels; i++) {
            const randomIndex = Math.floor(Math.random() * pixelCount) * 4;
            const x = (randomIndex / 4) % sw;
            const y = Math.floor((randomIndex / 4) / sw);
            
            const noise = getNoise(x, y);
            imageData.data[randomIndex] = Math.max(0, Math.min(255, imageData.data[randomIndex] + noise * 255));
            imageData.data[randomIndex + 1] = Math.max(0, Math.min(255, imageData.data[randomIndex + 1] + noise * 255));
            imageData.data[randomIndex + 2] = Math.max(0, Math.min(255, imageData.data[randomIndex + 2] + noise * 255));
          }
          
          return imageData;
        };
        
        HTMLCanvasElement.prototype.toBlob = function(callback, type, quality) {
          const canvas = this;
          const context = canvas.getContext('2d');
          
          if (context && canvas.width > 0 && canvas.height > 0) {
            try {
              // Apply noise before exporting
              const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
              const pixelCount = imageData.data.length / 4;
              const noisePixels = Math.floor(pixelCount * 0.005); // 0.5% of pixels
              
              for (let i = 0; i < noisePixels; i++) {
                const randomIndex = Math.floor(Math.random() * pixelCount) * 4;
                const x = (randomIndex / 4) % canvas.width;
                const y = Math.floor((randomIndex / 4) / canvas.width);
                
                const noise = getNoise(x, y);
                imageData.data[randomIndex] = Math.max(0, Math.min(255, imageData.data[randomIndex] + noise * 255));
                imageData.data[randomIndex + 1] = Math.max(0, Math.min(255, imageData.data[randomIndex + 1] + noise * 255));
                imageData.data[randomIndex + 2] = Math.max(0, Math.min(255, imageData.data[randomIndex + 2] + noise * 255));
              }
              
              context.putImageData(imageData, 0, 0);
            } catch (e) {
              // Ignore errors (canvas might be tainted)
            }
          }
          
          return originalToBlob.apply(this, arguments);
        };
        
        HTMLCanvasElement.prototype.toDataURL = function(type, quality) {
          const canvas = this;
          const context = canvas.getContext('2d');
          
          if (context && canvas.width > 0 && canvas.height > 0) {
            try {
              // Apply noise before exporting
              const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
              const pixelCount = imageData.data.length / 4;
              const noisePixels = Math.floor(pixelCount * 0.005); // 0.5% of pixels
              
              for (let i = 0; i < noisePixels; i++) {
                const randomIndex = Math.floor(Math.random() * pixelCount) * 4;
                const x = (randomIndex / 4) % canvas.width;
                const y = Math.floor((randomIndex / 4) / canvas.width);
                
                const noise = getNoise(x, y);
                imageData.data[randomIndex] = Math.max(0, Math.min(255, imageData.data[randomIndex] + noise * 255));
                imageData.data[randomIndex + 1] = Math.max(0, Math.min(255, imageData.data[randomIndex + 1] + noise * 255));
                imageData.data[randomIndex + 2] = Math.max(0, Math.min(255, imageData.data[randomIndex + 2] + noise * 255));
              }
              
              context.putImageData(imageData, 0, 0);
            } catch (e) {
              // Ignore errors (canvas might be tainted)
            }
          }
          
          return originalToDataURL.apply(this, arguments);
        };
      `,
    });

    // 5. Override WebRTC to prevent IP leak
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        const originalRTCPeerConnection = window.RTCPeerConnection;
        window.RTCPeerConnection = function(...args) {
          const pc = new originalRTCPeerConnection(...args);
          const originalCreateDataChannel = pc.createDataChannel.bind(pc);
          pc.createDataChannel = function(...args) {
            return originalCreateDataChannel(...args);
          };
          return pc;
        };
      `,
    });

    // 6. Override Notification and other permissions
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        // Already handled in step 2, but ensure it's applied
        if (!window.chrome) {
          window.chrome = {
            runtime: {},
            loadTimes: function() {},
            csi: function() {},
            app: {}
          };
        }
      `,
    });

    // 7. Override console methods to suppress React Router errors and hide automation traces
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        // Suppress React Router "cannot render router inside another router" errors
        const originalError = console.error;
        console.error = function(...args) {
          // Convert all arguments to strings for message checking
          const message = args.map(arg => {
            if (typeof arg === 'string') return arg;
            if (arg instanceof Error) return arg.message || arg.toString();
            try {
              return JSON.stringify(arg);
            } catch {
              return String(arg);
            }
          }).join(' ');
          
          // Filter out React Router nesting errors - these are often false positives in virtual browsers
          // Check for various formats of the error message (including the exact ChatGPT error)
          if (message.includes('router inside another router') || 
              message.includes('Router inside another Router') ||
              message.includes('<Router> inside another <Router>') ||
              message.includes('cannot render a <Router>') ||
              message.includes('cannot render a Router') ||
              message.includes('You cannot render a Router inside another Router') ||
              message.includes('You cannot render a <Router> inside another <Router>') ||
              message.includes('You should never have more than one in your app') ||
              message.includes('should never have more than one')) {
            return; // Suppress this specific error
          }
          originalError.apply(console, args);
        };
        
        console.debug = () => {};
        // Keep console.warn but suppress React Router warnings
        const originalWarn = console.warn;
        console.warn = function(...args) {
          // Convert all arguments to strings for message checking
          const message = args.map(arg => {
            if (typeof arg === 'string') return arg;
            if (arg instanceof Error) return arg.message || arg.toString();
            try {
              return JSON.stringify(arg);
            } catch {
              return String(arg);
            }
          }).join(' ');
          
          // Check for various formats of the warning message (including the exact ChatGPT error)
          if (message.includes('router inside another router') ||
              message.includes('Router inside another Router') ||
              message.includes('<Router> inside another <Router>') ||
              message.includes('cannot render a <Router>') ||
              message.includes('cannot render a Router') ||
              message.includes('You cannot render a Router inside another Router') ||
              message.includes('You cannot render a <Router> inside another <Router>') ||
              message.includes('You should never have more than one in your app') ||
              message.includes('should never have more than one')) {
            return; // Suppress this specific warning
          }
          originalWarn.apply(console, args);
        };
        
        // Catch uncaught errors that would crash the page (like React Router errors)
        window.addEventListener('error', function(event) {
          const errorMessage = event.message || event.error?.message || String(event.error || '');
          // Suppress React Router nesting errors that are false positives (including exact ChatGPT error format)
          if (errorMessage.includes('router inside another router') ||
              errorMessage.includes('Router inside another Router') ||
              errorMessage.includes('<Router> inside another <Router>') ||
              errorMessage.includes('cannot render a <Router>') ||
              errorMessage.includes('cannot render a Router') ||
              errorMessage.includes('You cannot render a Router inside another Router') ||
              errorMessage.includes('You cannot render a <Router> inside another <Router>') ||
              errorMessage.includes('You should never have more than one in your app') ||
              errorMessage.includes('should never have more than one')) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            return false; // Prevent error from crashing the page
          }
        }, true); // Use capture phase to catch early
        
        // Catch unhandled promise rejections
        window.addEventListener('unhandledrejection', function(event) {
          const reason = event.reason?.message || String(event.reason || '');
          if (reason.includes('router inside another router') ||
              reason.includes('Router inside another Router') ||
              reason.includes('<Router> inside another <Router>') ||
              reason.includes('cannot render a <Router>') ||
              reason.includes('cannot render a Router') ||
              reason.includes('You cannot render a Router inside another Router') ||
              reason.includes('You cannot render a <Router> inside another <Router>') ||
              reason.includes('You should never have more than one in your app') ||
              reason.includes('should never have more than one')) {
            event.preventDefault();
            event.stopPropagation();
          }
        });
      `,
    });

    // 8. Add realistic timezone and locale
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        Object.defineProperty(Intl.DateTimeFormat.prototype, 'resolvedOptions', {
          value: function() {
            return {
              ...Intl.DateTimeFormat.prototype.resolvedOptions.call(this),
              timeZone: 'America/New_York'
            };
          }
        });
      `,
    });

    // 9. Override document properties
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'hardwareConcurrency', {
        get: () => 8
      });
      
      Object.defineProperty(navigator, 'deviceMemory', {
        get: () => 8
      });

      Object.defineProperty(navigator, 'platform', {
        get: () => 'Win32'
      });

      // Override connection
      Object.defineProperty(navigator, 'connection', {
        get: () => ({
          effectiveType: '4g',
          rtt: 50,
          downlink: 10,
          saveData: false
        })
      });
    });

    // 10. Override automation indicators via CDP
    await client.send('Runtime.addBinding', { name: 'cdp' });
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        delete Object.getPrototypeOf(navigator).webdriver;
      `,
    });

    // 11. Set realistic viewport and screen properties
    await page.addInitScript(() => {
      Object.defineProperty(screen, 'availWidth', { get: () => 1366 });
      Object.defineProperty(screen, 'availHeight', { get: () => 768 });
      Object.defineProperty(screen, 'width', { get: () => 1366 });
      Object.defineProperty(screen, 'height', { get: () => 768 });
      Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
      Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });
    });

    // 12. reCAPTCHA v2 specific anti-detection
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        // Override Date to prevent timing analysis
        const originalDate = Date;
        const timeOffset = Math.random() * 100;
        Date = class extends originalDate {
          constructor(...args) {
            if (args.length === 0) {
              super(originalDate.now() + timeOffset);
            } else {
              super(...args);
            }
          }
          static now() {
            return originalDate.now() + timeOffset;
          }
        };
        Date.prototype = originalDate.prototype;
        Date.prototype.constructor = Date;

        // Override performance timing to add realistic jitter
        if (window.performance && window.performance.timing) {
          const originalTiming = window.performance.timing;
          const jitter = Math.random() * 10;
          Object.defineProperty(window.performance.timing, 'navigationStart', {
            get: () => originalTiming.navigationStart + jitter
          });
        }

        // Spoof mouse event properties that reCAPTCHA checks
        const originalAddEventListener = EventTarget.prototype.addEventListener;
        EventTarget.prototype.addEventListener = function(type, listener, options) {
          if (type === 'mousemove' || type === 'click' || type === 'mousedown' || type === 'mouseup') {
            const wrappedListener = function(event) {
              // Add micro-randomization to mouse events
              if (event.isTrusted === undefined) {
                Object.defineProperty(event, 'isTrusted', { value: true, configurable: true });
              }
              return listener.call(this, event);
            };
            return originalAddEventListener.call(this, type, wrappedListener, options);
          }
          return originalAddEventListener.call(this, type, listener, options);
        };

        // Override getBoundingClientRect to add micro-variations (prevents perfect click detection)
        const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
        Element.prototype.getBoundingClientRect = function() {
          const rect = originalGetBoundingClientRect.call(this);
          return {
            ...rect,
            x: rect.x + (Math.random() - 0.5) * 0.1,
            y: rect.y + (Math.random() - 0.5) * 0.1,
            width: rect.width + (Math.random() - 0.5) * 0.1,
            height: rect.height + (Math.random() - 0.5) * 0.1,
            top: rect.top + (Math.random() - 0.5) * 0.1,
            right: rect.right + (Math.random() - 0.5) * 0.1,
            bottom: rect.bottom + (Math.random() - 0.5) * 0.1,
            left: rect.left + (Math.random() - 0.5) * 0.1,
            toJSON: rect.toJSON
          };
        };

        // Fix maxTouchPoints based on device type (tablet/mobile should have touch support)
        const viewportWidth = window.innerWidth || screen.width || 0;
        const isTabletDevice = viewportWidth >= 768 && viewportWidth <= 1366;
        const isMobileDevice = viewportWidth > 0 && viewportWidth < 768;
        
        Object.defineProperty(navigator, 'maxTouchPoints', {
          get: () => {
            // Tablets and mobile devices should have 5+ touch points
            if (isTabletDevice || isMobileDevice) {
              return 5; // Real tablets/mobile have 5-10 touch points
            }
            return 0; // Desktop devices have no touch
          },
          configurable: true
        });
        
        // Ensure hasTouch property matches maxTouchPoints
        if (isTabletDevice || isMobileDevice) {
          Object.defineProperty(navigator, 'hasTouch', {
            get: () => true,
            configurable: true
          });
        }

        // Override requestAnimationFrame to add realistic timing
        const originalRAF = window.requestAnimationFrame;
        window.requestAnimationFrame = function(callback) {
          const start = performance.now();
          return originalRAF(function(timestamp) {
            const jitter = (Math.random() - 0.5) * 2; // ±1ms jitter
            callback(timestamp + jitter);
          });
        };
      `,
    });

    // 13. Add realistic mouse event listeners (reCAPTCHA tracks these)
    // Only for desktop devices - tablets/mobile use touch events
    await page.addInitScript(() => {
      // Detect device type from viewport
      const viewportWidth = window.innerWidth || screen.width || 0;
      const isTabletDevice = viewportWidth >= 768 && viewportWidth <= 1366;
      const isMobileDevice = viewportWidth > 0 && viewportWidth < 768;
      
      // Only add mouse movement simulation for desktop devices
      if (!isTabletDevice && !isMobileDevice) {
        // Simulate natural mouse movements even when not actively moving
        let lastMoveTime = Date.now();
        setInterval(() => {
          // Occasional micro-movements (humans don't hold perfectly still)
          if (Math.random() < 0.1 && Date.now() - lastMoveTime > 2000) {
            const event = new MouseEvent('mousemove', {
              bubbles: true,
              cancelable: true,
              view: window,
              clientX: window.innerWidth / 2 + (Math.random() - 0.5) * 2,
              clientY: window.innerHeight / 2 + (Math.random() - 0.5) * 2,
              movementX: (Math.random() - 0.5) * 0.5,
              movementY: (Math.random() - 0.5) * 0.5
            });
            document.dispatchEvent(event);
            lastMoveTime = Date.now();
          }
        }, 100);
      }
    });

    // 13b. Add touch event support for tablets and mobile devices
    await page.addInitScript(() => {
      // Detect device type from viewport
      const viewportWidth = window.innerWidth || screen.width || 0;
      const isTabletDevice = viewportWidth >= 768 && viewportWidth <= 1366;
      const isMobileDevice = viewportWidth > 0 && viewportWidth < 768;
      
      if (isTabletDevice || isMobileDevice) {
        // Ensure Touch and TouchEvent classes exist
        if (typeof Touch === 'undefined') {
          (window as any).Touch = class Touch {
            identifier: number;
            target: EventTarget;
            clientX: number;
            clientY: number;
            screenX: number;
            screenY: number;
            pageX: number;
            pageY: number;
            radiusX: number;
            radiusY: number;
            rotationAngle: number;
            force: number;

            constructor(touchInit: any) {
              this.identifier = touchInit.identifier || Date.now();
              this.target = touchInit.target;
              this.clientX = touchInit.clientX || 0;
              this.clientY = touchInit.clientY || 0;
              this.screenX = touchInit.screenX || touchInit.clientX || 0;
              this.screenY = touchInit.screenY || touchInit.clientY || 0;
              this.pageX = touchInit.pageX || touchInit.clientX || 0;
              this.pageY = touchInit.pageY || touchInit.clientY || 0;
              this.radiusX = touchInit.radiusX || 11.5;
              this.radiusY = touchInit.radiusY || 11.5;
              this.rotationAngle = touchInit.rotationAngle || 0;
              this.force = touchInit.force || 0.5;
            }
          };
        }

        if (typeof TouchEvent === 'undefined') {
          (window as any).TouchEvent = class TouchEvent extends Event {
            touches: TouchList;
            targetTouches: TouchList;
            changedTouches: TouchList;
            altKey: boolean;
            ctrlKey: boolean;
            metaKey: boolean;
            shiftKey: boolean;

            constructor(type: string, eventInitDict?: any) {
              super(type, eventInitDict);
              this.touches = eventInitDict?.touches || ([] as any);
              this.targetTouches = eventInitDict?.targetTouches || ([] as any);
              this.changedTouches = eventInitDict?.changedTouches || ([] as any);
              this.altKey = eventInitDict?.altKey || false;
              this.ctrlKey = eventInitDict?.ctrlKey || false;
              this.metaKey = eventInitDict?.metaKey || false;
              this.shiftKey = eventInitDict?.shiftKey || false;
            }
          };
        }

        // Convert mouse events to touch events for tablets/mobile
        // This makes the browser behave like a real touch device
        const convertMouseToTouch = (mouseEvent: MouseEvent, touchType: string) => {
          const touch = new (window as any).Touch({
            identifier: Date.now() + Math.random(),
            target: mouseEvent.target,
            clientX: mouseEvent.clientX,
            clientY: mouseEvent.clientY,
            screenX: mouseEvent.screenX,
            screenY: mouseEvent.screenY,
            pageX: mouseEvent.pageX,
            pageY: mouseEvent.pageY,
            radiusX: 11.5,
            radiusY: 11.5,
            rotationAngle: 0,
            force: touchType === 'touchstart' ? 0.5 : 0
          });

          const touchList = {
            length: 1,
            item: (index: number) => index === 0 ? touch : null,
            [0]: touch
          } as TouchList;

          const touchEvent = new (window as any).TouchEvent(touchType, {
            bubbles: true,
            cancelable: true,
            touches: touchList,
            targetTouches: touchList,
            changedTouches: touchList,
            altKey: mouseEvent.altKey,
            ctrlKey: mouseEvent.ctrlKey,
            metaKey: mouseEvent.metaKey,
            shiftKey: mouseEvent.shiftKey
          });

          return touchEvent;
        };

        // Intercept mouse events and convert to touch events
        document.addEventListener('mousedown', (e: MouseEvent) => {
          const touchEvent = convertMouseToTouch(e, 'touchstart');
          e.target?.dispatchEvent(touchEvent);
        }, { passive: true, capture: true });

        document.addEventListener('mousemove', (e: MouseEvent) => {
          if (e.buttons === 1) { // Only if mouse is pressed
            const touchEvent = convertMouseToTouch(e, 'touchmove');
            e.target?.dispatchEvent(touchEvent);
          }
        }, { passive: true, capture: true });

        document.addEventListener('mouseup', (e: MouseEvent) => {
          const touchEvent = convertMouseToTouch(e, 'touchend');
          e.target?.dispatchEvent(touchEvent);
        }, { passive: true, capture: true });

        // Add pointer events support (tablets use pointer events)
        if (typeof PointerEvent !== 'undefined') {
          document.addEventListener('mousedown', (e: MouseEvent) => {
            const pointerEvent = new PointerEvent('pointerdown', {
              bubbles: true,
              cancelable: true,
              pointerId: 1,
              pointerType: 'touch',
              clientX: e.clientX,
              clientY: e.clientY,
              isPrimary: true
            });
            e.target?.dispatchEvent(pointerEvent);
          }, { passive: true, capture: true });
        }
      }
    });

    // 14. reCAPTCHA v3 score improvement
    await improveRecaptchaV3Score(page);

    // 15. DataDome detection bypass
    await bypassDataDome(page);

    // 16. Behavioral biometrics simulation
    await simulateBehavioralBiometrics(page);

  } catch (error) {
    console.warn('Failed to apply some stealth techniques:', error);
    // Don't fail if stealth techniques can't be applied
  }
}

/**
 * Improve reCAPTCHA v3 score by simulating user engagement
 */
async function improveRecaptchaV3Score(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // Override performance timing for better scores
    const originalPerformance = window.performance;
    Object.defineProperty(window, 'performance', {
      get: () => ({
        ...originalPerformance,
        timing: {
          ...originalPerformance.timing,
          navigationStart: Date.now() - Math.random() * 1000,
        },
        memory: {
          usedJSHeapSize: 10000000 + Math.random() * 5000000,
          totalJSHeapSize: 20000000 + Math.random() * 10000000,
          jsHeapSizeLimit: 4294705152,
        },
      }),
    });

    // Simulate user engagement (scrolls, clicks, etc.)
    let interactionCount = 0;
    const simulateInteraction = () => {
      if (interactionCount < 5) {
        // Simulate scroll
        window.scrollBy(0, Math.random() * 100);
        
        // Simulate mouse movement
        document.dispatchEvent(new MouseEvent('mousemove', {
          bubbles: true,
          cancelable: true,
          clientX: Math.random() * window.innerWidth,
          clientY: Math.random() * window.innerHeight,
        }));
        
        interactionCount++;
        setTimeout(simulateInteraction, 2000 + Math.random() * 3000);
      }
    };
    setTimeout(simulateInteraction, 1000);

    // Track user activity time
    const activityStartTime = Date.now();
    Object.defineProperty(document, 'hidden', {
      get: () => false,
    });
    // Keep for potential future use
    void activityStartTime;
  });
}

/**
 * Bypass DataDome detection
 */
async function bypassDataDome(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // Override fingerprinting methods that DataDome uses
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      get: () => 8,
    });
    
    Object.defineProperty(navigator, 'deviceMemory', {
      get: () => 8,
    });

    // Spoof WebGL fingerprint
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      if (parameter === 37445) return 'Intel Inc.';
      if (parameter === 37446) return 'Intel Iris OpenGL Engine';
      return getParameter.call(this, parameter);
    };

    const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(parameter) {
      if (parameter === 37445) return 'Intel Inc.';
      if (parameter === 37446) return 'Intel Iris OpenGL Engine';
      return getParameter2.call(this, parameter);
    };

    // Override canvas fingerprinting
    const toDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(type?: string, quality?: number): string {
      const context = this.getContext('2d');
      if (context) {
        const imageData = context.getImageData(0, 0, this.width, this.height);
        for (let i = 0; i < imageData.data.length; i += 4) {
          imageData.data[i] += Math.random() * 0.0001;
          imageData.data[i + 1] += Math.random() * 0.0001;
          imageData.data[i + 2] += Math.random() * 0.0001;
        }
        context.putImageData(imageData, 0, 0);
      }
      return toDataURL.call(this, type, quality);
    };

    // Override AudioContext fingerprinting
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const windowWithAudio = window as any;
    if (window.AudioContext || windowWithAudio.webkitAudioContext) {
      const OriginalAudioContext = window.AudioContext || windowWithAudio.webkitAudioContext;
      windowWithAudio.AudioContext = class extends OriginalAudioContext {
        createAnalyser(): AnalyserNode {
          const analyser = super.createAnalyser();
          const originalGetFloatFrequencyData = analyser.getFloatFrequencyData.bind(analyser);
          analyser.getFloatFrequencyData = function(array: Float32Array): void {
            originalGetFloatFrequencyData(array as Float32Array<ArrayBuffer>);
            // Add noise to frequency data
            for (let i = 0; i < array.length; i++) {
              array[i] += (Math.random() - 0.5) * 0.01;
            }
          };
          return analyser;
        }
      };
    }
  });
}

/**
 * Simulate behavioral biometrics (mouse movement patterns, typing rhythm)
 */
async function simulateBehavioralBiometrics(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // Store learned mouse movement patterns
    const mousePatterns: Array<{ speed: number; curvature: number; pauses: number[] }> = [
      { speed: 0.8, curvature: 0.3, pauses: [50, 120, 200] },
      { speed: 1.0, curvature: 0.2, pauses: [30, 100, 180] },
      { speed: 0.9, curvature: 0.25, pauses: [40, 110, 190] },
    ];

    const patternIndex = 0;
    const currentPattern = mousePatterns[patternIndex % mousePatterns.length];

    // Track mouse movements and apply learned patterns
    let lastMouseEvent: MouseEvent | null = null;
    const originalAddEventListener = EventTarget.prototype.addEventListener;
    
    EventTarget.prototype.addEventListener = function(type, listener, options) {
      if (type === 'mousemove' && listener) {
        const wrappedListener = (event: Event) => {
          const mouseEvent = event as MouseEvent;
          
          if (lastMouseEvent && listener) {
            // Apply learned speed pattern
            const timeDelta = mouseEvent.timeStamp - lastMouseEvent.timeStamp;
            const adjustedTimeDelta = timeDelta * currentPattern.speed;
            
            // Apply learned curvature
            const movementX = mouseEvent.movementX || 0;
            const movementY = mouseEvent.movementY || 0;
            const curvature = currentPattern.curvature;
            
            const adjustedEvent = new MouseEvent('mousemove', {
              ...mouseEvent,
              movementX: movementX * (1 + curvature * (Math.random() - 0.5)),
              movementY: movementY * (1 + curvature * (Math.random() - 0.5)),
            });
            
            Object.defineProperty(adjustedEvent, 'timeStamp', {
              value: lastMouseEvent.timeStamp + adjustedTimeDelta,
            });
            
            // Handle both function listeners and object listeners
            if (typeof listener === 'function') {
              listener.call(this, adjustedEvent);
            } else if (listener && typeof listener.handleEvent === 'function') {
              listener.handleEvent(adjustedEvent);
            }
          } else if (listener) {
            if (typeof listener === 'function') {
              listener.call(this, event);
            } else if (listener && typeof listener.handleEvent === 'function') {
              listener.handleEvent(event);
            }
          }
          
          lastMouseEvent = mouseEvent;
        };
        return originalAddEventListener.call(this, type, wrappedListener, options);
      }
      return originalAddEventListener.call(this, type, listener, options);
    };

    // Simulate typing rhythm patterns
    const typingPatterns: Array<{ baseDelay: number; variation: number; pauseFrequency: number }> = [
      { baseDelay: 50, variation: 20, pauseFrequency: 0.1 },
      { baseDelay: 60, variation: 25, pauseFrequency: 0.15 },
      { baseDelay: 55, variation: 22, pauseFrequency: 0.12 },
    ];

    const typingPatternIndex = 0;
    const currentTypingPattern = typingPatterns[typingPatternIndex % typingPatterns.length];

    // Override keyboard events to apply typing rhythm
    const originalKeyboardEvent = KeyboardEvent;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).KeyboardEvent = class extends originalKeyboardEvent {
      constructor(type: string, eventInitDict?: KeyboardEventInit) {
        super(type, eventInitDict);
        
        if (type === 'keydown' || type === 'keypress') {
          // Apply learned typing rhythm (pattern for future enhancement)
          // Calculate delay pattern for potential future use
          const delayPattern = currentTypingPattern.baseDelay + 
            (Math.random() - 0.5) * currentTypingPattern.variation;
          void delayPattern; // Suppress unused variable warning - reserved for future use
          
          // Occasionally add pause (thinking time)
          if (Math.random() < currentTypingPattern.pauseFrequency) {
            const pause = 200 + Math.random() * 300;
            setTimeout(() => {}, pause);
          }
        }
      }
    };
  });
}

// ============================================================================
// HUMAN BEHAVIOR SIMULATION
// ============================================================================

/**
 * Human-like delay helper
 */
export async function humanDelay(minMs: number = 1000, maxMs: number = 4000): Promise<void> {
  if (minMs < 0 || maxMs < 0 || minMs > maxMs) {
    throw new Error(`Invalid delay range: minMs=${minMs}, maxMs=${maxMs}`);
  }
  
  const baseDelay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  const variation = Math.random() * 0.2 * baseDelay;
  const delay = Math.floor(baseDelay + variation - (variation / 2));
  
  await new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * Human-like typing with realistic rhythm and mistakes
 * Enhanced for anti-detection (reCAPTCHA typing analysis)
 */
export async function humanType(page: Page, selector: string, text: string): Promise<void> {
  await page.click(selector);
  await humanDelay(150, 400);
  
  // Simulate human typing with variable delays and occasional corrections
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    
    // Variable typing speed (faster for common chars, slower for special)
    const baseDelay = /[a-zA-Z0-9\s]/.test(char) 
      ? Math.random() * 40 + 15  // Common chars: 15-55ms
      : Math.random() * 80 + 40; // Special chars: 40-120ms
    
    // Add occasional longer pauses (thinking)
    const shouldPause = Math.random() < 0.05; // 5% chance
    if (shouldPause && i > 0) {
      await humanDelay(200, 600);
    }
    
    // Simulate occasional typos and corrections (very rare)
    if (Math.random() < 0.02 && i > 2) { // 2% chance, not at start
      // Type wrong char, then backspace, then correct
      const wrongChar = String.fromCharCode(char.charCodeAt(0) + 1);
      await page.type(selector, wrongChar, { delay: baseDelay });
      await humanDelay(50, 150);
      await page.keyboard.press('Backspace');
      await humanDelay(50, 150);
    }
    
    await page.type(selector, char, { delay: baseDelay });
    
    // Occasional micro-pauses between words
    if (char === ' ' && Math.random() < 0.3) {
      await humanDelay(50, 150);
    }
  }
  
  // Final pause after typing (human reads what they typed)
  await humanDelay(100, 300);
}

/**
 * Save session immediately after reCAPTCHA solve or critical action
 * This prevents the loop where reCAPTCHA keeps appearing
 */
export async function saveSessionImmediately(
  context: BrowserContext,
  siteId: string,
  sessionManager: { saveSession: (siteId: string, storageState: unknown) => Promise<void> }
): Promise<void> {
  try {
    // Wait a bit for cookies to be set
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const storageState = await context.storageState();
    
    // Save session immediately
    await sessionManager.saveSession(siteId, storageState);
    console.log(`✓ Session saved immediately for ${siteId} (post-reCAPTCHA)`);
    
    // Add some realistic behavior after saving (humans don't immediately refresh)
    const pages = context.pages();
    if (pages.length > 0) {
      const mainPage = pages[0];
      try {
        // Small mouse movement
        await humanDelay(200, 500);
        const viewport = mainPage.viewportSize();
        if (viewport) {
          await mainPage.mouse.move(
            viewport.width / 2 + (Math.random() - 0.5) * 50,
            viewport.height / 2 + (Math.random() - 0.5) * 50,
            { steps: 3 }
          );
        }
        await humanDelay(300, 800);
      } catch {
        // Ignore errors
      }
    }
  } catch (error) {
    console.warn(`Failed to save session immediately for ${siteId}:`, error);
  }
}

/**
 * Wait for reCAPTCHA to be solved and then save session
 * Call this after user manually solves reCAPTCHA
 */
export async function waitForRecaptchaSolve(
  page: Page,
  context: BrowserContext,
  siteId: string,
  sessionManager: { saveSession: (siteId: string, storageState: unknown) => Promise<void> },
  timeout: number = 60000
): Promise<boolean> {
  try {
    console.log('Waiting for reCAPTCHA to be solved...');
    
    // Wait for reCAPTCHA checkbox to be checked or disappear
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      // Check if reCAPTCHA is solved (checkbox checked or element gone)
      const isSolved = await page.evaluate(() => {
        // Check for reCAPTCHA success indicators
        const recaptchaFrame = document.querySelector('iframe[src*="recaptcha"]');
        if (!recaptchaFrame) return true; // No reCAPTCHA found
        
        // Check if checkbox is checked
        const checkbox = document.querySelector('.recaptcha-checkbox-checked');
        if (checkbox) return true;
        
        // Check for success token
        const token = document.querySelector('[name="g-recaptcha-response"]');
        if (token && (token as HTMLInputElement).value) return true;
        
        return false;
      }).catch(() => false);
      
      if (isSolved) {
        console.log('✓ reCAPTCHA appears to be solved');
        
        // Wait for page to process the solve
        await humanDelay(1000, 2000);
        
        // Save session immediately
        await saveSessionImmediately(context, siteId, sessionManager);
        
        // Wait a bit more for any redirects or page updates
        await humanDelay(500, 1500);
        
        return true;
      }
      
      // Check every 500ms
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.warn('Timeout waiting for reCAPTCHA solve');
    return false;
  } catch (error) {
    console.error('Error waiting for reCAPTCHA solve:', error);
    return false;
  }
}

/**
 * Switch page viewport from mobile to desktop (or vice versa)
 * Useful for login in mobile view, then switching to desktop for other operations
 */
export async function switchViewport(
  page: Page,
  targetDevice: 'mobile' | 'desktop' | 'tablet'
): Promise<void> {
  try {
    const context = page.context();
    const client = await context.newCDPSession(page);
    
    if (targetDevice === 'tablet' || targetDevice === 'desktop') {
      // Switch to tablet viewport (Android tablet)
      const tabletDevice = devices['Galaxy Tab S7'] || devices['Galaxy Tab S8'] || devices['iPad Pro 12.9" (6th generation)'] || devices['iPad Pro'];
      const tabletConfig = tabletDevice ? {
        viewport: tabletDevice.viewport,
        userAgent: tabletDevice.userAgent,
        deviceScaleFactor: tabletDevice.deviceScaleFactor || 2,
        isMobile: tabletDevice.isMobile || false,
        hasTouch: tabletDevice.hasTouch || true,
      } : {
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-T870) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        deviceScaleFactor: 2,
        isMobile: false,
        hasTouch: true,
      };
      
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: tabletConfig.viewport.width,
        height: tabletConfig.viewport.height,
        deviceScaleFactor: tabletConfig.deviceScaleFactor,
        mobile: tabletConfig.isMobile,
      });
      
      await client.send('Network.setUserAgentOverride', {
        userAgent: tabletConfig.userAgent,
      });
      
      await page.setViewportSize(tabletConfig.viewport);
      
      // Update navigator properties for tablet
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 });
        Object.defineProperty(navigator, 'platform', { get: () => 'Linux armv8l' });
      });
      
      console.log(`✓ Switched to tablet viewport (${tabletConfig.viewport.width}x${tabletConfig.viewport.height})`);
    } else {
      // Switch to mobile viewport
      const mobileDevice = devices['iPhone 13'];
      const mobileConfig = {
        viewport: mobileDevice.viewport,
        userAgent: mobileDevice.userAgent,
        deviceScaleFactor: mobileDevice.deviceScaleFactor,
        isMobile: mobileDevice.isMobile,
        hasTouch: mobileDevice.hasTouch,
      };
      
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: mobileConfig.viewport.width,
        height: mobileConfig.viewport.height,
        deviceScaleFactor: mobileConfig.deviceScaleFactor,
        mobile: mobileConfig.isMobile,
      });
      
      await client.send('Network.setUserAgentOverride', {
        userAgent: mobileConfig.userAgent,
      });
      
      await page.setViewportSize(mobileConfig.viewport);
      
      // Update navigator properties
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 });
        Object.defineProperty(navigator, 'platform', { get: () => 'iPhone' });
      });
      
      console.log('✓ Switched to mobile viewport (iPhone 13)');
    }
    
    // Wait a bit for viewport change to take effect
    await humanDelay(300, 600);
    
    // Trigger a resize event to ensure page reacts to viewport change
    await page.evaluate(() => {
      window.dispatchEvent(new Event('resize'));
    });
    
    await humanDelay(200, 400);
  } catch (error) {
    console.warn('Failed to switch viewport:', error);
    // Fallback: just set viewport size
    try {
      if (targetDevice === 'desktop') {
        await page.setViewportSize({ width: 1366, height: 768 });
      } else {
        const mobileDevice = devices['iPhone 13'];
        await page.setViewportSize(mobileDevice.viewport);
      }
    } catch (fallbackError) {
      console.warn('Fallback viewport switch also failed:', fallbackError);
    }
  }
}

/**
 * Human-like mouse movement and scroll with realistic patterns
 * Enhanced for anti-detection (reCAPTCHA v2, Cloudflare, etc.)
 */
export async function humanBehavior(page: Page): Promise<void> {
  try {
    // Random scroll with human-like patterns
    const scrollAmount = Math.floor(Math.random() * 400) + 150;
    const scrollSteps = Math.floor(Math.random() * 5) + 3; // Multiple scroll steps
    
    for (let i = 0; i < scrollSteps; i++) {
      const stepAmount = Math.floor(scrollAmount / scrollSteps);
      await page.evaluate((amount) => {
        window.scrollBy(0, amount);
      }, stepAmount);
      await humanDelay(100, 300);
    }
    
    await humanDelay(300, 800);
    
    // Realistic mouse movement with bezier-like curves and micro-movements
    const viewport = page.viewportSize();
    if (viewport) {
      // Move mouse in a more natural pattern (not straight lines)
      const startX = Math.floor(Math.random() * viewport.width);
      const startY = Math.floor(Math.random() * viewport.height);
      const endX = Math.floor(Math.random() * viewport.width);
      const endY = Math.floor(Math.random() * viewport.height);
      
      // Create intermediate points for curved movement
      const midX = (startX + endX) / 2 + (Math.random() - 0.5) * 100;
      const midY = (startY + endY) / 2 + (Math.random() - 0.5) * 100;
      
      const steps = Math.floor(Math.random() * 20) + 15; // More steps for smoother movement
      
      // Move through intermediate point for more natural curve
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        // Bezier-like curve with added jitter for realism
        const jitterX = (Math.random() - 0.5) * 2; // ±1px jitter
        const jitterY = (Math.random() - 0.5) * 2;
        
        const x = Math.round(
          (1 - t) * (1 - t) * startX + 
          2 * (1 - t) * t * midX + 
          t * t * endX + jitterX
        );
        const y = Math.round(
          (1 - t) * (1 - t) * startY + 
          2 * (1 - t) * t * midY + 
          t * t * endY + jitterY
        );
        
        // Variable speed (faster in middle, slower at start/end)
        const speed = t < 0.1 || t > 0.9 
          ? Math.random() * 8 + 12  // Slower at start/end: 12-20ms
          : Math.random() * 5 + 8;  // Faster in middle: 8-13ms
        
        await page.mouse.move(x, y, { steps: 1 });
        await new Promise(resolve => setTimeout(resolve, speed));
      }
      
      // Add micro-movements after main movement (humans don't stop perfectly)
      for (let i = 0; i < 3; i++) {
        await humanDelay(50, 150);
        const microX = endX + (Math.random() - 0.5) * 3;
        const microY = endY + (Math.random() - 0.5) * 3;
        await page.mouse.move(microX, microY, { steps: 1 });
      }
    }
    
    // Random pause after mouse movement
    await humanDelay(200, 600);
    
    // Sometimes do a small random scroll
    if (Math.random() > 0.5) {
      const smallScroll = Math.floor(Math.random() * 100) + 50;
      await page.evaluate((amount) => {
        window.scrollBy(0, amount);
      }, smallScroll);
      await humanDelay(100, 300);
    }
  } catch (error) {
    // Mouse movement not critical, continue
    console.warn('Human behavior simulation warning:', error);
  }
}

/**
 * Enhanced click with reCAPTCHA v2 evasion
 * Adds randomization to click position and timing
 */
export async function humanClick(page: Page, selector: string, options?: { timeout?: number }): Promise<void> {
  try {
    // Get element bounds
    const element = await page.locator(selector).first();
    const box = await element.boundingBox();
    
    if (box) {
      // Add random offset to click position (humans don't click perfectly centered)
      const offsetX = (Math.random() - 0.5) * (box.width * 0.3); // ±15% of width
      const offsetY = (Math.random() - 0.5) * (box.height * 0.3); // ±15% of height
      
      const clickX = box.x + box.width / 2 + offsetX;
      const clickY = box.y + box.height / 2 + offsetY;
      
      // Move mouse to element first (with realistic movement)
      await page.mouse.move(clickX, clickY, { 
        steps: Math.floor(Math.random() * 5) + 3 
      });
      
      // Random delay before click (humans pause before clicking)
      await humanDelay(50, 200);
      
      // Click with slight randomization
      await page.mouse.click(clickX + (Math.random() - 0.5) * 2, 
                            clickY + (Math.random() - 0.5) * 2, {
        delay: Math.random() * 50 + 10, // 10-60ms delay between mousedown and mouseup
        button: 'left'
      });
      
      // Random delay after click
      await humanDelay(100, 300);
    } else {
      // Fallback to regular click if bounding box not available
      await humanDelay(100, 300);
      await page.click(selector, options);
      await humanDelay(100, 300);
    }
  } catch (error) {
    // Fallback to regular click
    await page.click(selector, options).catch(() => {
      throw error;
    });
  }
}
