import { ValidationError } from './errors.js';
import { isPlainObject, toPositiveInteger } from './utils.js';

const TEXTURE_MAPS = new Set(['Textures', 'Textures2', 'ComponentTextures']);
const FILE_MAPS = new Set(['TextureFiles', 'ModelFiles']);

function addId(map, id, origin) {
  const parsed = toPositiveInteger(id);
  if (parsed === null) return;
  const existing = map.get(parsed);
  if (existing) {
    if (!existing.origins.includes(origin)) existing.origins.push(origin);
    return;
  }
  map.set(parsed, { id: parsed, origins: [origin] });
}

function isFileDataIdKey(key) {
  return /^file_?data_?id$/i.test(key);
}

function filesFromValue(value, map, origin, depth = 0) {
  if (depth > 16) return;

  const parsed = toPositiveInteger(value);
  if (parsed !== null) {
    addId(map, parsed, origin);
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      filesFromValue(entry, map, `${origin}[${index}]`, depth + 1);
    });
    return;
  }

  if (!isPlainObject(value)) return;

  let hasFileDataId = false;
  for (const [key, entry] of Object.entries(value)) {
    if (isFileDataIdKey(key)) {
      addId(map, entry, `${origin}.${key}`);
      hasFileDataId = true;
    }
  }
  if (hasFileDataId) return;

  for (const [key, entry] of Object.entries(value)) {
    if (isPlainObject(entry) || Array.isArray(entry)) {
      filesFromValue(entry, map, `${origin}.${key}`, depth + 1);
    }
  }
}

function slotsFromValue(value, map, origin, depth = 0) {
  if (depth > 12) return;

  const parsed = toPositiveInteger(value);
  if (parsed !== null) {
    addId(map, parsed, origin);
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      slotsFromValue(entry, map, `${origin}[${index}]`, depth + 1);
    });
    return;
  }

  if (!isPlainObject(value)) return;

  let hasFileDataId = false;
  for (const [key, entry] of Object.entries(value)) {
    if (isFileDataIdKey(key)) {
      addId(map, entry, `${origin}.${key}`);
      hasFileDataId = true;
    }
  }
  if (hasFileDataId) return;

  for (const [key, entry] of Object.entries(value)) {
    slotsFromValue(entry, map, `${origin}.${key}`, depth + 1);
  }
}

function componentModelsFromValue(value, maps, origin, depth = 0) {
  if (depth > 12) return;

  const parsed = toPositiveInteger(value);
  if (parsed !== null) {
    addId(maps.models, parsed, origin);
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      componentModelsFromValue(entry, maps, `${origin}[${index}]`, depth + 1);
    });
    return;
  }

  if (!isPlainObject(value)) return;

  for (const [key, entry] of Object.entries(value)) {
    if (isFileDataIdKey(key)) {
      addId(maps.models, entry, `${origin}.${key}`);
      continue;
    }
    if (key === 'Model' || key === 'ModelFileID' || key === 'ModelFileDataID') {
      addId(maps.models, entry, `${origin}.${key}`);
      continue;
    }
    if (TEXTURE_MAPS.has(key)) {
      slotsFromValue(entry, maps.textures, `${origin}.${key}`);
      continue;
    }
    if (isPlainObject(entry) || Array.isArray(entry)) {
      componentModelsFromValue(entry, maps, `${origin}.${key}`, depth + 1);
    }
  }
}

function walk(value, path, maps, depth = 0) {
  if (depth > 24 || value === null || value === undefined) return;

  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      walk(entry, `${path}[${index}]`, maps, depth + 1);
    });
    return;
  }

  if (!isPlainObject(value)) return;

  for (const [key, entry] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;

    if (key === 'Model' || key === 'ModelFileID' || key === 'ModelFileDataID') {
      addId(maps.models, entry, childPath);
      continue;
    }

    if (TEXTURE_MAPS.has(key)) {
      slotsFromValue(entry, maps.textures, childPath);
      continue;
    }

    if (key === 'ComponentModels') {
      componentModelsFromValue(entry, maps, childPath);
      continue;
    }

    if (FILE_MAPS.has(key)) {
      filesFromValue(
        entry,
        maps[key === 'ModelFiles' ? 'models' : 'textures'],
        childPath,
      );
      continue;
    }

    walk(entry, childPath, maps, depth + 1);
  }
}

function textureSlot(origin) {
  const match = /(?:^|\.)Textures(?:2)?\.([^.[]+)/.exec(origin);
  return match ? match[1] : null;
}

export function analyzeMeta(raw) {
  if (!isPlainObject(raw)) {
    throw new ValidationError('O meta precisa ser um objeto JSON.');
  }

  if (!('Model' in raw) && !('Textures' in raw) && !('TextureFiles' in raw)) {
    throw new ValidationError(
      'Meta inválido: campos de modelo/textura não encontrados.',
    );
  }

  const maps = {
    models: new Map(),
    textures: new Map(),
  };

  walk(raw, '', maps);

  const models = [...maps.models.values()].map((model) => ({
    id: model.id,
    origins: model.origins,
  }));

  const textures = [...maps.textures.values()].map((texture) => ({
    id: texture.id,
    slot: textureSlot(texture.origins[0]),
    origins: texture.origins,
  }));

  return {
    modelId: toPositiveInteger(raw.Model),
    models,
    textures,
    textureSlots: isPlainObject(raw.Textures) ? raw.Textures : null,
    hasCharacter: Boolean(raw.Character),
    hasEquipment: Boolean(raw.Equipment),
    scale: typeof raw.Scale === 'number' ? raw.Scale : null,
  };
}

export function summarizeMeta(raw) {
  const analyzed = analyzeMeta(raw);
  return {
    modelId: analyzed.modelId,
    modelIds: analyzed.models.map((entry) => entry.id),
    textureIds: analyzed.textures.map((entry) => entry.id),
    textureSlots: analyzed.textureSlots,
    scale: analyzed.scale,
    hasCharacter: analyzed.hasCharacter,
  };
}
