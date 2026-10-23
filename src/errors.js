export class AppError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = this.constructor.name;
    this.code = options.code ?? 'APP_ERROR';
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }
}

export class ConfigError extends AppError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code ?? 'CONFIG_ERROR' });
  }
}

export class ValidationError extends AppError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code ?? 'VALIDATION_ERROR' });
  }
}

export class HttpError extends AppError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code ?? 'HTTP_ERROR',
      retryable: options.retryable ?? false,
    });
    this.status = options.status;
    this.url = options.url;
  }
}

export class NotFoundError extends HttpError {
  constructor(url) {
    super(`Recurso não encontrado (404): ${url}`, {
      status: 404,
      url,
      code: 'NOT_FOUND',
      retryable: false,
    });
  }
}

export class DownloadValidationError extends AppError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code ?? 'DOWNLOAD_VALIDATION_ERROR',
    });
  }
}
