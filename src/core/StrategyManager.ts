import type { StrategyPerformance, ChallengePattern } from '../types/index.js';
import type { KnowledgeBase } from './KnowledgeBase.js';
import { AdaptiveRetryStrategy } from './AdaptiveRetryStrategy.js';

/**
 * Strategy Manager: Centralized strategy management and learning
 * 
 * Features:
 * - Track strategy performance
 * - A/B test strategies
 * - Real-time strategy adaptation
 * - Challenge pattern recognition
 * - Cross-site pattern sharing
 */
export class StrategyManager {
  private knowledgeBase?: KnowledgeBase;
  private retryStrategy: AdaptiveRetryStrategy;
  private strategyPerformance: Map<string, StrategyPerformance> = new Map();
  private challengePatterns: Map<string, ChallengePattern[]> = new Map();
  private activeStrategies: Map<string, string> = new Map(); // context -> strategyId

  constructor(knowledgeBase?: KnowledgeBase) {
    this.knowledgeBase = knowledgeBase;
    this.retryStrategy = new AdaptiveRetryStrategy(knowledgeBase);
  }

  /**
   * Get retry strategy for error
   */
  getRetryStrategy(
    errorType: 'network' | 'selector' | 'timeout' | '403' | '500' | 'other',
    context?: {
      site?: string;
      action?: string;
      previousAttempts?: number;
    }
  ) {
    return this.retryStrategy.getRetryStrategy(errorType, context);
  }

  /**
   * Record strategy execution result
   */
  recordStrategyResult(
    strategyType: 'selector' | 'retry' | 'navigation' | 'wait',
    strategyId: string,
    context: {
      site?: string;
      success: boolean;
      duration: number;
      metadata?: Record<string, unknown>;
    }
  ): void {
    const performance = this.strategyPerformance.get(strategyId) || {
      strategyId,
      strategyType,
      successRate: 0,
      averageTime: 0,
      usageCount: 0,
      lastUpdated: Date.now(),
      site: context.site,
      context: context.metadata,
    };

    performance.usageCount++;
    performance.lastUpdated = Date.now();

    // Update success rate
    const successIncrement = context.success ? 1 : 0;
    performance.successRate =
      (performance.successRate * (performance.usageCount - 1) + successIncrement) /
      performance.usageCount;

    // Update average time
    performance.averageTime =
      (performance.averageTime * (performance.usageCount - 1) + context.duration) /
      performance.averageTime;

    this.strategyPerformance.set(strategyId, performance);

    // Auto-adopt better strategies
    if (performance.usageCount > 10 && performance.successRate > 0.8) {
      this.considerStrategyAdoption(strategyId, strategyType, context.site);
    }
  }

  /**
   * Learn challenge pattern
   */
  learnChallengePattern(
    site: string,
    challengeType: 'cloudflare' | 'captcha' | 'error' | 'rate_limit' | 'blocked',
    context: {
      timeOfDay?: number;
      dayOfWeek?: number;
      trigger?: string;
      recoveryStrategy?: string;
      success: boolean;
    }
  ): void {
    if (!this.challengePatterns.has(site)) {
      this.challengePatterns.set(site, []);
    }

    const patterns = this.challengePatterns.get(site)!;
    let pattern = patterns.find(
      (p) => p.challengeType === challengeType && p.site === site
    );

    if (!pattern) {
      pattern = {
        site,
        challengeType,
        recoveryStrategy: context.recoveryStrategy || 'default',
        successRate: 0,
        lastSeen: Date.now(),
        occurrences: 0,
      };
      patterns.push(pattern);
    }

    pattern.occurrences++;
    pattern.lastSeen = Date.now();

    // Update success rate
    const successIncrement = context.success ? 1 : 0;
    pattern.successRate =
      (pattern.successRate * (pattern.occurrences - 1) + successIncrement) /
      pattern.occurrences;

    // Update time pattern
    if (context.timeOfDay !== undefined) {
      if (!pattern.timePattern) {
        pattern.timePattern = {};
      }
      if (!pattern.timePattern.hour) {
        pattern.timePattern.hour = [];
      }
      if (!pattern.timePattern.hour.includes(context.timeOfDay)) {
        pattern.timePattern.hour.push(context.timeOfDay);
      }
    }

    if (context.dayOfWeek !== undefined) {
      if (!pattern.timePattern) {
        pattern.timePattern = {};
      }
      if (!pattern.timePattern.dayOfWeek) {
        pattern.timePattern.dayOfWeek = [];
      }
      if (!pattern.timePattern.dayOfWeek.includes(context.dayOfWeek)) {
        pattern.timePattern.dayOfWeek.push(context.dayOfWeek);
      }
    }

    // Update trigger pattern
    if (context.trigger) {
      if (!pattern.triggerPattern) {
        pattern.triggerPattern = [];
      }
      if (!pattern.triggerPattern.includes(context.trigger)) {
        pattern.triggerPattern.push(context.trigger);
      }
    }

    // Update recovery strategy if this one works better
    if (context.recoveryStrategy && context.success) {
      if (pattern.successRate > 0.5) {
        pattern.recoveryStrategy = context.recoveryStrategy;
      }
    }

    this.challengePatterns.set(site, patterns);
  }

