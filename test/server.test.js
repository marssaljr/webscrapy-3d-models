import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { EXPANSIONS } from '../src/constants.js';
import { createLogger } from '../src/logger.js';
import { scrapeRecord } from '../src/scraper.js';
import { createApp } from '../src/server.js';
import {
  fixtureRoutes,
  makeTempDir,
  startFixtureServer,
} from './helpers.js';

const logger = createLogger({ level: 'silent', color: false });

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('serve dashboard, API e assets', async (t) => {
  const fixture = await startFixtureServer(fixtureRoutes());
  const temp = await makeTempDir();
  const app = await listen(
    createApp({
      outDir: temp.directory,
      baseUrl: fixture.baseUrl,
      expansions: EXPANSIONS,
      logger,
    }),
  );

  t.after(async () => {
    await app.close();
    await fixture.close();
    await temp.cleanup();
  });

  await scrapeRecord(
    {
      baseUrl: fixture.baseUrl,
      outDir: temp.directory,
      expansion: 'mists',
      kind: 'npc',
      id: 1,
      minIntervalMs: 0,
      retries: 0,
    },
    { logger },
  );

  const health = await fetch(`${app.url}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  const list = await fetch(`${app.url}/api/records?expansion=mists&kind=npc`);
  const listPayload = await list.json();
  assert.equal(listPayload.total, 1);
  assert.equal(listPayload.records[0].id, 1);

  const search = await fetch(`${app.url}/api/records?q=100`);
  assert.equal((await search.json()).total, 1);

  const record = await fetch(`${app.url}/api/records/mists/npc/1`);
  assert.equal((await record.json()).record.status, 'complete');

  const texture = await fetch(`${app.url}/data/mists/textures/200.webp`);
  assert.equal(texture.status, 200);
  assert.equal(texture.headers.get('content-type'), 'image/webp');
  const bytes = Buffer.from(await texture.arrayBuffer());
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.match(texture.headers.get('cache-control'), /immutable/);

  const head = await fetch(`${app.url}/data/mists/models/100.m2`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.ok(Number(head.headers.get('content-length')) > 0);

  const index = await fetch(`${app.url}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /M2 Atlas/);

  const scrape = await fetch(`${app.url}/api/scrape`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expansion: 'mists', kind: 'npc', id: 1 }),
  });
  assert.equal(scrape.status, 200);
  assert.equal((await scrape.json()).record.status, 'complete');

  const missing = await fetch(`${app.url}/api/records/mists/npc/999`);
  assert.equal(missing.status, 404);

  const traversal = await fetch(`${app.url}/data/%2e%2e/%2e%2e/package.json`);
  assert.ok([403, 404].includes(traversal.status));
  assert.doesNotMatch(await traversal.text(), /"name": "wow-model-scraper"/);
});

test('API rejeita corpo inválido', async (t) => {
  const temp = await makeTempDir();
  const app = await listen(
    createApp({
      outDir: temp.directory,
      expansions: EXPANSIONS,
      logger,
    }),
  );
  t.after(async () => {
    await app.close();
    await temp.cleanup();
  });

  const response = await fetch(`${app.url}/api/scrape`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{ nope',
  });
  assert.equal(response.status, 400);

  const invalidId = await fetch(`${app.url}/api/scrape`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'abc' }),
  });
  assert.equal(invalidId.status, 400);
});
