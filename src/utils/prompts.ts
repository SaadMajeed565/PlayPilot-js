/**
 * LLM Prompt Templates for Intent Extraction and Skill Generation
 */

/**
 * Intent extraction prompt template
 */
export const INTENT_EXTRACTION_PROMPT = `
You are an expert at analyzing web automation recordings and identifying user intents.

Given a sequence of web automation steps, classify the primary intent and extract the canonical action plan.

Common intents:
- submit-login: User logging into an account
- submit-form: Filling and submitting a form
- search: Performing a search query
- scrape-list: Extracting data from a list/table
- post-message: Posting a comment or message
- navigate: Simple page navigation
- generic-action: Other actions

Steps:
{steps}

Analyze these steps and respond with:
1. Intent label (one of the common intents above)
2. Brief description of what the user is trying to accomplish
3. Key steps in canonical format

Example:
Input steps:
- navigate to https://example.com/login
- fill input[name="email"] with "user@example.com"
- fill input[type="password"] with "password123"
- click button[type="submit"]
- wait for #dashboard

Output:
Intent: submit-login
Description: User logging into their account
Canonical steps:
1. Navigate to login page
2. Fill email field
3. Fill password field
4. Click submit button
5. Wait for dashboard to load
`;

/**
 * Selector healing prompt template
 */
export const SELECTOR_HEALING_PROMPT = `
You are an expert at finding robust CSS selectors for web elements.

Given a broken selector and DOM context, suggest better, more stable selectors.

Broken selector: {brokenSelector}
DOM context: {domContext}

Consider:
1. Stable attributes: name, placeholder, aria-label, role, data-testid
2. Text content matching
3. Semantic HTML structure
4. Relative positioning from stable elements

Provide ranked candidate selectors with:
- Selector string
- Strategy (css, text, role, etc.)
- Confidence score (0-1)
- Reasoning

Example:
Broken selector: .jsx-abc123def456
DOM context: <input name="email" placeholder="Enter email" class="jsx-abc123def456">

Candidates:
1. input[name="email"] - Strategy: css - Score: 0.95 - Reason: Uses stable name attribute
2. input[placeholder="Enter email"] - Strategy: css - Score: 0.85 - Reason: Uses placeholder attribute
3. input:first-of-type - Strategy: css - Score: 0.60 - Reason: Positional, less stable
`;

/**
 * Skill generation prompt template
 */
export const SKILL_GENERATION_PROMPT = `
You are an expert at creating reusable web automation skills.

Given an intent and canonical steps, generate a comprehensive skill specification.

Intent: {intent}
Steps: {steps}

Generate a skill spec with:
1. Name and description
2. Required inputs (with types and descriptions)
3. Expected outputs (with types)
4. Retry policy (max retries, backoff strategy)
5. Safety checks (what to verify before/after)
6. Rate limits (if applicable)

Make the skill reusable across similar sites while maintaining safety and reliability.

Example:
Intent: submit-login
Steps: [fill email, fill password, click submit, wait for dashboard]

Skill Spec:
{
  "name": "submit-login",
  "description": "Logs into a user account by filling email and password fields",
  "inputs": [
    {"name": "email", "type": "string", "required": true, "description": "User email address"},
    {"name": "password", "type": "string", "required": true, "description": "User password"}
  ],
  "outputs": [
    {"name": "success", "type": "boolean", "description": "Whether login was successful"},
    {"name": "session", "type": "object", "description": "Session information if successful"}
  ],
  "retryPolicy": {
    "maxRetries": 3,
    "backoff": "exponential",
    "baseDelay": 1000
  },
  "safetyChecks": [
    "verify-login-success",
    "check-for-captcha",
    "rate-limit-check"
  ],
  "rateLimit": {
    "perHost": 5,
    "global": 10,
    "windowMs": 60000
  }
}
`;

/**
 * Format steps for prompt
 */
export function formatStepsForPrompt(steps: Array<{ type: string; selector?: string; value?: string; url?: string }>): string {
  return steps
    .map((step, i) => {
      const parts: string[] = [`${i + 1}. ${step.type}`];
      if (step.url) parts.push(`URL: ${step.url}`);
      if (step.selector) parts.push(`Selector: ${step.selector}`);
      if (step.value) parts.push(`Value: ${step.value}`);
      return parts.join(' - ');
    })
    .join('\n');
}

