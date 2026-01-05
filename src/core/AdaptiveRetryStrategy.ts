import type { RetryStrategy, StrategyPerformance } from '../types/index.js';
import type { KnowledgeBase } from './KnowledgeBase.js';

/**
 * Adaptive Retry Strategy Manager
 * 
 * Features:
 * - Error-type based retry strategies
 * - Context-aware retry limits
 * - Smart backoff strategies (exponential, linear, fibonacci, jitter)
 * - Learning optimal retry counts per site/action
 * - Performance tracking
 */
export class AdaptiveRetryStrategy {
  private knowledgeBase?: KnowledgeBase;
  private strategyPerformance: Map<string, StrategyPerformance> = new Map();
  private defaultStrategies: Map<string, RetryStrategy> = new Map();

  constructor(knowledgeBase?: KnowledgeBase) {
    this.knowledgeBase = knowledgeBase;
    this.initializeDefaultStrategies();
  }

  /**
   * Initialize default retry strategies for different error types
   */
  private initializeDefaultStrategies(): void {
    // Network errors: More retries, longer backoff
    this.defaultStrategies.set('network', {
      errorType: 'network',
      maxRetries: 5,
      backoffType: 'exponential',
      baseDelay: 1000,
      maxDelay: 30000,
      jitter: true,
      adaptive: true,
    });

    // Selector errors: Fewer retries, try healing first
    this.defaultStrategies.set('selector', {
      errorType: 'selector',
      maxRetries: 3,
      backoffType: 'linear',
      baseDelay: 500,
      maxDelay: 5000,
      jitter: false,
      adaptive: true,
    });

    // Timeout errors: Medium retries, exponential backoff
    this.defaultStrategies.set('timeout', {
      errorType: 'timeout',
      maxRetries: 4,
      backoffType: 'exponential',
      baseDelay: 2000,
      maxDelay: 20000,
      jitter: true,
      adaptive: true,
    });

    // 403/401 errors: No retries, pause for human
    this.defaultStrategies.set('403', {
      errorType: '403',
      maxRetries: 0,
      backoffType: 'fixed',
      baseDelay: 0,
      jitter: false,
      adaptive: false,
    });

    // 500 errors: Retry with exponential backoff
    this.defaultStrategies.set('500', {
      errorType: '500',
      maxRetries: 3,
      backoffType: 'exponential',
      baseDelay: 2000,
      maxDelay: 15000,
      jitter: true,
      adaptive: true,
    });

    // Other errors: Default strategy
    this.defaultStrategies.set('other', {
      errorType: 'other',
      maxRetries: 2,
      backoffType: 'linear',
      baseDelay: 1000,
      maxDelay: 5000,
      jitter: false,
      adaptive: true,
    });
  }

  /**
   * Get retry strategy for an error type
   */
  getRetryStrategy(
    errorType: 'network' | 'selector' | 'timeout' | '403' | '500' | 'other',
    context?: {
      site?: string;
      action?: string;
      previousAttempts?: number;
    }
  ): RetryStrategy {
    // Check for learned strategy first
    if (context?.site && this.knowledgeBase) {
      const learnedStrategy = this.getLearnedStrategy(context.site, errorType, context.action);
      if (learnedStrategy) {
        return learnedStrategy;
      }
    }

    // Get default strategy
    const defaultStrategy = this.defaultStrategies.get(errorType) || this.defaultStrategies.get('other')!;

    // Adapt based on context if adaptive is enabled
    if (defaultStrategy.adaptive && context) {
      return this.adaptStrategy(defaultStrategy, context);
    }

    return defaultStrategy;
  }

  /**
   * Calculate delay for retry attempt
   */
  calculateDelay(
    strategy: RetryStrategy,
    attemptNumber: number,
    previousDelay?: number
  ): number {
    let delay = 0;

    switch (strategy.backoffType) {
      case 'exponential':
        delay = strategy.baseDelay * Math.pow(2, attemptNumber - 1);
        break;

      case 'linear':
        delay = strategy.baseDelay * attemptNumber;
        break;

      case 'fibonacci':
        delay = strategy.baseDelay * this.fibonacci(attemptNumber);
        break;

      case 'fixed':
        delay = strategy.baseDelay;
        break;
    }

    // Apply max delay limit
    if (strategy.maxDelay) {
      delay = Math.min(delay, strategy.maxDelay);
    }

    // Add jitter to avoid thundering herd
    if (strategy.jitter) {
      const jitterAmount = delay * 0.1; // 10% jitter
      delay += (Math.random() * 2 - 1) * jitterAmount;
    }

    return Math.max(0, Math.round(delay));
  }

  /**
   * Check if should retry based on strategy
   */
  shouldRetry(
    strategy: RetryStrategy,
    attemptNumber: number,
    error?: Error
  ): boolean {
    // Never retry 403 errors
    if (strategy.errorType === '403') {
      return false;
    }

    // Check max retries
    if (attemptNumber > strategy.maxRetries) {
      return false;
    }

    // Additional checks based on error
    if (error) {
      const errorMessage = error.message.toLowerCase();

      // Don't retry on certain errors
      if (
        errorMessage.includes('not found') ||
        errorMessage.includes('invalid') ||
        errorMessage.includes('forbidden')
      ) {
        return false;
      }
    }

    return true;
  }

