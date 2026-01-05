/**
 * LLM Integration utilities
 * Supports OpenAI and Ollama (local) models
 */

import OpenAI from 'openai';

let openaiClient: OpenAI | null = null;

/**
 * Initialize LLM client
 */
export function initializeLLM(provider: string = 'openai', apiKey?: string): void {
  if (provider === 'openai' && apiKey) {
    openaiClient = new OpenAI({ apiKey });
  }
  // Ollama would be initialized here if needed
}

/**
 * Call LLM for intent extraction
 */
export async function extractIntentWithLLM(
  steps: string,
  useLocal: boolean = false
): Promise<{ intent: string; description: string; steps: string[] }> {
  if (useLocal) {
    // Call local Ollama API
    return callOllama('extract-intent', { steps });
  }

  if (!openaiClient) {
    throw new Error('OpenAI client not initialized. Set OPENAI_API_KEY environment variable.');
  }

  const prompt = `Analyze these web automation steps and identify the intent:

${steps}

Respond with JSON:
{
  "intent": "submit-login|submit-form|search|scrape-list|post-message|navigate|generic-action",
  "description": "brief description",
  "steps": ["step1", "step2", ...]
}`;

  const response = await openaiClient.chat.completions.create({
    model: 'gpt-4-turbo-preview',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0.3,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error('No response from LLM');
  }

  return JSON.parse(content);
}

/**
 * Call LLM for selector healing
 */
export async function healSelectorWithLLM(
  brokenSelector: string,
  domContext: string,
  useLocal: boolean = false
): Promise<Array<{ selector: string; strategy: string; score: number; reason: string }>> {
  if (useLocal) {
    return callOllama('heal-selector', { brokenSelector, domContext });
  }

  if (!openaiClient) {
    throw new Error('OpenAI client not initialized');
  }

  const prompt = `Given this broken selector and DOM context, suggest better selectors:

Broken selector: ${brokenSelector}
DOM context: ${domContext}

Respond with JSON array of candidates:
[
  {
    "selector": "selector string",
    "strategy": "css|text|role|testId",
    "score": 0.0-1.0,
    "reason": "explanation"
  }
]`;

  const response = await openaiClient.chat.completions.create({
    model: 'gpt-4-turbo-preview',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0.2,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error('No response from LLM');
  }

  const parsed = JSON.parse(content);
  return Array.isArray(parsed) ? parsed : parsed.candidates || [];
}

/**
 * Call Ollama API (local LLM)
 */
async function callOllama(
  _task: string,
  _data: Record<string, unknown>
): Promise<any> {
  // This is a placeholder - would implement actual Ollama API calls
  throw new Error('Ollama integration not yet implemented');
}

