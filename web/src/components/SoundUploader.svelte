<script lang="ts">
  import { untrack } from 'svelte';
  import { decodeToMono, findSilenceTrim, linToDb, peak, playSamples, prepare, stopPlayback } from '../lib/audio';
  import { device } from '../lib/device.svelte';
  import {
    DEFAULT_RATE,
    GAIN_UNITY,
    ICON_BYTES,
    KEY_AUTO,
    KEY_NONE,
    Mode,
    SECTOR_PAYLOAD,
    SLOT_AUTO,
    isPrintableAscii,
    sanitizeName,
    sectorsFor,
    sectorsToSeconds,
    type Meta,
  } from '../lib/protocol';
  import IconEditor from './IconEditor.svelte';
  import MetaForm from './MetaForm.svelte';
  import Waveform from './Waveform.svelte';

  let {
    slot,
    initialMeta = null,
    existingIcon = null,
    replacingSectors = 0,
    file = null,
    onDone,
  }: {
    slot: number;
    initialMeta?: Meta | null;
    existingIcon?: Uint8Array | null;
    replacingSectors?: number;
    file?: File | null;
    onDone?: (slot: number) => void;
  } = $props();

  const rate = DEFAULT_RATE;

  // svelte-ignore state_referenced_locally
  let meta = $state<Meta>(initialMeta ? { ...initialMeta } : { name: '', key: KEY_AUTO, mode: Mode.ONE_SHOT, gain: GAIN_UNITY });
  let samples = $state.raw<Float32Array | null>(null);
  let info = $state<{ name: string; rate: number; channels: number; duration: number } | null>(null);
  let decoding = $state(false);
  let error = $state<string | null>(null);
  let thresholdDb = $state(-45);
  let autoTrim = $state(true);
  let doNormalize = $state(true);
  let start = $state(0);
  let end = $state(0);
  let icon = $state.raw<Uint8Array | null>(null);
  let progress = $state<{ sent: number; total: number } | null>(null);
  let dragging = $state(false);
  let fileInput: HTMLInputElement | undefined = $state();

  // auto trim (re)computes the handles whenever its inputs change
  $effect(() => {
    if (!samples) return;
    if (autoTrim) {
      const t = findSilenceTrim(samples, thresholdDb, Math.round(rate * 0.005));
      start = t.start;
      end = t.end > t.start ? t.end : samples.length;
    }
  });

  const prepared = $derived(samples && end > start ? prepare(samples, start, end, doNormalize, rate) : null);
  const total = $derived(prepared ? ICON_BYTES + prepared.adpcm.length : 0);
  const needSectors = $derived(prepared ? sectorsFor(total, device.hello?.sectorPayload || SECTOR_PAYLOAD) : 0);
  const freeSectors = $derived(device.hello?.sectorsFree ?? 0);
  const fits = $derived(needSectors <= freeSectors);
  const srcPeakDb = $derived(samples ? linToDb(peak(samples)) : -Infinity);
  const metaOk = $derived(meta.name.length > 0 && meta.name.length <= 16 && isPrintableAscii(meta.name));
  const taken = $derived(
    Object.fromEntries(device.entries.filter((e) => e.used && e.key !== KEY_NONE && e.slot !== slot).map((e) => [e.key, e.name])),
  );

  $effect(() => {
    const f = file;
    if (f) untrack(() => void load(f));
  });

  async function load(f: File) {
    error = null;
    decoding = true;
    stopPlayback();
    try {
      const r = await decodeToMono(f, rate);
      samples = r.samples;
      info = { name: f.name, rate: r.sourceRate, channels: r.sourceChannels, duration: r.sourceDuration };
      start = 0;
      end = r.samples.length;
      autoTrim = true;
      if (!meta.name) meta.name = sanitizeName(f.name.replace(/\.[^.]+$/, '')).trim() || 'Sound';
    } catch (e) {
      error = `Could not decode “${f.name}”: ${(e as Error).message || e}`;
      samples = null;
    } finally {
      decoding = false;
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragging = false;
    const f = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('audio/') || f.type.startsWith('video/') || /\.(wav|mp3|ogg|flac|m4a|aac|opus|webm)$/i.test(f.name));
    if (f) void load(f);
  }

  async function upload() {
    if (!prepared || !icon) return;
    error = null;
    progress = { sent: 0, total };
    try {
      const res = await device.uploadSound(slot, { ...meta }, prepared.rate, prepared.frames, icon, prepared.adpcm, (p) => (progress = p));
      if (res) onDone?.(res.slot);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      progress = null;
    }
  }

  const sec = (n: number) => n.toFixed(2) + ' s';
