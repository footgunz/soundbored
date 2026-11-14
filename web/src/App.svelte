<script lang="ts">
  import ConnectBar from './components/ConnectBar.svelte';
  import DangerZone from './components/DangerZone.svelte';
  import Grid from './components/Grid.svelte';
  import Log from './components/Log.svelte';
  import SlotPanel from './components/SlotPanel.svelte';
  import { device } from './lib/device.svelte';
  import { SLOT_AUTO } from './lib/protocol';

  let selected = $state<number | null>(null);
  let pendingFile = $state<File | null>(null);
  let panelKey = $state(0);

  function select(slot: number, file: File | null = null) {
    selected = slot;
    pendingFile = file;
    panelKey++;
  }

  // Without Web MIDI there is nothing else to connect to.
  if (!device.midi.supported) void device.connectMock();

  const ready = $derived(device.state !== 'idle');
</script>

<svelte:window
  ondragover={(e) => e.preventDefault()}
  ondrop={(e) => e.preventDefault()}
/>

<header class="card top">
  <div class="brand">
    <h1>soundbored</h1>
    <span class="muted">M-VAVE FM-1 soundboard</span>
  </div>
  <ConnectBar />
  {#if device.loading}
    <div class="progress load"><div style:width="{(device.loading.done / Math.max(1, device.loading.total)) * 100}%"></div></div>
  {/if}
</header>

{#if ready}
  <main class:with-panel={selected !== null}>
    <section class="left">
      <div class="row toolbar">
        <button class="primary" type="button" disabled={!device.connected} onclick={() => select(SLOT_AUTO)}>+ Add sound</button>
        <span class="muted">Click a slot to edit it, drag one onto another to swap them, or drop an audio file on a slot.</span>
      </div>
      <Grid {selected} onSelect={(s) => select(s)} onFile={(s, f) => select(s, f)} />
      <DangerZone />
      <Log />
    </section>
    {#if selected !== null}
      {#key panelKey}
        <SlotPanel slot={selected} file={pendingFile} onClose={() => (selected = null)} onSelect={(s) => (selected = s)} />
      {/key}
    {/if}
  </main>
{:else}
  <main class="intro">
    <div class="card">
      <h2>Connect</h2>
      <p>
        Plug in an FM-1 running the soundbored firmware and press <strong>Connect via Web MIDI</strong> (Chrome or Edge; the
        page needs SysEx permission). The port whose name contains “SOUNDBORED” is picked automatically.
      </p>
      <p>No hardware? <button type="button" onclick={() => device.connectMock()}>Use Simulated FM-1</button> — an in-browser device that speaks the same protocol and keeps its sounds in localStorage.</p>
    </div>
    <Log />
  </main>
{/if}

<style>
  :global(body) {
    padding: 12px;
  }
  .top {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-bottom: 12px;
  }
  .brand {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }
  h1 {
    margin: 0;
    font-size: 20px;
    letter-spacing: 0.02em;
  }
  .load {
    height: 3px;
  }
  main {
    display: grid;
    gap: 12px;
    align-items: start;
  }
  main.with-panel {
    grid-template-columns: minmax(0, 1fr) minmax(380px, 560px);
  }
  @media (max-width: 1000px) {
    main.with-panel {
      grid-template-columns: 1fr;
    }
  }
  .left {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
  }
  .intro {
    max-width: 720px;
  }
  .intro p {
    line-height: 1.5;
  }
</style>
