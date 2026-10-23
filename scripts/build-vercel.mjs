import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const source = path.join(root, 'data');
const target = path.join(root, 'public', 'data');

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });

try {
  await cp(source, target, { recursive: true, force: true });
  console.log('Dados copiados para public/data.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  console.log('Sem dados locais; public/data vazio.');
}
