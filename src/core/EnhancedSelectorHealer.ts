import type { SelectorCandidate, SelectorStrategy } from '../types/index.js';
import type { KnowledgeBase } from './KnowledgeBase.js';
import type { Page } from 'playwright';
import { AdvancedCache } from './AdvancedCache.js';
import { VisualMatcher } from './VisualMatcher.js';
import { OCRMatcher } from './OCRMatcher.js';

/**
 * Enhanced Selector Healer with advanced strategies:
 * - Multi-dimensional scoring
 * - Structure-based matching
 * - Semantic HTML matching
 * - Relative positioning
 * - Visual/positional matching
 * - Stability tracking
 */
export class EnhancedSelectorHealer {
  private selectorHistory: Map<string, SelectorCandidate[]> = new Map();
  private knowledgeBase?: KnowledgeBase;
  private stabilityCache: Map<string, number> = new Map(); // selector -> stability score
  private cache: AdvancedCache;
  private visualMatcher: VisualMatcher;
  private ocrMatcher: OCRMatcher;
  private selectorPredictions: Map<string, { stability: number; breakageProbability: number; lastUpdated: number }> = new Map();

  constructor(knowledgeBase?: KnowledgeBase) {
    this.knowledgeBase = knowledgeBase;
    this.cache = new AdvancedCache();
    this.visualMatcher = new VisualMatcher();
    this.ocrMatcher = new OCRMatcher();
  }

  /**
   * Enhanced healing with multiple strategies
   */
  async healSelector(
    brokenSelector: string,
    page: Page,
    context?: {
      site?: string;
      elementText?: string;
      elementAttributes?: Record<string, string>;
      elementType?: string; // 'input', 'button', 'link', etc.
    }
  ): Promise<SelectorCandidate[]> {
    // Check cache first
    if (context?.site) {
      const cached = this.cache.getCachedSelectors(brokenSelector, context.site, {
        elementText: context.elementText,
        elementType: context.elementType,
      });
      
      if (cached && cached.length > 0) {
        return cached; // Return cached candidates
      }
    }

    const candidates: SelectorCandidate[] = [];

    // Strategy 0: Check learned patterns from KnowledgeBase (highest priority)
    if (this.knowledgeBase && context?.site) {
      const learned = await this.knowledgeBase.getBestSelector(context.site, brokenSelector);
      if (learned && learned.successCount > learned.failureCount) {
        candidates.push({
          selector: learned.healedSelector,
          strategy: learned.strategy,
          score: 0.95,
          factors: {
            textMatch: 0,
            attributeMatch: 0,
            domDepth: 0,
            roleMatch: 0,
            historyScore: 0.95,
            stabilityScore: await this.getStabilityScore(learned.healedSelector, context.site),
            uniquenessScore: this.calculateUniqueness(learned.healedSelector),
          },
          metadata: {
            generatedAt: Date.now(),
            source: 'learned',
            confidence: learned.successCount / (learned.successCount + learned.failureCount),
          },
        });
      }
    }

    // Strategy 1: Stable attributes (name, placeholder, aria-label, role, data-testid)
    if (context?.elementAttributes) {
      const stableCandidates = await this.generateStableAttributeSelectors(
        context.elementAttributes,
        context.site
      );
      candidates.push(...stableCandidates);
    }

    // Strategy 2: Text-based matching
    if (context?.elementText) {
      const textCandidates = this.generateTextSelectors(context.elementText);
      candidates.push(...textCandidates);
    }

    // Strategy 3: Structure-based (relative positioning)
    const structureCandidates = await this.generateStructureSelectors(
      page,
      brokenSelector,
      context
    );
    candidates.push(...structureCandidates);

    // Strategy 4: Semantic HTML matching
    const semanticCandidates = await this.generateSemanticSelectors(
      page,
      context
    );
    candidates.push(...semanticCandidates);

    // Strategy 5: Visual/positional matching
    const visualCandidates = await this.generateVisualSelectors(
      page,
      brokenSelector,
      context
    );
    candidates.push(...visualCandidates);

    // Strategy 6: Fallback heuristics
    const heuristicCandidates = this.generateHeuristicSelectors(brokenSelector);
    candidates.push(...heuristicCandidates);

    // Enhanced scoring with multi-dimensional factors
    const scored = await Promise.all(
      candidates.map(async (c) => ({
        ...c,
        score: await this.scoreSelectorEnhanced(c, page, context),
      }))
    );

    // Apply history boost
    if (context?.site) {
      const history = this.selectorHistory.get(context.site);
      if (history) {
        scored.forEach((candidate) => {
          const historical = history.find((h) => h.selector === candidate.selector);
          if (historical) {
            candidate.score += historical.factors.historyScore * 0.15;
            candidate.factors.historyScore = historical.factors.historyScore;
          }
        });
      }
    }

    // Sort by score (descending) and remove duplicates
    const unique = this.deduplicateCandidates(scored);
    unique.sort((a, b) => b.score - a.score);

    const topCandidates = unique.slice(0, 10); // Return top 10 candidates

    // Cache the results
    if (context?.site && topCandidates.length > 0) {
      this.cache.cacheSelectors(
        brokenSelector,
        context.site,
        topCandidates,
        {
          elementText: context.elementText,
          elementType: context.elementType,
        }
      );
    }

    return topCandidates;
  }

