#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { DEFAULTS, DEFAULT_HOST, DEFAULT_PORT, EXPANSIONS, VERSION } from './constants.js';
import { ConfigError } from './errors.js';
import { parseIdList } from './ids.js';
import { createLogger, formatBytes } from './logger.js';
import { analyzeMeta } from './meta.js';
import { makeHttpClient, scrapeMany } from './scraper.js';
import { startServer } from './server.js';
import { AssetStore } from './storage.js';
import { buildUrls, normalizeBaseUrl, normalizeExpansion, normalizeKind, parseId } from './urls.js';

const VALUE_OPTIONS = new Set([
  'expansion',
  'kind',
  'out',
  'base-url',
  'file',
  'id',
  'concurrency',
  'record-concurrency',
  'asset-concurrency',
  'timeout',
  'retries',
  'retry-base',
  'rate',
  'min-interval',
  'port',
  'host',
  'limit',
  'q',
]);

const BOOLEAN_OPTIONS = new Set([
  'force',
  'strict',
  'no-model',
  'no-skins',
  'no-phys',
  'no-textures',
  'no-color',
  'quiet',
  'json',
  'fail-fast',
  'checksums',
  'help',
  'version',
  'raw',
]);

const SHORT_OPTIONS = {
  e: 'expansion',
  k: 'kind',
  o: 'out',
  i: 'file',
  p: 'port',
  H: 'host',
  j: 'json',
  q: 'quiet',
  h: 'help',
  F: 'force',
  V: 'version',
};

function camelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

export function parseArgv(argv) {
  const options = {};
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (token.startsWith('--')) {
      const [rawKey, inlineValue] = token.slice(2).split('=', 2);
      const key = rawKey;

      if (BOOLEAN_OPTIONS.has(key)) {
        if (inlineValue !== undefined) {
          throw new ConfigError(`A opção --${key} não aceita valor.`);
        }
        options[camelCase(key)] = true;
        continue;
      }

      if (!VALUE_OPTIONS.has(key)) {
        throw new ConfigError(`Opção desconhecida: --${key}`);
      }

      const value = inlineValue ?? argv[index + 1];
      if (value === undefined || (inlineValue === undefined && value.startsWith('-'))) {
        throw new ConfigError(`A opção --${key} precisa de um valor.`);
      }
      if (inlineValue === undefined) index += 1;
      options[camelCase(key)] = value;
      continue;
    }

    if (token.startsWith('-') && token !== '-') {
      const short = token.slice(1);
      const key = SHORT_OPTIONS[short];
      if (!key) throw new ConfigError(`Opção desconhecida: -${short}`);
      if (BOOLEAN_OPTIONS.has(key)) {
        options[camelCase(key)] = true;
        continue;
      }
      const value = argv[index + 1];
      if (value === undefined) {
        throw new ConfigError(`A opção -${short} precisa de um valor.`);
      }
      index += 1;
      options[camelCase(key)] = value;
      continue;
    }

    positionals.push(token);
  }

  return { options, positionals };
}

function envValue(name, fallback) {
  return process.env[name] ?? fallback;
}

function numericOption(value, label, { min = 0, integer = false, fallback } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || (integer && !Number.isInteger(parsed))) {
    throw new ConfigError(`${label} inválido: ${value}`);
  }
  return parsed;
}

function makeLoggerFromOptions(options) {
  return createLogger({
    level: options.json ? 'silent' : options.quiet ? 'warn' : 'info',
    color: !options.noColor && !options.json,
    json: false,
  });
}

function outputJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function looksLikeIdToken(token) {
  return /^\d+(?:\s*-\s*\d+)?$/.test(token) || token.includes(',');
}

