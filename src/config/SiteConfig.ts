import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Site-specific configuration interface
 */
export interface SiteConfig {
  highActivity?: boolean;
  navigationTimeout?: number;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  postLoadWait?: number;
  customWaitSelectors?: string[];
  customWaitTimeout?: number;
  customWaitFallbackSelectors?: string[];
  customWaitFallbackTimeout?: number;
  additionalWaitAfterLoad?: number;
  fallbackWait?: number;
}

/**
 * Sites configuration file structure
 */
interface SitesConfigFile {
  sites: Record<string, SiteConfig>;
  defaults: {
    normalSiteTimeout: number;
    normalSiteWaitUntil: 'load' | 'domcontentloaded' | 'networkidle';
    highActivityTimeout: number;
    highActivityWaitUntil: 'load' | 'domcontentloaded' | 'networkidle';
    postLoadWait: number;
    fallbackTimeout: number;
  };
}

/**
 * Site Configuration Manager
 * Loads and manages site-specific configurations from JSON file
 */
export class SiteConfigManager {
  private config: SitesConfigFile;
  private static instance: SiteConfigManager | null = null;

  private constructor() {
    // Initialize with default config (will be overridden if file loads successfully)
    this.config = {
      sites: {},
      defaults: {
        normalSiteTimeout: 30000,
        normalSiteWaitUntil: 'networkidle',
        highActivityTimeout: 60000,
        highActivityWaitUntil: 'load',
        postLoadWait: 2000,
        fallbackTimeout: 30000,
      },
    };
    // Try multiple paths to find the config file
    // First try relative to source (for development), then relative to dist (for production)
    const possiblePaths = [
      join(process.cwd(), 'src', 'config', 'sites-config.json'), // Development
      join(process.cwd(), 'backend', 'src', 'config', 'sites-config.json'), // Alternative
      join(process.cwd(), 'dist', 'config', 'sites-config.json'), // Production (compiled)
    ];

    let configLoaded = false;
    for (const configPath of possiblePaths) {
      try {
        const configContent = readFileSync(configPath, 'utf-8');
        this.config = JSON.parse(configContent);
        configLoaded = true;
        break;
      } catch {
        // Try next path
      }
    }

    if (!configLoaded) {
      console.error('Failed to load sites-config.json from any expected location, using defaults');
      // Config already initialized with defaults in constructor
    }
  }

  /**
   * Get singleton instance
   */
  static getInstance(): SiteConfigManager {
    if (!SiteConfigManager.instance) {
      SiteConfigManager.instance = new SiteConfigManager();
    }
    return SiteConfigManager.instance;
  }

  /**
   * Get site configuration for a given URL
   * @param url - The URL to get configuration for
   * @returns SiteConfig or null if no match found
   */
  getSiteConfig(url: string): SiteConfig | null {
    if (!url) return null;

    // Try to find matching site configuration
    for (const [domain, config] of Object.entries(this.config.sites)) {
      if (url.includes(domain)) {
        return config;
      }
    }

    return null;
  }

  /**
   * Check if a site is a high-activity site
   * @param url - The URL to check
   * @returns true if high-activity site
   */
  isHighActivitySite(url: string): boolean {
    const siteConfig = this.getSiteConfig(url);
    return siteConfig?.highActivity === true;
  }

  /**
   * Get navigation timeout for a site
   * @param url - The URL
   * @returns Timeout in milliseconds
   */
  getNavigationTimeout(url: string, isHighActivity: boolean): number {
    const siteConfig = this.getSiteConfig(url);
    if (siteConfig?.navigationTimeout) {
      return siteConfig.navigationTimeout;
    }
    return isHighActivity
      ? this.config.defaults.highActivityTimeout
      : this.config.defaults.normalSiteTimeout;
  }

  /**
   * Get waitUntil strategy for a site
   * @param url - The URL
   * @param isHighActivity - Whether site is high-activity
   * @returns WaitUntil strategy
   */
  getWaitUntil(url: string, isHighActivity: boolean): 'load' | 'domcontentloaded' | 'networkidle' {
    const siteConfig = this.getSiteConfig(url);
    if (siteConfig?.waitUntil) {
      return siteConfig.waitUntil;
    }
    return isHighActivity
      ? this.config.defaults.highActivityWaitUntil
      : this.config.defaults.normalSiteWaitUntil;
  }

  /**
   * Get post-load wait time for a site
   * @param url - The URL
   * @returns Wait time in milliseconds
   */
  getPostLoadWait(url: string): number {
    const siteConfig = this.getSiteConfig(url);
    return siteConfig?.postLoadWait ?? this.config.defaults.postLoadWait;
  }

  /**
   * Get fallback timeout
   * @returns Fallback timeout in milliseconds
   */
  getFallbackTimeout(): number {
    return this.config.defaults.fallbackTimeout;
  }

  /**
   * Get all site configurations (for debugging/inspection)
   */
  getAllConfigs(): Record<string, SiteConfig> {
    return { ...this.config.sites };
  }

  /**
   * Reload configuration from file (useful for hot-reloading in development)
   */
  reload(): void {
    // Try multiple paths to find the config file
    const possiblePaths = [
      join(process.cwd(), 'src', 'config', 'sites-config.json'), // Development
      join(process.cwd(), 'backend', 'src', 'config', 'sites-config.json'), // Alternative
      join(process.cwd(), 'dist', 'config', 'sites-config.json'), // Production (compiled)
    ];

    for (const configPath of possiblePaths) {
      try {
        const configContent = readFileSync(configPath, 'utf-8');
        this.config = JSON.parse(configContent);
        return;
      } catch {
        // Try next path
      }
    }
    
    console.error('Failed to reload sites-config.json from any expected location');
  }
}
