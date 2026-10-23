export const VERSION = '1.1.0';

export const DEFAULT_BASE_URL = 'https://wow.zamimg.com/modelviewer';
export const DEFAULT_EXPANSION = 'mists';
export const DEFAULT_KIND = 'npc';
export const DEFAULT_OUT_DIR = 'data';
export const DEFAULT_PORT = 4317;
export const DEFAULT_HOST = '127.0.0.1';
export const USER_AGENT = `wow-model-scraper/${VERSION} (+https://github.com/)`;

export const DEFAULTS = Object.freeze({
  baseUrl: DEFAULT_BASE_URL,
  expansion: DEFAULT_EXPANSION,
  kind: DEFAULT_KIND,
  outDir: DEFAULT_OUT_DIR,
  timeoutMs: 30_000,
  retries: 3,
  retryBaseMs: 600,
  minIntervalMs: 80,
  recordConcurrency: 2,
  assetConcurrency: 4,
  maxBodyBytes: 32 * 1024,
});

export const EXPANSIONS = Object.freeze([
  { id: 'classic', label: 'Classic' },
  { id: 'tbc', label: 'The Burning Crusade' },
  { id: 'wotlk', label: 'Wrath of the Lich King' },
  { id: 'cata', label: 'Cataclysm' },
  { id: 'mists', label: 'Mists of Pandaria' },
  { id: 'wod', label: 'Warlords of Draenor' },
  { id: 'legion', label: 'Legion' },
  { id: 'bfa', label: 'Battle for Azeroth' },
  { id: 'shadowlands', label: 'Shadowlands' },
  { id: 'dragonflight', label: 'Dragonflight' },
  { id: 'tww', label: 'The War Within' },
  { id: 'midnight', label: 'Midnight' },
  { id: 'live', label: 'Live (Retail)' },
]);

export const EXPANSION_ALIASES = Object.freeze({
  vanilla: 'classic',
  classicera: 'classic',
  bc: 'tbc',
  burningcrusade: 'tbc',
  wrath: 'wotlk',
  wrathofthelichking: 'wotlk',
  mop: 'mists',
  pandaria: 'mists',
  mistsofpandaria: 'mists',
  warlords: 'wod',
  wod: 'wod',
  bfa: 'bfa',
  battleforazeroth: 'bfa',
  sl: 'shadowlands',
  shadowlands: 'shadowlands',
  df: 'dragonflight',
  dragonflight: 'dragonflight',
  warwithin: 'tww',
  thewarwithin: 'tww',
});

export const KIND_ALIASES = Object.freeze({
  npc: 'npc',
  creature: 'npc',
  creaturedisplay: 'npc',
  object: 'object',
  doodad: 'object',
  item: 'item',
  itemdisplay: 'item',
});

export const KNOWN_KINDS = Object.freeze(['npc', 'object', 'item']);

export const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.m2': 'application/octet-stream',
  '.skin': 'application/octet-stream',
  '.phys': 'application/octet-stream',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
});

export const ASSET_MAGIC = Object.freeze({
  model: (bytes) =>
    bytes.length >= 4 &&
    bytes.toString('ascii', 0, 4) === 'MD21',
  legacyModel: (bytes) =>
    bytes.length >= 4 &&
    bytes.toString('ascii', 0, 4) === 'MD20',
  skin: (bytes) =>
    bytes.length >= 4 && bytes.toString('ascii', 0, 4) === 'SKIN',
  texture: (bytes) =>
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP',
});