  /**
   * Generate selectors based on stable attributes with enhanced scoring
   */
  private async generateStableAttributeSelectors(
    attributes: Record<string, string>,
    site?: string
  ): Promise<SelectorCandidate[]> {
    const candidates: SelectorCandidate[] = [];

    // Priority order: data-testid > name > aria-label > placeholder > role > id
    const stableAttrs = [
      { name: 'data-testid', priority: 1.0, strategy: 'testId' as SelectorStrategy },
      { name: 'name', priority: 0.9, strategy: 'css' as SelectorStrategy },
      { name: 'aria-label', priority: 0.85, strategy: 'css' as SelectorStrategy },
      { name: 'placeholder', priority: 0.8, strategy: 'css' as SelectorStrategy },
      { name: 'role', priority: 0.75, strategy: 'role' as SelectorStrategy },
      { name: 'id', priority: 0.7, strategy: 'css' as SelectorStrategy },
      { name: 'aria-labelledby', priority: 0.65, strategy: 'css' as SelectorStrategy },
      { name: 'data-cy', priority: 0.9, strategy: 'css' as SelectorStrategy }, // Cypress test ID
      { name: 'data-test', priority: 0.9, strategy: 'css' as SelectorStrategy },
    ];

    for (const attr of stableAttrs) {
      if (attributes[attr.name]) {
        let selector: string;
        if (attr.name === 'data-testid' || attr.name === 'data-cy' || attr.name === 'data-test') {
          selector = `[${attr.name}="${attributes[attr.name]}"]`;
        } else if (attr.name === 'id') {
          selector = `#${attributes[attr.name]}`;
        } else if (attr.name === 'role') {
          selector = `[role="${attributes[attr.name]}"]`;
        } else {
          selector = `[${attr.name}="${attributes[attr.name]}"]`;
        }

        const stabilityScore = site ? await this.getStabilityScore(selector, site) : 0.5;
        const uniquenessScore = this.calculateUniqueness(selector);

        candidates.push({
          selector,
          strategy: attr.strategy,
          score: 0,
          factors: {
            textMatch: 0,
            attributeMatch: attr.priority,
            domDepth: 0,
            roleMatch: attr.name === 'role' ? 0.2 : 0,
            historyScore: 0,
            stabilityScore,
            uniquenessScore,
          },
          metadata: {
            generatedAt: Date.now(),
            source: 'structure',
            confidence: attr.priority,
          },
        });
      }
    }

    return candidates;
  }

