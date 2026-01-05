import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

export interface TestCase {
  id: string;
  name: string;
  taskId: string;
  taskName?: string;
  targetUrl: string;
  expectedResult?: string;
  parameters?: Record<string, unknown>;
  lastRun?: number;
  lastResult?: 'pass' | 'fail' | 'pending';
  createdAt: number;
}

export interface TestRun {
  id: string;
  testCaseId: string;
  status: 'running' | 'passed' | 'failed';
  result?: any;
  startedAt: number;
  completedAt?: number;
}

/**
 * TestCaseManager: Manages test cases and test runs
 */
export class TestCaseManager {
  private testCases: Map<string, TestCase> = new Map();
  private testRuns: Map<string, TestRun> = new Map();
  private persistencePath: string;

  constructor(persistencePath?: string) {
    this.persistencePath = persistencePath || join(process.cwd(), 'data', 'test-cases.json');
    this.loadFromDisk();
  }

  /**
   * Create a test case
   */
  create(testCase: Omit<TestCase, 'id' | 'createdAt'>): TestCase {
    const id = randomUUID();
    const fullTestCase: TestCase = {
      ...testCase,
      id,
      createdAt: Date.now(),
    };
    this.testCases.set(id, fullTestCase);
    this.saveToDisk();
    return fullTestCase;
  }

  /**
   * Get test case by ID
   */
  get(id: string): TestCase | null {
    return this.testCases.get(id) || null;
  }

  /**
   * List all test cases
   */
  list(): TestCase[] {
    return Array.from(this.testCases.values());
  }

  /**
   * Update test case
   */
  update(id: string, updates: Partial<TestCase>): TestCase | null {
    const testCase = this.testCases.get(id);
    if (!testCase) return null;

    const updated = { ...testCase, ...updates };
    this.testCases.set(id, updated);
    this.saveToDisk();
    return updated;
  }

  /**
   * Delete test case
   */
  delete(id: string): boolean {
    const deleted = this.testCases.delete(id);
    if (deleted) {
      this.saveToDisk();
    }
    return deleted;
  }

  /**
   * Create a test run
   */
  createTestRun(testCaseId: string, status: 'running' | 'passed' | 'failed' = 'running'): TestRun {
    const id = randomUUID();
    const testRun: TestRun = {
      id,
      testCaseId,
      status,
      startedAt: Date.now(),
    };
    this.testRuns.set(id, testRun);
    return testRun;
  }

  /**
   * Update test run
   */
  updateTestRun(id: string, updates: Partial<TestRun>): TestRun | null {
    const testRun = this.testRuns.get(id);
    if (!testRun) return null;

    const updated = { ...testRun, ...updates };
    this.testRuns.set(id, updated);
    return updated;
  }

  /**
   * Get test runs
   */
  getTestRuns(limit?: number): TestRun[] {
    const runs = Array.from(this.testRuns.values());
    runs.sort((a, b) => b.startedAt - a.startedAt);
    return limit ? runs.slice(0, limit) : runs;
  }

  /**
   * Load from disk
   */
  private loadFromDisk(): void {
    try {
      if (existsSync(this.persistencePath)) {
        const data = readFileSync(this.persistencePath, 'utf-8');
        const parsed = JSON.parse(data);
        this.testCases = new Map((parsed.testCases || []).map((tc: TestCase) => [tc.id, tc]));
        this.testRuns = new Map((parsed.testRuns || []).map((tr: TestRun) => [tr.id, tr]));
      } else {
        // Ensure directory exists
        const dir = join(this.persistencePath, '..');
        if (dir && !existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
      }
    } catch (error) {
      console.error('Failed to load test cases from disk:', error);
    }
  }

  /**
   * Save to disk
   */
  private saveToDisk(): void {
    try {
      const dir = join(this.persistencePath, '..');
      if (dir && !existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const data = {
        testCases: Array.from(this.testCases.values()),
        testRuns: Array.from(this.testRuns.values()),
      };
      writeFileSync(this.persistencePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      console.error('Failed to save test cases to disk:', error);
    }
  }
}

