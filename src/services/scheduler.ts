/**
 * Scheduled Tasks System
 * Manages recurring announcements, reminders, and scheduled actions
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/logger';

const logger = createLogger('Scheduler');

/**
 * Task types
 */
export type TaskType = 'announcement' | 'reminder' | 'command' | 'custom';

/**
 * Task status
 */
export type TaskStatus = 'active' | 'paused' | 'completed';

/**
 * Scheduled task definition
 */
export interface ScheduledTask {
  id: string;
  name: string;
  type: TaskType;
  status: TaskStatus;
  /** Interval in milliseconds */
  intervalMs: number;
  /** Optional: specific times to run (HH:MM format) */
  scheduledTimes?: string[];
  /** Message to send or action to perform */
  action: TaskAction;
  /** Channel to send to (for announcements) */
  channel?: string;
  /** Minimum chat activity required (messages in last interval) */
  minChatActivity?: number;
  /** Created timestamp */
  createdAt: string;
  /** Last execution timestamp */
  lastRunAt?: string;
  /** Next scheduled run */
  nextRunAt?: string;
  /** Total executions */
  executionCount: number;
  /** Created by */
  createdBy?: string;
}

/**
 * Task action
 */
export interface TaskAction {
  type: 'message' | 'command' | 'callback';
  /** Message text or command to execute */
  content: string;
  /** For rotating messages */
  messages?: string[];
  /** Current message index for rotation */
  currentIndex?: number;
}

/**
 * Task execution result
 */
export interface TaskExecutionResult {
  taskId: string;
  success: boolean;
  executedAt: string;
  message?: string;
  error?: string;
}

/**
 * Scheduler configuration
 */
export interface SchedulerConfig {
  /** Check interval for scheduled tasks (ms) */
  checkIntervalMs: number;
  /** Default minimum chat activity */
  defaultMinChatActivity: number;
  /** Enable stream-only mode (only run when stream is live) */
  streamOnlyMode: boolean;
}

const DEFAULT_CONFIG: SchedulerConfig = {
  checkIntervalMs: 10000, // 10 seconds
  defaultMinChatActivity: 0,
  streamOnlyMode: false,
};

/**
 * Message sender function type
 */
export type MessageSender = (channel: string, message: string) => Promise<void>;

/**
 * Scheduler Manager
 */
export class SchedulerManager {
  private tasks: Map<string, ScheduledTask> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private config: SchedulerConfig;
  private dataPath: string;
  private messageSender: MessageSender | null = null;
  private checkInterval: NodeJS.Timeout | null = null;
  private chatActivityCount: Map<string, number> = new Map();
  private isStreamLive = false;
  private callbacks: Map<string, () => Promise<void>> = new Map();

  constructor(options?: {
    dataPath?: string;
    config?: Partial<SchedulerConfig>;
  }) {
    this.config = { ...DEFAULT_CONFIG, ...options?.config };
    this.dataPath = options?.dataPath || path.join(process.cwd(), 'dashboard', 'logs', 'scheduler.json');

    this.loadTasks();
    this.startCheckLoop();
  }

  /**
   * Set the message sender function
   */
  setMessageSender(sender: MessageSender): void {
    this.messageSender = sender;
    logger.info('Message sender configured');
  }

  /**
   * Register a callback for custom task actions
   */
  registerCallback(name: string, callback: () => Promise<void>): void {
    this.callbacks.set(name, callback);
  }

  /**
   * Update stream status
   */
  setStreamStatus(isLive: boolean): void {
    this.isStreamLive = isLive;
    logger.debug('Stream status updated', { isLive });
  }

  /**
   * Track chat activity
   */
  trackChatActivity(channel: string): void {
    const current = this.chatActivityCount.get(channel) || 0;
    this.chatActivityCount.set(channel, current + 1);
  }

