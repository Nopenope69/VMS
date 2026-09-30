#!/usr/bin/env node
/**
 * Test-only OpenID Connect provider for the SSO tests: oidc-provider (an independent, certified implementation
 * of the protocol) with in-memory accounts. Never shipped.
 *
 *   node tools/sim/oidc/server.mjs --port 4455 --config '<json>'
 *
 * config: { clients: [{ client_id, client_secret, redirect_uris }],
 *           accounts: { <login>: { email, email_verified, name, groups } } }
 *
 * Login goes through oidc-provider's development interaction form: POST /interaction/<uid> with
 * prompt=login&login=<account>&password=<anything>. Consent is granted automatically for the requested scopes.
 * Prints "oidc provider listening on <issuer>" when ready.
 */
import Provider from 'oidc-provider';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const port = Number(arg('port') || 4455);
const cfg = JSON.parse(arg('config') || '{}');
const issuer = `http://127.0.0.1:${port}`;
const accounts = cfg.accounts || {};

const provider = new Provider(issuer, {
  clients: (cfg.clients || []).map((c) => ({
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'client_secret_basic',
    ...c,
  })),
  claims: { openid: ['sub'], email: ['email', 'email_verified'], profile: ['name'], groups: ['groups'] },
  scopes: ['openid', 'email', 'profile', 'groups'],
  pkce: { required: () => true },
  features: { devInteractions: { enabled: true } },
  async findAccount(_ctx, sub) {
    const a = accounts[sub];
    if (!a) return undefined;
    return { accountId: sub, claims: async () => ({ sub, ...a }) };
  },
  async loadExistingGrant(ctx) {
    const grant = new ctx.oidc.provider.Grant({ clientId: ctx.oidc.client.clientId, accountId: ctx.oidc.session.accountId });
    grant.addOIDCScope(ctx.oidc.params.scope || 'openid');
    grant.addOIDCClaims(['sub', 'email', 'email_verified', 'name', 'groups']);
    await grant.save();
    return grant;
  },
});
provider.on('server_error', (_ctx, err) => console.error('server_error', err));

provider.listen(port, '127.0.0.1', () => console.log(`oidc provider listening on ${issuer}`));
