// Fix Orval-generated imports to include .js extension (required for ESM/NodeNext)
const fs = require('fs');
const path = require('path');
const file = path.resolve(__dirname, '../packages/sdk/src/generated/api.ts');
const content = fs.readFileSync(file, 'utf8');
fs.writeFileSync(file, content.replace(/from '\.\.\/fetch-mutator'/g, "from '../fetch-mutator.js'"));
