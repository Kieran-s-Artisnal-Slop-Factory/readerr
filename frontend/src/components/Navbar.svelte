<script>
  import { onMount } from 'svelte';
  import { href } from '../lib/paths';

  let { currentPath = '/' } = $props();
  let open = $state(false);
  let online = $state(true);
  let collectionsOpen = $state(false);
  let plansOpen = $state(false);
  let archiveEnabled = $state(false);

  onMount(() => {
    // Opportunistic background sync (throttled internally), plus the
    // reconnect/page-hide flush so offline or just-made writes still push.
    import('../lib/sync').then(({ maybeAutoSync, installSyncFlush }) => {
      installSyncFlush();
      maybeAutoSync();
    });
    // The Archive collection only appears once archival mode is enabled.
    import('../lib/services/settings').then(async ({ getUserSettings }) => {
      archiveEnabled = (await getUserSettings())?.archive_enabled ?? false;
    });
    // Trim the hot store in the background when archival is on (throttled).
    import('../lib/services/archive').then(({ maybeAutoArchive }) => maybeAutoArchive());

    online = navigator.onLine;
    const goOnline = () => (online = true);
    const goOffline = () => (online = false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    // Close any open dropdown on a click outside the nav dropdowns.
    const closeMenus = (e) => {
      if (!e.target.closest?.('.navdrop')) {
        collectionsOpen = false;
        plansOpen = false;
      }
    };
    window.addEventListener('click', closeMenus);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('click', closeMenus);
    };
  });

  const links = [
    { href: href('/'), label: 'Reading List' },
    { href: href('/inbox/'), label: 'Inbox' },
    { href: href('/stats/'), label: 'Stats' },
  ];

  const plans = [
    { href: href('/plan/'), label: 'Automation' },
    { href: href('/upcoming/'), label: 'Upcoming weeks' },
  ];

  // Backlog and Favourites live here too: they are collections of links, not
  // destinations of their own, and the top row stays short enough to breathe.
  const collections = $derived([
    { href: href('/backlog/'), label: 'Backlog' },
    { href: href('/favourites/'), label: 'Favourites' },
    { href: href('/tags/'), label: 'Tags' },
    { href: href('/topics/'), label: 'Topics' },
    { href: href('/resources/'), label: 'Resources' },
    { href: href('/slush/'), label: 'Slush' },
    ...(archiveEnabled ? [{ href: href('/archive/'), label: 'Archive' }] : []),
  ]);

  const settingsHref = href('/settings/');

  const normalize = (p) => p.replace(/\/+$/, '') || '/';
  const isCurrent = (linkHref) => normalize(linkHref) === normalize(currentPath);
  // Detail pages count toward their collection (e.g. /tag/ under Tags).
  const inCollections = () =>
    collections.some((c) => isCurrent(c.href)) ||
    ['/tag', '/topic', '/resource-list', '/link'].some((p) => normalize(currentPath).startsWith(p));
  const inPlans = () => plans.some((p) => isCurrent(p.href));

  function toggleCollections() {
    collectionsOpen = !collectionsOpen;
    plansOpen = false;
  }
  function togglePlans() {
    plansOpen = !plansOpen;
    collectionsOpen = false;
  }
  function closeAll() {
    open = false;
    collectionsOpen = false;
    plansOpen = false;
  }
</script>

