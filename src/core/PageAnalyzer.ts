import type { Page } from 'playwright';

/**
 * Page Analyzer: Intelligently analyzes page state and context
 * 
 * Detects:
 * - Cloudflare challenges
 * - Captchas
 * - Error pages
 * - Redirects to wrong pages
 * - Success indicators
 * - Loading states
 */
export class PageAnalyzer {
  /**
   * Analyze current page state
   */
  async analyzePage(page: Page, expectedContext?: {
    url?: string;
    expectedElements?: string[];
    expectedText?: string[];
  }): Promise<PageAnalysis> {
    const url = page.url();
    const title = await page.title().catch(() => '');
    const bodyText = await page.textContent('body').catch(() => '') || '';

    // Check for common challenges
    const cloudflare = await this.detectCloudflare(page, bodyText);
    const captcha = await this.detectCaptcha(page, bodyText);
    const errorPage = await this.detectErrorPage(page, bodyText, title);
    const loading = await this.detectLoading(page);

    // Check if we're on the expected page
    const pageRelevance = expectedContext
      ? await this.checkPageRelevance(page, expectedContext)
      : { isRelevant: true, confidence: 1.0, reasons: [] };

    // Determine overall state
    const state = this.determineState({
      cloudflare,
      captcha,
      errorPage,
      loading,
      pageRelevance,
    });

    return {
      url,
      title,
      state,
      cloudflare,
      captcha,
      errorPage,
      loading,
      pageRelevance,
      timestamp: Date.now(),
    };
  }

  /**
   * Detect Cloudflare challenge page
   */
  private async detectCloudflare(page: Page, bodyText: string): Promise<CloudflareDetection> {
    // Check for Cloudflare indicators
    const cloudflareIndicators = [
      'cloudflare',
      'checking your browser',
      'ddos protection',
      'ray id',
      'cf-ray',
      'just a moment',
      'please wait',
    ];

    const hasCloudflareText = cloudflareIndicators.some(indicator =>
      bodyText.toLowerCase().includes(indicator.toLowerCase())
    );

    // Check for Cloudflare-specific elements
    const cloudflareSelectors = [
      '#cf-wrapper',
      '.cf-browser-verification',
      '[data-ray]',
      '.cf-im-under-attack',
      '#challenge-form',
    ];

    let hasCloudflareElement = false;
    for (const selector of cloudflareSelectors) {
      const element = await page.$(selector).catch(() => null);
      if (element) {
        hasCloudflareElement = true;
        break;
      }
    }

    const isCloudflare = hasCloudflareText || hasCloudflareElement;

    return {
      detected: isCloudflare,
      type: isCloudflare ? (hasCloudflareElement ? 'challenge' : 'checking') : undefined,
      requiresAction: isCloudflare,
    };
  }

  /**
   * Detect captcha challenges
   */
  private async detectCaptcha(page: Page, bodyText: string): Promise<CaptchaDetection> {
    const captchaIndicators = [
      'captcha',
      'recaptcha',
      'hcaptcha',
      'verify you are human',
      'i am not a robot',
      'prove you are human',
    ];

    const hasCaptchaText = captchaIndicators.some(indicator =>
      bodyText.toLowerCase().includes(indicator.toLowerCase())
    );

    // Check for common captcha selectors
    const captchaSelectors = [
      '.g-recaptcha',
      '#recaptcha',
      '.hcaptcha-container',
      '[data-sitekey]',
      'iframe[src*="recaptcha"]',
      'iframe[src*="hcaptcha"]',
    ];

    let captchaType: 'recaptcha' | 'hcaptcha' | 'other' | undefined;
    for (const selector of captchaSelectors) {
      const element = await page.$(selector).catch(() => null);
      if (element) {
        if (selector.includes('recaptcha')) captchaType = 'recaptcha';
        else if (selector.includes('hcaptcha')) captchaType = 'hcaptcha';
        else captchaType = 'other';
        break;
      }
    }

    const detected = hasCaptchaText || captchaType !== undefined;

    return {
      detected,
      type: captchaType,
      requiresAction: detected,
    };
  }

  /**
   * Detect error pages
   */
  private async detectErrorPage(
    page: Page,
    bodyText: string,
    title: string
  ): Promise<ErrorPageDetection> {
    const errorIndicators = [
      '404',
      'not found',
      'page not found',
      'error',
      'something went wrong',
      'access denied',
      'forbidden',
      'unauthorized',
      'server error',
      '500',
      '503',
      'service unavailable',
    ];

    const hasErrorText = errorIndicators.some(indicator =>
      bodyText.toLowerCase().includes(indicator.toLowerCase()) ||
      title.toLowerCase().includes(indicator.toLowerCase())
    );

    // Check for common error page selectors
    const errorSelectors = [
      '.error-page',
      '#error',
      '.not-found',
      '[class*="error"]',
      '[id*="error"]',
    ];

    let hasErrorElement = false;
    for (const selector of errorSelectors) {
      const element = await page.$(selector).catch(() => null);
      if (element) {
        hasErrorElement = true;
        break;
      }
    }

    const detected = hasErrorText || hasErrorElement;

    return {
      detected,
      type: detected ? this.classifyError(bodyText, title) : undefined,
      requiresAction: detected,
    };
  }

