const fs = require('fs');
const path = require('path');
const EnvManager = require('./lib/env-manager');

const TEST_ENV = '.env.test';
const TEST_BACKUP_DIR = 'backups_test';

async function runTests() {
  console.log('🧪 Testing EnvManager...\n');

  // Cleanup from previous runs
  if (fs.existsSync(TEST_ENV)) fs.unlinkSync(TEST_ENV);
  if (fs.existsSync(TEST_BACKUP_DIR)) {
    fs.readdirSync(TEST_BACKUP_DIR).forEach(file => {
      fs.unlinkSync(path.join(TEST_BACKUP_DIR, file));
    });
    fs.rmdirSync(TEST_BACKUP_DIR);
  }

  const envManager = new EnvManager(TEST_ENV, TEST_BACKUP_DIR);

  // Test 1: Write initial .env
  console.log('=== Test 1: Initial Write ===');
  try {
    const initialContent = '# Initial Comment\nPORT=3000\n# Another comment\nBOT_TOKEN=old_token';
    fs.writeFileSync(TEST_ENV, initialContent);
    const env = await envManager.getEnv();
    console.log('✓ Initial .env read:', env);
    if (env.PORT === '3000' && env.BOT_TOKEN === 'old_token') {
      console.log('✓ Data matches');
    } else {
      throw new Error('Data mismatch');
    }
  } catch (err) {
    console.error('✗ Error:', err.message);
  }

  // Test 2: Update existing key
  console.log('\n=== Test 2: Update Existing Key ===');
  try {
    await envManager.updateEnv({ BOT_TOKEN: 'new_token_123' });
    const content = fs.readFileSync(TEST_ENV, 'utf8');
    console.log('✓ File content updated:');
    console.log(content);
    
    if (content.includes('BOT_TOKEN=new_token_123') && content.includes('# Initial Comment')) {
      console.log('✓ Comment preserved and token updated');
    } else {
      throw new Error('Update failed or comment lost');
    }
  } catch (err) {
    console.error('✗ Error:', err.message);
  }

  // Test 3: Add new keys
  console.log('\n=== Test 3: Add New Keys ===');
  try {
    await envManager.updateEnv({ 
      NEW_KEY: 'new_value',
      BROADCASTER_TOKEN: 'bc_token'
    });
    const env = await envManager.getEnv();
    console.log('✓ New keys added:', env);
    if (env.NEW_KEY === 'new_value' && env.BROADCASTER_TOKEN === 'bc_token') {
      console.log('✓ New keys verified');
    } else {
      throw new Error('New keys not found');
    }
  } catch (err) {
    console.error('✗ Error:', err.message);
  }

  // Test 4: Backup and List
  console.log('\n=== Test 4: Backup and List ===');
  try {
    const backupName = await envManager.createBackup();
    console.log('✓ Backup created:', backupName);
    const backups = envManager.listBackups();
    console.log('✓ Backups listed:', backups.length);
    if (backups.length === 1 && backups[0].filename === backupName) {
      console.log('✓ Backup verification successful');
    } else {
      throw new Error('Backup listing failed');
    }
  } catch (err) {
    console.error('✗ Error:', err.message);
  }

  // Test 5: Restore Backup
  console.log('\n=== Test 5: Restore Backup ===');
  try {
    // Modify current .env before restore
    await envManager.updateEnv({ BOT_TOKEN: 'temporary_token' });
    console.log('  - Modified .env before restore');
    
    const backups = envManager.listBackups();
    const oldestBackup = backups[backups.length - 1].filename;
    
    await envManager.restoreBackup(oldestBackup);
    const env = await envManager.getEnv();
    console.log('✓ Restored .env:', env);
    
    if (env.BOT_TOKEN === 'new_token_123') {
      console.log('✓ Restoration successful');
    } else {
      throw new Error('Restoration failed: token mismatch');
    }
    
    // Check if safety backup was created
    const finalBackups = envManager.listBackups();
    console.log('✓ Total backups after safety backup:', finalBackups.length);
    if (finalBackups.length === 2) {
      console.log('✓ Safety backup verified');
    }
  } catch (err) {
    console.error('✗ Error:', err.message);
  }

  console.log('\n✅ EnvManager tests completed!');

  // Final cleanup
  if (fs.existsSync(TEST_ENV)) fs.unlinkSync(TEST_ENV);
  if (fs.existsSync(TEST_BACKUP_DIR)) {
    fs.readdirSync(TEST_BACKUP_DIR).forEach(file => {
      fs.unlinkSync(path.join(TEST_BACKUP_DIR, file));
    });
    fs.rmdirSync(TEST_BACKUP_DIR);
  }
}

runTests().catch(console.error);
