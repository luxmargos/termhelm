#!/usr/bin/env node
let jobs = 0;
const timer = setInterval(() => {
  jobs += 1;
  console.log(`[worker-child] processed mock job ${jobs} pid=${process.pid}`);
}, 1_500);

function shutdown(signal) {
  console.log(`[worker-child] ${signal}; checkpointing job ${jobs}`);
  clearInterval(timer);
  setTimeout(() => process.exit(0), 100);
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
console.log(`READY worker-child pid=${process.pid}`);
