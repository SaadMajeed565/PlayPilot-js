import type { Page } from 'playwright';
import type { PageAnalysis, PageState } from './PageAnalyzer.js';
import { PageAnalyzer } from './PageAnalyzer.js';
import type { KnowledgeBase } from './KnowledgeBase.js';
import type { CanonicalAction, CanonicalStep } from '../types/index.js';
import type { SelectorHistory } from '../types/index.js';

/**
 * Intelligence Engine: All decision-making for automation
 * 
 * Consolidates:
 * - Pre-execution: Enhances actions with control flow (retries, conditionals, loops)
 * - Runtime: Makes decisions based on page state (wait, navigate, pause, etc.)
 * - Predictive: Predicts failures and optimizes proactively
 * 
 * Uses knowledge base to:
 * - Learn common challenges per site
 * - Apply successful recovery strategies
 * - Make intelligent decisions about next steps
 */
export class IntelligenceEngine {
  private pageAnalyzer: PageAnalyzer;
  private knowledgeBase?: KnowledgeBase;
  private breakagePatterns: Map<string, BreakagePattern> = new Map();
  private failurePredictions: Map<string, FailurePrediction> = new Map();
  
  // Pre-execution defaults (from LogicEngine)
  private defaultMaxRetries = 3;
  private defaultTimeout = 10000;
  private defaultBackoff = 'exponential';

  constructor(knowledgeBase?: KnowledgeBase) {
    this.pageAnalyzer = new PageAnalyzer();
    this.knowledgeBase = knowledgeBase;
  }

  /**
   * Enhance action with pre-execution logic (retries, conditionals, loops)
   */
  enhanceAction(action: CanonicalAction): CanonicalAction {
    // TODO: Implement pre-execution enhancement logic
    // This should add control flow elements like retries, conditionals, loops
    // based on the action intent and learned patterns

    // For now, return the action as-is
    return action;
  }

  /**
   * Analyze page and determine intelligent action
   */
  async analyzeAndDecide(
    page: Page,
    context: {
      expectedUrl?: string;
      expectedElements?: string[];
      expectedText?: string[];
      site?: string;
      currentStep?: string;
    }
  ): Promise<IntelligentDecision> {
    // Analyze current page state
    const analysis = await this.pageAnalyzer.analyzePage(page, {
      url: context.expectedUrl,
      expectedElements: context.expectedElements,
      expectedText: context.expectedText,
    });

    // Check knowledge base for learned strategies
    const learnedStrategy = context.site
      ? await this.getLearnedStrategy(context.site, analysis.state)
      : null;

    // Make decision based on analysis and learned knowledge
    const decision = await this.makeDecision(analysis, learnedStrategy, context);

    // Learn from this situation
    if (context.site && analysis.state !== 'ready') {
      await this.learnFromChallenge(context.site, analysis, decision);
    }

    return decision;
  }

  /**
   * Get learned strategy for handling this challenge
   */
  private async getLearnedStrategy(
    site: string,
    _state: PageState
  ): Promise<LearnedStrategy | null> {
    if (!this.knowledgeBase) return null;

    const patterns = await this.knowledgeBase.getSitePatterns(site);
    if (!patterns) return null;

    // Check if we've seen this challenge before
    // This would be stored in site patterns (we'll enhance this)
    // For now, return null and learn as we go
    return null;
  }

  /**
   * Make intelligent decision based on page state
   */
  private async makeDecision(
    analysis: PageAnalysis,
    learnedStrategy: LearnedStrategy | null,
    context: {
      expectedUrl?: string;
      expectedElements?: string[];
      expectedText?: string[];
      site?: string;
      currentStep?: string;
    }
  ): Promise<IntelligentDecision> {
    switch (analysis.state) {
      case 'cloudflare_challenge':
        return this.handleCloudflare(analysis, learnedStrategy);

      case 'captcha_required':
        return this.handleCaptcha(analysis, learnedStrategy);

      case 'error_page':
        return this.handleErrorPage(analysis, learnedStrategy);

      case 'wrong_page':
        return await this.handleWrongPage(analysis, context, learnedStrategy);

      case 'loading':
        return this.handleLoading(analysis);

      case 'ready':
        return {
          action: 'continue',
          confidence: analysis.pageRelevance.confidence,
          reason: 'Page is ready and relevant',
          waitTime: 0,
        };

      default:
        return {
          action: 'wait',
          confidence: 0.5,
          reason: 'Unknown page state',
          waitTime: 2000,
        };
    }
  }

