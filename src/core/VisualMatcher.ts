import type { Page } from 'playwright';
import { OCRMatcher } from './OCRMatcher.js';
import { ImageComparator } from './ImageComparator.js';

/**
 * VisualMatcher: Enhanced visual/positional matching with OCR and image comparison
 * Now includes OCR capabilities and image comparison for better element detection
 */
export class VisualMatcher {
  private ocrMatcher: OCRMatcher;
  private imageComparator: ImageComparator;

  constructor() {
    this.ocrMatcher = new OCRMatcher();
    this.imageComparator = new ImageComparator();
  }
  /**
   * Find candidate elements by approximating size/position similarity.
   * @param page Playwright page
   * @param reference Optional reference box to match against (width/height)
   */
  async findCandidates(
    page: Page,
    reference?: { width?: number; height?: number }
  ): Promise<Array<{ selector: string; score: number }>> {
    try {
      const boxes = await page.evaluate(() => {
        const elements = Array.from(document.querySelectorAll<HTMLElement>('body *'));
        return elements
          .filter(el => {
            const style = window.getComputedStyle(el);
            if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
            return true;
          })
          .map(el => {
            const rect = el.getBoundingClientRect();
            return {
              selector: (el as HTMLElement).outerHTML.slice(0, 80), // fallback identifier
              tag: el.tagName.toLowerCase(),
              width: rect.width,
              height: rect.height,
              area: rect.width * rect.height,
            };
          })
          .filter(b => b.area > 0);
      });

      if (!boxes || boxes.length === 0) return [];

      // Heuristic scoring: prefer similar size to reference if provided; otherwise prefer mid-sized elements
      const refArea = reference?.width && reference?.height ? reference.width * reference.height : undefined;
      const scores = boxes.map(b => {
        let score = 0.5;
        if (refArea && b.area > 0) {
          const ratio = Math.min(refArea, b.area) / Math.max(refArea, b.area);
          score = 0.5 + ratio * 0.5; // 0.5..1
        } else {
          // prefer moderate areas
          score = b.area > 2000 && b.area < 150000 ? 0.7 : 0.5;
        }
        return { selector: b.tag === 'input' || b.tag === 'button' ? `${b.tag}` : b.selector, score };
      });

      // Deduplicate selector strings and keep top few
      const unique = new Map<string, number>();
      for (const s of scores) {
        unique.set(s.selector, Math.max(unique.get(s.selector) ?? 0, s.score));
      }

      return Array.from(unique.entries())
        .map(([selector, score]) => ({ selector, score }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
    } catch (error) {
      console.warn('VisualMatcher failed', error);
      return [];
    }
  }

  /**
   * Find element by OCR text matching
   */
  async findByOCRText(
    page: Page,
    searchText: string,
    options?: { fuzzy?: boolean; threshold?: number }
  ): Promise<Array<{ selector: string; confidence: number; text: string }>> {
    return this.ocrMatcher.findElementByText(page, searchText, options);
  }

  /**
   * Extract text from element using OCR
   */
  async extractText(page: Page, selector: string): Promise<string> {
    return this.ocrMatcher.extractText(page, selector);
  }

  /**
   * Match visual elements using image comparison
   */
  async matchByImage(
    page: Page,
    referenceImage: Buffer,
    options?: { threshold?: number; region?: { x: number; y: number; width: number; height: number } }
  ): Promise<Array<{ selector: string; similarity: number; location: { x: number; y: number } }>> {
    return this.ocrMatcher.matchVisual(page, referenceImage, options);
  }

  /**
   * Compare element screenshot with reference
   */
  async compareElement(
    page: Page,
    selector: string,
    referenceImage: Buffer,
    options?: { threshold?: number }
  ): Promise<{ match: boolean; similarity: number; diffImage?: Buffer }> {
    return this.imageComparator.compareElementScreenshot(page, selector, referenceImage, options);
  }

  /**
   * Detect visual changes in page
   */
  async detectChanges(
    page: Page,
    previousScreenshot: Buffer,
    options?: { threshold?: number; region?: { x: number; y: number; width: number; height: number } }
  ): Promise<{ changed: boolean; similarity: number; changedRegions: Array<{ x: number; y: number; width: number; height: number }> }> {
    return this.imageComparator.detectVisualChanges(page, previousScreenshot, options);
  }
}