function commonScrapeOptions(options) {
  const rate = numericOption(options.rate, '--rate', { min: 0.01 });
  const minInterval = numericOption(options.minInterval, '--min-interval', { fallback: DEFAULTS.minIntervalMs });
  return {
    baseUrl: normalizeBaseUrl(
      options.baseUrl ?? envValue('WOWSCRAPER_BASE_URL', DEFAULTS.baseUrl),
    ),
    outDir: options.out ?? envValue('WOWSCRAPER_OUT', DEFAULTS.outDir),
    force: Boolean(options.force),
    strict: Boolean(options.strict),
    downloadModels: !options.noModel,
    downloadSkins: !options.noModel && !options.noSkins,
    downloadPhys: !options.noModel && !options.noPhys,
    downloadTextures: !options.noTextures,
    recordConcurrency: numericOption(options.concurrency ?? options.recordConcurrency, '--concurrency', {
      min: 1,
      integer: true,
      fallback: DEFAULTS.recordConcurrency,
    }),
    assetConcurrency: numericOption(options.assetConcurrency, '--asset-concurrency', {
      min: 1,
      integer: true,
      fallback: DEFAULTS.assetConcurrency,
    }),
    timeoutMs: numericOption(options.timeout, '--timeout', {
      min: 1,
      fallback: DEFAULTS.timeoutMs,
    }),
    retries: numericOption(options.retries, '--retries', {
      min: 0,
      integer: true,
      fallback: DEFAULTS.retries,
    }),
    retryBaseMs: numericOption(options.retryBase, '--retry-base', {
      min: 0,
      fallback: DEFAULTS.retryBaseMs,
    }),
    minIntervalMs: rate !== undefined ? 1000 / rate : minInterval,
    failFast: Boolean(options.failFast),
  };
}

async function readIdsSource(file) {
  if (!file) return '';
  if (file === '-') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  }
  return readFile(file, 'utf8');
}

async function commandScrape(options, positionals) {
  if (options.help) {
    printScrapeHelp();
    return 0;
  }

  const args = [...positionals];
  let commandKind;
  if (args.length > 0 && !looksLikeIdToken(args[0])) {
    commandKind = normalizeKind(args.shift());
  }

  const kind = normalizeKind(
    options.kind ?? commandKind ?? envValue('WOWSCRAPER_KIND', DEFAULTS.kind),
  );
  const expansion = normalizeExpansion(
    options.expansion ?? envValue('WOWSCRAPER_EXPANSION', DEFAULTS.expansion),
  );

  const inlineIds = [args.join(' '), options.id, await readIdsSource(options.file)]
    .filter(Boolean)
    .join('\n');

  if (!inlineIds.trim()) {
    throw new ConfigError(
      'Nenhum ID informado. Exemplo: npm run scrape -- npc 137698 --expansion mists',
    );
  }

  const ids = parseIdList(inlineIds);
  if (ids.length === 0) throw new ConfigError('Nenhum ID válido encontrado.');

  const logger = makeLoggerFromOptions(options);
  const scrapeOptions = {
    ...commonScrapeOptions(options),
    expansion,
    kind,
  };

  const result = await scrapeMany({ ...scrapeOptions, ids }, { logger });

  if (options.json) {
    outputJson({
      expansion,
      kind,
      counts: result.counts,
      results: result.results,
    });
  }

  return result.exitCode;
}

