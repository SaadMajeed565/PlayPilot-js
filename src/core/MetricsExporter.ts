import { Registry, Counter, Histogram, Gauge } from 'prom-client';
import type { PerformanceMonitor } from './PerformanceMonitor.js';

/**
 * MetricsExporter: Prometheus metrics exporter for real-time monitoring
 */
export class MetricsExporter {
  private registry: Registry;
  private commandCounter: Counter<string>;
  private commandDuration: Histogram<string>;
  private selectorStability: Gauge<string>;
  private selectorSuccessRate: Gauge<string>;
  private bottleneckGauge: Gauge<string>;

  constructor() {
    this.registry = new Registry();

    // Command execution counter
    this.commandCounter = new Counter({
      name: 'automation_command_total',
      help: 'Total number of automation commands executed',
      labelNames: ['command', 'site', 'status'],
      registers: [this.registry],
    });

    // Command duration histogram
    this.commandDuration = new Histogram({
      name: 'automation_command_duration_seconds',
      help: 'Duration of automation commands in seconds',
      labelNames: ['command', 'site'],
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
      registers: [this.registry],
    });

    // Selector stability gauge
    this.selectorStability = new Gauge({
      name: 'automation_selector_stability_score',
      help: 'Stability score of selectors (0-1)',
      labelNames: ['selector', 'strategy', 'site'],
      registers: [this.registry],
    });

    // Selector success rate gauge
    this.selectorSuccessRate = new Gauge({
      name: 'automation_selector_success_rate',
      help: 'Success rate of selectors (0-1)',
      labelNames: ['selector', 'strategy', 'site'],
      registers: [this.registry],
    });

    // Bottleneck gauge
    this.bottleneckGauge = new Gauge({
      name: 'automation_bottleneck_severity',
      help: 'Severity of performance bottlenecks (1=low, 2=medium, 3=high)',
      labelNames: ['type', 'command', 'site'],
      registers: [this.registry],
    });
  }

  /**
   * Update metrics from PerformanceMonitor
   */
  updateFromMonitor(monitor: PerformanceMonitor): void {
    const report = monitor.getReport();

    // Update command metrics
    for (const metric of report.topSlowCommands) {
      this.commandCounter.inc({
        command: metric.command,
        site: metric.site,
        status: 'total',
      }, metric.totalExecutions);

      this.commandCounter.inc({
        command: metric.command,
        site: metric.site,
        status: 'success',
      }, metric.successfulExecutions);

      this.commandDuration.observe(
        {
          command: metric.command,
          site: metric.site,
        },
        metric.averageDuration / 1000
      );
    }

    // Update selector metrics
    for (const selector of report.topUnstableSelectors) {
      this.selectorStability.set(
        {
          selector: selector.selector,
          strategy: selector.strategy,
          site: selector.site,
        },
        selector.stabilityScore
      );

      this.selectorSuccessRate.set(
        {
          selector: selector.selector,
          strategy: selector.strategy,
          site: selector.site,
        },
        selector.successfulUses / selector.totalUses
      );
    }

    // Update bottleneck metrics
    for (const bottleneck of report.bottlenecks) {
      const severity = bottleneck.severity === 'high' ? 3 : bottleneck.severity === 'medium' ? 2 : 1;
      this.bottleneckGauge.set(
        {
          type: bottleneck.type,
          command: bottleneck.command || 'unknown',
          site: bottleneck.site || 'global',
        },
        severity
      );
    }
  }

  /**
   * Get metrics in Prometheus format
   */
  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  /**
   * Reset all metrics
   */
  reset(): void {
    this.registry.resetMetrics();
  }

  /**
   * Get registry for custom metrics
   */
  getRegistry(): Registry {
    return this.registry;
  }
}

