import type { PlaywrightCommand } from '../types/index.js';

/**
 * Performance Monitor: Tracks metrics, identifies bottlenecks, and optimizes execution
 * 
 * Features:
 * - Real-time performance tracking
 * - Bottleneck identification
 * - Selector performance analysis
 * - Timing optimization
 * - Resource usage monitoring
 */
export class PerformanceMonitor {
  private metrics: Map<string, PerformanceMetrics> = new Map();
  private selectorPerformance: Map<string, SelectorPerformance> = new Map();
  private timingPatterns: Map<string, TimingPattern> = new Map();
  private bottleneckThreshold = 5000; // 5 seconds

  /**
   * Record command execution metrics
   */
  recordCommand(
    command: PlaywrightCommand,
    duration: number,
    success: boolean,
    site?: string
  ): void {
    const key = `${command.cmd}-${site || 'global'}`;
    
    if (!this.metrics.has(key)) {
      this.metrics.set(key, {
        command: command.cmd,
        site: site || 'global',
        totalExecutions: 0,
        successfulExecutions: 0,
        failedExecutions: 0,
        totalDuration: 0,
        averageDuration: 0,
        minDuration: Infinity,
        maxDuration: 0,
        p50: 0,
        p95: 0,
        p99: 0,
        durations: [],
      });
    }

    const metric = this.metrics.get(key)!;
    metric.totalExecutions++;
    metric.totalDuration += duration;
    metric.averageDuration = metric.totalDuration / metric.totalExecutions;
    
    if (success) {
      metric.successfulExecutions++;
    } else {
      metric.failedExecutions++;
    }

    metric.minDuration = Math.min(metric.minDuration, duration);
    metric.maxDuration = Math.max(metric.maxDuration, duration);
    metric.durations.push(duration);

    // Keep only last 1000 durations for percentile calculation
    if (metric.durations.length > 1000) {
      metric.durations.shift();
    }

    // Calculate percentiles
    if (metric.durations.length > 0) {
      const sorted = [...metric.durations].sort((a, b) => a - b);
      metric.p50 = sorted[Math.floor(sorted.length * 0.5)] || 0;
      metric.p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
      metric.p99 = sorted[Math.floor(sorted.length * 0.99)] || 0;
    }
  }

  /**
   * Record selector performance
   */
  recordSelector(
    selector: string,
    strategy: string,
    duration: number,
    success: boolean,
    site?: string
  ): void {
    const key = `${selector}-${strategy}-${site || 'global'}`;
    
    if (!this.selectorPerformance.has(key)) {
      this.selectorPerformance.set(key, {
        selector,
        strategy,
        site: site || 'global',
        totalUses: 0,
        successfulUses: 0,
        failedUses: 0,
        averageDuration: 0,
        totalDuration: 0,
        stabilityScore: 1.0,
        lastUsed: Date.now(),
      });
    }

    const perf = this.selectorPerformance.get(key)!;
    perf.totalUses++;
    perf.totalDuration += duration;
    perf.averageDuration = perf.totalDuration / perf.totalUses;
    perf.lastUsed = Date.now();

    if (success) {
      perf.successfulUses++;
    } else {
      perf.failedUses++;
    }

    // Calculate stability score (success rate weighted by recency)
    const successRate = perf.successfulUses / perf.totalUses;
    const recencyWeight = Math.min(1.0, perf.totalUses / 10); // More weight with more data
    perf.stabilityScore = successRate * recencyWeight;
  }

  /**
   * Record timing pattern for optimization
   */
  recordTiming(
    operation: string,
    duration: number,
    context?: {
      site?: string;
      pageType?: string;
      elementType?: string;
    }
  ): void {
    const key = `${operation}-${context?.site || 'global'}-${context?.pageType || 'default'}`;
    
    if (!this.timingPatterns.has(key)) {
      this.timingPatterns.set(key, {
        operation,
        site: context?.site || 'global',
        pageType: context?.pageType || 'default',
        samples: [],
        optimalWait: 0,
        averageDuration: 0,
      });
    }

    const pattern = this.timingPatterns.get(key)!;
    pattern.samples.push(duration);
    
    // Keep last 100 samples
    if (pattern.samples.length > 100) {
      pattern.samples.shift();
    }

    // Calculate optimal wait time (p95 of successful operations)
    if (pattern.samples.length > 10) {
      const sorted = [...pattern.samples].sort((a, b) => a - b);
      pattern.optimalWait = sorted[Math.floor(sorted.length * 0.95)] || 0;
      pattern.averageDuration = pattern.samples.reduce((a, b) => a + b, 0) / pattern.samples.length;
    }
  }

