import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, MIME_TYPES, VERSION } from './constants.js';
import { AppError, ConfigError, NotFoundError, ValidationError } from './errors.js';
import { createLogger } from './logger.js';
import { previewRecord } from './preview.js';
import { scrapeRecord } from './scraper.js';
import { AssetStore } from './storage.js';
import { normalizeExpansion, normalizeKind, parseId } from './urls.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

function sendJson(response, status, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function sendError(response, status, code, message, details) {
  sendJson(response, status, {
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  });
}

async function readJsonBody(request, limit = DEFAULTS.maxBodyBytes) {
  let size = 0;
  const chunks = [];

  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      throw new ValidationError(`Corpo da requisição maior que ${limit} bytes.`);
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError('Corpo da requisição não é JSON válido.');
  }
}

function toNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function serveFile(response, absolutePath, options = {}) {
  let info;
  try {
    info = await stat(absolutePath);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      sendError(response, 404, 'NOT_FOUND', 'Arquivo não encontrado.');
      return;
    }
    throw error;
  }

  if (!info.isFile()) {
    sendError(response, 404, 'NOT_FOUND', 'Arquivo não encontrado.');
    return;
  }

  const extension = path.extname(absolutePath).toLowerCase();
  const headers = {
    'content-type': MIME_TYPES[extension] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': options.immutable
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
    'x-content-type-options': 'nosniff',
  };

  if (options.head) {
    response.writeHead(200, headers);
    response.end();
    return;
  }

  response.writeHead(200, headers);
  const stream = createReadStream(absolutePath);
  stream.on('error', () => {
    if (!response.headersSent) sendError(response, 500, 'READ_ERROR', 'Falha ao ler arquivo.');
    else response.destroy();
  });
  stream.pipe(response);
}

