import { createHash } from 'node:crypto';
import { config } from './config.ts';
import { getDb } from './db.ts';

type Status = 'queued' | 'sent' | 'delivered' | 'failed';
type Conversation = { workspace: string; contact: string; assignee: string | null; activity: Date };
type Inbound = { workspace: string; contact: string; messageId: string; text: string; occurredAt: Date };
type Reply = { workspace: string; contact: string; clientRef: string; text: string; status: Status; nextAttempt: Date; createdAt: Date; attempts: number };

export const knownWorkspace = (id: unknown): id is string =>
  typeof id === 'string' && Object.hasOwn(config.pigeon.apiKeys, id);

export async function collections() {
  const db = await getDb();
  return {
    conversations: db.collection<Conversation>('conversations'),
    inbound: db.collection<Inbound>('inbound'),
    replies: db.collection<Reply>('replies'),
  };
}

export async function initializeInbox() {
  const { conversations, inbound, replies } = await collections();
  await Promise.all([
    conversations.createIndex({ workspace: 1, contact: 1 }, { unique: true }),
    inbound.createIndex({ workspace: 1, messageId: 1 }, { unique: true }),
    replies.createIndex({ workspace: 1, clientRef: 1 }, { unique: true }),
    replies.createIndex({ workspace: 1, status: 1, nextAttempt: 1 }),
  ]);
}

async function touchConversation(workspace: string, contact: string, activity: Date) {
  const { conversations } = await collections();
  await conversations.updateOne({ workspace, contact }, {
    $setOnInsert: { assignee: null },
    $max: { activity },
  }, { upsert: true });
}

export async function receiveMessage(message: Inbound) {
  const { inbound } = await collections();
  await touchConversation(message.workspace, message.contact, message.occurredAt);
  await inbound.updateOne({ workspace: message.workspace, messageId: message.messageId },
    { $setOnInsert: message }, { upsert: true });
}

export async function claimConversation(workspace: string, contact: string, agent: string) {
  const { conversations } = await collections();
  await conversations.updateOne({ workspace, contact }, {
    $setOnInsert: { activity: new Date(), assignee: null },
  }, { upsert: true });
  const result = await conversations.updateOne({ workspace, contact, assignee: { $in: [null, agent] } },
    { $set: { assignee: agent } });
  return result.matchedCount > 0;
}

export async function queueReply(workspace: string, contact: string, clientRef: string, text: string) {
  const { replies } = await collections();
  const now = new Date();
  await touchConversation(workspace, contact, now);
  await replies.updateOne({ workspace, clientRef }, {
    $setOnInsert: { contact, text, status: 'queued', nextAttempt: now, createdAt: now, attempts: 0 },
  }, { upsert: true });
}

export async function updateStatus(workspace: string, clientRef: string, status: Exclude<Status, 'queued'>) {
  const { replies } = await collections();
  const previous: Status[] = status === 'sent' ? ['queued'] : ['queued', 'sent'];
  await replies.updateOne({ workspace, clientRef, status: { $in: previous } }, { $set: { status } });
}

export function startOutbox() {
  for (const workspace of Object.keys(config.pigeon.apiKeys)) {
    let running = false;
    setInterval(async () => {
      if (running) return;
      running = true;
      try {
        const { replies } = await collections();
        const now = Date.now();
        const reply = await replies.findOneAndUpdate(
          { workspace, status: 'queued', nextAttempt: { $lte: new Date(now) } },
          { $set: { nextAttempt: new Date(now + 15_000) }, $inc: { attempts: 1 } },
          { sort: { nextAttempt: 1 }, returnDocument: 'after' },
        );
        if (!reply) return;

        let retryAfter = Math.min(8000, 500 * 2 ** Math.min(reply.attempts, 4));
        try {
          const response = await fetch(new URL('/v1/messages', config.pigeon.url), {
            method: 'POST',
            headers: {
              authorization: 'Bearer ' + config.pigeon.apiKeys[workspace],
              'content-type': 'application/json',
              'idempotency-key': createHash('sha256').update(JSON.stringify([workspace, reply.clientRef])).digest('hex'),
            },
            body: JSON.stringify({ to: reply.contact, text: reply.text, client_ref: reply.clientRef }),
            signal: AbortSignal.timeout(4000),
          });
          await response.body?.cancel();
          if (response.ok) {
            await updateStatus(workspace, reply.clientRef, 'sent');
            return;
          }
          if (response.status === 429) {
            retryAfter = Math.max(2000, (Number(response.headers.get('retry-after')) || 0) * 1000);
            await replies.updateMany({ workspace, status: 'queued' }, {
              $max: { nextAttempt: new Date(Date.now() + retryAfter) },
            });
            return;
          }
          if (response.status >= 400 && response.status < 500) {
            await updateStatus(workspace, reply.clientRef, 'failed');
            return;
          }
        } catch (error) {
          console.warn('Pigeon send will retry', error);
        }
        await replies.updateOne({ _id: reply._id, status: 'queued', attempts: reply.attempts }, {
          $set: { nextAttempt: new Date(Date.now() + retryAfter) },
        });
      } catch (error) {
        console.error('Outbox error', error);
      } finally {
        running = false;
      }
    }, 270).unref();
  }
}
