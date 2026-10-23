import { DEFAULTS, VERSION } from './constants.js';
import { parseM2FileIds } from './m2.js';
import { analyzeMeta } from './meta.js';
import { makeHttpClient } from './scraper.js';
import { buildUrls, normalizeBaseUrl, normalizeExpansion, normalizeKind, parseId, wowheadPageUrl } from './urls.js';
import { mapLimit } from './utils.js';

function normalizeOptions(input = {}) {
  return {
    baseUrl: normalizeBaseUrl(input.baseUrl ?? DEFAULTS.baseUrl),
    expansion: normalizeExpansion(input.expansion ?? DEFAULTS.expansion),
    kind: normalizeKind(input.kind ?? DEFAULTS.kind),
    id: parseId(input.id, 'ID do registro'),
    timeoutMs: Math.max(1, Number(input.timeoutMs ?? DEFAULTS.timeoutMs)),
    retries: Math.max(0, Number(input.retries ?? DEFAULTS.retries)),
    retryBaseMs: Math.max(0, Number(input.retryBaseMs ?? DEFAULTS.retryBaseMs)),
    minIntervalMs: Math.max(0, Number(input.minIntervalMs ?? DEFAULTS.minIntervalMs)),
    assetConcurrency: Math.max(1, Number(input.assetConcurrency ?? DEFAULTS.assetConcurrency)),
  };
}

function errorInfo(error) {
  return {
    code: error?.code ?? 'ERROR',
    message: error?.message ?? String(error),
    ...(error?.status ? { status: error.status } : {}),
  };
}

function remoteAsset(asset, bytes = 0) {
  return {
    ...asset,
    path: asset.url,
    status: 'remote',
    bytes,
    sha256: null,
    remote: true,
  };
}

function emptyRecord(options, urls) {
  return {
    schemaVersion: 1,
    scraper: { name: 'wow-model-scraper', version: VERSION },
    expansion: options.expansion,
    kind: options.kind,
    id: options.id,
    status: 'failed',
    preview: true,
    scrapedAt: new Date().toISOString(),
    durationMs: 0,
    source: {
      baseUrl: options.baseUrl,
      root: urls.root,
      metaUrl: urls.meta,
      pageUrl: wowheadPageUrl(options.kind, options.id),
      metaSource: 'network',
      metaStatus: null,
    },
    meta: null,
    assets: { models: [], skins: [], phys: [], textures: [] },
    stats: { models: 0, skins: 0, textures: 0, phys: 0, bytes: 0 },
    errors: [],
  };
}

async function readM2(http, url) {
  const response = await http.request(url, { accept: 'application/octet-stream' });
  const buffer = Buffer.from(await response.arrayBuffer());
  return { info: parseM2FileIds(buffer), bytes: buffer.byteLength };
}

async function headSize(http, url) {
  try {
    const response = await http.request(url, { method: 'HEAD' });
    const length = Number(response.headers.get('content-length'));
    await response.body?.cancel?.();
    return Number.isFinite(length) && length > 0 ? length : 0;
  } catch {
    return 0;
  }
}

