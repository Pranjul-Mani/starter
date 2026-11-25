import { randomUUID } from 'node:crypto';
import { MongoServerError } from 'mongodb';
import { getDb } from './db.ts';

type Change =
  | { type: 'message.inbound'; contact: string; message_id: string }
  | { type: 'message.status'; contact: string; client_ref: string; status: 'queued' | 'sent' | 'delivered' | 'failed' }
  | { type: 'conversation.assigned'; contact: string; assignee: string }
  | { type: 'conversation.state'; contact: string; state: 'open' | 'closed' };

export type PendingChange = Change & { key: string };
type Source = { workspace: string; changes: PendingChange[] };
const sources = ['inbound', 'replies', 'conversations'];
const feed = async () => (await getDb()).collection<PendingChange & { workspace: string; seq: number }>('workspace_events');

export function pending(change: Change): PendingChange {
  return { key: randomUUID(), ...change };
}

export async function initializeEvents() {
  const [events, db] = await Promise.all([feed(), getDb()]);
  await Promise.all([
    events.createIndex({ workspace: 1, seq: 1 }, { unique: true }),
    events.createIndex({ workspace: 1, key: 1 }, { unique: true }),
    ...sources.map(name => db.collection(name).createIndex({ 'changes.key': 1 }, { sparse: true })),
  ]);
}

export async function clearEvents() {
  await (await feed()).deleteMany({});
}

export async function latestSequence(workspace: string) {
  const last = await (await feed()).findOne({ workspace }, { sort: { seq: -1 } });
  return last?.seq ?? 0;
}

export async function framesAfter(workspace: string, after: number) {
  const rows = await (await feed()).find({ workspace, seq: { $gt: after } }).sort({ seq: 1 }).limit(100).toArray();
  return rows.map(({ _id, key, workspace, ...frame }) => frame);
}

async function publish(workspace: string, change: PendingChange) {
  const events = await feed();
  for (let retry = 0; retry < 30; retry += 1) {
    if (await events.findOne({ workspace, key: change.key }, { projection: { _id: 1 } })) return;
    const seq = (await latestSequence(workspace)) + 1;
    try {
      await events.insertOne({ workspace, seq, ...change });
      return;
    } catch (error) {
      if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
    }
  }
  throw new Error('Could not allocate a workspace event sequence');
}

export function startEventPublisher() {
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const db = await getDb();
      for (const name of sources) {
        const source = db.collection<Source>(name);
        const batch = await source.find({ 'changes.key': { $exists: true } }).limit(50).toArray();
        for (const row of batch) {
          for (const change of row.changes) {
            await publish(row.workspace, change);
            await source.updateOne({ _id: row._id }, { $pull: { changes: { key: change.key } } });
          }
        }
      }
    } catch (error) {
      console.error('Event publication will retry', error);
    } finally {
      busy = false;
    }
  }, 150).unref();
}
