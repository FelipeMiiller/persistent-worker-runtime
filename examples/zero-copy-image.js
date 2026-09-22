/**
 * Zero-copy image processing example.
 *
 * Demonstrates transferList for processing multi-megabyte image buffers
 * (or any large binary blob) without copying the data across threads.
 *
 * Real-world use case: a Node.js HTTP server that receives image uploads
 * and resizes/processes them on a worker thread without blocking the
 * Event Loop or wasting CPU on serialization.
 *
 * Run: `node examples/zero-copy-image.js`
 */

import { createWorkerRuntime } from '../src/index.js';

function makeFakeImage(width, height) {
  // Simulate a raw RGBA pixel buffer.
  const bytes = width * height * 4;
  const buf = new ArrayBuffer(bytes);
  const view = new Uint8Array(buf);
  // Fill with a deterministic gradient so we can verify the worker received it intact.
  for (let i = 0; i < view.length; i++) {
    view[i] = i % 256;
  }
  return buf;
}

async function main() {
  const runtime = await createWorkerRuntime({ workers: 2 });

  // 1) Allocate a 4K RGBA buffer (3840 * 2160 * 4 = ~33MB).
  const WIDTH = 3840;
  const HEIGHT = 2160;
  const imageBuffer = makeFakeImage(WIDTH, HEIGHT);
  console.log(`Allocated ${(imageBuffer.byteLength / 1024 / 1024).toFixed(2)}MB raw image buffer`);

  // 2) Dispatch processing on the worker. The buffer is transferred (not copied)
  //    because we put it in transferList.
  const t0 = performance.now();
  const result = await runtime.execute({
    type: 'compute_average_brightness',
    payload: { buffer: imageBuffer, width: WIDTH, height: HEIGHT },
    transferList: [imageBuffer],
    fn: (p) => {
      const pixels = new Uint8Array(p.buffer);
      let sum = 0;
      let count = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        // RGBA: use the red channel as a brightness proxy
        sum += pixels[i];
        count++;
      }
      return { averageBrightness: sum / count, pixels: count };
    },
  });
  const elapsed = performance.now() - t0;

  console.log(
    `\nWorker processed ${result.pixels.toLocaleString()} pixels in ${elapsed.toFixed(2)}ms`,
  );
  console.log(`Average brightness (red channel): ${result.averageBrightness.toFixed(2)}`);
  console.log(`Sender buffer after transfer: ${imageBuffer.byteLength} bytes (should be 0)`);

  if (imageBuffer.byteLength === 0) {
    console.log('\n✅ Buffer was transferred (zero-copy); sender cannot reuse it.');
    console.log(
      '   In a real app you would NOT keep a reference to the buffer on the sender side.',
    );
  } else {
    console.log('\n⚠️  Buffer still has data on sender side (transfer may have failed).');
  }

  await runtime.shutdown();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