async function commandMeta(options, positionals) {
  if (options.help) {
    printMetaHelp();
    return 0;
  }

  const args = [...positionals];
  let commandKind;
  if (args.length > 0 && !looksLikeIdToken(args[0])) {
    commandKind = normalizeKind(args.shift());
  }

  const kind = normalizeKind(options.kind ?? commandKind ?? DEFAULTS.kind);
  const expansion = normalizeExpansion(options.expansion ?? DEFAULTS.expansion);
  const id = parseId(args[0] ?? options.id, 'ID do registro');
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULTS.baseUrl);
  const urls = buildUrls({ baseUrl, expansion, kind, id });
  const logger = makeLoggerFromOptions(options);
  const http = makeHttpClient(
    {
      timeoutMs: numericOption(options.timeout, '--timeout', { fallback: DEFAULTS.timeoutMs }),
      retries: numericOption(options.retries, '--retries', { fallback: DEFAULTS.retries }),
    },
    logger,
  );

  const raw = await http.json(urls.meta);

  if (options.raw) {
    if (options.json) outputJson({ url: urls.meta, meta: raw });
    else process.stdout.write(`${JSON.stringify(raw, null, 2)}\n`);
    return 0;
  }

  const analysis = analyzeMeta(raw);
  const summary = {
    expansion,
    kind,
    id,
    url: urls.meta,
    modelId: analysis.modelId,
    modelIds: analysis.models.map((entry) => entry.id),
    textures: analysis.textures.map((entry) => ({
      id: entry.id,
      slot: entry.slot,
      origins: entry.origins,
    })),
    scale: analysis.scale,
    hasCharacter: analysis.hasCharacter,
    hasEquipment: analysis.hasEquipment,
  };

  if (options.json) {
    outputJson(summary);
    return 0;
  }

  process.stdout.write(`Meta: ${kind} ${id} (${expansion})\n`);
  process.stdout.write(`URL: ${urls.meta}\n`);
  process.stdout.write(`Modelo principal: ${summary.modelId ?? 'nenhum'}\n`);
  process.stdout.write(`Modelos M2: ${summary.modelIds.join(', ') || 'nenhum'}\n`);
  process.stdout.write('Texturas:\n');
  if (summary.textures.length === 0) {
    process.stdout.write('  nenhuma\n');
  } else {
    for (const texture of summary.textures) {
      process.stdout.write(
        `  ${texture.id}${texture.slot ? ` (slot ${texture.slot})` : ''} -> ${urls.root}/textures/${texture.id}.webp\n`,
      );
    }
  }
  if (summary.hasCharacter) {
    process.stdout.write('Personagem: sim (modelo montado por raça/gênero)\n');
  }
  if (summary.scale !== null) {
    process.stdout.write(`Escala: ${summary.scale}\n`);
  }
  return 0;
}

function resizeColumn(value, width) {
  const text = String(value ?? '');
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
}

