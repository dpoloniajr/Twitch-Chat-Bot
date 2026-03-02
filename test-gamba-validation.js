/**
 * Regression Test: !gamba Command Validation
 *
 * Tests that the !gamba command properly validates bet amounts
 * and does not silently bet 1 point when no amount is provided.
 *
 * Run with: node test-gamba-validation.js
 */

const axios = require('axios');

const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:3001';
const TEST_USERNAME = 'test_gamba_user';

// Colors for console output
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  reset: '\x1b[0m'
};

function log(color, message) {
  console.log(`${color}${message}${colors.reset}`);
}

async function setupTestUser() {
  try {
    // Give test user 1000 points to start
    await axios.post(`${DASHBOARD_URL}/api/loyalty/add`, {
      username: TEST_USERNAME,
      amount: 1000,
      reason: 'Test setup'
    });
    log(colors.green, `✓ Test user setup: ${TEST_USERNAME} has 1000 points`);
    return true;
  } catch (err) {
    log(colors.red, `✗ Failed to setup test user: ${err.message}`);
    return false;
  }
}

async function getBalance(username) {
  try {
    const response = await axios.get(`${DASHBOARD_URL}/api/loyalty/leaderboard`);
    const user = response.data.find(u => u.username === username.toLowerCase());
    return user ? user.points : 0;
  } catch (err) {
    log(colors.red, `✗ Failed to get balance: ${err.message}`);
    return null;
  }
}

async function testEmptyBetValidation() {
  log(colors.yellow, '\n--- Test 1: Empty Bet Should Fail ---');

  const initialBalance = await getBalance(TEST_USERNAME);
  log(colors.yellow, `Initial balance: ${initialBalance}`);

  try {
    // Attempt to bet with no amount (simulating the bug)
    const response = await axios.post(`${DASHBOARD_URL}/api/loyalty/gamba`, {
      username: TEST_USERNAME,
      amount: undefined // This should be rejected
    }, {
      timeout: 5000,
      validateStatus: () => true // Accept any status code
    });

    const finalBalance = await getBalance(TEST_USERNAME);

    if (response.status === 400 || (response.data && !response.data.success)) {
      log(colors.green, `✓ API correctly rejected empty bet (status ${response.status})`);

      if (finalBalance === initialBalance) {
        log(colors.green, `✓ Balance unchanged: ${initialBalance} → ${finalBalance}`);
        return true;
      } else {
        log(colors.red, `✗ FAIL: Balance changed: ${initialBalance} → ${finalBalance}`);
        return false;
      }
    } else {
      log(colors.red, `✗ FAIL: API accepted empty bet (status ${response.status})`);
      log(colors.red, `  Balance: ${initialBalance} → ${finalBalance}`);
      return false;
    }
  } catch (err) {
    log(colors.red, `✗ Request error: ${err.message}`);
    return false;
  }
}

async function testValidBet() {
  log(colors.yellow, '\n--- Test 2: Valid Bet Should Work ---');

  const initialBalance = await getBalance(TEST_USERNAME);
  log(colors.yellow, `Initial balance: ${initialBalance}`);

  try {
    const response = await axios.post(`${DASHBOARD_URL}/api/loyalty/gamba`, {
      username: TEST_USERNAME,
      amount: 100
    }, { timeout: 5000 });

    const finalBalance = await getBalance(TEST_USERNAME);

    if (response.data.success) {
      const won = response.data.won;
      const expectedBalance = won ? initialBalance + 100 : initialBalance - 100;

      if (finalBalance === expectedBalance) {
        log(colors.green, `✓ Bet processed correctly (${won ? 'WON' : 'LOST'})`);
        log(colors.green, `✓ Balance: ${initialBalance} → ${finalBalance} (expected ${expectedBalance})`);
        return true;
      } else {
        log(colors.red, `✗ FAIL: Balance mismatch: ${finalBalance} (expected ${expectedBalance})`);
        return false;
      }
    } else {
      log(colors.red, `✗ FAIL: Valid bet was rejected: ${response.data.error}`);
      return false;
    }
  } catch (err) {
    log(colors.red, `✗ Request error: ${err.message}`);
    return false;
  }
}

async function testBetAll() {
  log(colors.yellow, '\n--- Test 3: Bet All Should Work ---');

  const initialBalance = await getBalance(TEST_USERNAME);
  log(colors.yellow, `Initial balance: ${initialBalance}`);

  try {
    const response = await axios.post(`${DASHBOARD_URL}/api/loyalty/gamba`, {
      username: TEST_USERNAME,
      amount: 'all'
    }, { timeout: 5000 });

    const finalBalance = await getBalance(TEST_USERNAME);

    if (response.data.success) {
      const won = response.data.won;
      const bet = Math.min(initialBalance, 10000); // GAMBA_MAX = 10000
      const expectedBalance = won ? initialBalance + bet : 0;

      if (finalBalance === expectedBalance) {
        log(colors.green, `✓ Bet all processed correctly (${won ? 'WON' : 'LOST'})`);
        log(colors.green, `✓ Balance: ${initialBalance} → ${finalBalance} (expected ${expectedBalance})`);
        return true;
      } else {
        log(colors.red, `✗ FAIL: Balance mismatch: ${finalBalance} (expected ${expectedBalance})`);
        return false;
      }
    } else {
      log(colors.red, `✗ FAIL: Bet all was rejected: ${response.data.error}`);
      return false;
    }
  } catch (err) {
    log(colors.red, `✗ Request error: ${err.message}`);
    return false;
  }
}

