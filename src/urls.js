import {
  DEFAULT_BASE_URL,
  EXPANSION_ALIASES,
  KIND_ALIASES,
} from './constants.js';
import { ConfigError } from './errors.js';
import { toPositiveInteger } from './utils.js';

const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export function normalizeBaseUrl(value) {
  const raw = String(value ?? DEFAULT_BASE_URL).trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`URL base inválida: ${raw}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new ConfigError(`A URL base precisa usar http ou https: ${raw}`);
  }
  return url.toString().replace(/\/+$/, '');
}

export function normalizeExpansion(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) throw new ConfigError('Informe a expansão (ex.: mists).');
  const expanded = EXPANSION_ALIASES[raw] ?? raw;
  if (!SLUG_PATTERN.test(expanded)) {
    throw new ConfigError(`Expansão inválida: ${value}`);
  }
  return expanded;
}

export function normalizeKind(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) throw new ConfigError('Informe o tipo (npc, object ou item).');
  const kind = KIND_ALIASES[raw] ?? raw;
  if (!SLUG_PATTERN.test(kind)) {
    throw new ConfigError(`Tipo inválido: ${value}`);
  }
  return kind;
}

export function parseId(value, label = 'ID') {
  const id = toPositiveInteger(value);
  if (id === null) {
    throw new ConfigError(`${label} inválido: ${value}. Use um inteiro positivo.`);
  }
  return id;
}

export function buildUrls({ baseUrl, expansion, kind, id, modelId, textureId }) {
  const base = normalizeBaseUrl(baseUrl);
  const exp = normalizeExpansion(expansion);
  const assetKind = normalizeKind(kind);
  const recordId = parseId(id, 'ID do registro');
  const root = `${base}/${exp}`;

  const urls = {
    base,
    root,
    expansion: exp,
    kind: assetKind,
    id: recordId,
    meta: `${root}/meta/${assetKind}/${recordId}.json`,
  };

  if (modelId !== undefined) {
    const parsedModel = parseId(modelId, 'ID do modelo');
    urls.model = `${root}/m2/${parsedModel}.m2`;
    urls.modelId = parsedModel;
  }

  if (textureId !== undefined) {
    const parsedTexture = parseId(textureId, 'ID da textura');
    urls.texture = `${root}/textures/${parsedTexture}.webp`;
    urls.textureId = parsedTexture;
  }

  return urls;
}

export function wowheadPageUrl(kind, id) {
  const normalizedKind = normalizeKind(kind);
  const recordId = parseId(id);
  if (normalizedKind === 'npc') return `https://www.wowhead.com/npc=${recordId}`;
  if (normalizedKind === 'object') return `https://www.wowhead.com/object=${recordId}`;
  return `https://www.wowhead.com/item=${recordId}`;
}
