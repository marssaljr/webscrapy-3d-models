import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildUrls,
  normalizeBaseUrl,
  normalizeExpansion,
  normalizeKind,
  parseId,
  wowheadPageUrl,
} from '../src/urls.js';
import { ConfigError } from '../src/errors.js';

test('monta exatamente as URLs do Model Viewer', () => {
  const urls = buildUrls({
    baseUrl: 'https://wow.zamimg.com/modelviewer',
    expansion: 'mists',
    kind: 'npc',
    id: 137698,
    modelId: 6984000,
    textureId: 7262705,
  });

  assert.equal(
    urls.meta,
    'https://wow.zamimg.com/modelviewer/mists/meta/npc/137698.json',
  );
  assert.equal(
    urls.model,
    'https://wow.zamimg.com/modelviewer/mists/m2/6984000.m2',
  );
  assert.equal(
    urls.texture,
    'https://wow.zamimg.com/modelviewer/mists/textures/7262705.webp',
  );
});

test('normaliza aliases', () => {
  assert.equal(normalizeExpansion('mop'), 'mists');
  assert.equal(normalizeExpansion('SL'), 'shadowlands');
  assert.equal(normalizeKind('creature'), 'npc');
  assert.equal(normalizeKind('itemdisplay'), 'item');
});

test('normaliza a URL base', () => {
  assert.equal(normalizeBaseUrl('https://example.com/modelviewer/'), 'https://example.com/modelviewer');
  assert.throws(() => normalizeBaseUrl('ftp://example.com'), ConfigError);
  assert.throws(() => normalizeBaseUrl('not a url'), ConfigError);
});

test('valida IDs', () => {
  assert.equal(parseId('137698'), 137698);
  assert.throws(() => parseId('0'), ConfigError);
  assert.throws(() => parseId('1.5'), ConfigError);
  assert.throws(() => parseId('abc'), ConfigError);
});

test('gera página do Wowhead', () => {
  assert.equal(wowheadPageUrl('npc', 137698), 'https://www.wowhead.com/npc=137698');
  assert.equal(wowheadPageUrl('item', 19019), 'https://www.wowhead.com/item=19019');
});
