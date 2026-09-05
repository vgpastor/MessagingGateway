// Fix Orval-generated imports to include .js extension (required for ESM/NodeNext)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const file = resolve(here, '../packages/sdk/src/generated/api.ts');
const content = readFileSync(file, 'utf8');
writeFileSync(file, content.replace(/from '\.\.\/fetch-mutator'/g, "from '../fetch-mutator.js'"));
