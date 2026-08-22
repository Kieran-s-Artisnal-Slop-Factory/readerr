# Layman's critique — what a first-time user can't work out

**Stance:** I have never seen readerr. I have not read the docs and I never
will. Everything below is what I could and couldn't work out from the screen
in front of me, in the order I hit it. Where I say "I assumed", that assumption
is the design's output, not my mistake.

This is deliberately adversarial: I am not listing what works.

---

## 1. Onboarding asks me to choose before I know anything

The first screen offers four buttons:

> **Show me around** · **Start from scratch** · **Sync from existing server** ·
> **Import a backup file**

Three of those are for people who have used readerr before. As a new user I
have one real option, and it is not visually distinguished from the three that
don't apply to me. "Start from scratch" also sounds slightly alarming, like it
might erase something.

**What I'd expect:** one primary action ("Get started") with the returning-user
paths demoted to a single line — *"Already have readerr? Sync from a server or
import a backup."*

## 2. "Backlog" and "Reading List" are the same word to me

The nav's top row says **Reading List**, and the Collections menu contains
**Backlog**. Both are lists of links I intend to read. I could not tell you
which one a new link goes into, and the app never says.

The distinction that actually exists — *this week* versus *everything else* —
is a good one, but neither label carries it. "Reading List" in particular
sounds like the complete list, which is the opposite of what it is.

**What I'd expect:** name them for the distinction. **This Week** and
**Everything** (or **Saved**) would need no explanation at all.

## 3. "Slush" means nothing

Collections → **Slush**. I clicked it because I had no idea what it was, which
is not a design win. The page then told me:

> Read links that weren't favourited or referenced in a topic.

That is a clear sentence — but it is one click *past* where I needed it, and
"slush" still isn't a word I'd use for that. 908 items are in mine already and
I never chose to put anything there.

**What I'd expect:** call it **Archive** or **Read & filed**, or drop the
concept from the nav entirely and make it a filter on the main list ("read,
nothing kept"). If the word stays, the nav item needs a one-line description on
hover or under the heading.

## 4. I don't know the difference between a tag and a topic

Both are in Collections. Both attach to links. Both have their own pages. The
only visible difference is that a topic has a big text editor on it, which I
discovered by accident.

Nothing on either page tells me *when to use which*. My honest guess after
using it for ten minutes: tags are words, topics are… also words? I would
almost certainly use only tags and never discover what topics are for.

**What I'd expect:** one sentence on each index page — *"Tags label links.
Topics are documents you write, that cite links."* — and, on the link row, a
visible difference between the two chip types beyond a small `§`.

## 5. The ✓ button does something I didn't ask for

On a backlog row, **✓** looks like "mark as read". It also silently files the
link into the current week's reading list. I only noticed because my week
suddenly had entries I never scheduled.

This one is worth calling out sharply: it is the only control in the app whose
side effect is bigger than its label, and the project's own docs list it under
"gotchas". A gotcha in the docs is a bug in the UI.

**What I'd expect:** either the ✓ just marks read, or the button says what it
does (`✓ Read this week`) and the row shows the week chip appearing.

## 6. The capture box speaks a language I don't

Under the paste box:

> Per-line options: `!tags=[a,b]` `!topics=[x]` `!list=[y]` `!week=2`
> `!priority=1` `!favourite` `!done` `!resource` `!clean=false`

That's nine commands with three different syntaxes (bare flag, `=value`,
`=[list]`) shown to someone who has not yet pasted their first link. I skipped
it entirely and used the dropdowns underneath — which do most of the same
things, so I never learned why the text version exists.

**What I'd expect:** hide it behind "Advanced: type options instead" and show
the syntax when I actually type a `!`. The controls below are enough for a
first paste.

## 7. Priority 1–3 with no scale shown

The capture box has a **Priority** dropdown: `1 — top`, `2 — soon`,
`3 — default`. Rows then show a small `P1` chip. Is 1 high or low? I inferred
"top" means high, but the number ordering is backwards from every star rating
I've used, and `P1`/`P2` alone (on the row) has no legend anywhere.

**What I'd expect:** words, not numbers — **Top / Soon / Someday** — or at
minimum spell the chip out as "Top priority" on hover *and* on the row.

## 8. "Close week" sounds destructive and irreversible

There's a red-adjacent button at the bottom of the reading list: **Close week**.
I did not press it for three days. Nothing on the page tells me what closing
does, whether I can reopen, or what happens to what I didn't read.

The behaviour turns out to be reasonable (kept things stay, the rest returns).
The button just never says so.

**What I'd expect:** a subtitle under the button, or a confirm dialog that
states the outcome in plain words: *"Anything you wrote about is kept.
Everything unread goes back to Everything. You can still look at this week
afterwards."*

## 9. The inbox and the backlog look like the same idea twice

The Inbox has items with three buttons: **→ August 17-23**, **→ Backlog**,
**Ignore**. So the inbox is a list of links I might save, and the backlog is a
list of links I have saved. Once I know that, it's fine — but the two live in
completely different parts of the nav (Inbox top-level, Backlog inside
Collections) and share no visual language.

Also: **→ August 17-23** as a button label made me stop and work out what the
date range was. It is the current week, which the app knows.

**What I'd expect:** label it **→ This week**, with the dates as the tooltip.
And put Inbox next to whatever it feeds.

## 10. Nothing tells me what's mine and what's synced

The nav shows an "offline" badge sometimes. Settings has a sync switch. The
inbox says something about a sync server. I could not tell you, as a normal
user, whether my links are on someone's server, in this browser, or both — and
that is the question people care most about.

**What I'd expect:** one line in Settings, and one in onboarding: *"Everything
is stored in this browser. A sync server (optional) copies it between your
devices."*

## 11. Small things that cost me a beat each

- **Icon-only buttons.** `✓ ★ ⚒ # › ⠿ ✕` in one row, all the same size and
  colour. `⚒` for "resource" is not guessable — I read it as "settings", then
  "broken". `#` for tags is fine; `›` for "open" I assumed was "next page".
- **"Resource" vs "Resource list"** are different features one word apart.
- **The `+` floating button** and the capture box do the same thing on pages
  that have both, and only one of them is visible on the page that matters most.
- **Empty states point nowhere.** "No tags yet." is true, but it doesn't say
  how tags get made (from the capture box, or a link's `#` panel).
- **Stats calls a number "Variability".** The card explains it, but the word
  is doing no work — "How spread out your reading is" *is* the title.
- **Two dropdowns in the nav** hide nine destinations. On first run I did not
  find Topics, Resources or Plans at all; I only found them by clicking every
  menu deliberately.

---

## The three simplifications I'd make first

1. **Rename for the distinction, not the mechanism.** Reading List → *This
   Week*; Backlog → *Everything*; Slush → *Read & filed*. Three renames remove
   most of my confusion above and cost nothing structurally.
2. **Make the ✓ honest.** Either drop the hidden week filing or put it in the
   label. This is the only place the app surprised me twice.
3. **Say what each collection is for, on the page.** One sentence under each
   heading: Tags, Topics, Resources, Slush, Series, Inbox. Six sentences total,
   and the entire vocabulary problem goes away without renaming anything else.

## What I'd leave alone

The parts I understood with no help at all: the paste box (it is obvious that
you paste links into it), the week's drag handles, the series row expanding to
its parts with a `2/5` count, and the search-and-filter toolbar. Those need no
words — which is exactly why the rest stands out.
