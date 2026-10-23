import { readFile } from 'node:fs/promises';
import { DEFAULTS, USER_AGENT, VERSION } from './constants.js';
import { HttpClient } from './http.js';
import { createLogger, formatBytes } from './logger.js';
import { parseM2FileIds } from './m2.js';
import { analyzeMeta } from './meta.js';
import { AssetStore, assetRelativePaths } from './storage.js';
import { buildUrls, normalizeBaseUrl, normalizeExpansion, normalizeKind, parseId, wowheadPageUrl } from './urls.js';
import { formatDuration, mapLimit, unique } from './utils.js';

function errorInfo(error) {
  return {
    code: error?.code ?? 'ERROR',
    message: error?.message ?? String(error),
    ...(error?.status ? { status: error.status } : {}),
  };
}

function normalizeOptions(input = {}) {
  const downloadModels = input.downloadModels !== false;
  return {
    baseUrl: normalizeBaseUrl(input.baseUrl ?? DEFAULTS.baseUrl),
    expansion: normalizeExpansion(input.expansion ?? DEFAULTS.expansion),
    kind: normalizeKind(input.kind ?? DEFAULTS.kind),
    id: parseId(input.id, 'ID do registro'),
    outDir: input.outDir ?? DEFAULTS.outDir,
    force: Boolean(input.force),
    strict: Boolean(input.strict),
    downloadModels,
    downloadSkins: downloadModels && input.downloadSkins !== false,
    downloadPhys: downloadModels && input.downloadPhys !== false,
    downloadTextures: input.downloadTextures !== false,
    assetConcurrency: Math.max(1, Number(input.assetConcurrency ?? DEFAULTS.assetConcurrency)),
    timeoutMs: Math.max(1, Number(input.timeoutMs ?? DEFAULTS.timeoutMs)),
    retries: Math.max(0, Number(input.retries ?? DEFAULTS.retries)),
    retryBaseMs: Math.max(0, Number(input.retryBaseMs ?? DEFAULTS.retryBaseMs)),
    minIntervalMs: Math.max(0, Number(input.minIntervalMs ?? DEFAULTS.minIntervalMs)),
  };
}

export function makeHttpClient(options = {}, logger = null) {
  return new HttpClient({
    timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
    retries: options.retries ?? DEFAULTS.retries,
    retryBaseMs: options.retryBaseMs ?? DEFAULTS.retryBaseMs,
    minIntervalMs: options.minIntervalMs ?? DEFAULTS.minIntervalMs,
    userAgent: USER_AGENT,
    logger,
  });
}

async function loadMeta({ options, http, store, metaPath, urls, logger }) {
  if (!options.force) {
    try {
      const cached = await store.readJsonIfExists(metaPath);
      if (cached) {
        return { raw: cached, source: 'cache', url: urls.meta };
      }
    } catch (error) {
      logger.warn('Meta local inválido; baixando novamente', {
        id: options.id,
        error: error.message,
      });
    }
  }

  const raw = await http.json(urls.meta);
  await store.writeJson(metaPath, raw);
  return { raw, source: 'network', url: urls.meta };
}

function baseManifest({ options, urls, source, analysis, metaStatus }) {
  return {
    schemaVersion: 1,
    scraper: { name: 'wow-model-scraper', version: VERSION },
    expansion: options.expansion,
    kind: options.kind,
    id: options.id,
    status: 'failed',
    scrapedAt: new Date().toISOString(),
    durationMs: 0,
    source: {
      baseUrl: options.baseUrl,
      root: urls.root,
      metaUrl: urls.meta,
      pageUrl: wowheadPageUrl(options.kind, options.id),
      metaSource: source,
      metaStatus,
    },
    meta: analysis
      ? {
          modelId: analysis.modelId,
          modelIds: analysis.models.map((entry) => entry.id),
          textureIds: analysis.textures.map((entry) => entry.id),
          textureSlots: analysis.textureSlots,
          hasCharacter: analysis.hasCharacter,
          hasEquipment: analysis.hasEquipment,
          scale: analysis.scale,
        }
      : null,
    assets: {
      models: [],
      skins: [],
      phys: [],
      textures: [],
    },
    stats: {
      models: 0,
      skins: 0,
      textures: 0,
      phys: 0,
      bytes: 0,
    },
    errors: [],
  };
}

function isComplete(manifest, options) {
  const groups = [
    [manifest.assets.models, options.downloadModels],
    [manifest.assets.skins, options.downloadSkins],
    [manifest.assets.phys, options.downloadPhys],
    [manifest.assets.textures, options.downloadTextures],
  ];

  return groups.every(([assets, enabled]) =>
    !enabled || assets.every(
      (asset) => asset.status === 'downloaded' || asset.status === 'cached' || asset.status === 'skipped',
    ),
  );
}