  /**
   * Load tasks from file
   */
  private loadTasks(): void {
    try {
      if (fs.existsSync(this.dataPath)) {
        const content = fs.readFileSync(this.dataPath, 'utf-8');
        const data = JSON.parse(content);

        if (data.tasks && Array.isArray(data.tasks)) {
          for (const task of data.tasks) {
            this.tasks.set(task.id, task);
          }
        }

        if (data.config) {
          this.config = { ...this.config, ...data.config };
        }

        logger.info('Loaded scheduled tasks', { count: this.tasks.size });
      }
    } catch (error) {
      logger.error('Failed to load scheduled tasks', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Save tasks to file
   */
  saveTasks(): void {
    try {
      const dir = path.dirname(this.dataPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const data = {
        tasks: Array.from(this.tasks.values()),
        config: this.config,
        savedAt: new Date().toISOString(),
      };

      fs.writeFileSync(this.dataPath, JSON.stringify(data, null, 2));
      logger.debug('Saved scheduled tasks');
    } catch (error) {
      logger.error('Failed to save scheduled tasks', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Generate unique task ID
   */
  private generateId(): string {
    return `task_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Start the check loop
   */
  private startCheckLoop(): void {
    this.checkInterval = setInterval(() => {
      this.checkAndExecuteTasks();
    }, this.config.checkIntervalMs);
  }

  /**
   * Check and execute due tasks
   */
  private async checkAndExecuteTasks(): Promise<void> {
    const now = Date.now();

    for (const task of this.tasks.values()) {
      if (task.status !== 'active') continue;

      // Check stream-only mode
      if (this.config.streamOnlyMode && !this.isStreamLive) continue;

      // Check if task is due
      const nextRunTime = task.nextRunAt ? new Date(task.nextRunAt).getTime() : 0;
      if (nextRunTime > now) continue;

      // Check chat activity requirement
      if (task.minChatActivity && task.minChatActivity > 0 && task.channel) {
        const activity = this.chatActivityCount.get(task.channel) || 0;
        if (activity < task.minChatActivity) {
          // Reschedule without resetting activity counter
          task.nextRunAt = new Date(now + task.intervalMs).toISOString();
          continue;
        }
      }

      // Execute task
      await this.executeTask(task);

      // Reset chat activity counter for this channel
      if (task.channel) {
        this.chatActivityCount.set(task.channel, 0);
      }

      // Update next run time
      task.lastRunAt = new Date().toISOString();
      task.nextRunAt = new Date(now + task.intervalMs).toISOString();
      task.executionCount++;
    }

    this.saveTasks();
  }

  /**
   * Execute a task
   */
  private async executeTask(task: ScheduledTask): Promise<TaskExecutionResult> {
    const result: TaskExecutionResult = {
      taskId: task.id,
      success: false,
      executedAt: new Date().toISOString(),
    };

    try {
      switch (task.action.type) {
        case 'message':
          if (!this.messageSender) {
            throw new Error('Message sender not configured');
          }
          if (!task.channel) {
            throw new Error('No channel specified for message task');
          }

          let message = task.action.content;

          // Handle rotating messages
          if (task.action.messages && task.action.messages.length > 0) {
            const index = task.action.currentIndex || 0;
            message = task.action.messages[index];
            task.action.currentIndex = (index + 1) % task.action.messages.length;
          }

          await this.messageSender(task.channel, message);
          result.success = true;
          result.message = message;
          break;

        case 'callback':
          const callback = this.callbacks.get(task.action.content);
          if (!callback) {
            throw new Error(`Callback "${task.action.content}" not registered`);
          }
          await callback();
          result.success = true;
          break;

        default:
          throw new Error(`Unknown action type: ${task.action.type}`);
      }

      logger.debug('Task executed', { taskId: task.id, type: task.type });
    } catch (error) {
      result.error = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Task execution failed', {
        taskId: task.id,
        error: result.error,
      });
    }

    return result;
  }

  // ==================== Task Management ====================

  /**
   * Create a new task
   */
  createTask(options: {
    name: string;
    type: TaskType;
    intervalMs: number;
    action: TaskAction;
    channel?: string;
    minChatActivity?: number;
    scheduledTimes?: string[];
    createdBy?: string;
  }): ScheduledTask {
    const task: ScheduledTask = {
      id: this.generateId(),
      name: options.name,
      type: options.type,
      status: 'active',
      intervalMs: options.intervalMs,
      action: options.action,
      channel: options.channel,
      minChatActivity: options.minChatActivity ?? this.config.defaultMinChatActivity,
      scheduledTimes: options.scheduledTimes,
      createdAt: new Date().toISOString(),
      nextRunAt: new Date(Date.now() + options.intervalMs).toISOString(),
      executionCount: 0,
      createdBy: options.createdBy,
    };

    this.tasks.set(task.id, task);
    this.saveTasks();

    logger.info('Task created', { id: task.id, name: task.name, type: task.type });
    return task;
  }

  /**
   * Create an announcement task
   */
  createAnnouncement(options: {
    name: string;
    message: string;
    messages?: string[];
    channel: string;
    intervalMinutes: number;
    minChatActivity?: number;
    createdBy?: string;
  }): ScheduledTask {
    return this.createTask({
      name: options.name,
      type: 'announcement',
      intervalMs: options.intervalMinutes * 60 * 1000,
      action: {
        type: 'message',
        content: options.message,
        messages: options.messages,
        currentIndex: 0,
      },
      channel: options.channel,
      minChatActivity: options.minChatActivity,
      createdBy: options.createdBy,
    });
  }

  /**
   * Get a task by ID
   */
  getTask(id: string): ScheduledTask | null {
    return this.tasks.get(id) || null;
  }

  /**
   * Get all tasks
   */
  getAllTasks(): ScheduledTask[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Get tasks by type
   */
  getTasksByType(type: TaskType): ScheduledTask[] {
    return Array.from(this.tasks.values()).filter((t) => t.type === type);
  }

  /**
   * Get active tasks
   */
  getActiveTasks(): ScheduledTask[] {
    return Array.from(this.tasks.values()).filter((t) => t.status === 'active');
  }

  /**
   * Update a task
   */
  updateTask(
    id: string,
    updates: Partial<Omit<ScheduledTask, 'id' | 'createdAt'>>
  ): ScheduledTask | null {
    const task = this.tasks.get(id);
    if (!task) return null;

    Object.assign(task, updates);
    this.saveTasks();

    logger.info('Task updated', { id });
    return task;
  }

  /**
   * Pause a task
   */
  pauseTask(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;

    task.status = 'paused';
    this.saveTasks();

    logger.info('Task paused', { id, name: task.name });
    return true;
  }

  /**
   * Resume a task
   */
  resumeTask(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;

    task.status = 'active';
    task.nextRunAt = new Date(Date.now() + task.intervalMs).toISOString();
    this.saveTasks();

    logger.info('Task resumed', { id, name: task.name });
    return true;
  }

  /**
   * Delete a task
   */
  deleteTask(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;

    this.tasks.delete(id);
    this.saveTasks();

    logger.info('Task deleted', { id, name: task.name });
    return true;
  }

  /**
   * Execute a task immediately
   */
  async executeTaskNow(id: string): Promise<TaskExecutionResult | null> {
    const task = this.tasks.get(id);
    if (!task) return null;

    const result = await this.executeTask(task);

    task.lastRunAt = new Date().toISOString();
    task.executionCount++;
    this.saveTasks();

    return result;
  }

  // ==================== Configuration ====================

  /**
   * Get configuration
   */
  getConfig(): SchedulerConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<SchedulerConfig>): void {
    this.config = { ...this.config, ...updates };

    // Restart check loop if interval changed
    if (updates.checkIntervalMs && this.checkInterval) {
      clearInterval(this.checkInterval);
      this.startCheckLoop();
    }

    this.saveTasks();
    logger.info('Scheduler config updated');
  }

  // ==================== Statistics ====================

  /**
   * Get scheduler statistics
   */
  getStatistics(): {
    totalTasks: number;
    activeTasks: number;
    pausedTasks: number;
    totalExecutions: number;
    tasksByType: Record<TaskType, number>;
  } {
    const tasks = Array.from(this.tasks.values());

    const tasksByType: Record<TaskType, number> = {
      announcement: 0,
      reminder: 0,
      command: 0,
      custom: 0,
    };

    for (const task of tasks) {
      tasksByType[task.type]++;
    }

    return {
      totalTasks: tasks.length,
      activeTasks: tasks.filter((t) => t.status === 'active').length,
      pausedTasks: tasks.filter((t) => t.status === 'paused').length,
      totalExecutions: tasks.reduce((sum, t) => sum + t.executionCount, 0),
      tasksByType,
    };
  }

  /**
   * Clean up
   */
  destroy(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();

    this.saveTasks();
    logger.info('Scheduler destroyed');
  }
}

// Singleton
let defaultManager: SchedulerManager | null = null;

export function getSchedulerManager(): SchedulerManager {
  if (!defaultManager) {
    defaultManager = new SchedulerManager();
  }
  return defaultManager;
}

export function resetSchedulerManager(): void {
  if (defaultManager) {
    defaultManager.destroy();
    defaultManager = null;
  }
}
