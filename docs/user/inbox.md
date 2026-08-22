# The Inbox — subscribing to feeds

The **Inbox** (in the nav) is where links arrive on their own. Subscribe to a
site's RSS or Atom feed and its new posts show up here — not in your backlog,
not in your reading week, just waiting for a yes or no.

That triage step is the whole point: a feed is a firehose, and your backlog is
a promise to yourself. Everything in the inbox is one of three things.

| Button | What happens |
|---|---|
| **→ Week of …** | captures the item as a link and queues it for that reading week |
| **→ Backlog** | captures it as a link, unscheduled |
| **Ignore** | dismisses it — nothing is saved, and it never comes back |

## Adding a feed

Paste the feed's URL into the box at the top of the page and pick how much
history to pull in — the default is the last **30 days**, and "nothing" means
"only what shows up from here on".

Most sites publish a feed at a predictable address:

- `https://blog.cloudflare.com/rss/`
- `https://feeds.feedburner.com/TheDailyWtf`
- or try `/rss/`, `/feed/`, `/index.xml`, `/atom.xml` on any blog

You don't have to type `https://` — it's assumed.

The window you choose is remembered on the feed, so a later refresh never
drags in the back catalogue you deliberately skipped.

## When feeds get checked

Each feed is checked **once a day**, the first time you open the Inbox on that
device. You can also:

- **Refresh** one feed, from its row in the feed list;
- **Refresh all**, from the button above the list;
- **Pause** a feed — it stays subscribed, keeps its items, and is never
  fetched until you resume it.

Each row shows when *this device* last looked and what happened
(`4 new · checked Aug 22, 12:30 AM`), plus the reason in red if the feed
couldn't be read. That timestamp is per-device on purpose, so a phone that
hasn't been opened in a week still checks when you pick it up.

## What shows up

Only items you haven't dealt with. Specifically, the Inbox hides:

- anything you already have — if an item's URL is already a link in your
  library (backlog, a reading week, favourites, anywhere), it arrives
  pre-marked as **Added**;
- anything you triaged, on this device or any other;
- anything published before the window you chose when subscribing.

The **Added** and **Ignored** tabs show what you decided, with a **Back to
inbox** button on each row if you change your mind. Sending an item back to
the inbox doesn't delete the link it created — delete that from the link
itself if you want it gone.

## Across devices

Subscriptions and triage decisions sync like everything else: subscribe on the
laptop and the phone has the feed; ignore something on the phone and it's gone
from the laptop's inbox too. If both devices happen to fetch the same feed
before syncing, you still see each item once.

## With and without a sync server

The sync server is optional in readerr, and so it is here.

- **With one**, feeds are fetched by the server. That works for every feed,
  because the restriction below is a browser rule and a server isn't a
  browser.
- **Without one** — offline mode, or a readerr hosted as a static site — your
  browser fetches the feed itself. That works for any site that permits it.

The catch is **CORS**. A site chooses whether pages on other domains may read
its files, and most feeds simply don't say yes. When one refuses, the inbox
tells you plainly:

> Your browser wasn't allowed to read *example.com* directly — the site
> doesn't send the CORS header that would permit it. Feeds like this need a
> sync server to fetch them for you.

Nothing is broken and nothing you can change on that site will help; a
[sync server](sync-and-backups.md) is the fix, and it fetches any feed.

If a sync server *is* configured but can't be reached — or is older than the
app and has no `/feed` endpoint — readerr quietly tries the browser route
before giving up, and says which part failed. A server that answers but has no
`/feed` is simply a version behind: rebuild it
(`docker compose up --build`, or `go build` + restart).

## Gotchas

- **Ignoring is permanent for that item.** The feed will keep listing the post,
  and readerr will keep skipping it. That's deliberate — otherwise every
  refresh would hand back everything you already said no to.
- **A feed that renumbers its items re-imports them.** Items are identified by
  the id the feed publishes (`<guid>` / `<id>`), falling back to the URL. A
  site that changes those — a platform migration, usually — looks like a fresh
  batch of posts.
- **Removing a feed removes its inbox items too.** Links you already saved from
  it stay in your library; only the untriaged noise goes.
- **Titles come from the feed**, not from fetching the page, so they're
  whatever the publisher wrote.
