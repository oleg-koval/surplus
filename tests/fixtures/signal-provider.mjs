#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { setInterval, setTimeout } from 'node:timers';

writeFileSync(process.env.SURPLUS_SIGNAL_READY, 'ready');
process.on('SIGINT', () => {
  appendFileSync(process.env.SURPLUS_SIGNAL_COUNT, 'SIGINT\n');
  setTimeout(() => process.exit(0), 200);
});
setInterval(() => {}, 1_000);
