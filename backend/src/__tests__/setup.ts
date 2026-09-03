process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://vigilone:vigilone_dev_secret_2026@localhost:5432/vigilone_db?schema=public';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'vigilone_dev_jwt_signing_key_32bytes_min!';
process.env.INTERNAL_API_SECRET =
  process.env.INTERNAL_API_SECRET || 'vigilone_internal_secret_token_98234';
process.env.NODE_ENV = 'test';
