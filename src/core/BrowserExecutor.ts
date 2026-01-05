import { chromium, firefox, webkit, type Browser, type BrowserContext, type BrowserContextOptions } from 'playwright';
import type { Page } from 'playwright';

/**
 * BrowserExecutor: Abstraction layer for multi-browser support
 * Supports Chromium, Firefox, and WebKit browsers
 */
export type BrowserType = 'chromium' | 'firefox' | 'webkit';

export interface BrowserExecutorOptions extends BrowserContextOptions {
  browserType?: BrowserType;
  headless?: boolean;
}

export class BrowserExecutor {
  private browser: Browser | null = null;
  private browserType: BrowserType;
  private context: BrowserContext | null = null;

  constructor(browserType: BrowserType = 'chromium') {
    this.browserType = browserType;
  }

  /**
   * Launch browser
   */
  async launch(options: BrowserExecutorOptions = {}): Promise<BrowserContext> {
    const { browserType = this.browserType, headless = false, ...contextOptions } = options;

    let browserLauncher;
    switch (browserType) {
      case 'firefox':
        browserLauncher = firefox;
        break;
      case 'webkit':
        browserLauncher = webkit;
        break;
      case 'chromium':
      default:
        browserLauncher = chromium;
        break;
    }

    this.browser = await browserLauncher.launch({
      headless,
    });

    this.context = await this.browser.newContext(contextOptions);
    this.browserType = browserType;

    return this.context;
  }

  /**
   * Create new page
   */
  async newPage(): Promise<Page> {
    if (!this.context) {
      throw new Error('Browser context not initialized. Call launch() first.');
    }
    return this.context.newPage();
  }

  /**
   * Get current context
   */
  getContext(): BrowserContext | null {
    return this.context;
  }

  /**
   * Get browser type
   */
  getBrowserType(): BrowserType {
    return this.browserType;
  }

  /**
   * Check if browser is compatible with feature
   */
  isFeatureSupported(feature: string): boolean {
    const compatibility: Record<BrowserType, string[]> = {
      chromium: ['cdp', 'screenshot', 'pdf', 'video', 'network', 'storage'],
      firefox: ['screenshot', 'pdf', 'network', 'storage'],
      webkit: ['screenshot', 'network', 'storage'],
    };

    return compatibility[this.browserType]?.includes(feature) || false;
  }

  /**
   * Execute browser-specific command
   */
  async executeCommand<T>(
    command: string,
    ...args: unknown[]
  ): Promise<T> {
    if (!this.context) {
      throw new Error('Browser context not initialized.');
    }

    // Browser-specific command handling
    switch (command) {
      case 'cdp':
        if (this.browserType === 'chromium') {
          const page = this.context.pages()[0] || await this.newPage();
          const client = await this.context.newCDPSession(page);
          return client.send(args[0] as string, args[1] as Record<string, unknown>) as Promise<T>;
        }
        throw new Error(`CDP not supported in ${this.browserType}`);
      
      case 'screenshot':
        const page = this.context.pages()[0] || await this.newPage();
        return page.screenshot(args[0] as Parameters<Page['screenshot']>[0]) as Promise<T>;
      
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }

  /**
   * Close browser
   */
  async close(): Promise<void> {
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  /**
   * Get browser capabilities
   */
  getCapabilities(): {
    browserType: BrowserType;
    features: string[];
    version: string;
  } {
    const features: Record<BrowserType, string[]> = {
      chromium: ['cdp', 'screenshot', 'pdf', 'video', 'network', 'storage', 'geolocation'],
      firefox: ['screenshot', 'pdf', 'network', 'storage', 'geolocation'],
      webkit: ['screenshot', 'network', 'storage', 'geolocation'],
    };

    return {
      browserType: this.browserType,
      features: features[this.browserType] || [],
      version: 'latest', // Could be enhanced to get actual version
    };
  }
}

