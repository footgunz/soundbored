<script lang="ts">
  import { device } from '../lib/device.svelte';
  import { KEY_NONE, MODE_NAMES, SLOT_AUTO, isPrintableAscii, keyName, slotPosition, type Meta } from '../lib/protocol';
  import IconEditor from './IconEditor.svelte';
  import MetaForm from './MetaForm.svelte';
  import SoundUploader from './SoundUploader.svelte';

  let { slot, file = null, onClose, onSelect }: { slot: number; file?: File | null; onClose: () => void; onSelect: (s: number) => void } = $props();

  const entry = $derived(slot === SLOT_AUTO ? null : device.entries[slot]);
  const used = $derived(!!entry?.used);
  const icon = $derived(slot === SLOT_AUTO ? null : device.icons[slot]);

  type Tab = 'details' | 'sound' | 'icon';
  // svelte-ignore state_referenced_locally
  let tab = $state<Tab>(file || !used ? 'sound' : 'details');

  let meta = $state<Meta>({ name: '', key: KEY_NONE, mode: 0, gain: 256 });
  let metaFor = '';
  $effect(() => {
    // reset the form when the selected sound (or its stored metadata) changes
    const e = entry;
    const sig = e ? `${e.slot}:${e.used}:${e.name}:${e.key}:${e.mode}:${e.gain}` : '';
    if (sig !== metaFor) {
      metaFor = sig;
      if (e?.used) meta = { name: e.name, key: e.key, mode: e.mode, gain: e.gain };
    }
  });
  const dirty = $derived(!!entry?.used && (meta.name !== entry.name || meta.key !== entry.key || meta.mode !== entry.mode || meta.gain !== entry.gain));
  const metaOk = $derived(meta.name.length <= 16 && isPrintableAscii(meta.name));
  const taken = $derived(
    Object.fromEntries(device.entries.filter((e) => e.used && e.key !== KEY_NONE && e.slot !== slot).map((e) => [e.key, e.name])),
  );

  let confirmDelete = $state(false);
  let newIcon = $state.raw<Uint8Array | null>(null);
  let iconProgress = $state<{ sent: number; total: number } | null>(null);
  let msg = $state<string | null>(null);

  async function save() {
    msg = null;
    try {
      await device.setMeta(slot, { ...meta });
      msg = 'Saved.';
    } catch (e) {
      msg = (e as Error).message;
    }
  }

  async function del() {
    confirmDelete = false;
    try {
      await device.delete(slot);
      onClose();
    } catch (e) {
      msg = (e as Error).message;
    }
  }

  async function uploadIcon() {
    if (!newIcon) return;
    msg = null;
    iconProgress = { sent: 0, total: newIcon.length };
    try {
      await device.uploadIcon(slot, newIcon, (p) => (iconProgress = p));
      msg = 'Icon updated.';
    } catch (e) {
      msg = (e as Error).message;
    } finally {
      iconProgress = null;
    }
  }

  const pos = $derived(slot === SLOT_AUTO ? null : slotPosition(slot));
</script>

<aside class="card panel">
  <header class="row">
    <h2>
      {#if slot === SLOT_AUTO}New sound{:else}Slot {slot + 1}{/if}
      {#if pos}<span class="muted small">page {pos.page + 1}, row {pos.row + 1}, col {pos.col + 1}</span>{/if}
    </h2>
    <span class="spacer"></span>
    <button type="button" onclick={onClose} aria-label="Close">✕</button>
  </header>

  {#if used && entry}
    <p class="muted small">
      “{entry.name}” · {(entry.frames / entry.rate).toFixed(2)} s @ {entry.rate} Hz · {entry.sectors} sectors · key {keyName(entry.key)} · {MODE_NAMES[entry.mode] ?? entry.mode}
    </p>
    <nav class="tabs">
      <button type="button" class:on={tab === 'details'} onclick={() => (tab = 'details')}>Details</button>
      <button type="button" class:on={tab === 'icon'} onclick={() => (tab = 'icon')}>Icon</button>
      <button type="button" class:on={tab === 'sound'} onclick={() => (tab = 'sound')}>Replace sound</button>
    </nav>
  {/if}

  {#if used && entry && tab === 'details'}
    <MetaForm bind:meta {taken} />
    <div class="row">
      <button class="primary" type="button" disabled={!dirty || !metaOk || device.busy || !device.connected} onclick={save}>Save</button>
      <button type="button" disabled={!device.connected} onclick={() => device.play(slot)}>▶ Preview on device</button>
      <button type="button" disabled={!device.connected} onclick={() => device.stop()}>■ Stop</button>
      <span class="spacer"></span>
      {#if confirmDelete}
        <span class="warn">Delete “{entry.name}”?</span>
        <button class="danger solid" type="button" onclick={del}>Delete</button>
        <button type="button" onclick={() => (confirmDelete = false)}>Cancel</button>
      {:else}
        <button class="danger" type="button" disabled={!device.connected || device.busy} onclick={() => (confirmDelete = true)}>Delete…</button>
      {/if}
    </div>
  {:else if used && entry && tab === 'icon'}
    <IconEditor name={entry.name} bind:icon={newIcon} existing={icon} />
    {#if iconProgress}
      <div class="progress"><div style:width="{(iconProgress.sent / iconProgress.total) * 100}%"></div></div>
    {/if}
    <div class="row">
      <button class="primary" type="button" disabled={!newIcon || newIcon === icon || device.busy || !device.connected} onclick={uploadIcon}>Upload icon only</button>
      <span class="muted small">Uses BEGIN kind 1; the audio stays as it is.</span>
    </div>
  {:else}
    {#key slot}
      <SoundUploader
        {slot}
        {file}
        initialMeta={used && entry ? { name: entry.name, key: entry.key, mode: entry.mode, gain: entry.gain } : null}
        existingIcon={used ? icon : null}
        replacingSectors={used && entry ? entry.sectors : 0}
        onDone={(s) => {
          onSelect(s);
          tab = 'details';
        }}
      />
    {/key}
  {/if}
  {#if msg}<p class="muted">{msg}</p>{/if}
</aside>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
  }
  header h2 {
    margin: 0;
  }
  .spacer {
    flex: 1;
  }
  .small {
    font-size: 12px;
    font-weight: normal;
  }
  .tabs {
    display: flex;
    gap: 4px;
    border-bottom: 1px solid var(--line);
  }
  .tabs button {
    border: none;
    border-bottom: 2px solid transparent;
    border-radius: 0;
    background: none;
  }
  .tabs button.on {
    border-bottom-color: var(--accent);
    color: var(--accent);
  }
  p {
    margin: 0;
  }
</style>
