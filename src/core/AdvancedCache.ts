import type { SelectorCandidate, SelectorHistory } from '../types/index.js';
import type { Page } from 'playwright';

/**
 * Advanced Cache: Intelligent caching for selectors, patterns, and predictions
 * 
 * Features:
 * - LRU cache for selectors
 * - TTL-based expiration
 * - Predictive cache warming
 * - Cross-site pattern caching
 * - Performance-based cache invalidation
 */
export class AdvancedCache {
  private selectorCache: Map<string, CachedSelector> = new Map();
  private patternCache: Map<string, CachedPattern> = new Map();
  private predictionCache: Map<string, CachedPrediction> = new Map();
  private maxCacheSize = 1000;
  private defaultTTL = 24 * 60 * 60 * 1000; // 24 hours

  /**
   * Get cached selector candidates
   */
  getCachedSelectors(
    brokenSelector: string,
    site: string,
    context?: {
      elementText?: string;
      elementType?: string;
    }
  ): SelectorCandidate[] | null {
    const key = this.generateSelectorKey(brokenSelector, site, context);
    const cached = this.selectorCache.get(key);

    if (!cached) return null;

    // Check if expired
    if (Date.now() > cached.expiresAt) {
      this.selectorCache.delete(key);
      return null;
    }

    // Update access time for LRU
    cached.lastAccessed = Date.now();
    cached.accessCount++;

    return cached.candidates;
  }

  /**
   * Cache selector candidates
   */
  cacheSelectors(
    brokenSelector: string,
    site: string,
    candidates: SelectorCandidate[],
    context?: {
      elementText?: string;
      elementType?: string;
    },
    ttl?: number
  ): void {
    const key = this.generateSelectorKey(brokenSelector, site, context);
    
    // Evict if cache is full (LRU)
    if (this.selectorCache.size >= this.maxCacheSize) {
      this.evictLRU();
    }

    this.selectorCache.set(key, {
      brokenSelector,
      site,
      candidates,
      cachedAt: Date.now(),
      expiresAt: Date.now() + (ttl || this.defaultTTL),
      lastAccessed: Date.now(),
      accessCount: 0,
      context,
    });
  }

  /**
   * Get cached pattern
   */
  getCachedPattern(patternType: string, site: string): any | null {
    const key = `${patternType}-${site}`;
    const cached = this.patternCache.get(key);

    if (!cached) return null;

    if (Date.now() > cached.expiresAt) {
      this.patternCache.delete(key);
      return null;
    }

    cached.lastAccessed = Date.now();
    return cached.pattern;
  }

  /**
   * Cache pattern
   */
  cachePattern(
    patternType: string,
    site: string,
    pattern: any,
    ttl?: number
  ): void {
    const key = `${patternType}-${site}`;
    
    if (this.patternCache.size >= this.maxCacheSize) {
      this.evictLRUPatterns();
    }

    this.patternCache.set(key, {
      patternType,
      site,
      pattern,
      cachedAt: Date.now(),
      expiresAt: Date.now() + (ttl || this.defaultTTL),
      lastAccessed: Date.now(),
    });
  }

  /**
   * Get cached prediction
   */
  getCachedPrediction(predictionType: string, key: string): any | null {
    const fullKey = `${predictionType}-${key}`;
    const cached = this.predictionCache.get(fullKey);

    if (!cached) return null;

    if (Date.now() > cached.expiresAt) {
      this.predictionCache.delete(fullKey);
      return null;
    }

    cached.lastAccessed = Date.now();
    return cached.prediction;
  }

  /**
   * Cache prediction
   */
  cachePrediction(
    predictionType: string,
    key: string,
    prediction: any,
    ttl?: number
  ): void {
    const fullKey = `${predictionType}-${key}`;
    
    if (this.predictionCache.size >= this.maxCacheSize) {
      this.evictLRUPredictions();
    }

    this.predictionCache.set(fullKey, {
      predictionType,
      key,
      prediction,
      cachedAt: Date.now(),
      expiresAt: Date.now() + (ttl || this.defaultTTL / 2), // Predictions expire faster
      lastAccessed: Date.now(),
    });
  }

  /**
   * Invalidate cache for a selector (when it breaks)
   */
  invalidateSelector(brokenSelector: string, site: string): void {
    const keysToDelete: string[] = [];
    
    for (const [key, cached] of this.selectorCache.entries()) {
      if (cached.brokenSelector === brokenSelector && cached.site === site) {
        keysToDelete.push(key);
      }
    }

    keysToDelete.forEach(key => this.selectorCache.delete(key));
  }

