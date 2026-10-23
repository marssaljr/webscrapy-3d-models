import { HttpError, NotFoundError } from './errors.js';
import { retryAfterMs, sleep } from './utils.js';

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function isRetryableNetworkError(error) {
  if (!error) return false;
  const cause = error.cause ?? error;
  if (RETRYABLE_CODES.has(cause.code) || RETRYABLE_CODES.has(error.code)) {
    return true;
  }
  return cause.name === 'TimeoutError' || error.name === 'TimeoutError';
}

function backoffMs(base, attempt) {
  const exponential = base * 2 ** Math.max(0, attempt - 1);
  const jitter = Math.random() * base * 0.5;
  return Math.min(30_000, exponential + jitter);
}

export class HttpClient {
  constructor(options = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.retries = options.retries ?? 3;
    this.retryBaseMs = options.retryBaseMs ?? 600;
    this.minIntervalMs = options.minIntervalMs ?? 80;
    this.userAgent = options.userAgent ?? 'wow-model-scraper/1.0';
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.logger = options.logger ?? null;
    this.nextRequestAt = 0;
  }

  async #throttle(signal) {
    const now = Date.now();
    const waitMs = Math.max(0, this.nextRequestAt - now);
    this.nextRequestAt = Math.max(now, this.nextRequestAt) + this.minIntervalMs;
    if (waitMs > 0) await sleep(waitMs, signal);
  }

  async request(url, options = {}) {
    let lastError = null;

    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      await this.#throttle(options.signal);

      const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
      const signal = options.signal
        ? AbortSignal.any([options.signal, timeoutSignal])
        : timeoutSignal;

      try {
        const response = await this.fetchImpl(url, {
          method: options.method ?? 'GET',
          headers: {
            'user-agent': this.userAgent,
            accept: options.accept ?? '*/*',
            ...options.headers,
          },
          signal,
          redirect: 'follow',
        });

        if (response.ok) return response;

        if (response.status === 404) {
          await response.body?.cancel?.();
          throw new NotFoundError(url);
        }

        const error = new HttpError(
          `HTTP ${response.status} em ${url}`,
          {
            status: response.status,
            url,
            retryable: RETRYABLE_STATUS.has(response.status),
          },
        );

        if (!error.retryable || attempt === this.retries) {
          await response.body?.cancel?.();
          throw error;
        }

        const retryAfter = retryAfterMs(response.headers);
        const waitMs = retryAfter ?? backoffMs(this.retryBaseMs, attempt + 1);
        this.logger?.warn(`HTTP ${response.status}; tentando novamente em ${Math.round(waitMs)}ms`, {
          url,
          attempt: attempt + 1,
        });
        await response.body?.cancel?.();
        await sleep(waitMs, options.signal);
      } catch (error) {
        if (error instanceof NotFoundError) throw error;
        if (error instanceof HttpError && !error.retryable) throw error;
        if (options.signal?.aborted) throw options.signal.reason ?? error;

        lastError = error;
        const retryable =
          error instanceof HttpError ? error.retryable : isRetryableNetworkError(error);

        if (!retryable || attempt === this.retries) {
          if (error instanceof HttpError) throw error;
          throw new HttpError(`Falha de rede em ${url}: ${error.message}`, {
            url,
            retryable: false,
            cause: error,
          });
        }

        const waitMs = backoffMs(this.retryBaseMs, attempt + 1);
        this.logger?.warn(`Falha de rede; tentando novamente em ${Math.round(waitMs)}ms`, {
          url,
          attempt: attempt + 1,
          error: error.message,
        });
        await sleep(waitMs, options.signal);
      }
    }

    throw lastError ?? new HttpError(`Falha ao baixar ${url}`, { url });
  }

  async json(url, options = {}) {
    const response = await this.request(url, {
      ...options,
      accept: 'application/json, text/plain, */*',
    });

    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new HttpError(`Resposta não é JSON válido: ${url}`, {
        url,
        retryable: false,
        cause: error,
      });
    }
  }
}
