# Switchboard

Switchboard is a shared support inbox for teams using the simulated Pigeon messaging provider. Agents sign in with the mock identity provider, switch between their workspaces, claim and resolve conversations, and send replies. Delivery status and inbox changes update live.

## Run from a clean checkout

Install Node.js 22 or later and start Docker Desktop or Docker Engine. From the repository root, install dependencies and start the local services.

```sh
npm run scaffold:install
npm run up
```

Start the backend and frontend in separate terminals.

```sh
npm run scaffold:server
```

```sh
npm run scaffold:web
```

Open [the inbox](http://localhost:5173) and select **Sign in**. Choose Ben Ortiz to try the Acme inbox or Eli Novak to try both Acme and Globex. Run `npm run inbound` in another terminal to generate a sample message. The backend listens on port 4000 by default. Its readiness endpoint is [`/healthz`](http://localhost:4000/healthz).

For a Docker-free setup, run `npm run mocks` and set `MONGO_URL` to an accessible MongoDB instance. See `.env.example` for service addresses and secrets. If the backend uses a different port in development, set `SWITCHBOARD_API_URL` before starting Vite.

## Paybox billing

Choose Asha Rao for Acme or Chloe Martin for Globex and open **Billing**. Use Paybox's test cards from `PAYBOX.md`. The billing screen supports seat changes and bank approval. Paybox must be reachable from the browser for tokenization. When the backend reaches Paybox through an internal URL, set `PAYBOX_PUBLIC_URL` to the browser-facing address.

## Verify

```sh
npm run check
npm run check:full
```

The grader starts its own server on port 4000 and resets application data. Stop the development backend and use a disposable database. Use a native Linux filesystem for the crash tests. In our Windows Docker run, executing dependencies directly from a bind mount made restart slower than Pigeon's retry window.

The checked-in `CHECK_REPORT.json` records **75/75** across Levels 1, 2, 3, and 5. Level 4 is run privately.
