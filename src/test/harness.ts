import { readFileSync } from 'fs';
import { AutomationPipeline } from '../core/Pipeline.js';
import { JobManager } from '../core/JobManager.js';
import type { ChromeRecorderJSON } from '../types/index.js';

/**
 * Test harness for evaluating automation pipeline
 */
export class TestHarness {
  private pipeline: AutomationPipeline;
  private jobManager: JobManager;

  constructor() {
    this.pipeline = new AutomationPipeline();
    this.jobManager = new JobManager();
  }

  /**
   * Test a recorder JSON file
   */
  async testRecorderJSON(
    recorderJSON: ChromeRecorderJSON,
    options?: { execute?: boolean }
  ): Promise<{
    success: boolean;
    jobId: string;
    result?: import('../types/index.js').ExecutionResult;
    metrics?: {
      conversionAccuracy: number;
      executionSuccess: boolean;
      selectorHealingRate?: number;
    };
  }> {
    const jobId = await this.jobManager.createJob(recorderJSON);

    try {
      if (options?.execute !== false) {
        await this.pipeline.processJob(jobId);
      } else {
        // Just validate conversion without execution
        // This would require exposing internal pipeline steps
      }

      const job = this.jobManager.getJob(jobId);
      const result = job?.result;

      // Calculate metrics
      const metrics = result
        ? {
            conversionAccuracy: 1.0, // Would calculate based on steps converted
            executionSuccess: result.status === 'success',
            selectorHealingRate:
              result.metrics?.selectorHealingAttempts && result.metrics.selectorHealingSuccesses
                ? result.metrics.selectorHealingSuccesses /
                  result.metrics.selectorHealingAttempts
                : undefined,
          }
        : undefined;

      return {
        success: job?.status === 'success',
        jobId,
        result,
        metrics,
      };
    } catch (error) {
      return {
        success: false,
        jobId,
        metrics: {
          conversionAccuracy: 0,
          executionSuccess: false,
        },
      };
    }
  }

  /**
   * Test multiple recorder JSON files
   */
  async testBatch(
    recorderJSONs: ChromeRecorderJSON[],
    options?: { execute?: boolean }
  ): Promise<{
    total: number;
    successful: number;
    failed: number;
    averageMetrics: {
      conversionAccuracy: number;
      executionSuccessRate: number;
      selectorHealingRate?: number;
    };
  }> {
    const results = await Promise.all(
      recorderJSONs.map(json => this.testRecorderJSON(json, options))
    );

    const successful = results.filter(r => r.success).length;
    const metrics = results
      .map(r => r.metrics)
      .filter((m): m is NonNullable<typeof m> => m !== undefined);

    const avgConversion = metrics.reduce((sum, m) => sum + m.conversionAccuracy, 0) / metrics.length;
    const avgExecution = metrics.filter(m => m.executionSuccess).length / metrics.length;
    const avgHealing = metrics
      .filter(m => m.selectorHealingRate !== undefined)
      .reduce((sum, m) => sum + (m.selectorHealingRate || 0), 0) /
      metrics.filter(m => m.selectorHealingRate !== undefined).length;

    return {
      total: results.length,
      successful,
      failed: results.length - successful,
      averageMetrics: {
        conversionAccuracy: avgConversion,
        executionSuccessRate: avgExecution,
        selectorHealingRate: avgHealing || undefined,
      },
    };
  }

  /**
   * Load and test a sample file
   */
  async testSampleFile(filePath: string): Promise<ReturnType<typeof this.testRecorderJSON>> {
    const content = readFileSync(filePath, 'utf-8');
    const recorderJSON: ChromeRecorderJSON = JSON.parse(content);
    return this.testRecorderJSON(recorderJSON);
  }
}

