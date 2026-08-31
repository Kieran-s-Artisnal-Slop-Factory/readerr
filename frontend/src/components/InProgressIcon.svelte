<script lang="ts">
  /**
   * The "in progress" glyph: a circular arrow, the near-universal
   * still-going-round mark.
   *
   * Drawn inline rather than pulled from an icon set so it costs no request,
   * survives the offline/static builds, and inherits `currentColor` — which
   * is what lets the same mark read correctly on a plain button, on the
   * highlighted active state, and in every theme.
   */
  let { size = '1.05em' }: { size?: string } = $props();
</script>

<svg
  class="in-progress-icon"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2.1"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  <!-- An almost-closed circle: open at the top-right, where the head sits. -->
  <path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.13" />
  <!-- The arrowhead closing the loop. -->
  <path d="M20.6 4.1v4.7h-4.7" />
</svg>

<style>
  .in-progress-icon {
    display: block;
    flex-shrink: 0;
  }
</style>