  /**
   * Detect if page is still loading
   */
  private async detectLoading(page: Page): Promise<LoadingDetection> {
    // Check for loading indicators
    const loadingSelectors = [
      '.loading',
      '.spinner',
      '[class*="loading"]',
      '[class*="spinner"]',
      '#loading',
    ];

    let isLoading = false;
    for (const selector of loadingSelectors) {
      const element = await page.$(selector).catch(() => null);
      if (element && (await element.isVisible().catch(() => false))) {
        isLoading = true;
        break;
      }
    }

    // Check if document is still loading
    const documentReady = await page.evaluate(() => document.readyState).catch(() => 'complete');
    const isDocumentLoading = documentReady !== 'complete';

    return {
      detected: isLoading || isDocumentLoading,
      type: isLoading ? 'spinner' : isDocumentLoading ? 'document' : undefined,
    };
  }

  /**
   * Check if current page is relevant to expected context
   */
  private async checkPageRelevance(
    page: Page,
    expected: {
      url?: string;
      expectedElements?: string[];
      expectedText?: string[];
    }
  ): Promise<PageRelevance> {
    const reasons: string[] = [];
    let relevanceScore = 1.0;

    // Check URL relevance
    if (expected.url) {
      const currentUrl = page.url();
      const expectedDomain = new URL(expected.url).hostname;
      const currentDomain = new URL(currentUrl).hostname;

      if (currentDomain !== expectedDomain) {
        relevanceScore -= 0.5;
        reasons.push(`Domain mismatch: expected ${expectedDomain}, got ${currentDomain}`);
      } else if (!currentUrl.includes(new URL(expected.url).pathname)) {
        relevanceScore -= 0.2;
        reasons.push(`Path mismatch: expected path from ${expected.url}`);
      }
    }

    // Check for expected elements
    if (expected.expectedElements && expected.expectedElements.length > 0) {
      let foundElements = 0;
      for (const selector of expected.expectedElements) {
        const element = await page.$(selector).catch(() => null);
        if (element) {
          foundElements++;
        }
      }

      const elementScore = foundElements / expected.expectedElements.length;
      relevanceScore *= elementScore;

      if (elementScore < 0.5) {
        reasons.push(
          `Missing expected elements: only found ${foundElements}/${expected.expectedElements.length}`
        );
      }
    }

    // Check for expected text
    if (expected.expectedText && expected.expectedText.length > 0) {
      const bodyText = (await page.textContent('body').catch(() => '')) || '';
      let foundText = 0;

      for (const text of expected.expectedText) {
        if (bodyText.toLowerCase().includes(text.toLowerCase())) {
          foundText++;
        }
      }

      const textScore = foundText / expected.expectedText.length;
      relevanceScore *= textScore;

      if (textScore < 0.5) {
        reasons.push(`Missing expected text: only found ${foundText}/${expected.expectedText.length}`);
      }
    }

    return {
      isRelevant: relevanceScore >= 0.5,
      confidence: relevanceScore,
      reasons,
    };
  }

  /**
   * Classify error type
   */
  private classifyError(bodyText: string, title: string): '404' | '500' | '403' | 'timeout' | 'other' {
    const text = (bodyText + ' ' + title).toLowerCase();

    if (text.includes('404') || text.includes('not found')) return '404';
    if (text.includes('500') || text.includes('server error')) return '500';
    if (text.includes('403') || text.includes('forbidden') || text.includes('access denied'))
      return '403';
    if (text.includes('timeout') || text.includes('timed out')) return 'timeout';
    return 'other';
  }

  /**
   * Determine overall page state
   */
  private determineState(analysis: {
    cloudflare: CloudflareDetection;
    captcha: CaptchaDetection;
    errorPage: ErrorPageDetection;
    loading: LoadingDetection;
    pageRelevance: PageRelevance;
  }): PageState {
    if (analysis.cloudflare.detected) return 'cloudflare_challenge';
    if (analysis.captcha.detected) return 'captcha_required';
    if (analysis.errorPage.detected) return 'error_page';
    if (analysis.loading.detected) return 'loading';
    if (!analysis.pageRelevance.isRelevant) return 'wrong_page';
    return 'ready';
  }
}

/**
 * Page analysis result
 */
export interface PageAnalysis {
  url: string;
  title: string;
  state: PageState;
  cloudflare: CloudflareDetection;
  captcha: CaptchaDetection;
  errorPage: ErrorPageDetection;
  loading: LoadingDetection;
  pageRelevance: PageRelevance;
  timestamp: number;
}

export type PageState =
  | 'ready'
  | 'loading'
  | 'cloudflare_challenge'
  | 'captcha_required'
  | 'error_page'
  | 'wrong_page';

export interface CloudflareDetection {
  detected: boolean;
  type?: 'challenge' | 'checking';
  requiresAction: boolean;
}

export interface CaptchaDetection {
  detected: boolean;
  type?: 'recaptcha' | 'hcaptcha' | 'other';
  requiresAction: boolean;
}

export interface ErrorPageDetection {
  detected: boolean;
  type?: '404' | '500' | '403' | 'timeout' | 'other';
  requiresAction: boolean;
}

export interface LoadingDetection {
  detected: boolean;
  type?: 'spinner' | 'document';
}

export interface PageRelevance {
  isRelevant: boolean;
  confidence: number;
  reasons: string[];
}

