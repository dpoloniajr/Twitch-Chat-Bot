/**
 * Structured logging utility for the Twitch Chat Bot
 * Provides consistent logging with levels, context, and structured data
 */

import { LogLevel, LogEntry, LoggerOptions } from '../types';
import { LOGGING } from '../config/constants';
import * as fs from 'fs';
import * as path from 'path';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LOG_LEVEL_COLORS: Record<LogLevel, string> = {
  debug: '\x1b[36m', // Cyan
  info: '\x1b[32m',  // Green
  warn: '\x1b[33m',  // Yellow
  error: '\x1b[31m', // Red
};

const RESET_COLOR = '\x1b[0m';

/**
 * Logger class for structured logging
 */
export class Logger {
  private level: LogLevel;
  private context: string;
  private enableConsole: boolean;
  private enableFile: boolean;
  private filePath: string | null;
  private fileStream: fs.WriteStream | null = null;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level || (process.env.LOG_LEVEL as LogLevel) || LOGGING.DEFAULT_LEVEL;
    this.context = options.context || 'App';
    this.enableConsole = options.enableConsole !== false;
    this.enableFile = options.enableFile || false;
    this.filePath = options.filePath || null;

    if (this.enableFile && this.filePath) {
      this.initFileStream();
    }
  }

  private initFileStream(): void {
    if (!this.filePath) return;

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.fileStream = fs.createWriteStream(this.filePath, { flags: 'a' });
    this.fileStream.on('error', (err) => {
      console.error('Logger file stream error:', err.message);
      this.enableFile = false;
    });
  }

  /**
   * Check if a log level should be output
   */
  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.level];
  }

  /**
   * Format a log entry for console output
   */
  private formatConsole(entry: LogEntry): string {
    const color = LOG_LEVEL_COLORS[entry.level];
    const levelStr = entry.level.toUpperCase().padEnd(5);
    const contextStr = entry.context ? `[${entry.context}]` : '';
    const dataStr = entry.data ? ` ${JSON.stringify(entry.data)}` : '';

    return `${color}${entry.timestamp} ${levelStr}${RESET_COLOR} ${contextStr} ${entry.message}${dataStr}`;
  }

  /**
   * Format a log entry for file output (JSON lines format)
   */
  private formatFile(entry: LogEntry): string {
    return JSON.stringify(entry);
  }

  /**
   * Create a log entry
   */
  private createEntry(
    level: LogLevel,
    message: string,
    data?: Record<string, unknown>
  ): LogEntry {
    return {
      timestamp: new Date().toISOString(),
      level,
      message,
      context: this.context,
      data,
    };
  }

  /**
   * Write a log entry
   */
  private write(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;

    const entry = this.createEntry(level, message, data);

    if (this.enableConsole) {
      console.log(this.formatConsole(entry));
    }

    if (this.enableFile && this.fileStream) {
      this.fileStream.write(this.formatFile(entry) + '\n');
    }
  }

  /**
   * Log a debug message
   */
  debug(message: string, data?: Record<string, unknown>): void {
    this.write('debug', message, data);
  }

  /**
   * Log an info message
   */
  info(message: string, data?: Record<string, unknown>): void {
    this.write('info', message, data);
  }

  /**
   * Log a warning message
   */
  warn(message: string, data?: Record<string, unknown>): void {
    this.write('warn', message, data);
  }

  /**
   * Log an error message
   */
  error(message: string, data?: Record<string, unknown>): void {
    this.write('error', message, data);
  }

  /**
   * Log an error with stack trace
   */
  errorWithStack(message: string, error: Error, data?: Record<string, unknown>): void {
    this.write('error', message, {
      ...data,
      error: error.message,
      stack: error.stack,
    });
  }

  /**
   * Create a child logger with a new context
   */
  child(context: string): Logger {
    return new Logger({
      level: this.level,
      context: `${this.context}:${context}`,
      enableConsole: this.enableConsole,
      enableFile: this.enableFile,
      filePath: this.filePath ?? undefined,
    });
  }

  /**
   * Set the log level
   */
  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /**
   * Close the file stream
   */
  close(): void {
    if (this.fileStream) {
      this.fileStream.end();
      this.fileStream = null;
    }
  }
}

// Create default logger instance
const defaultLogger = new Logger({ context: 'Bot' });

// Export convenience functions
export const debug = (message: string, data?: Record<string, unknown>) =>
  defaultLogger.debug(message, data);
export const info = (message: string, data?: Record<string, unknown>) =>
  defaultLogger.info(message, data);
export const warn = (message: string, data?: Record<string, unknown>) =>
  defaultLogger.warn(message, data);
export const error = (message: string, data?: Record<string, unknown>) =>
  defaultLogger.error(message, data);
export const errorWithStack = (message: string, err: Error, data?: Record<string, unknown>) =>
  defaultLogger.errorWithStack(message, err, data);

// Export default logger
export default defaultLogger;

/**
 * Create a logger with a specific context
 */
export function createLogger(context: string, options?: Omit<LoggerOptions, 'context'>): Logger {
  return new Logger({ ...options, context });
}
