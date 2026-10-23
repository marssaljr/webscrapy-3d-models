const COLORS = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  cyan: '\u001b[36m',
};

const LEVEL_ORDER = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 99,
};

function paint(enabled, color, text) {
  return enabled ? `${COLORS[color]}${text}${COLORS.reset}` : text;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 100 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

export function createLogger(options = {}) {
  const level = options.level ?? 'info';
  const color = options.color ?? Boolean(process.stdout.isTTY);
  const json = options.json ?? false;
  const threshold = LEVEL_ORDER[level] ?? LEVEL_ORDER.info;
  const stream = options.stream ?? process.stdout;

  function write(entry) {
    if (json) {
      stream.write(`${JSON.stringify(entry)}\n`);
      return;
    }

    const { time, level: entryLevel, message, meta } = entry;
    const label = {
      debug: paint(color, 'dim', 'debug'),
      info: paint(color, 'cyan', 'info'),
      warn: paint(color, 'yellow', 'warn'),
      error: paint(color, 'red', 'error'),
    }[entryLevel];

    const suffix = meta && Object.keys(meta).length > 0 ? ` ${paint(color, 'dim', JSON.stringify(meta))}` : '';
    stream.write(`${paint(color, 'dim', time)} ${label} ${message}${suffix}\n`);
  }

  function log(entryLevel, message, meta) {
    const numeric = LEVEL_ORDER[entryLevel] ?? LEVEL_ORDER.info;
    if (numeric < threshold) return;

    write({
      time: new Date().toISOString(),
      level: entryLevel,
      message,
      ...(meta && Object.keys(meta).length > 0 ? { meta } : {}),
    });
  }

  return {
    level,
    debug: (message, meta) => log('debug', message, meta),
    info: (message, meta) => log('info', message, meta),
    warn: (message, meta) => log('warn', message, meta),
    error: (message, meta) => log('error', message, meta),
    success: (message, meta) => {
      if (json) {
        log('info', message, meta);
        return;
      }
      if (LEVEL_ORDER.info < threshold) return;
      write({
        time: new Date().toISOString(),
        level: 'info',
        message: `${paint(color, 'green', '✓')} ${message}`,
        ...(meta && Object.keys(meta).length > 0 ? { meta } : {}),
      });
    },
  };
}

export const silentLogger = createLogger({ level: 'silent', color: false });
