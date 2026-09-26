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

  it('should fail fast in production if COTURN_SECRET is default, short, or contains change_me', () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://vigilone:secret@localhost:5432/vigilone_db';
    process.env.JWT_SECRET = 'secure_production_secret_key_32_bytes_long!!';
    process.env.SETUP_TOKEN = 'secure_production_setup_token_98231_long!!';
    process.env.INTERNAL_API_SECRET = 'secure_production_internal_secret_32bytes_long!!';
    process.env.COTURN_SECRET = 'change_me_insecure_coturn_default';

    expect(() => loadConfig()).toThrow(/FATAL: Production mode detected with default, short \(<32 chars\), or insecure COTURN_SECRET/);
  });

  it('should fail fast in production if JWT_SECRET contains uppercase CHANGE_ME from .env.example', () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://vigilone:secret@localhost:5432/vigilone_db';
    process.env.JWT_SECRET = 'CHANGE_ME_GENERATE_RANDOM_JWT_SECRET_32_CHARS_MIN';
    process.env.SETUP_TOKEN = 'real_setup_token_98231';
    process.env.INTERNAL_API_SECRET = 'secure_production_internal_secret_32bytes_long!!';

    expect(() => loadConfig()).toThrow(/FATAL: Production mode detected with default or insecure JWT_SECRET/);
  });

  const strongProdEnv = () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://vigilone:secret@localhost:5432/vigilone_db';
    process.env.JWT_SECRET = 'secure_production_secret_key_32_bytes_long!!';
    process.env.SETUP_TOKEN = '3f9a1c0e8b7d6a5f4e3d2c1b0a998877';
    process.env.INTERNAL_API_SECRET = 'secure_production_internal_secret_32bytes_long!!';
    process.env.COTURN_SECRET = 'secure_production_coturn_secret_32_bytes_long!!';
    process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  };

  it('accepts a fully generated production configuration', () => {
    strongProdEnv();
    const cfg = loadConfig();
    expect(cfg.SETUP_TOKEN).toBe('3f9a1c0e8b7d6a5f4e3d2c1b0a998877');
  });

  it('fails fast in production when SETUP_TOKEN is missing (no public default exists)', () => {
    strongProdEnv();
    delete process.env.SETUP_TOKEN;
    expect(() => loadConfig()).toThrow(/insecure SETUP_TOKEN/);
  });

  it('fails fast in production when SETUP_TOKEN is the retired public default', () => {
    strongProdEnv();
    process.env.SETUP_TOKEN = 'vigilone_dev_setup_token_99182';
    expect(() => loadConfig()).toThrow(/insecure SETUP_TOKEN/);
  });

  it('fails fast in production when SETUP_TOKEN is shorter than 16 characters', () => {
    strongProdEnv();
    process.env.SETUP_TOKEN = 'short_tok';
    expect(() => loadConfig()).toThrow(/insecure SETUP_TOKEN/);
  });

  it('fails fast in production with the publicly known development encryption key', () => {
    strongProdEnv();
    process.env.CREDENTIAL_ENCRYPTION_KEY = 'eGlhOHBqa2w4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=';
    expect(() => loadConfig()).toThrow(/publicly known development CREDENTIAL_ENCRYPTION_KEY/);
  });

  it('in development never falls back to the retired default setup token', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.SETUP_TOKEN;
    const a = loadConfig().SETUP_TOKEN;
    process.env.SETUP_TOKEN = 'vigilone_dev_setup_token_99182';
    const b = loadConfig().SETUP_TOKEN;
    expect(a).not.toBe('vigilone_dev_setup_token_99182');
    expect(b).not.toBe('vigilone_dev_setup_token_99182');
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});