function updateStats(manifest) {
  const groups = [
    manifest.assets.models,
    manifest.assets.skins,
    manifest.assets.phys,
    manifest.assets.textures,
  ];
  const assets = groups.flat();
  manifest.stats.models = manifest.assets.models.length;
  manifest.stats.skins = manifest.assets.skins.length;
  manifest.stats.phys = manifest.assets.phys.length;
  manifest.stats.textures = manifest.assets.textures.length;
  manifest.stats.bytes = assets.reduce((total, asset) => total + (asset.bytes ?? 0), 0);
}

export async function scrapeRecord(input, deps = {}) {
  const options = normalizeOptions(input);
  const logger = deps.logger ?? createLogger({ level: 'silent', color: false });
  const http = deps.http ?? makeHttpClient(options, logger);
  const store = deps.store ?? new AssetStore(options.outDir);
  const startedAt = Date.now();
  const urls = buildUrls(options);
  const metaPath = store.metaPath(options.expansion, options.kind, options.id);
  const catalogPath = store.catalogPath(options.expansion, options.kind, options.id);

  let manifest = baseManifest({
    options,
    urls,
    source: 'unknown',
    analysis: null,
    metaStatus: null,
  });

  logger.info(`Coletando ${options.kind} ${options.id} (${options.expansion})`, {
    meta: urls.meta,
  });

  let meta;
  try {
    const metaResult = await loadMeta({
      options,
      http,
      store,
      metaPath,
      urls,
      logger,
    });
    meta = metaResult.raw;
    manifest.source.metaSource = metaResult.source;
    manifest.source.metaStatus = 'ok';
  } catch (error) {
    manifest.errors.push(errorInfo(error));
    manifest.durationMs = Date.now() - startedAt;
    manifest = {
      ...manifest,
      source: {
        ...manifest.source,
        metaStatus: error.status === 404 ? 'not-found' : 'error',
      },
    };
    await store.writeJson(catalogPath, manifest);
    logger.error(`Falha no meta de ${options.kind} ${options.id}: ${error.message}`);
    return manifest;
  }

  let analysis;
  try {
    analysis = analyzeMeta(meta);
  } catch (error) {
    manifest.errors.push(errorInfo(error));
    manifest.durationMs = Date.now() - startedAt;
    manifest.source.metaStatus = 'invalid';
    await store.writeJson(catalogPath, manifest);
    logger.error(`Meta inválido para ${options.kind} ${options.id}: ${error.message}`);
    return manifest;
  }

  manifest = baseManifest({
    options,
    urls,
    source: manifest.source.metaSource,
    analysis,
    metaStatus: 'ok',
  });

  if (analysis.models.length === 0) {
    manifest.errors.push({
      code: analysis.hasCharacter ? 'CHARACTER_MODEL' : 'NO_MODEL',
      message: analysis.hasCharacter
        ? 'O modelo base usa a montagem de personagem (raça/gênero) e não expõe um M2 único neste meta.'
        : 'Nenhum modelo M2 foi encontrado no meta.',
    });
  }

  const modelJobs = analysis.models.map((model, index) => {
    const relative = assetRelativePaths(
      options.expansion,
      options.kind,
      options.id,
      model.id,
    ).model;
    return {
      id: model.id,
      origins: model.origins,
      url: `${urls.root}/m2/${model.id}.m2`,
      path: relative,
      absolutePath: store.resolve(relative),
      index,
      kind: 'model',
    };
  });

  const textureJobs = analysis.textures.map((texture, index) => {
    const relative = assetRelativePaths(
      options.expansion,
      options.kind,
      options.id,
      null,
      texture.id,
    ).texture;
    return {
      id: texture.id,
      slot: texture.slot,
      origins: texture.origins,
      url: `${urls.root}/textures/${texture.id}.webp`,
      path: relative,
      absolutePath: store.resolve(relative),
      index,
      kind: 'texture',
    };
  });

  async function downloadJobs(jobs, enabled) {
    return mapLimit(jobs, options.assetConcurrency, async (job) => {
      const metadata = {
        id: job.id,
        ...(job.slot !== undefined ? { slot: job.slot } : {}),
        ...(job.modelId !== undefined ? { modelId: job.modelId } : {}),
        origins: job.origins,
        url: job.url,
        path: job.path,
      };

      if (!enabled) {
        return {
          ...metadata,
          status: 'skipped',
          bytes: 0,
          sha256: null,
        };
      }

      try {
        const result = await store.download({
          url: job.url,
          absolutePath: job.absolutePath,
          kind: job.kind,
          http,
          force: options.force,
        });
        logger.debug(
          `${result.status === 'cached' ? 'Reutilizado' : 'Baixado'} ${job.kind} ${job.id} (${formatBytes(result.bytes)})`,
        );
        return {
          ...metadata,
          status: result.status,
          bytes: result.bytes,
          sha256: result.sha256,
        };
      } catch (error) {
        const info = errorInfo(error);
        logger.warn(`Falha ao baixar ${job.kind} ${job.id}: ${info.message}`);
        return {
          ...metadata,
          status: 'failed',
          bytes: 0,
          sha256: null,
          error: info,
        };
      }
    });
  }

  manifest.assets.models = await downloadJobs(modelJobs, options.downloadModels);

  const modelFiles = new Map();
  for (const asset of manifest.assets.models) {
    if (asset.status === 'failed' || asset.status === 'skipped') continue;
    try {
      const info = parseM2FileIds(await readFile(store.resolve(asset.path)));
      asset.skinFileIds = info.skinFileIds;
      asset.physFileId = info.physFileId;
      modelFiles.set(asset.id, info);
    } catch (error) {
      asset.skinFileIds = [];
      asset.physFileId = null;
      logger.warn(`Não foi possível ler referências do M2 ${asset.id}: ${error.message}`);
    }
  }

  const skinJobs = [];
  const physJobs = [];
  const seenSkins = new Set();
  const seenPhys = new Set();

  for (const model of analysis.models) {
    const info = modelFiles.get(model.id);
    if (!info) continue;

    for (const skinId of info.skinFileIds) {
      if (seenSkins.has(skinId)) continue;
      seenSkins.add(skinId);
      const relative = assetRelativePaths(
        options.expansion,
        options.kind,
        options.id,
        model.id,
        null,
        skinId,
      ).skin;
      skinJobs.push({
        id: skinId,
        modelId: model.id,
        origins: [`model:${model.id}`],
        url: `${urls.root}/skin/${skinId}.skin`,
        path: relative,
        absolutePath: store.resolve(relative),
        kind: 'skin',
      });
    }

    if (info.physFileId && !seenPhys.has(info.physFileId)) {
      const physId = info.physFileId;
      seenPhys.add(physId);
      const relative = assetRelativePaths(
        options.expansion,
        options.kind,
        options.id,
        model.id,
        null,
        null,
        physId,
      ).phys;
      physJobs.push({
        id: physId,
        modelId: model.id,
        origins: [`model:${model.id}`],
        url: `${urls.root}/phys/${physId}.phys`,
        path: relative,
        absolutePath: store.resolve(relative),
        kind: 'phys',
      });
    }
  }

  manifest.assets.skins = await downloadJobs(skinJobs, options.downloadSkins);
  manifest.assets.phys = await downloadJobs(physJobs, options.downloadPhys);
  manifest.assets.textures = await downloadJobs(textureJobs, options.downloadTextures);

  const failedModels = manifest.assets.models.filter((asset) => asset.status === 'failed');
  const failedSkins = manifest.assets.skins.filter((asset) => asset.status === 'failed');
  const failedPhys = manifest.assets.phys.filter((asset) => asset.status === 'failed');
  const failedTextures = manifest.assets.textures.filter((asset) => asset.status === 'failed');

  for (const asset of failedModels) {
    manifest.errors.push({
      code: 'MODEL_DOWNLOAD_FAILED',
      message: `Modelo ${asset.id}: ${asset.error?.message ?? 'falha no download'}`,
    });
  }
  for (const asset of failedSkins) {
    manifest.errors.push({
      code: 'SKIN_DOWNLOAD_FAILED',
      message: `Skin ${asset.id}: ${asset.error?.message ?? 'falha no download'}`,
    });
  }
  for (const asset of failedPhys) {
    manifest.errors.push({
      code: 'PHYS_DOWNLOAD_FAILED',
      message: `Física ${asset.id}: ${asset.error?.message ?? 'falha no download'}`,
    });
  }
  for (const asset of failedTextures) {
    manifest.errors.push({
      code: 'TEXTURE_DOWNLOAD_FAILED',
      message: `Textura ${asset.id}: ${asset.error?.message ?? 'falha no download'}`,
    });
  }

  const anyAssetFailed = failedSkins.length > 0 || failedPhys.length > 0 || failedTextures.length > 0;

  if (failedModels.length > 0 || manifest.errors.some((error) => error.code === 'NO_MODEL' || error.code === 'CHARACTER_MODEL')) {
    manifest.status = 'failed';
  } else if (anyAssetFailed) {
    manifest.status = options.strict ? 'failed' : 'partial';
  } else {
    manifest.status = isComplete(manifest, options) ? 'complete' : 'partial';
  }

  updateStats(manifest);
  manifest.durationMs = Date.now() - startedAt;

  await store.writeJson(catalogPath, manifest);

  const summary = `${options.kind} ${options.id}: ${manifest.status}, ${manifest.stats.models} modelo(s), ${manifest.stats.skins} skin(s), ${manifest.stats.textures} textura(s), ${formatBytes(manifest.stats.bytes)}`;
  if (manifest.status === 'complete') {
    logger.success(`${summary} em ${formatDuration(manifest.durationMs)}`);
  } else if (manifest.status === 'partial') {
    logger.warn(`${summary} em ${formatDuration(manifest.durationMs)}`);
  } else {
    logger.error(`${summary} em ${formatDuration(manifest.durationMs)}`);
  }

  return manifest;
}

