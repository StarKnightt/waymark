import { Engine, loadLiteRtLm } from '@litert-lm/core';

export const MODEL = {
  name: 'Gemma 4 E2B',
  file: 'gemma-4-E2B-it-web.litertlm',
  url: 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.litertlm',
  bytes: 2008432640,
};

export interface GpuStatus { ok: boolean; reason?: string; adapter?: string }

export async function gpuStatus(): Promise<GpuStatus> {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (!gpu) return { ok: false, reason: 'This browser does not support WebGPU.' };
  try {
    const adapter = await Promise.race([gpu.requestAdapter(), new Promise<null>((r) => setTimeout(() => r(null), 3000))]);
    if (!adapter) return { ok: false, reason: 'WebGPU is available, but no GPU adapter was found.' };
    if (!adapter.features.has('shader-f16')) return { ok: false, reason: 'This GPU does not support 16-bit floats in WebGPU, which the model needs.' };
    const i = adapter.info;
    return { ok: true, adapter: [i.vendor, i.architecture, i.description].filter(Boolean).join(' ') };
  } catch (e) {
    return { ok: false, reason: `WebGPU failed: ${(e as Error).message}` };
  }
}

const modelUrl = () => new URLSearchParams(location.search).get('model') ?? MODEL.url;

async function dir() {
  return navigator.storage.getDirectory();
}

export async function cachedModel(): Promise<File | null> {
  try {
    const f = await (await (await dir()).getFileHandle(MODEL.file)).getFile();
    return f.size === MODEL.bytes ? f : null;
  } catch {
    return null;
  }
}

export type Progress = (p: { phase: 'download' | 'load'; loaded?: number; total?: number; text: string }) => void;

/** Streams the model into the origin-private file system, resuming a partial download if one exists. */
export async function downloadModel(onProgress?: Progress, signal?: AbortSignal): Promise<File> {
  const root = await dir();
  await navigator.storage.persist?.().catch(() => false);
  const part = await root.getFileHandle(MODEL.file + '.part', { create: true });
  let have = (await part.getFile()).size;
  const res = await fetch(modelUrl(), { headers: have ? { Range: `bytes=${have}-` } : {}, signal });
  if (!res.ok || !res.body) throw new Error(`Model download failed: HTTP ${res.status}`);
  if (res.status !== 206) have = 0;
  const w = await part.createWritable({ keepExistingData: have > 0 });
  if (have) await w.seek(have);
  const total = MODEL.bytes;
  let loaded = have, last = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await w.write(value);
      loaded += value.byteLength;
      const now = performance.now();
      if (now - last > 250) {
        last = now;
        onProgress?.({ phase: 'download', loaded, total, text: `Downloading ${MODEL.name}: ${(loaded / 1e9).toFixed(2)} of ${(total / 1e9).toFixed(2)} GB` });
      }
    }
  } finally {
    await w.close();
  }
  const file = await part.getFile();
  if (file.size !== MODEL.bytes) throw new Error(`Download incomplete (${file.size} of ${MODEL.bytes} bytes). Try again to resume.`);
  await (part as FileSystemFileHandle & { move(name: string): Promise<void> }).move(MODEL.file);
  return (await (await root.getFileHandle(MODEL.file)).getFile());
}

let enginePromise: Promise<Engine> | null = null;

export function getEngine(onProgress?: Progress): Promise<Engine> {
  enginePromise ??= (async () => {
    const file = (await cachedModel()) ?? (await downloadModel(onProgress));
    onProgress?.({ phase: 'load', text: `Starting ${MODEL.name} on your GPU` });
    // the production build ships the WebAssembly runtime itself (see vite.config.ts)
    if (import.meta.env.PROD) await loadLiteRtLm(new URL(`${import.meta.env.BASE_URL}litert/`, location.href).href);
    return Engine.create({ model: file, mainExecutorSettings: { maxNumTokens: 6144 }, benchmarkEnabled: true });
  })().catch((e) => {
    enginePromise = null;
    throw e;
  });
  return enginePromise;
}

export async function deleteModel() {
  const root = await dir();
  for (const n of [MODEL.file, MODEL.file + '.part']) await root.removeEntry(n).catch(() => {});
}
