import type { Page } from 'playwright';
import type {
  PlaywrightCommand,
  PlaywrightCommandPlan,
  ExecutionResult,
  ExecutionStatus,
} from '../types/index.js';
import { EnhancedSelectorHealer } from './EnhancedSelectorHealer.js';
import { IntelligenceEngine } from './IntelligenceEngine.js';
import { StrategyManager } from './StrategyManager.js';
import { PerformanceMonitor } from './PerformanceMonitor.js';
import type { KnowledgeBase } from './KnowledgeBase.js';
import { launchBrowser, humanDelay } from '../utils/BrowserConfig.js';
import type { BrowserContext } from 'playwright';

/**
 * Executor: Runs Playwright commands and returns structured results
 * Now with intelligent page analysis and decision-making
 */
export class Executor {
  private context: BrowserContext | null = null;
  private selectorHealer: EnhancedSelectorHealer;
  private intelligenceEngine: IntelligenceEngine;
  private strategyManager: StrategyManager;
  private performanceMonitor: PerformanceMonitor;
  private screenshotsDir: string = './screenshots';

  constructor(knowledgeBase?: KnowledgeBase) {
    this.selectorHealer = new EnhancedSelectorHealer(knowledgeBase);
    this.intelligenceEngine = new IntelligenceEngine(knowledgeBase);
    this.strategyManager = new StrategyManager(knowledgeBase);
    this.performanceMonitor = new PerformanceMonitor();
  }

