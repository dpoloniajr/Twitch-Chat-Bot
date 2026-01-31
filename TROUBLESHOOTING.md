# Troubleshooting Guide

## Git Push Issues

### Problem: Cannot push to repository

If you're experiencing issues pushing to the repository, it may be due to an incorrectly configured git fetch refspec.

#### Symptoms
- Git push fails with authentication errors
- Cannot fetch branches from remote
- Git operations hang or timeout
- Error messages like "Invalid username or token" or "Authentication failed"

#### Solution

Run the following command to fix the fetch refspec:

```bash
git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
```

This changes the git configuration from fetching only a specific branch to fetching all branches, which is the standard configuration.

#### What this does

The fetch refspec tells git which remote branches to fetch and how to map them to local tracking branches. The standard configuration is:

```
+refs/heads/*:refs/remotes/origin/*
```

This means: fetch all branches from `refs/heads/*` on the remote and store them as `refs/remotes/origin/*` locally.

#### Verify the fix

After running the command, verify the configuration:

```bash
git config --get remote.origin.fetch
```

Expected output:
```
+refs/heads/*:refs/remotes/origin/*
```

#### Alternative: Manual edit

You can also manually edit `.git/config` and change the `fetch` line under `[remote "origin"]` to:

```
fetch = +refs/heads/*:refs/remotes/origin/*
```

## Other Common Issues

### Token Generator Won't Start

**Problem**: Port 3000 is already in use

**Solution**:
```bash
# Find process using port 3000
lsof -i :3000
# Kill the process or change the port in token-generator.js
```

### Bot Won't Connect to Chat

**Problem**: Authentication or configuration issues

**Solutions**:
1. Verify all environment variables are set in `.env`
2. Check that tokens haven't expired
3. Ensure `TWITCH_CHANNELS` matches actual channel names
4. Regenerate tokens using `node token-generator.js`

### Commands Not Responding

**Problem**: Bot is connected but commands don't work

**Solutions**:
1. Verify bot has `chat:read` and `chat:edit` scopes
2. Check that commands are typed correctly (case-sensitive)
3. Ensure bot has proper permissions in channel
4. Check bot logs for error messages

### Dashboard Not Loading

**Problem**: Dashboard is not accessible

**Solutions**:
1. Check if dashboard port (default 3001) is in use
2. Verify `DASHBOARD_PORT` in `.env`
3. Ensure dashboard is enabled (not disabled)
4. Check for errors in console when starting the bot

For more help, see the main [README.md](README.md).
