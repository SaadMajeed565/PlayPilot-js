import type { ChromeRecorderJSON, CanonicalAction } from '../types/index.js';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { LauncherPageGenerator } from './LauncherPageGenerator.js';

/**
 * Website: Represents a domain/website being automated
 */
export interface Website {
  id: string;
  domain: string; // e.g., "facebook.com"
  name: string; // Display name, e.g., "Facebook"
  description?: string;
  tasks: Task[]; // Tasks for this website
  createdAt: number;
  updatedAt: number;
  totalRecordings: number;
  successRate: number;
}

/**
 * Task: A specific automation goal for a website
 */
export interface Task {
  id: string;
  websiteId: string;
  name: string;
  description: string;
  recordings: TaskRecording[];
  createdAt: number;
  updatedAt: number;
  successRate: number;
  totalExecutions: number;
}

/**
 * Task Recording: A single recording of a task
 */
export interface TaskRecording {
  id: string;
  taskId: string;
  recorderJSON: ChromeRecorderJSON;
  actions: CanonicalAction[];
  targetUrl?: string;
  success: boolean;
  recordedAt: number;
}

/**
 * Website Manager: Manages websites, their tasks, and recordings
 * 
 * Hierarchy: Website → Tasks → Recordings
 */
export class WebsiteManager {
  private websites: Map<string, Website> = new Map();
  private persistencePath: string;
  private launcherGenerator: LauncherPageGenerator;

  constructor(persistencePath?: string) {
    this.persistencePath = persistencePath || join(process.cwd(), 'data', 'websites.json');
    this.launcherGenerator = LauncherPageGenerator.getInstance();
    this.loadFromDisk();
  }