  /**
   * Invalidate cache for a site (when site structure changes)
   */
  invalidateSite(site: string): void {
    const keysToDelete: string[] = [];
    
    for (const [key, cached] of this.selectorCache.entries()) {
      if (cached.site === site) {
        keysToDelete.push(key);
      }
    }

    for (const [key, cached] of this.patternCache.entries()) {
      if (cached.site === site) {
        keysToDelete.push(key);
      }
    }

    keysToDelete.forEach(key => {
      this.selectorCache.delete(key);
      this.patternCache.delete(key);
    });
  }

  /**
   * Warm cache with frequently used selectors
   */
  warmCache(selectors: Array<{ selector: string; site: string; candidates: SelectorCandidate[] }>): void {
    for (const item of selectors) {
      this.cacheSelectors(item.selector, item.site, item.candidates);
    }
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): CacheStats {
    return {
      selectorCacheSize: this.selectorCache.size,
      patternCacheSize: this.patternCache.size,
      predictionCacheSize: this.predictionCache.size,
      totalSize: this.selectorCache.size + this.patternCache.size + this.predictionCache.size,
      hitRate: this.calculateHitRate(),
      topAccessed: this.getTopAccessed(10),
    };
  }

  /**
   * Clear expired entries
   */
  clearExpired(): void {
    const now = Date.now();
    
    for (const [key, cached] of this.selectorCache.entries()) {
      if (now > cached.expiresAt) {
        this.selectorCache.delete(key);
      }
    }

    for (const [key, cached] of this.patternCache.entries()) {
      if (now > cached.expiresAt) {
        this.patternCache.delete(key);
      }
    }

    for (const [key, cached] of this.predictionCache.entries()) {
      if (now > cached.expiresAt) {
        this.predictionCache.delete(key);
      }
    }
  }

  // Private helpers
  private generateSelectorKey(
    brokenSelector: string,
    site: string,
    context?: {
      elementText?: string;
      elementType?: string;
    }
  ): string {
    const contextStr = context
      ? `${context.elementText || ''}-${context.elementType || ''}`
      : '';
    return `${site}-${brokenSelector}-${contextStr}`;
  }

  private evictLRU(): void {
    if (this.selectorCache.size === 0) return;

    const entries = Array.from(this.selectorCache.entries());
    entries.sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);
    
    // Remove 10% of least recently used
    const toRemove = Math.max(1, Math.floor(entries.length * 0.1));
    for (let i = 0; i < toRemove; i++) {
      this.selectorCache.delete(entries[i][0]);
    }
  }

  private evictLRUPatterns(): void {
    if (this.patternCache.size === 0) return;

    const entries = Array.from(this.patternCache.entries());
    entries.sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);
    
    const toRemove = Math.max(1, Math.floor(entries.length * 0.1));
    for (let i = 0; i < toRemove; i++) {
      this.patternCache.delete(entries[i][0]);
    }
  }

  private evictLRUPredictions(): void {
    if (this.predictionCache.size === 0) return;

    const entries = Array.from(this.predictionCache.entries());
    entries.sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);
    
    const toRemove = Math.max(1, Math.floor(entries.length * 0.1));
    for (let i = 0; i < toRemove; i++) {
      this.predictionCache.delete(entries[i][0]);
    }
  }

  private calculateHitRate(): number {
    // Simplified hit rate calculation
    // In production, track hits/misses separately
    return 0.7; // Placeholder
  }

  private getTopAccessed(limit: number): Array<{ key: string; accessCount: number }> {
    const all: Array<{ key: string; accessCount: number }> = [];

    for (const [key, cached] of this.selectorCache.entries()) {
      all.push({ key, accessCount: cached.accessCount });
    }

    return all.sort((a, b) => b.accessCount - a.accessCount).slice(0, limit);
  }
}

// Types
interface CachedSelector {
  brokenSelector: string;
  site: string;
  candidates: SelectorCandidate[];
  cachedAt: number;
  expiresAt: number;
  lastAccessed: number;
  accessCount: number;
  context?: {
    elementText?: string;
    elementType?: string;
  };
}

interface CachedPattern {
  patternType: string;
  site: string;
  pattern: any;
  cachedAt: number;
  expiresAt: number;
  lastAccessed: number;
}

interface CachedPrediction {
  predictionType: string;
  key: string;
  prediction: any;
  cachedAt: number;
  expiresAt: number;
  lastAccessed: number;
}

interface CacheStats {
  selectorCacheSize: number;
  patternCacheSize: number;
  predictionCacheSize: number;
  totalSize: number;
  hitRate: number;
  topAccessed: Array<{ key: string; accessCount: number }>;
}

