<script lang="ts">
  import { device } from '../lib/device.svelte';

  let typed = $state('');
  let open = $state(false);
  let msg = $state<string | null>(null);

  async function format() {
    msg = null;
    try {
      await device.format();
      msg = 'Every sound was deleted.';
      typed = '';
      open = false;
    } catch (e) {
      msg = (e as Error).message;
    }
  }
</script>

<details class="card" bind:open>
  <summary>Danger zone</summary>
  <p>FORMAT deletes every sound on the device. Type <strong class="mono">WIPE</strong> to confirm.</p>
  <div class="row">
    <input bind:value={typed} placeholder="WIPE" spellcheck="false" autocomplete="off" />
    <button class="danger solid" type="button" disabled={typed !== 'WIPE' || !device.connected || device.busy} onclick={format}>Format device</button>
  </div>
  {#if msg}<p class="muted">{msg}</p>{/if}
</details>

<style>
  summary {
    cursor: pointer;
    color: var(--danger);
  }
  p {
    margin: 8px 0;
  }
</style>
