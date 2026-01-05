#!/usr/bin/env node
/* eslint-env node */

/**
 * Bundles the application with all dependencies into a single file
 * using esbuild
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const isProduction = process.env.NODE_ENV === 'production';

// Packages that should NOT be bundled (native modules, etc.)
// Playwright has native binaries that need to be installed separately
const external = [
  'playwright',
  'playwright-extra',
  'puppeteer-extra-plugin-stealth',
  // These might have native bindings, but let's try bundling them first
  // If they fail, add them to external
];

async function buildBundle() {
  console.log('📦 Bundling application with dependencies...\n');

  try {
    await build({
      entryPoints: [join(__dirname, 'src/index.ts')],
      bundle: true,
      outfile: join(__dirname, 'dist/index.js'),
      platform: 'node',
      target: 'node20',
      format: 'esm',
      sourcemap: !isProduction,
      minify: isProduction,
      external,
      banner: {
        js: `
// This file is bundled with all dependencies
// You can run it directly with: node dist/index.js
// Note: Playwright still needs to be installed separately for browser automation
        `.trim(),
      },
      define: {
        'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production'),
      },
      logLevel: 'info',
    });

    console.log('\n✅ Bundle created successfully!');
    console.log('📁 Output: dist/index.js');
    console.log('\n⚠️  Note: Playwright still needs to be installed separately');
    console.log('   Run: npm install playwright --production');
    console.log('   Or: npx playwright install');
  } catch (error) {
    console.error('❌ Build failed:', error);
    process.exit(1);
  }
}

buildBundle();
