/**
 * Type definitions for the AI-driven web automation system
 */

// Chrome Recorder JSON types
export interface ChromeRecorderStep {
  type:
    | 'click'
    | 'input'
    | 'navigate'
    | 'waitForSelector'
    | 'waitForTimeout'
    | 'wait'
    | 'pause'
    | 'assert'
    | 'scroll'
    | 'change'
    | 'keyDown'
    | 'keyUp'
    | 'scrape';
  selector?: string;
  text?: string;
  value?: string;
  url?: string;
  frame?: string;
  timestamp?: number;
  target?: string;
  key?: string;
  offsetX?: number;
  offsetY?: number;
  // Scraping fields (used when type is 'scrape')
  dataKey?: string; // Key name for storing scraped data
  attribute?: string; // 'text', 'innerHTML', 'href', 'src', or any attribute name
  multiple?: boolean; // Extract all matching elements or just first
  // Structured scraping fields (for complex objects)
  structure?: ScrapeField[]; // Array of fields to extract for structured data
  containerSelector?: string; // Container selector when extracting multiple structured objects
}

/**
 * ScrapeField: Definition for a single field in structured scraping
 */
export interface ScrapeField {
  key: string; // Field name in the output object
  selector: string; // CSS selector relative to container (or absolute if no container)
  attribute?: string; // 'text', 'innerHTML', 'href', 'src', or any attribute name (default: 'text')
  required?: boolean; // Whether this field is required (default: false)
  transform?: string; // Transformation function name (e.g., 'extractTime', 'isSentByMe') or custom logic
}

export interface ChromeRecorderJSON {
  title?: string;
  steps: ChromeRecorderStep[];
  url?: string;
  metadata?: {
    source?: string;
    version?: string;
  };
}

// Canonical Action types
export type SelectorStrategy =
  | 'css'
  | 'xpath'
  | 'text'
  | 'role'
  | 'testId'
  | 'label'
  | 'visual'
  | 'semantic'
  | 'structure'
  | 'heuristic'
  | 'learned';

export interface Target {
  selector?: string;
  strategy: SelectorStrategy;
  value?: string;
  fallbacks?: Target[];
}

export interface CanonicalStep {
  action: 'fill' | 'click' | 'navigate' | 'waitFor' | 'assert' | 'scroll' | 'select' | 'hover' | 'press';
  target?: Target;
  value?: string;
  timeout?: number;
  options?: Record<string, unknown>;
}

export interface CanonicalAction {
  intent: string;
  steps: CanonicalStep[];
  metadata: {
    source: string;
    site?: string;
    confidence?: number;
  };
  preconditions?: string[];
  postconditions?: string[];
}

// Skill types
export interface SkillSpec {
  name: string;
  description: string;
  inputs: Array<{
    name: string;
    type: string;
    required: boolean;
    description?: string;
  }>;
  outputs: Array<{
    name: string;
    type: string;
    description?: string;
  }>;
  steps: CanonicalStep[];
  retryPolicy: {
    maxRetries: number;
    backoff: 'exponential' | 'linear' | 'fixed';
    baseDelay: number;
  };
  safetyChecks: string[];
  rateLimit?: {
    perHost?: number;
    global?: number;
    windowMs?: number;
  };
}

// Playwright Command types
export type PlaywrightCommandType = 
  | 'goto' 
  | 'fill' 
  | 'click' 
  | 'waitFor' 
  | 'select' 
  | 'press' 
  | 'hover' 
  | 'scroll' 
  | 'evaluate'
  | 'screenshot';

export interface PlaywrightCommand {
  cmd: PlaywrightCommandType;
  args: unknown[];
  options?: {
    timeout?: number;
    retries?: number;
    delay?: number;
    waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  };
}

export interface PlaywrightCommandPlan {
  type: 'playwright';
  commands: PlaywrightCommand[];
  metadata?: {
    jobId?: string;
    site?: string;
    intent?: string;
  };
}

// Selector Healing types
export interface SelectorCandidate {
  selector: string;
  strategy: SelectorStrategy;
  score: number;
  factors: {
    textMatch: number;
    attributeMatch: number;
    domDepth: number;
    roleMatch: number;
    historyScore: number;
    stabilityScore?: number; // How stable selector is over time
    uniquenessScore?: number; // How specific/unique the selector is
    performanceScore?: number; // How fast selector resolves
  };
  metadata?: {
    generatedAt?: number;
    source?: 'learned' | 'structure' | 'visual' | 'semantic' | 'heuristic' | 'text';
    confidence?: number;
  };
}

