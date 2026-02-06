/**
 * Tests for Counters System
 */

import { CountersManager, resetCountersManager } from '../../src/services/counters';
import * as fs from 'fs';
import * as path from 'path';

describe('CountersManager', () => {
  let manager: CountersManager;
  const testDataPath = path.join(__dirname, 'test-counters.json');

  beforeEach(() => {
    resetCountersManager();
    manager = new CountersManager({
      dataPath: testDataPath,
      autoSaveIntervalMs: 0,
    });
  });

  afterEach(() => {
    manager.destroy();
    if (fs.existsSync(testDataPath)) {
      fs.unlinkSync(testDataPath);
    }
  });

  describe('default counters', () => {
    it('should create default counters on initialization', () => {
      const counters = manager.getAllCounters();
      const names = counters.map((c) => c.name);

      expect(names).toContain('deaths');
      expect(names).toContain('wins');
      expect(names).toContain('losses');
    });
  });

  describe('creating counters', () => {
    it('should create a new counter', () => {
      const result = manager.createCounter('kills', 'user1');

      expect(result.success).toBe(true);
      expect(result.counter?.name).toBe('kills');
      expect(result.counter?.value).toBe(0);
      expect(result.counter?.createdBy).toBe('user1');
    });

    it('should create counter with initial value', () => {
      const result = manager.createCounter('score', 'user1', { initialValue: 100 });

      expect(result.counter?.value).toBe(100);
    });

    it('should normalize counter names', () => {
      const result = manager.createCounter('My Counter', 'user1');

      expect(result.counter?.name).toBe('my_counter');
    });

    it('should reject duplicate counter names', () => {
      manager.createCounter('test', 'user1');

      const result = manager.createCounter('test', 'user2');

      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
    });

    it('should include description', () => {
      const result = manager.createCounter('test', 'user1', {
        description: 'A test counter',
      });

      expect(result.counter?.description).toBe('A test counter');
    });
  });

  describe('getting counters', () => {
    it('should get counter by name', () => {
      manager.createCounter('test', 'user1');

      const counter = manager.getCounter('test');

      expect(counter).not.toBeNull();
      expect(counter?.name).toBe('test');
    });

    it('should be case insensitive', () => {
      manager.createCounter('MyCounter', 'user1');

      const counter = manager.getCounter('MYCOUNTER');

      expect(counter).not.toBeNull();
    });

    it('should return null for non-existent counter', () => {
      const counter = manager.getCounter('nonexistent');

      expect(counter).toBeNull();
    });

    it('should get counter value', () => {
      manager.createCounter('test', 'user1', { initialValue: 42 });

      const value = manager.getValue('test');

      expect(value).toBe(42);
    });
  });

  describe('modifying counters', () => {
    beforeEach(() => {
      manager.createCounter('test', 'user1', { initialValue: 10 });
    });

    it('should set counter value', () => {
      const result = manager.setValue('test', 50, 'user2');

      expect(result.success).toBe(true);
      expect(result.counter?.value).toBe(50);
    });

    it('should increment counter', () => {
      const result = manager.increment('test', 5, 'user1');

      expect(result.success).toBe(true);
      expect(result.counter?.value).toBe(15);
    });

    it('should increment by 1 by default', () => {
      const result = manager.increment('test', undefined, 'user1');

      expect(result.counter?.value).toBe(11);
    });

    it('should decrement counter', () => {
      const result = manager.decrement('test', 3, 'user1');

      expect(result.success).toBe(true);
      expect(result.counter?.value).toBe(7);
    });

    it('should reset counter to zero', () => {
      const result = manager.reset('test', 'user1');

      expect(result.success).toBe(true);
      expect(result.counter?.value).toBe(0);
    });

    it('should clamp value to min/max', () => {
      manager.updateConfig({ maxValue: 100, minValue: -10 });

      manager.setValue('test', 1000, 'user1');
      expect(manager.getValue('test')).toBe(100);

      manager.setValue('test', -100, 'user1');
      expect(manager.getValue('test')).toBe(-10);
    });

    it('should update lastModified info', () => {
      manager.increment('test', 1, 'modifier');

      const counter = manager.getCounter('test');

      expect(counter?.lastModifiedBy).toBe('modifier');
    });
  });

  describe('deleting counters', () => {
    it('should delete a counter', () => {
      manager.createCounter('todelete', 'user1');

      const result = manager.deleteCounter('todelete');

      expect(result.success).toBe(true);
      expect(manager.getCounter('todelete')).toBeNull();
    });

    it('should return error for non-existent counter', () => {
      const result = manager.deleteCounter('nonexistent');

      expect(result.success).toBe(false);
    });
  });

  describe('history tracking', () => {
    beforeEach(() => {
      manager.updateConfig({ keepHistory: true });
      manager.createCounter('test', 'user1', { initialValue: 0 });
    });

    it('should record change history', () => {
      manager.increment('test', 10, 'user1', 'First increment');
      manager.decrement('test', 5, 'user2', 'Decrement');

      const history = manager.getHistory('test');

      expect(history.length).toBe(2);
      expect(history[0].previousValue).toBe(10);
      expect(history[0].newValue).toBe(5);
      expect(history[0].change).toBe(-5);
      expect(history[0].modifiedBy).toBe('user2');
    });

    it('should return history in reverse chronological order', () => {
      manager.increment('test', 1, 'user1');
      manager.increment('test', 1, 'user2');
      manager.increment('test', 1, 'user3');

      const history = manager.getHistory('test');

      expect(history[0].modifiedBy).toBe('user3');
      expect(history[2].modifiedBy).toBe('user1');
    });
  });

  describe('formatting', () => {
    it('should format single counter', () => {
      manager.createCounter('test', 'user1', { initialValue: 42 });

      const formatted = manager.formatCounter('test');

      expect(formatted).toBe('test: 42');
    });

    it('should format all counters', () => {
      manager.setValue('deaths', 5, 'user1');
      manager.setValue('wins', 10, 'user1');
      manager.setValue('losses', 3, 'user1');

      const formatted = manager.formatAllCounters();

      expect(formatted).toContain('deaths: 5');
      expect(formatted).toContain('wins: 10');
      expect(formatted).toContain('losses: 3');
    });
  });

  describe('listing counters', () => {
    it('should get all counter names', () => {
      manager.createCounter('custom1', 'user1');
      manager.createCounter('custom2', 'user1');

      const names = manager.getCounterNames();

      expect(names).toContain('deaths');
      expect(names).toContain('custom1');
      expect(names).toContain('custom2');
    });

    it('should get all counters', () => {
      const counters = manager.getAllCounters();

      expect(counters.length).toBeGreaterThanOrEqual(3); // At least defaults
      expect(counters.every((c) => c.name && c.value !== undefined)).toBe(true);
    });
  });

  describe('import/export', () => {
    it('should export counters', () => {
      manager.setValue('deaths', 10, 'user1');

      const exported = manager.exportCounters();

      expect(exported.find((c) => c.name === 'deaths')?.value).toBe(10);
    });

    it('should import counters with merge', () => {
      const result = manager.importCounters([
        {
          name: 'imported',
          value: 50,
          createdAt: new Date().toISOString(),
          createdBy: 'import',
          lastModifiedAt: new Date().toISOString(),
          lastModifiedBy: 'import',
        },
      ]);

      expect(result.imported).toBe(1);
      expect(manager.getValue('imported')).toBe(50);
    });

    it('should skip existing counters on merge', () => {
      const result = manager.importCounters([
        {
          name: 'deaths',
          value: 999,
          createdAt: new Date().toISOString(),
          createdBy: 'import',
          lastModifiedAt: new Date().toISOString(),
          lastModifiedBy: 'import',
        },
      ]);

      expect(result.skipped).toBe(1);
      expect(manager.getValue('deaths')).toBe(0); // Original value
    });
  });
});
