#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import process from 'node:process';

if (process.argv.includes('app-server')) {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', (line) => {
    let request;
    try { request = JSON.parse(line); } catch { return; }
    if (typeof request.id !== 'number') return;
    let result = {};
    if (request.method === 'account/read') result = { account: { type: 'chatgpt' } };
    if (request.method === 'account/rateLimits/read') {
      const now = Math.floor(Date.now() / 1000);
      const resetsAt = Number(process.env.SURPLUS_TEST_RESETS_AT ?? now + 3600);
      result = {
        ordinaryUsageAllowed: true,
        rateLimitsByLimitId: { codex: { primary: {
          usedPercent: Number(process.env.SURPLUS_TEST_WEEKLY_USED), resetsAt, windowDurationMins: 10080,
        } } },
      };
    }
    if (request.method === 'config/read') result = { config: { model: 'gpt-test', model_reasoning_effort: process.env.SURPLUS_TEST_EFFECTIVE_EFFORT ?? 'low' } };
    if (request.method === 'model/list') result = { data: [{
      model: 'gpt-test', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
    }] };
    process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
  });
} else {
  appendFileSync(process.env.SURPLUS_TEST_PROVIDER_ARGS, `${JSON.stringify(process.argv.slice(2))}\n`);
}
