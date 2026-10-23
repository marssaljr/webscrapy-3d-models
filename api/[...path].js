import path from 'node:path';
import { createApp } from '../src/server.js';
import { createLogger } from '../src/logger.js';

const handler = createApp({
  outDir: path.join(process.cwd(), 'data'),
  readOnly: true,
  logger: createLogger({ level: 'error' }),
});

export default handler;