  /**
   * Generate text-based selectors with improved matching
   */
  private generateTextSelectors(text: string): SelectorCandidate[] {
    const candidates: SelectorCandidate[] = [];
    const normalized = text.trim().toLowerCase();

    if (normalized.length === 0) return candidates;

    // Exact text match (highest priority)
    candidates.push({
      selector: `text="${text}"`,
      strategy: 'text',
      score: 0,
      factors: {
        textMatch: 0.4,
        attributeMatch: 0,
        domDepth: 0,
        roleMatch: 0,
        historyScore: 0,
        uniquenessScore: 0.8,
      },
      metadata: {
        generatedAt: Date.now(),
        source: 'text',
        confidence: 0.9,
      },
    });

    // Case-insensitive exact match
    candidates.push({
      selector: `text=/^${this.escapeRegex(text)}$/i`,
      strategy: 'text',
      score: 0,
      factors: {
        textMatch: 0.35,
        attributeMatch: 0,
        domDepth: 0,
        roleMatch: 0,
        historyScore: 0,
        uniquenessScore: 0.75,
      },
      metadata: {
        generatedAt: Date.now(),
        source: 'text',
        confidence: 0.85,
      },
    });

    // Partial text match (for buttons/links with icons)
    if (normalized.length > 3) {
      candidates.push({
        selector: `text=/.*${this.escapeRegex(normalized)}.*/i`,
        strategy: 'text',
        score: 0,
        factors: {
          textMatch: 0.25,
          attributeMatch: 0,
          domDepth: 0,
          roleMatch: 0,
          historyScore: 0,
          uniquenessScore: 0.5,
        },
        metadata: {
          generatedAt: Date.now(),
          source: 'text',
          confidence: 0.7,
        },
      });
    }

    return candidates;
  }

  /**
   * Generate structure-based selectors (relative positioning)
   */
  private async generateStructureSelectors(
    page: Page,
    brokenSelector: string,
    context?: {
      site?: string;
      elementType?: string;
    }
  ): Promise<SelectorCandidate[]> {
    const candidates: SelectorCandidate[] = [];

    try {
      // Try to find element by label association (for inputs)
      if (context?.elementType === 'input' || brokenSelector.includes('input')) {
        // Find input by associated label
        const labelSelectors = await page.evaluate(() => {
          const inputs = Array.from(document.querySelectorAll('input, textarea, select'));
          const results: string[] = [];

          for (const input of inputs) {
            const id = input.getAttribute('id');
            if (id) {
              const label = document.querySelector(`label[for="${id}"]`);
              if (label) {
                const labelText = label.textContent?.trim();
                if (labelText) {
                  results.push(`input:has(+ label:has-text("${labelText}"))`);
                  results.push(`label:has-text("${labelText}") + input`);
                }
              }
            }

            // Check for parent label
            const parentLabel = input.closest('label');
            if (parentLabel) {
              const labelText = parentLabel.textContent?.trim();
              if (labelText) {
                results.push(`label:has-text("${labelText}") input`);
              }
            }
          }

          return results;
        });

        for (const selector of labelSelectors) {
          candidates.push({
            selector,
            strategy: 'css',
            score: 0,
            factors: {
              textMatch: 0,
              attributeMatch: 0.2,
              domDepth: 0.15,
              roleMatch: 0,
              historyScore: 0,
              stabilityScore: context?.site ? await this.getStabilityScore(selector, context.site) : 0.5,
              uniquenessScore: this.calculateUniqueness(selector),
            },
            metadata: {
              generatedAt: Date.now(),
              source: 'structure',
              confidence: 0.7,
            },
          });
        }
      }

      // Try to find by sibling elements (brokenSelector not used in this strategy)
      const siblingSelectors = await this.generateSiblingSelectors(page, brokenSelector);
      candidates.push(...siblingSelectors);

      // Try to find by parent container
      const parentSelectors = await this.generateParentSelectors(page, brokenSelector);
      candidates.push(...parentSelectors);
    } catch (error) {
      console.warn('Error generating structure selectors:', error);
    }

    return candidates;
  }

