import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeMeta } from '../src/meta.js';
import { ValidationError } from '../src/errors.js';

const userMeta = {
  Model: 6984000,
  Textures: {
    11: 7262697,
    5: 7262705,
    12: 7262709,
    13: 7262701,
  },
  Textures2: null,
  TextureFiles: null,
  ModelFiles: null,
  Item: null,
  Creature: {
    CreatureGeosetData: [{ GeosetIndex: 0, GeosetValue: 1 }],
    CreatureGeosetDataID: 974,
    CreatureModelAlpha: 255,
    Texture: 0,
    CreatureCustomizations: null,
    ParticleColor: null,
  },
  Character: null,
  ItemEffects: null,
  Equipment: null,
  ComponentTextures: null,
  ComponentModels: null,
  StateKits: null,
  Decor: null,
  Scale: 1,
};

test('extrai modelo e texturas do meta do usuário', () => {
  const analysis = analyzeMeta(userMeta);
  assert.equal(analysis.modelId, 6984000);
  assert.deepEqual(analysis.models.map((entry) => entry.id), [6984000]);
  assert.deepEqual(analysis.textures.map((entry) => entry.id), [7262705, 7262697, 7262709, 7262701]);
  assert.equal(analysis.textures.find((entry) => entry.id === 7262705).slot, '5');
  assert.equal(analysis.scale, 1);
});

test('não trata equipamento nem metadados como modelos', () => {
  const analysis = analyzeMeta({
    Model: 0,
    Textures: null,
    Textures2: null,
    TextureFiles: {
      212674: [{ FileDataId: 1106059, Gender: 3, Class: 0, Race: 0, ExtraData: 0 }],
    },
    ModelFiles: null,
    Item: null,
    Creature: { CreatureGeosetDataID: 974, Texture: 212674 },
    Character: { Race: 10, Gender: 1, ChrModelId: 20 },
    Equipment: { 5: 37730, 7: 36524, 8: 15450 },
    ComponentTextures: null,
    ComponentModels: null,
    StateKits: null,
    Decor: null,
    Scale: 1,
  });

  assert.deepEqual(analysis.models, []);
  assert.deepEqual(analysis.textures.map((entry) => entry.id), [1106059]);
  assert.equal(analysis.textures[0].slot, null);
  assert.equal(analysis.hasCharacter, true);
  assert.equal(analysis.hasEquipment, true);
});

test('extrai dependências aninhadas e ignora escalares de metadados', () => {
  const analysis = analyzeMeta({
    Model: 1,
    Textures: { 1: 5 },
    TextureFiles: {
      900: [
        { FileDataId: 6, Gender: 3, Race: 7, Class: 8 },
        { FileDataId: 6, Gender: 9 },
      ],
    },
    ComponentModels: [{ Model: 2, Textures: { 2: 10 } }],
    StateKits: [{ Model: 3, Textures: { 3: 11 } }],
  });

  assert.deepEqual(analysis.models.map((entry) => entry.id), [1, 2, 3]);
  assert.deepEqual(analysis.textures.map((entry) => entry.id), [5, 6, 10, 11]);
});

test('rejeita JSON que não é meta', () => {
  assert.throws(() => analyzeMeta(null), ValidationError);
  assert.throws(() => analyzeMeta([]), ValidationError);
  assert.throws(() => analyzeMeta({ foo: 'bar' }), ValidationError);
});
