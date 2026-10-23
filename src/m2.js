import { ValidationError } from './errors.js';

const CHUNK_HEADER_BYTES = 8;
const MAX_CHUNKS = 512;

function ascii(bytes, start, end) {
  return bytes.toString('ascii', start, end);
}

function readIds(bytes, start, size) {
  const ids = [];
  const end = start + size - (size % 4);
  for (let offset = start; offset < end; offset += 4) {
    const id = bytes.readUInt32LE(offset);
    if (id > 0) ids.push(id);
  }
  return ids;
}

export function parseM2FileIds(bytes) {
  if (!bytes || bytes.length < 4) {
    throw new ValidationError('Arquivo M2 vazio ou truncado.');
  }

  const magic = ascii(bytes, 0, 4);
  if (magic === 'MD20') {
    return {
      magic,
      chunked: false,
      skinFileIds: [],
      physFileId: null,
    };
  }

  if (magic !== 'MD21') {
    throw new ValidationError(`Arquivo não é um M2 válido: ${magic}`);
  }

  const result = {
    magic,
    chunked: true,
    skinFileIds: [],
    physFileId: null,
  };

  if (bytes.length < CHUNK_HEADER_BYTES) return result;

  const headerSize = bytes.readUInt32LE(4);
  let offset = CHUNK_HEADER_BYTES + headerSize;
  if (offset > bytes.length) return result;

  const skins = new Set();
  let chunks = 0;

  while (offset + CHUNK_HEADER_BYTES <= bytes.length && chunks < MAX_CHUNKS) {
    const tag = ascii(bytes, offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const dataStart = offset + CHUNK_HEADER_BYTES;

    if (dataStart + size > bytes.length) break;

    if (tag === 'SFID') {
      for (const id of readIds(bytes, dataStart, size)) skins.add(id);
    } else if (tag === 'PFID' && size >= 4) {
      const id = bytes.readUInt32LE(dataStart);
      if (id > 0) result.physFileId = id;
    }

    offset = dataStart + size;
    chunks += 1;
  }

  result.skinFileIds = [...skins];
  return result;
}
