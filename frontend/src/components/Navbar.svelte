<script>
  import { onMount } from 'svelte';
  import { href } from '../lib/paths';

  let { currentPath = '/' } = $props();
  let open = $state(false);
  let online = $state(true);

  onMount(() => {
    // Opportunistic background sync, throttled internally.
    import('../lib/sync').then(({ maybeAutoSync }) => maybeAutoSync());

    online = navigator.onLine;
    const goOnline = () => (online = true);
    const goOffline = () => (online = false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  });

  const links = [
    { href: href('/'), label: 'Backlog' },
    { href: href('/week/'), label: 'This Week' },
    { href: href('/tags/'), label: 'Tags' },
    { href: href('/topics/'), label: 'Topics' },
    { href: href('/favourites/'), label: 'Favourites' },
    { href: href('/resources/'), label: 'Resources' },
    { href: href('/slush/'), label: 'Slush' },
    { href: href('/settings/'), label: 'Settings' },
  ];

  const normalize = (p) => p.replace(/\/+$/, '') || '/';
  const isCurrent = (linkHref) => normalize(linkHref) === normalize(currentPath);
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
      <a
        href={link.href}
        aria-current={isCurrent(link.href) ? 'page' : undefined}
        onclick={() => (open = false)}
      >
        {link.label}
      </a>
    {/each}
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

  @media (max-width: 40rem) {
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
  }
</style>
