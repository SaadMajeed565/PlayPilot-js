/* eslint-disable @typescript-eslint/no-explicit-any */
import express, { type Request, type Response } from 'express';
import cors from 'cors';
import type {
  SubmitJobRequest,
  SubmitJobResponse,
  JobStatusResponse,
} from '../types/index.js';
import { AutomationPipeline } from '../core/Pipeline.js';
import { JobManager } from '../core/JobManager.js';
import { KnowledgeBase } from '../core/KnowledgeBase.js';
import { WebsiteManager } from '../core/WebsiteManager.js';
import { SessionManager, type StorageState } from '../core/SessionManager.js';
import { LoginSessionManager } from '../core/LoginSessionManager.js';
import { randomUUID } from 'crypto';
import { WebhookManager } from './webhooks.js';
import { TestCaseManager } from '../core/TestCaseManager.js';
import { ScheduledTaskManager } from '../core/ScheduledTaskManager.js';

const app = express();

// Enable CORS for frontend
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json());

// Note: These are initialized here for API endpoints
// The scheduler in index.ts uses its own instances to avoid circular dependencies
export const jobManager = new JobManager();
export const knowledgeBase = new KnowledgeBase();
export const pipeline = new AutomationPipeline(jobManager, knowledgeBase);
export const websiteManager = new WebsiteManager();
export const sessionManager = new SessionManager();
export const loginSessionManager = new LoginSessionManager();
const webhookManager = new WebhookManager();
const testCaseManager = new TestCaseManager();
export const scheduledTaskManager = new ScheduledTaskManager();

// Liveness and readiness probes
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

app.get('/ready', async (_req: Request, res: Response) => {
  // Basic readiness: ensure knowledge base initialized
  try {
    knowledgeBase.getStatistics();
    res.status(200).json({ status: 'ready' });
  } catch (error) {
    res.status(500).json({ status: 'degraded', error: error instanceof Error ? error.message : String(error) });
  }
});

/**
 * POST /api/jobs - Submit a new automation job
 */
