/**
 * Graceful Shutdown Handler
 * Handles SIGTERM, SIGINT, and other shutdown signals properly
 */

import { createLogger } from './logger';
import { SHUTDOWN } from '../config/constants';

const logger = createLogger('Shutdown');

type ShutdownHandler = () => Promise<void> | void;

interface ShutdownOptions {
  gracePeriodMs?: number;
  exitOnUncaught?: boolean;
}

/**
 * Graceful shutdown manager
 */
export class ShutdownManager {
  private handlers: Map<string, ShutdownHandler> = new Map();
  private isShuttingDown: boolean = false;
  private gracePeriodMs: number;
  private exitOnUncaught: boolean;

  constructor(options: ShutdownOptions = {}) {
    this.gracePeriodMs = options.gracePeriodMs ?? SHUTDOWN.GRACE_PERIOD_MS;
    this.exitOnUncaught = options.exitOnUncaught ?? true;
  }

  /**
   * Register a shutdown handler
   * @param name - Unique name for the handler
   * @param handler - Async function to call during shutdown
   */
  register(name: string, handler: ShutdownHandler): void {
    if (this.handlers.has(name)) {
      logger.warn('Overwriting existing shutdown handler', { name });
    }
    this.handlers.set(name, handler);
    logger.debug('Registered shutdown handler', { name });
  }

  /**
   * Unregister a shutdown handler
   * @param name - Name of the handler to remove
   */
  unregister(name: string): boolean {
    const removed = this.handlers.delete(name);
    if (removed) {
      logger.debug('Unregistered shutdown handler', { name });
    }
    return removed;
  }

  /**
   * Execute all shutdown handlers
   */
  private async executeHandlers(): Promise<void> {
    const startTime = Date.now();
    const handlerNames = Array.from(this.handlers.keys());

    logger.info('Executing shutdown handlers', {
      count: handlerNames.length,
      handlers: handlerNames,
    });

    const results = await Promise.allSettled(
      Array.from(this.handlers.entries()).map(async ([name, handler]) => {
        try {
          logger.debug('Running shutdown handler', { name });
          await handler();
          logger.debug('Shutdown handler completed', { name });
          return { name, success: true };
        } catch (error) {
          const err = error as Error;
          logger.error('Shutdown handler failed', {
            name,
            error: err.message,
          });
          return { name, success: false, error: err.message };
        }
      })
    );

    const elapsed = Date.now() - startTime;
    const failed = results.filter(
      (r) => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.success)
    ).length;

    logger.info('Shutdown handlers completed', {
      elapsed,
      total: handlerNames.length,
      failed,
    });
  }

  /**
   * Perform graceful shutdown
   */
  async shutdown(signal: string, exitCode: number = 0): Promise<void> {
    if (this.isShuttingDown) {
      logger.warn('Shutdown already in progress, ignoring signal', { signal });
      return;
    }

    this.isShuttingDown = true;
    logger.info('Initiating graceful shutdown', { signal, exitCode });

    // Set a timeout to force exit if handlers take too long
    const forceExitTimeout = setTimeout(() => {
      logger.error('Graceful shutdown timed out, forcing exit', {
        gracePeriodMs: this.gracePeriodMs,
      });
      process.exit(1);
    }, this.gracePeriodMs);

    try {
      await this.executeHandlers();
      clearTimeout(forceExitTimeout);
      logger.info('Graceful shutdown complete', { exitCode });
      process.exit(exitCode);
    } catch (error) {
      clearTimeout(forceExitTimeout);
      const err = error as Error;
      logger.error('Error during shutdown', { error: err.message });
      process.exit(1);
    }
  }

  /**
   * Setup signal handlers
   */
  setupSignalHandlers(): void {
    // Handle SIGTERM (docker stop, kill)
    process.on('SIGTERM', () => {
      logger.info('Received SIGTERM signal');
      this.shutdown('SIGTERM', 0);
    });

    // Handle SIGINT (Ctrl+C)
    process.on('SIGINT', () => {
      logger.info('Received SIGINT signal');
      this.shutdown('SIGINT', 0);
    });

    // Handle SIGHUP (terminal closed)
    process.on('SIGHUP', () => {
      logger.info('Received SIGHUP signal');
      this.shutdown('SIGHUP', 0);
    });

    // Handle uncaught exceptions
    if (this.exitOnUncaught) {
      process.on('uncaughtException', (error: Error) => {
        logger.error('Uncaught exception', {
          error: error.message,
          stack: error.stack,
        });
        this.shutdown('uncaughtException', 1);
      });

      process.on('unhandledRejection', (reason: unknown) => {
        const error = reason instanceof Error ? reason : new Error(String(reason));
        logger.error('Unhandled rejection', {
          error: error.message,
          stack: error.stack,
        });
        this.shutdown('unhandledRejection', 1);
      });
    }

    logger.info('Signal handlers registered');
  }

  /**
   * Check if shutdown is in progress
   */
  isInProgress(): boolean {
    return this.isShuttingDown;
  }
}

// Singleton instance
let shutdownManager: ShutdownManager | null = null;

/**
 * Get the global shutdown manager instance
 */
export function getShutdownManager(options?: ShutdownOptions): ShutdownManager {
  if (!shutdownManager) {
    shutdownManager = new ShutdownManager(options);
  }
  return shutdownManager;
}

/**
 * Register a shutdown handler on the global manager
 */
export function onShutdown(name: string, handler: ShutdownHandler): void {
  getShutdownManager().register(name, handler);
}

/**
 * Setup global signal handlers
 */
export function setupGracefulShutdown(options?: ShutdownOptions): ShutdownManager {
  const manager = getShutdownManager(options);
  manager.setupSignalHandlers();
  return manager;
}

/**
 * Reset the shutdown manager (for testing)
 */
export function resetShutdownManager(): void {
  shutdownManager = null;
}