</script>

<div
  class="su"
  class:dragging
  role="region"
  aria-label="Sound"
  ondragover={(e) => {
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault();
      dragging = true;
    }
  }}
  ondragleave={() => (dragging = false)}
  ondrop={onDrop}
>
  <section>
    <h3>Audio</h3>
    <div class="row">
      <button type="button" onclick={() => fileInput?.click()} disabled={decoding}>Choose audio file…</button>
      <span class="muted">or drop one here</span>
      <input bind:this={fileInput} type="file" accept="audio/*,video/*,.wav,.mp3,.ogg,.flac,.m4a" hidden onchange={(e) => { const f = e.currentTarget.files?.[0]; if (f) void load(f); }} />
    </div>
    {#if decoding}<p class="muted">Decoding…</p>{/if}
    {#if info}
      <p class="muted small">
        {info.name}: {info.channels} ch, {info.rate} Hz, {sec(info.duration)}, peak {srcPeakDb.toFixed(1)} dBFS → mono {rate} Hz
      </p>
    {/if}
    {#if samples}
      <Waveform {samples} {rate} bind:start bind:end />
      <div class="row opts">
        <label class="row"><input type="checkbox" bind:checked={autoTrim} /> Trim silence below</label>
        <input type="range" min="-80" max="-10" step="1" bind:value={thresholdDb} disabled={!autoTrim} />
        <span class="mono">{thresholdDb} dBFS</span>
        <label class="row"><input type="checkbox" bind:checked={doNormalize} /> Normalise to −1 dBFS</label>
      </div>
      <div class="row opts">
        <button type="button" onclick={() => samples && playSamples(samples.subarray(start, end), rate)}>▶ Source (16 kHz)</button>
        <button type="button" disabled={!prepared} onclick={() => prepared && playSamples(prepared.decoded, rate, meta.gain / GAIN_UNITY)}>▶ ADPCM, as the device plays it</button>
        <button type="button" onclick={stopPlayback}>■ Stop</button>
      </div>
      {#if prepared}
        <div class="size">
          <div class="row">
            <span>{sec(prepared.frames / rate)} · {prepared.frames} frames · {total} bytes (icon {ICON_BYTES} + audio {prepared.adpcm.length}) · {needSectors} sectors</span>
          </div>
          <div class="progress meter" title="space">
            <div style:width="{Math.min(100, (needSectors / Math.max(1, freeSectors)) * 100)}%" class:over={!fits}></div>
          </div>
          <div class="row small" class:err={!fits} class:muted={fits}>
            free: {freeSectors} sectors = {sec(sectorsToSeconds(freeSectors, device.hello?.sectorPayload))} at 16 kHz
            {#if !fits}— too long; trim {sec(((needSectors - freeSectors) * SECTOR_PAYLOAD) / 8000)} or more{/if}
            {#if replacingSectors}· the old sound's {replacingSectors} sectors are freed after commit{/if}
          </div>
        </div>
      {/if}
    {/if}
  </section>

  <section>
    <h3>Icon</h3>
    <IconEditor name={meta.name} bind:icon existing={existingIcon} />
  </section>

  <section>
    <h3>Details</h3>
    <MetaForm bind:meta {taken} allowAuto={!initialMeta} />
  </section>

  <section>
    {#if progress}
      <div class="progress"><div style:width="{(progress.sent / progress.total) * 100}%"></div></div>
      <p class="muted small">{progress.sent} / {progress.total} bytes</p>
    {/if}
    <div class="row">
      <button
        class="primary"
        type="button"
        disabled={!prepared || !icon || !fits || !metaOk || !device.connected || device.busy}
        onclick={upload}
      >
        {initialMeta ? 'Replace sound' : 'Upload'} to {slot === SLOT_AUTO ? 'first empty slot' : `slot ${slot + 1}`}
      </button>
      {#if !metaOk && samples}<span class="err small">enter a name</span>{/if}
    </div>
    {#if error}<p class="err">{error}</p>{/if}
  </section>
</div>

<style>
  .su {
    display: flex;
    flex-direction: column;
    gap: 16px;
    border: 1px dashed transparent;
    border-radius: var(--radius);
  }
  .su.dragging {
    border-color: var(--accent);
  }
  .opts {
    margin-top: 8px;
  }
  .opts label {
    color: var(--text);
  }
  .small {
    font-size: 12px;
  }
  .size {
    margin-top: 10px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .meter > div.over {
    background: var(--danger);
  }
</style>
