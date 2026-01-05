import * as cron from 'node-cron';
import type { ScheduledTaskManager } from './ScheduledTaskManager.js';
import type { WebsiteManager } from './WebsiteManager.js';
import type { SessionManager } from './SessionManager.js';
import type { KnowledgeBase } from './KnowledgeBase.js';
import type { JobManager } from './JobManager.js';
import type { AutomationPipeline } from './Pipeline.js';

/**
 * TaskScheduler: Automatically executes scheduled tasks based on cron expressions
 */
export class TaskScheduler {
  private scheduledTaskManager: ScheduledTaskManager;
  private websiteManager: WebsiteManager;
  private sessionManager: SessionManager;
  private knowledgeBase: KnowledgeBase;
  private jobManager: JobManager;
  private pipeline: AutomationPipeline;
  private cronJobs: Map<string, cron.ScheduledTask> = new Map();
  private isRunning: boolean = false;

  constructor(
    scheduledTaskManager: ScheduledTaskManager,
    websiteManager: WebsiteManager,
    sessionManager: SessionManager,
    knowledgeBase: KnowledgeBase,
    jobManager: JobManager,
    pipeline: AutomationPipeline
  ) {
    this.scheduledTaskManager = scheduledTaskManager;
    this.websiteManager = websiteManager;
    this.sessionManager = sessionManager;
    this.knowledgeBase = knowledgeBase;
    this.jobManager = jobManager;
    this.pipeline = pipeline;
  }

  /**
   * Start the scheduler
   */
  start(): void {
    if (this.isRunning) {
      console.warn('Task scheduler is already running');
      return;
    }

    this.isRunning = true;
    console.log('🕐 Task scheduler started');

    // Load and schedule all existing tasks
    this.loadAndScheduleAll();

    // Also check every minute for new tasks or schedule changes
    setInterval(() => {
      this.syncSchedules();
    }, 60000); // Check every minute
  }

  /**
   * Stop the scheduler
   */
  stop(): void {
    this.isRunning = false;
    for (const [taskId, cronJob] of this.cronJobs.entries()) {
      cronJob.stop();
    }
    this.cronJobs.clear();
    console.log('🛑 Task scheduler stopped');
  }

  /**
   * Load all scheduled tasks and set up cron jobs
   */
  private loadAndScheduleAll(): void {
    const tasks = this.scheduledTaskManager.list();
    
    for (const task of tasks) {
      if (task.enabled) {
        this.scheduleTask(task);
      }
    }

    console.log(`📅 Scheduled ${this.cronJobs.size} task(s)`);
  }

  /**
   * Sync schedules - add new tasks, remove deleted ones, update changed ones
   */
  private syncSchedules(): void {
    const currentTasks = this.scheduledTaskManager.list();
    const currentTaskIds = new Set(currentTasks.map(t => t.id));

    // Remove tasks that no longer exist or are disabled
    for (const [taskId, cronJob] of this.cronJobs.entries()) {
      const task = currentTasks.find(t => t.id === taskId);
      if (!task || !task.enabled) {
        cronJob.stop();
        this.cronJobs.delete(taskId);
      }
    }

    // Add new tasks or update changed ones
    for (const task of currentTasks) {
      if (task.enabled) {
        if (!this.cronJobs.has(task.id)) {
          // New task
          this.scheduleTask(task);
        } else {
          // Check if schedule changed
          const existingCronJob = this.cronJobs.get(task.id);
          if (existingCronJob) {
            // For simplicity, reschedule if task was updated
            // (node-cron doesn't support updating schedules, so we recreate)
            existingCronJob.stop();
            this.cronJobs.delete(task.id);
            this.scheduleTask(task);
          }
        }
      }
    }
  }

  /**
   * Schedule a single task
   */
  private scheduleTask(scheduledTask: any): void {
    try {
      // Validate cron expression
      if (!cron.validate(scheduledTask.schedule)) {
        console.error(`Invalid cron expression for task ${scheduledTask.id}: ${scheduledTask.schedule}`);
        return;
      }

      // Create cron job
      const cronJob = cron.schedule(scheduledTask.schedule, async () => {
        await this.executeScheduledTask(scheduledTask);
      }, {
        scheduled: true,
        timezone: 'UTC', // You can make this configurable
      });

      this.cronJobs.set(scheduledTask.id, cronJob);
      
      // Calculate next run time
      const nextRun = this.calculateNextRun(scheduledTask.schedule);
      this.scheduledTaskManager.update(scheduledTask.id, { nextRun });

      console.log(`✅ Scheduled task "${scheduledTask.taskName || scheduledTask.taskId}" - Next run: ${nextRun ? new Date(nextRun).toISOString() : 'unknown'}`);
    } catch (error) {
      console.error(`Failed to schedule task ${scheduledTask.id}:`, error);
    }
  }