  /**
   * Identify bottlenecks in execution
   */
  identifyBottlenecks(): Bottleneck[] {
    const bottlenecks: Bottleneck[] = [];

    for (const [, metric] of this.metrics.entries()) {
      // Check for slow commands
      if (metric.p95 > this.bottleneckThreshold) {
        bottlenecks.push({
          type: 'slow_command',
          severity: metric.p95 > 10000 ? 'high' : 'medium',
          command: metric.command,
          site: metric.site,
          averageDuration: metric.averageDuration,
          p95: metric.p95,
          recommendation: this.getOptimizationRecommendation(metric),
        });
      }

      // Check for high failure rate
      if (metric.totalExecutions > 10) {
        const failureRate = metric.failedExecutions / metric.totalExecutions;
        if (failureRate > 0.3) {
          bottlenecks.push({
            type: 'high_failure_rate',
            severity: failureRate > 0.5 ? 'high' : 'medium',
            command: metric.command,
            site: metric.site,
            failureRate,
            recommendation: `Consider selector healing or retry strategy for ${metric.command}`,
          });
        }
      }
    }

    return bottlenecks.sort((a, b) => {
      const severityOrder = { high: 3, medium: 2, low: 1 };
      return severityOrder[b.severity] - severityOrder[a.severity];
    });
  }

  /**
   * Get optimization recommendations
   */
  private getOptimizationRecommendation(metric: PerformanceMetrics): string {
    if (metric.command === 'goto') {
      return 'Consider using waitUntil: "networkidle" or custom wait selectors';
    }
    if (metric.command === 'fill' || metric.command === 'click') {
      return 'Consider pre-waiting for element visibility or using more stable selectors';
    }
    if (metric.command === 'waitFor') {
      return 'Consider optimizing wait timeout or using more specific selectors';
    }
    return 'Review command implementation and consider caching or parallelization';
  }

  /**
   * Get optimal wait time for operation
   */
  getOptimalWait(
    operation: string,
    context?: {
      site?: string;
      pageType?: string;
    }
  ): number {
    const key = `${operation}-${context?.site || 'global'}-${context?.pageType || 'default'}`;
    const pattern = this.timingPatterns.get(key);
    
    if (pattern && pattern.optimalWait > 0) {
      return pattern.optimalWait;
    }

    // Default wait times
    const defaults: Record<string, number> = {
      'goto': 3000,
      'click': 1000,
      'fill': 500,
      'waitFor': 2000,
      'select': 1000,
    };

    return defaults[operation] || 1000;
  }

  /**
   * Get selector stability score
   */
  getSelectorStability(selector: string, strategy: string, site?: string): number {
    const key = `${selector}-${strategy}-${site || 'global'}`;
    const perf = this.selectorPerformance.get(key);
    return perf?.stabilityScore || 0.5; // Default to medium stability
  }

  /**
   * Get performance report
   */
  getReport(): PerformanceReport {
    const bottlenecks = this.identifyBottlenecks();
    
    return {
      timestamp: Date.now(),
      totalCommands: Array.from(this.metrics.values()).reduce((sum, m) => sum + m.totalExecutions, 0),
      averageSuccessRate: this.calculateOverallSuccessRate(),
      bottlenecks,
      topSlowCommands: this.getTopSlowCommands(5),
      topUnstableSelectors: this.getTopUnstableSelectors(5),
      recommendations: this.generateRecommendations(),
    };
  }

  private calculateOverallSuccessRate(): number {
    let total = 0;
    let successful = 0;

    for (const metric of this.metrics.values()) {
      total += metric.totalExecutions;
      successful += metric.successfulExecutions;
    }

    return total > 0 ? successful / total : 0;
  }

  private getTopSlowCommands(limit: number): PerformanceMetrics[] {
    return Array.from(this.metrics.values())
      .filter(m => m.totalExecutions > 5)
      .sort((a, b) => b.p95 - a.p95)
      .slice(0, limit);
  }

  private getTopUnstableSelectors(limit: number): SelectorPerformance[] {
    return Array.from(this.selectorPerformance.values())
      .filter(s => s.totalUses > 5)
      .sort((a, b) => a.stabilityScore - b.stabilityScore)
      .slice(0, limit);
  }

  private generateRecommendations(): string[] {
    const recommendations: string[] = [];
    const bottlenecks = this.identifyBottlenecks();

    if (bottlenecks.length > 0) {
      recommendations.push(`Found ${bottlenecks.length} performance bottlenecks - review and optimize`);
    }

    const unstableSelectors = this.getTopUnstableSelectors(3);
    if (unstableSelectors.length > 0) {
      recommendations.push(`Consider healing or replacing ${unstableSelectors.length} unstable selectors`);
    }

    const slowCommands = this.getTopSlowCommands(3);
    if (slowCommands.length > 0) {
      recommendations.push(`Optimize ${slowCommands.length} slow commands for better performance`);
    }

    return recommendations;
  }

  /**
   * Clear old metrics (keep last N executions)
   */
  clearOldMetrics(keepLast: number = 1000): void {
    for (const metric of this.metrics.values()) {
      if (metric.durations.length > keepLast) {
        metric.durations = metric.durations.slice(-keepLast);
      }
    }
  }

