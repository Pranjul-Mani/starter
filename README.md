# Switchboard

Switchboard is a shared support inbox for businesses using the simulated Pigeon messaging provider. The current implementation covers the initial messaging backend.

## Run locally

Use Node.js 22 or later. From the repository root:

```sh
npm run scaffold:install
npm run up
npm run start:server
```

Without Docker, run `npm run mocks` in a separate terminal and point `MONGO_URL` at a running MongoDB instance. See `.env.example` for the service URLs and other settings. The server listens on `PORT` and serves `GET /healthz` once its database indexes are ready.

`npm run inbound` sends a sample incoming message. `npm run check` starts the server itself on a grader-selected port. Stop the development server before running the check and use a disposable MongoDB database because the check resets application data. The supplied grader invokes `sh`. On Windows, make Git Bash available on PATH or use a Linux environment.
