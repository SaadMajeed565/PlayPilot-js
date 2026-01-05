# AI-driven Web Automation System

A production-grade web automation system that converts Chrome Recorder JSON recordings into robust, generalizable automation skills executed through Playwright.

## Features

- 🔄 **Chrome Recorder Integration**: Convert DevTools recordings into executable automation
- 🧠 **AI-Powered Intent Extraction**: Automatically identify user intents (login, search, form submission, etc.)
- 🔧 **Selector Healing**: Automatically resolve broken selectors using multi-tier strategies
- ⚙️ **Logic Engine**: Inject retries, conditionals, loops, and error handling
- 🎭 **Playwright Execution**: Robust browser automation with comprehensive error handling
- 📊 **Telemetry & Monitoring**: Track success rates, selector healing, and execution metrics
- 🚀 **REST API**: Submit jobs, check status, and retrieve artifacts

## Architecture

```
[Recorder JSON] → [Preprocessor] → [Intent Extractor] → [Skill Generator (LLM)] 
→ [Selector Healer + Logic Engine] → [Playwright Command Generator] → [Executor] 
→ [Telemetry + Memory]
```

## Installation

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run in development mode
npm run dev

# Run production build
npm start
```

## Deployment

To deploy the application to another location, you have two options:

### Option 1: Bundled Build (Recommended - No node_modules needed!)

This bundles all dependencies (except Playwright) into a single file, so you don't need to install most dependencies:

```bash
# Build with bundled dependencies
npm run build:bundle

# Create deployment package
npm run deploy

# Or do both in one command:
npm run package:bundle
```

This creates a `deploy` folder where:
- `dist/index.js` contains **all your code + most dependencies bundled together**
- `package.json` only includes Playwright (which can't be bundled)
- You only need to run `npm install --production` to get Playwright

**Benefits:**
- ✅ No need for most `node_modules` (only Playwright)
- ✅ Smaller deployment size
- ✅ Faster deployment (less to install)
- ✅ Single file to copy

**Note:** Playwright still needs to be installed separately because it has native browser binaries.

### Option 2: Regular Build (Traditional)

```bash
# Build TypeScript
npm run build

# Create deployment package
npm run package
```

This creates a `deploy` folder where:
- `dist/` contains your compiled code
- `package.json` includes all dependencies
- You need to run `npm install --production` to install everything

### After Deployment

1. Copy the `deploy` folder to your deployment location
2. Navigate to the folder and run:
   ```bash
   npm install --production
   ```
3. If using Playwright, install browsers:
   ```bash
   npx playwright install
   ```
4. Create a `.env` file with your environment variables
5. Run: `npm start`

### Manual Deployment

If you prefer to deploy manually:

1. Copy the following to your deployment location:
   - `dist/` folder (the compiled code)
   - `package.json` file

2. In the deployment location, run:
   ```bash
   npm install --production
   ```

3. Create a `.env` file with your environment variables

4. Run the application:
   ```bash
   npm start
   ```

## Usage

### Basic Example

```typescript
import { AutomationPipeline } from './core/Pipeline.js';
import { JobManager } from './core/JobManager.js';

const pipeline = new AutomationPipeline();
const jobManager = new JobManager();

// Load Chrome Recorder JSON
const recorderJSON = {
  title: "Login Flow",
  steps: [
    { type: "navigate", url: "https://example.com/login" },
    { type: "input", selector: "input[name='email']", value: "user@example.com" },
    { type: "input", selector: "input[type='password']", value: "password123" },
    { type: "click", selector: "button[type='submit']" },
    { type: "waitForSelector", selector: "#dashboard" }
  ]
};

// Create and process job
const jobId = await jobManager.createJob(recorderJSON);
await pipeline.processJob(jobId);

// Get results
const job = jobManager.getJob(jobId);
console.log(job.result);
```

### API Usage

Start the server:

```bash
npm start
```

Submit a job:

```bash
curl -X POST http://localhost:3000/api/jobs \
  -H "Content-Type: application/json" \
  -d @src/samples/login-example.json
```

Check job status:

```bash
curl http://localhost:3000/api/jobs/{jobId}
```

## Components

### Preprocessor
Normalizes Chrome Recorder JSON, validates structure, and extracts metadata.

### Intent Extractor
Converts low-level recorder steps into higher-level intents using pattern matching and LLM classification.

### Skill Generator
Produces structured, platform-agnostic action plans with retry policies, safety checks, and rate limits.

### Selector Healer
Multi-tier selector healing strategy:
1. Stable attributes (name, placeholder, aria-label, role)
2. Text-based matching
3. Structure-based relative selectors
4. Fallback heuristics with scoring

### Logic Engine
Injects control flow:
- Retries with exponential backoff
- Conditionals (if elementExists)
- Loops (for scraping)
- Human-like delays
- Error handling

### Playwright Generator
Translates canonical actions into Playwright-compatible commands.

### Executor
Runs Playwright commands with:
- Automatic selector healing on failure
- Screenshot capture
- Comprehensive error reporting
- Telemetry collection

## Testing

```bash
# Run tests
npm test

# Test with sample files
import { TestHarness } from './test/harness.js';

const harness = new TestHarness();
const result = await harness.testSampleFile('./src/samples/login-example.json');
console.log(result);
```

## Configuration

Create a `.env` file:

```env
PORT=3000
NODE_ENV=development

# Optional: LLM configuration
OPENAI_API_KEY=your_key_here
LLM_PROVIDER=openai  # or 'ollama' for local
```

## Sample Files

Sample Chrome Recorder JSON files are included in `src/samples/`:
- `login-example.json` - Login flow
- `search-example.json` - Search functionality
- `form-submit-example.json` - Form submission

## API Endpoints

- `POST /api/jobs` - Submit a new automation job
- `GET /api/jobs/:jobId` - Get job status and results
- `GET /api/jobs/:jobId/artifacts` - Get screenshots and artifacts
- `POST /api/jobs/:jobId/replay` - Replay job in debug mode
- `GET /health` - Health check

## Success Criteria

- ✅ Recorded flows converted to Playwright commands ≥85% of the time
- ✅ Selector healing resolves broken selectors ≥80% of the time
- ✅ Cross-site skill generalization across 3+ sites
- ✅ Comprehensive telemetry and diagnostics

## Roadmap

### MVP (Current)
- ✅ Preprocessor, intent extractor, canonical action mapping
- ✅ Playwright executor with basic selector healer
- ✅ Pattern-based skill generation
- ✅ Minimal telemetry and job queue

### v1 (Next)
- [ ] LLM-based intent extraction and skill generation
- [ ] Advanced selector healer with structure matching
- [ ] Memory store for selector reuse (Redis)
- [ ] User-facing debug UI

### Scale (Future)
- [ ] Cross-site skill generalization
- [ ] Visual matching (OCR) for selector healing
- [ ] Rate limiting, proxies, multi-tenant isolation
- [ ] Policy & abuse controls

## Technology Stack

- **Runtime**: Node.js + TypeScript
- **Automation**: Playwright
- **AI/LLM**: OpenAI API (with Ollama support planned)
- **Queue**: BullMQ + Redis (planned)
- **Database**: PostgreSQL (planned)
- **API**: Express.js

## Safety & Ethics

- ✅ Respects robots.txt and site terms
- ✅ Rate limiting per host and globally
- ✅ User consent and provenance logging
- ✅ Prohibits spam and protected data harvesting
- ✅ Manual override for sensitive flows

## License

MIT

## Contributing

Contributions welcome! Please read the specification document (`docs.txt`) for architecture details.

