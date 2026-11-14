<script lang="ts">
  import { device } from '../lib/device.svelte';
  import { sectorsToSeconds } from '../lib/protocol';
  import { findSoundbored } from '../lib/transport';

  let inName = $state('');
  let outName = $state('');

  $effect(() => {
    // preselect the SOUNDBORED pair once ports are known
    const a = device.midi.access;
    if (a && !inName && !outName) {
      const p = findSoundbored(a);
      if (p) {
        inName = p.input.name ?? '';
        outName = p.output.name ?? '';
      } else {
        inName = device.midi.inputs[0]?.name ?? '';
        outName = device.midi.outputs[0]?.name ?? '';
      }
    }
  });

  const h = $derived(device.hello);
  const stateText = $derived(
    {
      idle: 'not connected',
      connecting: 'connecting…',
      connected: 'connected',
      disconnected: 'disconnected — waiting for the device',
      error: 'error',
    }[device.state],
  );
</script>

<div class="bar">
  <div class="status">
    <span class="dot {device.state}"></span>
    <strong>{device.label || 'No device'}</strong>
    <span class="muted">{stateText}</span>
  </div>

  {#if h && device.state !== 'idle'}
    <div class="hello muted">
      <span title="free / total sectors">{h.sectorsFree}/{h.sectorsTotal} sectors free</span>
      <strong class="free">{sectorsToSeconds(h.sectorsFree, h.sectorPayload).toFixed(1)} s free</strong>
      <span>of {sectorsToSeconds(h.sectorsTotal, h.sectorPayload).toFixed(1)} s at 16 kHz</span>
      <span class="small">proto {h.proto} · {h.slots} slots · chunk {h.maxChunk}</span>
    </div>
  {/if}

  <span class="spacer"></span>

  {#if device.state === 'idle' || device.state === 'error'}
    {#if device.midi.supported}
      {#if !device.midi.access}
        <button class="primary" type="button" onclick={() => device.requestMidi()}>Connect via Web MIDI</button>
      {:else}
        <label for="midi-out">Out</label>
        <select id="midi-out" bind:value={outName}>
          {#each device.midi.outputs as p (p.id)}<option value={p.name}>{p.name}</option>{/each}
        </select>
        <label for="midi-in">In</label>
        <select id="midi-in" bind:value={inName}>
          {#each device.midi.inputs as p (p.id)}<option value={p.name}>{p.name}</option>{/each}
        </select>
        <button class="primary" type="button" disabled={!inName || !outName} onclick={() => device.connectMidi(inName, outName)}>Connect</button>
        {#if device.midi.outputs.length === 0}<span class="muted">no MIDI ports — plug in the FM-1</span>{/if}
      {/if}
    {:else}
      <span class="warn">Web MIDI is not available in this browser.</span>
    {/if}
    {#if device.midi.denied}<span class="err small" title={device.midi.denied}>MIDI access denied</span>{/if}
    <button type="button" onclick={() => device.connectMock()}>Use Simulated FM-1</button>
  {:else}
    {#if device.kind === 'mock'}
      <label class="row small"><input type="checkbox" checked={device.flaky} onchange={(e) => device.setFlaky(e.currentTarget.checked)} /> flaky link</label>
      <button type="button" onclick={() => device.simulateReconnect()} title="Simulate unplugging and replugging USB">Replug</button>
      <button type="button" onclick={() => device.resetMock()} disabled={!device.connected || device.busy}>Reset demo</button>
    {/if}
    <button type="button" onclick={() => device.refresh()} disabled={!device.connected}>Reload</button>
    <button type="button" onclick={() => device.disconnect()}>Disconnect</button>
  {/if}
</div>
{#if device.error}<div class="err errline">{device.error}</div>{/if}

<style>
  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px 14px;
  }
  .status,
  .hello {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .free {
    color: var(--ok);
  }
  .spacer {
    flex: 1;
  }
  .small {
    font-size: 12px;
  }
  label {
    color: var(--muted);
  }
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--muted);
  }
  .dot.connected {
    background: var(--ok);
  }
  .dot.connecting {
    background: var(--warn);
  }
  .dot.disconnected,
  .dot.error {
    background: var(--danger);
  }
  .errline {
    margin-top: 6px;
  }
</style>
