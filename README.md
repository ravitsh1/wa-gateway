# wa-gateway

Self-hosted WhatsApp gateway for a **personal number**. It connects as a linked device
(the same mechanism as WhatsApp Web, via [Baileys](https://baileys.wiki)), forwards messages of
explicitly tracked 1:1 chats to client apps through signed webhooks, and lets those apps send
text replies. MyBase is the first client; other apps can be added in `clients.json`.

> This is an unofficial connection. It is against WhatsApp's terms of service and the number can
> be restricted or banned. The gateway keeps the risk low (no bulk sending, spaced sends, replies
> only inside tracked chats) but cannot remove it. Approving every outgoing message is the
> client's responsibility: the gateway sends whatever a client asks it to send.

## What it does and does not do

- Only **1:1 chats that a client tracked by phone number**, and **groups an admin client tracked
  by their id**, are processed. Statuses, newsletters and every untracked chat or group are
  dropped in memory: nothing is stored or logged.
- Groups are **read only**: their messages are forwarded, and there is no way to send into one.
  Videos and stickers of a group are not downloaded (`media.error` is `skipped`).
- A chat is forwarded **from the moment it was tracked**. History sync is off; older messages
  are ignored.
- Both directions are forwarded (incoming, and what you send from your phone), so the client
  sees the whole conversation.
- Text, voice notes, images, videos, documents, stickers, locations and contact cards. Media is
  downloaded to disk and served to the tracking client until it expires.
- The gateway is a relay, not an archive. It keeps: the tracked list, webhooks not delivered yet,
  and media files, the last two for `RETENTION_HOURS` (default 72) at most. Analysis
  (AI, transcription) belongs in the client.
- The account is not marked online, so the phone keeps its notifications.

## Run

Requires Node 22.13+.

```bash
npm ci
cp .env.example .env
cp clients.example.json clients.json     # fill in; keys with: openssl rand -hex 32
npm run build
npm start
```

Pair once: `GET /v1/session` returns `qr` / `qrImage` (a PNG data URL) while `state` is `qr`.
Scan it in WhatsApp → Linked devices. The session keys are stored in `DATA_DIR/auth`;
anyone holding that folder can read and send as the account, so keep it private (`chmod 700`,
outside any web root, not in backups that leave the server).

`npm test` builds and runs the tests (no WhatsApp connection needed).

### On the server (systemd)

See `deploy/wa-gateway.service`. The process listens on `127.0.0.1` only. If the client app runs
on the same server it can call `http://127.0.0.1:3040` directly and nothing has to be exposed.

## API

All `/v1` routes need `Authorization: Bearer <apiKey>`. Phones accept any common format
(`050-1234567`, `+972 50 123 4567`) and are returned as international digits (`972501234567`).
Errors: `{ "error": "<code>", "message": "..." }`.

| Method | Path | |
|---|---|---|
| GET | `/health` | No auth. `{ ok, session }` |
| GET | `/v1/session` | Admin clients. `{ state, phone, qr, qrImage, pendingWebhooks }`; `state` is `starting`, `qr`, `connected`, `disconnected` or `logged_out` |
| POST | `/v1/session/logout` | Admin clients. Unlinks the device and deletes the session keys |
| GET | `/v1/chats` | Chats this client tracks |
| PUT | `/v1/chats/:phone` | Start tracking. Optional body `{ "label": "..." }` |
| DELETE | `/v1/chats/:phone` | Stop tracking; stored media of the chat is deleted |
| GET | `/v1/groups` | Admin clients. `{ groups: [{ id, name, participants, tracked }] }`, asked from WhatsApp (`503 not_connected` while offline) |
| PUT | `/v1/groups/:id` | Admin clients. Start tracking a group (`id` as listed, e.g. `120363...@g.us`). Optional body `{ "label": "..." }` |
| DELETE | `/v1/groups/:id` | Admin clients. Stop tracking; stored media of the group is deleted |
| POST | `/v1/messages` | `{ "phone", "text" }` → `{ phone, id }`. Only to a chat this client tracks (`403 chat_not_tracked`), only while connected (`503 not_connected`) |
| GET | `/v1/media/:id` | The file, for a client that tracks the chat it came from |

Outgoing messages are sent one at a time with at least `SEND_MIN_INTERVAL_MS` between them.

## Webhooks

Each event is POSTed as JSON to the client's `webhookUrl`:

```
X-WA-Timestamp: <unix seconds>
X-WA-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>" with webhookSecret>
```

Verify the signature over the raw body and reject old timestamps. Answer 2xx quickly; anything
else is retried (5s, 10s, 20s … up to hourly) for `RETENTION_HOURS`, in order, so a failing
endpoint delays later events. Delivery is at-least-once: de-duplicate on `message.id`.

```jsonc
{
  "event": "message",
  "deliveryId": "uuid",
  "chat": { "phone": "972501234567" },   // for a group: { "group": "120363...@g.us" }
  "message": {
    "id": "3EB0...",
    "direction": "in",            // "out" = sent by the account owner (phone or API)
    "sentViaApi": false,          // true when this client-sent message echoes back
    "timestamp": 1795194193,      // unix seconds
    "kind": "audio",              // text | audio | image | video | document | sticker | location | contact | other
    "text": null,                 // text or media caption
    "senderName": "Dana",         // in a group: the member who wrote
    "media": {
      "id": "uuid", "url": "https://.../v1/media/uuid",   // null when error is set
      "mime": "audio/ogg", "filename": null, "size": 18234,
      "seconds": 12, "voice": true,
      "error": null               // "too_large" | "download_failed"
    },
    "location": null,             // { latitude, longitude, name }
    "contact": null               // { name, vcard }
  }
}
```

Admin clients also get `{ "event": "session", "deliveryId", "session": { "state", "phone" } }`
when the connection state changes, e.g. to alert when the device was unlinked.

## Not in this version

Sending media, quoted replies, edits / deletions / reactions, sending into groups.
