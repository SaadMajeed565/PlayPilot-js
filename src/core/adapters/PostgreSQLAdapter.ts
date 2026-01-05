import type { Pool } from 'pg';
import type { KnowledgeBaseAdapter } from '../KnowledgeBaseAdapter.js';
import type { SelectorHistory, SkillTemplate } from '../../types/index.js';
import type { SitePattern } from '../KnowledgeBase.js';
import { Pool as PgPool } from 'pg';

/**
 * PostgreSQL-backed KnowledgeBase storage
 * Scales to millions of patterns with proper indexing
 */
export class PostgreSQLAdapter implements KnowledgeBaseAdapter {
  private pool: Pool;

  constructor(connectionString?: string) {
    this.pool = new PgPool({
      connectionString:
        connectionString || process.env.DATABASE_URL || 'postgresql://localhost/automation',
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });
  }

  async initialize(): Promise<void> {
    // Create tables if they don't exist
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS selector_history (
        id SERIAL PRIMARY KEY,
        site VARCHAR(255) NOT NULL,
        original_selector TEXT NOT NULL,
        healed_selector TEXT NOT NULL,
        strategy VARCHAR(50) NOT NULL,
        success_count INTEGER DEFAULT 0,
        failure_count INTEGER DEFAULT 0,
        last_used BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(site, original_selector, strategy)
      );

      CREATE INDEX IF NOT EXISTS idx_selector_history_site ON selector_history(site);
      CREATE INDEX IF NOT EXISTS idx_selector_history_last_used ON selector_history(last_used DESC);

      CREATE TABLE IF NOT EXISTS skill_templates (
        intent VARCHAR(255) PRIMARY KEY,
        skill_spec JSONB NOT NULL,
        success_rate DECIMAL(5,4) NOT NULL,
        usage_count INTEGER DEFAULT 1,
        last_updated BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_skill_templates_success_rate ON skill_templates(success_rate DESC);

      CREATE TABLE IF NOT EXISTS site_patterns (
        site VARCHAR(255) PRIMARY KEY,
        common_intents JSONB NOT NULL,
        common_selectors JSONB NOT NULL,
        common_flows TEXT[] NOT NULL,
        success_rate DECIMAL(5,4) NOT NULL,
        total_jobs INTEGER DEFAULT 1,
        last_updated BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_site_patterns_success_rate ON site_patterns(success_rate DESC);
      CREATE INDEX IF NOT EXISTS idx_site_patterns_total_jobs ON site_patterns(total_jobs DESC);
    `);
  }

  async saveSelectorHistory(site: string, history: SelectorHistory[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Delete existing for this site
      await client.query('DELETE FROM selector_history WHERE site = $1', [site]);

      // Insert new records
      for (const entry of history) {
        await client.query(
          `INSERT INTO selector_history 
           (site, original_selector, healed_selector, strategy, success_count, failure_count, last_used)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (site, original_selector, strategy)
           DO UPDATE SET
             healed_selector = EXCLUDED.healed_selector,
             success_count = EXCLUDED.success_count,
             failure_count = EXCLUDED.failure_count,
             last_used = EXCLUDED.last_used,
             updated_at = NOW()`,
          [
            entry.site,
            entry.originalSelector,
            entry.healedSelector,
            entry.strategy,
            entry.successCount,
            entry.failureCount,
            entry.lastUsed,
          ]
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getSelectorHistory(site: string): Promise<SelectorHistory[]> {
    const result = await this.pool.query(
      'SELECT * FROM selector_history WHERE site = $1 ORDER BY last_used DESC',
      [site]
    );

    return result.rows.map(row => ({
      site: row.site,
      originalSelector: row.original_selector,
      healedSelector: row.healed_selector,
      strategy: row.strategy as any,
      successCount: row.success_count,
      failureCount: row.failure_count,
      lastUsed: row.last_used,
    }));
  }

  async getAllSelectorHistories(): Promise<Map<string, SelectorHistory[]>> {
    const result = await this.pool.query('SELECT * FROM selector_history ORDER BY site, last_used DESC');
    const map = new Map<string, SelectorHistory[]>();

    for (const row of result.rows) {
      const entry: SelectorHistory = {
        site: row.site,
        originalSelector: row.original_selector,
        healedSelector: row.healed_selector,
        strategy: row.strategy as any,
        successCount: row.success_count,
        failureCount: row.failure_count,
        lastUsed: row.last_used,
      };

      if (!map.has(row.site)) {
        map.set(row.site, []);
      }
      map.get(row.site)!.push(entry);
    }

    return map;
  }

  async saveSkillTemplate(intent: string, template: SkillTemplate): Promise<void> {
    await this.pool.query(
      `INSERT INTO skill_templates (intent, skill_spec, success_rate, usage_count, last_updated)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (intent)
       DO UPDATE SET
         skill_spec = EXCLUDED.skill_spec,
         success_rate = EXCLUDED.success_rate,
         usage_count = EXCLUDED.usage_count,
         last_updated = EXCLUDED.last_updated,
         updated_at = NOW()`,
      [intent, JSON.stringify(template.skillSpec), template.successRate, template.usageCount, template.lastUpdated]
    );
  }

  async getSkillTemplate(intent: string): Promise<SkillTemplate | null> {
    const result = await this.pool.query('SELECT * FROM skill_templates WHERE intent = $1', [intent]);
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      intent: row.intent,
      skillSpec: row.skill_spec,
      successRate: parseFloat(row.success_rate),
      usageCount: row.usage_count,
      lastUpdated: row.last_updated,
    };
  }

  async getAllSkillTemplates(): Promise<Map<string, SkillTemplate>> {
    const result = await this.pool.query('SELECT * FROM skill_templates');
    const map = new Map<string, SkillTemplate>();

    for (const row of result.rows) {
      map.set(row.intent, {
        intent: row.intent,
        skillSpec: row.skill_spec,
        successRate: parseFloat(row.success_rate),
        usageCount: row.usage_count,
        lastUpdated: row.last_updated,
      });
    }

    return map;
  }

  async saveSitePattern(site: string, pattern: SitePattern): Promise<void> {
    await this.pool.query(
      `INSERT INTO site_patterns 
       (site, common_intents, common_selectors, common_flows, success_rate, total_jobs, last_updated)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (site)
       DO UPDATE SET
         common_intents = EXCLUDED.common_intents,
         common_selectors = EXCLUDED.common_selectors,
         common_flows = EXCLUDED.common_flows,
         success_rate = EXCLUDED.success_rate,
         total_jobs = EXCLUDED.total_jobs,
         last_updated = EXCLUDED.last_updated,
         updated_at = NOW()`,
      [
        site,
        JSON.stringify(Object.fromEntries(pattern.commonIntents)),
        JSON.stringify(Object.fromEntries(pattern.commonSelectors)),
        pattern.commonFlows,
        pattern.successRate,
        pattern.totalJobs,
        pattern.lastUpdated,
      ]
    );
  }

  async getSitePattern(site: string): Promise<SitePattern | null> {
    const result = await this.pool.query('SELECT * FROM site_patterns WHERE site = $1', [site]);
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      site: row.site,
      commonIntents: new Map(Object.entries(row.common_intents || {})),
      commonSelectors: new Map(Object.entries(row.common_selectors || {})),
      commonFlows: row.common_flows || [],
      successRate: parseFloat(row.success_rate),
      totalJobs: row.total_jobs,
      lastUpdated: row.last_updated,
    };
  }

  async getAllSitePatterns(): Promise<Map<string, SitePattern>> {
    const result = await this.pool.query('SELECT * FROM site_patterns');
    const map = new Map<string, SitePattern>();

    for (const row of result.rows) {
      map.set(row.site, {
        site: row.site,
        commonIntents: new Map(Object.entries(row.common_intents || {})),
        commonSelectors: new Map(Object.entries(row.common_selectors || {})),
        commonFlows: row.common_flows || [],
        successRate: parseFloat(row.success_rate),
        totalJobs: row.total_jobs,
        lastUpdated: row.last_updated,
      });
    }

    return map;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

