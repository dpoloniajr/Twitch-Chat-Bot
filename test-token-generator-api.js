const axios = require('axios');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 3005;
const BASE_URL = `http://localhost:${PORT}`;
const TEST_ENV = '.env.api-test';
const TEST_BACKUP_DIR = 'backups_api_test';

async function runTests() {
  console.log('🧪 Testing Token Generator API...\n');

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

  let serverStarted = false;
  
  // Wait for server to start
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server start timeout')), 10000);
    server.stdout.on('data', (data) => {
      console.log(`[Server]: ${data}`);
      if (data.toString().includes('Server running at')) {
        serverStarted = true;
        clearTimeout(timeout);
        resolve();
      }
    });
    server.stderr.on('data', (data) => {
      console.error(`[Server Error]: ${data}`);
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
      if (err.response) {
        console.log(`  Response Status: ${err.response.status}`);
        console.log(`  Response Data: ${JSON.stringify(err.response.data)}`);
      }
      failCount++;
    }
  }

  try {
    // Test 1: Health Check
    await test('GET /api/env/backups', async () => {
      const res = await axios.get(`${BASE_URL}/api/env/backups`);
      if (res.status !== 200 || !Array.isArray(res.data.backups)) {
        throw new Error('Failed to list backups');
      }
    });

    // Test 2: Create Backup
    await test('POST /api/env/backup', async () => {
      const res = await axios.post(`${BASE_URL}/api/env/backup`);
      if (res.status !== 200 || !res.data.success) {
        throw new Error('Failed to create backup');
      }
      console.log(`  (Backup created: ${res.data.backupName})`);
    });

    // Test 3: Get Scopes
    await test('GET /api/scopes/presets', async () => {
      const res = await axios.get(`${BASE_URL}/api/scopes/presets`);
      if (res.status !== 200 || !res.data['bot-recommended']) {
        throw new Error('Failed to get scope presets');
      }
    });

    // Test 4: Current Tokens
    await test('GET /api/current-tokens', async () => {
      const res = await axios.get(`${BASE_URL}/api/current-tokens`);
      if (res.status !== 200) {
        throw new Error('Failed to get current tokens');
      }
    });

    // Test 5: Test Connection (Validation)
    await test('POST /api/test-connection (Empty Token)', async () => {
      try {
        await axios.post(`${BASE_URL}/api/test-connection`, { token: '' });
        throw new Error('Should have failed with 400');
      } catch (err) {
        if (!err.response || err.response.status !== 400) {
          throw err;
        }
      }
    });

  } finally {
    // Kill the server
    console.log('\nStopping test server...');
    server.kill();
    
    // Cleanup
    if (fs.existsSync(TEST_ENV)) fs.unlinkSync(TEST_ENV);
    // Note: we leave TEST_BACKUP_DIR for manual inspection if needed, or clean it up
    if (fs.existsSync(TEST_BACKUP_DIR)) {
       fs.readdirSync(TEST_BACKUP_DIR).forEach(file => fs.unlinkSync(path.join(TEST_BACKUP_DIR, file)));
       fs.rmdirSync(TEST_BACKUP_DIR);
    }
  }

  console.log(`\nTests finished: ${passCount} Passed, ${failCount} Failed`);
  process.exit(failCount > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Fatal Test Error:', err);
  process.exit(1);
});
