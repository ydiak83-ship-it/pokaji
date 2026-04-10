#!/bin/bash
# Run this on the VPS after first SSH connection
# Usage: bash setup-server.sh

set -e

echo "=== Updating system ==="
apt-get update && apt-get upgrade -y

echo "=== Installing Docker ==="
curl -fsSL https://get.docker.com | sh

echo "=== Installing Docker Compose ==="
apt-get install -y docker-compose-plugin

echo "=== Installing Git ==="
apt-get install -y git

echo "=== Creating app directory ==="
mkdir -p /opt/pokaji
cd /opt/pokaji

echo "=== Done! ==="
echo "Now:"
echo "1. Copy project files to /opt/pokaji/"
echo "2. Create .env file"
echo "3. Run: docker compose up -d"
