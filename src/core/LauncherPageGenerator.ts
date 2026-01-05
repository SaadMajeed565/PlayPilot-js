import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { Website } from './WebsiteManager.js';

/**
 * Launcher Page Generator
 * Generates and maintains an HTML launcher page that lists all websites
 * as clickable links. This creates a more natural browsing pattern for automation.
 */
export class LauncherPageGenerator {
  private launcherPath: string;
  private static instance: LauncherPageGenerator | null = null;

  constructor(launcherPath?: string) {
    // Default to data directory
    this.launcherPath = launcherPath || join(process.cwd(), 'data', 'launcher.html');
  }

  /**
   * Get singleton instance
   */
  static getInstance(launcherPath?: string): LauncherPageGenerator {
    if (!LauncherPageGenerator.instance) {
      LauncherPageGenerator.instance = new LauncherPageGenerator(launcherPath);
    }
    return LauncherPageGenerator.instance;
  }

  /**
   * Generate HTML content for launcher page
   */
  private generateHTML(websites: Website[]): string {
    const websiteLinks = websites.map(website => {
      // Ensure URL has protocol
      const url = website.domain.startsWith('http') 
        ? website.domain 
        : `https://${website.domain}`;
      
      return `
      <div class="website-item">
        <a 
          href="${url}" 
          target="_blank" 
          data-website-id="${website.id}" 
          data-domain="${website.domain}"
          class="website-link"
        >
          <span class="website-name">${this.escapeHtml(website.name)}</span>
          <span class="website-domain">${this.escapeHtml(website.domain)}</span>
        </a>
        ${website.description ? `<p class="website-description">${this.escapeHtml(website.description)}</p>` : ''}
      </div>`;
    }).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Automation Website Launcher</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 40px 20px;
      color: #333;
    }
    
    .container {
      max-width: 1200px;
      margin: 0 auto;
      background: white;
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      padding: 40px;
    }
    
    h1 {
      font-size: 2.5em;
      margin-bottom: 10px;
      color: #667eea;
      text-align: center;
    }
    
    .subtitle {
      text-align: center;
      color: #666;
      margin-bottom: 40px;
      font-size: 1.1em;
    }
    
    .website-list {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 20px;
      margin-top: 30px;
    }
    
    .website-item {
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      padding: 20px;
      transition: all 0.3s ease;
      background: #fafafa;
    }
    
    .website-item:hover {
      border-color: #667eea;
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(102, 126, 234, 0.2);
    }
    
    .website-link {
      display: block;
      text-decoration: none;
      color: inherit;
      cursor: pointer;
    }
    
    .website-name {
      display: block;
      font-size: 1.3em;
      font-weight: 600;
      color: #333;
      margin-bottom: 5px;
    }
    
    .website-domain {
      display: block;
      font-size: 0.9em;
      color: #667eea;
      font-weight: 500;
    }
    
    .website-description {
      margin-top: 10px;
      font-size: 0.9em;
      color: #666;
      line-height: 1.4;
    }
    
    .stats {
      margin-top: 30px;
      padding-top: 20px;
      border-top: 2px solid #e0e0e0;
      text-align: center;
      color: #666;
      font-size: 0.9em;
    }
    
    @media (max-width: 768px) {
      .website-list {
        grid-template-columns: 1fr;
      }
      
      h1 {
        font-size: 2em;
      }
      
      .container {
        padding: 20px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🚀 Automation Website Launcher</h1>
    <p class="subtitle">Click on any website to open it in a new tab for automation</p>
    
    <div class="website-list">
      ${websiteLinks || '<p style="text-align: center; color: #666;">No websites configured yet.</p>'}
    </div>
    
    <div class="stats">
      <p>Total Websites: ${websites.length}</p>
      <p>Last Updated: ${new Date().toLocaleString()}</p>
    </div>
  </div>
  
  <script>
    // Add click tracking for analytics (optional)
    document.querySelectorAll('.website-link').forEach(link => {
      link.addEventListener('click', function() {
        console.log('Opening website:', this.dataset.domain);
        // Link will open in new tab via target="_blank"
      });
    });
  </script>
</body>
</html>`;
  }

  /**
   * Escape HTML to prevent XSS
   */
  private escapeHtml(text: string): string {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, m => map[m]);
  }

  /**
   * Update launcher page with current websites
   */
  updateLauncherPage(websites: Website[]): void {
    try {
      // Ensure directory exists
      const dir = join(this.launcherPath, '..');
      if (dir && !existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      // Generate and write HTML
      const html = this.generateHTML(websites);
      writeFileSync(this.launcherPath, html, 'utf-8');
      
      console.log(`✓ Launcher page updated at ${this.launcherPath} with ${websites.length} website(s)`);
    } catch (error) {
      console.error('Failed to update launcher page:', error);
      // Don't throw - launcher page is optional
    }
  }

  /**
   * Get launcher page path (for use in automation)
   */
  getLauncherPath(): string {
    return this.launcherPath;
  }

  /**
   * Get launcher page URL (file:// protocol)
   */
  getLauncherUrl(): string {
    // Convert Windows path to file:// URL format
    const path = this.launcherPath.replace(/\\/g, '/');
    if (path.startsWith('/')) {
      return `file://${path}`;
    }
    return `file:///${path}`;
  }

  /**
   * Check if launcher page exists
   */
  exists(): boolean {
    return existsSync(this.launcherPath);
  }
}

