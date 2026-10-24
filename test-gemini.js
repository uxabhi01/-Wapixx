import { generateAIReply, initGemini } from './gemini.js';
import { config } from './config.js';

console.log('===================================================');
console.log('Wapixx - Gemini API Connection Test Utility');
console.log('===================================================\n');

if (!config.hasValidApiKey) {
  console.error('❌ ERROR: GEMINI_API_KEY is not configured or uses a placeholder in .env!');
  console.error('Please obtain an API key from https://aistudio.google.com/ and set it in your .env file.');
  process.exit(1);
}

console.log(`Model configured: ${config.geminiModel}`);
console.log('Bot Persona loaded successfully.\n');
console.log('Sending test prompt to Gemini...');

const testPrompt = 'Hi! Please write a one-sentence confirmation that your AI connection is working successfully.';

try {
  const reply = await generateAIReply('test-user', testPrompt);
  console.log('\n===================================================');
  console.log('✅ SUCCESS! Gemini responded:');
  console.log('===================================================');
  console.log(reply);
  console.log('===================================================\n');
} catch (error) {
  console.error('\n❌ ERROR: Failed to communicate with Gemini API:');
  console.error(error?.message || error);
  console.log('\nPlease verify that your API key is correct and network connectivity is active.');
  process.exitCode = 1;
}
