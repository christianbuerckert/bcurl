#!/usr/bin/env node

import { startDaemon } from './daemon.js';

const poolSize = parseInt(process.argv[2] ?? '3', 10);
const timeout = parseInt(process.argv[3] ?? '300', 10);

startDaemon(poolSize, timeout).catch((err) => {
  console.error(`Failed to start daemon: ${err.message}`);
  process.exit(1);
});
