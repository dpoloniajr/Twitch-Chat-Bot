# Twitch Bot Setup Guide

## Overview
This project now separates concerns:
- **token-generator.js**: Handles OAuth and scope selection only
- **Excella**: The bot itself (no auth concerns)

## Getting Your Token

### Step 1: Start the Token Generator
```bash
node token-generator.js
```

### Step 2: Open the Web Interface
Open your browser and navigate to:
```
http://localhost:3000
```

### Step 3: Select Required Scopes
The web interface displays **all available Twitch OAuth scopes** organized by category:
- **Chat (IRC)**: `chat:read`, `chat:edit`
- **Chat (Bot/User)**: `channel:bot`, `user:bot`, `user:write:chat`, etc.
- **Clips**: Clip management scopes
- **Moderation**: Moderation and AutoMod scopes
- **Channel Management**: Broadcast, ads, schedule, etc.
- **Followers & Subscriptions**: Follow/subscription data
- **VIPs**: VIP management
- **Channel Points**: Redemptions, predictions, polls
- **User Account**: Profile and emotes
- **Extensions & Analytics**: Extension and game analytics
- **Bits**: Bits information
- **Guest Star**: Guest Star features
- **Other**: Charity, goals, hype train, whispers, shield mode, etc.

**✓ Quick Tips:**
- Use **"Select All"** to request all scopes
- Use **"Clear All"** to start fresh
- Only select the scopes your bot needs (excessive scopes can result in app suspension)

### Step 4: Authorize
Click **"Authorize with Selected Scopes"** and complete the Twitch authorization.

### Step 5: Tokens Saved
Your tokens are automatically saved to `.env`:
```
TWITCH_ACCESS_TOKEN=your_access_token
TWITCH_REFRESH_TOKEN=your_refresh_token
```

## Starting Your Bot

Once you have your tokens in `.env`:

```bash
node Excella
```

The bot will:
1. Validate all required environment variables
2. Connect to Twitch chat
3. Join configured channels
4. Start responding to commands

## Environment Variables

Create a `.env` file with:
```
TWITCH_CLIENT_ID=your_client_id
TWITCH_CLIENT_SECRET=your_client_secret
TWITCH_ACCESS_TOKEN=generated_from_token_generator
TWITCH_REFRESH_TOKEN=generated_from_token_generator
TWITCH_BROADCASTER_NAME=your_channel_name
TWITCH_CHANNELS=channel1,channel2,channel3
```

## Available Bot Commands

- `!clip` - Create a clip of the current stream
- `!followage [username]` - Check how long someone has been following
- `!commands` or `!help` - Show available commands

## Troubleshooting

### "Missing required environment variables"
Make sure your `.env` file contains all required variables and restart the bot.

### Token expires or becomes invalid
Run the token generator again to get new tokens and update `.env`.

### Bot won't connect
- Check that `TWITCH_BROADCASTER_NAME` matches your actual Twitch username
- Verify all tokens are valid and not expired
- Check internet connection

## Changing Scopes

If you need different scopes later:
1. Stop the bot
2. Run the token generator again
3. Select the scopes you need
4. The new tokens will be saved to `.env`
5. Restart the bot

## How It Works

**Token Generator** handles the OAuth flow:
- Displays all available Twitch scopes
- Lets you choose which scopes to request
- Handles authorization with Twitch
- Saves tokens to `.env`

**Bot** focuses on functionality:
- Uses the tokens from `.env`
- Implements chat commands
- Handles API operations
- No authentication logic
