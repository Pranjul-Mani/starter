import { useEffect, useRef, useState, type FormEvent } from 'react';

type Billing = {
  status: 'none' | 'active' | 'incomplete' | 'past_due' | 'canceled';
  seats: number;
  approval_url: string | null;
};

type BillingConfig = {
  billing: Billing;
  paybox: { url: string; publishableKey: string };
};

const descriptions = {
  none: ['Free trial', 'Choose a seat count and pay to start a subscription.'],
  active: ['Active', 'You can update the seat count below. Seat increases are charged for the remainder of this period. Decreases go toward your next invoice.'],
  incomplete: ['Payment incomplete', 'The first payment needs bank approval or a different card.'],
  past_due: ['Payment past due', 'Paybox is retrying the renewal. Your team can send replies while the retries are in progress.'],
  canceled: ['Canceled', 'Your team can read the inbox. Subscribe again to send replies.'],
};

export function BillingPanel({ workspace, onExpired }: { workspace: string; onExpired: () => void }) {
  const [data, setData] = useState<BillingConfig>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const pending = useRef<{ seats: number; token: string } | null>(null);
  const expired = useRef(onExpired);
  expired.current = onExpired;
  const query = '?' + new URLSearchParams({ workspace });

  useEffect(() => {
    if (busy) return;
    const controller = new AbortController();
    async function refresh() {
      try {
        const response = await fetch('/api/billing' + query, { signal: controller.signal });
        if (response.status === 401) return expired.current();
        if (!response.ok) throw new Error('Billing unavailable');
        setData(await response.json());
      } catch {
        if (!controller.signal.aborted) setError('Could not refresh billing.');
      }
    }
    void refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [query, busy, reload]);

  async function save(event: FormEvent<HTMLFormElement>, subscribe: boolean) {
    event.preventDefault();
    if (!data || busy) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const seats = Number(values.get('seats'));
    setBusy(true);
    setError('');
    try {
      if (subscribe && values.has('number')) {
        const number = String(values.get('number')).replace(/\s/g, '');
        const month = Number(values.get('month'));
        const year = Number(values.get('year'));
        const cvc = String(values.get('cvc'));
        const response = await fetch(new URL('/v1/tokens', data.paybox.url), {
          method: 'POST',
          credentials: 'omit',
          headers: { authorization: 'Bearer ' + data.paybox.publishableKey, 'content-type': 'application/json' },
          body: JSON.stringify({ card: { number, exp_month: month, exp_year: year, cvc } }),
        });
        if (!response.ok) {
          setError('Paybox could not tokenize the card. Check the details and try again.');
          return;
        }
        const { id } = await response.json();
        pending.current = { seats, token: id };
        form.reset();
      }
      const body = subscribe ? pending.current : { seats };
      if (!body) return;
      const response = await fetch('/api/billing/' + (subscribe ? 'subscribe' : 'seats') + query, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (response.status === 401) return expired.current();
      if (!response.ok && response.status !== 402) throw new Error('Billing request failed');
      const result: { billing: Billing } = await response.json();
      pending.current = null;
      setData({ ...data, billing: result.billing });
      if (response.status === 402 && !result.billing.approval_url) {
        setError(subscribe ? 'The payment did not go through. Try a different card.' : 'The seat count could not be changed. Check the payment status.');
      }
    } catch {
      setError('Could not finish the request. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const billing = data?.billing;
  const canChangeSeats = billing?.status === 'active' || billing?.status === 'past_due';
  return (
    <section className="billing-panel" aria-labelledby="billing-heading">
      <h1 id="billing-heading">Billing</h1>
      {error && <p className="error" role="alert">{error}</p>}
      {!billing && (!error ? <p role="status">Loading billing…</p> : (
        <button onClick={() => { setError(''); setReload(value => value + 1); }}>Retry</button>
      ))}
      {billing && (
        <div className="billing-card">
          <h2>{descriptions[billing.status][0]}</h2>
          <p>{descriptions[billing.status][1]}</p>
          {billing.seats > 0 && <p><strong>{billing.seats}</strong> {billing.seats === 1 ? 'seat' : 'seats'}</p>}
          {billing.approval_url ? (
            <a className="primary" href={billing.approval_url} target="_blank" rel="noopener noreferrer">Approve at your bank</a>
          ) : (
            <form key={billing.status + billing.seats} onSubmit={event => void save(event, !canChangeSeats)}>
              {pending.current && !canChangeSeats ? (
                <div className="billing-actions">
                  <button className="primary" disabled={busy}>Retry payment</button>
                  <button type="button" disabled={busy} onClick={() => { pending.current = null; setError(''); }}>Use another card</button>
                </div>
              ) : (
                <>
                  <label>Seats<input name="seats" type="number" min="1" step="1" required defaultValue={billing.seats || 1} /></label>
                  {!canChangeSeats && (
                    <fieldset>
                      <legend>Test card</legend>
                      <label>Card number<input name="number" inputMode="numeric" pattern="[0-9 ]{13,23}" maxLength={23} required /></label>
                      <div className="billing-card-fields">
                        <label>Expiry month<input name="month" type="number" min="1" max="12" placeholder="MM" required /></label>
                        <label>Expiry year<input name="year" type="number" min={new Date().getFullYear()} max="2199" placeholder="YYYY" required /></label>
                        <label>CVC<input name="cvc" inputMode="numeric" pattern="[0-9]{3}" maxLength={3} required /></label>
                      </div>
                    </fieldset>
                  )}
                  {!canChangeSeats && <p>$12 per seat every 30 days.</p>}
                  <button className="primary" disabled={busy}>{canChangeSeats ? 'Update seats' : 'Subscribe'}</button>
                </>
              )}
            </form>
          )}
        </div>
      )}
    </section>
  );
}