function recordMatches(record, query) {
  if (!query) return true;
  const haystack = [
    record.expansion,
    record.kind,
    record.id,
    record.meta?.modelId,
    ...(record.meta?.modelIds ?? []),
    ...(record.meta?.textureIds ?? []),
    ...(record.assets?.skins ?? []).map((asset) => asset.id),
    ...(record.assets?.phys ?? []).map((asset) => asset.id),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}

export function createApp(options = {}) {
  const outDir = options.outDir ?? DEFAULTS.outDir;
  const publicDir = path.resolve(options.publicDir ?? DEFAULT_PUBLIC_DIR);
  const store = new AssetStore(outDir);
  const dataRoot = store.rootDir;
  const logger = options.logger ?? createLogger({ level: 'info' });
  const readOnly = Boolean(options.readOnly);
  const baseOptions = {
    baseUrl: options.baseUrl ?? DEFAULTS.baseUrl,
    outDir: dataRoot,
    timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
    retries: options.retries ?? DEFAULTS.retries,
    retryBaseMs: options.retryBaseMs ?? DEFAULTS.retryBaseMs,
    minIntervalMs: options.minIntervalMs ?? DEFAULTS.minIntervalMs,
    assetConcurrency: options.assetConcurrency ?? DEFAULTS.assetConcurrency,
  };

  const inFlight = new Map();

  async function handleApi(request, response, url) {
    if (url.pathname === '/api/health') {
      sendJson(response, 200, {
        ok: true,
        version: VERSION,
        readOnly,
        dataDir: dataRoot,
        uptimeSeconds: Math.round(process.uptime()),
      });
      return true;
    }

    if (url.pathname === '/api/expansions') {
      sendJson(response, 200, { expansions: options.expansions ?? [] });
      return true;
    }

    if (url.pathname === '/api/records' && request.method === 'GET') {
      const expansion = url.searchParams.get('expansion') || undefined;
      const kind = url.searchParams.get('kind') || undefined;
      const query = (url.searchParams.get('q') ?? '').trim().toLowerCase();
      const limit = Math.min(1000, Math.max(1, toNumber(url.searchParams.get('limit'), 250)));

      if (expansion) normalizeExpansion(expansion);
      if (kind) normalizeKind(kind);

      const all = await store.listCatalogs({ expansion, kind });
      const filtered = all.filter((record) => recordMatches(record, query));
      sendJson(response, 200, {
        total: filtered.length,
        records: filtered.slice(0, limit),
      });
      return true;
    }

    const recordMatch = /^\/api\/records\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (recordMatch && request.method === 'GET') {
      const expansion = normalizeExpansion(decodeURIComponent(recordMatch[1]));
      const kind = normalizeKind(decodeURIComponent(recordMatch[2]));
      const id = parseId(decodeURIComponent(recordMatch[3]));
      const absolute = store.catalogPath(expansion, kind, id);
      try {
        const record = await store.readJson(absolute);
        sendJson(response, 200, { record });
      } catch (error) {
        if (error.code === 'ENOENT') {
          throw new NotFoundError(url.pathname);
        }
        throw error;
      }
      return true;
    }

    if (url.pathname === '/api/scrape' && request.method === 'POST') {
      const body = await readJsonBody(request);

      if (readOnly) {
        const record = await previewRecord(
          {
            ...baseOptions,
            expansion: body.expansion,
            kind: body.kind,
            id: body.id,
          },
          { logger },
        );
        sendJson(response, 200, { preview: true, record });
        return true;
      }
      let expansion;
      let kind;
      let id;
      try {
        expansion = normalizeExpansion(body.expansion ?? DEFAULTS.expansion);
        kind = normalizeKind(body.kind ?? DEFAULTS.kind);
        id = parseId(body.id, 'ID');
      } catch (error) {
        throw new ValidationError(error.message);
      }

      const key = `${expansion}/${kind}/${id}`;
      if (inFlight.has(key)) {
        sendJson(response, 409, {
          error: { code: 'IN_PROGRESS', message: `Já existe uma coleta em andamento para ${key}.` },
        });
        return true;
      }

      const promise = scrapeRecord(
        {
          ...baseOptions,
          expansion,
          kind,
          id,
          force: Boolean(body.force),
          strict: Boolean(body.strict),
        },
        { logger, store },
      );
      inFlight.set(key, promise);

      try {
        const manifest = await promise;
        sendJson(response, 200, { record: manifest });
      } finally {
        inFlight.delete(key);
      }
      return true;
    }

    if (url.pathname.startsWith('/api/')) {
      throw new NotFoundError(url.pathname);
    }

    return false;
  }

  return async function handler(request, response) {
    response.setHeader('x-frame-options', 'SAMEORIGIN');
    response.setHeader('referrer-policy', 'same-origin');

    if (!['GET', 'HEAD', 'POST'].includes(request.method)) {
      sendError(response, 405, 'METHOD_NOT_ALLOWED', 'Método não permitido.');
      return;
    }

    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

    try {
      if (url.pathname.startsWith('/api/')) {
        const handled = await handleApi(request, response, url);
        if (handled) return;
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        throw new NotFoundError(url.pathname);
      }

      if (url.pathname.startsWith('/data/')) {
        const relative = decodeURIComponent(url.pathname.slice('/data/'.length));
        const absolute = path.resolve(dataRoot, relative);
        if (!isWithin(dataRoot, absolute)) {
          sendError(response, 403, 'FORBIDDEN', 'Caminho inválido.');
          return;
        }
        await serveFile(response, absolute, {
          immutable: !relative.endsWith('.json'),
          head: request.method === 'HEAD',
        });
        return;
      }

      const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const absolute = path.resolve(publicDir, relative);
      if (!isWithin(publicDir, absolute)) {
        sendError(response, 403, 'FORBIDDEN', 'Caminho inválido.');
        return;
      }
      await serveFile(response, absolute, {
        immutable: false,
        head: request.method === 'HEAD',
      });
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof NotFoundError) {
        sendError(response, 404, 'NOT_FOUND', 'Rota não encontrada.');
      } else if (error instanceof ValidationError || error instanceof ConfigError) {
        sendError(response, 400, error.code, error.message);
      } else if (error instanceof AppError) {
        sendError(response, 500, error.code, error.message);
      } else {
        logger.error(`Erro no servidor: ${error.message}`);
        sendError(response, 500, 'INTERNAL_ERROR', 'Erro interno do servidor.');
      }
    }
  };
}

export async function startServer(options = {}) {
  const logger = options.logger ?? createLogger({ level: 'info' });
  const readOnly = Boolean(options.readOnly);
  const handler = createApp({ ...options, logger });
  const server = http.createServer(handler);
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 4317;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const displayHost = host === '0.0.0.0' ? 'localhost' : host;
  const url = `http://${displayHost}:${actualPort}`;

  logger.success(`Dashboard em ${url}`);
  logger.info(`Dados em ${path.resolve(options.outDir ?? DEFAULTS.outDir)}`);

  return { server, url, port: actualPort, host };
}
