import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createLogger } from '../src/logger.js';
import { scrapeRecord } from '../src/scraper.js';
import { AssetStore } from '../src/storage.js';
import {
  NPC_META,
  chunkedM2,
  fixtureRoutes,
  m2Bytes,
  makeTempDir,
  skinBytes,
  startFixtureServer,
  webpBytes,
} from './helpers.js';

const logger = createLogger({ level: 'silent', color: false });

function baseOptions(baseUrl, outDir, extra = {}) {
  return {
    baseUrl,
    outDir,
    expansion: 'mists',
    kind: 'npc',
    id: 1,
    minIntervalMs: 0,
    retries: 0,
    assetConcurrency: 2,
    ...extra,
  };
}

test('baixa meta, M2 e texturas e grava catálogo', async (t) => {
  const fixture = await startFixtureServer(fixtureRoutes());
  const temp = await makeTempDir();
  t.after(async () => {
    await fixture.close();
    await temp.cleanup();
  });

  const manifest = await scrapeRecord(baseOptions(fixture.baseUrl, temp.directory), { logger });

  assert.equal(manifest.status, 'complete');
  assert.equal(manifest.stats.models, 1);
  assert.equal(manifest.stats.textures, 2);
  assert.ok(manifest.stats.bytes > 0);
  assert.deepEqual(manifest.assets.models.map((asset) => asset.id), [100]);
  assert.deepEqual(manifest.assets.textures.map((asset) => asset.id), [200, 201]);

  const store = new AssetStore(temp.directory);
  const model = await readFile(path.join(temp.directory, 'mists/models/100.m2'));
  assert.equal(model.subarray(0, 4).toString('ascii'), 'MD21');

  const texture = await readFile(path.join(temp.directory, 'mists/textures/200.webp'));
  assert.equal(texture.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(texture.subarray(8, 12).toString('ascii'), 'WEBP');

  const catalog = await store.readJson(store.catalogPath('mists', 'npc', 1));
  assert.equal(catalog.status, 'complete');
  assert.equal(catalog.source.metaStatus, 'ok');
  assert.equal(catalog.assets.models[0].sha256.length, 64);
  assert.equal(fixture.counts.get('/mists/meta/npc/1.json'), 1);
  assert.equal(fixture.counts.get('/mists/m2/100.m2'), 1);
});

test('baixa skins e física referenciadas pelo M2', async (t) => {
  const routes = fixtureRoutes();
  routes['/mists/m2/100.m2'] = {
    body: chunkedM2({ skinIds: [300, 301], physId: 400 }),
    contentType: 'application/octet-stream',
  };
  routes['/mists/skin/300.skin'] = { body: skinBytes(), contentType: 'application/octet-stream' };
  routes['/mists/skin/301.skin'] = { body: skinBytes(), contentType: 'application/octet-stream' };
  routes['/mists/phys/400.phys'] = { body: Buffer.from('PHYS'), contentType: 'application/octet-stream' };
  const fixture = await startFixtureServer(routes);
  const temp = await makeTempDir();
  t.after(async () => {
    await fixture.close();
    await temp.cleanup();
  });

  const manifest = await scrapeRecord(baseOptions(fixture.baseUrl, temp.directory), { logger });

  assert.equal(manifest.status, 'complete');
  assert.equal(manifest.stats.skins, 2);
  assert.equal(manifest.stats.phys, 1);
  assert.deepEqual(manifest.assets.skins.map((asset) => asset.id), [300, 301]);
  assert.deepEqual(manifest.assets.phys.map((asset) => asset.id), [400]);
  assert.deepEqual(manifest.assets.models[0].skinFileIds, [300, 301]);
  assert.equal(manifest.assets.models[0].physFileId, 400);

  const skin = await readFile(path.join(temp.directory, 'mists/skins/300.skin'));
  assert.equal(skin.subarray(0, 4).toString('ascii'), 'SKIN');
  assert.equal(fixture.counts.get('/mists/skin/300.skin'), 1);
  assert.equal(fixture.counts.get('/mists/phys/400.phys'), 1);
});

test('skin ausente gera status parcial', async (t) => {
  const routes = fixtureRoutes();
  routes['/mists/m2/100.m2'] = {
    body: chunkedM2({ skinIds: [300] }),
    contentType: 'application/octet-stream',
  };
  const fixture = await startFixtureServer(routes);
  const temp = await makeTempDir();
  t.after(async () => {
    await fixture.close();
    await temp.cleanup();
  });

  const manifest = await scrapeRecord(baseOptions(fixture.baseUrl, temp.directory), { logger });

  assert.equal(manifest.status, 'partial');
  assert.equal(manifest.assets.skins[0].status, 'failed');
  assert.ok(manifest.errors.some((error) => error.code === 'SKIN_DOWNLOAD_FAILED'));
});

test('skin com magic inválido é rejeitada', async (t) => {
  const routes = fixtureRoutes();
  routes['/mists/m2/100.m2'] = {
    body: chunkedM2({ skinIds: [300] }),
    contentType: 'application/octet-stream',
  };
  routes['/mists/skin/300.skin'] = { body: Buffer.from('broken') };
  const fixture = await startFixtureServer(routes);
  const temp = await makeTempDir();
  t.after(async () => {
    await fixture.close();
    await temp.cleanup();
  });

  const manifest = await scrapeRecord(baseOptions(fixture.baseUrl, temp.directory), { logger });

  assert.equal(manifest.status, 'partial');
  assert.equal(manifest.assets.skins[0].status, 'failed');
});

test('segunda execução usa cache local sem novas requisições', async (t) => {
  const fixture = await startFixtureServer(fixtureRoutes());
  const temp = await makeTempDir();
  t.after(async () => {
    await fixture.close();
    await temp.cleanup();
  });

  const first = await scrapeRecord(baseOptions(fixture.baseUrl, temp.directory), { logger });
  const firstCount = [...fixture.counts.values()].reduce((total, count) => total + count, 0);
  const second = await scrapeRecord(baseOptions(fixture.baseUrl, temp.directory), { logger });
  const secondCount = [...fixture.counts.values()].reduce((total, count) => total + count, 0);

  assert.equal(first.status, 'complete');
  assert.equal(second.status, 'complete');
  assert.equal(second.source.metaSource, 'cache');
  assert.equal(second.assets.models[0].status, 'cached');
  assert.equal(firstCount, secondCount);
});

test('textura ausente gera status parcial', async (t) => {
  const routes = fixtureRoutes();
  delete routes['/mists/textures/201.webp'];
  const fixture = await startFixtureServer(routes);
  const temp = await makeTempDir();
  t.after(async () => {
    await fixture.close();
    await temp.cleanup();
  });

  const manifest = await scrapeRecord(baseOptions(fixture.baseUrl, temp.directory), { logger });
  assert.equal(manifest.status, 'partial');
  assert.equal(
    manifest.assets.textures.find((asset) => asset.id === 201).status,
    'failed',
  );
  assert.ok(manifest.errors.some((error) => error.code === 'TEXTURE_DOWNLOAD_FAILED'));
});

test('modo strict transforma textura ausente em falha', async (t) => {
  const routes = fixtureRoutes();
  delete routes['/mists/textures/201.webp'];
  const fixture = await startFixtureServer(routes);
  const temp = await makeTempDir();
  t.after(async () => {
    await fixture.close();
    await temp.cleanup();
  });

  const manifest = await scrapeRecord(
    baseOptions(fixture.baseUrl, temp.directory, { strict: true }),
    { logger },
  );
  assert.equal(manifest.status, 'failed');
});

test('meta 404 grava catálogo de falha', async (t) => {
  const fixture = await startFixtureServer({});
  const temp = await makeTempDir();
  t.after(async () => {
    await fixture.close();
    await temp.cleanup();
  });

  const manifest = await scrapeRecord(baseOptions(fixture.baseUrl, temp.directory), { logger });
  assert.equal(manifest.status, 'failed');
  assert.equal(manifest.source.metaStatus, 'not-found');

  const store = new AssetStore(temp.directory);
  const catalog = await store.readJson(store.catalogPath('mists', 'npc', 1));
  assert.equal(catalog.status, 'failed');
});

test('valida magic bytes e não deixa arquivo corrompido', async (t) => {
  const router = fixtureRoutes();
  router['/mists/textures/200.webp'] = {
    body: Buffer.from('not a webp'),
    contentType: 'image/webp',
  };
  const fixture = await startFixtureServer(router);
  const temp = await makeTempDir();
  t.after(async () => {
    await fixture.close();
    await temp.cleanup();
  });

  const manifest = await scrapeRecord(
    baseOptions(fixture.baseUrl, temp.directory, { strict: true }),
    { logger },
  );
  assert.equal(manifest.status, 'failed');

  await assert.rejects(stat(path.join(temp.directory, 'mists/textures/200.webp')), {
    code: 'ENOENT',
  });
});

test('force ignora cache e baixa novamente', async (t) => {
  const fixture = await startFixtureServer(fixtureRoutes());
  const temp = await makeTempDir();
  t.after(async () => {
    await fixture.close();
    await temp.cleanup();
  });

  await scrapeRecord(baseOptions(fixture.baseUrl, temp.directory), { logger });
  const manifest = await scrapeRecord(
    baseOptions(fixture.baseUrl, temp.directory, { force: true }),
    { logger },
  );

  assert.equal(manifest.status, 'complete');
  assert.equal(manifest.assets.models[0].status, 'downloaded');
  assert.equal(fixture.counts.get('/mists/m2/100.m2'), 2);
});

test('meta com personagem sem M2 falha de forma explícita', async (t) => {
  const routes = fixtureRoutes({
    ...NPC_META,
    Model: 0,
    Textures: null,
    TextureFiles: {
      1: [{ FileDataId: 200, Gender: 0 }],
    },
    Character: { Race: 10, Gender: 1, ChrModelId: 20 },
  });
  const fixture = await startFixtureServer(routes);
  const temp = await makeTempDir();
  t.after(async () => {
    await fixture.close();
    await temp.cleanup();
  });

  const manifest = await scrapeRecord(baseOptions(fixture.baseUrl, temp.directory), { logger });
  assert.equal(manifest.status, 'failed');
  assert.ok(manifest.errors.some((error) => error.code === 'CHARACTER_MODEL'));
  assert.equal(manifest.assets.textures[0].status, 'downloaded');
});

test('M2 com magic inválido é rejeitado', async (t) => {
  const routes = fixtureRoutes();
  routes['/mists/m2/100.m2'] = { body: Buffer.from('broken') };
  const fixture = await startFixtureServer(routes);
  const temp = await makeTempDir();
  t.after(async () => {
    await fixture.close();
    await temp.cleanup();
  });

  const manifest = await scrapeRecord(baseOptions(fixture.baseUrl, temp.directory), { logger });
  assert.equal(manifest.status, 'failed');
  assert.equal(manifest.assets.models[0].status, 'failed');
});

test('respeita MD20 legado', async (t) => {
  const routes = fixtureRoutes();
  routes['/mists/m2/100.m2'] = { body: Buffer.concat([Buffer.from('MD20'), Buffer.alloc(12)]) };
  const fixture = await startFixtureServer(routes);
  const temp = await makeTempDir();
  t.after(async () => {
    await fixture.close();
    await temp.cleanup();
  });

  const manifest = await scrapeRecord(baseOptions(fixture.baseUrl, temp.directory), { logger });
  assert.equal(manifest.status, 'complete');
});

test('fixtures têm conteúdo reconhecível', () => {
  assert.equal(m2Bytes().subarray(0, 4).toString('ascii'), 'MD21');
  assert.equal(webpBytes().subarray(0, 4).toString('ascii'), 'RIFF');
});