app.post('/api/jobs', async (req: Request, res: Response) => {
  try {
    const request: SubmitJobRequest = req.body;

    if (!request.recorderJSON) {
      return res.status(400).json({ error: 'recorderJSON is required' });
    }

    const jobId = await jobManager.createJob(request.recorderJSON, request.options);

    // Process job asynchronously
    pipeline.processJob(jobId).catch((err: unknown) => {
      console.error(`Error processing job ${jobId}:`, err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      jobManager.updateJobStatus(jobId, 'failed', errorMessage);
    });

    const response: SubmitJobResponse = {
      jobId,
      status: 'pending',
    };

    // Trigger webhook for job created
    webhookManager.trigger('job.created', {
      jobId,
      status: 'pending',
      timestamp: Date.now(),
    }).catch(err => console.warn('Webhook delivery failed:', err));

    return res.json(response);
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

/**
 * GET /api/jobs - Get all jobs
 */
app.get('/api/jobs', async (_req: Request, res: Response) => {
  try {
    const allJobs = jobManager.getAllJobs();
    // Return minimal job info (just IDs) for listing
    const jobList = allJobs.map((job) => ({
      id: job.id,
      status: job.status,
      createdAt: job.createdAt,
    }));
    return res.json(jobList);
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

/**
 * GET /api/jobs/:jobId - Get job status
 */
app.get('/api/jobs/:jobId', async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    const job = jobManager.getJob(jobId);

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const response: JobStatusResponse = {
      jobId: job.id,
      status: job.status,
      result: job.result,
      logs: jobManager.getLogs(jobId),
    };

    // Include id and createdAt for frontend compatibility
    return res.json({
      ...response,
      id: job.id,
      createdAt: job.createdAt,
    });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

/**
 * GET /api/jobs/:jobId/artifacts - Get job artifacts (screenshots, HAR, etc.)
 */
app.get('/api/jobs/:jobId/artifacts', async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    const job = jobManager.getJob(jobId);

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    if (!job.result?.artifacts) {
      return res.status(404).json({ error: 'No artifacts available' });
    }

    return res.json(job.result.artifacts);
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

/**
 * POST /api/jobs/:jobId/replay - Replay job in debug mode
 */
app.post('/api/jobs/:jobId/replay', async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    const job = jobManager.getJob(jobId);

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Create new job with same recorder JSON but debug mode
    const newJobId = await jobManager.createJob(job.recorderJSON, {
      ...req.body.options,
      debug: true,
    });

    await pipeline.processJob(newJobId);

    const newJob = jobManager.getJob(newJobId);
    return res.json({
      jobId: newJobId,
      status: newJob?.status,
      result: newJob?.result,
    });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

/**
 * GET /api/knowledge - Get knowledge base statistics
 */
app.get('/api/knowledge', (_req: Request, res: Response) => {
  try {
    const stats = knowledgeBase.getStatistics();
    return res.json(stats);
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

/**
 * GET /api/knowledge/site/:site - Get site-specific patterns
 */
app.get('/api/knowledge/site/:site', async (req: Request, res: Response) => {
  try {
    const { site } = req.params;
    const patterns = await knowledgeBase.getSitePatterns(site);
    const intents = await knowledgeBase.getSiteIntents(site);

    if (!patterns) {
      return res.status(404).json({ error: 'Site patterns not found' });
    }

    return res.json({
      site,
      intents,
      commonIntents: Object.fromEntries(patterns.commonIntents),
      commonSelectors: Object.fromEntries(patterns.commonSelectors),
      commonFlows: patterns.commonFlows,
      successRate: patterns.successRate,
      totalJobs: patterns.totalJobs,
      lastUpdated: patterns.lastUpdated,
    });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

/**
 * POST /api/websites - Create a new website
 */
app.post('/api/websites', (req: Request, res: Response) => {
  try {
    const { domain, name, description } = req.body;
    if (!domain) {
      return res.status(400).json({ error: 'Domain is required' });
    }
    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    const websiteId = websiteManager.createWebsite(domain, name, description);
    const website = websiteManager.getWebsite(websiteId);
    return res.json(website);
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

/**
 * GET /api/websites - Get all websites
 */
app.get('/api/websites', (_req: Request, res: Response) => {
  try {
    const websites = websiteManager.getAllWebsites();
    return res.json(websites);
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

/**
 * GET /api/websites/:websiteId - Get website details
 */
app.get('/api/websites/:websiteId', (req: Request, res: Response) => {
  try {
    const { websiteId } = req.params;
    const website = websiteManager.getWebsite(websiteId);

    if (!website) {
      return res.status(404).json({ error: 'Website not found' });
    }

    return res.json(website);
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

/**
 * DELETE /api/websites/:websiteId - Delete a website and all its tasks/recordings
 */
app.delete('/api/websites/:websiteId', (req: Request, res: Response) => {
  try {
    const { websiteId } = req.params;
    const website = websiteManager.getWebsite(websiteId);

    if (!website) {
      return res.status(404).json({ error: 'Website not found' });
    }

    // Delete website (this also deletes all tasks and recordings)
    websiteManager.deleteWebsite(websiteId);
    
    return res.json({ 
      message: 'Website deleted successfully',
      websiteId,
      deletedTasks: website.tasks.length,
      deletedRecordings: website.totalRecordings
    });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

/**
 * POST /api/websites/:websiteId/tasks - Create a task for a website
 */
app.post('/api/websites/:websiteId/tasks', (req: Request, res: Response) => {
  try {
    const { websiteId } = req.params;
    const { name, description } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Task name is required' });
    }

    const taskId = websiteManager.createTask(websiteId, name, description || '');
    const taskData = websiteManager.getTask(taskId);
    
    if (!taskData) {
      return res.status(500).json({ error: 'Failed to create task' });
    }

    return res.json(taskData.task);
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

/**
 * GET /api/websites/:websiteId/tasks - Get all tasks for a website
 */
app.get('/api/websites/:websiteId/tasks', (req: Request, res: Response) => {
  try {
    const { websiteId } = req.params;
    const tasks = websiteManager.getWebsiteTasks(websiteId);
    return res.json(tasks);
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

/**
 * GET /api/tasks/:taskId - Get task details
 */
app.get('/api/tasks/:taskId', (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;
    const taskData = websiteManager.getTask(taskId);

    if (!taskData) {
      return res.status(404).json({ error: 'Task not found' });
    }

    return res.json({
      ...taskData.task,
      website: {
        id: taskData.website.id,
        domain: taskData.website.domain,
        name: taskData.website.name,
      },
    });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

/**
 * GET /api/tasks/:taskId/inputs - Get input fields for a task
 */
app.get('/api/tasks/:taskId/inputs', (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;
    const taskData = websiteManager.getTask(taskId);

    if (!taskData) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const { task } = taskData;
    const inputs: Array<{ name: string; selector?: string; defaultValue?: string; label: string }> = [];
    const seenSelectors = new Set<string>();

    // Process ALL recordings to find all input fields
    // Sort by success rate and recency to prioritize better recordings
    const sortedRecordings = [...task.recordings].sort((a, b) => 
      (b.success ? 1 : 0) - (a.success ? 1 : 0) || b.recordedAt - a.recordedAt
    );

    let inputIndex = 0;

    for (const recording of sortedRecordings) {
      // First, try to extract from processed actions
      for (const action of recording.actions || []) {
        for (const step of action.steps || []) {
          if (step.action === 'fill' && step.target?.selector) {
            const selector = step.target.selector;
            // Skip if we've already seen this selector
            if (!seenSelectors.has(selector)) {
              seenSelectors.add(selector);
              const defaultValue = step.value || '';
              inputs.push({
                name: `input_${inputIndex}`,
                selector,
                defaultValue,
                label: `Input ${inputIndex + 1} (${selector})`,
              });
              inputIndex++;
            }
          }
        }
      }

      // Also check original recorderJSON for input/change steps
      if (recording.recorderJSON?.steps) {
        for (const step of recording.recorderJSON.steps) {
          if ((step.type === 'input' || step.type === 'change') && step.value) {
            // Extract selector from selectors array (Chrome Recorder format)
            let selector = 'unknown';
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const stepAny = step as any;
            if (Array.isArray(stepAny.selectors) && stepAny.selectors.length > 0) {
              const firstArray = stepAny.selectors[0];
              if (Array.isArray(firstArray) && firstArray.length > 0) {
                // Prefer CSS selectors
                for (let i = 0; i < firstArray.length; i++) {
                  const sel = String(firstArray[i]);
                  if (!sel.startsWith('aria/') && !sel.startsWith('xpath/') && !sel.startsWith('pierce/')) {
                    selector = sel;
                    break;
                  }
                }
                // If no CSS selector found, use first one
                if (selector === 'unknown' && firstArray.length > 0) {
                  selector = String(firstArray[0]);
                }
              }
            } else if (stepAny.selector) {
              selector = stepAny.selector;
            }
            
            // Skip if we've already seen this selector (unless it's 'unknown')
            if (selector === 'unknown' || !seenSelectors.has(selector)) {
              if (selector !== 'unknown') {
                seenSelectors.add(selector);
              }
              inputs.push({
                name: `input_${inputIndex}`,
                selector: selector !== 'unknown' ? selector : undefined,
                defaultValue: step.value,
                label: `Input ${inputIndex + 1}${selector !== 'unknown' ? ` (${selector})` : ''}`,
              });
              inputIndex++;
            }
          }
        }
      }
    }

    return res.json({ inputs });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

/**
 * POST /api/tasks/:taskId/recordings - Add recording to task
 */
app.post('/api/tasks/:taskId/recordings', async (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;
    const { recorderJSON, targetUrl: providedTargetUrl } = req.body;

    if (!recorderJSON) {
      return res.status(400).json({ error: 'recorderJSON is required' });
    }

    // Process recording to extract actions
    const jobId = await jobManager.createJob(recorderJSON);
    await pipeline.processJob(jobId);
    const job = jobManager.getJob(jobId);

    if (!job || !job.result) {
      return res.status(500).json({ error: 'Failed to process recording' });
    }

    // Extract metadata to get target URL from recording
    const { Preprocessor } = await import('../core/Preprocessor.js');
    const preprocessor = new Preprocessor();
    const metadata = preprocessor.extractMetadata(recorderJSON);
    
    // Use provided target URL or auto-extract from recording (last navigation URL)
    const targetUrl = providedTargetUrl || metadata.targetUrl;

    // Extract actions from job (simplified - would extract from pipeline)
    // For now, we'll extract from the normalized recording
    const normalized = preprocessor.normalize(recorderJSON);
    const { IntentExtractor } = await import('../core/IntentExtractor.js');
    const intentExtractor = new IntentExtractor();
    const actions = await intentExtractor.extractIntents(normalized, false);

    const recordingId = websiteManager.addRecording(
      taskId,
      recorderJSON,
      actions,
      job.status === 'success',
      targetUrl
    );

    // Trigger webhook for recording added
    webhookManager.trigger('recording.added', {
      recordingId,
      taskId,
      success: job.status === 'success',
      timestamp: Date.now(),
    }).catch(err => console.warn('Webhook delivery failed:', err));

    return res.json({ 
      recordingId, 
      taskId,
      targetUrl: targetUrl || 'Auto-extracted from recording',
      message: targetUrl 
        ? 'Recording added with provided target URL' 
        : 'Recording added with auto-extracted target URL from recording'
    });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

/**
 * PUT /api/tasks/:taskId/recordings/:recordingId - Update an existing recording
 */
app.put('/api/tasks/:taskId/recordings/:recordingId', async (req: Request, res: Response) => {
  try {
    const { taskId, recordingId } = req.params;
    const { recorderJSON, targetUrl: providedTargetUrl, success } = req.body;

    if (recorderJSON === undefined && providedTargetUrl === undefined && success === undefined) {
      return res.status(400).json({ error: 'Provide recorderJSON, targetUrl, or success to update' });
    }

    const existing = websiteManager.getRecording(taskId, recordingId);
    if (!existing) {
      return res.status(404).json({ error: 'Recording not found' });
    }

    const { recording } = existing;
    const newRecorderJSON = recorderJSON ?? recording.recorderJSON;
    let newTargetUrl = providedTargetUrl ?? recording.targetUrl;
    let newActions = recording.actions;

    if (recorderJSON) {
      const { Preprocessor } = await import('../core/Preprocessor.js');
      const preprocessor = new Preprocessor();
      const metadata = preprocessor.extractMetadata(newRecorderJSON);
      const normalized = preprocessor.normalize(newRecorderJSON);
      const { IntentExtractor } = await import('../core/IntentExtractor.js');
      const intentExtractor = new IntentExtractor();
      newActions = await intentExtractor.extractIntents(normalized, false);

      // Auto-extract target URL if not explicitly provided
      if (providedTargetUrl === undefined) {
        newTargetUrl = metadata.targetUrl || recording.targetUrl;
      }
    }

    const updated = websiteManager.updateRecording(taskId, recordingId, {
      recorderJSON: newRecorderJSON,
      actions: newActions,
      targetUrl: newTargetUrl,
      success: success ?? recording.success,
    });

    return res.json({ recording: updated });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

/**
 * DELETE /api/tasks/:taskId/recordings/:recordingId - Delete a recording
 */
app.delete('/api/tasks/:taskId/recordings/:recordingId', (req: Request, res: Response) => {
  try {
    const { taskId, recordingId } = req.params;
    websiteManager.deleteRecording(taskId, recordingId);
    return res.json({ message: 'Recording deleted', recordingId, taskId });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

/**
 * POST /api/tasks/:taskId/execute - Execute a task
 */
app.post('/api/tasks/:taskId/execute', async (req: Request, res: Response) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let persistentContext: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let page: any = null;

  try {
    const { taskId } = req.params;
    const { targetUrl, parameters } = req.body;

    if (!targetUrl) {
      return res.status(400).json({ error: 'targetUrl is required' });
    }

    const taskData = websiteManager.getTask(taskId);
    if (!taskData) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const { task } = taskData;

    // Check if task has recordings
    if (!task.recordings || task.recordings.length === 0) {
      return res.status(400).json({
        error: 'Task has no recordings. Add recordings to train the model first.',
      });
    }

    // Import required modules
    const { TaskExecutor } = await import('../core/TaskExecutor.js');
    const { launchBrowser, humanBehavior } = await import('../utils/BrowserConfig.js');
    // TaskExecutor expects Task type (from types/index.ts), WebsiteManager's Task has compatible structure
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

    // Get website and site ID for session management
    const website = websiteManager.getWebsite(task.websiteId);
    const siteId = website?.domain || task.websiteId;
    const savedSession = await sessionManager.loadSession(siteId);

    // Launch browser with basic configuration
    const headless = process.env.PLAYWRIGHT_HEADLESS === 'true';
    const userDataDir = process.env.PLAYWRIGHT_USER_DATA_DIR 
      ? `${process.env.PLAYWRIGHT_USER_DATA_DIR}/${siteId.replace(/[^a-z0-9]/gi, '_')}`
      : undefined;

    // Proxy configuration (optional)
    const proxyConfig = process.env.PROXY_SERVER ? {
      server: process.env.PROXY_SERVER,
      username: process.env.PROXY_USERNAME,
      password: process.env.PROXY_PASSWORD,
    } : undefined;

    // Launch browser context - start with latest tablet for tasks
    // Will switch to mobile only if login is needed
    // Use launcher page approach: opens launcher page + random background sites
    const launcherUrl = websiteManager.getLauncherUrl();
    const browserResult = await launchBrowser({
      headless,
      userDataDir,
      proxy: proxyConfig,
      storageState: savedSession ? savedSession as any : undefined, // Load cookies from saved session
      device: 'Galaxy Tab S7', // Start with Android tablet viewport for tasks
      launcherUrl: launcherUrl, // Pass launcher page URL to open as one of the tabs
      // Don't pass automationUrl - we'll click link from launcher page instead
    });
    
    // Handle return type: can be BrowserContext or LaunchBrowserResult
    persistentContext = 'context' in browserResult ? browserResult.context : browserResult;
    // Get any page from context (launcher page will be used by TaskExecutor)
    page = 'launcherPage' in browserResult && browserResult.launcherPage 
      ? browserResult.launcherPage 
      : 'automationPage' in browserResult && browserResult.automationPage 
        ? browserResult.automationPage 
        : await persistentContext.newPage();
    
    // Explicitly set tablet viewport for tasks (will switch to mobile if login needed)
    const { switchViewport } = await import('../utils/BrowserConfig.js');
    await switchViewport(page, 'tablet');
    console.log('✓ Set page to tablet viewport for task execution');
    
    // Add human-like behavior before starting (simulates browsing)
    await humanBehavior(page);

    // Create TaskExecutor instance with WebsiteManager for cross-task knowledge
    const taskExecutor = new TaskExecutor(knowledgeBase, jobManager, pipeline, websiteManager);

    // Execute the task (TaskExecutor expects Task type, structure is compatible)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await taskExecutor.executeTask(
      taskForExecution as any,
      targetUrl,
      page,
      parameters
    );

    // CRITICAL: Save session after successful execution to persist cookies, localStorage, etc.
    // This is especially important after login to maintain session across runs
    if (result.success && persistentContext) {
      try {
        const storageState = await persistentContext.storageState();
        
        
        // Add metadata (geolocation) to storage state if we have it
        const storageStateWithMetadata = {
          ...storageState,
          metadata: savedSession?.metadata ? {
            ...(savedSession.metadata.timezoneId && { timezoneId: savedSession.metadata.timezoneId }),
            ...(savedSession.metadata.userAgent && { userAgent: savedSession.metadata.userAgent }),
          } : undefined,
        };
        
        await sessionManager.saveSession(siteId, storageStateWithMetadata);
        console.log(`Session saved for ${siteId}`);
    } catch (error) {
        console.warn(`Failed to save session for ${siteId}:`, error);
        // Don't fail the request if session save fails, but log it
      }
    }

    // Update task execution stats
    websiteManager.recordExecution(taskId, result.success);

    // Trigger webhook for task execution
    webhookManager.trigger('task.executed', {
      taskId,
      success: result.success,
      targetUrl,
      timestamp: Date.now(),
    }).catch(err => console.warn('Webhook delivery failed:', err));

    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  } finally {
    // Clean up browser
    if (page) {
      try {
        await page.close();
      } catch (e) {
        // Ignore cleanup errors
      }
    }
    if (persistentContext) {
      try {
        await persistentContext.close();
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  }
});

/**
 * POST /api/tasks/execute-sequence - Execute multiple tasks sequentially in one browser session
 * Expects body: { tasks: [{ taskId, targetUrl, parameters? }, ...] }
 * All tasks must belong to the same website so cookies and storage can be reused.
 */
app.post('/api/tasks/execute-sequence', async (req: Request, res: Response) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let persistentContext: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let page: any = null;

  try {
    const { tasks } = req.body;

    if (!Array.isArray(tasks) || tasks.length === 0) {
      return res.status(400).json({ error: 'Provide a non-empty tasks array' });
    }

    // Expand each task to allow repeats/parameter sets within the sequence
    const expandedTasks = tasks.flatMap((t: any) => {
      if (!t?.taskId || !t?.targetUrl) {
        return [];
      }

      // If parametersList is provided, one run per entry
      if (Array.isArray(t.parametersList) && t.parametersList.length > 0) {
        return t.parametersList.map((params: Record<string, string>) => ({
          taskId: t.taskId,
          targetUrl: t.targetUrl,
          parameters: params,
        }));
      }

      // Otherwise, repeat the same parameters for `runs` times (default 1)
      const repeatCount = Number.isFinite(Number(t.runs)) ? Math.max(1, Number(t.runs)) : 1;
      return Array.from({ length: repeatCount }, () => ({
        taskId: t.taskId,
        targetUrl: t.targetUrl,
        parameters: t.parameters as Record<string, string> | undefined,
      }));
    });

    if (expandedTasks.length === 0) {
      return res.status(400).json({ error: 'Each task must include taskId and targetUrl' });
    }

    // Resolve tasks and ensure they all belong to the same website
    const taskEntries = expandedTasks.map((t: any) => {
      const taskData = websiteManager.getTask(t.taskId);
      if (!taskData) {
        throw new Error(`Task not found: ${t.taskId}`);
      }
      return {
        website: taskData.website,
        task: taskData.task,
        targetUrl: t.targetUrl,
        parameters: t.parameters,
      };
    });

    const websiteIds = new Set(taskEntries.map(entry => entry.task.websiteId));
    if (websiteIds.size > 1) {
      return res.status(400).json({
        error: 'All tasks must belong to the same website for sequential execution',
      });
    }

    const siteId = taskEntries[0].website.domain || taskEntries[0].task.websiteId;
    const savedSession = await sessionManager.loadSession(siteId);

    const { TaskExecutor } = await import('../core/TaskExecutor.js');
    const { launchBrowser, humanBehavior, switchViewport } = await import('../utils/BrowserConfig.js');

    // Launch a single persistent browser for the whole sequence
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
    const launcherUrl = websiteManager.getLauncherUrl();
    
    const browserResult = await launchBrowser({
      headless,
      userDataDir,
      proxy: proxyConfig,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      storageState: savedSession ? savedSession as any : undefined,
      device: 'Galaxy Tab S7', // start with tablet; TaskExecutor may switch as needed
      launcherUrl: launcherUrl, // Pass launcher page URL to open as one of the tabs
      // Don't pass automationUrl - we'll click link from launcher page instead
    });

    // Handle return type: can be BrowserContext or LaunchBrowserResult
    persistentContext = 'context' in browserResult ? browserResult.context : browserResult;
    // Get any page from context (launcher page will be used by TaskExecutor)
    page = 'launcherPage' in browserResult && browserResult.launcherPage 
      ? browserResult.launcherPage 
      : 'automationPage' in browserResult && browserResult.automationPage 
        ? browserResult.automationPage 
        : await persistentContext.newPage();
    await switchViewport(page, 'tablet');
    await humanBehavior(page);

    const taskExecutor = new TaskExecutor(knowledgeBase, jobManager, pipeline, websiteManager);

    const results: Array<{
      taskId: string;
      targetUrl: string;
      success: boolean;
      result: any;
      error?: string;
    }> = [];

    // Track previous targetUrl and parameters to skip navigation for truly repeated tasks
    let previousTargetUrl: string | null = null;
    let previousParameters: Record<string, string> | undefined = undefined;

    for (const entry of taskEntries) {
      const { task, targetUrl, parameters } = entry;

      if (!task.recordings || task.recordings.length === 0) {
        results.push({
          taskId: task.id,
          targetUrl,
          success: false,
          result: null,
          error: 'Task has no recordings. Add recordings to train the model first.',
        });
        continue;
      }

      // Align shape with Task type (structure matches)
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

      // Skip navigation only if both targetUrl AND parameters are the same
      // If parameters differ, we need to navigate to reset the page state
      const parametersMatch = previousParameters !== undefined && 
        JSON.stringify(previousParameters || {}) === JSON.stringify(parameters || {});
      const skipNavigation = previousTargetUrl !== null && 
                             previousTargetUrl === targetUrl && 
                             parametersMatch;

      // Add 5-second delay before repetitive tasks to avoid overwhelming the page
      if (skipNavigation) {
        await new Promise(resolve => setTimeout(resolve, 5000));
      }

      try {
        const result = await taskExecutor.executeTask(
          taskForExecution as any,
          targetUrl,
          page,
          parameters,
          skipNavigation
        );
        websiteManager.recordExecution(task.id, result.success);
        results.push({
          taskId: task.id,
          targetUrl,
          success: result.success,
          result,
        });
        
        // Update previous targetUrl and parameters only if task succeeded
        if (result.success) {
          previousTargetUrl = targetUrl;
          previousParameters = parameters;
        } else {
          // If task failed, reset previousTargetUrl and parameters so next task will navigate
          previousTargetUrl = null;
          previousParameters = undefined;
        }
      } catch (taskError) {
        results.push({
          taskId: task.id,
          targetUrl,
          success: false,
          result: null,
          error: taskError instanceof Error ? taskError.message : String(taskError),
        });
        // Reset previousTargetUrl and parameters on error so next task will navigate
        previousTargetUrl = null;
        previousParameters = undefined;
      }
    }

    // Save session if any task succeeded
    if (results.some(r => r.success) && persistentContext) {
      try {
        const storageState = await persistentContext.storageState();
        const storageStateWithMetadata = {
          ...storageState,
          metadata: savedSession?.metadata ? {
            ...(savedSession.metadata.timezoneId && { timezoneId: savedSession.metadata.timezoneId }),
            ...(savedSession.metadata.userAgent && { userAgent: savedSession.metadata.userAgent }),
          } : undefined,
        };
        await sessionManager.saveSession(siteId, storageStateWithMetadata as StorageState);
        console.log(`Sequential session saved for ${siteId}`);
      } catch (error) {
        console.warn(`Failed to save sequential session for ${siteId}:`, error);
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failureCount = results.length - successCount;

    return res.json({
      success: failureCount === 0,
      successCount,
      failureCount,
      results,
    });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {
        // Ignore cleanup errors
      }
    }
    if (persistentContext) {
      try {
        await persistentContext.close();
      } catch {
        // Ignore cleanup errors
      }
    }
  }
});

/**
 * POST /api/sessions/:siteId/login - Start login session (opens browser for user to login)
 * Opens browser in TABLET viewport for easier login and reCAPTCHA handling
 */
app.post('/api/sessions/:siteId/login', async (req: Request, res: Response) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let persistentContext: any = null;
  
  try {
    const { siteId } = req.params;
    const { loginUrl } = req.body;

    if (!loginUrl) {
      return res.status(400).json({ error: 'loginUrl is required' });
    }

    // Use the same userDataDir pattern as task execution
    const { launchBrowser } = await import('../utils/BrowserConfig.js');
    
    const userDataDir = process.env.PLAYWRIGHT_USER_DATA_DIR 
      ? `${process.env.PLAYWRIGHT_USER_DATA_DIR}/${siteId.replace(/[^a-z0-9]/gi, '_')}`
      : undefined;

    // Load existing session if available
    const savedSession = await sessionManager.loadSession(siteId);

    // Proxy configuration
    const proxyConfig = process.env.PROXY_SERVER ? {
      server: process.env.PROXY_SERVER,
      username: process.env.PROXY_USERNAME,
      password: process.env.PROXY_PASSWORD,
    } : undefined;

    // Launch browser with TABLET viewport for login (easier reCAPTCHA, simpler UI)
    // Browser runs headless by default but can be configured via PLAYWRIGHT_HEADLESS env var
    // Note: Screenshot streaming works best in headless mode
    const headless = process.env.PLAYWRIGHT_HEADLESS !== 'true'; // Default to true unless explicitly set to false
    
    // For login sessions, we can use direct navigation or launcher page
    // Using launcher page for consistency and anti-detection
    const launcherUrl = websiteManager.getLauncherUrl();
    
    const browserResult = await launchBrowser({
      headless, // Configurable via PLAYWRIGHT_HEADLESS env var (default: true)
      userDataDir,
      proxy: proxyConfig,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      storageState: savedSession ? savedSession as any : undefined,
      startWithMobile: false, // Start with tablet viewport for login (changed from mobile)
      launcherUrl: launcherUrl, // Pass launcher page URL to open as one of the tabs
      // For login, we might navigate directly, but launcher page still opens for consistency
    });

    // Handle return type: can be BrowserContext or LaunchBrowserResult
    persistentContext = 'context' in browserResult ? browserResult.context : browserResult;
    
    // Helper function to extract domain from URL
    const extractDomain = (url: string): string => {
      try {
        const urlObj = new URL(url.startsWith('http') ? url : `https://${url}`);
        return urlObj.hostname.replace(/^www\./, '');
      } catch {
        return url.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
      }
    };
    
    // Try to use launcher page approach (clicking link) like tasks do
    let loginPage: any = null;
    let useLauncher = false;
    
    if (launcherUrl) {
      try {
        // Find launcher page in open tabs
        const allPages = persistentContext.pages();
        let launcherPage: any = null;
        
        for (const openPage of allPages) {
          try {
            const pageUrl = openPage.url();
            if (pageUrl.includes('launcher.html') || pageUrl === launcherUrl || pageUrl.includes('launcher')) {
              launcherPage = openPage;
              console.log('✓ Found existing launcher page tab for login');
              break;
            }
          } catch {
            continue;
          }
        }
        
        // If launcher page found, click the website link instead of using goto()
        if (launcherPage) {
          const domain = extractDomain(loginUrl);
          const website = websiteManager.getAllWebsites().find(w => 
            w.domain === domain || w.domain.includes(domain) || domain.includes(w.domain)
          );
          
          if (website) {
            const linkSelector = `a[data-website-id="${website.id}"], a[data-domain*="${domain}"]`;
            console.log(`[Login] Clicking website link on launcher page: ${linkSelector}`);
            
            // Wait for link to be visible
            await launcherPage.waitForSelector(linkSelector, { timeout: 20000, state: 'visible' });
            
            // Click the link (will open in new tab via target="_blank")
            const [newPage] = await Promise.all([
              persistentContext.waitForEvent('page', { timeout: 30000 }),
              launcherPage.click(linkSelector, { timeout: 20000 })
            ]);
            
            if (newPage) {
              loginPage = newPage;
              useLauncher = true;
              console.log('✓ Login page opened via launcher page click');
            }
          }
        }
      } catch (launcherError) {
        console.warn('Launcher page navigation failed for login, falling back to direct navigation:', launcherError);
      }
    }
    
    // If launcher approach didn't work, use direct navigation
    if (!loginPage) {
      loginPage = 'automationPage' in browserResult && browserResult.automationPage 
        ? browserResult.automationPage 
        : await persistentContext.newPage();
    }
    
    // Explicitly set tablet viewport for login page
    const { switchViewport } = await import('../utils/BrowserConfig.js');
    await switchViewport(loginPage, 'tablet');
    console.log('✓ Login page opened in tablet viewport');
    
    // Suppress console errors for React Router conflicts before navigation
    await loginPage.addInitScript(() => {
      const originalError = console.error;
      console.error = function(...args: any[]) {
        // Convert all arguments to string for checking
        const message = args.map(arg => {
          if (typeof arg === 'string') return arg;
          if (arg instanceof Error) return arg.message || arg.toString();
          try {
            return JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        }).join(' ');
        
        // Suppress React Router nesting errors - check for various message formats (including exact ChatGPT error)
        if (message.includes('router inside another router') || 
            message.includes('Router inside another Router') ||
            message.includes('<Router> inside another <Router>') ||
            message.includes('cannot render a <Router>') ||
            message.includes('cannot render a Router') ||
            message.includes('You cannot render a Router inside another Router') ||
            message.includes('You cannot render a <Router> inside another <Router>') ||
            message.includes('You should never have more than one in your app') ||
            message.includes('should never have more than one')) {
          return; // Suppress this specific error
        }
        originalError.apply(console, args);
      };
      
      // Catch uncaught errors that would crash the page (like React Router errors)
      window.addEventListener('error', function(event: ErrorEvent) {
        const errorMessage = event.message || event.error?.message || String(event.error || '');
        // Suppress React Router nesting errors that are false positives (including exact ChatGPT error format)
        if (errorMessage.includes('router inside another router') ||
            errorMessage.includes('Router inside another Router') ||
            errorMessage.includes('<Router> inside another <Router>') ||
            errorMessage.includes('cannot render a <Router>') ||
            errorMessage.includes('cannot render a Router') ||
            errorMessage.includes('You cannot render a Router inside another Router') ||
            errorMessage.includes('You cannot render a <Router> inside another <Router>') ||
            errorMessage.includes('You should never have more than one in your app') ||
            errorMessage.includes('should never have more than one')) {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          return false; // Prevent error from crashing the page
        }
      }, true); // Use capture phase to catch early
      
      // Catch unhandled promise rejections
      window.addEventListener('unhandledrejection', function(event: PromiseRejectionEvent) {
        const reason = (event.reason as Error)?.message || String(event.reason || '');
        if (reason.includes('router inside another router') ||
            reason.includes('Router inside another Router') ||
            reason.includes('<Router> inside another <Router>') ||
            reason.includes('cannot render a <Router>') ||
            reason.includes('cannot render a Router') ||
            reason.includes('You cannot render a Router inside another Router') ||
            reason.includes('You cannot render a <Router> inside another <Router>') ||
            reason.includes('You should never have more than one in your app') ||
            reason.includes('should never have more than one')) {
          event.preventDefault();
          event.stopPropagation();
        }
      });
    }).catch(() => {}); // Ignore if script injection fails

    // Only use goto() if launcher page approach didn't work
    if (!useLauncher) {
      await loginPage.goto(loginUrl, { waitUntil: 'networkidle', timeout: 30000 });
    } else {
      // Wait for navigation to complete after clicking launcher link
      await loginPage.waitForLoadState('domcontentloaded', { timeout: 30000 });
    }
    
    // Wait a bit for page to fully render before starting screenshot stream
    await new Promise(resolve => setTimeout(resolve, 500));

    const sessionId = randomUUID();
    // Store context instead of browser (since we're using persistent context)
    // Also store reference to the login page
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    loginSessionManager.createSession(sessionId, siteId, persistentContext as any, persistentContext, loginUrl, loginPage);

    // Note: Session is only saved when user explicitly clicks "Done" or "Save Session"
    // No automatic capture on context close - user controls when to save
    // With persistent context, cookies are already persisted in userDataDir automatically

    return res.json({
      success: true,
      sessionId,
      siteId,
      loginUrl,
      message: 'Browser opened for login. Use the browser viewer in the UI to complete login.',
    });
  } catch (error) {
    // Cleanup on error
    if (persistentContext) {
      try {
        await persistentContext.close();
      } catch {
        // Ignore cleanup errors
      }
    }
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

/**
 * GET /api/sessions/:siteId/status/:sessionId - Check login session status
 */
app.get('/api/sessions/:siteId/status/:sessionId', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const session = loginSessionManager.getSession(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    return res.json({
      sessionId,
      siteId: session.siteId,
      status: session.status,
      loginUrl: session.loginUrl,
      createdAt: session.createdAt,
    });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

/**
 * POST /api/sessions/:siteId/done/:sessionId - User clicked "Done" - capture and save session
 */
app.post('/api/sessions/:siteId/done/:sessionId', async (req: Request, res: Response) => {
  try {
    const { siteId, sessionId } = req.params;
    const session = loginSessionManager.getSession(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Capture session state (cookies, localStorage, etc.)
    const captured = await loginSessionManager.captureSession(sessionId);
    if (!captured) {
      return res.status(400).json({ error: 'Failed to capture session' });
    }

    // Save session
    const storageStateWithMetadata: StorageState = {
      ...captured.storageState,
      metadata: {},
    };

    await sessionManager.saveSession(siteId, storageStateWithMetadata);
    await loginSessionManager.closeSession(sessionId);

    return res.json({
      success: true,
      siteId,
      sessionId,
      cookieCount: captured.cookies.length,
      message: 'Session captured and saved successfully. Cookies are also persisted in browser profile.',
    });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

/**
 * POST /api/sessions/:siteId/cancel/:sessionId - Cancel login session
 */
app.post('/api/sessions/:siteId/cancel/:sessionId', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const session = loginSessionManager.getSession(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    loginSessionManager.updateStatus(sessionId, 'cancelled');
    await loginSessionManager.closeSession(sessionId);

    return res.json({
      success: true,
      sessionId,
      message: 'Login session cancelled',
    });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

/**
 * Helper function to find the login page in a session
 */
function findLoginPage(session: { context: any; loginUrl?: string; loginPage?: any }): any | null {
  // First, try to use the stored loginPage reference
  if (session.loginPage) {
    try {
      // Check if the page is still valid (not closed)
      if (!session.loginPage.isClosed()) {
        return session.loginPage;
      }
    } catch {
      // Page might be closed, continue to find it
    }
  }

  const pages = session.context.pages();
  if (pages.length === 0) {
    return null;
  }

  if (!session.loginUrl) {
    // If no loginUrl, return first page
    return pages[0];
  }

  try {
    const loginUrl = new URL(session.loginUrl);
    const loginHostname = loginUrl.hostname;
    const loginPathname = loginUrl.pathname;
    
    // Find page that matches the login URL (check hostname and pathname)
    for (const page of pages) {
      try {
        if (page.isClosed()) continue;
        
        const pageUrl = page.url();
        if (pageUrl && pageUrl !== 'about:blank') {
          const pageUrlObj = new URL(pageUrl);
          // Match if hostname and pathname are similar (allows for query params differences)
          if (pageUrlObj.hostname === loginHostname && 
              pageUrlObj.pathname === loginPathname) {
            return page;
          }
        }
      } catch {
        // Skip pages with invalid URLs
        continue;
      }
    }

    // If no exact match, try to find page with same hostname (in case pathname changed)
    for (const page of pages) {
      try {
        if (page.isClosed()) continue;
        
        const pageUrl = page.url();
        if (pageUrl && pageUrl !== 'about:blank') {
          const pageUrlObj = new URL(pageUrl);
          if (pageUrlObj.hostname === loginHostname) {
            return page;
          }
        }
      } catch {
        continue;
      }
    }
  } catch {
    // If loginUrl is invalid, fall back to first page
  }

  // Fallback: return first non-closed page
  for (const page of pages) {
    try {
      if (!page.isClosed()) {
        return page;
      }
    } catch {
      continue;
    }
  }

  return null;
}

// Cache for tracking last URL check time per session (to avoid checking on every screenshot)
const sessionUrlCheckCache = new Map<string, number>();

/**
 * GET /api/sessions/:sessionId/screenshot - Get browser screenshot
 */
app.get('/api/sessions/:sessionId/screenshot', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const session = loginSessionManager.getSession(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const page = findLoginPage(session);
    if (!page) {
      return res.status(404).json({ error: 'Login page not found in session' });
    }

    // Re-fetch session to get latest page reference (important after reload)
    const currentSession = loginSessionManager.getSession(sessionId);
    if (!currentSession) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    // Get the latest page reference (in case it was updated after reload)
    const currentPage = findLoginPage(currentSession);
    if (!currentPage) {
      return res.status(404).json({ error: 'Login page not found in session' });
    }
    
    // Only do expensive checks occasionally (every 5 seconds), not on every screenshot
    const now = Date.now();
    const lastCheck = sessionUrlCheckCache.get(sessionId) || 0;
    const shouldDoFullCheck = now - lastCheck > 5000; // Check every 5 seconds (less frequent)

    if (shouldDoFullCheck) {
      sessionUrlCheckCache.set(sessionId, now);
      
      // Bring page to front (only occasionally) - but don't navigate
      try {
        await currentPage.bringToFront();
      } catch {
        // Ignore if bringToFront fails
      }

      // DON'T navigate or reload - just verify URL without changing it
      // Navigation should only happen via user actions, not automatically
    }

    // Wait for stable rendering - multiple strategies for accuracy
    await Promise.all([
      // Wait for layout stability
      currentPage.evaluate(() => {
        return new Promise<void>(resolve => {
          // Wait for multiple animation frames to ensure all rendering is complete
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                resolve();
              });
            });
          });
        });
      }).catch(() => {}),
      
      // Wait for fonts to load if possible
      currentPage.evaluate(() => {
        return document.fonts ? document.fonts.ready.then(() => undefined) : Promise.resolve();
      }).catch(() => {}),
      
      // Small delay to ensure all paints are complete
      new Promise(resolve => setTimeout(resolve, 16)), // ~1 frame at 60fps
    ]);

    // Ensure page is in a stable state before screenshot
    await currentPage.waitForLoadState('networkidle', { timeout: 500 }).catch(() => {
      // Ignore if networkidle timeout - page might still be loading assets
    });

    const screenshot = await currentPage.screenshot({
      type: 'png',
      fullPage: false, // Just viewport
      timeout: 2000,
    });
    
    // Verify screenshot is valid
    if (screenshot.length < 1000) {
      console.warn('Screenshot seems too small:', screenshot.length, 'bytes');
    }

    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(screenshot);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get screenshot',
    });
  }
});

/**
 * GET /api/sessions/:sessionId/screenshot-stream - Server-Sent Events stream for screenshots
 */
app.get('/api/sessions/:sessionId/screenshot-stream', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const session = loginSessionManager.getSession(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const page = findLoginPage(session);
    if (!page) {
      return res.status(404).json({ error: 'Login page not found in session' });
    }

    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

    let isActive = true;
    const interval = 250; // Update every 250ms

    // Send screenshots in a loop
    const sendScreenshot = async () => {
      if (!isActive) return;

      try {
        // Re-fetch session and page on each iteration to get the latest references
        // This ensures we use the new tab after reload
        const currentSession = loginSessionManager.getSession(sessionId);
        if (!currentSession) {
          res.write(`event: error\ndata: Session not found\n\n`);
          isActive = false;
          res.end();
          return;
        }
        
        const currentPage = findLoginPage(currentSession);
        if (!currentPage) {
          res.write(`event: error\ndata: Login page not found\n\n`);
          isActive = false;
          res.end();
          return;
        }
        
        // Wait for stable rendering - multiple strategies for accuracy
        await Promise.all([
          // Wait for layout stability
          currentPage.evaluate(() => {
            return new Promise<void>(resolve => {
              // Wait for multiple animation frames to ensure all rendering is complete
              requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                  requestAnimationFrame(() => {
                    resolve();
                  });
                });
              });
            });
          }).catch(() => {}),
          
          // Wait for fonts to load if possible
          currentPage.evaluate(() => {
            return document.fonts ? document.fonts.ready : Promise.resolve();
          }).catch(() => {}),
          
          // Small delay to ensure all paints are complete
          new Promise(resolve => setTimeout(resolve, 16)), // ~1 frame at 60fps
        ]);

        const screenshot = await currentPage.screenshot({
          type: 'png',
          fullPage: false,
          timeout: 2000,
        });

        // Convert to base64
        const base64 = screenshot.toString('base64');
        
        // Send as SSE event
        res.write(`data: ${base64}\n\n`);
      } catch (error) {
        if (isActive) {
          res.write(`event: error\ndata: ${error instanceof Error ? error.message : 'Screenshot failed'}\n\n`);
        }
      }

      if (isActive) {
        setTimeout(sendScreenshot, interval);
      }
    };

    // Start sending screenshots
    sendScreenshot();

    // Clean up on client disconnect
    req.on('close', () => {
      isActive = false;
      res.end();
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to start screenshot stream',
    });
  }
});

/**
 * GET /api/sessions/:sessionId/page-info - Get page scroll info
 */
app.get('/api/sessions/:sessionId/page-info', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const session = loginSessionManager.getSession(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const page = findLoginPage(session);
    if (!page) {
      return res.status(404).json({ error: 'Login page not found in session' });
    }
    const info = await page.evaluate(() => ({
      scrollHeight: document.documentElement.scrollHeight,
      scrollTop: window.scrollY,
      clientHeight: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      scrollLeft: window.scrollX,
      clientWidth: window.innerWidth,
      url: window.location.href,
      title: document.title,
    }));

    res.json(info);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get page info',
    });
  }
});

/**
 * POST /api/sessions/:sessionId/click - Click at coordinates
 * Optimized for low latency - fires clicks immediately without waiting
 */
app.post('/api/sessions/:sessionId/click', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const { x, y, selector } = req.body;
    const session = loginSessionManager.getSession(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Try to use cached page reference first for faster lookups
    let page = session.loginPage;
    if (!page || page.isClosed()) {
      page = findLoginPage(session);
      if (!page) {
        return res.status(404).json({ error: 'Login page not found in session' });
      }
    }

    // Fire click immediately without waiting - return response immediately
    if (selector) {
      // Click by selector - fire without waiting
      page.click(selector, { timeout: 5000 }).catch((err: unknown) => {
        // Log but don't block - user sees immediate response
        console.warn('Click error (non-blocking):', err);
      });
      // Return immediately - don't wait for click to complete
      res.json({ success: true });
      return;
    } else if (x !== undefined && y !== undefined) {
      // Click at coordinates - optimized for speed
      const viewportSize = page.viewportSize();
      if (viewportSize) {
        const clampedX = Math.max(0, Math.min(x, viewportSize.width - 1));
        const clampedY = Math.max(0, Math.min(y, viewportSize.height - 1));
        
        // Fire click immediately without waiting
        page.mouse.click(clampedX, clampedY).catch((err: unknown) => {
          console.warn('Click error (non-blocking):', err);
        });
        
        // Return success immediately
        res.json({ success: true });
        return;
      } else {
        // No viewport size - still fire click immediately
        page.mouse.click(x, y).catch((err: unknown) => {
          console.warn('Click error (non-blocking):', err);
        });
        res.json({ success: true });
        return;
      }
    } else {
      return res.status(400).json({ error: 'Either x,y coordinates or selector required' });
    }
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to click',
    });
  }
});

/**
 * POST /api/sessions/:sessionId/type - Type text
 * Optimized for low latency - fires typing immediately
 */
app.post('/api/sessions/:sessionId/type', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const { text, selector } = req.body;
    const session = loginSessionManager.getSession(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (!text) {
      return res.status(400).json({ error: 'Text is required' });
    }

    // Try to use cached page reference first
    let page = session.loginPage;
    if (!page || page.isClosed()) {
      page = findLoginPage(session);
      if (!page) {
        return res.status(404).json({ error: 'Login page not found in session' });
      }
    }

    // Fire typing immediately without waiting
    if (selector) {
      // Type into specific element - fire without waiting
      page.fill(selector, text, { timeout: 5000 }).catch((err: unknown) => {
        console.warn('Type error (non-blocking):', err);
      });
    } else {
      // Type at current focus - fire without waiting
      page.keyboard.type(text, { delay: 0 }).catch((err: unknown) => {
        console.warn('Type error (non-blocking):', err);
      });
    }

    // Return immediately - don't wait for typing to complete
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to type',
    });
  }
});

/**
 * POST /api/sessions/:sessionId/key - Send keyboard key
 * Optimized for low latency - fires key press immediately
 */
app.post('/api/sessions/:sessionId/key', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const { key } = req.body;
    const session = loginSessionManager.getSession(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (!key) {
      return res.status(400).json({ error: 'Key is required' });
    }

    // Try to use cached page reference first
    let page = session.loginPage;
    if (!page || page.isClosed()) {
      page = findLoginPage(session);
      if (!page) {
        return res.status(404).json({ error: 'Login page not found in session' });
      }
    }

    // Fire key press immediately without waiting
    page.keyboard.press(key).catch((err: unknown) => {
      console.warn('Key press error (non-blocking):', err);
    });

    // Return immediately
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to send key',
    });
  }
});

/**
 * POST /api/sessions/:sessionId/scroll - Scroll page
 * Optimized for low latency - fires scroll immediately
 */
app.post('/api/sessions/:sessionId/scroll', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const { x, y, deltaX, deltaY } = req.body;
    const session = loginSessionManager.getSession(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Try to use cached page reference first
    let page = session.loginPage;
    if (!page || page.isClosed()) {
      page = findLoginPage(session);
      if (!page) {
        return res.status(404).json({ error: 'Login page not found in session' });
      }
    }

    // Fire scroll immediately without waiting
    if (deltaX !== undefined || deltaY !== undefined) {
      // Scroll by delta (wheel event) - fire without waiting
      page.mouse.wheel(deltaX || 0, deltaY || 0).catch((err: unknown) => {
        console.warn('Scroll error (non-blocking):', err);
      });
    } else if (x !== undefined && y !== undefined) {
      // Scroll to position - fire without waiting
      page.evaluate(({ scrollX, scrollY }: { scrollX: number; scrollY: number }) => {
        window.scrollTo(scrollX, scrollY);
      }, { scrollX: x, scrollY: y }).catch((err: unknown) => {
        console.warn('Scroll error (non-blocking):', err);
      });
    } else {
      return res.status(400).json({ error: 'Either x,y, deltaX, or deltaY required' });
    }

    // Return immediately
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to scroll',
    });
  }
});

/**
 * POST /api/sessions/:sessionId/navigate - Navigate browser (back, forward, reload)
 */
app.post('/api/sessions/:sessionId/navigate', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const { action } = req.body; // 'back', 'forward', 'reload', or 'goto' with url
    const session = loginSessionManager.getSession(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const page = findLoginPage(session);
    if (!page) {
      return res.status(404).json({ error: 'Login page not found in session' });
    }

    if (action === 'back') {
      await page.goBack();
    } else if (action === 'forward') {
      await page.goForward();
    } else if (action === 'reload') {
      // Get current URL before closing
      const currentUrl = page.url();
      
      // Get the browser context
      const context = session.context;
      
      // Open URL in a new tab
      const newPage = await context.newPage();
      await newPage.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      
      // Wait for page to be fully loaded
      await newPage.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      
      // Bring new page to front
      await newPage.bringToFront();
      
      // IMPORTANT: Update session BEFORE closing old page to avoid race condition
      // Update session to use the new page (update the stored session in LoginSessionManager)
      session.loginPage = newPage;
      // Also update loginUrl to match current URL
      session.loginUrl = currentUrl;
      
      // Small delay to ensure session update is processed
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Close the old tab
      try {
        if (!page.isClosed()) {
          await page.close();
        }
      } catch {
        // Ignore if already closed or closing fails
      }
    } else if (action === 'goto' && req.body.url) {
      await page.goto(req.body.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } else {
      return res.status(400).json({ error: 'Invalid action. Use: back, forward, reload, or goto with url' });
    }

    return res.json({ success: true });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to navigate',
    });
  }
});

/**
 * GET /api/sessions/:sessionId/element - Get element info at coordinates
 */
app.get('/api/sessions/:sessionId/element', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const { x, y } = req.query;
    const session = loginSessionManager.getSession(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (x === undefined || y === undefined) {
      return res.status(400).json({ error: 'x and y coordinates required' });
    }

    const page = findLoginPage(session);
    if (!page) {
      return res.status(404).json({ error: 'Login page not found in session' });
    }

    // Get element at coordinates - ensure accurate positioning
    const coordX = Number(x);
    const coordY = Number(y);
    
    // Bring page to front to ensure accurate element detection
    try {
      await page.bringToFront();
    } catch {
      // Ignore if bringToFront fails
    }
    
    // Wait a moment for layout to stabilize
    await page.evaluate(() => {
      return new Promise<void>(resolve => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      });
    }).catch(() => {});
    
    const elementInfo = await page.evaluate(({ x: coordX, y: coordY }: { x: number; y: number }) => {
      // Use the most accurate method to get element at point
      const element = document.elementFromPoint(coordX, coordY);
      if (!element) return null;

      // Get bounding rect with more precision
      const rect = element.getBoundingClientRect();
      
      // Account for any scroll position if needed (getBoundingClientRect already does this relative to viewport)
      // But ensure we're getting the exact viewport coordinates
      return {
        tag: element.tagName.toLowerCase(),
        type: (element as HTMLInputElement).type || undefined,
        placeholder: (element as HTMLInputElement).placeholder || undefined,
        value: (element as HTMLInputElement).value || undefined,
        text: element.textContent?.slice(0, 50) || undefined,
        id: element.id || undefined,
        className: element.className || undefined,
        rect: {
          x: Math.round(rect.x * 100) / 100, // Round to 2 decimal places for precision
          y: Math.round(rect.y * 100) / 100,
          width: Math.round(rect.width * 100) / 100,
          height: Math.round(rect.height * 100) / 100,
        },
      };
    }, { x: coordX, y: coordY });

    return res.json({ element: elementInfo });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get element info',
    });
  }
});

/**
 * GET /api/sessions/:siteId/check - Check if website has saved session
 */
app.get('/api/sessions/:siteId/check', async (req: Request, res: Response) => {
  try {
    const { siteId } = req.params;
    const session = await sessionManager.loadSession(siteId);
    return res.json({ hasSession: !!session, siteId });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

/**
 * DELETE /api/sessions/:siteId - Delete saved session
 */
app.delete('/api/sessions/:siteId', async (req: Request, res: Response) => {
  try {
    const { siteId } = req.params;
    const deleted = await sessionManager.deleteSession(siteId);

    if (!deleted) {
      return res.status(404).json({ error: 'Session not found' });
    }

    return res.json({
      success: true,
      siteId,
      message: 'Session deleted successfully',
    });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

/**
 * GET /api/websites/:websiteId - Get website details (with session status)
 */
app.get('/api/websites/:websiteId', async (req: Request, res: Response) => {
  try {
    const { websiteId } = req.params;
    const website = websiteManager.getWebsite(websiteId);

    if (!website) {
      return res.status(404).json({ error: 'Website not found' });
    }

    const siteId = website.domain || websiteId;
    const hasSession = !!(await sessionManager.loadSession(siteId));

    return res.json({
      ...website,
      hasSession,
    });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

/**
 * Health check endpoint
 */
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

/**
 * GET /metrics - Prometheus metrics endpoint
 */
app.get('/metrics', async (_req: Request, res: Response) => {
  try {
    const { MetricsExporter } = await import('../core/MetricsExporter.js');
    const exporter = new MetricsExporter();
    
    // Update from performance monitor if available
    if (pipeline && (pipeline as any).performanceMonitor) {
      exporter.updateFromMonitor((pipeline as any).performanceMonitor);
    }
    
    const metrics = await exporter.getMetrics();
    res.set('Content-Type', 'text/plain');
    res.send(metrics);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to export metrics',
    });
  }
});

/**
 * GET /api/metrics/json - JSON metrics endpoint
 */
app.get('/api/metrics/json', (_req: Request, res: Response) => {
  try {
    if (pipeline && (pipeline as any).performanceMonitor) {
      const monitor = (pipeline as any).performanceMonitor;
      const metrics = monitor.exportJSON();
      res.json(metrics);
    } else {
      res.json({ error: 'Performance monitor not available' });
    }
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to export metrics',
    });
  }
});

/**
 * POST /api/webhooks - Register webhook
 */
app.post('/api/webhooks', (req: Request, res: Response): void => {
  try {
    const { url, events, secret, enabled } = req.body;
    
    if (!url || !events || !Array.isArray(events)) {
      res.status(400).json({ error: 'url and events array are required' });
      return;
    }

    const webhook = webhookManager.register({
      url,
      events,
      secret,
      enabled: enabled !== false,
    });

    res.json({ webhook });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to create webhook',
    });
  }
});

/**
 * GET /api/webhooks - List webhooks
 */
app.get('/api/webhooks', (_req: Request, res: Response) => {
  try {
    const webhooks = webhookManager.list();
    res.json({ webhooks });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to fetch webhooks',
    });
  }
});

/**
 * DELETE /api/webhooks/:id - Delete webhook
 */
app.delete('/api/webhooks/:id', (req: Request, res: Response): void => {
  try {
    const { id } = req.params;
    const deleted = webhookManager.delete(id);
    
    if (!deleted) {
      res.status(404).json({ error: 'Webhook not found' });
      return;
    }
    
    res.json({ success: true, id });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to delete webhook',
    });
  }
});

/**
 * POST /api/scheduled-tasks - Create scheduled task
 */
app.post('/api/scheduled-tasks', (req: Request, res: Response): void => {
  try {
    const { taskId, targetUrl, schedule, enabled, parameters } = req.body;
    
    if (!taskId || !targetUrl || !schedule) {
      res.status(400).json({ error: 'taskId, targetUrl, and schedule are required' });
      return;
    }

    // Validate cron expression format (basic check)
    const cronParts = schedule.trim().split(/\s+/);
    if (cronParts.length !== 5) {
      res.status(400).json({ 
        error: 'Invalid cron expression. Format: minute hour day month weekday (5 parts separated by spaces)',
        example: '0 9 * * * (daily at 9 AM)'
      });
      return;
    }

    // Get task name for display
    let taskName: string | undefined;
    try {
      const taskData = websiteManager.getTask(taskId);
      taskName = taskData?.task.name;
    } catch {
      // Task might not exist yet, that's okay
    }
    
    const scheduledTask = scheduledTaskManager.create({
      taskId,
      taskName,
      targetUrl,
      schedule,
      enabled: enabled !== false,
      parameters,
    });

    res.json(scheduledTask);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to create scheduled task',
    });
  }
});

/**
 * GET /api/scheduled-tasks - List scheduled tasks
 */
app.get('/api/scheduled-tasks', (_req: Request, res: Response): void => {
  try {
    const tasks = scheduledTaskManager.list();
    res.json(tasks);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to fetch scheduled tasks',
    });
  }
});

/**
 * PATCH /api/scheduled-tasks/:id - Update scheduled task
 */
app.patch('/api/scheduled-tasks/:id', (req: Request, res: Response): void => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    const updated = scheduledTaskManager.update(id, updates);
    if (!updated) {
      res.status(404).json({ error: 'Scheduled task not found' });
      return;
    }
    
    // Note: The scheduler will pick up the change on its next sync (every minute)
    // For immediate updates, you could trigger a scheduler sync here
    
    res.json(updated);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to update scheduled task',
    });
  }
});

/**
 * POST /api/scheduled-tasks/:id/trigger - Manually trigger a scheduled task
 */
app.post('/api/scheduled-tasks/:id/trigger', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    
    // Import scheduler (it's initialized in index.ts)
    // For now, we'll execute directly using the same logic
    const task = scheduledTaskManager.get(id);
    if (!task) {
      res.status(404).json({ error: 'Scheduled task not found' });
      return;
    }

    if (!task.enabled) {
      res.status(400).json({ error: 'Scheduled task is disabled' });
      return;
    }

    // Execute the task (same logic as scheduler)
    const taskData = websiteManager.getTask(task.taskId);
    if (!taskData) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    const { TaskExecutor } = await import('../core/TaskExecutor.js');
    const { launchBrowser } = await import('../utils/BrowserConfig.js');
    
    const { task: taskObj } = taskData;
    const website = websiteManager.getWebsite(taskObj.websiteId);
    const siteId = website?.domain || taskObj.websiteId;
    const savedSession = await sessionManager.loadSession(siteId);

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
    const launcherUrl = websiteManager.getLauncherUrl();
    
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
    const taskExecutor = new TaskExecutor(knowledgeBase, jobManager, pipeline, websiteManager);
    
    const taskForExecution = {
      id: taskObj.id,
      websiteId: taskObj.websiteId,
      name: taskObj.name,
      description: taskObj.description,
      recordings: taskObj.recordings,
      createdAt: taskObj.createdAt,
      updatedAt: taskObj.updatedAt,
      successRate: taskObj.successRate,
      totalExecutions: taskObj.totalExecutions,
    };

    const result = await taskExecutor.executeTask(
      taskForExecution as any,
      task.targetUrl,
      page,
      (task.parameters || {}) as Record<string, string>
    );

    if (result.success && persistentContext) {
      try {
        const storageState = await persistentContext.storageState();
        await sessionManager.saveSession(siteId, storageState);
      } catch (error) {
        console.warn(`Failed to save session:`, error);
      }
    }

    await persistentContext.close();

    // Update last run
    scheduledTaskManager.update(id, { lastRun: Date.now() });

    res.json({ 
      success: true, 
      result,
      message: 'Task executed successfully'
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to trigger scheduled task',
    });
  }
});

/**
 * DELETE /api/scheduled-tasks/:id - Delete scheduled task
 */
app.delete('/api/scheduled-tasks/:id', (req: Request, res: Response): void => {
  try {
    const { id } = req.params;
    const deleted = scheduledTaskManager.delete(id);
    
    if (!deleted) {
      res.status(404).json({ error: 'Scheduled task not found' });
      return;
    }
    
    res.json({ success: true, id });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to delete scheduled task',
    });
  }
});

/**
 * POST /api/test-cases - Create test case
 */
app.post('/api/test-cases', (req: Request, res: Response): void => {
  try {
    const { name, taskId, targetUrl, expectedResult, parameters } = req.body;
    
    if (!name || !taskId || !targetUrl) {
      res.status(400).json({ error: 'name, taskId, and targetUrl are required' });
      return;
    }

    // Get task name for display
    let taskName: string | undefined;
    try {
      const taskData = websiteManager.getTask(taskId);
      taskName = taskData?.task.name;
    } catch {
      // Task might not exist yet, that's okay
    }

    const testCase = testCaseManager.create({
      name,
      taskId,
      taskName,
      targetUrl,
      expectedResult,
      parameters,
    });

    res.json(testCase);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to create test case',
    });
  }
});

/**
 * GET /api/test-cases - List test cases
 */
app.get('/api/test-cases', (_req: Request, res: Response): void => {
  try {
    const testCases = testCaseManager.list();
    res.json(testCases);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to fetch test cases',
    });
  }
});

/**
 * DELETE /api/test-cases/:id - Delete test case
 */
app.delete('/api/test-cases/:id', (req: Request, res: Response): void => {
  try {
    const { id } = req.params;
    const deleted = testCaseManager.delete(id);
    
    if (!deleted) {
      res.status(404).json({ error: 'Test case not found' });
      return;
    }
    
    res.json({ success: true, id });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to delete test case',
    });
  }
});

/**
 * GET /api/test-runs - List test runs
 */
app.get('/api/test-runs', (req: Request, res: Response): void => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const testRuns = testCaseManager.getTestRuns(limit);
    res.json(testRuns);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to fetch test runs',
    });
  }
});

