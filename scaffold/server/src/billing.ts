import { createHash, randomUUID } from 'node:crypto';
import { config } from './config.ts';
import { getDb } from './db.ts';

type ProviderSubscription = {
  id: string;
  customer: string;
  status: 'active' | 'past_due' | 'incomplete' | 'incomplete_expired' | 'canceled';
  quantity: number;
  latest_invoice?: { payment?: { next_action?: { url: string } } };
};
type BillingRecord = {
  _id: string;
  customer?: string;
  subscription?: string;
  observedStatus?: ProviderSubscription['status'];
  owner?: string;
  leaseUntil: Date;
  seatChange?: { seats: number; key: string };
};
const records = async () => (await getDb()).collection<BillingRecord>('billing');
const trial = { status: 'none', seats: 0, can_send: true, approval_url: null };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

class PayboxError extends Error {
  readonly status: number;
  constructor(status: number) {
    super('Paybox returned HTTP ' + status);
    this.status = status;
  }
}

async function paybox<T>(path: string, method = 'GET', body?: object, key?: string): Promise<T> {
  const headers: Record<string, string> = { authorization: 'Bearer ' + config.paybox.secretKey };
  if (body) headers['content-type'] = 'application/json';
  if (key) headers['idempotency-key'] = key;
  const response = await fetch(new URL(path, config.paybox.url), {
    method, headers, body: body && JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(3500),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new PayboxError(response.status);
  }
  return response.json();
}

function view(subscription: ProviderSubscription | null) {
  if (!subscription) return trial;
  const status = subscription.status === 'incomplete_expired' ? 'canceled' : subscription.status;
  const approval = subscription.latest_invoice?.payment?.next_action?.url;
  // The provider may advertise its internal host. Use the browser-facing endpoint.
  const approvalPath = approval && new URL(approval).pathname;
  return {
    status,
    seats: subscription.quantity,
    can_send: status !== 'canceled',
    approval_url: status === 'incomplete' && approvalPath ? new URL(approvalPath, config.paybox.publicUrl).href : null,
  };
}

async function current(record: BillingRecord | null) {
  if (!record?.customer) return null;
  const { data } = await paybox<{ data: ProviderSubscription[] }>('/v1/subscriptions?' + new URLSearchParams({ customer: record.customer }));
  return data.at(-1) ?? null;
}

export async function billingView(workspace: string) {
  return view(await current(await (await records()).findOne({ _id: workspace })));
}

export async function canSend(workspace: string) {
  return (await billingView(workspace)).can_send;
}

export async function resetBilling() {
  await (await records()).deleteMany({});
}

export const validSeats = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

export const validCardToken = (value: unknown): value is string =>
  typeof value === 'string' && /^tok_\w{1,120}$/.test(value);

async function withLease<T>(workspace: string, operation: (record: BillingRecord, owner: string) => Promise<T>): Promise<T> {
  const collection = await records();
  await collection.updateOne({ _id: workspace }, { $setOnInsert: { leaseUntil: new Date(0) } }, { upsert: true });
  const owner = randomUUID();
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const record = await collection.findOneAndUpdate({ _id: workspace, leaseUntil: { $lte: new Date() } },
      { $set: { owner, leaseUntil: new Date(Date.now() + 25_000) } }, { returnDocument: 'after' });
    if (record) {
      try {
        return await operation(record, owner);
      } finally {
        await collection.updateOne({ _id: workspace, owner }, {
          $set: { leaseUntil: new Date(0) }, $unset: { owner: '' },
        });
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Billing operation is busy');
}

export async function subscribe(workspace: string, seats: number, token: string) {
  return withLease(workspace, async (record, owner) => {
    const collection = await records();
    const existing = await current(record);
    if (existing?.status === 'active' || existing?.status === 'past_due' || view(existing).approval_url) {
      if (existing) await collection.updateOne({ _id: workspace, owner }, { $set: { subscription: existing.id } });
      return view(existing);
    }

    let customer = record.customer;
    if (!customer) {
      const created = await paybox<{ id: string }>('/v1/customers', 'POST',
        { name: workspace, metadata: { workspace } }, 'customer-' + hash(workspace));
      customer = created.id;
      await collection.updateOne({ _id: workspace, owner }, { $set: { customer } });
    }

    const operation = hash(customer + ':' + token);
    try {
      await paybox('/v1/customers/' + customer + '/payment_method', 'POST', { token }, 'attach-' + operation);
      const subscription = await paybox<ProviderSubscription>('/v1/subscriptions', 'POST',
        { customer, price: 'price_seat_monthly', quantity: seats }, 'subscribe-' + operation);
      // Refresh after a replay because Paybox caches the original POST response.
      const latest = await paybox<ProviderSubscription>('/v1/subscriptions/' + subscription.id);
      await collection.updateOne({ _id: workspace, owner }, {
        $set: { subscription: latest.id, observedStatus: latest.status }, $unset: { seatChange: '' },
      });
      return view(latest);
    } catch (error) {
      if (error instanceof PayboxError && (error.status === 400 || error.status === 402)) return view(existing);
      throw error;
    }
  });
}

export async function changeSeats(workspace: string, seats: number) {
  return withLease(workspace, async (record, owner) => {
    const subscription = await current(record);
    if (!subscription || (subscription.status !== 'active' && subscription.status !== 'past_due')) {
      return { ok: false, billing: view(subscription) };
    }
    const collection = await records();
    if (subscription.quantity === seats) {
      await collection.updateOne({ _id: workspace, owner }, { $unset: { seatChange: '' } });
      return { ok: true, billing: view(subscription) };
    }

    const operation = record.seatChange?.seats === seats ? record.seatChange : { seats, key: randomUUID() };
    await collection.updateOne({ _id: workspace, owner }, { $set: { seatChange: operation } });
    try {
      const updated = await paybox<ProviderSubscription>('/v1/subscriptions/' + subscription.id, 'POST',
        { quantity: seats }, 'seats-' + operation.key);
      await collection.updateOne({ _id: workspace, owner }, { $unset: { seatChange: '' } });
      return { ok: true, billing: view(updated) };
    } catch (error) {
      if (!(error instanceof PayboxError) || (error.status !== 400 && error.status !== 402)) throw error;
      await collection.updateOne({ _id: workspace, owner }, { $unset: { seatChange: '' } });
      return { ok: false, billing: view(subscription) };
    }
  });
}

export async function refreshFromWebhook(customer: string, subscription: string) {
  const collection = await records();
  const record = await collection.findOne({ customer, subscription });
  if (!record) return;
  const latest = await paybox<ProviderSubscription>('/v1/subscriptions/' + subscription);
  await collection.updateOne({ _id: record._id, subscription }, { $set: { observedStatus: latest.status } });
}
