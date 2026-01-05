import type { Page, BrowserContext } from 'playwright';
import type { Task, TaskRecording } from '../types/index.js';
import type { KnowledgeBase } from './KnowledgeBase.js';
import { PageAnalyzer } from './PageAnalyzer.js';
import { AutomationPipeline } from './Pipeline.js';
import type { JobManager } from './JobManager.js';
import { SiteConfigManager } from '../config/SiteConfig.js';
import type { WebsiteManager } from './WebsiteManager.js';

/**
 * Task Execution Result
 */
export interface TaskExecutionResult {
  taskId: string;
  success: boolean;
  steps: TaskExecutionStep[];
  finalUrl?: string;
  error?: string;
  knowledgeGaps: KnowledgeGap[];
  scrapedData?: Record<string, string | number | boolean | object | Array<string | number | boolean | object>>;
}

/**
 * Task Execution Step
 */
export interface TaskExecutionStep {
  step: string;
  action: string;
  success: boolean;
  knowledgeUsed: boolean;
  knowledgeDetails?: string; // Details about what knowledge was used
  error?: string;
}

/**
 * Knowledge Gap: Something not in knowledge base
 */
export interface KnowledgeGap {
  situation: string;
  missingKnowledge: string;
  suggestion?: string;
}

/**
 * Task Executor: Intelligently executes tasks using knowledge base
 * 
 * Ensures:
 * - Only uses actions from knowledge base
 * - Handles login/navigation automatically
 * - Verifies page state
 * - Reports knowledge gaps clearly
 */
export class TaskExecutor {
  private pageAnalyzer: PageAnalyzer;
  private knowledgeBase: KnowledgeBase;
  private websiteManager?: any; // WebsiteManager instance to access cross-task knowledge
  private siteConfigManager: SiteConfigManager;

  constructor(
    knowledgeBase: KnowledgeBase,
    _jobManager: JobManager,
    _pipeline: AutomationPipeline,
    websiteManager?: any
  ) {
    this.knowledgeBase = knowledgeBase;
    this.pageAnalyzer = new PageAnalyzer();
    this.websiteManager = websiteManager;
    this.siteConfigManager = SiteConfigManager.getInstance();
  }

  /**
   * Wait for custom selectors if configured for the site
   * @param page - Playwright page
   * @param url - Current URL
   * @returns Promise that resolves when custom wait is complete
   */
  private async waitForCustomSelectors(page: Page, url: string): Promise<void> {
    const siteConfig = this.siteConfigManager.getSiteConfig(url);
    if (!siteConfig?.customWaitSelectors) {
      return;
    }

    console.log(`Waiting for custom selectors to load for ${url}...`);
    try {
      // Wait for ANY of the primary selectors to appear
      // Playwright's waitForSelector doesn't support comma-separated selectors,
      // so we need to wait for each one individually and succeed when ANY appears
      const timeout = siteConfig.customWaitTimeout || 45000;
      
      // Create promises for each selector
      const selectorPromises = siteConfig.customWaitSelectors.map(selector =>
        page.waitForSelector(selector, { timeout, state: 'visible' })
      );
      
      // Wait for ANY selector to appear (using Promise.race)
      await Promise.race(selectorPromises).catch(async () => {
        // If all primary selectors fail, try fallback selectors
        if (siteConfig.customWaitFallbackSelectors) {
          const fallbackTimeout = siteConfig.customWaitFallbackTimeout || 30000;
          const fallbackPromises = siteConfig.customWaitFallbackSelectors.map(selector =>
            page.waitForSelector(selector, { timeout: fallbackTimeout, state: 'visible' })
          );
          await Promise.race(fallbackPromises);
        } else {
          throw new Error('None of the custom wait selectors appeared');
        }
      });

      console.log('✓ Custom selectors loaded');
      
      // Additional wait if configured
      if (siteConfig.additionalWaitAfterLoad) {
        await page.waitForTimeout(siteConfig.additionalWaitAfterLoad);
      }
    } catch (error) {
      console.warn('Custom selectors not fully loaded, but continuing...', error);
      // Fallback wait if configured
      if (siteConfig.fallbackWait) {
        await page.waitForTimeout(siteConfig.fallbackWait);
      }
    }
  }

  /**
   * Navigate to target URL using launcher page (more natural browsing pattern)
   * First tries to find existing launcher page, if not found, navigates to it
   */
  private async navigateViaLauncher(
    page: Page,
    targetUrl: string,
    websiteId: string
  ): Promise<Page> {
    // Get launcher URL from website manager
    if (!this.websiteManager) {
      throw new Error('WebsiteManager not available for launcher navigation');
    }

    const launcherUrl = this.websiteManager.getLauncherUrl();
    if (!launcherUrl) {
      throw new Error('Launcher page not available');
    }

    const context = page.context();
    
    // Try to find existing launcher page in open tabs
    let launcherPage: Page | null = null;
    const allPages = context.pages();
    
    for (const openPage of allPages) {
      try {
        const pageUrl = openPage.url();
        // Check if this page is the launcher page
        if (pageUrl.includes('launcher.html') || pageUrl === launcherUrl || pageUrl.includes('launcher')) {
          launcherPage = openPage;
          console.log(`✓ Found existing launcher page tab`);
          break;
        }
      } catch {
        // Page might be closed, skip it
        continue;
      }
    }

    // If launcher page not found, navigate current page to launcher
    if (!launcherPage) {
      console.log(`Launcher page not found in open tabs, navigating to: ${launcherUrl}`);
      await page.goto(launcherUrl, { waitUntil: 'load', timeout: 60000 });
      launcherPage = page;
    }
    
    // Wait a bit for launcher page to fully load
    await launcherPage.waitForTimeout(2000);

    // Find and click the website link on launcher page
    const linkSelector = `a[data-website-id="${websiteId}"], a[data-domain*="${this.extractDomain(targetUrl)}"]`;
    console.log(`Clicking website link on launcher page: ${linkSelector}`);
    
    // Wait for link to be visible on launcher page
    await launcherPage.waitForSelector(linkSelector, { timeout: 20000, state: 'visible' });
    
    // Click the link (will open in new tab via target="_blank")
    const [newPage] = await Promise.all([
      context.waitForEvent('page', { timeout: 30000 }),
      launcherPage.click(linkSelector, { timeout: 20000 })
    ]);

    if (!newPage) {
      throw new Error('Failed to open new tab from launcher page');
    }

    console.log(`✓ New tab opened, waiting for navigation...`);
    
    // Wait for the new page to navigate to target URL (extended timeout for slow-loading sites)
    await newPage.waitForLoadState('domcontentloaded', { timeout: 120000 });
    
    // Wait 10 seconds after navigation for page to fully initialize (especially for SPAs and heavy sites)
    await newPage.waitForTimeout(10000);
    
    // Verify we're on the correct page
    const newPageUrl = newPage.url();
    if (!newPageUrl.includes(this.extractDomain(targetUrl))) {
      console.warn(`Warning: New page URL (${newPageUrl}) doesn't match expected domain`);
    }

    // Keep launcher page open (don't close it - it's part of the natural browsing pattern)
    // The launcher page stays open as a background tab, which is more realistic

    return newPage;
  }

  /**
   * Extract domain from URL
   */
  private extractDomain(url: string): string {
    try {
      const urlObj = new URL(url.startsWith('http') ? url : `https://${url}`);
      return urlObj.hostname.replace(/^www\./, '');
    } catch {
      return url.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    }
  }

