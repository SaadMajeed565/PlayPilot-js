import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

export interface ScheduledTask {
  id: string;
  taskId: string;
  taskName?: string;
  targetUrl: string;
  schedule: string; // Cron expression
  enabled: boolean;
  parameters?: Record<string, string>;
  lastRun?: number;
  nextRun?: number;
  createdAt: number;
}

/**
 * ScheduledTaskManager: Manages scheduled tasks
 */
export class ScheduledTaskManager {
  private tasks: Map<string, ScheduledTask> = new Map();
  private persistencePath: string;

  constructor(persistencePath?: string) {
    this.persistencePath = persistencePath || join(process.cwd(), 'data', 'scheduled-tasks.json');
    this.loadFromDisk();
  }

  /**
   * Create a scheduled task
   */
  create(task: Omit<ScheduledTask, 'id' | 'createdAt'>): ScheduledTask {
    const id = randomUUID();
    const fullTask: ScheduledTask = {
      ...task,
      id,
      createdAt: Date.now(),
    };
    this.tasks.set(id, fullTask);
    this.saveToDisk();
    return fullTask;
  }

  /**
   * Get task by ID
   */
  get(id: string): ScheduledTask | null {
    return this.tasks.get(id) || null;
  }

  /**
   * List all tasks
   */
  list(): ScheduledTask[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Update task
   */
  update(id: string, updates: Partial<ScheduledTask>): ScheduledTask | null {
    const task = this.tasks.get(id);
    if (!task) return null;

    const updated = { ...task, ...updates };
    this.tasks.set(id, updated);
    this.saveToDisk();
    return updated;
  }

  /**
   * Delete task
   */
  delete(id: string): boolean {
    const deleted = this.tasks.delete(id);
    if (deleted) {
      this.saveToDisk();
    }
    return deleted;
  }

  /**
   * Load from disk
   */
  private loadFromDisk(): void {
    try {
      if (existsSync(this.persistencePath)) {
        const data = readFileSync(this.persistencePath, 'utf-8');
        const tasks = JSON.parse(data);
        this.tasks = new Map((tasks || []).map((t: ScheduledTask) => [t.id, t]));
      } else {
        // Ensure directory exists
        const dir = join(this.persistencePath, '..');
        if (dir && !existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
      }
    } catch (error) {
      console.error('Failed to load scheduled tasks from disk:', error);
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

      const tasks = Array.from(this.tasks.values());
      writeFileSync(this.persistencePath, JSON.stringify(tasks, null, 2), 'utf-8');
    } catch (error) {
      console.error('Failed to save scheduled tasks to disk:', error);
    }
  }
}

