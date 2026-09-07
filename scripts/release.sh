#!/bin/bash

# Release script for onething
# Usage: ./scripts/release.sh <version>
# Example: ./scripts/release.sh 1.0.0

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if version is provided
if [ -z "$1" ]; then
    echo -e "${RED}Error: Version number required${NC}"
    echo "Usage: ./scripts/release.sh <version>"
    echo "Example: ./scripts/release.sh 1.0.0"
    exit 1
fi

VERSION=$1
TAG="v${VERSION}"

echo -e "${GREEN}Starting release process for version ${VERSION}${NC}"

# Check if we're on main branch
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "main" ]; then
    echo -e "${YELLOW}Warning: You are not on main branch (current: ${CURRENT_BRANCH})${NC}"
    read -p "Continue anyway? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Check for uncommitted changes
if [[ -n $(git status -s) ]]; then
    echo -e "${RED}Error: You have uncommitted changes${NC}"
    git status -s
    exit 1
fi

# Check if tag already exists
if git rev-parse "$TAG" >/dev/null 2>&1; then
    echo -e "${RED}Error: Tag ${TAG} already exists${NC}"
    exit 1
fi

# Update version in package.json
echo -e "${GREEN}Updating version in package.json...${NC}"
if command -v jq &> /dev/null; then
    # Use jq if available
    tmp=$(mktemp)
    jq --arg version "$VERSION" '.version = $version' package.json > "$tmp" && mv "$tmp" package.json
else
    # Fallback to sed
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" package.json
    else
        sed -i "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" package.json
    fi
fi

# Show the diff
echo -e "${GREEN}Version updated:${NC}"
git diff package.json

# Confirm before proceeding
read -p "Continue with commit and tag? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}Aborted. Rolling back changes...${NC}"
    git checkout package.json
    exit 1
fi

# Commit version change
echo -e "${GREEN}Committing version change...${NC}"
git add package.json
git commit -m "chore: bump version to ${TAG}"

# Create tag
echo -e "${GREEN}Creating tag ${TAG}...${NC}"
git tag -a "$TAG" -m "Release ${TAG}"

# Push changes
echo -e "${GREEN}Pushing to remote...${NC}"
git push origin "$CURRENT_BRANCH"
git push origin "$TAG"

echo -e "${GREEN}✓ Release ${TAG} created successfully!${NC}"
echo ""
echo "Next steps:"
echo "1. Go to https://github.com/$(git config --get remote.origin.url | sed 's/.*github.com[:/]\(.*\)\.git/\1/')/actions"
echo "2. Monitor the build workflow"
echo "3. The workflow publishes the GitHub release automatically after all checks and builds pass"
