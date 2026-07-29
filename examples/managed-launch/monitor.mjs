#!/usr/bin/env node
const endpoints = [
  ['api', `http://127.0.0.1:${process.env.TERMHELM_DEMO_API_PORT ?? '43801'}/health`],
  ['web', `http://127.0.0.1:${process.env.TERMHELM_DEMO_WEB_PORT ?? '43802'}/health`],
  ['events', `http://127.0.0.1:${process.env.TERMHELM_DEMO_EVENT_PORT ?? '43803'}/health`]
];

async function waitForHealthy(name, url) {
  const deadline = Date.now() + 30_000;
  let lastError = 'not started';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      const body = await response.json();
      if (response.ok && body.status === 'ok') {
        console.log(`[demo-monitor] ${name} healthy: ${JSON.stringify(body)}`);
        return;
      }
      lastError = `${response.status} ${JSON.stringify(body)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`${name} did not become healthy: ${lastError}`);
}

await Promise.all(endpoints.map(([name, url]) => waitForHealthy(name, url)));
const time = await fetch(`http://127.0.0.1:${process.env.TERMHELM_DEMO_API_PORT ?? '43801'}/api/time`).then(response => response.json());
console.log(`[demo-monitor] nested managed launch is ready: ${JSON.stringify(time)}`);
