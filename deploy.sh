#!/bin/bash

# Deploy to Quick and push to GitHub
# Usage: ./deploy.sh "commit message"

set -e  # Exit on any error

# Get commit message from argument or use default
COMMIT_MSG="${1:-Update appeal trends analyzer}"

echo "🚀 Starting deployment process..."

# Add all changes to git
echo "📁 Adding changes to git..."
git add .

# Check if there are any changes to commit
if git diff --staged --quiet; then
    echo "ℹ️  No changes to commit"
else
    # Commit changes
    echo "💾 Committing changes..."
    git commit -m "$COMMIT_MSG

🤖 Generated with [Claude Code](https://claude.ai/code)

Co-Authored-By: Claude <noreply@anthropic.com>"
fi

# Deploy to Quick
echo "🌐 Deploying to Quick..."
echo "y" | quick deploy . fraud-appeals-analyzer

# Push to GitHub
echo "📤 Pushing to GitHub..."
git push origin main

echo "✅ Deployment complete!"
echo "🌐 Live at: https://fraud-appeals-analyzer.quick.shopify.io"
echo "📂 GitHub: https://github.com/nsalei25/fraud-appeals-trends-analyzer"