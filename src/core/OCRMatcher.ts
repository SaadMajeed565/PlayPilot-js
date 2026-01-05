import type { Page } from 'playwright';

/**
 * OCRMatcher: Extract text and find elements using OCR
 * Uses Tesseract.js for text extraction from images
 */
export class OCRMatcher {
  /**
   * Extract text from element using OCR
   */
  async extractText(page: Page, selector: string): Promise<string> {
    try {
      const element = await page.locator(selector).first();
      const screenshot = await element.screenshot({ type: 'png' });
      
      // Dynamic import to avoid loading Tesseract if not needed
      const Tesseract = await import('tesseract.js');
      const { data: { text } } = await Tesseract.recognize(screenshot);
      
      return text.trim();
    } catch (error) {
      console.warn('OCR extraction failed:', error);
      return '';
    }
  }

  /**
   * Find element by OCR text match
   */
  async findElementByText(
    page: Page,
    searchText: string,
    options?: { fuzzy?: boolean; threshold?: number }
  ): Promise<Array<{ selector: string; confidence: number; text: string }>> {
    const threshold = options?.threshold || 0.7;
    const results: Array<{ selector: string; confidence: number; text: string }> = [];

    try {
      // Get all visible elements that might contain text
      const candidates = await page.evaluate(() => {
        const elements: Array<{ selector: string; tag: string }> = [];
        const allElements = document.querySelectorAll('button, a, input, textarea, [role="button"], [role="link"]');
        
        allElements.forEach((el) => {
          const style = window.getComputedStyle(el);
          if (style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0') {
            const tag = el.tagName.toLowerCase();
            const id = el.id ? `#${el.id}` : '';
            const classes = el.className ? `.${Array.from(el.classList).join('.')}` : '';
            const selector = `${tag}${id}${classes}` || tag;
            elements.push({ selector, tag });
          }
        });
        
        return elements;
      });

      // Extract text from each candidate using OCR
      for (const candidate of candidates.slice(0, 20)) { // Limit to 20 for performance
        try {
          const text = await this.extractText(page, candidate.selector);
          if (text) {
            const similarity = this.calculateSimilarity(text.toLowerCase(), searchText.toLowerCase());
            if (similarity >= threshold) {
              results.push({
                selector: candidate.selector,
                confidence: similarity,
                text,
              });
            }
          }
        } catch {
          // Skip failed extractions
        }
      }

      return results.sort((a, b) => b.confidence - a.confidence);
    } catch (error) {
      console.warn('OCR element search failed:', error);
      return [];
    }
  }

  /**
   * Calculate text similarity (Levenshtein distance based)
   */
  private calculateSimilarity(str1: string, str2: string): number {
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;
    
    if (longer.length === 0) return 1.0;
    
    const distance = this.levenshteinDistance(longer, shorter);
    return (longer.length - distance) / longer.length;
  }

  /**
   * Calculate Levenshtein distance between two strings
   */
  private levenshteinDistance(str1: string, str2: string): number {
    const matrix: number[][] = [];

    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= str1.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }

    return matrix[str2.length][str1.length];
  }

  /**
   * Match visual elements using image comparison
   */
  async matchVisual(
    page: Page,
    referenceImage: Buffer,
    options?: { threshold?: number; region?: { x: number; y: number; width: number; height: number } }
  ): Promise<Array<{ selector: string; similarity: number; location: { x: number; y: number } }>> {
    const threshold = options?.threshold || 0.8;
    const results: Array<{ selector: string; similarity: number; location: { x: number; y: number } }> = [];

    try {
      // Dynamic import for image comparison
      const pixelmatch = await import('pixelmatch');
      const sharp = await import('sharp');

      // Get page screenshot
      const pageScreenshot = await page.screenshot({ type: 'png', fullPage: false });
      
      // Compare images
      const referenceImg = await sharp.default(referenceImage).raw().ensureAlpha().toBuffer({ resolveWithObject: true });
      const pageImg = await sharp.default(pageScreenshot).raw().ensureAlpha().toBuffer({ resolveWithObject: true });

      const width = Math.min(referenceImg.info.width, pageImg.info.width);
      const height = Math.min(referenceImg.info.height, pageImg.info.height);

      const diff = Buffer.alloc(width * height * 4);
      const numDiffPixels = pixelmatch.default(
        referenceImg.data,
        pageImg.data,
        diff,
        width,
        height,
        { threshold: 0.1 }
      );

      const similarity = 1 - (numDiffPixels / (width * height));

      if (similarity >= threshold) {
        // Find element at location
        const elements = await page.evaluate((x, y) => {
          const element = document.elementFromPoint(x, y);
          if (element) {
            const tag = element.tagName.toLowerCase();
            const id = element.id ? `#${element.id}` : '';
            const classes = element.className ? `.${Array.from(element.classList).join('.')}` : '';
            return `${tag}${id}${classes}` || tag;
          }
          return null;
        }, options?.region?.x || width / 2, options?.region?.y || height / 2);

        if (elements) {
          results.push({
            selector: elements,
            similarity,
            location: { x: options?.region?.x || width / 2, y: options?.region?.y || height / 2 },
          });
        }
      }

      return results;
    } catch (error) {
      console.warn('Visual matching failed:', error);
      return [];
    }
  }
}

