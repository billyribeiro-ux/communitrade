export { billingEntitlementScope, billingEntitlementPredicate } from './billing-entitlements.js';
export {emailSuppressionDigest} from './email.js';
export {assertProductionRuntime,isProductionRuntime} from './production.js';
export { ingressBodyDigest, ingressSigningValue, signIngress, verifyIngressSignature, type IngressPrincipal, type IngressSignatureInput } from './ingress.js';

export interface AppConfig {
  readonly port: number;
  readonly databaseUrl: string;
}

export class AppConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppConfigError";
  }
}

/** Parse the small set of settings needed to start a backend process. */
export function parseAppConfig(env: Readonly<Record<string, string | undefined>>): AppConfig {
  const portValue = env.PORT;
  const port = portValue === undefined || portValue.trim() === "" ? 3001 : Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new AppConfigError("PORT must be an integer between 1 and 65535.");
  }

  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new AppConfigError("DATABASE_URL is required.");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(databaseUrl);
  } catch {
    throw new AppConfigError("DATABASE_URL must be a valid PostgreSQL connection URL.");
  }
  if (!["postgres:", "postgresql:"].includes(parsedUrl.protocol) || !parsedUrl.hostname) {
    throw new AppConfigError("DATABASE_URL must be a valid PostgreSQL connection URL.");
  }

  return Object.freeze({ port, databaseUrl });
}