async function testBalanceDisplay() {
  log(colors.yellow, '\n--- Test 5: Balance Display in Response ---');

  // Ensure user has enough points for this test
  await axios.post(`${DASHBOARD_URL}/api/loyalty/add`, {
    username: TEST_USERNAME,
    amount: 500,
    reason: 'Test balance display'
  });

  const initialBalance = await getBalance(TEST_USERNAME);
  log(colors.yellow, `Initial balance: ${initialBalance}`);

  try {
    const response = await axios.post(`${DASHBOARD_URL}/api/loyalty/gamba`, {
      username: TEST_USERNAME,
      amount: 50
    }, { timeout: 5000 });

    if (response.data.success) {
      const { oldBalance, newBalance, won, amountBet } = response.data;

      // Check that oldBalance is returned
      if (oldBalance === undefined) {
        log(colors.red, `✗ FAIL: oldBalance not included in response`);
        return false;
      }

      // Verify oldBalance matches what we expect
      if (oldBalance !== initialBalance) {
        log(colors.red, `✗ FAIL: oldBalance mismatch: ${oldBalance} (expected ${initialBalance})`);
        return false;
      }

      // Verify the math is correct
      const expectedNewBalance = won ? oldBalance + amountBet : oldBalance - amountBet;
      if (newBalance !== expectedNewBalance) {
        log(colors.red, `✗ FAIL: newBalance calculation incorrect: ${newBalance} (expected ${expectedNewBalance})`);
        return false;
      }

      log(colors.green, `✓ oldBalance included in response: ${oldBalance}`);
      log(colors.green, `✓ Balance transition correct: ${oldBalance} → ${newBalance} (${won ? 'WON' : 'LOST'})`);
      return true;
    } else {
      log(colors.red, `✗ FAIL: Request failed: ${response.data.error}`);
      return false;
    }
  } catch (err) {
    log(colors.red, `✗ Request error: ${err.message}`);
    return false;
  }
}

async function testInvalidAmounts() {
  log(colors.yellow, '\n--- Test 4: Invalid Amounts Should Be Rejected ---');

  const testCases = [
    { value: 0, label: 'zero' },
    { value: -50, label: 'negative' },
    { value: 'abc', label: 'non-numeric string' },
    { value: NaN, label: 'NaN' },
    { value: null, label: 'null' },
    { value: '  ', label: 'whitespace' },
    { value: Infinity, label: 'Infinity' },
    { value: -Infinity, label: '-Infinity' }
  ];

  let allPassed = true;

  for (const testCase of testCases) {
    const initialBalance = await getBalance(TEST_USERNAME);

    try {
      const response = await axios.post(`${DASHBOARD_URL}/api/loyalty/gamba`, {
        username: TEST_USERNAME,
        amount: testCase.value
      }, {
        timeout: 5000,
        validateStatus: () => true
      });

      const finalBalance = await getBalance(TEST_USERNAME);

      if (response.status === 400 || (response.data && !response.data.success)) {
        if (finalBalance === initialBalance) {
          log(colors.green, `✓ ${testCase.label} correctly rejected, balance unchanged`);
        } else {
          log(colors.red, `✗ FAIL: ${testCase.label} rejected but balance changed: ${initialBalance} → ${finalBalance}`);
          allPassed = false;
        }
      } else {
        log(colors.red, `✗ FAIL: ${testCase.label} was accepted`);
        log(colors.red, `  Response: ${JSON.stringify(response.data)}`);
        allPassed = false;
      }
    } catch (err) {
      log(colors.red, `✗ Request error for ${testCase.label}: ${err.message}`);
      allPassed = false;
    }
  }

  return allPassed;
}

async function runTests() {
  log(colors.yellow, '=================================');
  log(colors.yellow, '  !gamba Command Validation Tests');
  log(colors.yellow, '=================================');

  // Setup
  const setupSuccess = await setupTestUser();
  if (!setupSuccess) {
    log(colors.red, '\n✗ Setup failed, aborting tests');
    process.exit(1);
  }

  // Run tests
  const results = {
    emptyBet: await testEmptyBetValidation(),
    validBet: await testValidBet(),
    betAll: await testBetAll(),
    invalidAmounts: await testInvalidAmounts(),
    balanceDisplay: await testBalanceDisplay()
  };

  // Summary
  log(colors.yellow, '\n=================================');
  log(colors.yellow, '  Test Summary');
  log(colors.yellow, '=================================');

  const totalTests = Object.keys(results).length;
  const passedTests = Object.values(results).filter(r => r).length;

  for (const [name, passed] of Object.entries(results)) {
    const status = passed ? '✓ PASS' : '✗ FAIL';
    const color = passed ? colors.green : colors.red;
    log(color, `${status}: ${name}`);
  }

  log(colors.yellow, `\nTotal: ${passedTests}/${totalTests} passed`);

  if (passedTests === totalTests) {
    log(colors.green, '\n✓ All tests passed!');
    process.exit(0);
  } else {
    log(colors.red, '\n✗ Some tests failed');
    process.exit(1);
  }
}

// Run tests
runTests().catch(err => {
  log(colors.red, `Fatal error: ${err.message}`);
  process.exit(1);
});
