import { createCorsOptions } from './main';

describe('API CORS configuration', () => {
  it('allows credentialed Admin-origin PUT feedback preflight without wildcard origin', () => {
    const options = createCorsOptions(['https://eco-oil-admin.vercel.app']);

    expect(options.methods).toContain('PUT');
    expect(options.methods).toContain('OPTIONS');
    expect(options.origin).toEqual(['https://eco-oil-admin.vercel.app']);
    expect(options.credentials).toBe(true);
    expect(options.origin).not.toContain('*');
  });
});
