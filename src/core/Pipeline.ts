import { Preprocessor } from './Preprocessor.js';
import { IntentExtractor } from './IntentExtractor.js';
import { SkillGenerator } from './SkillGenerator.js';
import { PlaywrightGenerator } from './PlaywrightGenerator.js';
import { Executor } from './Executor.js';
import { JobManager } from './JobManager.js';
import { KnowledgeBase } from './KnowledgeBase.js';
import { PatternLearningEngine } from './PatternLearningEngine.js';

/**
 * Automation Pipeline: Orchestrates the entire flow from Recorder JSON to execution
 */
export class AutomationPipeline {
  private preprocessor: Preprocessor;
  private intentExtractor: IntentExtractor;
  private skillGenerator: SkillGenerator;
  private playwrightGenerator: PlaywrightGenerator;
  private executor: Executor;
  private jobManager: JobManager;
  private knowledgeBase: KnowledgeBase;
  private patternLearningEngine: PatternLearningEngine;

  constructor(jobManager?: JobManager, knowledgeBase?: KnowledgeBase) {
    this.preprocessor = new Preprocessor();
    this.intentExtractor = new IntentExtractor();
    this.knowledgeBase = knowledgeBase || new KnowledgeBase();
    this.skillGenerator = new SkillGenerator(this.knowledgeBase);
    this.playwrightGenerator = new PlaywrightGenerator(this.knowledgeBase);
    this.executor = new Executor(this.knowledgeBase);
    this.jobManager = jobManager || new JobManager();
    this.patternLearningEngine = new PatternLearningEngine(this.knowledgeBase);
  }

  /**
   * Process a job through the entire pipeline
   */
  async processJob(jobId: string): Promise<void> {
    const job = this.jobManager.getJob(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }

    try {
      this.jobManager.updateJobStatus(jobId, 'running');

      // Step 1: Preprocess
      this.jobManager.addLog(jobId, 'Preprocessing recorder JSON...');
      const normalized = this.preprocessor.normalize(job.recorderJSON);
      const metadata = this.preprocessor.extractMetadata(normalized);

      // Step 2: Extract intents
      this.jobManager.addLog(jobId, 'Extracting intents...');
      const actions = await this.intentExtractor.extractIntents(normalized, false);

      // Step 3: Generate skills
      this.jobManager.addLog(jobId, 'Generating skills...');
      await Promise.all(
        actions.map(action => this.skillGenerator.generateSkill(action, false))
      );

      // Step 4: Generate Playwright plan
      this.jobManager.addLog(jobId, 'Generating Playwright commands...');
      const plans = await Promise.all(
        actions.map(action =>
          this.playwrightGenerator.generatePlan(action, {
            site: metadata.site,
          })
        )
      );

      // Step 5: Execute
      this.jobManager.addLog(jobId, 'Executing automation...');
      // Use env variable for headless mode, default to true for pipeline jobs
      const headless = process.env.PLAYWRIGHT_HEADLESS === 'true';
      const results = await Promise.all(
        plans.map(plan =>
          this.executor.execute(plan, {
            headless,
            captureScreenshots: true,
            jobId,
          })
        )
      );

      // Combine results
      const combinedResult = this.combineResults(results);

      // Update job
      this.jobManager.updateJobResult(jobId, combinedResult);
      this.jobManager.updateJobStatus(
        jobId,
        combinedResult.status === 'success' ? 'success' : 'failed'
      );

      // Learn from this job - update knowledge base
      this.jobManager.addLog(jobId, 'Learning from job patterns...');
      const site = metadata.site || 'unknown';
      this.knowledgeBase.learnFromJob(site, actions, combinedResult, normalized);
      
      // Extract patterns for advanced learning
      await this.patternLearningEngine.extractPatterns(site, actions, combinedResult);

      this.jobManager.addLog(jobId, `Job completed with status: ${combinedResult.status}`);
    } catch (error) {
      this.jobManager.addLog(
        jobId,
        `Error: ${error instanceof Error ? error.message : String(error)}`
      );
      this.jobManager.updateJobStatus(
        jobId,
        'failed',
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  }

  /**
   * Combine multiple execution results into one
   */
  private combineResults(
    results: Array<import('../types/index.js').ExecutionResult>
  ): import('../types/index.js').ExecutionResult {
    if (results.length === 0) {
      throw new Error('No results to combine');
    }

    if (results.length === 1) {
      return results[0];
    }

    // Combine all commands
    const allCommands = results.flatMap(r => r.commands);
    const hasFailures = results.some(r => r.status === 'failed');
    const allArtifacts = results
      .map(r => r.artifacts)
      .filter(Boolean)
      .reduce(
        (acc, artifacts) => {
          if (artifacts?.screenshots) {
            acc.screenshots = [...(acc.screenshots || []), ...artifacts.screenshots];
          }
          return acc;
        },
        { screenshots: [] } as { screenshots: string[] }
      );

    return {
      status: hasFailures ? 'failed' : 'success',
      jobId: results[0].jobId,
      startTime: Math.min(...results.map(r => r.startTime)),
      endTime: Math.max(...results.map(r => r.endTime || Date.now())),
      duration: results.reduce((sum, r) => sum + (r.duration || 0), 0),
      commands: allCommands,
      artifacts: allArtifacts,
      metrics: {
        selectorHealingAttempts: results.reduce(
          (sum, r) => sum + (r.metrics?.selectorHealingAttempts || 0),
          0
        ),
        selectorHealingSuccesses: results.reduce(
          (sum, r) => sum + (r.metrics?.selectorHealingSuccesses || 0),
          0
        ),
      },
    };
  }
}

