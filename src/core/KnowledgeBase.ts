import type {
  SelectorHistory,
  SkillTemplate,
  CanonicalAction,
  SkillSpec,
  ExecutionResult,
  SelectorStrategy,
} from '../types/index.js';
import type { KnowledgeBaseAdapter } from './KnowledgeBaseAdapter.js';
import { JSONAdapter } from './adapters/JSONAdapter.js';
import { PostgreSQLAdapter } from './adapters/PostgreSQLAdapter.js';

/**
 * Knowledge Base: Learns from all recordings and builds reusable patterns
 * 
 * This is the "AI brain" that:
 * - Studies all recordings to identify patterns
 * - Learns site-specific selectors and strategies
 * - Builds skill templates that improve over time
 * - Analyzes what works and what doesn't
 * 
 * Supports multiple storage backends:
 * - JSON file (simple, good for development)
 * - PostgreSQL (scales to millions of patterns)
 */
export class KnowledgeBase {
  private selectorHistory: Map<string, SelectorHistory[]> = new Map(); // site -> history[]
  private skillTemplates: Map<string, SkillTemplate> = new Map(); // intent -> template
  private sitePatterns: Map<string, SitePattern> = new Map(); // site -> patterns
  private urlPatterns: Map<string, UrlPattern> = new Map(); // url -> pattern (learned actions for this URL)
  private adapter: KnowledgeBaseAdapter;
  private saveDebounceTimer?: NodeJS.Timeout;

  constructor(adapter?: KnowledgeBaseAdapter, persistencePath?: string) {
    // Use provided adapter or auto-detect based on environment
    if (adapter) {
      this.adapter = adapter;
    } else if (process.env.DATABASE_URL || process.env.KNOWLEDGE_STORAGE === 'postgresql') {
      // Use PostgreSQL if DATABASE_URL is set
      this.adapter = new PostgreSQLAdapter(process.env.DATABASE_URL);
    } else {
      // Default to JSON for simplicity
      this.adapter = new JSONAdapter(persistencePath);
    }

    this.initialize();
  }

  private async initialize(): Promise<void> {
    await this.adapter.initialize();
    await this.loadFromAdapter();
  }

  /**
   * Learn from a completed job - extract patterns and update knowledge
   */
  async learnFromJob(
    site: string,
    actions: CanonicalAction[],
    result: ExecutionResult,
    recorderJSON: any
  ): Promise<void> {
    // Learn selector patterns
    this.learnSelectorPatterns(site, actions, result);

    // Learn skill templates
    this.learnSkillTemplates(site, actions, result);

    // Learn site-specific patterns
    await this.learnSitePatterns(site, actions, recorderJSON, result);

    // Persist knowledge (debounced to avoid too many writes)
    this.debouncedSave();
  }

  /**
   * Debounced save to avoid too many writes
   */
  private debouncedSave(): void {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }

