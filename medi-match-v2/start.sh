#!/bin/bash
echo "🚑 Starting MediMatch v2..."
cd "$(dirname "$0")/backend"
npm install
node server.js
