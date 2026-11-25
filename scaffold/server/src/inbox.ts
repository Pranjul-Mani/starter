import type { Filter } from 'mongodb';
import { config } from './config.ts';
import { getDb } from './db.ts';
import { pending, type PendingChange } from './events.ts';

type Status = 'queued' | 'sent' | 'delivered' | 'failed';
export type ConversationStatus = 'open' | 'closed';
type EventSource = { changes?: PendingChange[] };
type Conversation = EventSource & { workspace: string; contact: string; assignee: string | null; activity: Date; state?: ConversationStatus };
type Inbound = { workspace: string; contact: string; messageId: string; text: string; occurredAt: Date };
type Reply = EventSource & { workspace: string; contact: string; clientRef: string; text: string; status: Status; nextAttempt: Date; createdAt: Date; attempts: number };

export const knownWorkspace = (id: unknown): id is string =>
  typeof id === 'string' && Object.hasOwn(config.pigeon.apiKeys, id);

export async function collections() {
  const db = await getDb();
  return {
    conversations: db.collection<Conversation>('conversations'),
    inbound: db.collection<Inbound & EventSource>('inbound'),
    replies: db.collection<Reply>('replies'),
  };
}

export async function initializeInbox() {
  const { conversations, inbound, replies } = await collections();
  await Promise.all([
    conversations.createIndex({ workspace: 1, contact: 1 }, { unique: true }),
    conversations.createIndex({ workspace: 1, activity: -1, contact: 1 }),
    inbound.createIndex({ workspace: 1, messageId: 1 }, { unique: true }),
    inbound.createIndex({ workspace: 1, contact: 1, occurredAt: 1 }),
    replies.createIndex({ workspace: 1, clientRef: 1 }, { unique: true }),
    replies.createIndex({ workspace: 1, status: 1, nextAttempt: 1 }),
    replies.createIndex({ workspace: 1, contact: 1, createdAt: 1 }),
  ]);
}

export async function touchConversation(workspace: string, contact: string, activity: Date) {
  const { conversations } = await collections();
  await conversations.updateOne({ workspace, contact }, {
    $setOnInsert: { assignee: null },
    $max: { activity },
  }, { upsert: true });
}

export async function receiveMessage(message: Inbound) {
  const { inbound } = await collections();
  await touchConversation(message.workspace, message.contact, message.occurredAt);
  const change = pending({ type: 'message.inbound', contact: message.contact, message_id: message.messageId });
  await inbound.updateOne({ workspace: message.workspace, messageId: message.messageId }, {
    $setOnInsert: { ...message, changes: [change] },
  }, { upsert: true });
}

export async function claimConversation(workspace: string, contact: string, agent: string) {
  const { conversations } = await collections();
  await conversations.updateOne({ workspace, contact }, {
    $setOnInsert: { activity: new Date(), assignee: null },
  }, { upsert: true });
  const result = await conversations.updateOne({ workspace, contact, assignee: null }, {
    $set: { assignee: agent },
    $push: { changes: pending({ type: 'conversation.assigned', contact, assignee: agent }) },
  });
  return result.matchedCount > 0 || !!await conversations.findOne({ workspace, contact, assignee: agent });
}

export async function queueReply(workspace: string, contact: string, clientRef: string, text: string) {
  const { replies } = await collections();
  const now = new Date();
  const reply = await replies.findOneAndUpdate({ workspace, clientRef }, {
    $setOnInsert: {
      contact, text, status: 'queued', nextAttempt: now, createdAt: now, attempts: 0,
      changes: [pending({ type: 'message.status', contact, client_ref: clientRef, status: 'queued' })],
    },
  }, { upsert: true, returnDocument: 'after' });
  if (!reply) throw new Error('Could not store reply');
  await touchConversation(workspace, reply.contact, reply.createdAt);
}

export async function updateStatus(workspace: string, clientRef: string, status: Exclude<Status, 'queued'>) {
  const { replies } = await collections();
  const previous: Status[] = status === 'sent' ? ['queued'] : ['queued', 'sent'];
  const reply = await replies.findOne({ workspace, clientRef, status: { $in: previous } }, { projection: { contact: 1 } });
  if (!reply) return;
  await replies.updateOne({ _id: reply._id, status: { $in: previous } }, {
    $set: { status },
    $push: { changes: pending({ type: 'message.status', contact: reply.contact, client_ref: clientRef, status }) },
  });
}

type Cursor = { activity: Date; contact: string };
const pageSize = 30;

function conversationView(item: Conversation) {
  return {
    contact: item.contact,
    assignee: item.assignee,
    activity: item.activity,
    state: item.state ?? 'open',
  };
}

export async function listConversations(workspace: string, cursor?: Cursor, state?: ConversationStatus) {
  const { conversations } = await collections();
  const filter: Filter<Conversation> = { workspace };
  if (state) filter.state = state === 'open' ? { $ne: 'closed' } : 'closed';
  if (cursor) {
    filter.$or = [
      { activity: { $lt: cursor.activity } },
      { activity: cursor.activity, contact: { $gt: cursor.contact } },
    ];
  }
  const rows = await conversations.find(filter).sort({ activity: -1, contact: 1 }).limit(pageSize + 1).toArray();
  const items = rows.slice(0, pageSize).map(conversationView);
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > pageSize && last
      ? Buffer.from(JSON.stringify([last.activity.toISOString(), last.contact])).toString('base64url')
      : null,
  };
}

export async function conversationDetail(workspace: string, contact: string) {
  const { conversations, inbound, replies } = await collections();
  const filter = { workspace, contact };
  const conversation = await conversations.findOne(filter);
  if (!conversation) return null;
  const [received, sent] = await Promise.all([
    inbound.find(filter).toArray(),
    replies.find(filter).toArray(),
  ]);
  const messages = [
    ...received.map(message => ({
      key: 'in:' + message.messageId,
      direction: 'inbound' as const,
      text: message.text,
      time: message.occurredAt,
    })),
    ...sent.map(message => ({
      key: 'out:' + message.clientRef,
      direction: 'outbound' as const,
      text: message.text,
      time: message.createdAt,
      status: message.status,
    })),
  ].sort((a, b) => a.time.getTime() - b.time.getTime() || a.key.localeCompare(b.key));
  return { ...conversationView(conversation), messages };
}

export async function setConversationState(workspace: string, contact: string, state: ConversationStatus) {
  const { conversations } = await collections();
  const result = await conversations.updateOne({ workspace, contact, state: state === 'open' ? 'closed' : { $ne: 'closed' } }, {
    $set: { state },
    $push: { changes: pending({ type: 'conversation.state', contact, state }) },
  });
  return result.matchedCount > 0 || !!await conversations.findOne({ workspace, contact });
}
