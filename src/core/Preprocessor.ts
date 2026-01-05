import type { ChromeRecorderJSON, ChromeRecorderStep } from '../types/index.js';

/**
 * Preprocessor: Normalizes Chrome Recorder JSON and extracts metadata
 */
export class Preprocessor {
  /**
   * Normalize and validate Chrome Recorder JSON
   */
  normalize(recorderJSON: unknown): ChromeRecorderJSON {
    if (!recorderJSON || typeof recorderJSON !== 'object') {
      throw new Error('Invalid recorder JSON: must be an object');
    }

    const json = recorderJSON as Record<string, unknown>;
    
    // Ensure steps array exists
    if (!Array.isArray(json.steps)) {
      throw new Error('Invalid recorder JSON: steps must be an array');
    }

    const metadata = json.metadata && typeof json.metadata === 'object' 
      ? json.metadata as Record<string, unknown>
      : {};

    const normalized: ChromeRecorderJSON = {
      title: typeof json.title === 'string' ? json.title : undefined,
      steps: this.normalizeSteps(json.steps),
      url: typeof json.url === 'string' ? json.url : undefined,
      metadata: {
        source: typeof metadata.source === 'string' 
          ? metadata.source 
          : 'recorder-v1',
        version: typeof metadata.version === 'string' 
          ? metadata.version 
          : '1.0',
      },
    };

    return normalized;
  }

  /**
   * Normalize individual steps
   */
  private normalizeSteps(steps: unknown[]): ChromeRecorderStep[] {
    return steps.map((step, index) => {
      if (!step || typeof step !== 'object') {
        throw new Error(`Invalid step at index ${index}: must be an object`);
      }

      const s = step as Record<string, unknown>;
      
      // Normalize step type
      const type = this.normalizeStepType(s.type, s);
      
      const normalized: ChromeRecorderStep = {
        type,
        timestamp: typeof s.timestamp === 'number' ? s.timestamp : Date.now() + index,
      };

      // Add optional fields
      // Handle Chrome Recorder's selectors array (array of arrays)
      // Prefer CSS selectors over aria selectors
      if (Array.isArray(s.selectors) && s.selectors.length > 0) {
        // Try to find a CSS selector first (not aria/)
        let foundSelector = false;
        for (const selectorArray of s.selectors) {
          if (Array.isArray(selectorArray) && selectorArray.length > 0) {
            const selector = String(selectorArray[0]);
            // Prefer CSS selectors (starting with #, ., or valid CSS)
            if (!selector.startsWith('aria/') && !selector.startsWith('xpath/') && !selector.startsWith('pierce/')) {
              normalized.selector = selector;
              foundSelector = true;
              break;
            }
          }
        }
        // If no CSS selector found, use the first one (even if aria)
        if (!foundSelector) {
          const firstSelectorArray = s.selectors[0];
          if (Array.isArray(firstSelectorArray) && firstSelectorArray.length > 0) {
            normalized.selector = String(firstSelectorArray[0]);
          }
        }
      } else if (typeof s.selector === 'string') {
        normalized.selector = s.selector;
      }
      if (typeof s.text === 'string') {
        normalized.text = s.text;
      }
      if (typeof s.value === 'string') {
        normalized.value = s.value;
      }
      if (typeof s.url === 'string') {
        normalized.url = s.url;
      }
      if (typeof s.frame === 'string') {
        normalized.frame = s.frame;
      }
      if (typeof s.target === 'string') {
        normalized.target = s.target;
      }
      if (typeof s.key === 'string') {
        normalized.key = s.key;
      }
      if (typeof s.offsetX === 'number') {
        normalized.offsetX = s.offsetX;
      }
      if (typeof s.offsetY === 'number') {
        normalized.offsetY = s.offsetY;
      }
      
      // Scraping fields (for scrape step type)
      if (typeof s.dataKey === 'string') {
        normalized.dataKey = s.dataKey;
      }
      if (typeof s.attribute === 'string') {
        normalized.attribute = s.attribute;
      }
      if (typeof s.multiple === 'boolean') {
        normalized.multiple = s.multiple;
      }
      if (Array.isArray(s.structure)) {
        normalized.structure = s.structure;
      }
      if (typeof s.containerSelector === 'string') {
        normalized.containerSelector = s.containerSelector;
      }

      return normalized;
    });
  }

  /**
   * Normalize step type, handling variations
   */
  private normalizeStepType(
    type: unknown,
    step: Record<string, unknown>
  ): ChromeRecorderStep['type'] {
    if (typeof type === 'string') {
      const normalized = type.toLowerCase();
      const validTypes: ChromeRecorderStep['type'][] = [
        'click',
        'input',
        'navigate',
        'waitForSelector',
        'waitForTimeout',
        'wait',
        'pause',
        'assert',
        'scroll',
        'change',
        'keyDown',
        'keyUp',
        'scrape',
      ];
      
      if (validTypes.includes(normalized as ChromeRecorderStep['type'])) {
        return normalized as ChromeRecorderStep['type'];
      }
    }

    // Infer type from step properties
    if (step.url) return 'navigate';
    if (step.value || step.text) return 'input';
    if (step.selector && step.text === undefined) return 'click';
    
    return 'click'; // Default fallback
  }

  /**
   * Extract metadata from recorder JSON
   */
  extractMetadata(recorderJSON: ChromeRecorderJSON): {
    site?: string;
    url?: string;
    targetUrl?: string; // Final destination URL (last navigation)
    stepCount: number;
    hasNavigation: boolean;
    hasInput: boolean;
    hasAssertion: boolean;
  } {
    const url = recorderJSON.url || recorderJSON.steps.find(s => s.url)?.url;
    
    // Extract target URL (last navigation URL - the final destination)
    const navigationSteps = recorderJSON.steps.filter(s => s.type === 'navigate' && s.url);
    const targetUrl = navigationSteps.length > 0 
      ? navigationSteps[navigationSteps.length - 1].url 
      : url;
    
    let site: string | undefined;
    
    if (url) {
      try {
        site = new URL(url).hostname;
      } catch {
        // Invalid URL, skip site extraction
      }
    }

    return {
      site,
      url,
      targetUrl,
      stepCount: recorderJSON.steps.length,
      hasNavigation: recorderJSON.steps.some(s => s.type === 'navigate' || s.url),
      hasInput: recorderJSON.steps.some(s => s.type === 'input' || s.value),
      hasAssertion: recorderJSON.steps.some(s => s.type === 'assert'),
    };
  }

  /**
   * Canonicalize selectors (basic normalization)
   */
  canonicalizeSelector(selector: string): string {
    // Remove extra whitespace
    let normalized = selector.trim();
    
    // Normalize quotes
    normalized = normalized.replace(/['"]/g, '"');
    
    // Remove redundant attribute selectors
    // This is a basic implementation; more sophisticated normalization can be added
    
    return normalized;
  }
}

