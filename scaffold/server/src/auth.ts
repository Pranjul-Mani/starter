import { createHash, randomBytes } from 'node:crypto';
import { Router, type CookieOptions } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from './config.ts';
import { getDb } from './db.ts';
import { field, route } from './http.ts';

type Membership = { id: string; role: 'admin' | 'agent' };
type Session = {
  _id: string;
  sub: string;
  name: string;
  workspaces: Membership[];
  expiresAt: Date;
};
type LoginAttempt = { _id: string; state: string; verifier: string; nonce: string; expiresAt: Date };

const sessionCookie = 'switchboard_session';
const loginCookie = 'switchboard_login';
const loginLifetime = 10 * 60 * 1000;
const token = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('base64url');
const issuer = config.oidc.issuer;
const cookieOptions: CookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: new URL(config.oidc.redirectUri).protocol === 'https:',
  path: '/',
};

async function authCollections() {
  const db = await getDb();
  return {
    sessions: db.collection<Session>('sessions'),
    attempts: db.collection<LoginAttempt>('login_attempts'),
  };
}

export async function initializeAuth() {
  const { sessions, attempts } = await authCollections();
  await Promise.all([
    sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    attempts.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]);
}

function cookieValue(header: string | undefined, name: string) {
  const value = header?.split(';').map(part => part.trim()).find(part => part.startsWith(name + '='))?.slice(name.length + 1);
  return value && /^[\w-]{43}$/.test(value) ? value : undefined;
}

export async function getSession(header: string | undefined) {
  const value = cookieValue(header, sessionCookie);
  if (!value) return null;
  const { sessions } = await authCollections();
  return sessions.findOne({ _id: hash(value), expiresAt: { $gt: new Date() } });
}

export function allowedOrigin(origin: string | undefined) {
  return !origin || origin === new URL(config.webOrigin).origin || origin === new URL(config.oidc.redirectUri).origin;
}

async function discovery() {
  const response = await fetch(issuer.replace(/\/$/, '') + '/.well-known/openid-configuration', {
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('Identity provider discovery failed');
  const metadata = await response.json();
  if (metadata.issuer !== issuer) throw new Error('Identity provider issuer mismatch');
  return {
    authorize: new URL(metadata.authorization_endpoint),
    exchange: new URL(metadata.token_endpoint),
    jwks: new URL(metadata.jwks_uri),
  };
}

function isMembership(value: unknown): value is Membership {
  if (!value || typeof value !== 'object') return false;
  const { id, role } = value as Record<string, unknown>;
  return field(id) && (role === 'admin' || role === 'agent');
}

export const auth = Router();
auth.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

auth.get('/login', route(async (_req, res) => {
  const { authorize } = await discovery();
  const browserToken = token();
  const attempt = {
    _id: hash(browserToken), state: token(), verifier: token(), nonce: token(),
    expiresAt: new Date(Date.now() + loginLifetime),
  };
  const { attempts } = await authCollections();
  await attempts.insertOne(attempt);
  authorize.search = new URLSearchParams({
    client_id: config.oidc.clientId,
    redirect_uri: config.oidc.redirectUri,
    response_type: 'code',
    scope: 'openid profile',
    state: attempt.state,
    nonce: attempt.nonce,
    code_challenge: hash(attempt.verifier),
    code_challenge_method: 'S256',
  }).toString();
  res.cookie(loginCookie, browserToken, { ...cookieOptions, maxAge: loginLifetime });
  res.redirect(authorize.href);
}));

auth.get('/callback', route(async (req, res) => {
  const { code, state } = req.query;
  const browserToken = cookieValue(req.headers.cookie, loginCookie);
  if (!browserToken || !field(code) || !field(state)) {
    res.sendStatus(400);
    return;
  }
  const { attempts, sessions } = await authCollections();
  const attempt = await attempts.findOneAndDelete({
    _id: hash(browserToken), state, expiresAt: { $gt: new Date() },
  });
  if (!attempt) {
    res.sendStatus(400);
    return;
  }
  res.clearCookie(loginCookie, cookieOptions);

  const { exchange, jwks } = await discovery();
  let claims;
  try {
    const response = await fetch(exchange, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: config.oidc.clientId,
        client_secret: config.oidc.clientSecret,
        redirect_uri: config.oidc.redirectUri,
        code,
        code_verifier: attempt.verifier,
      }),
    });
    if (!response.ok) {
      res.sendStatus(401);
      return;
    }
    const { id_token } = await response.json();
    ({ payload: claims } = await jwtVerify(id_token, createRemoteJWKSet(jwks, { timeoutDuration: 5000 }), {
      issuer, audience: config.oidc.clientId, algorithms: ['RS256'], requiredClaims: ['exp', 'sub', 'nonce'],
    }));
  } catch {
    res.sendStatus(401);
    return;
  }
  if (claims.nonce !== attempt.nonce || !field(claims.sub) || typeof claims.exp !== 'number'
    || !Array.isArray(claims.workspaces) || !claims.workspaces.every(isMembership)) {
    res.sendStatus(401);
    return;
  }

  const oldSession = cookieValue(req.headers.cookie, sessionCookie);
  if (oldSession) await sessions.deleteOne({ _id: hash(oldSession) });
  const sessionToken = token();
  const expiresAt = new Date(Math.min(claims.exp * 1000, Date.now() + 60 * 60 * 1000));
  await sessions.insertOne({
    _id: hash(sessionToken), sub: claims.sub,
    name: field(claims.name) ? claims.name : claims.sub,
    workspaces: claims.workspaces.map(({ id, role }) => ({ id, role })), expiresAt,
  });
  res.cookie(sessionCookie, sessionToken, { ...cookieOptions, expires: expiresAt });
  res.redirect(config.webOrigin);
}));

auth.post('/logout', route(async (req, res) => {
  if (!allowedOrigin(req.get('origin'))) {
    res.sendStatus(403);
    return;
  }
  const value = cookieValue(req.headers.cookie, sessionCookie);
  if (value) {
    const { sessions } = await authCollections();
    await sessions.deleteOne({ _id: hash(value) });
  }
  res.clearCookie(sessionCookie, cookieOptions);
  res.sendStatus(204);
}));
