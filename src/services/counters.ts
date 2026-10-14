/**
 * Counters System
 * Track deaths, wins, losses, and custom counters
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/logger';
import { updateJsonFileSync } from '../lib/file-lock';

const logger = createLogger('Counters');

/**
 * Counter data structure
 */
export interface Counter {
  name: string;
  value: number;
  createdAt: string;
  createdBy: string;
  lastModifiedAt: string;
  lastModifiedBy: string;
  description?: string;
}

/**
 * Counter history entry
 */
export interface CounterHistoryEntry {
  counterName: string;
  previousValue: number;
  newValue: number;
  change: number;
  modifiedBy: string;
  timestamp: string;
  reason?: string;
}

/**
 * Counters manager configuration
 */
export interface CountersConfig {
  /** Maximum number of counters */
  maxCounters: number;
  /** Maximum counter value */
  maxValue: number;
  /** Minimum counter value (can be negative) */
  minValue: number;
  /** Keep history of changes */
  keepHistory: boolean;
  /** Maximum history entries per counter */
  maxHistoryEntries: number;
}

/**
 * Shape of counters.json (shared with the dashboard)
 */
interface CountersFileData {
  counters?: Record<string, Counter>;
  history?: CounterHistoryEntry[];
  config?: Partial<CountersConfig>;
  savedAt?: string;
  [key: string]: unknown;
}

const DEFAULT_CONFIG: CountersConfig = {
  maxCounters: 100,
  maxValue: 999999,
  minValue: -999999,
  keepHistory: true,
  maxHistoryEntries: 100,
};

/**
 * Counters manager class
 */
export class CountersManager {
  private counters: Map<string, Counter>;
  private history: CounterHistoryEntry[];
  private config: CountersConfig;
  private dataPath: string;
  private dirty: boolean = false;
  private saveInterval: NodeJS.Timeout | null = null;

  // Merge-on-save state: counter values as of the last load/save, so a save
  // applies increments as deltas and explicit sets as absolute values
  private baseline: Map<string, number> = new Map();
  private absoluteValues: Set<string> = new Set();
  private pendingHistory: CounterHistoryEntry[] = [];
  private replacedAll: boolean = false;
  private configDirty: boolean = false;
  private lastSyncedMtimeMs: number = 0;

  constructor(options?: {
    dataPath?: string;
    config?: Partial<CountersConfig>;
    autoSaveIntervalMs?: number;
  }) {
    this.counters = new Map();
    this.history = [];
    this.config = { ...DEFAULT_CONFIG, ...options?.config };
    this.dataPath = options?.dataPath || path.join(process.cwd(), 'dashboard', 'logs', 'counters.json');

    this.loadData();

    // Auto-save periodically
    const autoSaveInterval = options?.autoSaveIntervalMs ?? 60000;
    if (autoSaveInterval > 0) {
      this.saveInterval = setInterval(() => this.saveIfDirty(), autoSaveInterval);
    }

    // Create default counters if none exist
    if (this.counters.size === 0) {
      this.createDefaultCounters();
    }
  }

  /**
   * Create default counters
   */
  private createDefaultCounters(): void {
    const defaults = [
      { name: 'deaths', description: 'Death counter for the current game' },
      { name: 'wins', description: 'Win counter' },
      { name: 'losses', description: 'Loss counter' },
    ];

    for (const def of defaults) {
      if (!this.counters.has(def.name)) {
        this.counters.set(def.name, {
          name: def.name,
          value: 0,
          createdAt: new Date().toISOString(),
          createdBy: 'system',
          lastModifiedAt: new Date().toISOString(),
          lastModifiedBy: 'system',
          description: def.description,
        });
      }
    }
    this.dirty = true;
  }