  /**
   * Record retry attempt result for learning
   */
  recordRetryResult(
    strategy: RetryStrategy,
    context: {
      site?: string;
      action?: string;
      attemptNumber: number;
      success: boolean;
      duration: number;
    }
  ): void {
    const strategyId = this.getStrategyId(strategy, context);

    const performance = this.strategyPerformance.get(strategyId) || {
      strategyId,
      strategyType: 'retry',
      successRate: 0,
      averageTime: 0,
      usageCount: 0,
      lastUpdated: Date.now(),
      site: context.site,
      context: {
        errorType: strategy.errorType,
        action: context.action,
      },
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
      performance.usageCount;

    this.strategyPerformance.set(strategyId, performance);

    // Learn optimal retry count if adaptive
    if (strategy.adaptive && context.site) {
      this.learnOptimalRetryCount(strategy, context);
    }
  }

  /**
   * Get learned strategy from knowledge base
   */
  private getLearnedStrategy(
    site: string,
    errorType: string,
    action?: string
  ): RetryStrategy | null {
    // This would query knowledge base for learned strategies
    // For now, return null to use defaults
    // TODO: Implement knowledge base query for retry strategies
    return null;
  }

  /**
   * Adapt strategy based on context
   */
  private adaptStrategy(
    strategy: RetryStrategy,
    context: {
      site?: string;
      action?: string;
      previousAttempts?: number;
    }
  ): RetryStrategy {
    const adapted = { ...strategy };

    // Adjust based on site performance
    if (context.site) {
      const performance = this.getSitePerformance(context.site, strategy.errorType);
      if (performance) {
        // If success rate is low, reduce retries
        if (performance.successRate < 0.3) {
          adapted.maxRetries = Math.max(1, strategy.maxRetries - 1);
        }
        // If success rate is high, might increase retries slightly
        else if (performance.successRate > 0.8) {
          adapted.maxRetries = Math.min(strategy.maxRetries + 1, 7);
        }
      }
    }

    // Adjust based on previous attempts
    if (context.previousAttempts && context.previousAttempts > 0) {
      // Reduce retries if many previous attempts failed
      if (context.previousAttempts > 3) {
        adapted.maxRetries = Math.max(1, strategy.maxRetries - 1);
      }
    }

    return adapted;
  }

  /**
   * Get performance data for a site and error type
   */
  private getSitePerformance(site: string, errorType: string): StrategyPerformance | null {
    for (const [_, performance] of this.strategyPerformance.entries()) {
      if (performance.site === site && performance.context?.errorType === errorType) {
        return performance;
      }
    }
    return null;
  }

  /**
   * Learn optimal retry count
   */
  private learnOptimalRetryCount(
    strategy: RetryStrategy,
    context: {
      site?: string;
      action?: string;
      attemptNumber: number;
      success: boolean;
    }
  ): void {
    if (!context.site) return;

    // Track which attempt number succeeded
    // This would be stored in knowledge base
    // For now, just log for future implementation
    console.log(
      `[Retry Learning] ${context.site} - ${strategy.errorType} - Attempt ${context.attemptNumber} - Success: ${context.success}`
    );
  }

  /**
   * Get strategy ID for tracking
   */
  private getStrategyId(strategy: RetryStrategy, context: { site?: string; action?: string }): string {
    return `${strategy.errorType}-${context.site || 'global'}-${context.action || 'default'}`;
  }

  /**
   * Calculate Fibonacci number
   */
  private fibonacci(n: number): number {
    if (n <= 1) return 1;
    let a = 1;
    let b = 1;
    for (let i = 2; i <= n; i++) {
      const temp = a + b;
      a = b;
      b = temp;
    }
    return b;
  }

  /**
   * Get strategy performance statistics
   */
  getPerformanceStats(): StrategyPerformance[] {
    return Array.from(this.strategyPerformance.values());
  }

  /**
   * Get best strategy for a context
   */
  getBestStrategy(
    errorType: 'network' | 'selector' | 'timeout' | '403' | '500' | 'other',
    context?: {
      site?: string;
      action?: string;
    }
  ): RetryStrategy {
    // Get all strategies for this error type
    const strategies: Array<{ strategy: RetryStrategy; performance: StrategyPerformance | null }> = [];

    // Default strategy
    const defaultStrategy = this.defaultStrategies.get(errorType) || this.defaultStrategies.get('other')!;
    strategies.push({
      strategy: defaultStrategy,
      performance: null,
    });

    // Check for learned strategies
    if (context?.site) {
      const learned = this.getLearnedStrategy(context.site, errorType, context.action);
      if (learned) {
        const performance = this.getSitePerformance(context.site, errorType);
        strategies.push({
          strategy: learned,
          performance: performance || null,
        });
      }
    }

    // Return strategy with best performance
    if (strategies.length === 1) {
      return strategies[0].strategy;
    }

    // Sort by performance (success rate * usage count)
    strategies.sort((a, b) => {
      const scoreA = (a.performance?.successRate || 0.5) * (a.performance?.usageCount || 1);
      const scoreB = (b.performance?.successRate || 0.5) * (b.performance?.usageCount || 1);
      return scoreB - scoreA;
    });

    return strategies[0].strategy;
  }
}

