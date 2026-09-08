import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

jest.setTimeout(30000);

const envPath = resolve(__dirname, '../../..', '.env.test');

if (!existsSync(envPath)) {
  throw new Error('Refusing API tests: .env.test is required; no inherited database URL is allowed.');
}

{
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const separator = trimmed.indexOf('=');
    if (separator < 1) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    // Tests must never inherit the developer database URL. This file is loaded by Jest before app modules.
    process.env[key] = value;
  }
}

const testDatabaseUrl = process.env.DATABASE_URL?.trim();
if (!testDatabaseUrl) throw new Error('Refusing API tests: DATABASE_URL is missing from .env.test.');
let parsedDatabaseUrl: URL;
try { parsedDatabaseUrl = new URL(testDatabaseUrl); } catch { throw new Error('Refusing API tests: DATABASE_URL is invalid.'); }
if (
  parsedDatabaseUrl.protocol !== 'postgresql:' && parsedDatabaseUrl.protocol !== 'postgres:'
  || parsedDatabaseUrl.hostname !== 'localhost'
  || parsedDatabaseUrl.port !== '5433'
  || parsedDatabaseUrl.pathname !== '/uco_test'
) {
  throw new Error('Refusing API tests: DATABASE_URL must be localhost:5433/uco_test from .env.test.');
}
process.env.DATABASE_URL = testDatabaseUrl;

process.env.NODE_ENV = 'test';
const runningE2e = process.argv.some((argument) => /(?:^|[\\/])[^\\/]*\.e2e-spec\.ts$/.test(argument) || (argument.startsWith('--testRegex') && argument.includes('e2e-spec')));
if (runningE2e && process.env.E2E_TEST_DATABASE_CONFIRMED !== '1') {
  throw new Error('Refusing API E2E: set E2E_TEST_DATABASE_CONFIRMED=1 only after verifying an isolated test database.');
}
// E2E tests use seeded mock accounts, including ADMIN. Never inherit DEMO_MODE
// from the developer environment because demo mode intentionally blocks mock Admin login.
process.env.DEMO_MODE = 'false';