  /**
   * Load counters from file
   */
  private loadData(): void {
    try {
      if (fs.existsSync(this.dataPath)) {
        const content = fs.readFileSync(this.dataPath, 'utf-8');
        const parsed = JSON.parse(content);

        if (parsed.counters) {
          this.counters = new Map(Object.entries(parsed.counters));
        }
        if (parsed.history) {
          this.history = parsed.history;
        }
        if (parsed.config) {
          this.config = { ...this.config, ...parsed.config };
        }

        this.baseline = this.snapshotValues();
        this.lastSyncedMtimeMs = this.getFileMtime();
        logger.info('Loaded counters', { count: this.counters.size });
      }
    } catch (error) {
      logger.error('Failed to load counters', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  private snapshotValues(): Map<string, number> {
    return new Map(Array.from(this.counters, ([name, counter]) => [name, counter.value]));
  }

  private getFileMtime(): number {
    try {
      return fs.statSync(this.dataPath).mtimeMs;
    } catch {
      return 0;
    }
  }

  private clamp(value: number, config: CountersConfig): number {
    return Math.max(config.minValue, Math.min(config.maxValue, value));
  }

  /**
   * Apply this process's changes since the last sync onto the file's current contents
   */
  private mergeInto(current: CountersFileData | null): CountersFileData {
    const config = this.configDirty ? this.config : { ...this.config, ...(current?.config ?? {}) };

    if (this.replacedAll || !current) {
      return {
        ...(current ?? {}),
        counters: Object.fromEntries(this.counters),
        history: this.history.slice(-config.maxHistoryEntries * this.counters.size),
        config,
        savedAt: new Date().toISOString(),
      };
    }

    const counters: Record<string, Counter> = { ...(current.counters ?? {}) };
    const deleted = new Set(Array.from(this.baseline.keys()).filter((name) => !this.counters.has(name)));
    for (const name of deleted) {
      delete counters[name];
    }

    for (const [name, counter] of this.counters) {
      const base = this.baseline.get(name);
      const onDisk = counters[name];
      const absolute = this.absoluteValues.has(name);

      if (!onDisk) {
        if (base === undefined || counter.value !== base || absolute) {
          counters[name] = { ...counter };
        }
        continue;
      }

      const delta = counter.value - (base ?? 0);
      if (!absolute && delta === 0) {
        continue;
      }

      counters[name] = {
        ...onDisk,
        value: absolute ? counter.value : this.clamp(onDisk.value + delta, config),
        lastModifiedAt: counter.lastModifiedAt,
        lastModifiedBy: counter.lastModifiedBy,
      };
    }

    const counterCount = Object.keys(counters).length;
    const history = [...(current.history ?? []), ...this.pendingHistory]
      .filter((h) => !deleted.has(h.counterName))
      .slice(-config.maxHistoryEntries * counterCount);

    return {
      ...current,
      counters,
      history,
      config,
      savedAt: new Date().toISOString(),
    };
  }

  /**
   * Save counters to file
   */
  saveData(): void {
    try {
      const dir = path.dirname(this.dataPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Lock, re-read and merge, so changes the dashboard made since our last
      // sync are kept. Throws without writing if the file can't be parsed.
      const merged = updateJsonFileSync<CountersFileData>(this.dataPath, (current) => this.mergeInto(current))!;

      this.counters = new Map(Object.entries(merged.counters ?? {}));
      this.history = merged.history ?? [];
      this.config = { ...this.config, ...merged.config };
      this.baseline = this.snapshotValues();
      this.absoluteValues.clear();
      this.pendingHistory = [];
      this.replacedAll = false;
      this.configDirty = false;
      this.lastSyncedMtimeMs = this.getFileMtime();
      this.dirty = false;
      logger.debug('Saved counters', { count: this.counters.size });
    } catch (error) {
      logger.error('Failed to save counters', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Save if there are pending changes
   */
  private saveIfDirty(): void {
    if (this.dirty) {
      this.saveData();
    } else if (this.getFileMtime() !== this.lastSyncedMtimeMs) {
      // Nothing pending here, so pick up changes another process wrote
      this.loadData();
    }
  }

  /**
   * Normalize counter name
   */
  private normalizeName(name: string): string {
    return name.toLowerCase().trim().replace(/\s+/g, '_');
  }

  /**
   * Create a new counter
   */
  createCounter(
    name: string,
    createdBy: string,
    options?: { initialValue?: number; description?: string }
  ): { success: boolean; counter?: Counter; error?: string } {
    const normalizedName = this.normalizeName(name);

    if (normalizedName.length < 1 || normalizedName.length > 50) {
      return { success: false, error: 'Counter name must be 1-50 characters' };
    }

    if (this.counters.has(normalizedName)) {
      return { success: false, error: `Counter "${normalizedName}" already exists` };
    }

    if (this.counters.size >= this.config.maxCounters) {
      return { success: false, error: `Maximum counter limit (${this.config.maxCounters}) reached` };
    }

    const initialValue = Math.max(
      this.config.minValue,
      Math.min(this.config.maxValue, options?.initialValue || 0)
    );

    const counter: Counter = {
      name: normalizedName,
      value: initialValue,
      createdAt: new Date().toISOString(),
      createdBy: createdBy.toLowerCase(),
      lastModifiedAt: new Date().toISOString(),
      lastModifiedBy: createdBy.toLowerCase(),
      description: options?.description,
    };

    this.counters.set(normalizedName, counter);
    this.dirty = true;

    logger.info('Counter created', { name: normalizedName, createdBy });

    return { success: true, counter };
  }

  /**
   * Get a counter
   */
  getCounter(name: string): Counter | null {
    return this.counters.get(this.normalizeName(name)) || null;
  }

  /**
   * Get counter value
   */
  getValue(name: string): number | null {
    const counter = this.getCounter(name);
    return counter?.value ?? null;
  }

  /**
   * Set counter value
   */
  setValue(
    name: string,
    value: number,
    modifiedBy: string,
    reason?: string
  ): { success: boolean; counter?: Counter; error?: string } {
    return this.applyValue(name, value, modifiedBy, reason, true);
  }

  /**
   * Change a counter's value. `absolute` marks an explicit set, which wins
   * over other writers on save; otherwise the change is saved as a delta.
   */
  private applyValue(
    name: string,
    value: number,
    modifiedBy: string,
    reason: string | undefined,
    absolute: boolean
  ): { success: boolean; counter?: Counter; error?: string } {
    const normalizedName = this.normalizeName(name);
    const counter = this.counters.get(normalizedName);

    if (!counter) {
      return { success: false, error: `Counter "${normalizedName}" not found` };
    }

    const clampedValue = Math.max(
      this.config.minValue,
      Math.min(this.config.maxValue, value)
    );

    const previousValue = counter.value;
    counter.value = clampedValue;
    counter.lastModifiedAt = new Date().toISOString();
    counter.lastModifiedBy = modifiedBy.toLowerCase();

    if (absolute) {
      this.absoluteValues.add(normalizedName);
    }
    this.dirty = true;

    // Record history
    if (this.config.keepHistory) {
      this.recordHistory(normalizedName, previousValue, clampedValue, modifiedBy, reason);
    }

    logger.info('Counter set', { name: normalizedName, value: clampedValue, modifiedBy });

    return { success: true, counter };
  }

  /**
   * Increment counter
   */
  increment(
    name: string,
    amount: number = 1,
    modifiedBy: string,
    reason?: string
  ): { success: boolean; counter?: Counter; error?: string } {
    const counter = this.getCounter(name);

    if (!counter) {
      return { success: false, error: `Counter "${name}" not found` };
    }

    const newValue = counter.value + amount;
    return this.applyValue(name, newValue, modifiedBy, reason || `+${amount}`, false);
  }

  /**
   * Decrement counter
   */
  decrement(
    name: string,
    amount: number = 1,
    modifiedBy: string,
    reason?: string
  ): { success: boolean; counter?: Counter; error?: string } {
    return this.increment(name, -amount, modifiedBy, reason || `-${amount}`);
  }

  /**
   * Reset counter to zero
   */
  reset(
    name: string,
    modifiedBy: string,
    reason?: string
  ): { success: boolean; counter?: Counter; error?: string } {
    return this.setValue(name, 0, modifiedBy, reason || 'Reset');
  }

  /**
   * Delete a counter
   */
  deleteCounter(name: string): { success: boolean; error?: string } {
    const normalizedName = this.normalizeName(name);

    if (!this.counters.has(normalizedName)) {
      return { success: false, error: `Counter "${normalizedName}" not found` };
    }

    this.counters.delete(normalizedName);
    this.dirty = true;

    // Remove history for this counter
    this.history = this.history.filter((h) => h.counterName !== normalizedName);

    logger.info('Counter deleted', { name: normalizedName });

    return { success: true };
  }

  /**
   * Record history entry
   */
  private recordHistory(
    counterName: string,
    previousValue: number,
    newValue: number,
    modifiedBy: string,
    reason?: string
  ): void {
    const entry: CounterHistoryEntry = {
      counterName,
      previousValue,
      newValue,
      change: newValue - previousValue,
      modifiedBy: modifiedBy.toLowerCase(),
      timestamp: new Date().toISOString(),
      reason,
    };
    this.history.push(entry);
    this.pendingHistory.push(entry);

    // Trim old history
    const maxTotal = this.config.maxHistoryEntries * this.counters.size;
    if (this.history.length > maxTotal * 2) {
      this.history = this.history.slice(-maxTotal);
    }
  }

  /**
   * Get history for a counter
   */
  getHistory(name: string, limit: number = 10): CounterHistoryEntry[] {
    const normalizedName = this.normalizeName(name);
    return this.history
      .filter((h) => h.counterName === normalizedName)
      .slice(-limit)
      .reverse();
  }

  /**
   * Get all counters
   */
  getAllCounters(): Counter[] {
    return Array.from(this.counters.values());
  }

  /**
   * Get counter names
   */
  getCounterNames(): string[] {
    return Array.from(this.counters.keys());
  }

  /**
   * Format counter for display
   */
  formatCounter(name: string): string {
    const counter = this.getCounter(name);
    if (!counter) {
      return `Counter "${name}" not found`;
    }

    return `${counter.name}: ${counter.value}`;
  }

  /**
   * Format all counters for display
   */
  formatAllCounters(): string {
    const counters = this.getAllCounters();
    if (counters.length === 0) {
      return 'No counters defined';
    }

    return counters.map((c) => `${c.name}: ${c.value}`).join(' | ');
  }

  /**
   * Get configuration
   */
  getConfig(): CountersConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<CountersConfig>): void {
    this.config = { ...this.config, ...updates };
    this.configDirty = true;
    this.dirty = true;
    logger.info('Counters config updated', { updates: Object.keys(updates) });
  }

  /**
   * Export counters
   */
  exportCounters(): Counter[] {
    return this.getAllCounters();
  }

  /**
   * Import counters
   */
  importCounters(
    counters: Counter[],
    merge: boolean = true
  ): { imported: number; skipped: number } {
    let imported = 0;
    let skipped = 0;

    if (!merge) {
      this.counters.clear();
      this.replacedAll = true;
    }

    for (const counter of counters) {
      const normalizedName = this.normalizeName(counter.name);

      if (merge && this.counters.has(normalizedName)) {
        skipped++;
        continue;
      }

      this.counters.set(normalizedName, {
        ...counter,
        name: normalizedName,
      });
      imported++;
    }

    this.dirty = true;
    logger.info('Counters imported', { imported, skipped });

    return { imported, skipped };
  }

  /**
   * Clean up and stop auto-save
   */
  destroy(): void {
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
      this.saveInterval = null;
    }
    this.saveIfDirty();
  }
}

// Singleton instance
let defaultManager: CountersManager | null = null;

export function getCountersManager(): CountersManager {
  if (!defaultManager) {
    defaultManager = new CountersManager();
  }
  return defaultManager;
}

export function resetCountersManager(): void {
  if (defaultManager) {
    defaultManager.destroy();
    defaultManager = null;
  }
}
