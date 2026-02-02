/**
 * Main entry point for the Twitch Chat Bot TypeScript modules
 */

// Export types
export * from './types';

// Export configuration
export * from './config/constants';

// Export utilities
export { Logger, createLogger, default as logger } from './utils/logger';
export {
  ShutdownManager,
  getShutdownManager,
  onShutdown,
  setupGracefulShutdown,
} from './utils/shutdown';

// Export filters
export {
  ChatFilterManager,
  getFilterManager,
  resetFilterManager,
} from './filters/chat-filter';

// Export commands
export {
  CommandRegistry,
  getCommandRegistry,
  resetCommandRegistry,
} from './commands/registry';

export {
  ModerationManager,
} from './commands/moderation';

// Export services
export {
  LoyaltyManager,
  getLoyaltyManager,
  resetLoyaltyManager,
} from './services/loyalty';

export {
  QuotesManager,
  getQuotesManager,
  resetQuotesManager,
} from './services/quotes';

export {
  CountersManager,
  getCountersManager,
  resetCountersManager,
} from './services/counters';

export {
  StreamUtilsManager,
  getStreamUtilsManager,
  resetStreamUtilsManager,
} from './services/stream-utils';
