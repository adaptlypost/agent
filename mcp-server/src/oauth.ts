import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from 'jose';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface OauthConfig {
  authkitDomain: string;
  resourceUrl: string;
  resourceName: string;
  oauthRequired: boolean;
}

export function oauthConfigFromEnv(defaults: {
  resourceUrl: string;
  resourceName: string;
}): OauthConfig {
  return {
    authkitDomain: (process.env.WORKOS_AUTHKIT_DOMAIN ?? '').replace(/\/$/, ''),
    resourceUrl: process.env.MCP_RESOURCE_URL ?? defaults.resourceUrl,
    resourceName: defaults.resourceName,
    oauthRequired: process.env.MCP_OAUTH_REQUIRED === 'true',
  };
}

const metadataPaths = new Set([
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
]);

export function handleProtectedResourceMetadata(
  config: OauthConfig,
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const path = (req.url ?? '').split('?')[0];
  if (!metadataPaths.has(path)) return false;

  if (!config.authkitDomain) {
    res.writeHead(404);
    res.end('Not found');
    return true;
  }

  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(
    JSON.stringify({
      resource: config.resourceUrl,
      authorization_servers: [config.authkitDomain],
      bearer_methods_supported: ['header'],
      resource_name: config.resourceName,
    }),
  );
  return true;
}

export function sendUnauthorized(
  config: OauthConfig,
  res: ServerResponse,
  description: string,
) {
  const metadataUrl = `${new URL(config.resourceUrl).origin}/.well-known/oauth-protected-resource/mcp`;
  res.writeHead(401, {
    'Content-Type': 'application/json',
    'WWW-Authenticate': `Bearer resource_metadata="${metadataUrl}", error="invalid_token", error_description="${description}"`,
  });
  res.end(JSON.stringify({ error: 'invalid_token', error_description: description }));
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksIssuer: string | null = null;

async function getJwks(config: OauthConfig) {
  if (jwks) return { jwks, issuer: jwksIssuer };

  const metadataRes = await fetch(
    `${config.authkitDomain}/.well-known/oauth-authorization-server`,
  );
  if (!metadataRes.ok) {
    throw new Error(
      `Failed to load authorization server metadata: ${metadataRes.status}`,
    );
  }
  const metadata = (await metadataRes.json()) as {
    issuer?: string;
    jwks_uri?: string;
  };
  if (!metadata.jwks_uri) {
    throw new Error('Authorization server metadata is missing jwks_uri');
  }

  jwks = createRemoteJWKSet(new URL(metadata.jwks_uri));
  jwksIssuer = metadata.issuer ?? config.authkitDomain;
  return { jwks, issuer: jwksIssuer };
}

export function looksLikeJwt(token: string): boolean {
  return token.split('.').length === 3;
}

export async function verifyOauthJwt(
  config: OauthConfig,
  token: string,
): Promise<{ valid: true } | { valid: false; error: string }> {
  if (!config.authkitDomain) {
    return { valid: false, error: 'OAuth is not configured on this server' };
  }
  try {
    const { jwks: keySet, issuer } = await getJwks(config);
    await jwtVerify(token, keySet!, issuer ? { issuer } : undefined);
    return { valid: true };
  } catch (error) {
    if (error instanceof joseErrors.JWTExpired) {
      return { valid: false, error: 'Access token has expired' };
    }
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Invalid access token',
    };
  }
}
