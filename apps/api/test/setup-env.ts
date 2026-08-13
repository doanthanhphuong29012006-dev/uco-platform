import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

jest.setTimeout(30000);

const envPath = resolve(__dirname, '../../..', '.env.test');

if (existsSync(envPath)) {
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

process.env.NODE_ENV = 'test';
// E2E tests use seeded mock accounts, including ADMIN. Never inherit DEMO_MODE
// from the developer environment because demo mode intentionally blocks mock Admin login.
process.env.DEMO_MODE = 'false';
