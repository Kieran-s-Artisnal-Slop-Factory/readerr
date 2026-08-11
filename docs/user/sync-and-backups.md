# Sync & backups

readerr works completely on its own — everything is stored in your browser and
nothing needs a server. **Sync is optional**, and it does two things:

1. keeps the same data on **multiple devices**, and
2. gives you a **backup** on a machine you control.

If you only ever use one browser, you can skip syncing entirely and rely on
the exports below.

## How sync works (the short version)

Every device keeps a full copy of your data. When it syncs, it sends its
changes to the server and pulls down everyone else's. If the *same* thing was
edited in two places, the **most recent edit wins** — there's nothing to merge
by hand. You can sync in any order, on any schedule, and everyone ends up with
the same data.

Your edits **push about a second after you make them** (debounced, so a burst
of edits goes up as one push), and anything still pending is flushed when you
close or hide the tab. Writes made offline push as soon as the connection
comes back. On top of that, a full sync runs when you open the app and
roughly every 15 minutes as you use it, and **Sync now** in Settings forces a
full round trip whenever you want one.

## Turning sync on

1. Deploy a server (next section) or use one you already run.
2. On each device: **Settings → Sync**, enter the **Sync server URL**
   (e.g. `http://192.168.1.10:8080`), and **Test connection**.
3. That's it — data starts flowing. On a fresh device, choose **Sync from
   existing server** during onboarding instead, and everything pulls down
   before you even reach the app.

> If the app is *served by* the sync server (the normal Docker setup below),
> leave the URL **blank** — it syncs to the same address it loaded from.

## Turning sync off

**Settings → Sync** also has a **Sync enabled on this device** switch. Turn
it off and the device is fully local: nothing pushes or pulls, **Sync now**
is greyed out ("Sync is disabled on this device."), Sync history is hidden,
and the weekly close runs from local data without waiting for a server.
Saving a server URL turns sync back on. It's the clean way to retire a device
from a sync setup — or to stop a device waiting on a server that no longer
exists.

## Deploying your own backend

The server is a single small program with one database file. The easiest way
to run it is Docker.

### With Docker Compose (recommended)

Create a `docker-compose.yml`:

```yaml
services:
  readerr:
    image: ghcr.io/descent098/readerr:latest
    ports:
      - "8080:8080"          # open http://<host>:8080
    volumes:
      - ./data:/data         # your database, as a real file on the host
    restart: unless-stopped
```

Then:

```sh
docker compose up -d
```

Open **http://localhost:8080** (or your server's address). The app and the
sync API are served together, so on that machine the sync URL stays blank.
Your database lives at **`./data/readerr.db`** next to the compose file — a
real file you can copy or back up.

To serve on the standard HTTP port instead, change the mapping to `"80:8080"`.

### With plain Docker

```sh
docker run -d --name readerr \
  -p 8080:8080 \
  -v "$PWD/data:/data" \
  ghcr.io/descent098/readerr:latest
```

### Notes

- **No password.** The server trusts its network — great for a home LAN or a
  single user. To put it on the public internet, run it behind a reverse proxy
  (Caddy, nginx, Traefik) that adds HTTPS and access control.
- **It's just one file.** Back up `./data/readerr.db` and you've backed up the
  server. The database upgrades itself automatically when you update the image.
- Full operator details (ports, multi-arch images, CI, HTTPS, building from
  source) are in the developer guide:
  [docs/dev/deployment.md](../dev/deployment.md).

## Using more than one device

Point each device at the same server URL. Onboard new devices with **Sync from
existing server** so they arrive pre-loaded. After that they stay in step
automatically.

### If both sides already have data

When you connect a device that *already* has links to a server that *also*
already has data, readerr asks how to combine them:

- **Merge both** (recommended) — combine everything; newest edit wins per
  item. Nothing is lost.
- **Use server data** — replace this device with the server's copy. The
  confirmation warns that local-only rows — archived links — are cleared
  too, so export a backup first if you need them.
- **Use local data** — wipe the server and replace it with this device's copy.

Pick **Merge** unless you specifically want one side to overwrite the other.
(A caveat about "Use local data" and *other* already-synced devices is in
[gotchas](gotchas.md#i-chose-use-local-data-and-rows-i-wiped-reappeared).)

## Backups and exports

Sync is **not a backup** — a bad edit would sync everywhere. For real backups,
use **Settings → Backup**:

- **Export JSON** — a complete snapshot of everything. Re-importing it replaces
  all local data. This is your disaster-recovery file.
- **Export Markdown** — every topic, tag, and link (with notes and excerpts)
  as plain `.md` files. Your writing is never locked in.
- **Curated / time-range / template exports** — smaller, mergeable slices for
  sharing or moving structure between installs.
- On the server itself, visiting `/backup` downloads the database file.

Importing a backup on the welcome screen is also how you onboard from a file
instead of a server.

## Watching sync health

**Settings → Sync** shows the last sync time or the last error. Expand **Sync
history** (shown only while sync is enabled) for a log of recent syncs, with
options for how much to track (all errors, only real errors ignoring offline
blips, or none) and how long to keep it. Counters for errors, successful
syncs, and last-synced are always shown.
