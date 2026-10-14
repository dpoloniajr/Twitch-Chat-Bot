/**
 * File and console logger used by the token generator. Each line is written to
 * stdout/stderr and appended to logs/token-generator.log in the project root.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as util from 'util';
import { projectPath } from '../utils/project-root';

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

export class Logger {
  readonly moduleName: string;
  readonly logDir: string;

  constructor(moduleName: string, logDir: string = projectPath('logs')) {
    this.moduleName = moduleName;
    this.logDir = logDir;
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  formatMessage(level: LogLevel, message: string): string {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${level}] [${this.moduleName}] ${message}`;
  }

  log(level: LogLevel, message: string, data: unknown = null): void {
    const formatted = this.formatMessage(level, message);
    // Write straight to the stream so the console-timestamp patch does not add a second timestamp
    const stream = level === 'ERROR' || level === 'WARN' ? process.stderr : process.stdout;
    stream.write(formatted + '\n');
    if (data) {
      stream.write(util.inspect(data, { depth: null, colors: true }) + '\n');
    }

    const fileMessage = formatted + (data ? ` ${JSON.stringify(data)}` : '') + '\n';
    fs.appendFileSync(path.join(this.logDir, 'token-generator.log'), fileMessage);
  }

  info(message: string, data?: unknown): void { this.log('INFO', message, data); }
  warn(message: string, data?: unknown): void { this.log('WARN', message, data); }
  error(message: string, data?: unknown): void { this.log('ERROR', message, data); }
  debug(message: string, data?: unknown): void { if (process.env.DEBUG) this.log('DEBUG', message, data); }
}
