<script lang="ts">
  import { KEY_AUTO, KEY_BASE_NOTE, KEY_NONE, KEYS, keyName } from '../lib/protocol';

  let {
    value = $bindable(KEY_NONE),
    taken = {},
    allowAuto = false,
  }: { value?: number; taken?: Record<number, string>; allowAuto?: boolean } = $props();

  const BLACK = new Set([1, 3, 6, 8, 10]);
  const keys = Array.from({ length: KEYS }, (_, k) => ({ k, note: KEY_BASE_NOTE + k, black: BLACK.has((KEY_BASE_NOTE + k) % 12) }));
  const whites = keys.filter((x) => !x.black);
  // a black key sits on the boundary after the white key below it
  const blacks = keys
    .filter((x) => x.black)
    .map((x) => ({ ...x, at: whites.findIndex((w) => w.k === x.k - 1) + 1 }));
</script>

<div class="kp">
  <div class="row opts">
    <button type="button" class:sel={value === KEY_NONE} onclick={() => (value = KEY_NONE)}>None</button>
    {#if allowAuto}
      <button type="button" class:sel={value === KEY_AUTO} onclick={() => (value = KEY_AUTO)} title="The device picks: the slot number if under 27 and free, else none">Auto</button>
    {/if}
    <span class="muted">
      {#if value === KEY_NONE}no key{:else if value === KEY_AUTO}device picks{:else}key {value} = {keyName(value)}{#if taken[value]}<span class="warn"> (moves from “{taken[value]}”)</span>{/if}{/if}
    </span>
  </div>
  <div class="piano" style:--n={whites.length}>
    {#each whites as w, i (w.k)}
      <button
        type="button"
        class="white"
        class:sel={value === w.k}
        class:taken={taken[w.k] !== undefined}
        style:left="calc({i} * 100% / var(--n))"
        title="{keyName(w.k)}{taken[w.k] ? ` — ${taken[w.k]}` : ''}"
        onclick={() => (value = w.k)}
      ><span>{keyName(w.k)}</span></button>
    {/each}
    {#each blacks as b (b.k)}
      <button
        type="button"
        class="black"
        class:sel={value === b.k}
        class:taken={taken[b.k] !== undefined}
        style:left="calc({b.at} * 100% / var(--n) - 100% / var(--n) / 3)"
        title="{keyName(b.k)}{taken[b.k] ? ` — ${taken[b.k]}` : ''}"
        onclick={() => (value = b.k)}
        aria-label={keyName(b.k)}
      ></button>
    {/each}
  </div>
</div>

<style>
  .opts {
    margin-bottom: 6px;
  }
  .opts button.sel {
    border-color: var(--accent);
    background: var(--accent-2);
  }
  .piano {
    position: relative;
    height: 70px;
    width: 100%;
    max-width: 460px;
  }
  .piano button {
    position: absolute;
    top: 0;
    padding: 0;
    border-radius: 0 0 4px 4px;
  }
  .white {
    width: calc(100% / var(--n));
    height: 100%;
    background: #ddd;
    border: 1px solid #555;
    color: #333;
    font-size: 9px;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    padding-bottom: 3px !important;
  }
  .black {
    width: calc(100% / var(--n) * 2 / 3);
    height: 60%;
    background: #222;
    border: 1px solid #000;
    z-index: 1;
  }
  .white.taken {
    background: #b9c3cf;
  }
  .black.taken {
    background: #4a5361;
  }
  .piano .sel {
    background: var(--accent) !important;
    border-color: var(--accent) !important;
  }
</style>