function manifestIsFailure(manifest, strict = false) {
  return manifest.status === 'failed' || (strict && manifest.status !== 'complete');
}

export async function scrapeMany(input, deps = {}) {
  const ids = unique((input.ids ?? []).map((id) => parseId(id, 'ID do registro')));
  const logger = deps.logger ?? createLogger({ level: 'info', color: true });
  const baseOptions = {
    ...input,
    timeoutMs: input.timeoutMs ?? DEFAULTS.timeoutMs,
    retries: input.retries ?? DEFAULTS.retries,
    retryBaseMs: input.retryBaseMs ?? DEFAULTS.retryBaseMs,
    minIntervalMs: input.minIntervalMs ?? DEFAULTS.minIntervalMs,
    assetConcurrency: input.assetConcurrency ?? DEFAULTS.assetConcurrency,
    outDir: input.outDir ?? DEFAULTS.outDir,
    baseUrl: input.baseUrl ?? DEFAULTS.baseUrl,
    expansion: input.expansion ?? DEFAULTS.expansion,
    kind: input.kind ?? DEFAULTS.kind,
  };

  const http = deps.http ?? makeHttpClient(baseOptions, logger);
  const store = deps.store ?? new AssetStore(baseOptions.outDir);
  const concurrency = Math.max(1, Number(input.recordConcurrency ?? DEFAULTS.recordConcurrency));
  const failFast = Boolean(input.failFast);
  const results = new Array(ids.length);
  let cursor = 0;
  let stopped = false;

  logger.info(`Iniciando ${ids.length} registro(s) com concorrência ${concurrency}`, {
    expansion: baseOptions.expansion,
    kind: baseOptions.kind,
  });

  async function worker() {
    while (true) {
      if (stopped) return;
      const index = cursor;
      cursor += 1;
      if (index >= ids.length) return;

      try {
        const manifest = await scrapeRecord(
          { ...baseOptions, id: ids[index] },
          { logger, http, store },
        );
        results[index] = manifest;

        if (failFast && manifestIsFailure(manifest, Boolean(input.strict))) {
          stopped = true;
          logger.warn('Interrompendo lote após falha (--fail-fast).');
        }
      } catch (error) {
        const info = errorInfo(error);
        results[index] = {
          status: 'failed',
          id: ids[index],
          expansion: baseOptions.expansion,
          kind: baseOptions.kind,
          errors: [info],
        };
        logger.error(`Erro inesperado em ${ids[index]}: ${info.message}`);
        if (failFast) stopped = true;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, ids.length) }, () => worker()),
  );

  const completed = results.filter(Boolean);
  const counts = {
    total: ids.length,
    complete: completed.filter((entry) => entry.status === 'complete').length,
    partial: completed.filter((entry) => entry.status === 'partial').length,
    failed: completed.filter((entry) => entry.status === 'failed').length,
    bytes: completed.reduce((total, entry) => total + (entry.stats?.bytes ?? 0), 0),
  };

  if (stopped && completed.length < ids.length) {
    counts.skipped = ids.length - completed.length;
  }

  const exitCode =
    counts.failed > 0 || (input.strict && counts.partial > 0) ? 1 : 0;

  logger.info(
    `Lote concluído: ${counts.complete} completo(s), ${counts.partial} parcial(is), ${counts.failed} falha(s), ${formatBytes(counts.bytes)}`,
  );

  return { results, counts, exitCode, stopped };
}