  /**
   * Load websites from disk
   */
  private loadFromDisk(): void {
    try {
      if (existsSync(this.persistencePath)) {
        const data = readFileSync(this.persistencePath, 'utf-8');
        const websitesArray = JSON.parse(data) as Website[];
        // Migrate old data: initialize successfulExecutions for tasks that don't have it
        for (const website of websitesArray) {
          for (const task of website.tasks) {
            if (!(task as any).successfulExecutions) {
              // If we have totalExecutions but no successfulExecutions, estimate from successRate
              if (task.totalExecutions > 0 && task.successRate > 0) {
                (task as any).successfulExecutions = Math.round(task.totalExecutions * task.successRate);
              } else {
                (task as any).successfulExecutions = 0;
              }
            }
          }
          // Recalculate website stats after migration
          this.recalculateWebsiteStats(website);
        }
        this.websites = new Map(websitesArray.map(w => [w.id, w]));
        // Update launcher page after loading websites
        this.updateLauncherPage();
      } else {
        // Ensure directory exists
        const dir = join(this.persistencePath, '..');
        if (dir && !existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        // Create empty launcher page if no websites exist
        this.updateLauncherPage();
      }
    } catch (error) {
      console.error('Failed to load websites from disk:', error);
      // Continue with empty map if loading fails
      // Still try to create launcher page
      this.updateLauncherPage();
    }
  }

  /**
   * Save websites to disk
   */
  private saveToDisk(): void {
    try {
      const dir = join(this.persistencePath, '..');
      if (dir && !existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const websitesArray = Array.from(this.websites.values());
      writeFileSync(this.persistencePath, JSON.stringify(websitesArray, null, 2), 'utf-8');
    } catch (error) {
      console.error('Failed to save websites to disk:', error);
    }
  }

  /**
   * Create a new website
   */
  createWebsite(domain: string, name: string, description?: string): string {
    const websiteId = randomUUID();
    const website: Website = {
      id: websiteId,
      domain: this.normalizeDomain(domain),
      name,
      description,
      tasks: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      totalRecordings: 0,
      successRate: 0,
    };

    this.websites.set(websiteId, website);
    this.saveToDisk();
    // Update launcher page with new website
    this.updateLauncherPage();
    return websiteId;
  }

  /**
   * Get website by ID
   */
  getWebsite(websiteId: string): Website | null {
    return this.websites.get(websiteId) || null;
  }

  /**
   * Delete a website and all its tasks and recordings
   */
  deleteWebsite(websiteId: string): void {
    const website = this.websites.get(websiteId);
    if (!website) {
      throw new Error(`Website ${websiteId} not found`);
    }

    // Delete all tasks and recordings for this website
    // (They're stored within the website object, so deleting the website removes everything)
    this.websites.delete(websiteId);
    this.saveToDisk();
    // Update launcher page after deletion
    this.updateLauncherPage();
  }

  /**
   * Get website by domain
   */
  getWebsiteByDomain(domain: string): Website | null {
    const normalizedDomain = this.normalizeDomain(domain);
    for (const website of this.websites.values()) {
      if (website.domain === normalizedDomain) {
        return website;
      }
    }
    return null;
  }

  /**
   * Get all websites
   */
  getAllWebsites(): Website[] {
    return Array.from(this.websites.values());
  }

  /**
   * Create a task for a website
   */
  createTask(websiteId: string, name: string, description: string): string {
    const website = this.websites.get(websiteId);
    if (!website) {
      throw new Error(`Website ${websiteId} not found`);
    }

    const taskId = randomUUID();
    const task: Task = {
      id: taskId,
      websiteId,
      name,
      description,
      recordings: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      successRate: 0,
      totalExecutions: 0,
    };
    // Initialize successful executions counter
    (task as any).successfulExecutions = 0;

    website.tasks.push(task);
    website.updatedAt = Date.now();
    this.saveToDisk();
    return taskId;
  }

  /**
   * Get task by ID
   */
  getTask(taskId: string): { website: Website; task: Task } | null {
    for (const website of this.websites.values()) {
      const task = website.tasks.find(t => t.id === taskId);
      if (task) {
        return { website, task };
      }
    }
    return null;
  }

  /**
   * Get all tasks for a website
   */
  getWebsiteTasks(websiteId: string): Task[] {
    const website = this.websites.get(websiteId);
    return website ? website.tasks : [];
  }

  /**
   * Add recording to a task
   */
  addRecording(
    taskId: string,
    recorderJSON: ChromeRecorderJSON,
    actions: CanonicalAction[],
    success: boolean,
    targetUrl?: string
  ): string {
    const taskData = this.getTask(taskId);
    if (!taskData) {
      throw new Error(`Task ${taskId} not found`);
    }

    const { website, task } = taskData;
    const recordingId = randomUUID();
    const recording: TaskRecording = {
      id: recordingId,
      taskId,
      recorderJSON,
      actions,
      targetUrl,
      success,
      recordedAt: Date.now(),
    };

    task.recordings.push(recording);
    task.updatedAt = Date.now();
    this.recalculateStats(website);
    this.saveToDisk();
    return recordingId;
  }

  /**
   * Update an existing recording on a task
   */
  updateRecording(
    taskId: string,
    recordingId: string,
    updates: Partial<Pick<TaskRecording, 'recorderJSON' | 'actions' | 'targetUrl' | 'success'>>
  ): TaskRecording {
    const taskData = this.getTask(taskId);
    if (!taskData) {
      throw new Error(`Task ${taskId} not found`);
    }

    const { website, task } = taskData;
    const recordingIndex = task.recordings.findIndex(r => r.id === recordingId);
    if (recordingIndex === -1) {
      throw new Error(`Recording ${recordingId} not found for task ${taskId}`);
    }

    const current = task.recordings[recordingIndex];
    const updated: TaskRecording = {
      ...current,
      ...updates,
      // Keep recordedAt stable unless explicitly changed in future
      recordedAt: current.recordedAt,
    };

    task.recordings[recordingIndex] = updated;
    task.updatedAt = Date.now();
    this.recalculateStats(website);
    this.saveToDisk();
    return updated;
  }

  /**
   * Delete a recording from a task
   */
  deleteRecording(taskId: string, recordingId: string): void {
    const taskData = this.getTask(taskId);
    if (!taskData) {
      throw new Error(`Task ${taskId} not found`);
    }

    const { website, task } = taskData;
    const beforeCount = task.recordings.length;
    task.recordings = task.recordings.filter(r => r.id !== recordingId);

    if (task.recordings.length === beforeCount) {
      throw new Error(`Recording ${recordingId} not found for task ${taskId}`);
    }

    task.updatedAt = Date.now();
    this.recalculateStats(website);
    this.saveToDisk();
  }

  /**
   * Get a specific recording for a task
   */
  getRecording(taskId: string, recordingId: string): { website: Website; task: Task; recording: TaskRecording } | null {
    const taskData = this.getTask(taskId);
    if (!taskData) {
      return null;
    }

    const recording = taskData.task.recordings.find(r => r.id === recordingId);
    if (!recording) {
      return null;
    }

    return { ...taskData, recording };
  }

  /**
   * Get best recording for a task
   */
  getBestRecording(taskId: string): TaskRecording | null {
    const taskData = this.getTask(taskId);
    if (!taskData) return null;

    const { task } = taskData;
    if (task.recordings.length === 0) return null;

    // Return most recent successful recording, or most recent if none successful
    const successful = task.recordings.filter(r => r.success);
    if (successful.length > 0) {
      return successful.sort((a, b) => b.recordedAt - a.recordedAt)[0];
    }

    return task.recordings.sort((a, b) => b.recordedAt - a.recordedAt)[0];
  }

  /**
   * Update task execution stats
   */
  recordExecution(taskId: string, success: boolean): void {
    const taskData = this.getTask(taskId);
    if (!taskData) return;

    const { website, task } = taskData;
    task.totalExecutions++;
    
    // Calculate success rate based on actual executions
    // Track successful executions separately
    if (!(task as any).successfulExecutions) {
      (task as any).successfulExecutions = 0;
    }
    if (success) {
      (task as any).successfulExecutions++;
    }
    
    task.successRate = task.totalExecutions > 0
      ? (task as any).successfulExecutions / task.totalExecutions
      : 0;
    
    task.updatedAt = Date.now();
    this.recalculateWebsiteStats(website);
    this.saveToDisk();
  }

  /**
   * Normalize domain (remove protocol, www, trailing slash)
   */
  private normalizeDomain(domain: string): string {
    try {
      // If it's a full URL, extract domain
      if (domain.includes('://')) {
        const url = new URL(domain);
        return url.hostname.replace(/^www\./, '');
      }
      // If it's just a domain, clean it up
      return domain.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
    } catch {
      // If parsing fails, return cleaned domain
      return domain.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
    }
  }

  /**
   * Close and save all data
   */
  close(): void {
    this.saveToDisk();
  }

  /**
   * Recalculate task and website level statistics (based on recordings)
   * Note: Task execution success rates are maintained separately via recordExecution
   */
  private recalculateStats(website: Website): void {
    // Update website totals (recording count)
    const allRecordings = website.tasks.flatMap(t => t.recordings);
    website.totalRecordings = allRecordings.length;
    website.updatedAt = Date.now();

    // Don't update task success rates here - they're based on executions, not recordings
    // Task success rates are only updated via recordExecution()
    
    // Recalculate website success rate based on task execution success rates
    this.recalculateWebsiteStats(website);
  }

  /**
   * Update launcher page with current websites
   */
  private updateLauncherPage(): void {
    try {
      const websites = Array.from(this.websites.values());
      this.launcherGenerator.updateLauncherPage(websites);
    } catch (error) {
      // Don't fail if launcher page update fails
      console.warn('Failed to update launcher page:', error);
    }
  }

  /**
   * Get launcher page URL for automation
   */
  getLauncherUrl(): string {
    return this.launcherGenerator.getLauncherUrl();
  }

  /**
   * Recalculate website-level statistics based on task execution success rates
   */
  private recalculateWebsiteStats(website: Website): void {
    // Calculate website success rate as weighted average of task execution success rates
    // Weight by number of executions per task
    let totalExecutions = 0;
    let totalSuccessfulExecutions = 0;
    
    for (const task of website.tasks) {
      const taskExecutions = task.totalExecutions || 0;
      const taskSuccessfulExecutions = (task as any).successfulExecutions || 0;
      totalExecutions += taskExecutions;
      totalSuccessfulExecutions += taskSuccessfulExecutions;
    }
    
    // Website success rate is based on actual task executions, not recordings
    website.successRate = totalExecutions > 0
      ? totalSuccessfulExecutions / totalExecutions
      : 0;
    
    website.updatedAt = Date.now();
  }
}

