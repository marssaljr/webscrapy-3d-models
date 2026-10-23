import { createHash, randomBytes } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
} from 'node:fs';
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ASSET_MAGIC } from './constants.js';
import { DownloadValidationError } from './errors.js';
import { safeJson } from './utils.js';

class HashingTransform extends Transform {
  constructor(prefixLength = 32) {
    super();
    this.hash = createHash('sha256');
    this.bytes = 0;
    this.prefix = Buffer.alloc(0);
    this.relevantBytes = prefixLength;
  }

  _transform(chunk, _encoding, callback) {
    this.hash.update(chunk);
    this.bytes += chunk.length;

    if (this.prefix.length < this.relevantBytes) {
      const remaining = this.relevantBytes - this.prefix.length;
      this.prefix = Buffer.concat([this.prefix, chunk.subarray(0, remaining)]);
    }

    callback(null, chunk);
  }

  digest() {
    return this.hash.digest('hex');
  }
}

export function assetRelativePaths(
  expansion,
  kind,
  id,
  modelId,
  textureId,
  skinId,
  physId,
) {
  const base = `${expansion}`;
  return {
    meta: `${base}/meta/${kind}/${id}.json`,
    catalog: `${base}/catalog/${kind}/${id}.json`,
    model: `${base}/models/${modelId}.m2`,
    skin: `${base}/skins/${skinId}.skin`,
    phys: `${base}/phys/${physId}.phys`,
    texture: `${base}/textures/${textureId}.webp`,
  };
}

export class AssetStore {
  constructor(rootDir) {
    this.rootDir = path.resolve(rootDir);
  }

  resolve(relativePath) {
    const absolute = path.resolve(this.rootDir, relativePath);
    const relative = path.relative(this.rootDir, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new DownloadValidationError(`Caminho fora da pasta de dados: ${relativePath}`);
    }
    return absolute;
  }

  metaPath(expansion, kind, id) {
    return this.resolve(assetRelativePaths(expansion, kind, id).meta);
  }

  catalogPath(expansion, kind, id) {
    return this.resolve(assetRelativePaths(expansion, kind, id).catalog);
  }

  modelPath(expansion, modelId) {
    return this.resolve(`${expansion}/models/${modelId}.m2`);
  }

  skinPath(expansion, skinId) {
    return this.resolve(`${expansion}/skins/${skinId}.skin`);
  }

  physPath(expansion, physId) {
    return this.resolve(`${expansion}/phys/${physId}.phys`);
  }

  texturePath(expansion, textureId) {
    return this.resolve(`${expansion}/textures/${textureId}.webp`);
  }

  async exists(relativeOrAbsolute) {
    const absolute = path.isAbsolute(relativeOrAbsolute)
      ? relativeOrAbsolute
      : this.resolve(relativeOrAbsolute);
    try {
      await access(absolute);
      return true;
    } catch {
      return false;
    }
  }

  async readJson(absolutePath) {
    const text = await readFile(absolutePath, 'utf8');
    return JSON.parse(text);
  }

  async readJsonIfExists(absolutePath) {
    try {
      return await this.readJson(absolutePath);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async writeJson(absolutePath, value) {
    await mkdir(path.dirname(absolutePath), { recursive: true });
    const temp = `${absolutePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(temp, `${safeJson(value)}\n`, 'utf8');
      if (await this.exists(absolutePath)) await unlink(absolutePath).catch(() => {});
      await rename(temp, absolutePath);
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
  }

  async download({ url, absolutePath, kind, http, force = false, signal }) {
    if (!force) {
      try {
        const existing = await stat(absolutePath);
        if (existing.isFile() && existing.size > 0) {
          return {
            status: 'cached',
            bytes: existing.size,
            sha256: null,
            url,
          };
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }

    await mkdir(path.dirname(absolutePath), { recursive: true });
    const temp = `${absolutePath}.${process.pid}.${randomBytes(4).toString('hex')}.part`;
    const response = await http.request(url, {
      accept: kind === 'texture' ? 'image/webp,image/*,*/*' : '*/*',
      signal,
    });

    const hasher = new HashingTransform(32);

    try {
      if (!response.body) {
        throw new DownloadValidationError(`Resposta vazia para ${url}`);
      }

      await pipeline(
        Readable.fromWeb(response.body),
        hasher,
        createWriteStream(temp, { flags: 'wx' }),
      );

      if (hasher.bytes === 0) {
        throw new DownloadValidationError(`Arquivo vazio: ${url}`);
      }

      validateMagic(kind, hasher.prefix, url);

      if (await this.exists(absolutePath)) {
        await unlink(absolutePath).catch(() => {});
      }
      await rename(temp, absolutePath);

      return {
        status: 'downloaded',
        bytes: hasher.bytes,
        sha256: hasher.digest(),
        url,
      };
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  async listCatalogs({ expansion, kind } = {}) {
    const results = [];

    async function walk(directory, depth = 0) {
      if (depth > 6) return;
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return;
        throw error;
      }

      for (const entry of entries) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(absolute, depth + 1);
        } else if (entry.isFile() && entry.name.endsWith('.json')) {
          const catalogDir = path.basename(path.dirname(absolute));
          if (kind && catalogDir !== kind) continue;
          try {
            const catalog = await readFile(absolute, 'utf8');
            results.push(JSON.parse(catalog));
          } catch {
            // Catálogos inválidos são ignorados na listagem.
          }
        }
      }
    }

    if (expansion) {
      await walk(path.join(this.rootDir, expansion, 'catalog'));
    } else {
      let expansions;
      try {
        expansions = await readdir(this.rootDir, { withFileTypes: true });
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
      for (const entry of expansions) {
        if (!entry.isDirectory()) continue;
        await walk(path.join(this.rootDir, entry.name, 'catalog'));
      }
    }

    return results.sort((a, b) =>
      String(b.scrapedAt ?? '').localeCompare(String(a.scrapedAt ?? '')),
    );
  }

  async checksum(absolutePath) {
    const hash = createHash('sha256');
    await pipeline(createReadStream(absolutePath), hash);
    return hash.digest('hex');
  }

  async verifyAsset(asset, { checksums = false } = {}) {
    const absolute = this.resolve(asset.path);
    try {
      const info = await stat(absolute);
      if (!info.isFile()) {
        return { ok: false, reason: 'não é um arquivo' };
      }
      if (Number.isFinite(asset.bytes) && info.size !== asset.bytes) {
        return {
          ok: false,
          reason: `tamanho ${info.size} != ${asset.bytes}`,
        };
      }
      if (checksums && asset.sha256) {
        const actual = await this.checksum(absolute);
        if (actual !== asset.sha256) {
          return { ok: false, reason: 'sha256 divergente' };
        }
      }
      return { ok: true, bytes: info.size };
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { ok: false, reason: 'arquivo ausente' };
      }
      return { ok: false, reason: error.message };
    }
  }
}

export function validateMagic(kind, bytes, url = '') {
  if (kind === 'texture') {
    if (!ASSET_MAGIC.texture(bytes)) {
      throw new DownloadValidationError(
        `Textura não parece ser WebP válida: ${url}`,
      );
    }
    return;
  }

  if (kind === 'model') {
    if (!ASSET_MAGIC.model(bytes) && !ASSET_MAGIC.legacyModel(bytes)) {
      throw new DownloadValidationError(
        `Modelo não parece ser M2 válido (MD20/MD21): ${url}`,
      );
    }
    return;
  }

  if (kind === 'skin' && !ASSET_MAGIC.skin(bytes)) {
    throw new DownloadValidationError(
      `Skin não parece ser válida (SKIN): ${url}`,
    );
  }
}
