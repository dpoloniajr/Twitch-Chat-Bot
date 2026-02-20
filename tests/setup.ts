/**
 * Jest test setup file
 * Configure global test environment and mocks
 */

// Set test environment variables
process.env.NODE_ENV = 'test';
// Don't set LOG_LEVEL globally - let individual tests control it

// Mock console methods to reduce noise (optional - can be commented out for debugging)
// global.console = {
//   ...console,
//   log: jest.fn(),
//   debug: jest.fn(),
//   info: jest.fn(),
//   warn: jest.fn(),
// };

// Global test timeout
jest.setTimeout(10000);

// Clean up after all tests
afterAll(() => {
  // Clean up any resources
});

// Reset mocks between tests
beforeEach(() => {
  jest.clearAllMocks();
});
