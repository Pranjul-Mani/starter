import { billingView, canSend, changeSeats, refreshFromWebhook, resetBilling, subscribe, validCardToken, validSeats } from './billing.ts';
import express from 'express';
import { createServer } from 'node:http';
import { config } from './config.ts';
import { claimConversation, collections, initializeInbox, knownWorkspace, queueReply, receiveMessage, updateStatus } from './inbox.ts';

import { api } from './api.ts';
import { auth, initializeAuth } from './auth.ts';
import { field, route, validWebhook } from './http.ts';
import { clearEvents, initializeEvents, startEventPublisher } from './events.ts';
import { attachSockets } from './sockets.ts';
import { initializeDispatch, resetDispatch, startOutbox } from './outbox.ts';

const app = express();
app.use('/auth', auth);
app.use('/api', api);
app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

app.post('/webhooks/pigeon', express.raw({ type: () => true }), route(async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!validWebhook(req.get('x-pigeon-signature'), raw, config.pigeon.webhookSecret)) {
    res.sendStatus(401);
    return;
  }
  let event;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch {
    res.sendStatus(400);
    return;
  }
  if (!event || !field(event.type) || !field(event.workspace)) {
    res.sendStatus(400);
    return;
  }
  const { workspace, data } = event;
  if (!knownWorkspace(workspace)) {
    res.sendStatus(204);
    return;
  }
  if (event.type === 'message.inbound') {
    const occurredAt = new Date(event.occurred_at);
    if (!field(data?.message_id) || !field(data?.from) || typeof data?.text !== 'string' || !Number.isFinite(occurredAt.getTime())) {
      res.sendStatus(400);
      return;
    }
    await receiveMessage({ workspace, messageId: data.message_id, contact: data.from, text: data.text, occurredAt });
  }
  if (event.type === 'message.status' && field(data?.client_ref)) {
    const { status } = data;
    if (status === 'sent' || status === 'delivered' || status === 'failed') {
      await updateStatus(workspace, data.client_ref, status);
    }
  }
  res.sendStatus(204);
}));

app.post('/webhooks/paybox', express.raw({ type: () => true }), route(async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!validWebhook(req.get('x-paybox-signature'), raw, config.paybox.webhookSecret)) {
    res.sendStatus(401);
    return;
  }
  let event;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch {
    res.sendStatus(400);
    return;
  }
  const object = event?.data?.object;
  const subscription = object?.object === 'subscription' ? object.id : object?.subscription;
  if (field(object?.customer) && field(subscription)) {
    await refreshFromWebhook(object.customer, subscription);
  }
  res.sendStatus(204);
}));

const grader = express.Router();
grader.use((req, res, next) => {
  if (req.get('x-grader-token') !== config.graderToken) {
    res.sendStatus(401);
    return;
  }
  next();
});
grader.use(express.json());

grader.post('/reset', route(async (_req, res) => {
  const { conversations, inbound, replies } = await collections();
  await Promise.all([conversations.deleteMany({}), inbound.deleteMany({}), replies.deleteMany({})]);
  await Promise.all([clearEvents(), resetDispatch(), resetBilling()]);
  res.sendStatus(200);
}));
grader.post('/reply', route(async (req, res) => {
  const { workspace, contact, text, client_ref } = req.body ?? {};
  if (!knownWorkspace(workspace) || !field(contact) || !field(text) || !field(client_ref)) {
    res.sendStatus(400);
    return;
  }
  if (!(await canSend(workspace))) {
    res.sendStatus(402);
    return;
  }
  await queueReply(workspace, contact, client_ref, text);
  res.sendStatus(202);
}));
grader.post('/claim', route(async (req, res) => {
  const { workspace, contact, agent } = req.body ?? {};
  if (!knownWorkspace(workspace) || !field(contact) || !field(agent)) {
    res.sendStatus(400);
    return;
  }
  res.sendStatus(await claimConversation(workspace, contact, agent) ? 200 : 409);
}));
grader.post('/billing/subscribe', route(async (req, res) => {
  const { workspace, seats, token } = req.body ?? {};
  if (!knownWorkspace(workspace) || !validSeats(seats) || !validCardToken(token)) {
    res.sendStatus(400);
    return;
  }
  const billing = await subscribe(workspace, seats, token);
  res.status(billing.status === 'active' ? 200 : 402).json({ billing });
}));

grader.post('/billing/seats', route(async (req, res) => {
  const { workspace, seats } = req.body ?? {};
  if (!knownWorkspace(workspace) || !validSeats(seats)) {
    res.sendStatus(400);
    return;
  }
  const { ok, billing } = await changeSeats(workspace, seats);
  res.status(ok ? 200 : 402).json({ billing });
}));

grader.get('/snapshot', route(async (_req, res) => {
  const { conversations, inbound, replies } = await collections();
  const workspaces = Object.fromEntries(await Promise.all(Object.keys(config.pigeon.apiKeys).map(async workspace => {
    const { status, seats, can_send } = await billingView(workspace);
    return [workspace, {
      contacts: Object.create(null) as Record<string, { inbound: string[]; assignee: string | null }>,
      outbound: Object.create(null) as Record<string, string>,
      billing: { status, seats, can_send },
    }] as const;
  })));
  const [contacts, messages, outgoing] = await Promise.all([
    conversations.find().toArray(),
    inbound.find().sort({ occurredAt: 1, messageId: 1 }).toArray(),
    replies.find().toArray(),
  ]);
  for (const item of contacts) {
    workspaces[item.workspace].contacts[item.contact] = { inbound: [], assignee: item.assignee };
  }
  for (const item of messages) {
    workspaces[item.workspace].contacts[item.contact]?.inbound.push(item.messageId);
  }
  for (const item of outgoing) {
    workspaces[item.workspace].outbound[item.clientRef] = item.status;
  }
  res.json({ workspaces });
}));
app.use('/__grader', grader);

await Promise.all([initializeInbox(), initializeAuth(), initializeEvents(), initializeDispatch()]);
const server = createServer(app);
attachSockets(server);
server.listen(config.port, () => {
  startOutbox();
  startEventPublisher();
  console.log(`server on http://localhost:${config.port}`);
});