  /**
   * Generate selectors based on semantic HTML
   */
  private async generateSemanticSelectors(
    page: Page,
    context?: {
      elementType?: string;
      elementText?: string;
    }
  ): Promise<SelectorCandidate[]> {
    const candidates: SelectorCandidate[] = [];

    try {
      // Use semantic HTML elements
      const semanticElements = ['nav', 'main', 'article', 'section', 'header', 'footer', 'aside'];
      const semanticSelectors = await page.evaluate((elements) => {
        const results: string[] = [];
        for (const el of elements) {
          const found = document.querySelectorAll(el);
          if (found.length > 0) {
            results.push(el);
          }
        }
        return results;
      }, semanticElements);

      for (const selector of semanticSelectors) {
        if (context?.elementType) {
          candidates.push({
            selector: `${selector} ${context.elementType}`,
            strategy: 'css',
            score: 0,
            factors: {
              textMatch: 0,
              attributeMatch: 0.15,
              domDepth: 0.1,
              roleMatch: 0.1,
              historyScore: 0,
              uniquenessScore: 0.6,
            },
            metadata: {
              generatedAt: Date.now(),
              source: 'semantic',
              confidence: 0.65,
            },
          });
        }
      }

      // Use ARIA landmarks
      const ariaRoles = ['button', 'link', 'textbox', 'searchbox', 'navigation', 'main'];
      for (const role of ariaRoles) {
        candidates.push({
          selector: `[role="${role}"]`,
          strategy: 'role',
          score: 0,
          factors: {
            textMatch: 0,
            attributeMatch: 0.1,
            domDepth: 0,
            roleMatch: 0.2,
            historyScore: 0,
            uniquenessScore: 0.4,
          },
          metadata: {
            generatedAt: Date.now(),
            source: 'semantic',
            confidence: 0.5,
          },
        });
      }
    } catch (error) {
      console.warn('Error generating semantic selectors:', error);
    }

    return candidates;
  }

  /**
   * Generate visual/positional selectors
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async _generateVisualSelectorsLegacy(
    page: Page,
    brokenSelector: string,
    _context?: {
      site?: string;
    }
  ): Promise<SelectorCandidate[]> {
    const candidates: SelectorCandidate[] = [];

    try {
      // Try to find by position relative to viewport
      const positionData = await page.evaluate(() => {
        const elements = Array.from(document.querySelectorAll('*'));
        return elements.map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            tag: el.tagName.toLowerCase(),
            position: {
              top: rect.top,
              left: rect.left,
              width: rect.width,
              height: rect.height,
            },
            visible: rect.width > 0 && rect.height > 0 && rect.top >= 0,
          };
        });
      });

      // Find elements in similar positions (could be the same element with different selector)
      // This is a simplified version - in production, would use more sophisticated matching
      if (positionData.length > 0) {
        // Try to match by tag and approximate position
        const tagMatch = brokenSelector.match(/^(\w+)/);
        if (tagMatch) {
          const tag = tagMatch[1];
          const matchingElements = positionData.filter((d) => d.tag === tag && d.visible);
          if (matchingElements.length > 0) {
            // Use nth-of-type for positional matching
            candidates.push({
              selector: `${tag}:nth-of-type(${matchingElements.length})`,
              strategy: 'css',
              score: 0,
              factors: {
                textMatch: 0,
                attributeMatch: 0.1,
                domDepth: 0.05,
                roleMatch: 0,
                historyScore: 0,
                uniquenessScore: 0.3,
              },
              metadata: {
                generatedAt: Date.now(),
                source: 'visual',
                confidence: 0.4,
              },
            });
          }
        }
      }
    } catch (error) {
      console.warn('Error generating visual selectors:', error);
    }

    return candidates;
  }

  /**
   * New visual matching using VisualMatcher heuristic (no external CV deps)
   */
  private async generateVisualSelectors(
    page: Page,
    brokenSelector: string,
    context?: {
      site?: string;
    }
  ): Promise<SelectorCandidate[]> {
    const candidates: SelectorCandidate[] = [];

    try {
      // Keep legacy heuristic as fallback for additional coverage
      const legacy = await this._generateVisualSelectorsLegacy(page, brokenSelector, context);
      candidates.push(...legacy);

      const visualMatches = await this.visualMatcher.findCandidates(page);
      for (const match of visualMatches) {
        candidates.push({
          selector: match.selector,
          strategy: 'visual',
          score: match.score,
          factors: {
            textMatch: 0,
            attributeMatch: 0.1,
            domDepth: 0.05,
            roleMatch: 0,
            historyScore: context?.site ? 0.05 : 0,
            uniquenessScore: 0.3,
          },
          metadata: {
            generatedAt: Date.now(),
            source: 'visual',
            confidence: match.score,
          },
        });
      }
    } catch (error) {
      console.warn('Error generating visual selectors (visual matcher):', error);
    }

    return candidates;
  }

