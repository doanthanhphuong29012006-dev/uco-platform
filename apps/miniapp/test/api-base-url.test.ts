import assert from 'node:assert/strict';
import test from 'node:test';
import { PRODUCTION_API_BASE_URL, resolveApiBaseUrl } from '../src/lib/api-base-url';

test('uses the local API proxy during development', () => {
  assert.equal(resolveApiBaseUrl('development'), '/api/v1');
});

test('uses Render API by default for production', () => {
  assert.equal(resolveApiBaseUrl('production'), PRODUCTION_API_BASE_URL);
  assert.equal(resolveApiBaseUrl('production', PRODUCTION_API_BASE_URL), PRODUCTION_API_BASE_URL);
});

test('rejects unsafe production API base URLs', () => {
  for (const value of ['/api/v1', 'http://localhost:3000/api/v1', 'https://demo.example.com/api/v1', 'https://eco-oil-api.onrender.com']) {
    assert.throws(() => resolveApiBaseUrl('production', value));
  }
});
