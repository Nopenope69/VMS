-- Phase 8: working OIDC single sign-on.
-- Before this migration the client secret was stored in plaintext in "clientSecretEncrypted" (and returned by the
-- API). Such rows are blanked and disabled here; an administrator must enter the secret again, which now stores it
-- encrypted.
-- AlterTable
ALTER TABLE "IdentityProvider" ADD COLUMN     "allowedEmailDomains" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "autoProvision" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "defaultRole" "Role" NOT NULL DEFAULT 'VIEWER',
ADD COLUMN     "roleClaim" TEXT,
ADD COLUMN     "roleMappingJson" JSONB;

-- CreateTable
CREATE TABLE "ExternalIdentity" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OidcLoginState" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "codeVerifier" TEXT,
    "nonce" TEXT,
    "userId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OidcLoginState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExternalIdentity_userId_idx" ON "ExternalIdentity"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalIdentity_providerId_subject_key" ON "ExternalIdentity"("providerId", "subject");

-- CreateIndex
CREATE INDEX "OidcLoginState_expiresAt_idx" ON "OidcLoginState"("expiresAt");

-- AddForeignKey
ALTER TABLE "ExternalIdentity" ADD CONSTRAINT "ExternalIdentity_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalIdentity" ADD CONSTRAINT "ExternalIdentity_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "IdentityProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalIdentity" ADD CONSTRAINT "ExternalIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OidcLoginState" ADD CONSTRAINT "OidcLoginState_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "IdentityProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Existing plaintext secrets are not kept.
UPDATE "IdentityProvider" SET "clientSecretEncrypted" = '', "enabled" = false;

ALTER TABLE "IdentityProvider" ADD CONSTRAINT "IdentityProvider_defaultRole_check" CHECK ("defaultRole" <> 'SUPER_ADMIN');
ALTER TABLE "OidcLoginState" ADD CONSTRAINT "OidcLoginState_kind_check" CHECK ("kind" IN ('AUTHORIZE', 'LOGIN_CODE'));