  /**
   * Execute a Playwright command plan
   */
  async execute(
    plan: PlaywrightCommandPlan,
    options?: {
      headless?: boolean;
      timeout?: number;
      captureScreenshots?: boolean;
      jobId?: string;
    }
  ): Promise<ExecutionResult> {
    const jobId = options?.jobId || plan.metadata?.jobId || `job-${Date.now()}`;
    const startTime = Date.now();
    let status: ExecutionStatus = 'running';
    const commandResults: ExecutionResult['commands'] = [];
    const artifacts: ExecutionResult['artifacts'] = {
      screenshots: [],
    };

    let page: Page | null = null;

    try {
      // Launch browser context
      const headless = options?.headless ?? (process.env.PLAYWRIGHT_HEADLESS === 'true');

      // Use persistent user profile if configured
      const userDataDir = process.env.PLAYWRIGHT_USER_DATA_DIR;

      const browserResult = await launchBrowser({
        headless,
        userDataDir: userDataDir || undefined,
      });

      // Handle return type: can be BrowserContext or LaunchBrowserResult
      this.context = 'context' in browserResult ? browserResult.context : browserResult;
      page = 'automationPage' in browserResult && browserResult.automationPage 
        ? browserResult.automationPage 
        : await this.context.newPage();

      // Execute commands with intelligent analysis
      for (let i = 0; i < plan.commands.length; i++) {
        const command = plan.commands[i];
        const cmdStartTime = Date.now();
        let cmdStatus: 'success' | 'failed' | 'skipped' = 'success';
        let error: string | undefined;

        try {
          // Analyze page state before command (for navigation commands)
          if (command.cmd === 'goto' && page) {
            const decision = await this.intelligenceEngine.analyzeAndDecide(page, {
              expectedUrl: command.args[0] as string,
              site: plan.metadata?.site,
              currentStep: `step-${i}`,
            });

            // Handle intelligent decision
            if (decision.action === 'wait') {
              await page.waitForTimeout(decision.waitTime || 2000);
            } else if (decision.action === 'pause' && decision.requiresHuman) {
              throw new Error(`Intelligence: ${decision.reason} - ${decision.message || ''}`);
            }
          }

          // Predict failure probability before execution
          const failurePrediction = this.intelligenceEngine.predictFailureProbability(
            [{ cmd: command.cmd, selector: command.args[0] as string }],
            plan.metadata?.site || 'unknown'
          );

          // If high failure risk, use enhanced strategies
          if (failurePrediction.failureProbability > 0.6) {
            // High failure risk - could log to console or external logger
            console.log(
              `[Executor] High failure risk detected (${(failurePrediction.failureProbability * 100).toFixed(0)}%) - using enhanced strategies`
            );
          }

          // Execute the command with performance monitoring
          const cmdStartTime = Date.now();
          await this.executeCommand(page, command, options);
          const cmdDuration = Date.now() - cmdStartTime;

          // Record performance metrics
          this.performanceMonitor.recordCommand(
            command,
            cmdDuration,
            true,
            plan.metadata?.site
          );

          if (command.args[0] && typeof command.args[0] === 'string') {
            this.performanceMonitor.recordSelector(
              command.args[0],
              'executed',
              cmdDuration,
              true,
              plan.metadata?.site
            );
          }

          // Analyze page state after command
          if (page) {
            const nextCommand = plan.commands[i + 1];
            const expectedElements = nextCommand?.args?.[0]
              ? [nextCommand.args[0] as string]
              : undefined;

            const decision = await this.intelligenceEngine.analyzeAndDecide(page, {
              site: plan.metadata?.site,
              expectedElements,
              currentStep: `step-${i}`,
            });

            // Handle intelligent decision
            if (decision.action === 'wait') {
              await page.waitForTimeout(decision.waitTime || 2000);

              // Retry analysis after wait
              if (decision.retryAfter) {
                const retryDecision = await this.intelligenceEngine.analyzeAndDecide(page, {
                  site: plan.metadata?.site,
                  expectedElements,
                });

                if (retryDecision.action === 'pause' && retryDecision.requiresHuman) {
                  throw new Error(`Intelligence: ${retryDecision.reason} - ${retryDecision.message || ''}`);
                }
              }
            } else if (decision.action === 'navigate' && decision.targetUrl) {
              // Redirected to wrong page - navigate to correct one
              await page.goto(decision.targetUrl, { waitUntil: 'load', timeout: 30000 });
            } else if (decision.action === 'navigate_back') {
              await page.goBack({ waitUntil: 'load', timeout: 30000 });
            } else if (decision.action === 'pause' && decision.requiresHuman) {
              throw new Error(`Intelligence: ${decision.reason} - ${decision.message || ''}`);
            } else if (decision.action === 'abort') {
              throw new Error(`Intelligence: ${decision.reason}`);
            }
          }

          // Capture screenshot on success if enabled
          if (options?.captureScreenshots && page) {
            const screenshotPath = `${this.screenshotsDir}/${jobId}-${commandResults.length}.png`;
            await page.screenshot({ path: screenshotPath, fullPage: false });
            artifacts.screenshots?.push(screenshotPath);
          }
        } catch (err) {
          cmdStatus = 'failed';
          error = err instanceof Error ? err.message : String(err);
          const cmdDuration = Date.now() - cmdStartTime;

          // Record failure in performance monitor
          this.performanceMonitor.recordCommand(
            command,
            cmdDuration,
            false,
            plan.metadata?.site
          );

          if (command.args[0] && typeof command.args[0] === 'string') {
            this.performanceMonitor.recordSelector(
              command.args[0],
              'executed',
              cmdDuration,
              false,
              plan.metadata?.site
            );
          }

          // Try selector healing on failure with enhanced strategies
          if (this.isSelectorError(err) && command.args[0]) {
            const healed = await this.attemptSelectorHealing(
              page,
              command,
              plan.metadata?.site
            );

            if (healed) {
              cmdStatus = 'success';
              error = undefined;
            } else {
              // Try with retry strategy if selector healing failed
              const retryStrategy = this.strategyManager.getRetryStrategy('selector', {
                site: plan.metadata?.site,
                action: command.cmd,
                previousAttempts: 1,
              });

              if (retryStrategy.maxRetries > 0) {
                const retried = await this.retryWithStrategy(
                  page,
                  command,
                  retryStrategy,
                  plan.metadata?.site
                );
                if (retried) {
                  cmdStatus = 'success';
                  error = undefined;
                }
              }

              // Capture screenshot on failure
              if (options?.captureScreenshots) {
                const screenshotPath = `${this.screenshotsDir}/${jobId}-${commandResults.length}-error.png`;
                await page.screenshot({ path: screenshotPath, fullPage: false });
                artifacts.screenshots?.push(screenshotPath);
              }
            }
          } else {
            // Try retry strategy for non-selector errors
            const errorType = this.classifyError(err);
            const retryStrategy = this.strategyManager.getRetryStrategy(errorType, {
              site: plan.metadata?.site,
              action: command.cmd,
            });

            if (retryStrategy.maxRetries > 0 && this.shouldRetry(retryStrategy, 1, err)) {
              const retried = await this.retryWithStrategy(
                page,
                command,
                retryStrategy,
                plan.metadata?.site
              );
              if (retried) {
                cmdStatus = 'success';
                error = undefined;
              }
            }

            // Capture screenshot on failure
            if (options?.captureScreenshots) {
              const screenshotPath = `${this.screenshotsDir}/${jobId}-${commandResults.length}-error.png`;
              await page.screenshot({ path: screenshotPath, fullPage: false });
              artifacts.screenshots?.push(screenshotPath);
            }
          }
        }

        commandResults.push({
          command,
          status: cmdStatus,
          duration: Date.now() - cmdStartTime,
          error,
        });

        // Stop on critical failure
        if (cmdStatus === 'failed' && this.isCriticalCommand(command)) {
          status = 'failed';
          break;
        }
      }

      // Determine final status
      if (status === 'running') {
        const hasFailures = commandResults.some(r => r.status === 'failed');
        status = hasFailures ? 'failed' : 'success';
      }

    } catch (err) {
      status = 'failed';
      return {
        status,
        jobId,
        startTime,
        endTime: Date.now(),
        duration: Date.now() - startTime,
        commands: commandResults,
        artifacts,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      if (page) {
        await page.close();
      }
      if (this.context) {
        await this.context.close();
        this.context = null;
      }
    }

    const endTime = Date.now();

    return {
      status,
      jobId,
      startTime,
      endTime,
      duration: endTime - startTime,
      commands: commandResults,
      artifacts,
      metrics: {
        selectorHealingAttempts: commandResults.filter(
          r => r.error?.includes('selector')
        ).length,
      },
    };
  }

  /**
   * Execute a single Playwright command
   */
  private async executeCommand(
    page: Page,
    command: PlaywrightCommand,
    options?: { timeout?: number }
  ): Promise<void> {
    const timeout = command.options?.timeout || options?.timeout || 30000;

    switch (command.cmd) {
      case 'goto': {
        const targetUrl = command.args[0] as string;
        // Use 'networkidle' by default to ensure JavaScript and CSS are fully loaded
        await page.goto(targetUrl, {
          timeout,
          waitUntil: command.options?.waitUntil || 'networkidle',
        });
        break;
      }

      case 'fill':
        // Add human-like delay before filling
        await humanDelay(300, 800);
        await page.fill(command.args[0] as string, command.args[1] as string, {
          timeout,
        });
        // Add delay after filling to simulate human behavior
        await humanDelay(200, 500);
        break;

      case 'click':
        // Add human-like delay before clicking
        await humanDelay(200, 600);
        await page.click(command.args[0] as string, { timeout });
        // Add delay after clicking to simulate human behavior
        await humanDelay(300, 800);
        break;

      case 'waitFor':
        if (command.args[0]) {
          await page.waitForSelector(command.args[0] as string, { timeout });
        } else {
          // Delay
          await page.waitForTimeout(timeout);
        }
        break;

      case 'select':
        await page.selectOption(command.args[0] as string, command.args[1] as string, {
          timeout,
        });
        break;

      case 'press':
        await page.press(command.args[0] as string || 'body', command.args[1] as string, {
          timeout,
        });
        break;

      case 'hover':
        await page.hover(command.args[0] as string, { timeout });
        break;

      case 'scroll':
        await page.evaluate(() => {
          window.scrollBy(0, window.innerHeight);
        });
        break;

      case 'screenshot':
        await page.screenshot({
          path: command.args[0] as string,
          fullPage: command.args[1] as boolean || false,
        });
        break;

      default:
        throw new Error(`Unknown command: ${command.cmd}`);
    }
  }

  /**
   * Attempt selector healing on failure with enhanced strategies
   */
  private async attemptSelectorHealing(
    page: Page,
    command: PlaywrightCommand,
    site?: string
  ): Promise<boolean> {
    if (!command.args[0] || typeof command.args[0] !== 'string') {
      return false;
    }

    const brokenSelector = command.args[0];
    const startTime = Date.now();

    try {
      // Get element context for enhanced healing
      const elementContext = await this.getElementContext(page, brokenSelector);

      // Use enhanced healer
      const candidates = await this.selectorHealer.healSelector(
        brokenSelector,
        page,
        {
          site,
          elementText: elementContext?.text,
          elementAttributes: elementContext?.attributes,
          elementType: elementContext?.type,
        }
      );

      // Try candidates in order (top 5)
      for (const candidate of candidates.slice(0, 5)) {
        try {
          await this.executeCommand(page, {
            ...command,
            args: [candidate.selector, ...command.args.slice(1)],
          });

          // Record success
          const duration = Date.now() - startTime;
          if (site) {
            this.selectorHealer.recordSuccess(
              site,
              candidate.selector,
              candidate.strategy as any
            );

            // Record strategy performance
            this.strategyManager.recordStrategyResult('selector', `heal-${candidate.strategy}`, {
              site,
              success: true,
              duration,
            });
          }

          return true;
        } catch (healError) {
          // Try next candidate
          continue;
        }
      }

      // Record failure
      if (site) {
        const duration = Date.now() - startTime;
        this.strategyManager.recordStrategyResult('selector', 'heal-failed', {
          site,
          success: false,
          duration,
        });
      }

      return false;
    } catch (error) {
      console.warn('Error during selector healing:', error);
      return false;
    }
  }

  /**
   * Get element context for enhanced healing
   */
  private async getElementContext(
    page: Page,
    selector: string
  ): Promise<{ text?: string; attributes?: Record<string, string>; type?: string } | null> {
    try {
      // Try to find element by broken selector first
      const element = await page.$(selector).catch(() => null);
      if (!element) {
        // Try to find similar elements
        const tagMatch = selector.match(/^(\w+)/);
        if (tagMatch) {
          const elements = await page.$$(tagMatch[1]).catch(() => []);
          if (elements.length > 0) {
            const firstElement = elements[0];
            const text = await firstElement.textContent().catch(() => null);
            const attributes = await firstElement.evaluate((el) => {
              const attrs: Record<string, string> = {};
              for (const attr of el.attributes) {
                attrs[attr.name] = attr.value;
              }
              return attrs;
            }).catch(() => ({}));
            const tagName = await firstElement.evaluate((el) => el.tagName.toLowerCase()).catch(() => undefined);

            return {
              text: text || undefined,
              attributes,
              type: tagName,
            };
          }
        }
        return null;
      }

      const text = await element.textContent().catch(() => null);
      const attributes = await element.evaluate((el) => {
        const attrs: Record<string, string> = {};
        for (const attr of el.attributes) {
          attrs[attr.name] = attr.value;
        }
        return attrs;
      }).catch(() => ({}));
      const tagName = await element.evaluate((el) => el.tagName.toLowerCase()).catch(() => undefined);

      return {
        text: text || undefined,
        attributes,
        type: tagName,
      };
    } catch {
      return null;
    }
  }

  /**
   * Retry command with adaptive retry strategy
   */
  private async retryWithStrategy(
    page: Page,
    command: PlaywrightCommand,
    strategy: any,
    site?: string
  ): Promise<boolean> {
    const retryManager = this.strategyManager.getRetryStrategyManager();
    let attemptNumber = 1;

    while (retryManager.shouldRetry(strategy, attemptNumber)) {
      const delay = retryManager.calculateDelay(strategy, attemptNumber);
      if (delay > 0) {
        await page.waitForTimeout(delay);
      }

      const startTime = Date.now();
      try {
        await this.executeCommand(page, command);
        const duration = Date.now() - startTime;

        // Record success
        retryManager.recordRetryResult(strategy, {
          site,
          action: command.cmd,
          attemptNumber,
          success: true,
          duration,
        });

        return true;
      } catch (error) {
        const duration = Date.now() - startTime;
        attemptNumber++;

        // Record failure
        retryManager.recordRetryResult(strategy, {
          site,
          action: command.cmd,
          attemptNumber: attemptNumber - 1,
          success: false,
          duration,
        });

        if (!retryManager.shouldRetry(strategy, attemptNumber, error as Error)) {
          return false;
        }
      }
    }

    return false;
  }

  /**
   * Classify error type for retry strategy
   */
  private classifyError(err: unknown): 'network' | 'selector' | 'timeout' | '403' | '500' | 'other' {
    if (!(err instanceof Error)) return 'other';

    const message = err.message.toLowerCase();

    if (message.includes('timeout') || message.includes('timed out')) {
      return 'timeout';
    }
    if (message.includes('selector') || message.includes('element') || message.includes('not found')) {
      return 'selector';
    }
    if (message.includes('network') || message.includes('connection')) {
      return 'network';
    }
    if (message.includes('403') || message.includes('forbidden')) {
      return '403';
    }
    if (message.includes('500') || message.includes('server error')) {
      return '500';
    }

    return 'other';
  }

  /**
   * Check if should retry based on strategy
   */
  private shouldRetry(strategy: any, attemptNumber: number, error?: Error): boolean {
    const retryManager = this.strategyManager.getRetryStrategyManager();
    return retryManager.shouldRetry(strategy, attemptNumber, error);
  }

  /**
   * Check if error is selector-related
   */
  private isSelectorError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const message = err.message.toLowerCase();
    return (
      message.includes('selector') ||
      message.includes('element') ||
      message.includes('not found') ||
      message.includes('timeout')
    );
  }

  /**
   * Check if command is critical (should stop on failure)
   */
  private isCriticalCommand(command: PlaywrightCommand): boolean {
    return ['goto', 'click', 'fill'].includes(command.cmd);
  }
}




