# Sync

readerr is **local-first**: everything lives in your browser's IndexedDB and
the app is fully functional with no server at all. Syncing is optional — a
small Go backend acts as a backup target and a hub that keeps multiple
devices converging on the same data. This document covers every sync-related
feature.

## The model in one paragraph

Each device holds a complete copy of the data. A sync is a **push** followed
by a **pull**: the device sends every row it created or changed since its
last push; the server accepts each row under **last-write-wins** (the row
with the newer `updated_at` timestamp wins, per row — not per field) and
stamps it with the next value of a single global counter (`server_seq`). The
pull then asks for "everything past the counter value I last saw", and
applies those rows locally under the same last-write-wins rule. Deletions
sync too: deleted rows become *tombstones* (marked, not removed), so a
delete on one device propagates to the others.

What this means in practice:

- **Edits never block.** There are no sync conflicts to resolve by hand; if
  the same item was edited on two devices, the most recent edit wins.
- **Notes are safe from flag flips.** Long-form notes live in their own rows,
  so favouriting a link on your phone can't clobber the note you're writing
  on your desktop.
- **Order doesn't matter.** Devices can sync in any order, any number of
  times; everyone converges on the same state.

## Modes

- **Sync mode** (default): background sync runs once per browser session and
  then at most every 15 minutes as you navigate, plus whenever you hit
  **Sync now**. The backend also resolves page titles for captured links.
- **Offline mode** (chosen in onboarding): no network calls, ever. You can
  opt back in at any time by entering a server URL in Settings.

## Setting up a server

The backend is a single binary (or Docker container) with an SQLite file:

```
DB_PATH=readerr.db PORT=8080 ./readerr
```

Point the app at it under **Settings → Sync**:

- **Blank URL = same origin.** If the backend serves the built frontend
  (the Docker image does), leave the URL empty.
- Otherwise enter it explicitly, e.g. `http://192.168.1.10:8080`.
- **Test connection** probes the server's `/healthz` and explains common
  failures (wrong path, proxy in the way, server down) in plain terms.

There is **no auth** — the server trusts its network. Run it on a LAN or
behind whatever access control you already trust (VPN, reverse proxy).

## Onboarding with an existing server

If you already run a backend and are setting up a new device, choose
**Sync from existing server** on the very first onboarding screen, enter the
URL, and hit *Connect & sync*. The device pulls everything — links, notes,
tags, topics, weeks, plans, settings — and lands you on the Reading List.
No walkthrough needed; your setup travels with your data.

(Onboarding steps can also be deep-linked: `/onboarding?page=2` opens the
walkthrough on a specific step.)

## Pointing at a new server: conflict options

Entering a **different** server URL in Settings makes the app probe both
sides. Depending on what it finds:

- **Server empty:** your local data simply pushes up. Nothing to decide.
- **Local empty, server has data:** the server copy downloads. This is the
  default — a fresh device just adopts the existing dataset.
- **Both sides have data:** a panel asks you to choose:

  | Option | What happens |
  |---|---|
  | **Merge both** (recommended) | Server data downloads, combines with local under last-write-wins per item, and the result pushes back. Nothing is lost; duplicates by id resolve to the newest edit. |
  | **Use server data** | This device is wiped (including local-only data like archived links) and replaced with the server copy. Asks for confirmation. |
  | **Use local data** | The **server** is wiped and repopulated with this device's copy. Other devices syncing to it will converge on this dataset. Asks for confirmation. |

Switching servers also resets the device's sync bookkeeping (cursors and
server-assigned sequence numbers), so the first sync against the new server
exchanges complete datasets rather than assuming shared history.

## Sync history & status

**Settings → Sync** shows the last sync time or the last error (with an
explanation of what the HTTP status likely means). Below it, the
**Sync history** accordion keeps a local log:

- **Track errors**: all errors, only *explicit* errors (failures while your
  device was simply offline are ignored), or none.
- **Keep history for N days** (default 30) — older events are pruned
  automatically.
- **Track successful syncs too** — off by default; background sync runs on
  nearly every page load, so success rows accumulate fast.
- A stat line always tracks totals (errors, successful syncs, last synced)
  even when event logging is off, and the log paginates at 30 events.

The history never syncs and is excluded from backups — it's device-local
diagnostics.

## Backups vs sync

Sync is not a backup — a bad edit propagates everywhere. For real backups:

- **Settings → Backup → Export JSON** — a complete client-side snapshot
  (tombstones included); importing one replaces all local data.
- **`GET /backup`** on the server — downloads the SQLite file itself.
- **Export Markdown** — every topic, tag, and link as plain markdown files,
  so your prose is never locked in.

## Title fetching

When a link is pasted without a title and **Automatically title bare links**
(Settings → Link handling) is on, the backend fetches the page and extracts
its title — servers can read cross-origin pages that browsers can't. In
offline mode titles aren't fetched at all; links keep their URL as the title
until you edit one in.

## Endpoint reference

| Endpoint | Purpose |
|---|---|
| `GET /healthz` | Liveness probe (used by *Test connection*). |
| `POST /sync/push` | Accept client rows (LWW, stamps `server_seq`). |
| `GET /sync/pull?since=N` | Rows with `server_seq > N`, tombstones included. |
| `GET /sync/stats` | `{latestSeq}` — cheap "does this server have data?" probe. |
| `POST /sync/reset` | Wipe all server data and restart the sequence (the *Use local data* option). |
| `GET /backup` | Download the server's SQLite file. |
| `GET /title?url=…` | Server-side page-title fetch for captured links. |
| `GET /dbsize` | Server database size in bytes (shown on the Stats page). |

## Troubleshooting

- **"Cannot reach the sync server"** — check the URL, that the server is
  running, and that nothing (firewall, VPN) is between you and it. Offline
  failures are expected and harmless; sync retries on the next interval.
- **404 on sync** — the URL points at something that isn't a readerr
  backend (a plain web server, or a stale URL after moving servers).
- **400 on push** — app and server versions likely disagree; update both to
  the same version.
- **A device shows old data** — open Settings and hit **Sync now**;
  background sync is throttled to every 15 minutes.
- **Moved to a new server and data didn't transfer** — configure the new
  URL in Settings and pick a conflict option; don't copy browser data
  around by hand.
