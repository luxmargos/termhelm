#!/usr/bin/env node
import { createServer } from 'node:http';

const port = Number(process.env.TERMHELM_DEMO_EVENT_PORT ?? 43803);
const clients = new Set();
let sequence = 0;
const server = createServer((request, response) => {
  if (request.url === '/health') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ service: 'events', status: 'ok', clients: clients.size, pid: process.pid }));
    return;
  }
  if (request.url !== '/events') {
    response.statusCode = 404;
    response.end('not found');
    return;
  }
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  });
  clients.add(response);
  request.once('close', () => clients.delete(response));
});

const heartbeat = setInterval(() => {
  sequence += 1;
  for (const client of clients) client.write(`event: heartbeat\ndata: ${sequence}\n\n`);
  console.log(`[events] heartbeat=${sequence} clients=${clients.size}`);
}, 2_000);

server.listen(port, '127.0.0.1', () => {
  console.log(`READY events http://127.0.0.1:${port}`);
});

function shutdown(signal) {
  console.log(`[events] ${signal}; closing ${clients.size} stream(s)`);
  clearInterval(heartbeat);
  for (const client of clients) client.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2_000).unref();
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
