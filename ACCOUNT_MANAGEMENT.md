# Account Management System - Implementation Guide

## Overview

The multi-account management system allows you to manage multiple Twitch bot accounts with a single codebase. Tokens are encrypted and stored securely, eliminating the need to regenerate tokens for each account switch.

## Architecture

### Components

1. **account-manager.js** - Core account management module
   - Encrypted token storage (AES-256-CBC)
   - CRUD operations for accounts
   - Token lifecycle management
   - .env import/export

2. **token-generator.js** - Enhanced with account manager integration
   - New API endpoints for account management
   - Account-aware OAuth callbacks
   - Account selection UI (frontend coming)

3. **Excella** - Updated to support account loading
   - `--account` CLI flag for account selection
   - Automatic credential loading from encrypted storage
   - Fallback to .env if no account specified

4. **accounts.encrypted.json** - Encrypted account storage
   - Auto-generated on first use
   - Contains all account configurations
   - Encrypted with AES-256-CBC

## Usage

### Starting Bot with Specific Account

```bash
# Load and use 'mybot' account
node Excella --account=mybot

# Load and use 'testbot' account
node Excella --account=testbot

# Default: Use environment variables from .env
node Excella
```

### Managing Accounts via Token Generator

1. Start token generator:
   ```bash
   node token-generator.js
   # Open http://localhost:3000
   ```

2. Create new account:
   ```
   Account Name: mybot
   Client ID: [your-client-id]
   Client Secret: [your-client-secret]
   Broadcaster Name: twitch_username
   Channels: channel1,channel2,channel3
   ```

3. Authorize tokens:
   - Click "Authorize Bot Account"
   - Login with Twitch and approve scopes
   - Tokens are automatically encrypted and saved

4. Manage accounts via API:
   ```bash
   # List all accounts
   curl http://localhost:3000/api/accounts

   # Get specific account
   curl http://localhost:3000/api/accounts/mybot

   # Export account as .env
   curl http://localhost:3000/api/accounts/mybot/export

   # Delete account
   curl -X DELETE http://localhost:3000/api/accounts/mybot
   ```

### API Endpoints

#### GET /api/accounts
List all accounts (public info only)

**Response:**
```json
{
  "success": true,
  "accounts": [
    {
      "name": "mybot",
      "broadcasterName": "mytwitch",
      "channels": ["mytwitch"],
      "hasAccessToken": true,
      "tokenStatus": "valid",
      "tokenScopes": ["chat:read", "chat:edit"]
    }
  ]
}
```

#### GET /api/accounts/:name
Get single account details

#### POST /api/accounts
Create new account

**Request Body:**
```json
{
  "accountName": "newbot",
  "clientId": "xxx",
  "clientSecret": "xxx",
  "broadcasterName": "mytwitch",
  "channels": ["channel1", "channel2"]
}
```

#### PATCH /api/accounts/:name
Update account settings

**Request Body:**
```json
{
  "broadcasterName": "newname",
  "channels": ["newchannel"]
}
```

#### POST /api/accounts/:name/rename
Rename account

**Request Body:**
```json
{
  "newName": "renamed-bot"
}
```

#### DELETE /api/accounts/:name
Delete account

#### GET /api/accounts/:name/export
Download account as .env file

## Security

### Encryption

- **Algorithm:** AES-256-CBC
- **Key Size:** 32 bytes (256 bits)
- **IV:** Random 16 bytes per encryption
- **Storage:** `.encryption-key` file (chmod 600)

### Best Practices

1. **Never commit encryption key:**
   ```bash
   # Add to .gitignore
   echo ".encryption-key" >> .gitignore
   echo "accounts.encrypted.json" >> .gitignore
   ```

2. **Backup encryption key securely:**
   ```bash
   # Keep a backup of .encryption-key in secure location
   # If lost, ALL encrypted tokens become inaccessible
   ```

3. **Protect .env files:**
   ```bash
   # Ensure .env is in .gitignore
   echo ".env" >> .gitignore
   ```

4. **Limit file permissions:**
   ```bash
   chmod 600 .encryption-key
   chmod 600 accounts.encrypted.json
   chmod 600 .env
   ```

## Migration from Single Account

### Option 1: Keep Using .env (Backward Compatible)

```bash
# Just use the bot normally - no changes needed
node Excella
# Loads from TWITCH_* environment variables
```

### Option 2: Migrate to Account Manager

1. Create account from existing .env:
   ```bash
   # Visit http://localhost:3000
   # Enter your Client ID, Client Secret, etc.
   # Click "Create Account" with name "default"
   ```

2. Authorize tokens:
   ```bash
   # Click "Authorize Bot Account"
   # Tokens are encrypted and saved
   ```

3. Start bot with account:
   ```bash
   node Excella --account=default
   ```

4. Optional: Delete .env
   ```bash
   rm .env
   # Now you're fully using account manager
   ```

## Token Refresh

Tokens expire after ~1 hour. The bot automatically refreshes tokens on startup.

### Manual Token Refresh

```bash
# Visit token-generator and re-authorize account
node token-generator.js
# Click "Authorize Bot Account" for existing account
# New tokens are saved automatically
```

## Troubleshooting

### Error: Account not found

```bash
# List available accounts
curl http://localhost:3000/api/accounts

# Check account name spelling
node Excella --account=correctname
```

### Error: Account has not been authorized

```bash
# Account exists but tokens not set
# Run token-generator and authorize the account
node token-generator.js
# Click account name, then "Authorize Bot"
```

### Error: Encryption key mismatch

```bash
# Encryption key was regenerated or lost
# Tokens in accounts.encrypted.json are now inaccessible
# Options:
# 1. Delete .encryption-key to generate new one (requires re-auth)
# 2. Restore .encryption-key from backup
```

### Missing .encryption-key

```bash
# On first run of account-manager, key is auto-generated
# If you see this error:
# 1. Delete accounts.encrypted.json
# 2. Run token-generator (new key will be created)
# 3. Re-authorize all accounts
```

## Advanced Usage

### Import Account from .env File

```bash
const AccountManager = require('./account-manager');
const am = new AccountManager();
const envContent = require('fs').readFileSync('.env', 'utf8');

am.importFromEnv('mybot', envContent);
```

### Export All Accounts

```bash
const AccountManager = require('./account-manager');
const am = new AccountManager();

am.listAccounts().forEach(acc => {
  console.log(`\n=== ${acc.name} ===`);
  console.log(am.exportToEnv(acc.name));
});
```

### Switch Between Accounts at Runtime

```bash
# Start with account A
node Excella --account=botA

# To switch, restart with account B
# (requires stopping current process)
node Excella --account=botB
```

## Testing

Run the included test suite:

```bash
node test-account-manager.js
```

Output should show:
- ✓ Account creation
- ✓ Account listing
- ✓ Token updates
- ✓ Encryption/decryption
- ✓ Account deletion
- ✓ .env export

## File Structure

```
.
├── account-manager.js          # Core account management
├── token-generator.js          # Updated with account API
├── Excella                      # Updated with --account support
├── accounts.encrypted.json      # Auto-generated encrypted storage
├── .encryption-key             # Auto-generated encryption key (chmod 600)
├── .env                        # Still supported (legacy)
├── accounts.json.example       # Example structure (reference)
└── test-account-manager.js     # Test suite
```

## Future Enhancements

- [ ] Web UI for account management (dashboard integration)
- [ ] Account-specific cooldowns and rate limits
- [ ] Automatic token refresh scheduler
- [ ] Multi-account simultaneous operation
- [ ] Account export/import for backup
- [ ] PostgreSQL backend for production
- [ ] Account activity logging and audit trail