/**
 * POST /api/test-cases/run - Run test case
 */
app.post('/api/test-cases/run', async (req: Request, res: Response): Promise<void> => {
  try {
    const { testCaseId } = req.body;
    
    if (!testCaseId) {
      res.status(400).json({ error: 'testCaseId is required' });
      return;
    }

    const testCase = testCaseManager.get(testCaseId);
    if (!testCase) {
      res.status(404).json({ error: 'Test case not found' });
      return;
    }

    // Create test run
    const testRun = testCaseManager.createTestRun(testCaseId, 'running');
    
    // Execute the task asynchronously
    (async () => {
      try {
        // Use the same execution method as the task execute endpoint
        const { TaskExecutor } = await import('../core/TaskExecutor.js');
        const { launchBrowser } = await import('../utils/BrowserConfig.js');
        
        const taskData = websiteManager.getTask(testCase.taskId);
        if (!taskData) {
          throw new Error('Task not found');
        }

        const { task } = taskData;
        const website = websiteManager.getWebsite(task.websiteId);
        const siteId = website?.domain || task.websiteId;
        const savedSession = await sessionManager.loadSession(siteId);

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
        const launcherUrl = websiteManager.getLauncherUrl();
        
        const browserResult = await launchBrowser({
          headless,
          userDataDir,
          proxy: proxyConfig,
          storageState: savedSession as any, // StorageState is compatible with Playwright's storageState
          launcherUrl: launcherUrl, // Pass launcher page URL to open as one of the tabs
          // Don't pass automationUrl - we'll click link from launcher page instead
        });

        // Handle return type: can be BrowserContext or LaunchBrowserResult
        const persistentContext = 'context' in browserResult ? browserResult.context : browserResult;
        const page = 'automationPage' in browserResult && browserResult.automationPage 
          ? browserResult.automationPage 
          : await persistentContext.newPage();
        const taskExecutor = new TaskExecutor(knowledgeBase, jobManager, pipeline, websiteManager);
        
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

        const result = await taskExecutor.executeTask(
          taskForExecution as any,
          testCase.targetUrl,
          page,
          (testCase.parameters || {}) as Record<string, string>
        );

        await persistentContext.close();

        // Update test run with result
        const success = result.success;
        testCaseManager.updateTestRun(testRun.id, {
          status: success ? 'passed' : 'failed',
          result,
          completedAt: Date.now(),
        });

        // Update test case with last run info
        testCaseManager.update(testCaseId, {
          lastRun: Date.now(),
          lastResult: success ? 'pass' : 'fail',
        });
      } catch (error) {
        testCaseManager.updateTestRun(testRun.id, {
          status: 'failed',
          result: { error: error instanceof Error ? error.message : String(error) },
          completedAt: Date.now(),
        });

        testCaseManager.update(testCaseId, {
          lastRun: Date.now(),
          lastResult: 'fail',
        });
      }
    })();

    res.json({ runId: testRun.id, status: 'running' });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to run test case',
    });
  }
});

export default app;

