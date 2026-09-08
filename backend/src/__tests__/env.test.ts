import { loadConfig } from '../config/env';

describe('Environment & Secrets Configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should load default development configuration successfully', () => {
    process.env.NODE_ENV = 'development';
    process.env.DATABASE_URL = 'postgresql://vigilone:secret@localhost:5432/vigilone_db';
    process.env.JWT_SECRET = 'a'.repeat(32);

    const cfg = loadConfig();
    expect(cfg.NODE_ENV).toBe('development');
    expect(cfg.PORT).toBe(4000);
    expect(cfg.CREDENTIAL_ENCRYPTION_KEY).toBeDefined();
  });

  it('should fail fast in production if JWT_SECRET is default or contains change_me', () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://vigilone:secret@localhost:5432/vigilone_db';
    process.env.JWT_SECRET = 'change_me_in_prod_123456789012345';
    process.env.SETUP_TOKEN = 'real_setup_token_98231';
    process.env.INTERNAL_API_SECRET = 'secure_production_internal_secret_32bytes_long!!';

    expect(() => loadConfig()).toThrow(/FATAL: Production mode detected with default or insecure JWT_SECRET/);
  });

  it('should fail fast in production if SETUP_TOKEN is default or contains change_me', () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://vigilone:secret@localhost:5432/vigilone_db';
    process.env.JWT_SECRET = 'secure_production_secret_key_32_bytes_long!!';
    process.env.SETUP_TOKEN = 'change_me_internal_secret';
    process.env.INTERNAL_API_SECRET = 'secure_production_internal_secret_32bytes_long!!';

    expect(() => loadConfig()).toThrow(/FATAL: Production mode detected with default or insecure SETUP_TOKEN/);
  });

  it('should fail fast in production if INTERNAL_API_SECRET is default, short, or contains change_me', () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://vigilone:secret@localhost:5432/vigilone_db';
    process.env.JWT_SECRET = 'secure_production_secret_key_32_bytes_long!!';
    process.env.SETUP_TOKEN = 'secure_production_setup_token_98231_long!!';
    process.env.INTERNAL_API_SECRET = 'change_me_insecure_default';

    expect(() => loadConfig()).toThrow(/FATAL: Production mode detected with default, short \(<32 chars\), or insecure INTERNAL_API_SECRET/);
  });
});
