import { billingView, canSend, changeSeats, subscribe, validCardToken, validSeats } from './billing.ts';
import { config } from './config.ts';
import { Router, json, type Request, type Response } from 'express';
import { allowedOrigin, getSession } from './auth.ts';
import { field, route } from './http.ts';
import { claimConversation, conversationDetail, knownWorkspace, listConversations, queueReply, setConversationState } from './inbox.ts';

export const api = Router();
api.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && !allowedOrigin(req.get('origin'))) {
    res.sendStatus(403);
    return;
  }
  next();
});

api.get('/me', route(async (req, res) => {
  const session = await getSession(req.headers.cookie);
  if (!session) {
    res.sendStatus(401);
    return;
  }
  res.json({ sub: session.sub, name: session.name, workspaces: session.workspaces });
}));

function workspaceRoute(handler: (req: Request, res: Response, workspace: string, agent: string) => Promise<void>, adminOnly = false) {
  return route(async (req, res) => {
    const session = await getSession(req.headers.cookie);
    if (!session) {
      res.sendStatus(401);
      return;
    }
    const workspace = req.query.workspace;
    const membership = session.workspaces.find(member => member.id === workspace);
    if (!knownWorkspace(workspace) || !membership || (adminOnly && membership.role !== 'admin')) {
      res.sendStatus(403);
      return;
    }
    await handler(req, res, workspace, session.sub);
  });
}

function parseCursor(value: unknown) {
  if (!field(value) || value.length > 1000) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(decoded) || !field(decoded[0]) || !field(decoded[1])) return null;
    const activity = new Date(decoded[0]);
    return Number.isFinite(activity.getTime()) ? { activity, contact: decoded[1] } : null;
  } catch {
    return null;
  }
}

api.get('/conversations', workspaceRoute(async (req, res, workspace) => {
  const cursor = parseCursor(req.query.cursor);
  const state = req.query.state;
  if ((req.query.cursor !== undefined && !cursor) || (state !== undefined && state !== 'open' && state !== 'closed')) {
    res.sendStatus(400);
    return;
  }
  res.json(await listConversations(workspace, cursor ?? undefined, state));
}));

api.get('/conversations/:contact', workspaceRoute(async (req, res, workspace) => {
  const detail = await conversationDetail(workspace, req.params.contact);
  if (!detail) {
    res.sendStatus(404);
    return;
  }
  res.json(detail);
}));

api.post('/conversations/:contact/claim', workspaceRoute(async (req, res, workspace, agent) => {
  res.sendStatus(await claimConversation(workspace, req.params.contact, agent) ? 200 : 409);
}));

api.post('/conversations/:contact/replies', json(), workspaceRoute(async (req, res, workspace) => {
  const { text, client_ref } = req.body ?? {};
  if (!field(text) || !text.trim() || text.length > 4000 || !field(client_ref) || client_ref.length > 128) {
    res.sendStatus(400);
    return;
  }
  if (!(await canSend(workspace))) {
    res.sendStatus(402);
    return;
  }
  await queueReply(workspace, req.params.contact, client_ref, text.trim());
  res.sendStatus(202);
}));

api.post('/conversations/:contact/state', json(), workspaceRoute(async (req, res, workspace) => {
  const { state } = req.body ?? {};
  if (state !== 'open' && state !== 'closed') {
    res.sendStatus(400);
    return;
  }
  res.sendStatus(await setConversationState(workspace, req.params.contact, state) ? 200 : 404);
}));

api.get('/billing', workspaceRoute(async (_req, res, workspace) => {
  res.json({
    billing: await billingView(workspace),
    paybox: { url: config.paybox.publicUrl, publishableKey: config.paybox.publishableKey },
  });
}, true));

api.post('/billing/subscribe', json(), workspaceRoute(async (req, res, workspace) => {
  const { seats, token } = req.body ?? {};
  if (!validSeats(seats) || !validCardToken(token)) {
    res.sendStatus(400);
    return;
  }
  const billing = await subscribe(workspace, seats, token);
  res.status(billing.status === 'active' ? 200 : 402).json({ billing });
}, true));

api.post('/billing/seats', json(), workspaceRoute(async (req, res, workspace) => {
  const { seats } = req.body ?? {};
  if (!validSeats(seats)) {
    res.sendStatus(400);
    return;
  }
  const { ok, billing } = await changeSeats(workspace, seats);
  res.status(ok ? 200 : 402).json({ billing });
}, true));