export async function previewRecord(input, deps = {}) {
  const options = normalizeOptions(input);
  const logger = deps.logger ?? null;
  const http = deps.http ?? makeHttpClient(options, logger);
  const startedAt = Date.now();
  const urls = buildUrls(options);
  const record = emptyRecord(options, urls);

  let analysis;
  console.error('preview:meta-start');
  try {
    const meta = await http.json(urls.meta);
    record.source.metaStatus = 'ok';
    analysis = analyzeMeta(meta);
    record.meta = {
      modelId: analysis.modelId,
      modelIds: analysis.models.map((entry) => entry.id),
      textureIds: analysis.textures.map((entry) => entry.id),
      textureSlots: analysis.textureSlots,
      hasCharacter: analysis.hasCharacter,
      hasEquipment: analysis.hasEquipment,
      scale: analysis.scale,
    };
  } catch (error) {
    console.error('preview:meta-error', error);
    record.source.metaStatus = error.status === 404 ? 'not-found' : 'error';
    record.errors.push(errorInfo(error));
    record.durationMs = Date.now() - startedAt;
    return record;
  }

  if (analysis.models.length === 0) {
    record.errors.push({
      code: analysis.hasCharacter ? 'CHARACTER_MODEL' : 'NO_MODEL',
      message: analysis.hasCharacter
        ? 'O modelo base usa a montagem de personagem (raça/gênero) e não expõe um M2 único neste meta.'
        : 'Nenhum modelo M2 foi encontrado no meta.',
    });
    record.durationMs = Date.now() - startedAt;
    return record;
  }

  console.error('preview:meta-ok');
  const m2Results = await mapLimit(analysis.models, 2, async (model) => {
    const url = `${urls.root}/m2/${model.id}.m2`;
    try {
      const result = await readM2(http, url);
      return { model, url, ...result };
    } catch (error) {
      record.errors.push({
        code: 'MODEL_READ_FAILED',
        message: `Modelo ${model.id}: ${error.message}`,
      });
      return { model, url, info: null, bytes: 0 };
    }
  });

  console.error('preview:m2-ok', m2Results.length);
  record.assets.models = m2Results.map((entry) =>
    remoteAsset(
      {
        id: entry.model.id,
        origins: entry.model.origins,
        url: entry.url,
      },
      entry.bytes,
    ),
  );

  const seenSkins = new Set();
  const seenPhys = new Set();
  for (const entry of m2Results) {
    if (!entry.info) continue;
    for (const skinId of entry.info.skinFileIds) {
      if (seenSkins.has(skinId)) continue;
      seenSkins.add(skinId);
      record.assets.skins.push({
        id: skinId,
        modelId: entry.model.id,
        origins: [`model:${entry.model.id}`],
        url: `${urls.root}/skin/${skinId}.skin`,
      });
    }
    const physId = entry.info.physFileId;
    if (physId && !seenPhys.has(physId)) {
      seenPhys.add(physId);
      record.assets.phys.push({
        id: physId,
        modelId: entry.model.id,
        origins: [`model:${entry.model.id}`],
        url: `${urls.root}/phys/${physId}.phys`,
      });
    }
  }

  record.assets.textures = analysis.textures.map((texture) => ({
    id: texture.id,
    slot: texture.slot,
    origins: texture.origins,
    url: `${urls.root}/textures/${texture.id}.webp`,
  }));

  const companions = [...record.assets.skins, ...record.assets.phys];
  const sizeTargets = [...companions, ...record.assets.textures];
  console.error('preview:size-start', sizeTargets.length);
  const sizes = await mapLimit(sizeTargets, Math.min(2, options.assetConcurrency), async (asset) => ({
    asset,
    bytes: await headSize(http, asset.url),
  }));

  console.error('preview:size-ok', sizes.length);
  const sizeById = new Map(sizes.map(({ asset, bytes }) => [`${asset.url}`, bytes]));
  record.assets.skins = record.assets.skins.map((asset) => remoteAsset(asset, sizeById.get(asset.url) ?? 0));
  record.assets.phys = record.assets.phys.map((asset) => remoteAsset(asset, sizeById.get(asset.url) ?? 0));
  record.assets.textures = record.assets.textures.map((asset) => remoteAsset(asset, sizeById.get(asset.url) ?? 0));

  const allAssets = [
    ...record.assets.models,
    ...record.assets.skins,
    ...record.assets.phys,
    ...record.assets.textures,
  ];
  record.stats.models = record.assets.models.length;
  record.stats.skins = record.assets.skins.length;
  record.stats.phys = record.assets.phys.length;
  record.stats.textures = record.assets.textures.length;
  record.stats.bytes = allAssets.reduce((total, asset) => total + (asset.bytes ?? 0), 0);
  record.status = record.errors.length === 0 ? 'complete' : 'partial';
  record.durationMs = Date.now() - startedAt;
  return record;
}
