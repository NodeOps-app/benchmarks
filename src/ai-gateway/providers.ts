import type { AIGatewayProviderConfig } from './types.js';

/**
 * AI gateway benchmark configurations.
 *
 * Every gateway is hit directly (no gateway proxies through another) with the
 * same model — Claude Haiku 4.5 — so the comparison is apples-to-apples.
 * `anthropic-direct` is the no-gateway control, used to measure how much
 * latency each gateway adds on top of the underlying provider.
 */
export const providers: AIGatewayProviderConfig[] = [
  {
    name: 'openrouter',
    requiredEnvVars: ['OPENROUTER_API_KEY'],
    wireFormat: 'openai',
    model: 'anthropic/claude-haiku-4.5',
    host: 'openrouter.ai',
    path: '/api/v1/chat/completions',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    }),
  },
  {
    name: 'vercel-ai-gateway',
    requiredEnvVars: ['VERCEL_AI_GATEWAY_API_KEY'],
    wireFormat: 'openai',
    model: 'anthropic/claude-haiku-4.5',
    host: 'ai-gateway.vercel.sh',
    path: '/v1/chat/completions',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.VERCEL_AI_GATEWAY_API_KEY}`,
    }),
  },
  {
    // Direct Anthropic passthrough (not routed through another gateway), so
    // this measures Cloudflare's own overhead in isolation.
    name: 'cloudflare-ai-gateway',
    requiredEnvVars: ['CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID', 'CLOUDFLARE_AI_GATEWAY_GATEWAY_ID', 'ANTHROPIC_API_KEY'],
    wireFormat: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    host: 'gateway.ai.cloudflare.com',
    path: `/v1/${process.env.CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID}/${process.env.CLOUDFLARE_AI_GATEWAY_GATEWAY_ID}/anthropic/v1/messages`,
    buildHeaders: () => ({
      'x-api-key': process.env.ANTHROPIC_API_KEY || '',
      'anthropic-version': '2023-06-01',
      ...(process.env.CLOUDFLARE_AI_GATEWAY_TOKEN ? { 'cf-aig-authorization': `Bearer ${process.env.CLOUDFLARE_AI_GATEWAY_TOKEN}` } : {}),
    }),
  },
  {
    // `anthropic/` here is LLM Gateway's provider-pinning syntax (provider/model),
    // so requests route to Anthropic itself — the same underlying model and
    // deployment as the other participants, addressed in this gateway's own
    // catalog naming convention.
    name: 'llmgateway',
    requiredEnvVars: ['LLMGATEWAY_API_KEY'],
    wireFormat: 'openai',
    model: 'anthropic/claude-haiku-4-5',
    host: 'api.llmgateway.io',
    path: '/v1/chat/completions',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.LLMGATEWAY_API_KEY}`,
    }),
  },
  {
    // No-gateway baseline/control.
    name: 'anthropic-direct',
    requiredEnvVars: ['ANTHROPIC_API_KEY'],
    wireFormat: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    host: 'api.anthropic.com',
    path: '/v1/messages',
    buildHeaders: () => ({
      'x-api-key': process.env.ANTHROPIC_API_KEY || '',
      'anthropic-version': '2023-06-01',
    }),
  },
  //
  // add gateways above
];
