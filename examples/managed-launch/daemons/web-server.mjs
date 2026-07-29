#!/usr/bin/env node
import { createServer } from 'node:http';

const port = Number(process.env.TERMHELM_DEMO_WEB_PORT ?? 43802);
const apiPort = Number(process.env.TERMHELM_DEMO_API_PORT ?? 43801);
const server = createServer(async (request, response) => {
  if (request.url === '/health') {
    try {
      const upstream = await fetch(`http://127.0.0.1:${apiPort}/health`);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ service: 'web', status: upstream.ok ? 'ok' : 'degraded', pid: process.pid }));
    } catch {
      response.statusCode = 503;
      response.end(JSON.stringify({ service: 'web', status: 'waiting-for-api', pid: process.pid }));
    }
    return;
  }
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><title>TermHelm demo</title><h1>Web daemon ${process.pid}</h1>`);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`READY web http://127.0.0.1:${port}`);
});

function shutdown(signal) {
  console.log(`[web] ${signal}; closing listener`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2_000).unref();
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
