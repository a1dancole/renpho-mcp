import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

/**
 * Props are produced when the user signs in with their Renpho account on the
 * /authorize page, encrypted into the issued token by workers-oauth-provider,
 * and handed back to the MCP agent on every authenticated request via
 * `this.props`.
 *
 * Renpho has no OAuth / refresh-token mechanism: its session tokens expire
 * after a few hours and the only way to get a new one is to log in again. So
 * the credentials themselves must travel with the grant. They are encrypted
 * at rest by the OAuth provider (the key is derived from the token Claude
 * holds, so the KV contents alone cannot be decrypted).
 */
export type Props = {
  /** Renpho account email (lower-cased). */
  email: string;
  /** Renpho account password — see note above. */
  password: string;
  /** Renpho account id (as a string; ids exceed 2^53). */
  userId: string;
  /** SHA-256 of the email; namespaces every cache key so users never collide. */
  userHash: string;
};

/** Worker bindings. Mirrors wrangler.jsonc; `wrangler types` regenerates this. */
export interface Env {
  OAUTH_KV: KVNamespace;
  /** Sealed Renpho session tokens + measurement pages. */
  RENPHO_CACHE: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  MCP_OBJECT: DurableObjectNamespace;
  /** Secret used to AES-GCM seal everything written to RENPHO_CACHE. */
  SESSION_ENCRYPTION_KEY: string;
  /** IANA tz used to resolve "today" and to stamp measurements with local time. */
  TIME_ZONE: string;
  /** Optional comma-separated allow-list of Renpho emails permitted to connect. */
  ALLOWED_EMAILS: string;
}