  /**
   * Generate sibling-based selectors
   * Note: brokenSelector parameter kept for API consistency but not used in this strategy
   */
  private async generateSiblingSelectors(
    page: Page,
    _brokenSelector: string
  ): Promise<SelectorCandidate[]> {
    const candidates: SelectorCandidate[] = [];

    try {
      // Find stable sibling elements and use them as anchors
      const stableSiblings = await page.evaluate(() => {
        const results: string[] = [];
        const allElements = Array.from(document.querySelectorAll('*'));

        for (const el of allElements) {
          const id = el.getAttribute('id');
          const dataTestId = el.getAttribute('data-testid');
          const name = el.getAttribute('name');

          if (id && !id.includes(':')) {
            results.push(`#${id} + *`);
            results.push(`#${id} ~ *`);
          }
          if (dataTestId) {
            results.push(`[data-testid="${dataTestId}"] + *`);
            results.push(`[data-testid="${dataTestId}"] ~ *`);
          }
          if (name) {
            results.push(`[name="${name}"] + *`);
            results.push(`[name="${name}"] ~ *`);
          }
        }

        return results.slice(0, 10); // Limit results
      });

      for (const selector of stableSiblings) {
        candidates.push({
          selector,
          strategy: 'css',
          score: 0,
          factors: {
            textMatch: 0,
            attributeMatch: 0.15,
            domDepth: 0.1,
            roleMatch: 0,
            historyScore: 0,
            uniquenessScore: 0.5,
          },
          metadata: {
            generatedAt: Date.now(),
            source: 'structure',
            confidence: 0.6,
          },
        });
      }
    } catch (error) {
      console.warn('Error generating sibling selectors:', error);
    }

    return candidates;
  }

  /**
   * Generate parent-based selectors
   */
  private async generateParentSelectors(
    page: Page,
    brokenSelector: string
  ): Promise<SelectorCandidate[]> {
    const candidates: SelectorCandidate[] = [];

    try {
      // Find stable parent containers
      const stableParents = await page.evaluate(() => {
        const results: string[] = [];
        const containers = Array.from(
          document.querySelectorAll('form, nav, main, article, section, [role="main"], [role="navigation"]')
        );

        for (const container of containers) {
          const id = container.getAttribute('id');
          const className = container.getAttribute('class');
          const role = container.getAttribute('role');

          if (id) {
            results.push(`#${id} *`);
          }
          if (className) {
            const firstClass = className.split(' ')[0];
            if (firstClass) {
              results.push(`.${firstClass} *`);
            }
          }
          if (role) {
            results.push(`[role="${role}"] *`);
          }
        }

        return results.slice(0, 10);
      });

      const tagMatch = brokenSelector.match(/^(\w+)/);
      const tag = tagMatch ? tagMatch[1] : '*';

      for (const parentSelector of stableParents) {
        candidates.push({
          selector: `${parentSelector} ${tag}`,
          strategy: 'css',
          score: 0,
          factors: {
            textMatch: 0,
            attributeMatch: 0.1,
            domDepth: 0.15,
            roleMatch: 0.05,
            historyScore: 0,
            uniquenessScore: 0.4,
          },
          metadata: {
            generatedAt: Date.now(),
            source: 'structure',
            confidence: 0.55,
          },
        });
      }
    } catch (error) {
      console.warn('Error generating parent selectors:', error);
    }

    return candidates;
  }

