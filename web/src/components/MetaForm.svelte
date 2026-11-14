<script lang="ts">
  import { GAIN_MAX, GAIN_UNITY, MODE_NAMES, NAME_MAX, isPrintableAscii, type Meta } from '../lib/protocol';
  import KeyPicker from './KeyPicker.svelte';

  let {
    meta = $bindable(),
    taken = {},
    allowAuto = false,
  }: { meta: Meta; taken?: Record<number, string>; allowAuto?: boolean } = $props();

  const uid = $props.id();
  const nameOk = $derived(meta.name.length <= NAME_MAX && isPrintableAscii(meta.name));
</script>

<div class="field">
  <label for="{uid}-name">Name</label>
  <div>
    <input id="{uid}-name" maxlength={NAME_MAX} bind:value={meta.name} class:bad={!nameOk} spellcheck="false" />
    <span class="muted">{meta.name.length}/{NAME_MAX}</span>
    {#if !nameOk}<div class="err">Printable ASCII only (0x20–0x7E).</div>{/if}
  </div>
</div>
<div class="field">
  <span class="lbl">Key</span>
  <KeyPicker bind:value={meta.key} {taken} {allowAuto} />
</div>
<div class="field">
  <span class="lbl">Mode</span>
  <div class="row">
    {#each MODE_NAMES as m, i (m)}
      <label class="radio"><input type="radio" name="{uid}-mode" value={i} bind:group={meta.mode} /> {m}</label>
    {/each}
  </div>
</div>
<div class="field">
  <label for="{uid}-gain">Gain</label>
  <div class="row">
    <input id="{uid}-gain" class="gain" type="range" min="0" max={GAIN_MAX} step="1" bind:value={meta.gain} />
    <span class="mono">{(meta.gain / GAIN_UNITY).toFixed(2)}×</span>
    <button type="button" onclick={() => (meta.gain = GAIN_UNITY)}>1×</button>
  </div>
</div>

<style>
  .lbl {
    color: var(--muted);
  }
  .radio {
    color: var(--text);
  }
  input.bad {
    border-color: var(--danger);
  }
  .gain {
    width: 180px;
  }
</style>
