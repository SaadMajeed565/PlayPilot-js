#!/usr/bin/env node
/* eslint-env node */

/**
 * Deployment script to package the backend for distribution
 * This script copies all necessary files for deployment
 */

import { copyFileSync, mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEPLOY_DIR = join(__dirname, 'deploy');
const DIST_DIR = join(__dirname, 'dist');

console.log('📦 Creating deployment package...\n');

// Recursive directory copy function
function copyDir(src, dest) {
  if (!existsSync(dest)) {
    mkdirSync(dest, { recursive: true });
  }
  
  const entries = readdirSync(src, { withFileTypes: true });
  
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

// Create deploy directory
if (!existsSync(DEPLOY_DIR)) {
  mkdirSync(DEPLOY_DIR, { recursive: true });
} else {
  console.log('⚠️  Deploy directory already exists. Cleaning...');
  rmSync(DEPLOY_DIR, { recursive: true, force: true });
  mkdirSync(DEPLOY_DIR, { recursive: true });
}

// Check if dist exists
if (!existsSync(DIST_DIR)) {
  console.error('❌ Error: dist directory not found. Please run "npm run build" first.');
  process.exit(1);
}

// Copy dist folder
console.log('📋 Copying dist folder...');
copyDir(DIST_DIR, join(DEPLOY_DIR, 'dist'));

// Copy package.json
console.log('📋 Copying package.json...');
copyFileSync(join(__dirname, 'package.json'), join(DEPLOY_DIR, 'package.json'));

// Copy package-lock.json if it exists
if (existsSync(join(__dirname, 'package-lock.json'))) {
  console.log('📋 Copying package-lock.json...');
  copyFileSync(join(__dirname, 'package-lock.json'), join(DEPLOY_DIR, 'package-lock.json'));
}

// Check if dist/index.js is a bundle (has bundled dependencies)
const distIndexPath = join(DEPLOY_DIR, 'dist', 'index.js');
let isBundled = false;
if (existsSync(distIndexPath)) {
  const distContent = readFileSync(distIndexPath, 'utf-8');
  isBundled = distContent.includes('// This file is bundled with all dependencies');
}

// Create production package.json
console.log('📋 Creating production package.json...');
const packageJson = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));

let productionPackageJson;
if (isBundled) {
  // For bundled builds, only include Playwright (can't be bundled)
  console.log('   Detected bundled build - creating minimal package.json');
  productionPackageJson = {
    name: packageJson.name,
    version: packageJson.version,
    type: 'module',
    main: 'dist/index.js',
    scripts: {
      start: 'node dist/index.js',
    },
    dependencies: {
      // Only Playwright needs to be installed (has native binaries)
      playwright: packageJson.dependencies.playwright,
      'playwright-extra': packageJson.dependencies['playwright-extra'],
      'puppeteer-extra-plugin-stealth': packageJson.dependencies['puppeteer-extra-plugin-stealth'],
    },
  };
} else {
  // For regular builds, include all production dependencies
  productionPackageJson = {
    ...packageJson,
    scripts: {
      start: packageJson.scripts.start,
    },
    devDependencies: undefined,
  };
}

writeFileSync(
  join(DEPLOY_DIR, 'package.json'),
  JSON.stringify(productionPackageJson, null, 2)
);

// Create deployment README
const bundledNote = isBundled 
  ? `\n**Note:** This is a bundled build. Most dependencies are already included in \`dist/index.js\`.
   You only need to install Playwright (for browser automation).`
  : `\n**Note:** This is a regular build. All dependencies need to be installed.`;

const readmeContent = `# Deployment Package

This package contains the built backend application.
${bundledNote}

## Installation

1. Copy this entire folder to your deployment location
2. Navigate to the folder in terminal
3. Run: \`npm install --production\`
   ${isBundled ? '(This will only install Playwright and related packages)' : ''}
4. ${isBundled ? 'If using Playwright, run: \`npx playwright install\`\n4. ' : ''}Create a \`.env\` file with your environment variables (see below)
5. Run: \`npm start\`

## Environment Variables

Create a \`.env\` file in this directory with the following variables:

\`\`\`
PORT=3000
OPENAI_API_KEY=your_key_here
LLM_PROVIDER=openai
FRONTEND_URL=http://localhost:5173
# Add other required environment variables
\`\`\`

## Running

\`\`\`bash
npm start
\`\`\`

The server will start on the port specified in your \`.env\` file (default: 3000).
`;

writeFileSync(join(DEPLOY_DIR, 'DEPLOYMENT.md'), readmeContent);

console.log('\n✅ Deployment package created successfully!');
console.log(`📁 Location: ${DEPLOY_DIR}`);
console.log('\n📝 Next steps:');
console.log('   1. Copy the "deploy" folder to your deployment location');
console.log('   2. Navigate to the folder and run: npm install --production');
console.log('   3. Create a .env file with your environment variables');
console.log('   4. Run: npm start');
console.log('\n✨ Done!');
