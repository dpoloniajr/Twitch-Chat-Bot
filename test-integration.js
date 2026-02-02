/**
 * Integration and Smoke tests for Dashboard API
 */
const axios = require('axios');

const PORT = process.env.DASHBOARD_PORT || 3001;
const BASE_URL = `http://localhost:${PORT}`;

console.log('🧪 Testing Dashboard Integration...\n');

async function runTests() {
  let failCount = 0;
  let passCount = 0;

  async function test(name, fn) {
    process.stdout.write(`- ${name}: `);
    try {
      await fn();
      console.log('✓ Pass');
      passCount++;
    } catch (err) {
      console.log(`✗ Fail (${err.message})`);
      if (err.response) {
        console.log(`  Response Status: ${err.response.status}`);
        console.log(`  Response Data: ${JSON.stringify(err.response.data)}`);
      }
      failCount++;
    }
  }

  // 1. Integration: Validation - Missing required field
  await test('POST /api/logs validation (missing user)', async () => {
    try {
      await axios.post(`${BASE_URL}/api/logs`, { command: '!test' });
      throw new Error('Expected 400 but got 200');
    } catch (err) {
      if (!err.response || err.response.status !== 400 || err.response.data.error !== 'user is required') {
        throw new Error(`Unexpected error: ${err.message}`);
      }
    }
  });

  // 2. Integration: Validation - Wrong type
  await test('POST /api/custom-commands validation (wrong type)', async () => {
    try {
      await axios.post(`${BASE_URL}/api/custom-commands`, { name: '!test', response: 123 });
      throw new Error('Expected 400 but got 200');
    } catch (err) {
      if (!err.response || err.response.status !== 400 || err.response.data.error !== 'response must be a string') {
        throw new Error(`Unexpected error: ${err.message}`);
      }
    }
  });

  // 3. Smoke: Valid log entry
  await test('POST /api/logs smoke test (valid request)', async () => {
    const res = await axios.post(`${BASE_URL}/api/logs`, { user: 'TestUser', command: '!smoke-test' });
    if (res.status !== 200 || !res.data.success) {
      throw new Error('Failed to create log entry');
    }
  });

  // 4. Smoke: Valid custom command
  await test('POST /api/custom-commands smoke test (valid request)', async () => {
    const res = await axios.post(`${BASE_URL}/api/custom-commands`, { 
      name: '!smokecmd', 
      response: 'This is a smoke test response' 
    });
    if (res.status !== 200 || !res.data.success) {
      throw new Error('Failed to create custom command');
    }
  });

  // 5. Smoke: Cleanup
  await test('DELETE /api/custom-commands/:name smoke test', async () => {
    const res = await axios.delete(`${BASE_URL}/api/custom-commands/!smokecmd`);
    if (res.status !== 200 || !res.data.success) {
      throw new Error('Failed to delete custom command');
    }
  });

  console.log(`\nTests finished: ${passCount} Passed, ${failCount} Failed`);
  process.exit(failCount > 0 ? 1 : 0);
}

runTests();