    this.saveDebounceTimer = setTimeout(() => {
      this.saveToAdapter();
    }, 2000); // Save after 2 seconds of inactivity
  }

  /**
   * Learn selector patterns from successful executions
   */
  private learnSelectorPatterns(
    site: string,
    actions: CanonicalAction[],
    result: ExecutionResult
  ): void {
    // site is used in the function body
    if (!this.selectorHistory.has(site)) {
      this.selectorHistory.set(site, []);
    }

    const history = this.selectorHistory.get(site)!;

    // Extract selectors from actions
    for (const action of actions) {
      for (const step of action.steps) {
        if (step.target?.selector) {
          const selector = step.target.selector;
          const strategy = step.target.strategy || 'css';

          // Check if this selector was successful
          // Note: We check if the command succeeded, not the selector directly
          const wasSuccessful = result.commands?.some(
            cmd => cmd.status === 'success' && cmd.command?.args?.[0] === selector
          ) || false;

          // Find or create history entry
          let entry = history.find(
            h => h.originalSelector === selector && h.strategy === strategy
          );

          if (!entry) {
            entry = {
              site,
              originalSelector: selector,
              healedSelector: selector, // Initially same
              strategy: strategy as SelectorStrategy,
              successCount: 0,
              failureCount: 0,
              lastUsed: Date.now(),
            };
            history.push(entry);
          }

          // Update statistics
          if (wasSuccessful) {
            entry.successCount++;
          } else {
            entry.failureCount++;
          }
          entry.lastUsed = Date.now();
        }
      }
    }
  }

  /**
   * Learn skill templates from repeated successful patterns
   */
  private learnSkillTemplates(
    _site: string,
    actions: CanonicalAction[],
    result: ExecutionResult
  ): void {
    const wasSuccessful = result.status === 'success';

    for (const action of actions) {
      const intent = action.intent;
      const existing = this.skillTemplates.get(intent);

      if (wasSuccessful) {
        // Update or create skill template
        if (existing) {
          existing.usageCount++;
          existing.successRate =
            (existing.successRate * (existing.usageCount - 1) + 1) / existing.usageCount;
          existing.lastUpdated = Date.now();

          // Merge and improve skill spec based on new successful pattern
          existing.skillSpec = this.mergeSkillSpecs(existing.skillSpec, action);
        } else {
          // Create new template from this successful action
          this.skillTemplates.set(intent, {
            intent,
            skillSpec: this.actionToSkillSpec(action),
            successRate: 1.0,
            usageCount: 1,
            lastUpdated: Date.now(),
          });
        }
      } else if (existing) {
        // Update failure rate
        existing.usageCount++;
        existing.successRate =
          (existing.successRate * (existing.usageCount - 1) + 0) / existing.usageCount;
      }
    }
  }

  /**
   * Learn site-specific patterns (common flows, selectors, structures)
   */
  private async learnSitePatterns(
    site: string,
    actions: CanonicalAction[],
    recorderJSON: any,
    result: ExecutionResult
  ): Promise<void> {
    let pattern = this.sitePatterns.get(site);
    if (!pattern) {
      // Try loading from adapter first
      pattern = (await this.adapter.getSitePattern(site)) ?? undefined;
      if (!pattern) {
        pattern = {
          site,
          commonIntents: new Map(),
          commonSelectors: new Map(),
          commonFlows: [],
          successRate: 0,
          totalJobs: 0,
          lastUpdated: Date.now(),
        };
      }
      this.sitePatterns.set(site, pattern);
    }
    pattern.totalJobs++;
    pattern.lastUpdated = Date.now();

    if (result.status === 'success') {
      pattern.successRate =
        (pattern.successRate * (pattern.totalJobs - 1) + 1) / pattern.totalJobs;
    } else {
      pattern.successRate =
        (pattern.successRate * (pattern.totalJobs - 1) + 0) / pattern.totalJobs;
    }

    // Track common intents for this site
    for (const action of actions) {
      const count = pattern.commonIntents.get(action.intent) || 0;
      pattern.commonIntents.set(action.intent, count + 1);
    }

    // Track common selectors
    for (const action of actions) {
      for (const step of action.steps) {
        if (step.target?.selector) {
          const selector = step.target.selector;
          const count = pattern.commonSelectors.get(selector) || 0;
          pattern.commonSelectors.set(selector, count + 1);
        }
      }
    }

    // Track common flows (sequence of intents)
    const flow = actions.map(a => a.intent).join(' -> ');
    if (!pattern.commonFlows.includes(flow)) {
      pattern.commonFlows.push(flow);
    }

    // Learn URL patterns from recorder JSON
    this.learnUrlPatterns(recorderJSON, actions, result);
  }

  /**
   * Learn URL patterns - track what actions are associated with each URL
   */
  private learnUrlPatterns(
    recorderJSON: any,
    actions: CanonicalAction[],
    result: ExecutionResult
  ): void {
    // Extract URLs from recorder JSON steps
    const urls: string[] = [];
    
    if (recorderJSON.steps) {
      for (const step of recorderJSON.steps) {
        if (step.type === 'navigate' && step.url) {
          urls.push(step.url);
        }
      }
    }

    // Also check if recorder JSON has a main URL
    if (recorderJSON.url) {
      urls.push(recorderJSON.url);
    }

    // Store URL patterns
    for (const url of urls) {
      if (!this.urlPatterns.has(url)) {
        this.urlPatterns.set(url, {
          url,
          intents: [],
          selectors: new Map(),
          successRate: result.status === 'success' ? 1.0 : 0.0,
          usageCount: 1,
          lastUsed: Date.now(),
        });
      }

      const urlPattern = this.urlPatterns.get(url)!;
      urlPattern.usageCount++;
      urlPattern.lastUsed = Date.now();

      // Update success rate
      if (result.status === 'success') {
        urlPattern.successRate =
          (urlPattern.successRate * (urlPattern.usageCount - 1) + 1) / urlPattern.usageCount;
      } else {
        urlPattern.successRate =
          (urlPattern.successRate * (urlPattern.usageCount - 1) + 0) / urlPattern.usageCount;
      }

      // Track intents for this URL
      for (const action of actions) {
        if (!urlPattern.intents.includes(action.intent)) {
          urlPattern.intents.push(action.intent);
        }
      }

      // Track selectors for this URL
      for (const action of actions) {
        for (const step of action.steps) {
          if (step.target?.selector) {
            const selector = step.target.selector;
            const count = urlPattern.selectors.get(selector) || 0;
            urlPattern.selectors.set(selector, count + 1);
          }
        }
      }
    }
  }

  /**
   * Get best selector for a site based on learned history
   */
  async getBestSelector(site: string, originalSelector: string): Promise<SelectorHistory | null> {
    const history = this.selectorHistory.get(site) || await this.adapter.getSelectorHistory(site);
    if (!history || history.length === 0) return null;

    // Cache in memory for faster access
    if (!this.selectorHistory.has(site)) {
      this.selectorHistory.set(site, history);
    }

    // Find selectors that match or were healed from this original
    const candidates = history.filter(
      h => h.originalSelector === originalSelector || h.healedSelector === originalSelector
    );

    if (candidates.length === 0) return null;

    // Return the one with best success rate
    return candidates.reduce((best, current) => {
      const bestRate = best.successCount / (best.successCount + best.failureCount || 1);
      const currentRate = current.successCount / (current.successCount + current.failureCount || 1);
      return currentRate > bestRate ? current : best;
    });
  }

  /**
   * Record selector success - update selector history with successful usage
   */
  async recordSelectorSuccess(site: string, selector: string): Promise<void> {
    if (!this.selectorHistory.has(site)) {
      this.selectorHistory.set(site, []);
    }

    const history = this.selectorHistory.get(site)!;
    const entry = history.find(h => h.originalSelector === selector || h.healedSelector === selector);

    if (entry) {
      entry.successCount++;
      entry.lastUsed = Date.now();
    } else {
      // Create new entry
      history.push({
        site,
        originalSelector: selector,
        healedSelector: selector,
        strategy: 'css',
        successCount: 1,
        failureCount: 0,
        lastUsed: Date.now(),
      });
    }

    this.debouncedSave();
  }

  /**
   * Record selector failure - update selector history with failed usage
   */
  async recordSelectorFailure(site: string, selector: string): Promise<void> {
    if (!this.selectorHistory.has(site)) {
      this.selectorHistory.set(site, []);
    }

    const history = this.selectorHistory.get(site)!;
    const entry = history.find(h => h.originalSelector === selector || h.healedSelector === selector);

    if (entry) {
      entry.failureCount++;
      entry.lastUsed = Date.now();
    } else {
      // Create new entry
      history.push({
        site,
        originalSelector: selector,
        healedSelector: selector,
        strategy: 'css',
        successCount: 0,
        failureCount: 1,
        lastUsed: Date.now(),
      });
    }

    this.debouncedSave();
  }

  /**
   * Record successful flow - update site patterns with successful intent sequence
   */
  async recordSuccessfulFlow(site: string, flow: string): Promise<void> {
    let pattern = this.sitePatterns.get(site);
    if (!pattern) {
      pattern = (await this.adapter.getSitePattern(site)) ?? undefined;
      if (!pattern) {
        pattern = {
          site,
          commonIntents: new Map(),
          commonSelectors: new Map(),
          commonFlows: [],
          successRate: 0,
          totalJobs: 0,
          lastUpdated: Date.now(),
        };
      }
      this.sitePatterns.set(site, pattern);
    }

    if (!pattern.commonFlows.includes(flow)) {
      pattern.commonFlows.push(flow);
    }
    pattern.lastUpdated = Date.now();

    this.debouncedSave();
  }

  /**
   * Record cross-site pattern - patterns that work across multiple sites
   */
  async recordCrossSitePattern(pattern: {
    intent: string;
    commonSelectors: string[];
    siteCount: number;
    successRate: number;
    lastUsed: number;
  }): Promise<void> {
    // This could be stored as a skill template or a special cross-site pattern
    // For now, we'll create/update a skill template with this pattern
    const existing = this.skillTemplates.get(pattern.intent);
    
    if (existing) {
      // Update existing template if this cross-site pattern is better
      if (pattern.successRate > existing.successRate) {
        existing.successRate = pattern.successRate;
        existing.lastUpdated = pattern.lastUsed;
      }
    } else {
      // Create a new skill template from the cross-site pattern
      // Note: We need to construct a SkillSpec from the pattern
      // For now, create a minimal template
      this.skillTemplates.set(pattern.intent, {
        intent: pattern.intent,
        skillSpec: {
          name: pattern.intent,
          description: `Cross-site pattern for ${pattern.intent} (works on ${pattern.siteCount} sites)`,
          inputs: [],
          outputs: [],
          steps: [], // Would need to be populated from the pattern
          retryPolicy: {
            maxRetries: 3,
            backoff: 'exponential',
            baseDelay: 1000,
          },
          safetyChecks: [],
        },
        successRate: pattern.successRate,
        usageCount: pattern.siteCount,
        lastUpdated: pattern.lastUsed,
      });
    }

    this.debouncedSave();
  }

  /**
   * Get learned skill template for an intent
   */
  async getSkillTemplate(intent: string): Promise<SkillTemplate | null> {
    if (this.skillTemplates.has(intent)) {
      return this.skillTemplates.get(intent)!;
    }

    // Load from adapter if not in memory
    const template = await this.adapter.getSkillTemplate(intent);
    if (template) {
      this.skillTemplates.set(intent, template);
    }
    return template;
  }

  /**
   * Get site-specific patterns
   */
  async getSitePatterns(site: string): Promise<SitePattern | null> {
    if (this.sitePatterns.has(site)) {
      return this.sitePatterns.get(site)!;
    }

    // Load from adapter if not in memory
    const pattern = await this.adapter.getSitePattern(site);
    if (pattern) {
      this.sitePatterns.set(site, pattern);
    }
    return pattern;
  }

  /**
   * Get all learned intents for a site
   */
  async getSiteIntents(site: string): Promise<string[]> {
    const pattern = await this.getSitePatterns(site);
    if (!pattern) return [];

    // Return intents sorted by frequency
    return Array.from(pattern.commonIntents.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([intent]) => intent);
  }

  /**
   * Check if URL is known (has been recorded/automated before)
   */
  getKnownUrl(url: string): UrlPattern | null {
    // Check exact match first
    if (this.urlPatterns.has(url)) {
      return this.urlPatterns.get(url)!;
    }

    // Check for URL pattern matches (same path, different query params)
    const urlObj = new URL(url);
    const baseUrl = `${urlObj.protocol}//${urlObj.hostname}${urlObj.pathname}`;

    for (const [knownUrl, pattern] of this.urlPatterns.entries()) {
      try {
        const knownUrlObj = new URL(knownUrl);
        const knownBaseUrl = `${knownUrlObj.protocol}//${knownUrlObj.hostname}${knownUrlObj.pathname}`;
        
        if (baseUrl === knownBaseUrl) {
          return pattern;
        }
      } catch {
        // Invalid URL, skip
      }
    }

    return null;
  }

  /**
   * Get learned actions for a known URL
   */
  getUrlActions(url: string): {
    intents: string[];
    selectors: string[];
    successRate: number;
  } | null {
    const urlPattern = this.getKnownUrl(url);
    if (!urlPattern) return null;

    return {
      intents: urlPattern.intents,
      selectors: Array.from(urlPattern.selectors.keys()),
      successRate: urlPattern.successRate,
    };
  }

  /**
   * Get statistics about learning
   */
  getStatistics(): KnowledgeBaseStats {
    const totalSites = this.sitePatterns.size;
    const totalSkills = this.skillTemplates.size;
    const totalSelectors = Array.from(this.selectorHistory.values()).reduce(
      (sum, history) => sum + history.length,
      0
    );

    const avgSuccessRate =
      Array.from(this.skillTemplates.values()).reduce(
        (sum, template) => sum + template.successRate,
        0
      ) / totalSkills || 0;

    return {
      totalSites,
      totalSkills,
      totalSelectors,
      avgSkillSuccessRate: avgSuccessRate,
      sites: Array.from(this.sitePatterns.keys()),
    };
  }

  // Helper methods

  private actionToSkillSpec(action: CanonicalAction): SkillSpec {
    return {
      name: action.intent,
      description: `Learned ${action.intent} skill`,
      inputs: [],
      outputs: [],
      steps: action.steps,
      retryPolicy: {
        maxRetries: 3,
        backoff: 'exponential',
        baseDelay: 1000,
      },
      safetyChecks: [],
    };
  }

  private mergeSkillSpecs(existing: SkillSpec, action: CanonicalAction): SkillSpec {
    // Merge steps, keeping the most successful patterns
    return {
      ...existing,
      steps: action.steps, // Use latest successful pattern
      lastUpdated: Date.now(),
    } as SkillSpec;
  }


  private async saveToAdapter(): Promise<void> {
    try {
      // Save selector histories
      for (const [site, history] of this.selectorHistory.entries()) {
        await this.adapter.saveSelectorHistory(site, history);
      }

      // Save skill templates
      for (const [intent, template] of this.skillTemplates.entries()) {
        await this.adapter.saveSkillTemplate(intent, template);
      }

      // Save site patterns
      for (const [site, pattern] of this.sitePatterns.entries()) {
        await this.adapter.saveSitePattern(site, pattern);
      }
    } catch (error) {
      console.error('Failed to save knowledge base:', error);
    }
  }

  private async loadFromAdapter(): Promise<void> {
    try {
      // Load all data from adapter
      const [selectorHistories, skillTemplates, sitePatterns] = await Promise.all([
        this.adapter.getAllSelectorHistories(),
        this.adapter.getAllSkillTemplates(),
        this.adapter.getAllSitePatterns(),
      ]);

      this.selectorHistory = selectorHistories;
      this.skillTemplates = skillTemplates;
      this.sitePatterns = sitePatterns;
    } catch (error) {
      console.error('Failed to load knowledge base:', error);
    }
  }

  /**
   * Close adapter connection (for database adapters)
   */
  async close(): Promise<void> {
    // Save any pending changes
    await this.saveToAdapter();
    await this.adapter.close();
  }
}

/**
 * Site-specific pattern data
 */
export interface SitePattern {
  site: string;
  commonIntents: Map<string, number>; // intent -> frequency
  commonSelectors: Map<string, number>; // selector -> frequency
  commonFlows: string[]; // common intent sequences
  successRate: number;
  totalJobs: number;
  lastUpdated: number;
}

/**
 * URL-specific pattern data
 */
export interface UrlPattern {
  url: string;
  intents: string[]; // intents associated with this URL
  selectors: Map<string, number>; // selector -> frequency
  successRate: number;
  usageCount: number;
  lastUsed: number;
}

/**
 * Knowledge base statistics
 */
export interface KnowledgeBaseStats {
  totalSites: number;
  totalSkills: number;
  totalSelectors: number;
  avgSkillSuccessRate: number;
  sites: string[];
}

