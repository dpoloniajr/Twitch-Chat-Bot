const axios = require('axios');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 3006;
const BASE_URL = `http://localhost:${PORT}`;
const TEST_ENV = '.env.acc-test';
const TEST_BACKUP_DIR = 'backups_acc_test';

async function runTests() {
  console.log('🧪 Testing Account Management API...\n');

  // Setup test .env
  fs.writeFileSync(TEST_ENV, 'PORT=' + PORT + '\nTWITCH_CLIENT_ID=test_id\nTWITCH_CLIENT_SECRET=test_secret\n');
  if (!fs.existsSync(TEST_BACKUP_DIR)) fs.mkdirSync(TEST_BACKUP_DIR);

  // Start the server
  console.log('Starting test server on port ' + PORT + '...');
  const server = spawn('node', ['token-generator.js'], {
    env: { 
      ...process.env, 
      PORT: PORT, 
      TOKEN_GENERATOR_PORT: PORT,
      ENV_PATH: TEST_ENV,
      BACKUP_DIR: TEST_BACKUP_DIR,
      NODE_ENV: 'test' 
    },
    stdio: 'pipe'
  });

  await new Promise((resolve) => {
    server.stdout.on('data', (data) => {
      if (data.toString().includes('Server running at')) resolve();
    });
  });

  let passCount = 0;
  let failCount = 0;

  async function test(name, fn) {
    process.stdout.write(`- ${name}: `);
    try {
      await fn();
      console.log('✓ Pass');
      passCount++;
    } catch (err) {
      console.log(`✗ Fail (${err.message})`);
      failCount++;
    }
  }

  try {
    // Test 1: List Accounts (Empty)
    await test('GET /api/accounts', async () => {
      const res = await axios.get(`${BASE_URL}/api/accounts`);
      if (res.status !== 200 || !Array.isArray(res.data.accounts)) throw new Error('Invalid accounts response');
    });

    // Test 2: Create Account
    await test('POST /api/accounts', async () => {
      const res = await axios.post(`${BASE_URL}/api/accounts`, {
        accountName: 'TestBot',
        clientId: 'bot_id',
        clientSecret: 'bot_secret',
        broadcasterName: 'BroadcasterUser',
        channels: ['chan1', 'chan2']
      });
      if (!res.data.success) throw new Error('Failed to create account');
    });

    // Test 3: Verify Account was created
    await test('Verify Account Existence', async () => {
      const res = await axios.get(`${BASE_URL}/api/accounts`);
      const account = res.data.accounts.find(a => a.name === 'TestBot');
      if (!account) throw new Error('Account not found after creation');
    });

    // Test 4: Delete Account
    await test('DELETE /api/accounts/TestBot', async () => {
      const res = await axios.delete(`${BASE_URL}/api/accounts/TestBot`);
      if (!res.data.success) throw new Error('Failed to delete account');
    });

  } finally {
    server.kill();
    if (fs.existsSync(TEST_ENV)) fs.unlinkSync(TEST_ENV);
    if (fs.existsSync(TEST_BACKUP_DIR)) {
       fs.readdirSync(TEST_BACKUP_DIR).forEach(file => fs.unlinkSync(path.join(TEST_BACKUP_DIR, file)));
       fs.rmdirSync(TEST_BACKUP_DIR);
    }
    // Clean up test account file if created
    if (fs.existsSync('accounts.encrypted.json')) {
        // We might want to keep it or delete it. For tests, better to delete.
        // But AccountManager might use a different name in test? No, it uses default.
    }
  }

  console.log(`\nTests finished: ${passCount} Passed, ${failCount} Failed`);
  process.exit(failCount > 0 ? 1 : 0);
}

runTests().catch(console.error);
