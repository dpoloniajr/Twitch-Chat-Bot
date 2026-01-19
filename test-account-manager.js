// Test account manager functionality
const AccountManager = require('./account-manager');

console.log('🧪 Testing Account Manager...\n');

const am = new AccountManager();

// Test 1: Create account
console.log('=== Test 1: Create Account ===');
try {
  const account = am.createAccount(
    'testbot1',
    'test-client-id',
    'test-client-secret',
    'testchannel',
    ['testchannel', 'otherchannel']
  );
  console.log('✓ Account created:', account.name);
  console.log('  - Channels:', account.channels);
  console.log('  - Created at:', account.createdAt);
} catch (err) {
  console.error('✗ Error:', err.message);
}

// Test 2: List accounts
console.log('\n=== Test 2: List Accounts ===');
try {
  const accounts = am.listAccounts();
  console.log('✓ Found', accounts.length, 'account(s)');
  accounts.forEach(acc => {
    console.log(`  - ${acc.name}:`, acc.tokenStatus, `(${acc.broadcasterTokenStatus})`);
  });
} catch (err) {
  console.error('✗ Error:', err.message);
}

// Test 3: Get account
console.log('\n=== Test 3: Get Account ===');
try {
  const account = am.getAccount('testbot1');
  if (account) {
    console.log('✓ Retrieved account:', account.name);
    console.log('  - Broadcaster:', account.broadcasterName);
    console.log('  - Channels:', account.channels.join(', '));
  } else {
    console.log('✗ Account not found');
  }
} catch (err) {
  console.error('✗ Error:', err.message);
}

// Test 4: Update tokens
console.log('\n=== Test 4: Update Tokens ===');
try {
  const updated = am.updateTokens('testbot1', {
    accessToken: 'test-access-token-12345',
    refreshToken: 'test-refresh-token-67890',
    scopes: ['chat:read', 'chat:edit', 'clips:edit'],
    expiresIn: 3600
  });
  console.log('✓ Tokens updated');
  console.log('  - Access token:', updated.accessToken.substring(0, 20) + '...');
  console.log('  - Scopes:', updated.tokenScopes.length);
  console.log('  - Expires at:', updated.tokenExpiresAt);
} catch (err) {
  console.error('✗ Error:', err.message);
}

// Test 5: Get as environment object
console.log('\n=== Test 5: Export as .env ===');
try {
  const envObj = am.getAsEnvObject('testbot1');
  console.log('✓ Exported to .env format');
  console.log('  - CLIENT_ID:', envObj.TWITCH_CLIENT_ID);
  console.log('  - BROADCASTER_NAME:', envObj.TWITCH_BROADCASTER_NAME);
  console.log('  - CHANNELS:', envObj.TWITCH_CHANNELS);
  console.log('  - SCOPES:', envObj.TWITCH_SCOPES);
  console.log('  - TOKEN_STATUS: ' + (envObj.TWITCH_ACCESS_TOKEN ? '✓ Valid' : '✗ Missing'));
} catch (err) {
  console.error('✗ Error:', err.message);
}

// Test 6: Encryption/Decryption
console.log('\n=== Test 6: Encryption/Decryption ===');
try {
  const testData = { secret: 'sensitive-token-data', timestamp: Date.now() };
  const encrypted = am.encrypt(testData);
  console.log('✓ Data encrypted');
  console.log('  - IV:', encrypted.iv.substring(0, 20) + '...');
  console.log('  - Encrypted data:', encrypted.data.substring(0, 30) + '...');
  
  const decrypted = am.decrypt(encrypted);
  if (decrypted.secret === testData.secret) {
    console.log('✓ Data decrypted correctly');
    console.log('  - Secret matches:', decrypted.secret);
  } else {
    console.log('✗ Decryption failed - data mismatch');
  }
} catch (err) {
  console.error('✗ Error:', err.message);
}

// Test 7: Update account settings
console.log('\n=== Test 7: Update Account Settings ===');
try {
  const updated = am.updateAccountSettings('testbot1', {
    channels: ['newchannel', 'anotherchannel'],
    broadcasterName: 'newbroadcaster'
  });
  console.log('✓ Account settings updated');
  console.log('  - New broadcaster:', updated.broadcasterName);
  console.log('  - New channels:', updated.channels.join(', '));
} catch (err) {
  console.error('✗ Error:', err.message);
}

// Test 8: Rename account
console.log('\n=== Test 8: Rename Account ===');
try {
  const renamed = am.renameAccount('testbot1', 'mainbot');
  console.log('✓ Account renamed to:', renamed.name);
} catch (err) {
  console.error('✗ Error:', err.message);
}

// Test 9: List after changes
console.log('\n=== Test 9: Final Account List ===');
try {
  const accounts = am.listAccounts();
  accounts.forEach(acc => {
    console.log(`✓ ${acc.name}`);
    console.log(`  - Broadcaster: ${acc.broadcasterName}`);
    console.log(`  - Channels: ${acc.channels.join(', ')}`);
    console.log(`  - Token status: ${acc.tokenStatus}`);
  });
} catch (err) {
  console.error('✗ Error:', err.message);
}

// Test 10: Delete account
console.log('\n=== Test 10: Delete Account ===');
try {
  am.deleteAccount('mainbot');
  console.log('✓ Account deleted');
  const remaining = am.listAccounts();
  console.log('  - Remaining accounts:', remaining.length);
} catch (err) {
  console.error('✗ Error:', err.message);
}

console.log('\n✅ All tests completed!');