  /**
   * Handle Cloudflare challenge
   */
  private handleCloudflare(
    _analysis: PageAnalysis,
    learnedStrategy: LearnedStrategy | null
  ): IntelligentDecision {
    // Use learned strategy if available
    if (learnedStrategy && learnedStrategy.action === 'wait') {
      return {
        action: 'wait',
        confidence: 0.9,
        reason: `Learned: Cloudflare usually resolves after ${learnedStrategy.waitTime}ms`,
        waitTime: learnedStrategy.waitTime || 5000,
        retryAfter: true,
      };
    }

    // Default strategy: wait for Cloudflare to resolve
    return {
      action: 'wait',
      confidence: 0.8,
      reason: 'Cloudflare challenge detected - waiting for automatic resolution',
      waitTime: 5000,
      retryAfter: true,
      maxRetries: 3,
    };
  }

  /**
   * Handle captcha
   */
  private handleCaptcha(
    analysis: PageAnalysis,
    _learnedStrategy: LearnedStrategy | null
  ): IntelligentDecision {
    // Captcha requires human intervention
    return {
      action: 'pause',
      confidence: 1.0,
      reason: `Captcha detected (${analysis.captcha.type}) - requires human intervention`,
      requiresHuman: true,
      message: 'Please solve the captcha manually',
    };
  }

  /**
   * Handle error page
   */
  private handleErrorPage(
    analysis: PageAnalysis,
    _learnedStrategy: LearnedStrategy | null
  ): IntelligentDecision {
    const errorType = analysis.errorPage.type || 'other';

    // 404 - page not found, try going back or to home
    if (errorType === '404') {
      return {
        action: 'navigate_back',
        confidence: 0.7,
        reason: '404 error - attempting to go back',
        waitTime: 1000,
      };
    }

    // 500/503 - server error, retry
    if (errorType === '500' || errorType === 'timeout') {
      return {
        action: 'retry',
        confidence: 0.8,
        reason: `Server error (${errorType}) - retrying`,
        waitTime: 3000,
        maxRetries: 2,
      };
    }

    // 403 - access denied, might need different approach
    if (errorType === '403') {
      return {
        action: 'pause',
        confidence: 0.9,
        reason: '403 Forbidden - may need authentication or different approach',
        requiresHuman: true,
        message: 'Access denied - check if authentication is required',
      };
    }

    return {
      action: 'pause',
      confidence: 0.7,
      reason: `Error page detected (${errorType})`,
      requiresHuman: true,
      message: 'Unexpected error page encountered',
    };
  }

  /**
   * Handle wrong page (redirected to irrelevant page)
   */
  private async handleWrongPage(
    analysis: PageAnalysis,
    context: {
      expectedUrl?: string;
      expectedElements?: string[];
      expectedText?: string[];
      site?: string;
      currentStep?: string;
    },
    _learnedStrategy: LearnedStrategy | null
  ): Promise<IntelligentDecision> {
    const currentUrl = analysis.url;

    // Check if redirected URL is in knowledge base (we've recorded this page before!)
    if (this.knowledgeBase) {
      const knownUrl = this.knowledgeBase.getKnownUrl(currentUrl);
      
      if (knownUrl && knownUrl.successRate > 0.5) {
        // This URL is known! We've automated it before
        const urlActions = this.knowledgeBase.getUrlActions(currentUrl);
        
        if (urlActions) {
          return {
            action: 'continue',
            confidence: 0.9,
            reason: `Recognized known URL from knowledge base - continuing with learned actions (${urlActions.intents.join(', ')})`,
            knownUrl: true,
            learnedIntents: urlActions.intents,
            learnedSelectors: urlActions.selectors,
            waitTime: 1000, // Brief wait to ensure page is ready
          };
        }
      }
    }

    // If we have expected URL, try navigating to it
    if (context.expectedUrl) {
      return {
        action: 'navigate',
        confidence: 0.8,
        reason: `Redirected to wrong page - navigating to expected URL`,
        targetUrl: context.expectedUrl,
        waitTime: 2000,
      };
    }

    // Try going back
    return {
      action: 'navigate_back',
      confidence: 0.6,
      reason: 'Redirected to irrelevant page - going back',
      waitTime: 1000,
    };
  }

