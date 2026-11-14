<script lang="ts">
  import { defaultIconRgba, fileToIconRgba, nameHue, quantizeToIcon } from '../lib/icon';
  import IconView from './IconView.svelte';

  let {
    name,
    icon = $bindable(null),
    existing = null,
  }: { name: string; icon?: Uint8Array | null; existing?: Uint8Array | null } = $props();

  type Source = 'existing' | 'default' | 'image';
  // svelte-ignore state_referenced_locally
  let source = $state<Source>(existing ? 'existing' : 'default');
  let imageRgba = $state.raw<Uint8ClampedArray | null>(null);
  let imageName = $state('');
  let dither = $state(false);
  let hueOverride = $state<number | null>(null);
  let error = $state<string | null>(null);
  let dragging = $state(false);
  let fileInput: HTMLInputElement | undefined = $state();

  const hue = $derived(hueOverride ?? nameHue(name || '?'));

  $effect(() => {
    if (source === 'existing' && existing) icon = existing;
    else if (source === 'image' && imageRgba) icon = quantizeToIcon(imageRgba, { dither });
    else icon = quantizeToIcon(defaultIconRgba(name || '?', hue), { dither });
  });

  async function useFile(f: File | undefined) {
    if (!f) return;
    error = null;
    try {
      imageRgba = await fileToIconRgba(f);
      imageName = f.name;
      source = 'image';
    } catch (e) {
      error = `Could not read image: ${(e as Error).message}`;
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragging = false;
    const f = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('image/'));
    void useFile(f);
  }
</script>

<div
  class="ie"
  class:dragging
  role="region"
  aria-label="Icon"
  ondragover={(e) => {
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
    }
  }}
  ondragleave={() => (dragging = false)}
  ondrop={onDrop}
>
  <div class="previews">
    <IconView {icon} scale={1} title="1×" />
    <IconView {icon} scale={4} title="4×" />
  </div>
  <div class="controls">
    <div class="row">
      {#if existing}
        <label><input type="radio" bind:group={source} value="existing" /> current</label>
      {/if}
      <label><input type="radio" bind:group={source} value="default" /> letters</label>
      <label><input type="radio" bind:group={source} value="image" disabled={!imageRgba} /> image{imageName ? `: ${imageName}` : ''}</label>
    </div>
    <div class="row">
      <button type="button" onclick={() => fileInput?.click()}>Choose image…</button>
      <span class="muted">or drop one here</span>
      <input bind:this={fileInput} type="file" accept="image/*" hidden onchange={(e) => useFile(e.currentTarget.files?.[0])} />
    </div>
    {#if source === 'default'}
      <div class="row">
        <label for="hue">Colour</label>
        <input id="hue" type="range" min="0" max="359" value={hue} oninput={(e) => (hueOverride = +e.currentTarget.value)} />
      </div>
    {/if}
    {#if source !== 'existing'}
      <label class="row"><input type="checkbox" bind:checked={dither} /> Dither (Floyd–Steinberg)</label>
    {/if}
    <p class="muted small">48×48, 16 colours (RGB565). Images are centre-cropped to a square.</p>
    {#if error}<p class="err">{error}</p>{/if}
  </div>
</div>

<style>
  .ie {
    display: flex;
    gap: 16px;
    align-items: flex-start;
    padding: 8px;
    border: 1px dashed transparent;
    border-radius: var(--radius);
  }
  .ie.dragging {
    border-color: var(--accent);
  }
  .previews {
    display: flex;
    gap: 12px;
    align-items: flex-end;
  }
  .controls {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .controls label {
    color: var(--text);
  }
  .small {
    font-size: 12px;
    margin: 0;
  }
</style>