  /**
   * Generate heuristic-based selectors
   */
  private generateHeuristicSelectors(brokenSelector: string): SelectorCandidate[] {
    const candidates: SelectorCandidate[] = [];

    // Try to extract stable parts
    const tagMatch = brokenSelector.match(/^(\w+)/);
    if (tagMatch) {
      const tag = tagMatch[1];

      // Try simplified version
      candidates.push({
        selector: tag,
        strategy: 'css',
        score: 0,
        factors: {
          textMatch: 0,
          attributeMatch: 0.05,
          domDepth: 0.05,
          roleMatch: 0,
          historyScore: 0,
          uniquenessScore: 0.1,
        },
        metadata: {
          generatedAt: Date.now(),
          source: 'heuristic',
          confidence: 0.3,
        },
      });
    }

    return candidates;
  }

  /**
   * Enhanced multi-dimensional scoring
   */
  private async scoreSelectorEnhanced(
    candidate: SelectorCandidate,
    _page: Page,
    context?: {
      site?: string;
      elementText?: string;
      elementAttributes?: Record<string, string>;
    }
  ): Promise<number> {
    let score = 0;

    // Text match score
    if (candidate.factors.textMatch > 0 && context?.elementText) {
      const normalized = context.elementText.toLowerCase();
      const selectorText = candidate.selector.toLowerCase();
      if (selectorText.includes(normalized) || normalized.includes(selectorText)) {
        score += candidate.factors.textMatch;
      }
    }

    // Attribute match score
    score += candidate.factors.attributeMatch;

    // DOM depth score (simpler selectors are better)
    const depth = (candidate.selector.match(/>/g) || []).length;
    score += candidate.factors.domDepth * (1 - Math.min(depth / 5, 1));

    // Role/semantic match
    score += candidate.factors.roleMatch;

    // Stability score (if available)
    if (candidate.factors.stabilityScore !== undefined) {
      score += candidate.factors.stabilityScore * 0.2;
    }

    // Uniqueness score (if available)
    if (candidate.factors.uniquenessScore !== undefined) {
      score += candidate.factors.uniquenessScore * 0.15;
    }

    // Performance score (if available) - would need to measure actual performance
    if (candidate.factors.performanceScore !== undefined) {
      score += candidate.factors.performanceScore * 0.1;
    }

    // History score boost (applied separately)
    score += candidate.factors.historyScore * 0.25;

    // Metadata confidence boost
    if (candidate.metadata?.confidence) {
      score += candidate.metadata.confidence * 0.1;
    }

    return Math.min(score, 1.0);
  }

  /**
   * Get stability score for a selector (how stable it is over time)
   */
  private async getStabilityScore(selector: string, site: string): Promise<number> {
    const cacheKey = `${site}:${selector}`;
    if (this.stabilityCache.has(cacheKey)) {
      return this.stabilityCache.get(cacheKey)!;
    }

    // Check knowledge base for stability data
    if (this.knowledgeBase) {
      const history = await this.knowledgeBase.getBestSelector(site, selector);
      if (history) {
        const totalUses = history.successCount + history.failureCount;
        if (totalUses > 0) {
          const stability = history.successCount / totalUses;
          this.stabilityCache.set(cacheKey, stability);
          return stability;
        }
      }
    }

    // Default stability score
    const defaultStability = 0.5;
    this.stabilityCache.set(cacheKey, defaultStability);
    return defaultStability;
  }

  /**
   * Calculate uniqueness score (how specific/unique the selector is)
   */
  private calculateUniqueness(selector: string): number {
    let score = 0.5; // Base score

    // ID selectors are very unique
    if (selector.startsWith('#')) {
      score = 0.95;
    }
    // Data attributes are unique
    else if (selector.includes('[data-testid=') || selector.includes('[data-cy=')) {
      score = 0.9;
    }
    // Name attributes are fairly unique
    else if (selector.includes('[name=')) {
      score = 0.7;
    }
    // Role attributes are moderately unique
    else if (selector.includes('[role=')) {
      score = 0.6;
    }
    // Text selectors depend on text uniqueness
    else if (selector.startsWith('text=')) {
      score = 0.65;
    }
    // Simple tag selectors are not unique
    else if (/^[a-z]+$/.test(selector)) {
      score = 0.1;
    }
    // Complex selectors are more unique
    else if (selector.includes('>') || selector.includes(' ')) {
      score = 0.4;
    }

    return score;
  }