  /**
   * Execute a task intelligently
   */
  async executeTask(
    task: Task,
    targetUrl: string,
    page: Page,
    parameters?: Record<string, string>,
    skipNavigation?: boolean
  ): Promise<TaskExecutionResult> {
    const steps: TaskExecutionStep[] = [];
    const knowledgeGaps: KnowledgeGap[] = [];
    let currentUrl = page.url();
    let activePage = page; // Track which page we're using

    try {
      // Step 1: Navigate to target URL (skip if requested for sequential tasks)
      if (!skipNavigation) {
        steps.push({
          step: 'navigate',
          action: `Navigate to ${targetUrl}`,
          success: false,
          knowledgeUsed: false,
        });

        // Try to use launcher page for more natural browsing pattern
        let useLauncher = false;
        if (this.websiteManager && task.websiteId) {
          try {
            const launcherUrl = this.websiteManager.getLauncherUrl();
            if (launcherUrl) {
              useLauncher = true;
              console.log('Using launcher page for navigation (more natural browsing pattern)');
              activePage = await this.navigateViaLauncher(page, targetUrl, task.websiteId);
              currentUrl = activePage.url();
              steps[steps.length - 1].success = true;
              steps[steps.length - 1].action = `Navigate to ${targetUrl} via launcher page`;
            }
          } catch (launcherError) {
            console.warn('Launcher page navigation failed, falling back to direct navigation:', launcherError);
            useLauncher = false;
          }
        }

        // If launcher didn't work, use direct navigation
        if (!useLauncher) {
          // Navigate to target URL with fallback strategy based on site configuration
          // High-activity sites never reach 'networkidle' due to continuous background requests
          const isHighActivitySite = this.siteConfigManager.isHighActivitySite(targetUrl);
          const navigationTimeout = this.siteConfigManager.getNavigationTimeout(targetUrl, isHighActivitySite);
          const waitUntil = this.siteConfigManager.getWaitUntil(targetUrl, isHighActivitySite);
          const postLoadWait = this.siteConfigManager.getPostLoadWait(targetUrl);
          const fallbackTimeout = this.siteConfigManager.getFallbackTimeout();
          
          let navigationSuccess = false;
          let navigationError: Error | null = null;
          
          if (isHighActivitySite) {
          // For high-activity sites, use 'load' instead of 'networkidle'
          try {
            await activePage.goto(targetUrl, { waitUntil, timeout: navigationTimeout });
            // Wait a bit more for JavaScript to initialize
            await activePage.waitForTimeout(postLoadWait);
            
            // Wait for custom selectors if configured (e.g., WhatsApp chat interface)
            await this.waitForCustomSelectors(activePage, targetUrl);
            
            navigationSuccess = true;
          } catch (error) {
            navigationError = error instanceof Error ? error : new Error(String(error));
            // Try domcontentloaded as last resort
            try {
              await activePage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: fallbackTimeout });
              await activePage.waitForTimeout(postLoadWait * 1.5); // Slightly longer wait for fallback
              
              // Still try custom selectors even with domcontentloaded
              await this.waitForCustomSelectors(activePage, targetUrl);
              
              navigationSuccess = true;
            } catch (fallbackError) {
              navigationError = fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError));
            }
          }
        } else {
          // For normal sites, try networkidle first, then fallback to load
          try {
            await activePage.goto(targetUrl, { waitUntil: 'networkidle', timeout: navigationTimeout });
            
            // Wait for custom selectors if configured
            await this.waitForCustomSelectors(activePage, targetUrl);
            
            navigationSuccess = true;
          } catch (error) {
            navigationError = error instanceof Error ? error : new Error(String(error));
            console.warn(`networkidle timeout for ${targetUrl}, trying with 'load' instead`);
            try {
              await activePage.goto(targetUrl, { waitUntil: 'load', timeout: fallbackTimeout });
              
              // Wait for custom selectors if configured
              await this.waitForCustomSelectors(activePage, targetUrl);
              
              navigationSuccess = true;
            } catch (loadError) {
              navigationError = loadError instanceof Error ? loadError : new Error(String(loadError));
              // Last resort: domcontentloaded
              console.warn(`load timeout for ${targetUrl}, trying with 'domcontentloaded'`);
              await activePage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: fallbackTimeout });
              await activePage.waitForTimeout(postLoadWait); // Give page time to render
              
              // Wait for custom selectors if configured
              await this.waitForCustomSelectors(activePage, targetUrl);
              
              navigationSuccess = true;
            }
          }
        }
        
        if (!navigationSuccess && navigationError) {
          throw navigationError;
        }
        
        currentUrl = activePage.url();
        
        // Verify we actually navigated (not stuck on about:blank)
        if (currentUrl === 'about:blank' || currentUrl === '') {
          throw new Error(`Navigation failed - page is still on '${currentUrl}' instead of ${targetUrl}`);
        }
        } // Close if (!useLauncher) block
      } else {
        // When skipping navigation, just update currentUrl and mark navigation step as skipped
        currentUrl = activePage.url();
        steps.push({
          step: 'navigate',
          action: `Skip navigation (already on ${targetUrl})`,
          success: true,
          knowledgeUsed: false,
        });
      }

      // Analyze page after navigation (use activePage)
      let analysis = await this.pageAnalyzer.analyzePage(activePage, {
        url: targetUrl,
      });

      // Step 2: Check if we need login FIRST (before page verification)
      // This is important because login pages won't have the expected selectors
      const needsLoginCheck = await this.needsLogin(analysis, task, activePage);
      if (needsLoginCheck) {
        steps.push({
          step: 'detect-login',
          action: 'Detected login page - will use dedicated login task recordings',
          success: true,
          knowledgeUsed: true,
          knowledgeDetails: 'Detected login requirement and found dedicated login task',
        });

        // Switch to mobile viewport for login (easier reCAPTCHA, simpler UI)
        try {
          const { switchViewport } = await import('../utils/BrowserConfig.js');
          await switchViewport(activePage, 'tablet');
          steps.push({
            step: 'switch-viewport-login',
            action: 'Switched to mobile viewport for login',
            success: true,
            knowledgeUsed: false,
          });
          console.log('✓ Switched to mobile viewport for login');
        } catch (error) {
          console.warn('Failed to switch to mobile viewport for login:', error);
          // Continue even if viewport switch fails
        }

        const loginResult = await this.handleLogin(task, activePage, steps, knowledgeGaps, parameters);
        if (!loginResult.success) {
          return {
            taskId: task.id,
            success: false,
            steps,
            finalUrl: currentUrl,
            error: loginResult.error,
            knowledgeGaps,
          };
        }
        
        // After login, switch from mobile back to desktop viewport
        try {
          const { switchViewport } = await import('../utils/BrowserConfig.js');
          await switchViewport(activePage, 'tablet');
          steps.push({
            step: 'switch-viewport-desktop',
            action: 'Switched from mobile to desktop viewport after login',
            success: true,
            knowledgeUsed: false,
          });
          console.log('✓ Switched back to desktop viewport after login');
        } catch (error) {
          console.warn('Failed to switch viewport after login:', error);
          // Continue even if viewport switch fails
        }
        
        // After login, wait a bit and re-analyze page
        await activePage.waitForTimeout(2000);
        currentUrl = activePage.url();
        
        // Re-analyze page after login
        const postLoginAnalysis = await this.pageAnalyzer.analyzePage(activePage, {
          url: targetUrl,
        });
        analysis = postLoginAnalysis;
      }

      // Step 3: Verify we're on the correct page (skip strict verification if we just logged in)
      const verification = await this.verifyPage(activePage, targetUrl, task, needsLoginCheck);
      if (!verification.isCorrect) {
        // Try to navigate again
        steps.push({
          step: 'recover',
          action: `Page verification failed: ${verification.reason}. Navigating to ${targetUrl}`,
          success: false,
          knowledgeUsed: false,
        });

        await activePage.goto(targetUrl, { waitUntil: 'load', timeout: 30000 });
        currentUrl = activePage.url();

        const reVerification = await this.verifyPage(activePage, targetUrl, task);
        if (!reVerification.isCorrect) {
          knowledgeGaps.push({
            situation: `Cannot reach target URL ${targetUrl}`,
            missingKnowledge: 'Navigation path to target URL',
            suggestion: 'Record a navigation flow to this URL',
          });

          return {
            taskId: task.id,
            success: false,
            steps,
            finalUrl: currentUrl,
            error: `Cannot reach target URL: ${reVerification.reason}`,
            knowledgeGaps,
          };
        }
      }

      steps[steps.length - 1].success = true;

      // Step 3: Execute task actions
      const bestRecording = this.getBestRecording(task);
      if (!bestRecording) {
        knowledgeGaps.push({
          situation: 'No recordings available for task',
          missingKnowledge: 'Task execution steps',
          suggestion: 'Add recordings to this task',
        });

        return {
          taskId: task.id,
          success: false,
          steps,
          finalUrl: currentUrl,
          error: 'No recordings available for task',
          knowledgeGaps,
        };
      }

      // Initialize scraped data storage
      const scrapedData: Record<string, string | number | boolean | object | Array<string | number | boolean | object>> = {};

      const executionResult = await this.executeTaskActions(
        bestRecording,
        activePage,
        steps,
        knowledgeGaps,
        parameters,
        scrapedData
      );

      return {
        taskId: task.id,
        success: executionResult.success,
        steps,
        finalUrl: activePage.url(), // Use activePage (target website) instead of original page (might be launcher)
        error: executionResult.error,
        knowledgeGaps,
        scrapedData: Object.keys(scrapedData).length > 0 ? scrapedData : undefined,
      };
    } catch (error) {
      return {
        taskId: task.id,
        success: false,
        steps,
        finalUrl: currentUrl,
        error: error instanceof Error ? error.message : String(error),
        knowledgeGaps,
      };
    }
  }

  /**
   * Check if login is needed - intelligently detects login pages
   */
  private async needsLogin(_analysis: any, task: Task, page: Page): Promise<boolean> {
    // Check for login page indicators
    const loginIndicators = [
      'login',
      'sign in',
      'log in',
      'email',
      'password',
      'forgot password',
      'create account',
    ];

    // Check page content for login indicators
    const bodyText = await page.textContent('body').catch(() => '') || '';
    const pageText = bodyText.toLowerCase();
    const hasLoginText = loginIndicators.some(indicator => pageText.includes(indicator));

    // Check for login form elements
    const hasEmailField = await page.locator('input[type="email"], input[name*="email"], input[id*="email"], input[placeholder*="email" i]').count() > 0;
    const hasPasswordField = await page.locator('input[type="password"]').count() > 0;
    const hasLoginButton = await page.locator('button:has-text("log in"), button:has-text("sign in"), button:has-text("login"), input[type="submit"][value*="log" i]').count() > 0;

    const isLoginPage = (hasEmailField || hasPasswordField) && (hasLoginButton || hasLoginText);

    if (isLoginPage) {
      // Check if we have login knowledge (in current task or other tasks for same website)
      const hasLoginKnowledge = await this.hasLoginKnowledge(task);
      return hasLoginKnowledge;
    }

    return false;
  }

  /**
   * Find dedicated login task for a website
   * Looks for tasks with names like "login", "sign in", "signin", etc.
   * For a dedicated login task, ALL recordings are considered login recordings
   */
  private findDedicatedLoginTask(website: any): Task | null {
    if (!website || !website.tasks) {
      return null;
    }

    // Login task name patterns (case-insensitive)
    const loginTaskPatterns = [
      /^login$/i,
      /^sign\s*in$/i,
      /^signin$/i,
      /^authenticate$/i,
      /^auth$/i,
    ];

    // Look for a task that matches login patterns
    // For a dedicated login task, we use ALL its recordings (the whole task is for login)
    for (const task of website.tasks) {
      const taskName = task.name.toLowerCase().trim();
      if (loginTaskPatterns.some(pattern => pattern.test(taskName))) {
        // If it's a dedicated login task, return it if it has any recordings
        // We don't need to check for submit-login intent - the whole task is for login
        if (task.recordings && task.recordings.length > 0) {
          console.log(`[Login] Found dedicated login task: "${task.name}" with ${task.recordings.length} recording(s)`);
          return task;
        } else {
          console.log(`[Login] Found login task "${task.name}" but it has no recordings yet`);
        }
      }
    }
    
    console.log(`[Login] No dedicated login task found. Available tasks: ${website.tasks.map((t: any) => t.name).join(', ')}`);

    return null;
  }

  /**
   * Check if we have login knowledge available
   * Prioritizes dedicated login task, then falls back to other tasks
   */
  private async hasLoginKnowledge(task: Task): Promise<boolean> {
    // If WebsiteManager is available, check for dedicated login task first
    if (this.websiteManager) {
      try {
        const taskData = this.websiteManager.getTask(task.id);
        if (taskData) {
          const { website } = taskData;
          
          // First priority: Check for dedicated login task
          // If a dedicated login task exists, we have login knowledge (all its recordings are login)
          const loginTask = this.findDedicatedLoginTask(website);
          if (loginTask) {
            console.log(`[Login] Found dedicated login task: ${loginTask.name}`);
            return true;
          }

          // Second priority: Check current task if it's not the login task
          const currentTaskHasLogin = task.recordings.some((rec: any) => {
            return rec.actions.some((action: any) => action.intent === 'submit-login');
          });

          if (currentTaskHasLogin) {
            return true;
          }

          // Third priority: Check other tasks in the website for login recordings
          for (const otherTask of website.tasks) {
            if (otherTask.id !== task.id) {
              const hasLogin = otherTask.recordings.some((rec: any) => {
                return rec.actions.some((action: any) => action.intent === 'submit-login');
              });
              if (hasLogin) {
                return true;
              }
            }
          }
        }
      } catch (error) {
        console.warn('Failed to check cross-task login knowledge:', error);
      }
    } else {
      // Fallback: Check current task only if WebsiteManager not available
      const currentTaskHasLogin = task.recordings.some((rec: any) => {
        return rec.actions.some((action: any) => action.intent === 'submit-login');
      });
      if (currentTaskHasLogin) {
        return true;
      }
    }

    return false;
  }

  /**
   * Handle login using dedicated login task's recordings
   * Prioritizes dedicated login task, then falls back to other tasks
   */
  private async handleLogin(
    task: Task,
    page: Page,
    steps: TaskExecutionStep[],
    knowledgeGaps: KnowledgeGap[],
    parameters?: Record<string, string>
  ): Promise<{ success: boolean; error?: string; knowledgeDetails?: string }> {
    let loginRecording: any = null;
    let loginTaskName = task.name;
    let knowledgeSource = 'current task';
    let loginTask: Task | null = null;

    // Priority 1: Look for dedicated login task
    if (this.websiteManager) {
      try {
        const taskData = this.websiteManager.getTask(task.id);
        if (taskData) {
          const { website } = taskData;
          
          // First priority: Use dedicated login task
          loginTask = this.findDedicatedLoginTask(website);
          if (loginTask) {
            // Get the best recording from the dedicated login task
            // For dedicated login task, ALL recordings are login recordings
            const bestRecording = this.getBestRecording(loginTask);
            if (bestRecording) {
              loginRecording = bestRecording;
              loginTaskName = loginTask.name;
              knowledgeSource = `dedicated login task "${loginTask.name}"`;
              console.log(`[Login] Using dedicated login task: ${loginTask.name} with ${loginTask.recordings.length} recording(s)`);
            }
          }
        }
      } catch (error) {
        console.warn('Failed to find dedicated login task:', error);
      }
    }

    // Priority 2: If no dedicated login task, check current task
    if (!loginRecording) {
      loginRecording = task.recordings.find((rec: any) =>
        rec.actions.some((action: any) => action.intent === 'submit-login')
      );
      if (loginRecording) {
        loginTaskName = task.name;
        knowledgeSource = 'current task';
      }
    }

    // Priority 3: If still not found, search other tasks in the same website
    if (!loginRecording && this.websiteManager) {
      try {
        const taskData = this.websiteManager.getTask(task.id);
        if (taskData) {
          const { website } = taskData;
          // Search all tasks for login recordings (excluding dedicated login task if already checked)
          for (const otherTask of website.tasks) {
            if (otherTask.id !== task.id && (!loginTask || otherTask.id !== loginTask.id)) {
              const foundRecording = otherTask.recordings.find((rec: any) =>
                rec.actions.some((action: any) => action.intent === 'submit-login')
              );
              if (foundRecording) {
                loginRecording = foundRecording;
                loginTaskName = otherTask.name;
                knowledgeSource = `task "${otherTask.name}"`;
                break;
              }
            }
          }
        }
      } catch (error) {
        console.warn('Failed to search cross-task login knowledge:', error);
      }
    }

    if (!loginRecording) {
      knowledgeGaps.push({
        situation: 'Login required but no login knowledge available',
        missingKnowledge: 'Login flow for this site',
        suggestion: 'Create a dedicated "login" task for this website and add login recordings to it',
      });

      return {
        success: false,
        error: 'Login required but no login knowledge found. Please create a dedicated "login" task for this website with login recordings.',
      };
    }

    steps.push({
      step: 'login',
      action: `Execute login using ${knowledgeSource}`,
      success: false,
      knowledgeUsed: true,
      knowledgeDetails: `Using login recordings from ${knowledgeSource} (${loginTaskName})`,
    });

    try {
      // For dedicated login task, prefer executing from recorderJSON (more reliable)
      // For other tasks, try actions first, then fallback to recorderJSON
      if (loginTask && knowledgeSource.includes('dedicated login task')) {
        // For dedicated login task, execute directly from recorderJSON
        // This is more reliable as it uses the original recorded steps
        console.log(`[Login] Executing login from dedicated login task using recorderJSON`);
        
        const fallbackResult = await this.executeFromRecorderJSON(
          loginRecording.recorderJSON,
          page,
          steps,
          knowledgeGaps,
          parameters
        );
        
        if (fallbackResult.success) {
          steps[steps.length - 1].success = true;
          return { success: true };
        } else {
          steps[steps.length - 1].error = fallbackResult.error;
          return { success: false, error: fallbackResult.error };
        }
      } else {
        // For other tasks, try actions first, then fallback to recorderJSON
        const actionsToExecute = loginRecording.actions.filter(
          (action: any) => action.intent === 'submit-login'
        );
        console.log(`[Login] Executing ${actionsToExecute.length} login actions from task recording`);

        // Check if actions have valid selectors
        const hasValidActions = actionsToExecute.some((action: any) => {
          return action.steps && action.steps.some((step: any) => 
            step.target?.selector || (step.target?.value && step.target.strategy === 'text')
          );
        });

        if (hasValidActions) {
          // Try executing from actions
          let useFallback = false;
          for (const action of actionsToExecute) {
            const actionResult = await this.executeAction(action, page, knowledgeGaps, parameters);
            if (!actionResult.success) {
              // If error indicates missing selectors, use fallback
              if (actionResult.error?.includes('fallback') || 
                  actionResult.error?.includes('No valid selector') || 
                  actionResult.error?.includes('no valid target')) {
                useFallback = true;
                break;
              }
              steps[steps.length - 1].error = actionResult.error;
              return { success: false, error: actionResult.error };
            }
          }

          if (!useFallback) {
            steps[steps.length - 1].success = true;
            return { success: true };
          }
        }

        // Fallback to recorderJSON if actions don't have valid selectors or execution failed
        console.log(`[Login] Falling back to recorderJSON execution`);
        const fallbackResult = await this.executeFromRecorderJSON(
          loginRecording.recorderJSON,
          page,
          steps,
          knowledgeGaps,
          parameters
        );
        
        if (fallbackResult.success) {
          steps[steps.length - 1].success = true;
          return { success: true };
        } else {
          steps[steps.length - 1].error = fallbackResult.error;
          return { success: false, error: fallbackResult.error };
        }
      }
    } catch (error) {
      steps[steps.length - 1].error = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Verify we're on the correct page
   */
  private async verifyPage(
    page: Page,
    targetUrl: string,
    task: Task,
    justLoggedIn: boolean = false
  ): Promise<{ isCorrect: boolean; reason: string }> {
    const currentUrl = page.url();
    const analysis = await this.pageAnalyzer.analyzePage(page, {
      url: targetUrl,
    });

    // Check URL match (normalize for www., subdomains, and trailing slashes)
    const targetUrlObj = new URL(targetUrl);
    const currentUrlObj = new URL(currentUrl);

    // Normalize hostnames - remove www. and common subdomains for comparison
    const normalizeHostname = (hostname: string) => {
      // Remove www. prefix
      let normalized = hostname.replace(/^www\./, '');
      // Handle common subdomain redirects (e.g., web.facebook.com -> facebook.com)
      // Extract base domain (facebook.com from web.facebook.com)
      const parts = normalized.split('.');
      if (parts.length > 2) {
        // Check if it's a known subdomain redirect pattern
        const commonSubdomains = ['web', 'm', 'mobile', 'www'];
        if (commonSubdomains.includes(parts[0])) {
          // Remove subdomain: web.facebook.com -> facebook.com
          normalized = parts.slice(1).join('.');
        }
      }
      return normalized;
    };

    const normalizedTargetHost = normalizeHostname(targetUrlObj.hostname);
    const normalizedCurrentHost = normalizeHostname(currentUrlObj.hostname);

    // Normalize paths (remove trailing slashes and query parameters for comparison)
    const normalizePath = (pathname: string) => {
      return pathname.replace(/\/$/, '') || '/';
    };

    const normalizedTargetPath = normalizePath(targetUrlObj.pathname);
    const normalizedCurrentPath = normalizePath(currentUrlObj.pathname);

    // Check if hosts match (after normalization)
    // Also allow if current host is a subdomain of target (e.g., web.facebook.com matches facebook.com)
    const hostsMatch = normalizedTargetHost === normalizedCurrentHost ||
      currentUrlObj.hostname.endsWith('.' + normalizedTargetHost) ||
      normalizedCurrentHost.endsWith('.' + normalizedTargetHost);

    if (!hostsMatch) {
      return {
        isCorrect: false,
        reason: `URL mismatch: expected ${targetUrl}, got ${currentUrl}`,
      };
    }

    // For path matching, be lenient - if target is root path, accept any path
    // Otherwise check if current path starts with target path
    if (normalizedTargetPath !== '/' && !normalizedCurrentPath.startsWith(normalizedTargetPath)) {
      // But allow if target is just the domain (no specific path required)
      if (targetUrlObj.pathname === '/' || targetUrlObj.pathname === '') {
        // Target is just domain, so any path is acceptable
      } else {
        return {
          isCorrect: false,
          reason: `URL path mismatch: expected path starting with ${normalizedTargetPath}, got ${normalizedCurrentPath}`,
        };
      }
    }

    // Check page relevance
    if (!analysis.pageRelevance.isRelevant) {
      return {
        isCorrect: false,
        reason: `Page not relevant: ${analysis.pageRelevance.reasons.join(', ')}`,
      };
    }

    // Check for expected elements from task recordings (very lenient check)
    // Skip strict verification if we just logged in (page might be redirecting/loading)
    if (!justLoggedIn) {
      const bestRecording = this.getBestRecording(task);
      if (bestRecording && bestRecording.actions.length > 0) {
        const expectedSelectors = this.extractSelectors(bestRecording);
        
        // Only verify if we have selectors to check and they're not all aria selectors
        const cssSelectors = expectedSelectors.filter(s => !s.startsWith('aria/'));
        if (cssSelectors.length > 0) {
          let foundCount = 0;

          // Wait a bit longer for page to fully load after potential redirects
          await page.waitForTimeout(1000);

          for (const selector of cssSelectors) {
            try {
              // Wait a bit for elements to load
              const element = await page.waitForSelector(selector, { timeout: 2000, state: 'attached' }).catch(() => null);
              if (element) {
                foundCount++;
              }
            } catch {
              // Ignore selector errors during verification - elements might load later
            }
          }

          // Only fail if we find NONE of the CSS selectors AND we have multiple selectors to check
          // If we just logged in, be even more lenient
          if (foundCount === 0 && cssSelectors.length >= 2) {
            // If we just logged in, give it more time - page might be redirecting
            if (justLoggedIn) {
              await page.waitForTimeout(2000);
              // Try one more time
              for (const selector of cssSelectors.slice(0, 2)) {
                try {
                  const element = await page.waitForSelector(selector, { timeout: 3000, state: 'attached' }).catch(() => null);
                  if (element) {
                    foundCount++;
                  }
                } catch {
                  // Ignore
                }
              }
            }
            
            // Only fail if still no selectors found
            if (foundCount === 0) {
              return {
                isCorrect: false,
                reason: `Missing expected elements: none of ${cssSelectors.length} selectors found`,
              };
            }
          }
        }
      }
    } else {
      // If we just logged in, skip strict verification - page might be loading/redirecting
      // Just verify we're on the right domain
    }

    return { isCorrect: true, reason: 'Page verified' };
  }

  /**
   * Execute task actions from recording
   */
  private async executeTaskActions(
    recording: TaskRecording,
    page: Page,
    steps: TaskExecutionStep[],
    knowledgeGaps: KnowledgeGap[],
    parameters?: Record<string, string>,
    scrapedData?: Record<string, string | number | boolean | object | Array<string | number | boolean | object>>
  ): Promise<{ success: boolean; error?: string }> {
    // Filter out login actions (already handled)
    const taskActions = recording.actions.filter(
      action => action.intent !== 'submit-login' && action.intent !== 'navigate'
    );

    // If no actions or actions have no steps, try to execute directly from recorderJSON
    if (taskActions.length === 0 || taskActions.every(a => !a.steps || a.steps.length === 0)) {
      // Fallback: execute directly from recorderJSON steps
      return await this.executeFromRecorderJSON(recording.recorderJSON, page, steps, knowledgeGaps, parameters, scrapedData);
    }

    // Try to execute actions, but fallback to recorderJSON if selectors are missing
    let useFallback = false;
    for (const action of taskActions) {
      const stepResult = await this.executeAction(action, page, knowledgeGaps, parameters);
      
      steps.push({
        step: action.intent,
        action: `Execute ${action.intent}`,
        success: stepResult.success,
        knowledgeUsed: stepResult.knowledgeUsed,
        knowledgeDetails: stepResult.knowledgeDetails,
        error: stepResult.error,
      });

      if (!stepResult.success) {
        // If error indicates missing selectors, use fallback
        if (stepResult.error?.includes('fallback') || stepResult.error?.includes('No valid selector') || stepResult.error?.includes('no valid target')) {
          useFallback = true;
          break;
        }
        return {
          success: false,
          error: stepResult.error || `Failed to execute ${action.intent}`,
        };
      }
    }

    // If we need to use fallback, execute from original recorderJSON
    if (useFallback) {
      const fallbackResult = await this.executeFromRecorderJSON(recording.recorderJSON, page, steps, knowledgeGaps, parameters, scrapedData);
      
      // Update the last step to reflect fallback result
      if (steps.length > 0) {
        const lastStep = steps[steps.length - 1];
        if (lastStep.step === 'fallback' || lastStep.action?.includes('fallback')) {
          // Remove the incorrectly added fallback step
          steps.pop();
        }
      }
      
      // Add proper fallback step with actual result
      steps.push({
        step: 'fallback',
        action: 'Using fallback execution from original recording',
        success: fallbackResult.success,
        knowledgeUsed: false,
        error: fallbackResult.error,
      });
      
      return fallbackResult;
    }

    return { success: true };
  }

  /**
   * Fallback: Execute directly from Chrome Recorder JSON
   */
  private async executeFromRecorderJSON(
    recorderJSON: any,
    page: Page,
    steps: TaskExecutionStep[],
    _knowledgeGaps: KnowledgeGap[],
    parameters?: Record<string, string>,
    scrapedData?: Record<string, string | number | boolean | object | Array<string | number | boolean | object>>
  ): Promise<{ success: boolean; error?: string }> {
    if (!recorderJSON.steps || !Array.isArray(recorderJSON.steps)) {
      return { success: false, error: 'No steps found in recording' };
    }

    let lastError: string | undefined;
    let executedSteps = 0;

    for (const step of recorderJSON.steps) {
      // Skip viewport and navigation (already done)
      if (step.type === 'setViewport' || step.type === 'navigate') {
        continue;
      }

      try {
        // Extract selector from selectors array
        let selector: string | null = null;
        if (Array.isArray(step.selectors) && step.selectors.length > 0) {
          // Prefer CSS selectors
          for (const selectorArray of step.selectors) {
            if (Array.isArray(selectorArray) && selectorArray.length > 0) {
              const sel = String(selectorArray[0]);
              if (!sel.startsWith('aria/') && !sel.startsWith('xpath/') && !sel.startsWith('pierce/')) {
                selector = sel;
                break;
              }
            }
          }
          // If no CSS selector, use first one
          if (!selector && Array.isArray(step.selectors[0]) && step.selectors[0].length > 0) {
            selector = String(step.selectors[0][0]);
          }
        }

        switch (step.type) {
          case 'scrape': {
            // Handle scraping step
            if (scrapedData && step.dataKey) {
              try {
                // Check if this is structured scraping
                if (step.structure && Array.isArray(step.structure) && step.structure.length > 0) {
                  // Structured scraping: extract multiple fields as objects
                  await this.scrapeStructuredData(page, step, scrapedData);
                } else {
                  // Simple scraping: extract single value or array
                  const scrapeSelector = selector || step.selector;
                  if (!scrapeSelector) {
                    steps.push({
                      step: 'scrape',
                      action: `Scrape ${step.dataKey}`,
                      success: false,
                      knowledgeUsed: false,
                      error: 'No selector provided for scrape step',
                    });
                    break;
                  }

                  await page.waitForSelector(scrapeSelector, { timeout: 10000, state: 'visible' }).catch(() => {
                    // Continue even if selector wait fails - element might already be visible
                  });

                  const attribute = step.attribute || 'text';
                  const multiple = step.multiple || false;

                  if (multiple) {
                    // Extract all matching elements
                    const elements = page.locator(scrapeSelector);
                    const count = await elements.count();
                    const values: Array<string | number | boolean | object> = [];

                    for (let i = 0; i < count; i++) {
                      const element = elements.nth(i);
                      const value = await this.extractElementValue(element, attribute);
                      if (value) {
                        values.push(value);
                      }
                    }

                    scrapedData[step.dataKey] = values;
                  } else {
                    // Extract first matching element
                    const element = page.locator(scrapeSelector).first();
                    const value = await this.extractElementValue(element, attribute);
                    scrapedData[step.dataKey] = value;
                  }
                }

                steps.push({
                  step: 'scrape',
                  action: step.structure 
                    ? `Scrape structured data: ${step.dataKey}`
                    : `Scrape ${step.dataKey} from ${selector || step.selector}`,
                  success: true,
                  knowledgeUsed: false,
                });
              } catch (scrapeError) {
                const errorMsg = scrapeError instanceof Error ? scrapeError.message : String(scrapeError);
                steps.push({
                  step: 'scrape',
                  action: `Scrape ${step.dataKey}`,
                  success: false,
                  knowledgeUsed: false,
                  error: errorMsg,
                });
              }
            }
            break;
          }

          case 'click':
            if (selector) {
              if (selector.startsWith('aria/')) {
                const ariaLabel = selector.replace('aria/', '');
                await page.getByRole('searchbox', { name: ariaLabel }).click({ timeout: 10000 }).catch(() => {
                  return page.getByLabel(ariaLabel).click({ timeout: 10000 });
                });
              } else {
                await page.click(selector, { timeout: 10000 });
              }
            }
            break;
          case 'change':
          case 'input':
            if (selector) {
              // Get value: use parameter if provided, otherwise use recorded value
              let fillValue = step.value || '';
              if (parameters) {
                // First, try to detect if this is an email or password field
                const selectorLower = selector.toLowerCase();
                const isEmailField = selectorLower.includes('email') || 
                                     selectorLower.includes('user') ||
                                     selectorLower.includes('username') ||
                                     selectorLower.includes('login');
                const isPasswordField = selectorLower.includes('password') || 
                                        selectorLower.includes('pass');
                
                // Try email parameter for email fields
                if (isEmailField && parameters['email']) {
                  fillValue = parameters['email'];
                }
                // Try password parameter for password fields
                else if (isPasswordField && parameters['password']) {
                  fillValue = parameters['password'];
                }
                // Try username parameter as fallback for email fields
                else if (isEmailField && parameters['username']) {
                  fillValue = parameters['username'];
                }
                // Try to find parameter by selector
                else {
                  const paramKey = selector.replace(/[#.]/g, '_');
                  if (parameters[paramKey]) {
                    fillValue = parameters[paramKey];
                  } else if (parameters[selector]) {
                    fillValue = parameters[selector];
                  } else {
                    // Use indexed parameters or single parameter
                    const inputParams = Object.entries(parameters).filter(([k]) => k.startsWith('input_'));
                    if (inputParams.length > 0) {
                      // Find which input this is by counting previous inputs
                      const inputIndex = recorderJSON.steps.slice(0, recorderJSON.steps.indexOf(step)).filter((s: any) => s.type === 'change' || s.type === 'input').length;
                      const paramKey = `input_${inputIndex}`;
                      if (parameters[paramKey]) {
                        fillValue = parameters[paramKey];
                      } else if (inputParams[0]) {
                        fillValue = inputParams[0][1]; // Use first input parameter
                      }
                    } else if (Object.keys(parameters).length === 1) {
                      fillValue = Object.values(parameters)[0];
                    }
                  }
                }
              }
              
              // Use humanized typing for all input fields
              if (selector.startsWith('aria/')) {
                const ariaLabel = selector.replace('aria/', '');
                await this.humanizedType(page, selector, fillValue, {
                  timeout: 10000,
                  useAria: true,
                  ariaLabel,
                });
              } else {
                await this.humanizedType(page, selector, fillValue, { timeout: 10000 });
              }
            }
            break;
          case 'keyDown':
            if (step.key === 'Enter') {
              await page.keyboard.press('Enter');
            }
            break;
        }
        
        executedSteps++;
        // Track successful step execution
        steps.push({
          step: step.type,
          action: `Execute ${step.type}${step.type === 'change' || step.type === 'input' ? ` (${step.value || ''})` : ''}`,
          success: true,
          knowledgeUsed: false,
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        lastError = errorMsg;
        
        // Track failed step
        steps.push({
          step: step.type,
          action: `Execute ${step.type}`,
          success: false,
          knowledgeUsed: false,
          error: errorMsg,
        });
        
        // Continue with next steps instead of failing immediately
        // This allows partial success (e.g., if click fails but keyDown works)
      }
    }

    // Return success if we executed at least one step successfully
    // or if we completed all steps without critical errors
    if (executedSteps > 0 || lastError === undefined) {
      return { success: true };
    }
    
    return { 
      success: false, 
      error: lastError || 'Failed to execute steps from recording' 
    };
  }

  /**
   * Execute a single action from recording steps
   */
  private async executeAction(
    action: any,
    page: Page,
    knowledgeGaps: KnowledgeGap[],
    parameters?: Record<string, string>,
    task?: Task
  ): Promise<{ success: boolean; knowledgeUsed: boolean; knowledgeDetails?: string; error?: string }> {
    // Check if action has valid steps with selectors
    const hasValidSteps = action.steps && action.steps.some((step: any) => 
      step.target?.selector || (step.target?.value && step.target.strategy === 'text')
    );

    // If no valid steps, signal that we should use fallback
    if (!hasValidSteps) {
      return {
        success: false,
        knowledgeUsed: false,
        error: 'Action has no valid selectors - will use fallback execution',
      };
    }

    // Execute the steps from the recording directly
    const knowledgeDetails: string[] = [];
    try {
      for (const step of action.steps) {
        const stepResult = await this.executeStep(step, page, knowledgeGaps, parameters, task);
        if (stepResult.knowledgeUsed && stepResult.knowledgeDetails) {
          knowledgeDetails.push(stepResult.knowledgeDetails);
        }
      }

      return {
        success: true,
        knowledgeUsed: knowledgeDetails.length > 0,
        knowledgeDetails: knowledgeDetails.length > 0 ? knowledgeDetails.join('; ') : undefined,
      };
    } catch (error) {
      // If execution fails, try to find similar actions from other tasks
      const errorMsg = error instanceof Error ? error.message : String(error);
      
      if (this.websiteManager && task) {
        // Try to find similar action from other tasks
        const similarAction = await this.findSimilarActionFromOtherTasks(task, action, page);
        if (similarAction) {
          // Retry with knowledge from other task
          try {
            for (const step of similarAction.steps) {
              const stepResult = await this.executeStep(step, page, knowledgeGaps, parameters, task);
              if (stepResult.knowledgeUsed && stepResult.knowledgeDetails) {
                knowledgeDetails.push(stepResult.knowledgeDetails);
              }
            }
            return {
              success: true,
              knowledgeUsed: true,
              knowledgeDetails: `Used similar action from task "${similarAction.taskName}"; ${knowledgeDetails.join('; ')}`,
            };
          } catch (retryError) {
            // If retry also fails, continue with original error
          }
        }
      }
      
      if (errorMsg.includes('No valid selector') || errorMsg.includes('no valid target')) {
        return {
          success: false,
          knowledgeUsed: false,
          error: 'Selector extraction failed - will use fallback execution',
        };
      }
      return {
        success: false,
        knowledgeUsed: knowledgeDetails.length > 0,
        knowledgeDetails: knowledgeDetails.length > 0 ? knowledgeDetails.join('; ') : undefined,
        error: errorMsg,
      };
    }
  }

  /**
   * Find similar action from other tasks when current action fails
   */
  private async findSimilarActionFromOtherTasks(
    currentTask: Task,
    failedAction: any,
    page: Page
  ): Promise<{ steps: any[]; taskName: string } | null> {
    if (!this.websiteManager) return null;

    try {
      const taskData = this.websiteManager.getTask(currentTask.id);
      if (!taskData) return null;

      const { website } = taskData;
      const actionIntent = failedAction.intent;

      // Search all tasks for similar actions
      for (const otherTask of website.tasks) {
        if (otherTask.id === currentTask.id) continue;

        for (const recording of otherTask.recordings) {
          if (!recording.success) continue;

          // Look for actions with same intent
          for (const action of recording.actions) {
            if (action.intent === actionIntent) {
              // Verify the selectors work on current page
              let allSelectorsWork = true;
              for (const step of action.steps) {
                if (step.target?.selector) {
                  try {
                    const element = await page.locator(step.target.selector).first();
                    const count = await element.count();
                    if (count === 0) {
                      allSelectorsWork = false;
                      break;
                    }
                  } catch {
                    allSelectorsWork = false;
                    break;
                  }
                }
              }

              if (allSelectorsWork) {
                return {
                  steps: action.steps,
                  taskName: otherTask.name,
                };
              }
            }
          }
        }
      }

      // If exact intent match not found, try pattern matching
      // e.g., if looking for "submit-login", try any action with "login" in intent
      const intentPattern = this.extractIntentPattern(actionIntent);
      if (intentPattern) {
        for (const otherTask of website.tasks) {
          if (otherTask.id === currentTask.id) continue;

          for (const recording of otherTask.recordings) {
            if (!recording.success) continue;

            for (const action of recording.actions) {
              if (action.intent.toLowerCase().includes(intentPattern.toLowerCase())) {
                // Verify selectors work
                let allSelectorsWork = true;
                for (const step of action.steps) {
                  if (step.target?.selector) {
                    try {
                      const element = await page.locator(step.target.selector).first();
                      const count = await element.count();
                      if (count === 0) {
                        allSelectorsWork = false;
                        break;
                      }
                    } catch {
                      allSelectorsWork = false;
                      break;
                    }
                  }
                }

                if (allSelectorsWork) {
                  return {
                    steps: action.steps,
                    taskName: otherTask.name,
                  };
                }
              }
            }
          }
        }
      }
    } catch (error) {
      console.warn('Failed to find similar action from other tasks:', error);
    }

    return null;
  }

  /**
   * Extract pattern from intent (e.g., "login" from "submit-login")
   */
  private extractIntentPattern(intent: string): string | null {
    const lowerIntent = intent.toLowerCase();
    
    if (lowerIntent.includes('login') || lowerIntent.includes('signin')) {
      return 'login';
    }
    if (lowerIntent.includes('search')) {
      return 'search';
    }
    if (lowerIntent.includes('submit') || lowerIntent.includes('form')) {
      return 'submit';
    }
    if (lowerIntent.includes('navigate')) {
      return 'navigate';
    }
    
    return null;
  }

  /**
   * Humanized typing: Type text character by character with random delays and human-like patterns
   */
  private async humanizedType(
    page: Page,
    selector: string,
    text: string,
    options?: { timeout?: number; useAria?: boolean; ariaLabel?: string }
  ): Promise<void> {
    const timeout = options?.timeout || 10000;
    
    // Get the element
    let element;
    if (options?.useAria && options.ariaLabel) {
      try {
        element = page.getByRole('searchbox', { name: options.ariaLabel });
      } catch {
        try {
          element = page.getByLabel(options.ariaLabel);
        } catch {
          element = page.locator(`[aria-label="${options.ariaLabel}"]`).first();
        }
      }
    } else {
      element = page.locator(selector);
    }

    // Get bounding box for mouse movement
    const box = await element.boundingBox();
    
    // Move mouse to element with human-like curve (if element is visible)
    if (box) {
      const startX = box.x + box.width / 2;
      const startY = box.y + box.height / 2;
      
      // Add slight random offset to mouse position
      const offsetX = (Math.random() - 0.5) * 10;
      const offsetY = (Math.random() - 0.5) * 10;
      
      await page.mouse.move(startX + offsetX, startY + offsetY, {
        steps: Math.floor(Math.random() * 5) + 3, // 3-7 steps for smooth movement
      });
      
      // Small random delay before clicking
      await page.waitForTimeout(Math.floor(Math.random() * 100) + 50);
    }

    // Click to focus (more human-like than just focus)
    await element.click({ timeout, delay: Math.floor(Math.random() * 50) + 10 });
    
    // Small delay after click
    await page.waitForTimeout(Math.floor(Math.random() * 150) + 50);

    // Clear the field using keyboard (more human-like)
    await page.keyboard.press('Control+A');
    await page.waitForTimeout(Math.floor(Math.random() * 50) + 20);

    // Type character by character with human-like patterns
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      
      // Variable typing speed (faster for common characters, slower for special)
      let baseDelay = this.getRandomTypingDelay();
      if (char === ' ' || char.match(/[a-zA-Z0-9]/)) {
        // Common characters: 30-120ms
        baseDelay = Math.floor(Math.random() * 90) + 30;
      } else {
        // Special characters: 80-200ms (people type these slower)
        baseDelay = Math.floor(Math.random() * 120) + 80;
      }
      
      // Use keyboard.type for humanized typing (this handles input events automatically)
      await page.keyboard.type(char, { delay: baseDelay });
      
      // Occasional longer pauses (like humans thinking or correcting)
      if (Math.random() < 0.1 && i < text.length - 1) {
        // 10% chance of a longer pause (200-500ms)
        await page.waitForTimeout(Math.floor(Math.random() * 300) + 200);
      } else if (i < text.length - 1) {
        // Normal small delay between characters
        await page.waitForTimeout(Math.floor(Math.random() * 30) + 10);
      }
      
      // Pause after spaces (humans often pause after words)
      if (char === ' ' && i < text.length - 1) {
        await page.waitForTimeout(Math.floor(Math.random() * 100) + 50);
      }
    }
  }

  /**
   * Get random typing delay (30-200ms) to simulate human typing speed
   */
  private getRandomTypingDelay(): number {
    // Random delay between 30ms and 200ms
    return Math.floor(Math.random() * 170) + 30;
  }

  /**
   * Find knowledge from other tasks when current task doesn't have it
   * Intelligently searches for selectors that work on the current page
   */
  private async findCrossTaskKnowledge(
    currentTask: Task,
    actionType: string,
    originalSelector: string,
    page: Page
  ): Promise<{ selector: string; taskName: string } | null> {
    if (!this.websiteManager) return null;

    try {
      const taskData = this.websiteManager.getTask(currentTask.id);
      if (!taskData) return null;

      const { website } = taskData;

      // First, try to find exact action type matches
      for (const otherTask of website.tasks) {
        if (otherTask.id === currentTask.id) continue;

        // Search recordings for similar actions (prioritize successful ones)
        const sortedRecordings = [...otherTask.recordings].sort((a, b) => 
          (b.success ? 1 : 0) - (a.success ? 1 : 0)
        );

        for (const recording of sortedRecordings) {
          for (const action of recording.actions) {
            for (const actionStep of action.steps) {
              // Check if this step matches what we're looking for
              if (actionStep.action === actionType && actionStep.target?.selector) {
                const candidateSelector = actionStep.target.selector;

                // Skip if it's the same selector we already tried
                if (candidateSelector === originalSelector) continue;

                // Try to find this selector on the current page
                try {
                  const element = await page.locator(candidateSelector).first();
                  const count = await element.count();
                  if (count > 0) {
                    // Verify it's actually visible/interactable
                    const isVisible = await element.isVisible().catch(() => false);
                    if (isVisible) {
                      // Found a working selector from another task!
                      return {
                        selector: candidateSelector,
                        taskName: otherTask.name,
                      };
                    }
                  }
                } catch {
                  // Selector doesn't work, try next
                  continue;
                }
              }
            }
          }
        }
      }

      // Also check for similar selectors by pattern matching
      // e.g., if looking for email field, find any input[type="email"] from other tasks
      const selectorPattern = this.extractSelectorPattern(originalSelector);
      if (selectorPattern) {
        // Prioritize successful recordings
        for (const otherTask of website.tasks) {
          if (otherTask.id === currentTask.id) continue;

          const sortedRecordings = [...otherTask.recordings].sort((a, b) => 
            (b.success ? 1 : 0) - (a.success ? 1 : 0)
          );

          for (const recording of sortedRecordings) {
            for (const action of recording.actions) {
              for (const actionStep of action.steps) {
                if (actionStep.action === actionType && actionStep.target?.selector) {
                  const candidateSelector = actionStep.target.selector;
                  
                  // Skip if it's the same selector
                  if (candidateSelector === originalSelector) continue;
                  
                  // Check if selector pattern matches
                  if (this.selectorsMatchPattern(candidateSelector, selectorPattern)) {
                    try {
                      const element = await page.locator(candidateSelector).first();
                      const count = await element.count();
                      if (count > 0) {
                        // Verify it's visible
                        const isVisible = await element.isVisible().catch(() => false);
                        if (isVisible) {
                          return {
                            selector: candidateSelector,
                            taskName: otherTask.name,
                          };
                        }
                      }
                    } catch {
                      continue;
                    }
                  }
                }
              }
            }
          }
        }
      }
    } catch (error) {
      console.warn('Failed to find cross-task knowledge:', error);
    }

    return null;
  }

  /**
   * Extract pattern from selector (e.g., input[type="email"] from #email)
   */
  private extractSelectorPattern(selector: string): string | null {
    // Try to infer pattern from selector
    if (selector.includes('email') || selector.includes('Email')) {
      return 'email';
    }
    if (selector.includes('password') || selector.includes('Password')) {
      return 'password';
    }
    if (selector.includes('login') || selector.includes('Login')) {
      return 'login';
    }
    if (selector.includes('search') || selector.includes('Search')) {
      return 'search';
    }
    return null;
  }

  /**
   * Check if a selector matches a pattern
   */
  private selectorsMatchPattern(selector: string, pattern: string): boolean {
    const lowerSelector = selector.toLowerCase();
    const lowerPattern = pattern.toLowerCase();

    // Direct match
    if (lowerSelector.includes(lowerPattern)) return true;

    // Pattern-specific matching
    if (pattern === 'email') {
      return lowerSelector.includes('email') || 
             lowerSelector.includes('input[type="email"]') ||
             lowerSelector.includes('[name*="email"]');
    }
    if (pattern === 'password') {
      return lowerSelector.includes('password') || 
             lowerSelector.includes('input[type="password"]');
    }
    if (pattern === 'login') {
      return lowerSelector.includes('login') || 
             lowerSelector.includes('signin') ||
             lowerSelector.includes('button[type="submit"]');
    }
    if (pattern === 'search') {
      return lowerSelector.includes('search') || 
             lowerSelector.includes('input[type="search"]');
    }

    return false;
  }

  /**
   * Execute a single canonical step using Playwright
   */
  private async executeStep(
    step: any,
    page: Page,
    _knowledgeGaps: KnowledgeGap[],
    parameters?: Record<string, string>,
    task?: Task
  ): Promise<{ knowledgeUsed: boolean; knowledgeDetails?: string }> {
    const timeout = step.timeout || 10000;

    try {
      switch (step.action) {
        case 'navigate':
          if (step.value) {
            await page.goto(step.value, { waitUntil: 'load', timeout });
          }
          return { knowledgeUsed: false };

        case 'fill':
          if (step.target?.selector) {
            const site = this.extractSiteFromPage(page);
            const originalSelector = step.target.selector;
            
            // First try knowledge base
            const bestSelector = await this.knowledgeBase.getBestSelector(site, originalSelector);
            let selectorToUse = bestSelector?.healedSelector || bestSelector?.originalSelector || originalSelector;
            let knowledgeDetails: string | undefined;
            
            // If knowledge base doesn't have it, query other tasks for similar selectors
            if (!bestSelector && this.websiteManager && task) {
              const crossTaskKnowledge = await this.findCrossTaskKnowledge(
                task,
                'fill',
                originalSelector,
                page
              );
              
              if (crossTaskKnowledge) {
                selectorToUse = crossTaskKnowledge.selector;
                knowledgeDetails = `Used selector from task "${crossTaskKnowledge.taskName}": ${selectorToUse}`;
              }
            } else if (bestSelector) {
              if (bestSelector.healedSelector && bestSelector.healedSelector !== originalSelector) {
                knowledgeDetails = `Used healed selector: ${bestSelector.healedSelector} (from ${originalSelector})`;
              } else if (bestSelector.originalSelector === originalSelector) {
                knowledgeDetails = `Used learned selector: ${originalSelector} (${bestSelector.successCount} successes)`;
              }
            }
            
            // Get value: use parameter if provided, otherwise use recorded value
            // Parameters are keyed by selector or by input index
            let fillValue = step.value || '';
            if (parameters) {
              // Try to find parameter by selector first
              const paramKey = selectorToUse.replace(/[#.]/g, '_');
              if (parameters[paramKey]) {
                fillValue = parameters[paramKey];
              } else if (parameters[selectorToUse]) {
                fillValue = parameters[selectorToUse];
              } else if (parameters['input_0'] || parameters['input_1'] || parameters['input_2']) {
                // Use indexed parameters (input_0, input_1, etc.)
                // This is a simple approach - could be improved with better parameter mapping
                const inputIndex = Object.keys(parameters).find(k => k.startsWith('input_'));
                if (inputIndex) {
                  fillValue = parameters[inputIndex];
                }
              } else if (Object.keys(parameters).length === 1) {
                // If only one parameter, use it
                fillValue = Object.values(parameters)[0];
              }
            }
            
            // Handle aria selectors with humanized typing
            try {
              if (selectorToUse.startsWith('aria/')) {
                const ariaLabel = selectorToUse.replace('aria/', '');
                await this.humanizedType(page, selectorToUse, fillValue, {
                  timeout,
                  useAria: true,
                  ariaLabel,
                });
              } else {
                await this.humanizedType(page, selectorToUse, fillValue, { timeout });
              }
              
              return {
                knowledgeUsed: !!bestSelector || !!knowledgeDetails,
                knowledgeDetails,
              };
            } catch (fillError) {
              // If fill fails, try to find alternative selector from other tasks
              if (this.websiteManager && task && !knowledgeDetails) {
                const alternative = await this.findCrossTaskKnowledge(
                  task,
                  'fill',
                  originalSelector,
                  page
                );
                
                if (alternative && alternative.selector !== selectorToUse) {
                  try {
                    await this.humanizedType(page, alternative.selector, fillValue, { timeout });
                    return {
                      knowledgeUsed: true,
                      knowledgeDetails: `Used alternative selector from task "${alternative.taskName}": ${alternative.selector}`,
                    };
                  } catch {
                    // Alternative also failed, throw original error
                  }
                }
              }
              throw fillError;
            }
          }
          return { knowledgeUsed: false };
          break;

        case 'click':
          if (step.target?.selector) {
            const site = this.extractSiteFromPage(page);
            const originalSelector = step.target.selector;
            
            // First try knowledge base
            const bestSelector = await this.knowledgeBase.getBestSelector(site, originalSelector);
            let selectorToUse = bestSelector?.healedSelector || bestSelector?.originalSelector || originalSelector;
            let knowledgeDetails: string | undefined;
            
            // If knowledge base doesn't have it, query other tasks for similar selectors
            if (!bestSelector && this.websiteManager && task) {
              const crossTaskKnowledge = await this.findCrossTaskKnowledge(
                task,
                'click',
                originalSelector,
                page
              );
              
              if (crossTaskKnowledge) {
                selectorToUse = crossTaskKnowledge.selector;
                knowledgeDetails = `Used selector from task "${crossTaskKnowledge.taskName}": ${selectorToUse}`;
              }
            } else if (bestSelector) {
              if (bestSelector.healedSelector && bestSelector.healedSelector !== originalSelector) {
                knowledgeDetails = `Used healed selector: ${bestSelector.healedSelector} (from ${originalSelector})`;
              } else if (bestSelector.originalSelector === originalSelector) {
                knowledgeDetails = `Used learned selector: ${originalSelector} (${bestSelector.successCount} successes)`;
              }
            }
            
            // Handle aria selectors
            try {
              if (selectorToUse.startsWith('aria/')) {
                // Convert aria/Search to getByRole('searchbox') or similar
                const ariaLabel = selectorToUse.replace('aria/', '');
                // Try getByRole first, fallback to getByLabelText
                try {
                  await page.getByRole('searchbox', { name: ariaLabel }).click({ timeout });
                } catch {
                  try {
                    await page.getByLabel(ariaLabel).click({ timeout });
                  } catch {
                    // Fallback: try to find by accessible name
                    const element = await page.locator(`[aria-label="${ariaLabel}"]`).first();
                    if (await element.count() > 0) {
                      await element.click({ timeout });
                    } else {
                      throw new Error(`Could not find element with aria selector: ${selectorToUse}`);
                    }
                  }
                }
              } else {
                await page.click(selectorToUse, { timeout });
              }
              
              return {
                knowledgeUsed: !!bestSelector || !!knowledgeDetails,
                knowledgeDetails,
              };
            } catch (clickError) {
              // If click fails, try to find alternative selector from other tasks
              if (this.websiteManager && task && !knowledgeDetails) {
                const alternative = await this.findCrossTaskKnowledge(
                  task,
                  'click',
                  originalSelector,
                  page
                );
                
                if (alternative && alternative.selector !== selectorToUse) {
                  try {
                    await page.click(alternative.selector, { timeout });
                    return {
                      knowledgeUsed: true,
                      knowledgeDetails: `Used alternative selector from task "${alternative.taskName}": ${alternative.selector}`,
                    };
                  } catch {
                    // Alternative also failed, throw original error
                  }
                }
              }
              throw clickError;
            }
          } else if (step.target?.value && step.target.strategy === 'text') {
            // Only use text-based click if strategy is explicitly 'text' and value exists
            await page.click(`text=${step.target.value}`, { timeout });
            return { knowledgeUsed: false };
          } else if (!step.target || (!step.target.selector && !step.target.value)) {
            // No target at all - this means the selector extraction failed
            // This will trigger the fallback to execute from recorderJSON
            throw new Error(`Click action has no valid target. Selector extraction may have failed.`);
          } else {
            // Debug: log the step to understand what we're working with
            console.error('Click step missing selector:', JSON.stringify({
              action: step.action,
              target: step.target,
              step: step
            }, null, 2));
            throw new Error(`No valid selector found for click action. Target: ${JSON.stringify(step.target || {})}`);
          }
          break;

        case 'waitFor':
          if (step.target?.selector) {
            await page.waitForSelector(step.target.selector, { timeout });
          } else {
            // Just wait for timeout
            await page.waitForTimeout(timeout);
          }
          break;

        case 'press': {
          const pressSelector = step.target?.selector || 'body';
          const key = step.value || step.key || 'Enter';
          await page.press(pressSelector, key, { timeout });
          break;
        }

        case 'select':
          if (step.target?.selector && step.value) {
            await page.selectOption(step.target.selector, step.value, { timeout });
          }
          break;

        case 'scroll':
          if (step.options) {
            await page.evaluate((opts) => {
              window.scrollBy(opts.x || 0, opts.y || 0);
            }, step.options);
          } else {
            await page.evaluate(() => {
              window.scrollBy(0, window.innerHeight);
            });
          }
          break;

        default:
          console.warn(`Unknown step action: ${step.action}`);
          return { knowledgeUsed: false };
      }
      
      // Default return if switch doesn't return (shouldn't happen, but TypeScript needs it)
      return { knowledgeUsed: false };
    } catch (error) {
      // If selector fails, try to learn from it
      if (step.target?.selector) {
        // Note: This would ideally update knowledge base with failure
        console.warn(`Step execution failed: ${step.action} on ${step.target.selector}`);
      }
      throw error;
    }
  }

  /**
   * Helper methods
   */
  private getBestRecording(task: Task): TaskRecording | null {
    const successful = task.recordings.filter(r => r.success);
    if (successful.length > 0) {
      return successful.sort((a, b) => b.recordedAt - a.recordedAt)[0];
    }
    return task.recordings.sort((a, b) => b.recordedAt - a.recordedAt)[0] || null;
  }

  private extractSelectors(recording: TaskRecording): string[] {
    const selectors: string[] = [];
    for (const action of recording.actions) {
      for (const step of action.steps) {
        if (step.target?.selector) {
          selectors.push(step.target.selector);
        }
      }
    }
    return selectors;
  }

  private extractSiteFromPage(page: Page): string {
    try {
      const url = new URL(page.url());
      return url.hostname;
    } catch {
      return 'unknown';
    }
  }

  /**
   * Extract value from an element based on attribute
   */
  private async extractElementValue(
    element: any,
    attribute: string
  ): Promise<string> {
    if (attribute === 'text' || attribute === 'textContent') {
      return (await element.textContent())?.trim() || '';
    } else if (attribute === 'innerHTML' || attribute === 'html') {
      return await element.innerHTML() || '';
    } else if (attribute === 'value') {
      return (await element.inputValue()) || '';
    } else {
      return (await element.getAttribute(attribute)) || '';
    }
  }

  /**
   * Scrape structured data (multiple fields as objects)
   */
  private async scrapeStructuredData(
    page: Page,
    step: any,
    scrapedData: Record<string, string | number | boolean | object | Array<string | number | boolean | object>>
  ): Promise<void> {
    if (!step.structure || !Array.isArray(step.structure)) {
      throw new Error('Structured scraping requires a structure array');
    }

    // Extract selector from step
    let containerSelector: string | null = null;
    if (Array.isArray(step.selectors) && step.selectors.length > 0) {
      // Prefer CSS selectors
      for (const selectorArray of step.selectors) {
        if (Array.isArray(selectorArray) && selectorArray.length > 0) {
          const sel = String(selectorArray[0]);
          if (!sel.startsWith('aria/') && !sel.startsWith('xpath/') && !sel.startsWith('pierce/')) {
            containerSelector = sel;
            break;
          }
        }
      }
      if (!containerSelector && Array.isArray(step.selectors[0]) && step.selectors[0].length > 0) {
        containerSelector = String(step.selectors[0][0]);
      }
    } else if (step.containerSelector) {
      containerSelector = step.containerSelector;
    } else if (step.selector) {
      containerSelector = step.selector;
    }

    const multiple = step.multiple !== false; // Default to true for structured data

    if (containerSelector) {
      // Wait for container
      await page.waitForSelector(containerSelector, { timeout: 10000, state: 'visible' }).catch(() => {
        // Continue even if selector wait fails
      });
    }

    if (multiple && containerSelector) {
      // Extract multiple structured objects
      const containers = page.locator(containerSelector);
      const containerCount = await containers.count();
      const structuredArray: Array<Record<string, string | number | boolean>> = [];

      for (let i = 0; i < containerCount; i++) {
        const container = containers.nth(i);
        const structuredObject: Record<string, string | number | boolean> = {};

        for (const field of step.structure) {
          try {
            // Use relative selector if container exists, otherwise absolute
            const fieldSelector = field.selector;
            const fieldElement = containerSelector 
              ? container.locator(fieldSelector).first()
              : page.locator(fieldSelector).first();
            
            const count = await fieldElement.count();
            if (count > 0) {
              const attribute = field.attribute || 'text';
              let value = await this.extractElementValue(fieldElement, attribute);
              
              // Apply transformation if specified
              if (value && field.transform) {
                value = this.applyTransform(value, field.transform, fieldElement, container);
              }

              if (value || !field.required) {
                structuredObject[field.key] = value;
              }
            } else if (field.required) {
              throw new Error(`Required field '${field.key}' not found`);
            }
          } catch (fieldError) {
            if (field.required) {
              throw new Error(`Failed to extract required field '${field.key}': ${fieldError instanceof Error ? fieldError.message : String(fieldError)}`);
            }
            // Optional field, skip it
          }
        }

        structuredArray.push(structuredObject);
      }

      scrapedData[step.dataKey] = structuredArray;
    } else {
      // Extract single structured object
      const container = containerSelector 
        ? page.locator(containerSelector).first()
        : null;
      
      const structuredObject: Record<string, string | number | boolean> = {};

      for (const field of step.structure) {
        try {
          const fieldSelector = field.selector;
          const fieldElement = container
            ? container.locator(fieldSelector).first()
            : page.locator(fieldSelector).first();
          
          const count = await fieldElement.count();
          if (count > 0) {
            const attribute = field.attribute || 'text';
            let value = await this.extractElementValue(fieldElement, attribute);
            
            // Apply transformation if specified
            if (value && field.transform) {
              value = this.applyTransform(value, field.transform, fieldElement, container);
            }

            if (value || !field.required) {
              structuredObject[field.key] = value;
            }
          } else if (field.required) {
            throw new Error(`Required field '${field.key}' not found`);
          }
        } catch (fieldError) {
          if (field.required) {
            throw new Error(`Failed to extract required field '${field.key}': ${fieldError instanceof Error ? fieldError.message : String(fieldError)}`);
          }
          // Optional field, skip it
        }
      }

      scrapedData[step.dataKey] = structuredObject;
    }
  }

  /**
   * Apply transformation to scraped value
   */
  private applyTransform(
    value: string,
    transform: string,
    _element: any,
    _container: any
  ): string {
    switch (transform.toLowerCase()) {
      case 'extracttime':
      case 'extract-time': {
        // Extract time from text (e.g., "12:52" from "message text 12:52")
        const timeMatch = value.match(/(\d{1,2}:\d{2}(?::\d{2})?)/);
        return timeMatch ? timeMatch[1] : value;
      }

      case 'issentbyme':
      case 'is-sent-by-me':
      case 'sender': {
        // Check if message is sent by user (common patterns)
        // This could check for specific classes, data attributes, or position
        // For now, return a placeholder - can be enhanced with container checks
        return 'sent'; // or 'received' - could be enhanced with element inspection
      }

      case 'trim':
        return value.trim();

      case 'lowercase':
        return value.toLowerCase();

      case 'uppercase':
        return value.toUpperCase();

      case 'extractnumber':
      case 'extract-number': {
        // Extract first number from text
        const numMatch = value.match(/(\d+)/);
        return numMatch ? numMatch[1] : value;
      }

      default:
        // Return as-is if transform not recognized
        return value;
    }
  }
}

