import type { KnowledgeBase } from './KnowledgeBase.js';
import type { ExecutionResult, CanonicalAction } from '../types/index.js';

/**
 * Pattern Learning Engine: Advanced pattern recognition and extraction
 * 
 * Features:
 * - Extract common patterns from executions
 * - Cross-site pattern detection
 * - Predictive pattern matching
 * - Temporal pattern learning
 * - Failure pattern analysis
 */
export class PatternLearningEngine {
  private knowledgeBase?: KnowledgeBase;
  private patternCache: Map<string, any> = new Map();

  constructor(knowledgeBase?: KnowledgeBase) {
    this.knowledgeBase = knowledgeBase;
  }

  /**
   * Extract patterns from execution results
   */
  async extractPatterns(
    site: string,
    actions: CanonicalAction[],
    result: ExecutionResult
  ): Promise<void> {
    // Extract selector patterns
    await this.extractSelectorPatterns(site, actions, result);

    // Extract flow patterns
    await this.extractFlowPatterns(site, actions, result);

    // Extract timing patterns
    await this.extractTimingPatterns(site, actions, result);

    // Extract failure patterns
    if (result.status === 'failed') {
      await this.extractFailurePatterns(site, actions, result);
    }
  }

  /**
   * Extract selector patterns
   */
  private async extractSelectorPatterns(
    site: string,
    actions: CanonicalAction[],
    result: ExecutionResult
  ): Promise<void> {
    const selectorPatterns: Map<string, {
      selector: string;
      successRate: number;
      usageCount: number;
      contexts: string[];
    }> = new Map();

    for (const action of actions) {
      for (const step of action.steps) {
        if (step.target?.selector) {
          const selector = step.target.selector;
          const patternKey = `${site}:${selector}`;

          let pattern = selectorPatterns.get(patternKey);
          if (!pattern) {
            pattern = {
              selector,
              successRate: 0,
              usageCount: 0,
              contexts: [],
            };
            selectorPatterns.set(patternKey, pattern);
          }

          pattern.usageCount++;
          pattern.contexts.push(action.intent);

          // Check if this selector was successful
          const wasSuccessful = result.commands?.some(
            (cmd) => cmd.status === 'success' && cmd.command?.args?.[0] === selector
          ) || false;

          if (wasSuccessful) {
            pattern.successRate = (pattern.successRate * (pattern.usageCount - 1) + 1) / pattern.usageCount;
          } else {
            pattern.successRate = (pattern.successRate * (pattern.usageCount - 1) + 0) / pattern.usageCount;
          }
        }
      }
    }

    // Store patterns in knowledge base
    // This would be integrated with KnowledgeBase pattern storage
    console.log(`[PatternLearning] Extracted ${selectorPatterns.size} selector patterns for ${site}`);
  }

  /**
   * Extract flow patterns (sequence of intents)
   */
  private async extractFlowPatterns(
    site: string,
    actions: CanonicalAction[],
    result: ExecutionResult
  ): Promise<void> {
    const flow = actions.map((a) => a.intent).join(' -> ');
    const flowKey = `${site}:${flow}`;

    // Track flow success rate
    const wasSuccessful = result.status === 'success';
    
    // This would be stored in knowledge base
    console.log(`[PatternLearning] Flow pattern for ${site}: ${flow} (Success: ${wasSuccessful})`);
  }

  /**
   * Extract timing patterns
   */
  private async extractTimingPatterns(
    site: string,
    actions: CanonicalAction[],
    result: ExecutionResult
  ): Promise<void> {
    if (!result.duration) return;

    const timingData = {
      site,
      totalDuration: result.duration,
      averageStepDuration: result.duration / (actions.length || 1),
      timestamp: Date.now(),
      hourOfDay: new Date().getHours(),
      dayOfWeek: new Date().getDay(),
    };

    // Learn optimal wait times
    // This would be stored and used to optimize future executions
    console.log(`[PatternLearning] Timing pattern for ${site}: ${timingData.averageStepDuration}ms per step`);
  }

  /**
   * Extract failure patterns
   */
  private async extractFailurePatterns(
    site: string,
    actions: CanonicalAction[],
    result: ExecutionResult
  ): Promise<void> {
    if (result.status !== 'failed') return;

    const failedCommands = result.commands?.filter((c) => c.status === 'failed') || [];
    const failurePattern = {
      site,
      failedStepCount: failedCommands.length,
      errorTypes: failedCommands.map((c) => this.classifyError(c.error || '')),
      failedSelectors: failedCommands
        .map((c) => c.command?.args?.[0] as string)
        .filter(Boolean),
      timestamp: Date.now(),
    };

    // Analyze failure patterns
    // This would be stored for predictive failure detection
    console.log(`[PatternLearning] Failure pattern for ${site}: ${failurePattern.errorTypes.join(', ')}`);
  }

  /**
   * Detect cross-site patterns
   */
  async detectCrossSitePatterns(sites: string[]): Promise<Map<string, any>> {
    const crossSitePatterns: Map<string, any> = new Map();

    // This would analyze patterns across multiple sites
    // to find universal patterns that work everywhere
    
    console.log(`[PatternLearning] Analyzing cross-site patterns across ${sites.length} sites`);
    
    return crossSitePatterns;
  }

  /**
   * Predict selector breakage
   */
  async predictSelectorBreakage(
    site: string,
    selector: string
  ): Promise<{ willBreak: boolean; confidence: number; reason?: string }> {
    // Analyze selector stability over time
    // Check for patterns that indicate upcoming breakage
    
    // This would use historical data to predict breakage
    return {
      willBreak: false,
      confidence: 0.5,
    };
  }

  /**
   * Classify error type
   */
  private classifyError(error: string): string {
    const errorLower = error.toLowerCase();
    
    if (errorLower.includes('timeout')) return 'timeout';
    if (errorLower.includes('selector') || errorLower.includes('element')) return 'selector';
    if (errorLower.includes('network')) return 'network';
    if (errorLower.includes('403') || errorLower.includes('forbidden')) return '403';
    if (errorLower.includes('500')) return '500';
    
    return 'other';
  }

  /**
   * Get learned patterns for a site
   */
  getLearnedPatterns(site: string): any {
    return this.patternCache.get(site) || null;
  }

  /**
   * Clear pattern cache
   */
  clearCache(): void {
    this.patternCache.clear();
  }
}

