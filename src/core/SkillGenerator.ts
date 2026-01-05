import type { CanonicalAction, SkillSpec } from '../types/index.js';
import { IntelligenceEngine } from './IntelligenceEngine.js';
import type { KnowledgeBase } from './KnowledgeBase.js';

/**
 * Skill Generator: Produces structured, platform-agnostic action plans using LLM
 */
export class SkillGenerator {
  private intelligenceEngine: IntelligenceEngine;
  private knowledgeBase?: KnowledgeBase;

  constructor(knowledgeBase?: KnowledgeBase) {
    this.intelligenceEngine = new IntelligenceEngine(knowledgeBase);
    this.knowledgeBase = knowledgeBase;
  }

  /**
   * Generate skill spec from canonical action
   */
  async generateSkill(
    action: CanonicalAction,
    useLLM: boolean = false
  ): Promise<SkillSpec> {
    // Check if we have a learned template for this intent
    if (this.knowledgeBase) {
      const template = await this.knowledgeBase.getSkillTemplate(action.intent);
      if (template && template.successRate > 0.7) {
        // Use learned template if it has good success rate
        return {
          ...template.skillSpec,
          steps: action.steps, // Use current steps but keep learned retry/safety policies
        };
      }
    }

    // Enhance action with logic (pre-execution enhancement)
    const enhanced = this.intelligenceEngine.enhanceAction(action);

    if (useLLM) {
      return await this.generateSkillWithLLM(enhanced);
    }

    return this.generateSkillFromPatterns(enhanced);
  }

  /**
   * Generate skill using LLM (placeholder)
   */
  private async generateSkillWithLLM(action: CanonicalAction): Promise<SkillSpec> {
    // TODO: Implement LLM-based skill generation
    // This would use OpenAI API or local LLM to generate comprehensive skill specs
    // For now, fallback to pattern-based generation
    return this.generateSkillFromPatterns(action);
  }

  /**
   * Generate skill from patterns (fast, no LLM)
   */
  private generateSkillFromPatterns(action: CanonicalAction): SkillSpec {
    // Infer inputs/outputs from action
    const inputs = this.inferInputs(action);
    const outputs = this.inferOutputs(action);

    // Determine retry policy based on intent
    const retryPolicy = this.determineRetryPolicy(action.intent);

    // Determine safety checks
    const safetyChecks = this.determineSafetyChecks(action.intent);

    // Determine rate limits
    const rateLimit = this.determineRateLimit(action.intent);

    return {
      name: action.intent,
      description: `Automated ${action.intent} skill`,
      inputs,
      outputs,
      steps: action.steps,
      retryPolicy,
      safetyChecks,
      rateLimit,
    };
  }

  /**
   * Infer required inputs from action
   */
  private inferInputs(action: CanonicalAction): SkillSpec['inputs'] {
    const inputs: SkillSpec['inputs'] = [];

    // Check for common input patterns
    for (const step of action.steps) {
      if (step.action === 'fill' && step.value) {
        // Check if value is a template variable
        if (step.value.includes('{{') && step.value.includes('}}')) {
          const varName = step.value.match(/{{(\w+)}}/)?.[1];
          if (varName && !inputs.find(i => i.name === varName)) {
            inputs.push({
              name: varName,
              type: 'string',
              required: true,
              description: `Value for ${step.target?.selector || 'field'}`,
            });
          }
        }
      }
    }

    // Add default inputs for common intents
    if (action.intent === 'submit-login') {
      if (!inputs.find(i => i.name === 'email')) {
        inputs.push({
          name: 'email',
          type: 'string',
          required: true,
          description: 'User email address',
        });
      }
      if (!inputs.find(i => i.name === 'password')) {
        inputs.push({
          name: 'password',
          type: 'string',
          required: true,
          description: 'User password',
        });
      }
    }

    return inputs;
  }

  /**
   * Infer outputs from action
   */
  private inferOutputs(action: CanonicalAction): SkillSpec['outputs'] {
    const outputs: SkillSpec['outputs'] = [];

    // Common outputs based on intent
    if (action.intent === 'submit-login') {
      outputs.push({
        name: 'success',
        type: 'boolean',
        description: 'Whether login was successful',
      });
      outputs.push({
        name: 'session',
        type: 'object',
        description: 'Session information if login successful',
      });
    } else if (action.intent === 'search') {
      outputs.push({
        name: 'results',
        type: 'array',
        description: 'Search results',
      });
    } else if (action.intent === 'scrape-list') {
      outputs.push({
        name: 'items',
        type: 'array',
        description: 'Scraped list items',
      });
    } else {
      outputs.push({
        name: 'success',
        type: 'boolean',
        description: 'Whether action completed successfully',
      });
    }

    return outputs;
  }

  /**
   * Determine retry policy based on intent
   */
  private determineRetryPolicy(intent: string): SkillSpec['retryPolicy'] {
    // More critical actions get more retries
    if (intent === 'submit-login' || intent === 'navigate') {
      return {
        maxRetries: 3,
        backoff: 'exponential',
        baseDelay: 1000,
      };
    }

    return {
      maxRetries: 2,
      backoff: 'linear',
      baseDelay: 500,
    };
  }

  /**
   * Determine safety checks based on intent
   */
  private determineSafetyChecks(intent: string): string[] {
    const checks: string[] = [];

    if (intent === 'submit-login') {
      checks.push('verify-login-success');
      checks.push('check-for-captcha');
      checks.push('rate-limit-check');
    } else if (intent === 'post-message') {
      checks.push('verify-post-success');
      checks.push('check-for-moderation');
      checks.push('rate-limit-check');
    } else {
      checks.push('verify-action-completion');
    }

    return checks;
  }

  /**
   * Determine rate limits based on intent
   */
  private determineRateLimit(intent: string): SkillSpec['rateLimit'] | undefined {
    if (intent === 'submit-login' || intent === 'post-message') {
      return {
        perHost: 5,
        global: 10,
        windowMs: 60000, // 1 minute
      };
    }

    if (intent === 'search' || intent === 'scrape-list') {
      return {
        perHost: 10,
        global: 20,
        windowMs: 60000,
      };
    }

    return undefined;
  }
}

