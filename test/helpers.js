import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const NPC_META = {
  Model: 100,
  Textures: {
    11: 200,
    12: 201,
  },
  Textures2: null,
  TextureFiles: null,
  ModelFiles: null,
  Item: null,
  Creature: {
    CreatureGeosetData: [{ GeosetIndex: 0, GeosetValue: 1 }],
    CreatureGeosetDataID: 974,
    CreatureModelAlpha: 255,
    Texture: 0,
    CreatureCustomizations: null,
    ParticleColor: null,
  },
  Character: null,
  ItemEffects: null,
  Equipment: null,
  ComponentTextures: null,
  ComponentModels: null,
  StateKits: null,
  Decor: null,
  Scale: 1,
};

export function m2Bytes(extra = 'model') {
  return Buffer.concat([Buffer.from('MD21'), Buffer.from(extra), Buffer.alloc(20)]);
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function m2Chunk(tag, data) {
  return Buffer.concat([Buffer.from(tag), uint32(data.length), data]);
}

export function chunkedM2({ skinIds = [], physId = null } = {}) {
  const chunks = [m2Chunk('MD21', Buffer.alloc(16))];

  if (skinIds.length > 0) {
    chunks.push(m2Chunk('SFID', Buffer.concat(skinIds.map(uint32))));
  }
  if (physId) {
    chunks.push(m2Chunk('PFID', uint32(physId)));
  }

  return Buffer.concat(chunks);
}

export function skinBytes() {
  return Buffer.concat([Buffer.from('SKIN'), Buffer.alloc(12)]);
}

export function webpBytes(label = 'texture') {
  return Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.from([0x10, 0, 0, 0]),
    Buffer.from('WEBP'),
    Buffer.from(label),
  ]);
}

export async function makeTempDir(prefix = 'wow-scraper-') {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  return {
    directory,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

export async function startFixtureServer(routes) {
  const counts = new Map();

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.local');
    counts.set(url.pathname, (counts.get(url.pathname) ?? 0) + 1);
    const route = routes[url.pathname];

    if (!route) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }

    if (route.json !== undefined) {
      const body = JSON.stringify(route.json);
      response.writeHead(route.status ?? 200, { 'content-type': 'application/json' });
      response.end(body);
      return;
    }

    const body = Buffer.isBuffer(route.body) ? route.body : Buffer.from(route.body ?? '');
    response.writeHead(route.status ?? 200, {
      'content-type': route.contentType ?? 'application/octet-stream',
      'content-length': body.length,
    });
    response.end(body);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    counts,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export function fixtureRoutes(meta = NPC_META) {
  return {
    '/mists/meta/npc/1.json': { json: meta },
    '/mists/m2/100.m2': { body: m2Bytes(), contentType: 'application/octet-stream' },
    '/mists/textures/200.webp': { body: webpBytes('a'), contentType: 'image/webp' },
    '/mists/textures/201.webp': { body: webpBytes('b'), contentType: 'image/webp' },
  };
}
