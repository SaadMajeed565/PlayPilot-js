import type { Job, ChromeRecorderJSON, ExecutionResult, ExecutionStatus } from '../types/index.js';
import { randomUUID } from 'crypto';

/**
 * Job Manager: Manages job lifecycle and storage
 */
export class JobManager {
  private jobs: Map<string, Job> = new Map();
  private logs: Map<string, string[]> = new Map();

  /**
   * Create a new job
   */
  async createJob(
    recorderJSON: ChromeRecorderJSON,
    _options?: {
      timeout?: number;
      retries?: number;
      debug?: boolean;
    }
  ): Promise<string> {
    const jobId = randomUUID();
    const job: Job = {
      id: jobId,
      status: 'pending',
      recorderJSON,
      createdAt: Date.now(),
    };

    this.jobs.set(jobId, job);
    this.logs.set(jobId, [`Job ${jobId} created at ${new Date().toISOString()}`]);

    return jobId;
  }

  /**
   * Get job by ID
   */
  getJob(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }

  /**
   * Update job status
   */
  updateJobStatus(
    jobId: string,
    status: ExecutionStatus,
    error?: string
  ): void {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }

    job.status = status;
    
    if (status === 'running' && !job.startedAt) {
      job.startedAt = Date.now();
    }
    
    if ((status === 'success' || status === 'failed') && !job.completedAt) {
      job.completedAt = Date.now();
    }

    if (error) {
      job.error = error;
    }

    this.jobs.set(jobId, job);
  }

  /**
   * Update job result
   */
  updateJobResult(jobId: string, result: ExecutionResult): void {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }

    job.result = result;
    this.jobs.set(jobId, job);
  }

  /**
   * Add log entry
   */
  addLog(jobId: string, message: string): void {
    if (!this.logs.has(jobId)) {
      this.logs.set(jobId, []);
    }

    const timestamp = new Date().toISOString();
    this.logs.get(jobId)!.push(`[${timestamp}] ${message}`);
  }

  /**
   * Get logs for a job
   */
  getLogs(jobId: string): string[] {
    return this.logs.get(jobId) || [];
  }

  /**
   * Get all jobs (for debugging/admin)
   */
  getAllJobs(): Job[] {
    return Array.from(this.jobs.values());
  }

  /**
   * Delete job (cleanup)
   */
  deleteJob(jobId: string): boolean {
    this.logs.delete(jobId);
    return this.jobs.delete(jobId);
  }
}

