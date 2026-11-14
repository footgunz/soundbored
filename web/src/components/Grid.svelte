<script lang="ts">
  import { device } from '../lib/device.svelte';
  import { MODE_NAMES, keyName } from '../lib/protocol';
  import IconView from './IconView.svelte';

  let {
    selected,
    onSelect,
    onFile,
  }: { selected: number | null; onSelect: (slot: number) => void; onFile: (slot: number, f: File) => void } = $props();

  const pages = [0, 1, 2, 3];
  let dragFrom = $state<number | null>(null);
  let dragOver = $state<number | null>(null);
  const MIME = 'application/x-soundbored-slot';

  function dragStart(e: DragEvent, slot: number) {
    dragFrom = slot;
    e.dataTransfer?.setData(MIME, String(slot));
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  }

  function dragOverCell(e: DragEvent, slot: number) {
    const types = e.dataTransfer?.types ?? [];
    if (types.includes(MIME) || types.includes('Files')) {
      e.preventDefault();
      dragOver = slot;
    }
  }

  function drop(e: DragEvent, slot: number) {
    e.preventDefault();
    dragOver = null;
    const from = e.dataTransfer?.getData(MIME);
    if (from) {
      const a = +from;
      dragFrom = null;
      if (a !== slot) void device.swap(a, slot);
      return;
    }
    const f = e.dataTransfer?.files?.[0];
    if (f) onFile(slot, f);
  }

  const dur = (frames: number, rate: number) => (rate ? (frames / rate).toFixed(frames / rate < 10 ? 2 : 1) + ' s' : '');
</script>

<div class="pages">
  {#each pages as p (p)}
    <div class="page card">
      <h3>Page {p + 1}</h3>
      <div class="grid">
        {#each Array.from({ length: 12 }, (_, i) => p * 12 + i) as slot (slot)}
          {@const e = device.entries[slot]}
          <div
            class="cell"
            class:used={e?.used}
            class:sel={selected === slot}
            class:over={dragOver === slot && dragFrom !== slot}
            class:from={dragFrom === slot}
            role="button"
            tabindex="0"
            draggable={e?.used && device.connected && !device.busy}
            ondragstart={(ev) => dragStart(ev, slot)}
            ondragend={() => {
              dragFrom = null;
              dragOver = null;
            }}
            ondragover={(ev) => dragOverCell(ev, slot)}
            ondragleave={() => dragOver === slot && (dragOver = null)}
            ondrop={(ev) => drop(ev, slot)}
            onclick={() => onSelect(slot)}
            onkeydown={(ev) => (ev.key === 'Enter' || ev.key === ' ') && onSelect(slot)}
            title={e?.used ? `${e.name} — ${MODE_NAMES[e.mode] ?? ''}, drag to move` : 'empty — click or drop an audio file'}
          >
            {#if e?.used}
              <IconView icon={device.icons[slot]} />
              <div class="name">{e.name}</div>
              <div class="meta">
                <span class="key" class:none={e.key === 0xff}>{keyName(e.key)}</span>
                <span>{dur(e.frames, e.rate)}</span>
              </div>
              <button
                class="play"
                type="button"
                title="Preview on device"
                aria-label="Preview"
                disabled={!device.connected}
                onclick={(ev) => {
                  ev.stopPropagation();
                  void device.play(slot);
                }}>▶</button
              >
            {:else}
              <div class="empty">+</div>
            {/if}
            <span class="num">{slot + 1}</span>
          </div>
        {/each}
      </div>
    </div>
  {/each}
</div>

<style>
  .pages {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(330px, 1fr));
    gap: 12px;
  }
  .page {
    padding: 10px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
  }
  .cell {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 6px 2px 4px;
    min-height: 96px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--panel-2);
    cursor: pointer;
    user-select: none;
    outline: none;
  }
  .cell:not(.used) {
    background: transparent;
    border-style: dashed;
    justify-content: center;
  }
  .cell:hover,
  .cell:focus-visible {
    border-color: var(--accent-2);
  }
  .cell.sel {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }
  .cell.over {
    border-color: var(--warn);
    box-shadow: 0 0 0 2px var(--warn);
  }
  .cell.from {
    opacity: 0.4;
  }
  .name {
    font-size: 11px;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 0 2px;
  }
  .meta {
    display: flex;
    gap: 6px;
    font-size: 10px;
    color: var(--muted);
  }
  .key {
    color: var(--accent);
  }
  .key.none {
    color: var(--muted);
  }
  .empty {
    color: var(--line);
    font-size: 22px;
  }
  .num {
    position: absolute;
    top: 2px;
    left: 4px;
    font-size: 9px;
    color: var(--muted);
  }
  .play {
    position: absolute;
    top: 2px;
    right: 2px;
    padding: 0 5px;
    font-size: 10px;
    line-height: 16px;
    opacity: 0;
  }
  .cell:hover .play,
  .cell:focus-within .play {
    opacity: 1;
  }
</style>
