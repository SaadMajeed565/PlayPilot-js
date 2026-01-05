import type { KnowledgeBaseAdapter } from '../KnowledgeBaseAdapter.js';
import type { SelectorHistory, SkillTemplate } from '../../types/index.js';
import type { SitePattern } from '../KnowledgeBase.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

/**
 * JSON file-backed KnowledgeBase storage
 * Simple, no dependencies, but doesn't scale well
 * Good for development and small deployments
 */
export class JSONAdapter implements KnowledgeBaseAdapter {
  private filePath: string;

  constructor(persistencePath?: string) {
    const basePath = persistencePath || join(process.cwd(), 'data', 'knowledge');
    this.filePath = join(basePath, 'knowledge.json');
    this.ensureDirectory();
  }

  async initialize(): Promise<void> {
    // File is created on first save
  }

  private ensureDirectory(): void {
    const dir = join(this.filePath, '..');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  private loadData(): {
    selectorHistory: Record<string, SelectorHistory[]>;
    skillTemplates: Record<string, SkillTemplate>;
    sitePatterns: Record<string, any>;
  } {
    if (!existsSync(this.filePath)) {
      return {
        selectorHistory: {},
        skillTemplates: {},
        sitePatterns: {},
      };
    }

    try {
      return JSON.parse(readFileSync(this.filePath, 'utf-8'));
    } catch (error) {
      console.error('Failed to load knowledge base:', error);
      return {
        selectorHistory: {},
        skillTemplates: {},
        sitePatterns: {},
      };
    }
  }

  private saveData(data: {
    selectorHistory: Record<string, SelectorHistory[]>;
    skillTemplates: Record<string, SkillTemplate>;
    sitePatterns: Record<string, any>;
  }): void {
    try {
      writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      console.error('Failed to save knowledge base:', error);
    }
  }

  async saveSelectorHistory(site: string, history: SelectorHistory[]): Promise<void> {
    const data = this.loadData();
    data.selectorHistory[site] = history;
    this.saveData(data);
  }

  async getSelectorHistory(site: string): Promise<SelectorHistory[]> {
    const data = this.loadData();
    return data.selectorHistory[site] || [];
  }

  async getAllSelectorHistories(): Promise<Map<string, SelectorHistory[]>> {
    const data = this.loadData();
    return new Map(Object.entries(data.selectorHistory || {}));
  }

  async saveSkillTemplate(intent: string, template: SkillTemplate): Promise<void> {
    const data = this.loadData();
    data.skillTemplates[intent] = template;
    this.saveData(data);
  }

  async getSkillTemplate(intent: string): Promise<SkillTemplate | null> {
    const data = this.loadData();
    return data.skillTemplates[intent] || null;
  }

  async getAllSkillTemplates(): Promise<Map<string, SkillTemplate>> {
    const data = this.loadData();
    return new Map(Object.entries(data.skillTemplates || {}));
  }

  async saveSitePattern(site: string, pattern: SitePattern): Promise<void> {
    const data = this.loadData();
    data.sitePatterns[site] = {
      ...pattern,
      commonIntents: Object.fromEntries(pattern.commonIntents),
      commonSelectors: Object.fromEntries(pattern.commonSelectors),
    };
    this.saveData(data);
  }

  async getSitePattern(site: string): Promise<SitePattern | null> {
    const data = this.loadData();
    const pattern = data.sitePatterns[site];
    if (!pattern) return null;

    return {
      ...pattern,
      commonIntents: new Map(Object.entries(pattern.commonIntents || {})),
      commonSelectors: new Map(Object.entries(pattern.commonSelectors || {})),
    } as SitePattern;
  }

  async getAllSitePatterns(): Promise<Map<string, SitePattern>> {
    const data = this.loadData();
    const map = new Map<string, SitePattern>();

    for (const [site, pattern] of Object.entries(data.sitePatterns || {})) {
      map.set(site, {
        ...pattern,
        commonIntents: new Map(Object.entries(pattern.commonIntents || {})),
        commonSelectors: new Map(Object.entries(pattern.commonSelectors || {})),
      } as SitePattern);
    }

    return map;
  }

  async close(): Promise<void> {
    // No cleanup needed for file-based storage
  }
}

