import assert from 'node:assert/strict';
import test from 'node:test';
import { parseM2FileIds } from '../src/m2.js';
import { ValidationError } from '../src/errors.js';
import { chunkedM2, m2Bytes } from './helpers.js';

test('extrai skins e física dos chunks do M2', () => {
  const info = parseM2FileIds(chunkedM2({ skinIds: [6984033, 6984034], physId: 900 }));

  assert.equal(info.magic, 'MD21');
  assert.equal(info.chunked, true);
  assert.deepEqual(info.skinFileIds, [6984033, 6984034]);
  assert.equal(info.physFileId, 900);
});

test('M2 sem chunks SFID/PFID não inventa referências', () => {
  const info = parseM2FileIds(m2Bytes());

  assert.deepEqual(info.skinFileIds, []);
  assert.equal(info.physFileId, null);
});

test('M2 legado MD20 não tem IDs de skin externos', () => {
  const info = parseM2FileIds(Buffer.concat([Buffer.from('MD20'), Buffer.alloc(20)]));

  assert.equal(info.chunked, false);
  assert.deepEqual(info.skinFileIds, []);
});

test('rejeita magic inválido', () => {
  assert.throws(() => parseM2FileIds(Buffer.from('nope')), ValidationError);
});