  /**
   * Handle loading state
   */
  private handleLoading(_analysis: PageAnalysis): IntelligentDecision {
    return {
      action: 'wait',
      confidence: 0.9,
      reason: 'Page is still loading',
      waitTime: 2000,
      retryAfter: true,
      maxRetries: 5,
    };
  }

  /**
   * Learn from challenges encountered with enhanced pattern recognition
   */
  private async learnFromChallenge(
    site: string,
    analysis: PageAnalysis,
    decision: IntelligentDecision
  ): Promise<void> {
    if (!this.knowledgeBase) return;

    // Store challenge pattern in knowledge base
    const now = new Date();
    const challengeData = {
      site,
      challengeType: this.mapStateToChallengeType(analysis.state),
      timeOfDay: now.getHours(),
      dayOfWeek: now.getDay(),
      recoveryStrategy: decision.action,
      success: decision.action !== 'pause' && decision.action !== 'abort',
    };

    // This would be stored in knowledge base for pattern recognition
    // For now, we'll use a more detailed logging approach
    console.log(
      `[Intelligence] Learned challenge for ${site}: ${analysis.state} -> ${decision.action} ` +
      `(Time: ${challengeData.timeOfDay}:00, Day: ${challengeData.dayOfWeek}, Success: ${challengeData.success})`
    );

    // Store in knowledge base if it supports challenge patterns
    // TODO: Integrate with StrategyManager for challenge pattern learning
  }

  /**
   * Map page state to challenge type
   */
  private mapStateToChallengeType(
    state: PageState
  ): 'cloudflare' | 'captcha' | 'error' | 'rate_limit' | 'blocked' {
    switch (state) {
      case 'cloudflare_challenge':
        return 'cloudflare';
      case 'captcha_required':
        return 'captcha';
      case 'error_page':
        return 'error';
      case 'wrong_page':
        return 'blocked';
      default:
        return 'error';
    }
  }

  /**
   * Get learned strategy with enhanced pattern matching
   */
  async getLearnedStrategyEnhanced(
    site: string,
    state: PageState,
    context?: {
      timeOfDay?: number;
      previousChallenges?: PageState[];
    }
  ): Promise<LearnedStrategy | null> {
    if (!this.knowledgeBase) return null;

    const patterns = await this.knowledgeBase.getSitePatterns(site);
    if (!patterns) return null;

    // Check for time-based patterns
    const now = new Date();
    const currentHour = context?.timeOfDay ?? now.getHours();

    // This would query challenge patterns from knowledge base
    // For now, return null and learn as we go
    return null;
  }
}

/**
 * Intelligent decision made by the engine
 */
export interface IntelligentDecision {
  action: DecisionAction;
  confidence: number;
  reason: string;
  waitTime?: number;
  targetUrl?: string;
  maxRetries?: number;
  retryAfter?: boolean;
  requiresHuman?: boolean;
  message?: string;
  knownUrl?: boolean; // True if URL is recognized from knowledge base
  learnedIntents?: string[]; // Learned intents for this URL
  learnedSelectors?: string[]; // Learned selectors for this URL
}

export type DecisionAction =
  | 'continue'
  | 'wait'
  | 'retry'
  | 'navigate'
  | 'navigate_back'
  | 'pause'
  | 'abort';

/**
 * Learned strategy from knowledge base
 */
interface LearnedStrategy {
  action: DecisionAction;
  waitTime?: number;
  successRate: number;
  lastUsed: number;
}

