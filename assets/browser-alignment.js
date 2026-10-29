/* Run the pinned Kalign engine off the main thread. No sequences leave this browser. */
(() => {
  "use strict";

  const scriptURL = document.currentScript?.src;
  const workerURL = new URL("browser-alignment.worker.js", scriptURL || document.baseURI);
  const ALGORITHM = "Kalign";
  const VERSION = "3.3.1";
  const MAX_SEQUENCES = 50;
  const MAX_LENGTH = 20000;
  const MAX_TOTAL_LENGTH = 250000;

  function prepareInput(sequences) {
    if (!Array.isArray(sequences) || sequences.length < 2 || sequences.length > MAX_SEQUENCES) {
      throw new Error(`Select between 2 and ${MAX_SEQUENCES} proteins for alignment.`);
    }
    const names = new Set();
    let total = 0;
    return sequences.map((record) => {
      const name = record?.name;
      const sequence = record?.sequence;
      if (typeof name !== "string" || !/^[A-Za-z0-9_.:|,-]{1,200}$/.test(name) || names.has(name)) {
        throw new Error("Alignment sequence names must be unique, short FASTA identifiers.");
      }
      names.add(name);
      if (typeof sequence !== "string" || !sequence.length || sequence.length > MAX_LENGTH) {
        throw new Error(`Protein ${name} has an unavailable or unsupported sequence length.`);
      }
      // Kalign 3.3.1 supports B/Z/X but warns about U/O/J; do not replace those residues.
      if (!/^[ACDEFGHIKLMNPQRSTVWYBZX]+$/.test(sequence)) {
        throw new Error(`Protein ${name} contains residues unsupported by Kalign 3.3.1. Its sequence has not been changed.`);
      }
      total += sequence.length;
      if (total > MAX_TOTAL_LENGTH) throw new Error("The selected proteins exceed this browser alignment size limit.");
      return { name, sequence };
    });
  }

  function verifyResult(result, input) {
    if (result?.algorithm !== ALGORITHM || result?.version !== VERSION || !Array.isArray(result.aligned)) {
      throw new Error("The alignment engine returned an invalid result.");
    }
    if (result.aligned.length !== input.length) throw new Error("The alignment is missing one or more proteins.");
    const rows = new Map();
    let alignmentLength = null;
    for (const row of result.aligned) {
      if (!row || typeof row.name !== "string" || rows.has(row.name)
          || typeof row.sequence !== "string" || !/^[ACDEFGHIKLMNPQRSTVWYBZX-]+$/.test(row.sequence)) {
        throw new Error("The alignment contains an invalid or duplicate protein record.");
      }
      if (alignmentLength === null) alignmentLength = row.sequence.length;
      if (row.sequence.length !== alignmentLength) throw new Error("The aligned proteins have different column counts.");
      rows.set(row.name, row.sequence);
    }
    const aligned = input.map((record) => {
      const sequence = rows.get(record.name);
      if (!sequence || sequence.replace(/-/g, "") !== record.sequence) {
        throw new Error(`Alignment verification failed for ${record.name}: the original protein was not preserved.`);
      }
      return { name: record.name, sequence };
    });
    return { ...result, aligned, alignmentLength };
  }

  async function run(sequences, options = {}) {
    const input = prepareInput(sequences);
    const { signal, onProgress } = options;
    const timeoutMs = options.timeoutMs ?? 120000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300000) {
      throw new Error("The alignment timeout must be between 1 and 300000 milliseconds.");
    }
    if (signal?.aborted) throw new DOMException("Alignment cancelled.", "AbortError");
    if (typeof Worker === "undefined" || typeof WebAssembly === "undefined") {
      throw new Error("This browser does not support the WebAssembly worker required for alignment.");
    }
    const started = performance.now();
    return new Promise((resolve, reject) => {
      // Kalign has process-level state. A fresh worker makes every run independent.
      const worker = new Worker(workerURL);
      let settled = false;
      let timer;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        worker.terminate();
        if (error) reject(error);
        else resolve({ ...result, elapsedMs: Math.round(performance.now() - started) });
      };
      const abort = () => finish(new DOMException("Alignment cancelled.", "AbortError"));
      timer = setTimeout(() => {
        const error = new Error("Alignment exceeded its time limit. Try fewer or shorter proteins.");
        error.name = "TimeoutError";
        finish(error);
      }, timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      worker.onerror = () => finish(new Error("The browser alignment engine could not run. Please reload and try again."));
      worker.onmessageerror = () => finish(new Error("The browser could not read the alignment result."));
      worker.onmessage = ({ data }) => {
        if (settled) return;
        try {
          if (data?.type === "progress") {
            if (typeof onProgress === "function") onProgress(data.message);
          } else if (data?.type === "result") {
            finish(null, verifyResult(data.result, input));
          } else if (data?.type === "error") {
            finish(new Error(data.message || "Protein alignment failed."));
          }
        } catch (error) {
          finish(error);
        }
      };
      if (signal?.aborted) abort();
      else worker.postMessage({ sequences: input });
    });
  }

  window.ProteinAlignment = Object.freeze({ run, algorithm: ALGORITHM, version: VERSION });
})();
