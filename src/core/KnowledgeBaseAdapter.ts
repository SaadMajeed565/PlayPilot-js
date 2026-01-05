import type { SelectorHistory, SkillTemplate } from '../types/index.js';
import type { SitePattern } from './KnowledgeBase.js';

/**
 * Abstract interface for KnowledgeBase storage
 * Allows switching between JSON file, PostgreSQL, Redis, etc.
 */
export interface KnowledgeBaseAdapter {
  // Selector History
  saveSelectorHistory(site: string, history: SelectorHistory[]): Promise<void>;
  getSelectorHistory(site: string): Promise<SelectorHistory[]>;
  getAllSelectorHistories(): Promise<Map<string, SelectorHistory[]>>;

  // Skill Templates
  saveSkillTemplate(intent: string, template: SkillTemplate): Promise<void>;
  getSkillTemplate(intent: string): Promise<SkillTemplate | null>;
  getAllSkillTemplates(): Promise<Map<string, SkillTemplate>>;

  // Site Patterns
  saveSitePattern(site: string, pattern: SitePattern): Promise<void>;
  getSitePattern(site: string): Promise<SitePattern | null>;
  getAllSitePatterns(): Promise<Map<string, SitePattern>>;

  // Bulk operations
  initialize(): Promise<void>;
  close(): Promise<void>;
}

