import assert from 'node:assert/strict';
import test from 'node:test';
import { parseIdList } from '../src/ids.js';
import { ConfigError } from '../src/errors.js';

test('lê listas, intervalos, comentários e remove duplicatas', () => {
  assert.deepEqual(
    parseIdList('137698, 1000-1002\n# comentário\n5 1000\n'),
    [137698, 1000, 1001, 1002, 5],
  );
});

test('aceita array', () => {
  assert.deepEqual(parseIdList(['1', 2, '2', 3]), [1, 2, 3]);
});

test('rejeita intervalo invertido', () => {
  assert.throws(() => parseIdList('10-5'), ConfigError);
});

test('rejeita intervalo grande demais', () => {
  assert.throws(() => parseIdList('1-10001'), ConfigError);
});

test('rejeita IDs inválidos', () => {
  assert.throws(() => parseIdList('abc'), ConfigError);
  assert.throws(() => parseIdList('0'), ConfigError);
  assert.throws(() => parseIdList('-1'), ConfigError);
});
