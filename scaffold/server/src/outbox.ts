import { createHash, randomUUID } from 'node:crypto';
import { canSend } from './billing.ts';
import { config } from './config.ts';
import { getDb } from './db.ts';
import { collections, touchConversation, updateStatus } from './inbox.ts';

type Dispatch = { _id: string; owner: string | null; lockedUntil: Date; availableAt: Date };
const workspaceIds = Object.keys(config.pigeon.apiKeys);
const idle = { owner: null, lockedUntil: new Date(0), availableAt: new Date(0) };
const dispatches = async () => (await getDb()).collection<Dispatch>('pigeon_dispatch');

export async function initializeDispatch() {
  const dispatch = await dispatches();
  await Promise.all(workspaceIds.map(_id => dispatch.updateOne({ _id }, { $setOnInsert: idle }, { upsert: true })));
}

export async function resetDispatch() {
  await (await dispatches()).updateMany({}, { $set: idle });
}

function coolOff(headers: Headers) {
  const retryAfter = headers.get('retry-after') ?? '';
  const seconds = Number(retryAfter);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
  return new Date(Date.now() + Math.max(2000, Number.isFinite(delay) ? delay : 0) + 20);
}

async function dispatchOne(workspace: string) {
  const { replies } = await collections();
  const eligible = { workspace, status: 'queued' as const, nextAttempt: { $lte: new Date() } };
  if (!await replies.findOne(eligible, { projection: { _id: 1 } })) return;

  const dispatch = await dispatches();
  const owner = randomUUID();
  const now = new Date();
  const lease = await dispatch.updateOne({
    _id: workspace, availableAt: { $lte: now }, lockedUntil: { $lte: now },
  }, {
    $set: { owner, lockedUntil: new Date(now.getTime() + 10_000) },
  });
  if (!lease.matchedCount) return;

  let availableAt = new Date(now.getTime() + 260);
  try {
    const reply = await replies.findOneAndUpdate(eligible,
      { $set: { nextAttempt: new Date(now.getTime() + 15_000) }, $inc: { attempts: 1 } },
      { sort: { nextAttempt: 1 }, returnDocument: 'after' },
    );
    if (!reply) return;

    if (!(await canSend(workspace))) {
      await updateStatus(workspace, reply.clientRef, 'failed');
      return;
    }
    await touchConversation(workspace, reply.contact, reply.createdAt);
    const backoff = Math.min(8000, 500 * 2 ** Math.min(reply.attempts, 4));
    let nextAttempt = new Date(Date.now() + backoff);
    let response: Response | undefined;
    availableAt = new Date(Date.now() + 260);
    try {
      response = await fetch(new URL('/v1/messages', config.pigeon.url), {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + config.pigeon.apiKeys[workspace],
          'content-type': 'application/json',
          'idempotency-key': createHash('sha256').update(JSON.stringify([workspace, reply.clientRef])).digest('hex'),
        },
        body: JSON.stringify({ to: reply.contact, text: reply.text, client_ref: reply.clientRef }),
        signal: AbortSignal.timeout(4000),
      });
      void response.body?.cancel().catch(() => {});
    } catch {
      nextAttempt = new Date(Date.now() + backoff);
    }
    if (response?.ok) {
      await updateStatus(workspace, reply.clientRef, 'sent');
      return;
    }
    if (response?.status === 429) {
      availableAt = coolOff(response.headers);
      nextAttempt = availableAt;
    } else if (response && response.status >= 400 && response.status < 500) {
      await updateStatus(workspace, reply.clientRef, 'failed');
      return;
    }

    await replies.updateOne({ _id: reply._id, status: 'queued', attempts: reply.attempts }, {
      $set: { nextAttempt },
    });
  } finally {
    await dispatch.updateOne({ _id: workspace, owner }, {
      $set: { ...idle, availableAt },
    });
  }
}

export function startOutbox() {
  for (const workspace of workspaceIds) {
    let running = false;
    setInterval(async () => {
      if (running) return;
      running = true;
      try {
        await dispatchOne(workspace);
      } catch (error) {
        console.error('Outbox error', error);
      } finally {
        running = false;
      }
    }, 100).unref();
  }
}
