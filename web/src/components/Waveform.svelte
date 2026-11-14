<script lang="ts">
  let {
    samples,
    rate,
    start = $bindable(0),
    end = $bindable(0),
  }: { samples: Float32Array; rate: number; start?: number; end?: number } = $props();

  let canvas: HTMLCanvasElement | undefined = $state();
  let width = $state(600);
  const height = 110;
  let drag: 'start' | 'end' | null = null;

  $effect(() => {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const n = samples.length;
    const mid = height / 2;
    ctx.strokeStyle = '#333943';
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(width, mid);
    ctx.stroke();
    if (n === 0) return;
    const sx = (s: number) => (s / n) * width;
    ctx.fillStyle = '#4fb3ff';
    for (let x = 0; x < width; x++) {
      const a = Math.floor((x / width) * n);
      const b = Math.max(a + 1, Math.floor(((x + 1) / width) * n));
      let lo = 0,
        hi = 0;
      for (let i = a; i < b && i < n; i++) {
        const v = samples[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      ctx.fillRect(x, mid - hi * mid, 1, Math.max(1, (hi - lo) * mid));
    }
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, sx(start), height);
    ctx.fillRect(sx(end), 0, width - sx(end), height);
    ctx.fillStyle = '#f0b74a';
    ctx.fillRect(sx(start) - 1, 0, 2, height);
    ctx.fillRect(sx(end) - 1, 0, 2, height);
  });

  function toSample(e: PointerEvent) {
    const r = canvas!.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    return Math.round(f * samples.length);
  }

  function down(e: PointerEvent) {
    const s = toSample(e);
    drag = Math.abs(s - start) <= Math.abs(s - end) ? 'start' : 'end';
    canvas!.setPointerCapture(e.pointerId);
    move(e);
  }

  function move(e: PointerEvent) {
    if (!drag) return;
    const s = toSample(e);
    if (drag === 'start') start = Math.min(s, end - 1);
    else end = Math.max(s, start + 1);
    start = Math.max(0, start);
    end = Math.min(samples.length, end);
  }

  const fmt = (s: number) => (s / rate).toFixed(3) + ' s';
</script>

<div class="wf" bind:clientWidth={width}>
  <canvas
    bind:this={canvas}
    style:height="{height}px"
    onpointerdown={down}
    onpointermove={move}
    onpointerup={() => (drag = null)}
    onpointercancel={() => (drag = null)}
  ></canvas>
  <div class="row muted small">
    <span>start {fmt(start)}</span>
    <span>end {fmt(end)}</span>
    <span>length {fmt(end - start)}</span>
    <span>drag the yellow handles to trim</span>
  </div>
</div>

<style>
  .wf {
    width: 100%;
  }
  canvas {
    width: 100%;
    display: block;
    background: #0c0d10;
    border-radius: 6px;
    cursor: ew-resize;
    touch-action: none;
  }
  .small {
    font-size: 12px;
    margin-top: 4px;
  }
</style>
