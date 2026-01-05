import type {
  CanonicalAction,
  PlaywrightCommand,
  PlaywrightCommandPlan,
  Target,
} from '../types/index.js';
import type { KnowledgeBase } from './KnowledgeBase.js';

/**
 * Playwright Command Generator: Translates canonical actions into Playwright commands
 * Note: Selector healing is now handled during execution in Executor where Page object is available
 */
export class PlaywrightGenerator {
  constructor(_knowledgeBase?: KnowledgeBase) {
    // Selector healing moved to Executor where Page object is available
  }

  /**
   * Generate Playwright command plan from canonical action
   * Note: Selector healing is handled during execution in Executor
   */
  async generatePlan(
    action: CanonicalAction,
    _options?: {
      healSelectors?: boolean;
      site?: string;
    }
  ): Promise<PlaywrightCommandPlan> {
    const commands: PlaywrightCommand[] = [];

    for (const step of action.steps) {
      const playwrightCmd = await this.convertStepToPlaywright(step);

      if (playwrightCmd) {
        commands.push(playwrightCmd);
      }
    }

    return {
      type: 'playwright',
      commands,
      metadata: {
        site: action.metadata.site,
        intent: action.intent,
      },
    };
  }

  /**
   * Convert canonical step to Playwright command
   */
  private async convertStepToPlaywright(
    step: CanonicalAction['steps'][0]
  ): Promise<PlaywrightCommand | null> {
    switch (step.action) {
      case 'navigate':
        return {
          cmd: 'goto',
          args: [step.value || ''],
          options: {
            timeout: step.timeout || 30000,
            waitUntil: 'load',
          },
        };

      case 'fill': {
        const fillSelector = await this.resolveSelector(step.target);
        if (!fillSelector) return null;

        return {
          cmd: 'fill',
          args: [fillSelector, step.value || ''],
          options: {
            timeout: step.timeout || 10000,
          },
        };
      }

      case 'click': {
        const clickSelector = await this.resolveSelector(step.target);
        if (!clickSelector) return null;

        return {
          cmd: 'click',
          args: [clickSelector],
          options: {
            timeout: step.timeout || 10000,
          },
        };
      }

      case 'waitFor': {
        // Allow selector waits or plain timeouts (no selector)
        const waitSelector = step.target
          ? await this.resolveSelector(step.target)
          : undefined;

        return {
          cmd: 'waitFor',
          args: waitSelector ? [waitSelector] : [],
          options: {
            timeout: step.timeout || 10000,
          },
        };
      }

      case 'select': {
        const selectSelector = await this.resolveSelector(step.target);
        if (!selectSelector) return null;

        return {
          cmd: 'select',
          args: [selectSelector, step.value || ''],
          options: {
            timeout: step.timeout || 10000,
          },
        };
      }

      case 'press': {
        const pressSelector = step.target
          ? await this.resolveSelector(step.target)
          : 'body';
        return {
          cmd: 'press',
          args: [pressSelector, step.value || 'Enter'],
          options: {
            timeout: step.timeout || 5000,
          },
        };
      }

      case 'hover': {
        const hoverSelector = await this.resolveSelector(step.target);
        if (!hoverSelector) return null;

        return {
          cmd: 'hover',
          args: [hoverSelector],
          options: {
            timeout: step.timeout || 10000,
          },
        };
      }

      case 'scroll':
        return {
          cmd: 'scroll',
          args: [],
          options: {
            ...step.options,
          },
        };

      case 'assert':
        // Assertions are handled separately in executor
        return null;

      default:
        // Handle custom actions (delays, conditionals, etc.)
        if (step.options?.delay) {
          // Convert delay to wait
          return {
            cmd: 'waitFor',
            args: [],
            options: {
              timeout: step.options.delay as number,
            },
          };
        }
        return null;
    }
  }

  /**
   * Resolve selector from target
   * Note: Enhanced healing requires a Page object, so it's done during execution in Executor
   * This method just converts the target to a selector string
   */
  private async resolveSelector(
    target: Target | undefined
  ): Promise<string | null> {
    if (!target) return null;

    // Convert target to Playwright selector string
    // Enhanced healing happens during execution when we have access to the Page object
    return this.targetToSelector(target);
  }

  /**
   * Convert target to Playwright selector string
   */
  private targetToSelector(target: Target): string {
    switch (target.strategy) {
      case 'css':
        return target.selector || '';
      
      case 'xpath':
        return `xpath=${target.selector || ''}`;
      
      case 'text':
        return `text=${target.value || target.selector || ''}`;
      
      case 'role':
        return `role=${target.value || target.selector || ''}`;
      
      case 'testId':
        return `[data-testid="${target.value || target.selector || ''}"]`;
      
      case 'label':
        return `label=${target.value || target.selector || ''}`;
      
      default:
        return target.selector || '';
    }
  }
}

