import express from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { config } from './config.ts';
import { claimConversation, collections, initializeInbox, knownWorkspace, queueReply, receiveMessage, startOutbox, updateStatus } from './inbox.ts';

const app = express();
const field = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const route = (handler: (req: express.Request, res: express.Response) => Promise<void>): express.RequestHandler =>
  (req, res, next) => { handler(req, res).catch(next); };

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

app.post('/webhooks/pigeon', express.raw({ type: () => true }), route(async (req, res) => {
  const signature = /^t=(\d+),v1=([a-f0-9]{64})$/i.exec(req.get('x-pigeon-signature') ?? '');
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!signature || Math.abs(Math.floor(Date.now() / 1000) - Number(signature[1])) > 300) {
    res.sendStatus(401);
    return;
  }
  const expected = createHmac('sha256', config.pigeon.webhookSecret).update(signature[1] + '.').update(raw).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature[2], 'hex'))) {
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
  res.sendStatus(200);
}));
grader.post('/reply', route(async (req, res) => {
  const { workspace, contact, text, client_ref } = req.body ?? {};
  if (!knownWorkspace(workspace) || !field(contact) || !field(text) || !field(client_ref)) {
    res.sendStatus(400);
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
grader.get('/snapshot', route(async (_req, res) => {
  const { conversations, inbound, replies } = await collections();
  const workspaces = Object.fromEntries(Object.keys(config.pigeon.apiKeys).map(workspace => [workspace, {
    contacts: Object.create(null) as Record<string, { inbound: string[]; assignee: string | null }>,
    outbound: Object.create(null) as Record<string, string>,
  }]));
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

await initializeInbox();
const server = createServer(app);
server.listen(config.port, () => {
  startOutbox();
  console.log(`server on http://localhost:${config.port}`);
});