async function commandList(options) {
  if (options.help) {
    printListHelp();
    return 0;
  }

  const store = new AssetStore(options.out ?? DEFAULTS.outDir);
  const expansion = options.expansion ? normalizeExpansion(options.expansion) : undefined;
  const kind = options.kind ? normalizeKind(options.kind) : undefined;
  const query = String(options.q ?? '').trim().toLowerCase();
  const limit = numericOption(options.limit, '--limit', {
    min: 1,
    integer: true,
    fallback: 250,
  });

  let records = await store.listCatalogs({ expansion, kind });
  if (query) {
    records = records.filter((record) =>
      [
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
        .toLowerCase()
        .includes(query),
    );
  }
  records = records.slice(0, limit);

  if (options.json) {
    outputJson({ total: records.length, records });
    return 0;
  }

  if (records.length === 0) {
    process.stdout.write('Nenhum registro encontrado.\n');
    return 0;
  }

  process.stdout.write(
    `${resizeColumn('TIPO', 8)} ${resizeColumn('ID', 9)} ${resizeColumn('EXPANSÃO', 13)} ${resizeColumn('STATUS', 9)} ${resizeColumn('MODELOS', 8)} ${resizeColumn('SKINS', 6)} ${resizeColumn('TEXTURAS', 9)} ${resizeColumn('FÍSICOS', 8)} TAMANHO\n`,
  );
  process.stdout.write(`${'-'.repeat(88)}\n`);
  for (const record of records) {
    process.stdout.write(
      `${resizeColumn(record.kind, 8)} ${resizeColumn(record.id, 9)} ${resizeColumn(record.expansion, 13)} ${resizeColumn(record.status, 9)} ${resizeColumn(record.stats?.models ?? 0, 8)} ${resizeColumn(record.stats?.skins ?? 0, 6)} ${resizeColumn(record.stats?.textures ?? 0, 9)} ${resizeColumn(record.stats?.phys ?? 0, 8)} ${formatBytes(record.stats?.bytes ?? 0)}\n`,
    );
  }
  process.stdout.write(`\n${records.length} registro(s).\n`);
  return 0;
}

async function commandVerify(options) {
  if (options.help) {
    printVerifyHelp();
    return 0;
  }

  const store = new AssetStore(options.out ?? DEFAULTS.outDir);
  const expansion = options.expansion ? normalizeExpansion(options.expansion) : undefined;
  const kind = options.kind ? normalizeKind(options.kind) : undefined;
  const records = await store.listCatalogs({ expansion, kind });
  const issues = [];
  let checked = 0;

  for (const record of records) {
    const assets = [
      ...(record.assets?.models ?? []),
      ...(record.assets?.skins ?? []),
      ...(record.assets?.phys ?? []),
      ...(record.assets?.textures ?? []),
    ];
    for (const asset of assets) {
      if (asset.status === 'skipped') continue;
      checked += 1;
      const result = await store.verifyAsset(asset, {
        checksums: Boolean(options.checksums),
      });
      if (!result.ok) {
        const extension = String(asset.path ?? '').split('.').pop();
        issues.push({
          expansion: record.expansion,
          kind: record.kind,
          id: record.id,
          asset: asset.id,
          type: extension || 'asset',
          path: asset.path,
          reason: result.reason,
        });
      }
    }
  }

  const summary = {
    records: records.length,
    assets: checked,
    issues,
  };

  if (options.json) {
    outputJson(summary);
  } else if (issues.length === 0) {
    process.stdout.write(
      `OK: ${checked} arquivo(s) em ${records.length} registro(s) verificado(s).\n`,
    );
  } else {
    for (const issue of issues) {
      process.stdout.write(
        `FALHA ${issue.expansion}/${issue.kind}/${issue.id} ${issue.path}: ${issue.reason}\n`,
      );
    }
    process.stdout.write(
      `\n${issues.length} problema(s) em ${checked} arquivo(s) verificado(s).\n`,
    );
  }

  return issues.length > 0 ? 1 : 0;
}

async function commandServe(options) {
  if (options.help) {
    printServeHelp();
    return 0;
  }

  const logger = makeLoggerFromOptions(options);
  const port = numericOption(options.port, '--port', {
    min: 0,
    integer: true,
    fallback: DEFAULT_PORT,
  });
  const host = options.host ?? DEFAULT_HOST;

  const { server } = await startServer({
    port,
    host,
    outDir: options.out ?? DEFAULTS.outDir,
    baseUrl: options.baseUrl ?? DEFAULTS.baseUrl,
    expansions: EXPANSIONS,
    logger,
  });

  const shutdown = (signal) => {
    logger.info(`Encerrando (${signal})...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  return new Promise(() => {});
}

function commandExpansions(options) {
  if (options.json) {
    outputJson({ expansions: EXPANSIONS });
    return 0;
  }
  process.stdout.write('Expansões conhecidas (use o id na opção --expansion):\n');
  for (const expansion of EXPANSIONS) {
    process.stdout.write(`  ${expansion.id.padEnd(14)} ${expansion.label}\n`);
  }
  process.stdout.write('\nAliases aceitos: mop, sl, df, tww, wrath, vanilla e outros.\n');
  process.stdout.write('Qualquer outro slug também é aceito na URL.\n');
  return 0;
}

function printHelp() {
  process.stdout.write(`wow-model-scraper ${VERSION}

Uso:
  node src/cli.js <comando> [opções]

Comandos:
  scrape <tipo> <ids...>   Baixa meta, M2, skins e texturas
  meta <tipo> <id>         Inspeciona o meta sem baixar assets
  list                     Lista registros coletados
  verify                   Verifica integridade dos arquivos
  serve                    Abre o dashboard local
  expansions               Lista expansões conhecidas

Exemplos:
  npm run scrape -- npc 137698 --expansion mists
  npm run scrape -- npc 137698 1000-1005 --expansion mists --force
  npm run scrape -- npc --file ids.txt --expansion mists
  npm run meta -- npc 137698 --expansion mists
  npm run serve

Tipos: npc (creature), object, item.
Expansão padrão: ${DEFAULTS.expansion}.

Use "node src/cli.js <comando> --help" para opções específicas.
`);
}

function printScrapeHelp() {
  process.stdout.write(`Uso:
  node src/cli.js scrape [tipo] <ids...> [opções]

IDs aceitam lista separada por espaço/vírgula, intervalos (100-110) e comentários com #.

Opções:
  -e, --expansion <id>       Expansão do Model Viewer (padrão: ${DEFAULTS.expansion})
  -k, --kind <tipo>          npc, object ou item
  -o, --out <dir>            Pasta de saída (padrão: ${DEFAULTS.outDir})
  -i, --file <arquivo>       Lê IDs de um arquivo (- para stdin)
      --id <lista>           IDs adicionais
  -F, --force                Ignora cache local e baixa novamente
      --strict               Textura ausente também marca falha
      --no-model             Não baixa M2, skins ou física
      --no-skins             Não baixa arquivos .skin
      --no-phys              Não baixa arquivos .phys
      --no-textures          Não baixa texturas
      --concurrency <n>      Registros em paralelo (padrão: ${DEFAULTS.recordConcurrency})
      --asset-concurrency <n> Assets em paralelo por registro (padrão: ${DEFAULTS.assetConcurrency})
      --rate <n>             Máximo de requisições por segundo (padrão: ~12,5)
      --timeout <ms>         Timeout por requisição (padrão: ${DEFAULTS.timeoutMs})
      --retries <n>          Tentativas em falhas temporárias (padrão: ${DEFAULTS.retries})
      --fail-fast            Para o lote na primeira falha
  -q, --quiet                Mostra apenas avisos e erros
  -j, --json                 Saída JSON
  -h, --help                 Ajuda
`);
}

function printMetaHelp() {
  process.stdout.write(`Uso:
  node src/cli.js meta [tipo] <id> [opções]

Opções:
  -e, --expansion <id>   Expansão (padrão: ${DEFAULTS.expansion})
  -k, --kind <tipo>      npc, object ou item
      --base-url <url>   URL base alternativa
      --raw              Exibe o JSON original
  -j, --json             Saída JSON
  -h, --help             Ajuda
`);
}

function printListHelp() {
  process.stdout.write(`Uso:
  node src/cli.js list [opções]

Opções:
  -e, --expansion <id>   Filtra por expansão
  -k, --kind <tipo>      Filtra por tipo
      --q <texto>        Busca por ID, modelo ou textura
      --limit <n>        Máximo de registros (padrão: 250)
  -o, --out <dir>        Pasta de dados (padrão: ${DEFAULTS.outDir})
  -j, --json             Saída JSON
  -h, --help             Ajuda
`);
}

function printVerifyHelp() {
  process.stdout.write(`Uso:
  node src/cli.js verify [opções]

Opções:
  -e, --expansion <id>   Filtra por expansão
  -k, --kind <tipo>      Filtra por tipo
  -o, --out <dir>        Pasta de dados (padrão: ${DEFAULTS.outDir})
      --checksums        Recalcula e compara sha256 (mais lento)
  -j, --json             Saída JSON
  -h, --help             Ajuda
`);
}

function printServeHelp() {
  process.stdout.write(`Uso:
  node src/cli.js serve [opções]

Opções:
      --port <n>         Porta (padrão: ${DEFAULT_PORT})
      --host <host>      Host (padrão: ${DEFAULT_HOST})
  -o, --out <dir>        Pasta de dados (padrão: ${DEFAULTS.outDir})
      --base-url <url>   URL base do Model Viewer
  -q, --quiet            Logs reduzidos
  -h, --help             Ajuda
`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    printHelp();
    return 0;
  }

  const command = argv.shift();

  if (command === '--version' || command === '-V' || command === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return 0;
  }

  const { options, positionals } = parseArgv(argv);

  if (options.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  if (options.help && !['scrape', 'meta', 'list', 'verify', 'serve'].includes(command)) {
    printHelp();
    return 0;
  }

  switch (command) {
    case 'scrape':
      return commandScrape(options, positionals);
    case 'meta':
      return commandMeta(options, positionals);
    case 'list':
      return commandList(options);
    case 'verify':
      return commandVerify(options);
    case 'serve':
      return commandServe(options);
    case 'expansions':
      return commandExpansions(options);
    default:
      throw new ConfigError(`Comando desconhecido: ${command}`);
  }
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode ?? 0;
  })
  .catch((error) => {
    const logger = createLogger({ level: 'error', color: true });
    logger.error(error.message);
    if (process.env.DEBUG && error.stack) {
      process.stderr.write(`${error.stack}\n`);
    }
    process.exitCode = error.code === 'CONFIG_ERROR' ? 2 : 1;
  });
