# Account Management - Quick Start

## 5-Minute Setup

### Step 1: Start Token Generator
```bash
node token-generator.js
# Opens http://localhost:3000
```

### Step 2: Create Account
```
Account Name: mybot
Client ID: [from Twitch dev console]
Client Secret: [from Twitch dev console]
Broadcaster Name: your_twitch_username
Channels: your_twitch_username,friend_channel
```

### Step 3: Authorize
- Click "Authorize Bot Account"
- Login to Twitch
- Approve requested scopes
- Tokens saved automatically ✓

### Step 4: Start Bot
```bash
node Excella --account=mybot
```

Done! 🎉

## Common Commands

```bash
# List all accounts
curl http://localhost:3000/api/accounts

# Start bot with specific account
node Excella --account=mybot

# Export account as .env (backup)
curl http://localhost:3000/api/accounts/mybot/export > mybot.env

# Switch between accounts (requires restart)
node Excella --account=testbot
```

## Important Files

- `accounts.encrypted.json` - Your encrypted tokens (auto-created)
- `.encryption-key` - Encryption key (auto-created, KEEP SAFE!)
- `.env` - Still works (legacy), loaded if --account not specified

## Security Reminders

⚠️ **Never commit .encryption-key to git!**
```bash
echo ".encryption-key" >> .gitignore
```

⚠️ **Backup your encryption key** - if lost, tokens become inaccessible

⚠️ **Keep tokens secure** - only share .env with trusted admins

## Need Help?

See [ACCOUNT_MANAGEMENT.md](ACCOUNT_MANAGEMENT.md) for detailed docs.