  /**
   * Deduplicate candidates by selector
   */
  private deduplicateCandidates(candidates: SelectorCandidate[]): SelectorCandidate[] {
    const seen = new Set<string>();
    const unique: SelectorCandidate[] = [];

    for (const candidate of candidates) {
      if (!seen.has(candidate.selector)) {
        seen.add(candidate.selector);
        unique.push(candidate);
      }
    }

    return unique;
  }

  /**
   * Escape regex special characters
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Record successful selector
   */
  recordSuccess(site: string, selector: string, strategy: SelectorStrategy): void {
    if (!this.selectorHistory.has(site)) {
      this.selectorHistory.set(site, []);
    }

    const history = this.selectorHistory.get(site)!;
    const existing = history.find((h) => h.selector === selector);

    if (existing) {
      existing.factors.historyScore = Math.min(existing.factors.historyScore + 0.1, 1.0);
      existing.score = Math.min(existing.score + 0.05, 1.0);
    } else {
      history.push({
        selector,
        strategy,
        score: 0.6,
        factors: {
          textMatch: 0,
          attributeMatch: 0,
          domDepth: 0,
          roleMatch: 0,
          historyScore: 0.2,
          stabilityScore: 0.5,
          uniquenessScore: this.calculateUniqueness(selector),
        },
        metadata: {
          generatedAt: Date.now(),
          source: 'learned',
          confidence: 0.7,
        },
      });
    }

    // Update stability cache
    const cacheKey = `${site}:${selector}`;
    const currentStability = this.stabilityCache.get(cacheKey) || 0.5;
    this.stabilityCache.set(cacheKey, Math.min(currentStability + 0.05, 1.0));
  }

  /**
   * Record failed selector
   */
  recordFailure(site: string, selector: string): void {
    if (!this.selectorHistory.has(site)) {
      return;
    }

    const history = this.selectorHistory.get(site)!;
    const existing = history.find((h) => h.selector === selector);

    if (existing) {
      existing.factors.historyScore = Math.max(existing.factors.historyScore - 0.1, 0);
      existing.score = Math.max(existing.score - 0.1, 0);
    }

    // Update stability cache
    const cacheKey = `${site}:${selector}`;
    const currentStability = this.stabilityCache.get(cacheKey) || 0.5;
    this.stabilityCache.set(cacheKey, Math.max(currentStability - 0.1, 0));
  }

  /**
   * AI-powered selector generation using LLM
   */
  async generateAISelector(
    page: Page,
    context: {
      site?: string;
      elementText?: string;
      elementAttributes?: Record<string, string>;
      elementType?: string;
      description?: string;
    }
  ): Promise<Array<{ selector: string; confidence: number; reasoning: string }>> {
    try {
      // Check if OpenAI is available
      const { OpenAI } = await import('openai');
      const apiKey = process.env.OPENAI_API_KEY;
      
      if (!apiKey) {
        console.warn('OpenAI API key not found, skipping AI selector generation');
        return [];
      }

      const openai = new OpenAI({ apiKey });

      // Build prompt for selector generation
      const prompt = `Generate CSS selectors for a web element with the following characteristics:
- Site: ${context.site || 'unknown'}
- Element Type: ${context.elementType || 'unknown'}
- Text: ${context.elementText || 'none'}
- Attributes: ${JSON.stringify(context.elementAttributes || {})}
- Description: ${context.description || 'none'}

Generate 5 CSS selectors ordered by stability and reliability. For each selector, provide:
1. The CSS selector
2. Confidence score (0-1)
3. Brief reasoning

Format as JSON array: [{"selector": "...", "confidence": 0.9, "reasoning": "..."}]`;

      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are an expert at generating stable CSS selectors for web automation. Focus on selectors that are unlikely to break when pages change.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.3,
        max_tokens: 500,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) return [];

      // Parse JSON response
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const selectors = JSON.parse(jsonMatch[0]);
        return selectors.map((s: any) => ({
          selector: s.selector,
          confidence: s.confidence || 0.5,
          reasoning: s.reasoning || '',
        }));
      }

