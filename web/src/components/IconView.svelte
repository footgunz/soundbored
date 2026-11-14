<script lang="ts">
  import { drawIcon } from '../lib/icon';

  let { icon, scale = 1, title = '' }: { icon: Uint8Array | null; scale?: number; title?: string } = $props();
  let canvas: HTMLCanvasElement | undefined = $state();

  $effect(() => {
    if (!canvas) return;
    if (icon) drawIcon(canvas, icon);
    else {
      canvas.width = 48;
      canvas.height = 48;
      canvas.getContext('2d')?.clearRect(0, 0, 48, 48);
    }
  });
</script>

<canvas bind:this={canvas} class="pixelated" style:width="{48 * scale}px" style:height="{48 * scale}px" {title}></canvas>

<style>
  canvas {
    display: block;
    background: #000;
    border-radius: 2px;
  }
</style>
