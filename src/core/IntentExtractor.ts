import type { ChromeRecorderJSON, ChromeRecorderStep, CanonicalAction } from '../types/index.js';
import { Preprocessor } from './Preprocessor.js';

/**
 * Intent Extractor: Converts low-level steps into higher-level intents
 */
export class IntentExtractor {
  private preprocessor: Preprocessor;

  constructor() {
    this.preprocessor = new Preprocessor();
  }

  /**
   * Extract intents from recorder JSON
   */
  async extractIntents(
    recorderJSON: ChromeRecorderJSON,
    useLLM: boolean = false
  ): Promise<CanonicalAction[]> {
    // Chunk steps into meaningful groups
    const chunks = this.chunkSteps(recorderJSON.steps);
    
    // Extract intent for each chunk
    const actions: CanonicalAction[] = [];
    
    for (const chunk of chunks) {
      const intent = useLLM
        ? await this.extractIntentWithLLM(chunk)
        : this.extractIntentWithPatterns(chunk);
      
      actions.push({
        intent,
        steps: this.convertStepsToCanonical(chunk),
        metadata: {
          source: recorderJSON.metadata?.source || 'recorder-v1',
          site: this.preprocessor.extractMetadata(recorderJSON).site,
          confidence: useLLM ? 0.9 : 0.7,
        },
      });
    }

    return actions;
  }

  /**
   * Chunk steps into meaningful groups
   */
  private chunkSteps(steps: ChromeRecorderStep[]): ChromeRecorderStep[][] {
    const chunks: ChromeRecorderStep[][] = [];
    let currentChunk: ChromeRecorderStep[] = [];

    for (const step of steps) {
      // Start new chunk on navigation
      if (step.type === 'navigate' && currentChunk.length > 0) {
        chunks.push(currentChunk);
        currentChunk = [step];
        continue;
      }

      currentChunk.push(step);

      // End chunk after assertion or significant action
      if (step.type === 'assert' || (step.type === 'click' && this.isSubmitButton(step))) {
        chunks.push(currentChunk);
        currentChunk = [];
      }
    }

    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
    }

    return chunks;
  }

  /**
   * Extract intent using pattern matching (fast, no LLM)
   */
  private extractIntentWithPatterns(steps: ChromeRecorderStep[]): string {
    const hasInput = steps.some(s => s.type === 'input' || s.value);
    const hasClick = steps.some(s => s.type === 'click');
    const hasNavigation = steps.some(s => s.type === 'navigate');
    const hasAssertion = steps.some(s => s.type === 'assert');

    // Pattern: Login flow
    if (hasInput && hasClick && this.containsPasswordField(steps)) {
      return 'submit-login';
    }

    // Pattern: Form submission
    if (hasInput && hasClick && this.isSubmitButton(steps[steps.length - 1])) {
      return 'submit-form';
    }

    // Pattern: Search
    if (hasInput && hasClick && this.isSearchField(steps)) {
      return 'search';
    }

    // Pattern: Navigation
    if (hasNavigation && steps.length === 1) {
      return 'navigate';
    }

    // Pattern: Scraping/list extraction
    if (hasAssertion && !hasInput) {
      return 'scrape-list';
    }

    // Pattern: Post/comment
    if (hasInput && hasClick && this.isTextArea(steps)) {
      return 'post-message';
    }

    // Default
    return 'generic-action';
  }

  /**
   * Extract intent using LLM (placeholder - would integrate with OpenAI/Ollama)
   */
  private async extractIntentWithLLM(steps: ChromeRecorderStep[]): Promise<string> {
    // TODO: Implement LLM-based intent extraction
    // This would use OpenAI API or local LLM to classify the intent
    // For now, fallback to pattern matching
    return this.extractIntentWithPatterns(steps);
  }

  /**
   * Convert recorder steps to canonical steps
   */
  private convertStepsToCanonical(steps: ChromeRecorderStep[]): CanonicalAction['steps'] {
    return steps.map(step => {
      switch (step.type) {
        case 'navigate':
          return {
            action: 'navigate',
            value: step.url,
            timeout: 30000,
          };
        
        case 'input':
        case 'change':
          return {
            action: 'fill',
            target: step.selector
              ? {
                  selector: step.selector,
                  strategy: 'css',
                }
              : undefined,
            value: step.value || step.text,
          };
        
        case 'click':
          // Prefer selector if available
          if (step.selector) {
            return {
              action: 'click',
              target: {
                selector: step.selector,
                strategy: 'css',
              },
            };
          }
          // Fallback to text only if we have actual text (not "main" or other invalid values)
          if (step.text && step.text !== 'main' && step.text.trim().length > 0) {
            return {
              action: 'click',
              target: {
                strategy: 'text',
                value: step.text,
              },
            };
          }
          // If no valid selector or text, return click without target (will be handled by fallback)
          return {
            action: 'click',
            target: undefined,
          };
        
        case 'waitForSelector':
          return {
            action: 'waitFor',
            target: step.selector
              ? {
                  selector: step.selector,
                  strategy: 'css',
                }
              : undefined,
            timeout: 10000,
          };

        // Explicit waits/timeouts from recorder
        case 'waitForTimeout':
        case 'wait':
        case 'pause':
          {
            const waitStep = step as { timeout?: number };
            const timeout = typeof waitStep.timeout === 'number' ? waitStep.timeout : 2000;
            return {
              action: 'waitFor',
              // No selector; executor will treat this as a sleep
              timeout,
            };
          }
        
        case 'assert':
          return {
            action: 'assert',
            target: step.selector
              ? {
                  selector: step.selector,
                  strategy: 'css',
                }
              : undefined,
            value: step.text,
          };
        
        case 'scroll':
          return {
            action: 'scroll',
            options: {
              x: step.offsetX || 0,
              y: step.offsetY || 0,
            },
          };
        
        default:
          return {
            action: 'click',
            target: step.selector
              ? {
                  selector: step.selector,
                  strategy: 'css',
                }
              : undefined,
          };
      }
    });
  }

  // Helper methods for pattern detection
  private containsPasswordField(steps: ChromeRecorderStep[]): boolean {
    return steps.some(
      s =>
        (s.selector?.toLowerCase().includes('password') ||
          s.selector?.toLowerCase().includes('pwd')) &&
        (s.type === 'input' || s.value)
    );
  }

  private isSubmitButton(step: ChromeRecorderStep): boolean {
    if (!step.selector) return false;
    const sel = step.selector.toLowerCase();
    const text = step.text?.toLowerCase() || '';
    return (
      sel.includes('submit') ||
      sel.includes('button[type="submit"]') ||
      text.includes('submit') ||
      text.includes('sign in') ||
      text.includes('login')
    );
  }

  private isSearchField(steps: ChromeRecorderStep[]): boolean {
    return steps.some(
      s =>
        s.selector?.toLowerCase().includes('search') ||
        s.selector?.toLowerCase().includes('query')
    );
  }

  private isTextArea(steps: ChromeRecorderStep[]): boolean {
    return steps.some(s => s.selector?.toLowerCase().includes('textarea'));
  }
}