      return [];
    } catch (error) {
      console.warn('AI selector generation failed:', error);
      return [];
    }
  }

  /**
   * ML-based selector stability prediction
   */
  predictSelectorStability(
    selector: string,
    context?: { site?: string; elementType?: string }
  ): { stability: number; breakageProbability: number } {
    const cacheKey = `${selector}-${context?.site || 'global'}-${context?.elementType || 'unknown'}`;
    const cached = this.selectorPredictions.get(cacheKey);

    if (cached && Date.now() - cached.lastUpdated < 3600000) { // Cache for 1 hour
      return {
        stability: cached.stability,
        breakageProbability: cached.breakageProbability,
      };
    }

    // Simple ML-like prediction based on selector characteristics
    let stability = 0.5;
    let breakageProbability = 0.5;

    // Analyze selector characteristics
    const hasId = selector.includes('#');
    const hasClass = selector.includes('.');
    const hasAttribute = selector.includes('[');
    const hasPseudo = selector.includes(':');
    const hasComplexCombinator = /[>+~]/.test(selector);
    const depth = (selector.match(/\s/g) || []).length;

    // Stability factors
    if (hasId) stability += 0.3; // IDs are very stable
    if (hasAttribute && selector.includes('data-')) stability += 0.2; // Data attributes are stable
    if (hasAttribute && selector.includes('aria-')) stability += 0.15; // ARIA attributes are stable
    if (hasAttribute && selector.includes('name=')) stability += 0.1; // Name attributes are relatively stable
    if (hasClass && !hasComplexCombinator) stability += 0.1; // Simple class selectors
    if (hasPseudo) stability -= 0.1; // Pseudo-selectors can be less stable
    if (hasComplexCombinator) stability -= 0.15; // Complex combinators are fragile
    if (depth > 3) stability -= 0.1; // Deep selectors are fragile

    // Normalize
    stability = Math.max(0, Math.min(1, stability));
    breakageProbability = 1 - stability;

    // Cache prediction
    this.selectorPredictions.set(cacheKey, {
      stability,
      breakageProbability,
      lastUpdated: Date.now(),
    });

    return { stability, breakageProbability };
  }

  /**
   * OCR-based element finding
   */
  async findElementByOCR(
    page: Page,
    searchText: string,
    options?: { fuzzy?: boolean; threshold?: number }
  ): Promise<Array<{ selector: string; confidence: number; text: string }>> {
    return this.ocrMatcher.findElementByText(page, searchText, options);
  }

  /**
   * Cross-site selector pattern matching
   */
  async findCrossSitePatterns(
    brokenSelector: string,
    context: { site?: string; elementType?: string; elementText?: string }
  ): Promise<Array<{ selector: string; sites: string[]; confidence: number }>> {
    if (!this.knowledgeBase || !context.site) return [];

    try {
      // Get all sites from knowledge base
      const stats = this.knowledgeBase.getStatistics();
      const patterns: Array<{ selector: string; sites: string[]; confidence: number }> = [];

      // Check each site for similar patterns
      for (const site of stats.sites || []) {
        if (site === context.site) continue; // Skip current site

        const sitePattern = await this.knowledgeBase.getSitePatterns(site);
        if (!sitePattern) continue;

        // Look for similar selectors based on element type and text
        const commonSelectors = sitePattern.commonSelectors || {};
        for (const [selector, count] of Object.entries(commonSelectors)) {
          // Check if selector matches our context
          if (context.elementType && selector.includes(context.elementType)) {
            const existing = patterns.find(p => p.selector === selector);
            if (existing) {
              existing.sites.push(site);
              existing.confidence = Math.min(1, existing.confidence + 0.1);
            } else {
              patterns.push({
                selector,
                sites: [site],
                confidence: Math.min(1, count / 10), // Normalize by usage count
              });
            }
          }
        }
      }

      return patterns.sort((a, b) => b.confidence - a.confidence).slice(0, 5);
    } catch (error) {
      console.warn('Cross-site pattern matching failed:', error);
      return [];
    }
  }
}