<header class="navbar">
  <a class="brand" href={href('/')}>read<span>err</span></a>

  {#if !online}
    <span class="offline-badge" title="You're offline — everything keeps working from this device">
      offline
    </span>
  {/if}

  <button
    class="hamburger"
    aria-expanded={open}
    aria-controls="site-nav"
    aria-label="Toggle navigation"
    onclick={() => (open = !open)}
  >
    <span class="bar"></span>
    <span class="bar"></span>
    <span class="bar"></span>
  </button>

  <nav id="site-nav" class:open>
    {#each links as link}
      <a href={link.href} aria-current={isCurrent(link.href) ? 'page' : undefined} onclick={closeAll}>
        {link.label}
      </a>
    {/each}

    <div class="navdrop">
      <button
        type="button"
        class="navdrop-toggle"
        class:active={inPlans()}
        aria-expanded={plansOpen}
        aria-haspopup="true"
        onclick={togglePlans}
      >
        Plans <span class="caret">{plansOpen ? '▴' : '▾'}</span>
      </button>
      <span class="navdrop-label">Plans</span>
      <div class="navdrop-menu" class:open={plansOpen} role="menu">
        {#each plans as link}
          <a href={link.href} role="menuitem" aria-current={isCurrent(link.href) ? 'page' : undefined} onclick={closeAll}>
            {link.label}
          </a>
        {/each}
      </div>
    </div>

    <div class="navdrop">
      <button
        type="button"
        class="navdrop-toggle"
        class:active={inCollections()}
        aria-expanded={collectionsOpen}
        aria-haspopup="true"
        onclick={toggleCollections}
      >
        Collections <span class="caret">{collectionsOpen ? '▴' : '▾'}</span>
      </button>
      <span class="navdrop-label">Collections</span>
      <div class="navdrop-menu" class:open={collectionsOpen} role="menu">
        {#each collections as link}
          <a href={link.href} role="menuitem" aria-current={isCurrent(link.href) ? 'page' : undefined} onclick={closeAll}>
            {link.label}
          </a>
        {/each}
      </div>
    </div>

    <a
      class="settings-link"
      href={settingsHref}
      aria-label="Settings"
      title="Settings"
      aria-current={isCurrent(settingsHref) ? 'page' : undefined}
      onclick={closeAll}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
      <span class="settings-text">Settings</span>
    </a>
  </nav>
</header>

<style>
  .navbar {
    position: sticky;
    top: 0;
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    height: var(--navbar-height);
    padding-inline: var(--space-4);
    background: var(--surface-color);
    border-bottom: 1px solid var(--border-color);
  }

  .brand {
    font-weight: 800;
    font-size: var(--font-size-lg);
    text-decoration: none;
    color: var(--text-color);
    letter-spacing: -0.02em;
  }

  .brand span {
    color: var(--color-primary);
  }

  .offline-badge {
    background: var(--color-warning);
    color: var(--bg-color);
    border-radius: var(--radius-full);
    padding: 0 var(--space-2);
    font-size: var(--font-size-sm);
    font-weight: 700;
    margin-right: auto;
  }

  nav {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  nav a {
    text-decoration: none;
    color: var(--text-muted-color);
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-full);
    font-weight: 600;
    font-size: var(--font-size-sm);
  }

  nav a:hover {
    color: var(--text-color);
  }

  nav a[aria-current='page'] {
    background: var(--color-primary-soft);
    color: var(--color-primary-strong);
  }

  .navdrop {
    position: relative;
  }

  .navdrop-toggle {
    border: none;
    background: none;
    color: var(--text-muted-color);
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-full);
    font-weight: 600;
    font-size: var(--font-size-sm);
    cursor: pointer;
    font-family: inherit;
  }

  .navdrop-toggle:hover {
    color: var(--text-color);
  }

  .navdrop-toggle.active {
    background: var(--color-primary-soft);
    color: var(--color-primary-strong);
  }

  .caret {
    font-size: 0.7em;
  }

  /* Mobile-only group label; hidden on desktop. */
  .navdrop-label {
    display: none;
  }

  .navdrop-menu {
    display: none;
    position: absolute;
    top: calc(100% + var(--space-1));
    right: 0;
    min-width: 10rem;
    flex-direction: column;
    background: var(--surface-raised-color);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-2);
    padding: var(--space-1);
    z-index: 20;
  }

  .navdrop-menu.open {
    display: flex;
  }

  .navdrop-menu a {
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-3);
  }

  .settings-link {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    line-height: 0;
  }

  .settings-text {
    display: none;
  }

  .hamburger {
    display: none;
    flex-direction: column;
    justify-content: center;
    gap: 5px;
    width: 2.5rem;
    height: 2.5rem;
    background: none;
    border: none;
    cursor: pointer;
    padding: var(--space-2);
  }

  .bar {
    height: 2px;
    width: 100%;
    background: var(--text-color);
    border-radius: var(--radius-full);
    transition: transform 0.2s ease, opacity 0.2s ease;
  }

  @media (max-width: 48rem) {
    .hamburger {
      display: flex;
    }

    .hamburger[aria-expanded='true'] .bar:nth-child(1) {
      transform: translateY(7px) rotate(45deg);
    }

    .hamburger[aria-expanded='true'] .bar:nth-child(2) {
      opacity: 0;
    }

    .hamburger[aria-expanded='true'] .bar:nth-child(3) {
      transform: translateY(-7px) rotate(-45deg);
    }

    nav {
      display: none;
      position: absolute;
      top: var(--navbar-height);
      left: 0;
      right: 0;
      flex-direction: column;
      align-items: stretch;
      background: var(--surface-color);
      border-bottom: 1px solid var(--border-color);
      padding: var(--space-3);
      box-shadow: var(--shadow-2);
    }

    nav.open {
      display: flex;
    }

    nav a {
      padding: var(--space-3);
      font-size: var(--font-size-base);
    }

    /* On mobile the dropdowns flatten into labelled groups. */
    .navdrop-toggle {
      display: none;
    }

    .navdrop-label {
      display: block;
      padding: var(--space-2) var(--space-3) 0;
      font-size: var(--font-size-sm);
      color: var(--text-muted-color);
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .navdrop-menu {
      display: flex;
      position: static;
      border: none;
      background: none;
      box-shadow: none;
      padding: 0 0 0 var(--space-3);
    }

    .settings-link {
      line-height: inherit;
    }

    .settings-text {
      display: inline;
    }
  }
</style>
