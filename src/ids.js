import { ConfigError } from './errors.js';
import { parseId } from './urls.js';

const RANGE_LIMIT = 10_000;

export function parseIdList(input, label = 'lista de IDs') {
  if (Array.isArray(input)) {
    return uniqueIds(input.map((value) => parseId(value, label)));
  }

  const text = String(input ?? '');
  const ids = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;

    for (const token of line.split(/[\s,;]+/)) {
      if (!token) continue;

      const range = /^(\d+)\s*-\s*(\d+)$/.exec(token);
      if (range) {
        const start = parseId(range[1], label);
        const end = parseId(range[2], label);
        if (end < start) {
          throw new ConfigError(`Intervalo invertido na ${label}: ${token}`);
        }
        if (end - start + 1 > RANGE_LIMIT) {
          throw new ConfigError(
            `Intervalo muito grande na ${label}: ${token} (máximo ${RANGE_LIMIT})`,
          );
        }
        for (let id = start; id <= end; id += 1) ids.push(id);
        continue;
      }

      ids.push(parseId(token, label));
    }
  }

  return uniqueIds(ids);
}

export function uniqueIds(ids) {
  return [...new Set(ids)];
}
