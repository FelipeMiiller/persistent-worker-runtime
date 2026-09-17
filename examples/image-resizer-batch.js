/**
 * Example: Bounded Concurrency Batch Image/Data Processing
 *
 * Demonstrates how to use executeAll() (Promise.all style) to process
 * multiple items in parallel without overloading CPU cores.
 */

import { createWorkerRuntime } from '../src/index.js';

async function main() {
  console.log('--- EXAMPLE: Bounded Concurrency Batch Processing ---\n');

  // Pool with 2 workers
  const runtime = await createWorkerRuntime({ workers: 2 });

  const imagesToResize = [
    { name: 'hero.png', width: 1920, height: 1080 },
    { name: 'avatar.png', width: 400, height: 400 },
    { name: 'banner.png', width: 1200, height: 630 },
    { name: 'thumbnail.png', width: 150, height: 150 },
  ];

  console.log(`Submitting ${imagesToResize.length} image tasks to a 2-worker bounded pool...`);

  // Bounded batch execution: preserves Promise.all ergonomics without unbounded thread creation
  const resizedResults = await runtime.executeAll(
    imagesToResize.map((img) => ({
      type: 'resize_image',
      payload: img,
      fn: (p) => {
        // Simulates CPU-heavy pixel resizing
        const totalPixels = p.width * p.height;
        return {
          original: p.name,
          resizedTo: `${Math.round(p.width / 2)}x${Math.round(p.height / 2)}`,
          processedPixels: totalPixels,
        };
      },
    })),
  );

  console.log('All images resized successfully:');
  console.table(resizedResults);

  await runtime.shutdown();
}

main().catch(console.error);
