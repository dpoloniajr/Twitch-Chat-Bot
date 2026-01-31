# Contributing to Twitch Chat Bot

Thank you for your interest in contributing to the Twitch Chat Bot project! This guide will help you set up your development environment and resolve common issues, particularly authentication problems when pushing to GitHub.

## Table of Contents

- [Getting Started](#getting-started)
- [Fixing GitHub Authentication Issues](#fixing-github-authentication-issues)
- [Development Workflow](#development-workflow)
- [Code Style](#code-style)
- [Submitting Changes](#submitting-changes)

## Getting Started

1. **Fork the Repository**
   - Visit https://github.com/dpoloniajr/Twitch-Chat-Bot
   - Click the "Fork" button in the top-right corner
   - This creates a copy of the repository under your GitHub account

2. **Clone Your Fork**
   ```bash
   git clone https://github.com/YOUR-USERNAME/Twitch-Chat-Bot.git
   cd Twitch-Chat-Bot
   ```

3. **Install Dependencies**
   ```bash
   npm install
   ```

4. **Set Up Environment**
   ```bash
   cp .env.example .env
   # Edit .env with your Twitch credentials
   ```

## Fixing GitHub Authentication Issues

If you're experiencing "Authentication failed" errors when trying to push to GitHub, this section will help you resolve them.

### Understanding the Problem

GitHub removed support for password authentication in August 2021. You now need to use one of these methods:
- **Personal Access Token (PAT)** - Recommended for HTTPS
- **SSH Keys** - Alternative method using SSH protocol

### Solution 1: Personal Access Token (PAT) - Recommended

This is the easiest method for GitHub Desktop and command-line users.

#### For GitHub Desktop Users:

1. **Sign Out and Sign Back In**
   - Open GitHub Desktop
   - Go to `File` → `Options` (Windows) or `GitHub Desktop` → `Preferences` (Mac)
   - Click `Accounts`
   - Click `Sign Out`
   - Click `Sign in` and follow the browser authentication flow
   - GitHub Desktop will automatically handle authentication

2. **If the Above Doesn't Work, Use a Personal Access Token**
   - Go to https://github.com/settings/tokens
   - Click `Generate new token` → `Generate new token (classic)`
   - Give it a descriptive name (e.g., "Twitch Bot Development")
   - Set expiration (recommended: 90 days)
   - Select scopes:
     - ✅ `repo` (Full control of private repositories)
     - ✅ `workflow` (Update GitHub Action workflows)
   - Click `Generate token`
   - **IMPORTANT**: Copy the token immediately (you won't see it again!)
   - In GitHub Desktop, when prompted for credentials, use:
     - Username: Your GitHub username
     - Password: Paste the Personal Access Token

#### For Command-Line Git Users:

1. **Create a Personal Access Token**
   - Follow steps 1-5 from above to generate a PAT

2. **Configure Git to Use the Token**

   **Option A: Store credentials in Git credential helper (Recommended)**
   ```bash
   # Enable credential helper
   git config --global credential.helper store
   
   # Now when you push, Git will prompt for credentials once
   git push
   # Username: your-github-username
   # Password: paste-your-personal-access-token
   
   # Credentials are saved and you won't be prompted again
   ```

   **Option B: Use token directly in remote URL**
   ```bash
   # Update the remote URL to include your token
   git remote set-url origin https://YOUR-USERNAME:YOUR-TOKEN@github.com/dpoloniajr/Twitch-Chat-Bot.git
   
   # Verify the change
   git remote -v
   ```
   
   **⚠️ Warning**: Option B stores your token in plain text in `.git/config`. Use Option A for better security.

### Solution 2: SSH Keys

If you prefer SSH over HTTPS, follow these steps:

#### 1. Generate SSH Key (if you don't have one)

```bash
# Generate a new SSH key
ssh-keygen -t ed25519 -C "your-email@example.com"

# Press Enter to accept default file location
# Enter a passphrase (optional but recommended)
```

#### 2. Add SSH Key to ssh-agent

**On Windows:**
```bash
# Start ssh-agent
eval "$(ssh-agent -s)"

# Add your SSH key
ssh-add ~/.ssh/id_ed25519
```

**On Mac/Linux:**
```bash
# Start ssh-agent
eval "$(ssh-agent -s)"

# Add your SSH key
ssh-add ~/.ssh/id_ed25519
```

#### 3. Add SSH Key to GitHub

```bash
# Copy your public key to clipboard
# Windows (with Git Bash):
cat ~/.ssh/id_ed25519.pub | clip

# Mac:
pbcopy < ~/.ssh/id_ed25519.pub

# Linux:
cat ~/.ssh/id_ed25519.pub
# Then manually copy the output
```

- Go to https://github.com/settings/keys
- Click `New SSH key`
- Give it a title (e.g., "Development Laptop")
- Paste your public key
- Click `Add SSH key`

#### 4. Change Remote URL to SSH

```bash
# Change from HTTPS to SSH
git remote set-url origin git@github.com:dpoloniajr/Twitch-Chat-Bot.git

# Verify the change
git remote -v

# Test the connection
ssh -T git@github.com
# You should see: "Hi USERNAME! You've successfully authenticated..."
```

### Solution 3: GitHub CLI (gh)

GitHub CLI is a modern command-line tool that handles authentication automatically.

```bash
# Install GitHub CLI
# Windows (with Chocolatey): choco install gh
# Mac (with Homebrew): brew install gh
# Linux: See https://github.com/cli/cli#installation

# Authenticate
gh auth login

# Follow the prompts to authenticate via browser
# Choose: HTTPS or SSH
# GitHub CLI will configure everything for you
```

## Common Authentication Errors and Solutions

### Error: "remote: Support for password authentication was removed"

**Solution**: You're using a password instead of a token. Follow [Solution 1](#solution-1-personal-access-token-pat---recommended) above.

### Error: "fatal: Authentication failed for 'https://github.com/...'"

**Solution**: Your credentials are incorrect or expired.
- Generate a new Personal Access Token
- Update your stored credentials:
  ```bash
  # Clear stored credentials
  git credential reject
  # Type: protocol=https
  # Type: host=github.com
  # Press Enter twice
  
  # Now push again and enter new credentials
  git push
  ```

### Error: "Permission denied (publickey)"

**Solution**: Your SSH key is not set up correctly.
- Follow [Solution 2](#solution-2-ssh-keys) above
- Ensure your SSH key is added to ssh-agent: `ssh-add -l`
- Verify your SSH key is added to GitHub: https://github.com/settings/keys

### Error: "fatal: could not read Username"

**Solution**: Git can't find your credentials.
```bash
# Configure your username
git config --global user.name "Your Name"
git config --global user.email "your-email@example.com"

# Then try again
git push
```

## Development Workflow

1. **Create a new branch for your feature/fix**
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes**
   - Edit files as needed
   - Test your changes thoroughly

3. **Commit your changes**
   ```bash
   git add .
   git commit -m "Description of your changes"
   ```

4. **Push to your fork**
   ```bash
   git push origin feature/your-feature-name
   ```

5. **Create a Pull Request**
   - Go to your fork on GitHub
   - Click "Compare & pull request"
   - Describe your changes
   - Submit the pull request

## Code Style

- Use consistent indentation (2 spaces for JavaScript)
- Follow existing code patterns in the repository
- Add comments for complex logic
- Test your changes before submitting

## Testing Your Changes

Before submitting a pull request:

1. **Test the bot locally**
   ```bash
   node Excella
   ```

2. **Test the token generator**
   ```bash
   node token-generator.js
   ```

3. **Test the dashboard (if applicable)**
   ```bash
   npm run dashboard
   ```

4. **Verify no errors in console**

## Submitting Changes

1. Ensure your code follows the project's code style
2. Test your changes thoroughly
3. Update documentation if needed (README.md, etc.)
4. Create a clear, descriptive pull request
5. Respond to any feedback from maintainers

## Need Help?

If you're still experiencing issues after trying these solutions:

1. Check existing issues: https://github.com/dpoloniajr/Twitch-Chat-Bot/issues
2. Open a new issue with:
   - Description of the problem
   - Error messages (if any)
   - Steps you've already tried
   - Your operating system and Git version (`git --version`)

## Additional Resources

- [GitHub Personal Access Tokens Documentation](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/creating-a-personal-access-token)
- [GitHub SSH Keys Documentation](https://docs.github.com/en/authentication/connecting-to-github-with-ssh)
- [GitHub Desktop Documentation](https://docs.github.com/en/desktop)
- [Git Credential Helper Documentation](https://git-scm.com/docs/gitcredentials)

---

Thank you for contributing to Twitch Chat Bot! 🎉