  /**
   * Predict challenge based on patterns
   */
  predictChallenge(
    site: string,
    context?: {
      timeOfDay?: number;
      dayOfWeek?: number;
      action?: string;
    }
  ): ChallengePattern | null {
    const patterns = this.challengePatterns.get(site);
    if (!patterns || patterns.length === 0) {
      return null;
    }

    const now = new Date();
    const currentHour = context?.timeOfDay ?? now.getHours();
    const currentDay = context?.dayOfWeek ?? now.getDay();

    // Find patterns that match current context
    const matchingPatterns = patterns.filter((pattern) => {
      if (pattern.timePattern) {
        if (
          pattern.timePattern.hour &&
          !pattern.timePattern.hour.includes(currentHour)
        ) {
          return false;
        }
        if (
          pattern.timePattern.dayOfWeek &&
          !pattern.timePattern.dayOfWeek.includes(currentDay)
        ) {
          return false;
        }
      }

      if (context?.action && pattern.triggerPattern) {
        if (!pattern.triggerPattern.some((trigger) => context.action?.includes(trigger))) {
          return false;
        }
      }

      return true;
    });

    if (matchingPatterns.length === 0) {
      return null;
    }

    // Return pattern with highest occurrence rate
    matchingPatterns.sort((a, b) => b.occurrences - a.occurrences);
    return matchingPatterns[0];
  }

  /**
   * Get best strategy for context
   */
  getBestStrategy(
    strategyType: 'selector' | 'retry' | 'navigation' | 'wait',
    context?: {
      site?: string;
      action?: string;
      errorType?: string;
    }
  ): string | null {
    const contextKey = this.getContextKey(strategyType, context);
    return this.activeStrategies.get(contextKey) || null;
  }

  /**
   * Set active strategy for context
   */
  setActiveStrategy(
    strategyType: 'selector' | 'retry' | 'navigation' | 'wait',
    strategyId: string,
    context?: {
      site?: string;
      action?: string;
      errorType?: string;
    }
  ): void {
    const contextKey = this.getContextKey(strategyType, context);
    this.activeStrategies.set(contextKey, strategyId);
  }

  /**
   * Consider adopting a strategy if it performs well
   */
  private considerStrategyAdoption(
    strategyId: string,
    strategyType: 'selector' | 'retry' | 'navigation' | 'wait',
    site?: string
  ): void {
    const performance = this.strategyPerformance.get(strategyId);
    if (!performance) return;

    // Get current active strategy
    const currentStrategyId = this.getBestStrategy(strategyType, { site });
    if (currentStrategyId === strategyId) {
      return; // Already active
    }

    const currentPerformance = currentStrategyId
      ? this.strategyPerformance.get(currentStrategyId)
      : null;

    // Adopt if new strategy is significantly better
    if (
      !currentPerformance ||
      (performance.successRate > currentPerformance.successRate + 0.1 &&
        performance.usageCount >= 10)
    ) {
      this.setActiveStrategy(strategyType, strategyId, { site });
      console.log(
        `[StrategyManager] Adopted new ${strategyType} strategy ${strategyId} for ${site || 'global'}`
      );
    }
  }

  /**
   * Get context key for strategy lookup
   */
  private getContextKey(
    strategyType: string,
    context?: {
      site?: string;
      action?: string;
      errorType?: string;
    }
  ): string {
    const parts = [strategyType];
    if (context?.site) parts.push(context.site);
    if (context?.action) parts.push(context.action);
    if (context?.errorType) parts.push(context.errorType);
    return parts.join(':');
  }

  /**
   * Get all strategy performance stats
   */
  getPerformanceStats(): StrategyPerformance[] {
    return Array.from(this.strategyPerformance.values());
  }

  /**
   * Get challenge patterns for a site
   */
  getChallengePatterns(site: string): ChallengePattern[] {
    return this.challengePatterns.get(site) || [];
  }

  /**
   * Get retry strategy manager
   */
  getRetryStrategyManager(): AdaptiveRetryStrategy {
    return this.retryStrategy;
  }
}

