/**
 * Tests for Logger Module
 */

import { Logger, createLogger } from '../../src/utils/logger';

describe('Logger', () => {
  let consoleSpy: jest.SpyInstance;
  const originalLogLevel = process.env.LOG_LEVEL;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    // Clear LOG_LEVEL to test default behavior
    delete process.env.LOG_LEVEL;
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    // Restore original LOG_LEVEL
    if (originalLogLevel !== undefined) {
      process.env.LOG_LEVEL = originalLogLevel;
    } else {
      delete process.env.LOG_LEVEL;
    }
  });

  describe('log levels', () => {
    it('should log info messages by default', () => {
      const logger = new Logger({ level: 'info', context: 'Test' });
      logger.info('Test message');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('INFO')
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Test message')
      );
    });

    it('should not log debug messages at info level', () => {
      const logger = new Logger({ level: 'info', context: 'Test' });
      logger.debug('Debug message');

      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it('should log debug messages at debug level', () => {
      const logger = new Logger({ level: 'debug', context: 'Test' });
      logger.debug('Debug message');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('DEBUG')
      );
    });

    it('should log warn messages', () => {
      const logger = new Logger({ level: 'info', context: 'Test' });
      logger.warn('Warning message');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('WARN')
      );
    });

    it('should log error messages', () => {
      const logger = new Logger({ level: 'info', context: 'Test' });
      logger.error('Error message');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('ERROR')
      );
    });

    it('should only log errors at error level', () => {
      const logger = new Logger({ level: 'error', context: 'Test' });

      logger.debug('Debug');
      logger.info('Info');
      logger.warn('Warn');

      expect(consoleSpy).not.toHaveBeenCalled();

      logger.error('Error');
      expect(consoleSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('context', () => {
    it('should include context in log output', () => {
      const logger = new Logger({ level: 'info', context: 'MyContext' });
      logger.info('Test message');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[MyContext]')
      );
    });

    it('should create child logger with combined context', () => {
      const parent = new Logger({ level: 'info', context: 'Parent' });
      const child = parent.child('Child');

      child.info('Test message');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[Parent:Child]')
      );
    });
  });

  describe('data logging', () => {
    it('should include data in log output', () => {
      const logger = new Logger({ level: 'info', context: 'Test' });
      logger.info('Test message', { key: 'value', num: 42 });

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('"key":"value"')
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('"num":42')
      );
    });

    it('should handle nested data objects', () => {
      const logger = new Logger({ level: 'info', context: 'Test' });
      logger.info('Test message', { nested: { deep: 'value' } });

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('"deep":"value"')
      );
    });
  });

  describe('errorWithStack', () => {
    it('should include error message and stack', () => {
      const logger = new Logger({ context: 'Test' });
      const error = new Error('Test error');
      logger.errorWithStack('Operation failed', error);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Operation failed')
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('"error":"Test error"')
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('"stack"')
      );
    });

    it('should merge additional data with error info', () => {
      const logger = new Logger({ context: 'Test' });
      const error = new Error('Test error');
      logger.errorWithStack('Operation failed', error, { userId: '123' });

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('"userId":"123"')
      );
    });
  });

  describe('setLevel', () => {
    it('should change log level dynamically', () => {
      const logger = new Logger({ level: 'error', context: 'Test' });

      logger.info('Should not appear');
      expect(consoleSpy).not.toHaveBeenCalled();

      logger.setLevel('info');
      logger.info('Should appear');
      expect(consoleSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('console disable', () => {
    it('should not log when console is disabled', () => {
      const logger = new Logger({ enableConsole: false, context: 'Test' });
      logger.info('Test message');

      expect(consoleSpy).not.toHaveBeenCalled();
    });
  });

  describe('createLogger', () => {
    it('should create logger with specified context', () => {
      const logger = createLogger('CustomContext', { level: 'info' });
      logger.info('Test message');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[CustomContext]')
      );
    });
  });

  describe('timestamp format', () => {
    it('should include ISO timestamp', () => {
      const logger = new Logger({ level: 'info', context: 'Test' });
      logger.info('Test message');

      // Check for ISO date format pattern
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
      );
    });
  });
});
