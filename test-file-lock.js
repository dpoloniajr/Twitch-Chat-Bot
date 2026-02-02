/**
 * Test for lib/file-lock.js cross-process locking
 */
const { withCrossProcessLock } = require('./lib/file-lock');
const fs = require('fs').promises;
const path = require('path');

const TEST_FILE = path.join(__dirname, 'test-lock-file.txt');

console.log('🧪 Testing File Lock...\n');

async function runTest() {
  // Ensure file exists
  await fs.writeFile(TEST_FILE, '0');
  
  console.log('Starting 10 concurrent increments...');
  
  // Try to increment a number in a file 10 times concurrently
  // Without locking, some increments would be lost
  const increments = Array(10).fill(0).map(async (_, i) => {
    return withCrossProcessLock(TEST_FILE, async () => {
      const content = await fs.readFile(TEST_FILE, 'utf8');
      const val = parseInt(content);
      // Artificial delay to increase chance of race condition
      await new Promise(r => setTimeout(r, 50));
      await fs.writeFile(TEST_FILE, (val + 1).toString());
      return val + 1;
    });
  });

  const results = await Promise.all(increments);
  const finalVal = await fs.readFile(TEST_FILE, 'utf8');
  
  console.log('Results:', results.join(', '));
  console.log('Final value:', finalVal);

  if (finalVal === '10') {
    console.log('\n✓ Pass: Final value is exactly 10');
  } else {
    console.log(`\n✗ Fail: Expected 10, got ${finalVal}`);
  }

  // Cleanup
  try {
    await fs.unlink(TEST_FILE);
  } catch (e) {}
}

runTest();
