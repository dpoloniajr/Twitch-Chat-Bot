const fs = require('fs');
const path = require('path');
const EnvManager = require('./lib/env-manager');
const AccountManager = require('./account-manager');

const TEST_ENV = '.env.verify';
const TEST_BACKUP_DIR = 'backups_verify';

async function verify() {
  console.log('🧪 Final Verification of Token Writing Logic...\n');

  // Setup
  if (fs.existsSync(TEST_ENV)) fs.unlinkSync(TEST_ENV);
  const envManager = new EnvManager(TEST_ENV, TEST_BACKUP_DIR);
  const am = new AccountManager();

  console.log('--- Step 1: Testing .env Bot Token Write ---');
  await envManager.updateEnv({
    TWITCH_ACCESS_TOKEN: 'bot_access_123',
    TWITCH_REFRESH_TOKEN: 'bot_refresh_123',
    TWITCH_SCOPES: 'chat:read chat:edit'
  });
  
  let env = await envManager.getEnv();
  if (env.TWITCH_ACCESS_TOKEN === 'bot_access_123') {
    console.log('✓ Bot token written to .env correctly');
  } else {
    throw new Error('Bot token write failed');
  }

  console.log('\n--- Step 2: Testing .env Broadcaster Token Write ---');
  await envManager.updateEnv({
    TWITCH_BROADCASTER_ACCESS_TOKEN: 'bc_access_456',
    TWITCH_BROADCASTER_REFRESH_TOKEN: 'bc_refresh_456',
    TWITCH_BROADCASTER_SCOPES: 'bits:read channel:read:subscriptions'
  });
  
  env = await envManager.getEnv();
  if (env.TWITCH_BROADCASTER_ACCESS_TOKEN === 'bc_access_456' && env.TWITCH_ACCESS_TOKEN === 'bot_access_123') {
    console.log('✓ Broadcaster token added to .env while preserving Bot token');
  } else {
    throw new Error('Broadcaster token write failed or corrupted existing data');
  }

  console.log('\n--- Step 3: Testing Account Manager Multi-Token Support ---');
  const accName = 'VerificationAccount';
  // Clean up if exists
  try { am.deleteAccount(accName); } catch (e) {}
  
  am.createAccount(accName, 'cid', 'csec', 'bname', ['chan']);
  
  // Update Bot tokens
  am.updateTokens(accName, {
    accessToken: 'acc_bot_token',
    refreshToken: 'acc_bot_refresh',
    scopes: ['chat:read'],
    expiresIn: 3600
  });

  // Update Broadcaster tokens separately (as OAuth flow would do)
  am.updateTokens(accName, {
    broadcasterAccessToken: 'acc_bc_token',
    broadcasterRefreshToken: 'acc_bc_refresh',
    broadcasterScopes: ['bits:read'],
    broadcasterExpiresIn: 3600
  });

  const account = am.getAccount(accName);
  if (account.accessToken === 'acc_bot_token' && account.broadcasterAccessToken === 'acc_bc_token') {
    console.log('✓ Account Manager correctly stores both Bot and Broadcaster tokens');
  } else {
    throw new Error('Account Manager failed to store dual tokens');
  }

  console.log('\n--- Step 4: Verification of Env Export with Dual Tokens ---');
  const exported = am.exportToEnv(accName);
  if (exported.includes('TWITCH_ACCESS_TOKEN=acc_bot_token') && exported.includes('TWITCH_BROADCASTER_ACCESS_TOKEN=acc_bc_token')) {
    console.log('✓ Exported .env content contains both Bot and Broadcaster tokens');
  } else {
    throw new Error('Exported .env missing tokens');
  }

  // Final Cleanup
  fs.unlinkSync(TEST_ENV);
  if (fs.existsSync(TEST_BACKUP_DIR)) {
      fs.readdirSync(TEST_BACKUP_DIR).forEach(f => fs.unlinkSync(path.join(TEST_BACKUP_DIR, f)));
      fs.rmdirSync(TEST_BACKUP_DIR);
  }
  am.deleteAccount(accName);

  console.log('\n✅ All final verifications passed!');
}

verify().catch(err => {
  console.error('✗ Verification failed:', err.message);
  process.exit(1);
});
