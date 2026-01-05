/**
 * Basic usage example for the AI Web Automation system
 */

import { AutomationPipeline } from '../core/Pipeline.js';
import { JobManager } from '../core/JobManager.js';
import type { ChromeRecorderJSON } from '../types/index.js';

async function main() {
  // Initialize components
  const pipeline = new AutomationPipeline();
  const jobManager = new JobManager();

  // Example Chrome Recorder JSON
  const recorderJSON: ChromeRecorderJSON = {
    title: 'Example Login Flow',
    url: 'https://example.com/login',
    steps: [
      {
        type: 'navigate',
        url: 'https://example.com/login',
        timestamp: 1000,
      },
      {
        type: 'input',
        selector: "input[name='email']",
        value: 'user@example.com',
        timestamp: 2000,
      },
      {
        type: 'input',
        selector: "input[type='password']",
        value: 'password123',
        timestamp: 3000,
      },
      {
        type: 'click',
        selector: "button[type='submit']",
        text: 'Sign in',
        timestamp: 4000,
      },
      {
        type: 'waitForSelector',
        selector: '#dashboard',
        timestamp: 5000,
      },
    ],
    metadata: {
      source: 'chrome-recorder',
      version: '1.0',
    },
  };

  try {
    console.log('Creating job...');
    const jobId = await jobManager.createJob(recorderJSON, {
      debug: true,
    });

    console.log(`Job created: ${jobId}`);
    console.log('Processing job...');

    // Process the job
    await pipeline.processJob(jobId);

    // Get results
    const job = jobManager.getJob(jobId);
    if (job?.result) {
      console.log('\n=== Execution Results ===');
      console.log(`Status: ${job.result.status}`);
      console.log(`Duration: ${job.result.duration}ms`);
      console.log(`Commands executed: ${job.result.commands.length}`);
      console.log(
        `Successful: ${job.result.commands.filter(c => c.status === 'success').length}`
      );
      console.log(
        `Failed: ${job.result.commands.filter(c => c.status === 'failed').length}`
      );

      if (job.result.metrics) {
        console.log('\n=== Metrics ===');
        console.log(
          `Selector healing attempts: ${job.result.metrics.selectorHealingAttempts || 0}`
        );
        console.log(
          `Selector healing successes: ${job.result.metrics.selectorHealingSuccesses || 0}`
        );
      }

      if (job.result.artifacts?.screenshots) {
        console.log(`\nScreenshots captured: ${job.result.artifacts.screenshots.length}`);
      }
    }

    // Get logs
    const logs = jobManager.getLogs(jobId);
    console.log('\n=== Logs ===');
    logs.forEach(log => console.log(log));
  } catch (error) {
    console.error('Error:', error);
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

