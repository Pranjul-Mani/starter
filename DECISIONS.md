# Decisions

The first slice uses the supplied Express scaffold and MongoDB. A unique workspace and provider message ID identifies an inbound message. A unique workspace and client reference identifies a reply. The server verifies the timestamp and HMAC against the raw webhook body. The inbox snapshot orders incoming messages by provider timestamp and uses the message ID to break ties.

The outbound worker stores a retry time before making each provider call. An interrupted send becomes eligible again after that time, and retries reuse the same Pigeon idempotency key. Terminal delivery states take precedence over a late sent update. A conditional MongoDB update gives a conversation one assignee and allows that same agent to repeat their claim.

The worker paces each workspace within one server instance. Shared provider throttling across server instances remains open. Login, the React inbox, conversation lifecycle controls, and WebSocket replay are pending. Optional encrypted notes, search, and billing are outside this first slice.
