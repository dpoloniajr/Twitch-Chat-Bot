#!/bin/bash

# Git Setup and Validation Script
# This script ensures that your git configuration is correct for pushing to the repository

echo "==================================="
echo "Git Configuration Setup Script"
echo "==================================="
echo ""

# Check if we're in a git repository
if ! git rev-parse --git-dir > /dev/null 2>&1; then
    echo "❌ Error: Not in a git repository"
    exit 1
fi

echo "✓ Git repository detected"
echo ""

# Get current fetch refspec
current_fetch=$(git config --get remote.origin.fetch)
echo "Current fetch refspec: $current_fetch"

# Check if fetch refspec is correct
expected_fetch="+refs/heads/*:refs/remotes/origin/*"

if [ "$current_fetch" = "$expected_fetch" ]; then
    echo "✓ Fetch refspec is already correct"
else
    echo "⚠ Fetch refspec needs to be updated"
    echo "  Current: $current_fetch"
    echo "  Expected: $expected_fetch"
    echo ""
    read -p "Do you want to fix the fetch refspec? (y/n) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        git config remote.origin.fetch "$expected_fetch"
        if [ $? -eq 0 ]; then
            echo "✓ Fetch refspec updated successfully"
        else
            echo "❌ Failed to update fetch refspec"
            exit 1
        fi
    else
        echo "⚠ Skipped fetch refspec update"
    fi
fi

echo ""
echo "==================================="
echo "Configuration Summary"
echo "==================================="

# Display key git configuration
echo ""
echo "Remote URL:"
git remote get-url origin

echo ""
echo "Fetch Refspec:"
git config --get remote.origin.fetch

echo ""
echo "Current Branch:"
git branch --show-current

echo ""
echo "User Configuration:"
echo "  Name: $(git config --get user.name)"
echo "  Email: $(git config --get user.email)"

echo ""
echo "==================================="
echo "Git configuration setup complete!"
echo "==================================="
