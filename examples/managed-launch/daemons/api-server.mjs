#!/usr/bin/env node
import { createServer } from 'node:http';

const port = Number(process.env.TERMHELM_DEMO_API_PORT ?? 43801);
const server = createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  if (request.url === '/health') {
    response.end(JSON.stringify({ service: 'api', status: 'ok', pid: process.pid }));
    return;
  }
  if (request.url === '/api/time') {
    response.end(JSON.stringify({ now: new Date().toISOString(), pid: process.pid }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: 'not found' }));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`READY api http://127.0.0.1:${port}`);
});

function shutdown(signal) {
  console.log(`[api] ${signal}; draining requests`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2_000).unref();
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
