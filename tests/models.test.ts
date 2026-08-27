import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { API_KEY_ENV, DEFAULT_BASE_URL, DEFAULT_MODEL, selectModel } from '../src/models.js';

describe('selectModel', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.ORQ_MODEL;
    delete process.env.ORQ_MODEL_BASE_URL;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('returns the built-in defaults when nothing is overridden', () => {
    expect(selectModel('engineer')).toEqual({
      model: DEFAULT_MODEL,
      baseUrl: DEFAULT_BASE_URL,
      apiKeyEnv: API_KEY_ENV,
    });
  });

  it('an explicit override wins over everything', () => {
    process.env.ORQ_MODEL = 'from-env/model';
    expect(selectModel('engineer', 'explicit/model').model).toBe('explicit/model');
  });

  it('falls back to ORQ_MODEL / ORQ_MODEL_BASE_URL env when no override is given', () => {
    process.env.ORQ_MODEL = 'from-env/model';
    process.env.ORQ_MODEL_BASE_URL = 'https://example.test/v1';
    const r = selectModel('reviewer');
    expect(r.model).toBe('from-env/model');
    expect(r.baseUrl).toBe('https://example.test/v1');
  });
});