export interface SelectorStability {
  selector: string;
  site: string;
  stabilityScore: number; // 0-1, how often selector changes
  changeFrequency: number; // Times changed per day
  lastChange: number;
  averageLifespan: number; // Average days before breaking
}

export interface ChallengePattern {
  site: string;
  challengeType: 'cloudflare' | 'captcha' | 'error' | 'rate_limit' | 'blocked';
  timePattern?: {
    hour?: number[];
    dayOfWeek?: number[];
  };
  triggerPattern?: string[]; // What triggers this challenge
  recoveryStrategy: string;
  successRate: number;
  lastSeen: number;
  occurrences: number;
}

// Executor types
export type ExecutionStatus = 'pending' | 'running' | 'success' | 'failed' | 'retrying' | 'blocked' | 'captcha';

export interface ExecutionResult {
  status: ExecutionStatus;
  jobId: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  commands: Array<{
    command: PlaywrightCommand;
    status: 'success' | 'failed' | 'skipped';
    duration: number;
    error?: string;
    screenshot?: string;
  }>;
  artifacts?: {
    screenshots?: string[];
    har?: string;
    domSnapshot?: string;
  };
  error?: string;
  metrics?: {
    selectorHealingAttempts?: number;
    selectorHealingSuccesses?: number;
    retries?: number;
  };
}

// Telemetry types
export interface TelemetryEvent {
  timestamp: number;
  type: 'command' | 'selector_healing' | 'retry' | 'error' | 'success' | 'rate_limit';
  data: Record<string, unknown>;
  jobId?: string;
}

// Memory store types
export interface SelectorHistory {
  site: string;
  originalSelector: string;
  healedSelector: string;
  strategy: SelectorStrategy;
  successCount: number;
  failureCount: number;
  lastUsed: number;
}

export interface SkillTemplate {
  intent: string;
  skillSpec: SkillSpec;
  successRate: number;
  usageCount: number;
  lastUpdated: number;
  patterns?: {
    commonSelectors?: string[];
    optimalTimings?: {
      waitTime?: number;
      retryDelay?: number;
    };
    siteTypes?: string[]; // Types of sites this works on
  };
}

export interface RetryStrategy {
  errorType: 'network' | 'selector' | 'timeout' | '403' | '500' | 'other';
  maxRetries: number;
  backoffType: 'exponential' | 'linear' | 'fibonacci' | 'fixed';
  baseDelay: number;
  maxDelay?: number;
  jitter?: boolean; // Add randomness to avoid thundering herd
  adaptive?: boolean; // Learn optimal retry counts
}

export interface StrategyPerformance {
  strategyId: string;
  strategyType: 'selector' | 'retry' | 'navigation' | 'wait';
  successRate: number;
  averageTime: number;
  usageCount: number;
  lastUpdated: number;
  site?: string;
  context?: Record<string, unknown>;
}

// Job types
export interface Job {
  id: string;
  status: ExecutionStatus;
  recorderJSON: ChromeRecorderJSON;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  result?: ExecutionResult;
  error?: string;
}

// API types
export interface SubmitJobRequest {
  recorderJSON: ChromeRecorderJSON;
  options?: {
    timeout?: number;
    retries?: number;
    debug?: boolean;
  };
}

export interface SubmitJobResponse {
  jobId: string;
  status: ExecutionStatus;
  estimatedDuration?: number;
}

export interface JobStatusResponse {
  jobId: string;
  status: ExecutionStatus;
  progress?: number;
  result?: ExecutionResult;
  logs?: string[];
}

// Task types (moved from TaskManager.ts)
export interface Task {
  id: string;
  name: string;
  description: string;
  recordings: TaskRecording[];
  createdAt: number;
  updatedAt: number;
  successRate: number;
  totalExecutions: number;
  websiteId?: string; // Added for WebsiteManager compatibility
}

export interface TaskRecording {
  id: string;
  recorderJSON: ChromeRecorderJSON;
  actions: CanonicalAction[];
  targetUrl?: string;
  success: boolean;
  recordedAt: number;
}