  /**
   * Export metrics in Prometheus format
   */
  exportPrometheusMetrics(): string {
    const lines: string[] = [];
    
    // Command execution metrics
    for (const [, metric] of this.metrics.entries()) {
      const labels = `command="${metric.command}",site="${metric.site}"`;
      
      lines.push(`# HELP automation_command_total Total command executions`);
      lines.push(`# TYPE automation_command_total counter`);
      lines.push(`automation_command_total{${labels}} ${metric.totalExecutions}`);
      
      lines.push(`# HELP automation_command_success_total Successful command executions`);
      lines.push(`# TYPE automation_command_success_total counter`);
      lines.push(`automation_command_success_total{${labels}} ${metric.successfulExecutions}`);
      
      lines.push(`# HELP automation_command_duration_seconds Command execution duration`);
      lines.push(`# TYPE automation_command_duration_seconds histogram`);
      lines.push(`automation_command_duration_seconds{${labels}} ${metric.averageDuration / 1000}`);
      
      lines.push(`# HELP automation_command_duration_p95_seconds 95th percentile command duration`);
      lines.push(`# TYPE automation_command_duration_p95_seconds gauge`);
      lines.push(`automation_command_duration_p95_seconds{${labels}} ${metric.p95 / 1000}`);
    }

    // Selector performance metrics
    for (const [, perf] of this.selectorPerformance.entries()) {
      const labels = `selector="${perf.selector}",strategy="${perf.strategy}",site="${perf.site}"`;
      
      lines.push(`# HELP automation_selector_stability_score Selector stability score`);
      lines.push(`# TYPE automation_selector_stability_score gauge`);
      lines.push(`automation_selector_stability_score{${labels}} ${perf.stabilityScore}`);
      
      lines.push(`# HELP automation_selector_success_rate Selector success rate`);
      lines.push(`# TYPE automation_selector_success_rate gauge`);
      lines.push(`automation_selector_success_rate{${labels}} ${perf.successfulUses / perf.totalUses}`);
    }

    return lines.join('\n');
  }

  /**
   * Get metrics in JSON format for API
   */
  exportJSON(): {
    timestamp: number;
    commands: Array<{
      command: string;
      site: string;
      totalExecutions: number;
      successRate: number;
      averageDuration: number;
      p95: number;
    }>;
    selectors: Array<{
      selector: string;
      strategy: string;
      site: string;
      stabilityScore: number;
      successRate: number;
    }>;
    bottlenecks: Bottleneck[];
  } {
    return {
      timestamp: Date.now(),
      commands: Array.from(this.metrics.values()).map(m => ({
        command: m.command,
        site: m.site,
        totalExecutions: m.totalExecutions,
        successRate: m.successfulExecutions / m.totalExecutions,
        averageDuration: m.averageDuration,
        p95: m.p95,
      })),
      selectors: Array.from(this.selectorPerformance.values()).map(s => ({
        selector: s.selector,
        strategy: s.strategy,
        site: s.site,
        stabilityScore: s.stabilityScore,
        successRate: s.successfulUses / s.totalUses,
      })),
      bottlenecks: this.identifyBottlenecks(),
    };
  }

  /**
   * Start real-time metrics collection
   */
  startRealTimeCollection(intervalMs: number = 5000): () => void {
    const interval = setInterval(() => {
      // Export metrics periodically
      const metrics = this.exportJSON();
      // Could emit event or send to external system
      if (typeof process !== 'undefined' && process.emit) {
        process.emit('metrics:update', metrics);
      }
    }, intervalMs);

    return () => clearInterval(interval);
  }
}

// Types
interface PerformanceMetrics {
  command: string;
  site: string;
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  totalDuration: number;
  averageDuration: number;
  minDuration: number;
  maxDuration: number;
  p50: number;
  p95: number;
  p99: number;
  durations: number[];
}

interface SelectorPerformance {
  selector: string;
  strategy: string;
  site: string;
  totalUses: number;
  successfulUses: number;
  failedUses: number;
  averageDuration: number;
  totalDuration: number;
  stabilityScore: number;
  lastUsed: number;
}

interface TimingPattern {
  operation: string;
  site: string;
  pageType: string;
  samples: number[];
  optimalWait: number;
  averageDuration: number;
}

interface Bottleneck {
  type: 'slow_command' | 'high_failure_rate' | 'resource_exhaustion';
  severity: 'high' | 'medium' | 'low';
  command?: string;
  site?: string;
  averageDuration?: number;
  p95?: number;
  failureRate?: number;
  recommendation: string;
}

interface PerformanceReport {
  timestamp: number;
  totalCommands: number;
  averageSuccessRate: number;
  bottlenecks: Bottleneck[];
  topSlowCommands: PerformanceMetrics[];
  topUnstableSelectors: SelectorPerformance[];
  recommendations: string[];
}

