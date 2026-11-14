<script lang="ts">
  import { device } from '../lib/device.svelte';

  const t = (ms: number) => new Date(ms).toLocaleTimeString();
</script>

<details class="card">
  <summary>Log ({device.log.length})</summary>
  <div class="log mono">
    {#each device.log.slice().reverse() as l, i (device.log.length - i)}
      <div class={l.dir}><span class="muted">{t(l.t)}</span> {l.dir} {l.text}</div>
    {/each}
  </div>
</details>

<style>
  summary {
    cursor: pointer;
    color: var(--muted);
  }
  .log {
    max-height: 200px;
    overflow: auto;
    font-size: 11px;
    margin-top: 8px;
  }
  .info {
    color: var(--warn);
  }
</style>