  /**
   * Execute a scheduled task
   */
  private async executeScheduledTask(scheduledTask: any): Promise<void> {
    console.log(`🚀 Executing scheduled task: ${scheduledTask.taskName || scheduledTask.taskId}`);
    
    try {
      // Update last run time
      this.scheduledTaskManager.update(scheduledTask.id, {
        lastRun: Date.now(),
      });

      // Get task data
      const taskData = this.websiteManager.getTask(scheduledTask.taskId);
      if (!taskData) {
        console.error(`Task ${scheduledTask.taskId} not found`);
        return;
      }

      const { task } = taskData;
      const website = this.websiteManager.getWebsite(task.websiteId);
      const siteId = website?.domain || task.websiteId;

      // Import required modules
      const { TaskExecutor } = await import('./TaskExecutor.js');
      const { launchBrowser } = await import('../utils/BrowserConfig.js');

      // Load session
      const savedSession = await this.sessionManager.loadSession(siteId);

      // Launch browser
      const headless = process.env.PLAYWRIGHT_HEADLESS === 'true';
      const userDataDir = process.env.PLAYWRIGHT_USER_DATA_DIR 
        ? `${process.env.PLAYWRIGHT_USER_DATA_DIR}/${siteId.replace(/[^a-z0-9]/gi, '_')}`
        : undefined;

      const proxyConfig = process.env.PROXY_SERVER ? {
        server: process.env.PROXY_SERVER,
        username: process.env.PROXY_USERNAME,
        password: process.env.PROXY_PASSWORD,
      } : undefined;

      // Use launcher page approach: opens launcher page + random background sites
      const launcherUrl = this.websiteManager.getLauncherUrl();
      
      const browserResult = await launchBrowser({
        headless,
        userDataDir,
        proxy: proxyConfig,
        storageState: savedSession as any,
        launcherUrl: launcherUrl, // Pass launcher page URL to open as one of the tabs
        // Don't pass automationUrl - we'll click link from launcher page instead
      });

      // Handle return type: can be BrowserContext or LaunchBrowserResult
      const persistentContext = 'context' in browserResult ? browserResult.context : browserResult;
      // Get any page from context (launcher page will be used by TaskExecutor)
      const page = 'launcherPage' in browserResult && browserResult.launcherPage 
        ? browserResult.launcherPage 
        : 'automationPage' in browserResult && browserResult.automationPage 
          ? browserResult.automationPage 
          : await persistentContext.newPage();
      const taskExecutor = new TaskExecutor(
        this.knowledgeBase,
        this.jobManager,
        this.pipeline,
        this.websiteManager
      );

      const taskForExecution = {
        id: task.id,
        websiteId: task.websiteId,
        name: task.name,
        description: task.description,
        recordings: task.recordings,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        successRate: task.successRate,
        totalExecutions: task.totalExecutions,
      };

      // Execute the task
      const result = await taskExecutor.executeTask(
        taskForExecution as any,
        scheduledTask.targetUrl,
        page,
        (scheduledTask.parameters || {}) as Record<string, string>
      );

      // Save session if successful
      if (result.success && persistentContext) {
        try {
          const storageState = await persistentContext.storageState();
          await this.sessionManager.saveSession(siteId, storageState);
        } catch (error) {
          console.warn(`Failed to save session for ${siteId}:`, error);
        }
      }

      await persistentContext.close();

      // Update next run time
      const nextRun = this.calculateNextRun(scheduledTask.schedule);
      this.scheduledTaskManager.update(scheduledTask.id, { nextRun });

      console.log(`✅ Scheduled task "${scheduledTask.taskName || scheduledTask.taskId}" completed: ${result.success ? 'SUCCESS' : 'FAILED'}`);
    } catch (error) {
      console.error(`❌ Failed to execute scheduled task ${scheduledTask.id}:`, error);
      
      // Update next run time even on failure
      const nextRun = this.calculateNextRun(scheduledTask.schedule);
      this.scheduledTaskManager.update(scheduledTask.id, { nextRun });
    }
  }

  /**
   * Calculate next run time from cron expression
   * This is a simplified version - for production, use a proper cron parser
   */
  private calculateNextRun(cronExpression: string): number | undefined {
    try {
      // Use node-cron's internal parsing or calculate manually
      // For now, return undefined and let node-cron handle it
      // In production, you might want to use a library like 'cron-parser'
      return undefined; // node-cron handles scheduling internally
    } catch {
      return undefined;
    }
  }

  /**
   * Manually trigger a scheduled task (for testing)
   */
  async triggerTask(taskId: string): Promise<void> {
    const task = this.scheduledTaskManager.get(taskId);
    if (task && task.enabled) {
      await this.executeScheduledTask(task);
    } else {
      throw new Error(`Task ${taskId} not found or disabled`);
    }
  }
}

