import type { Page } from 'playwright';

/**
 * ImageComparator: Compare screenshots and detect visual changes
 */
export class ImageComparator {
  /**
   * Compare two screenshots and return similarity score
   */
  async compareImages(
    image1: Buffer,
    image2: Buffer,
    options?: { threshold?: number; ignoreAntialiasing?: boolean }
  ): Promise<{ similarity: number; diffPixels: number; diffImage?: Buffer }> {
    try {
      const pixelmatch = await import('pixelmatch');
      const sharp = await import('sharp');

      const img1 = await sharp.default(image1).raw().ensureAlpha().toBuffer({ resolveWithObject: true });
      const img2 = await sharp.default(image2).raw().ensureAlpha().toBuffer({ resolveWithObject: true });

      const width = Math.min(img1.info.width, img2.info.width);
      const height = Math.min(img1.info.height, img2.info.height);

      const diff = Buffer.alloc(width * height * 4);
      const numDiffPixels = pixelmatch.default(
        img1.data,
        img2.data,
        diff,
        width,
        height,
        {
          threshold: options?.threshold || 0.1,
          ignoreAntialiasing: options?.ignoreAntialiasing !== false,
        }
      );

      const totalPixels = width * height;
      const similarity = 1 - (numDiffPixels / totalPixels);

      // Generate diff image
      const diffImage = await sharp.default(diff, {
        raw: {
          width,
          height,
          channels: 4,
        },
      })
        .png()
        .toBuffer();

      return {
        similarity,
        diffPixels: numDiffPixels,
        diffImage,
      };
    } catch (error) {
      console.warn('Image comparison failed:', error);
      return { similarity: 0, diffPixels: 0 };
    }
  }

  /**
   * Take screenshot of element and compare with reference
   */
  async compareElementScreenshot(
    page: Page,
    selector: string,
    referenceImage: Buffer,
    options?: { threshold?: number }
  ): Promise<{ match: boolean; similarity: number; diffImage?: Buffer }> {
    try {
      const element = await page.locator(selector).first();
      const screenshot = await element.screenshot({ type: 'png' });

      const result = await this.compareImages(screenshot, referenceImage, options);
      const threshold = options?.threshold || 0.9;

      return {
        match: result.similarity >= threshold,
        similarity: result.similarity,
        diffImage: result.diffImage,
      };
    } catch (error) {
      console.warn('Element screenshot comparison failed:', error);
      return { match: false, similarity: 0 };
    }
  }

  /**
   * Detect visual changes in page over time
   */
  async detectVisualChanges(
    page: Page,
    previousScreenshot: Buffer,
    options?: { threshold?: number; region?: { x: number; y: number; width: number; height: number } }
  ): Promise<{ changed: boolean; similarity: number; changedRegions: Array<{ x: number; y: number; width: number; height: number }> }> {
    try {
      const currentScreenshot = await page.screenshot({
        type: 'png',
        clip: options?.region,
      });

      const result = await this.compareImages(previousScreenshot, currentScreenshot, options);
      const threshold = options?.threshold || 0.95;

      return {
        changed: result.similarity < threshold,
        similarity: result.similarity,
        changedRegions: result.similarity < threshold
          ? [{ x: 0, y: 0, width: 0, height: 0 }] // Simplified - could use more advanced region detection
          : [],
      };
    } catch (error) {
      console.warn('Visual change detection failed:', error);
      return { changed: false, similarity: 1, changedRegions: [] };
    }
  }
}

