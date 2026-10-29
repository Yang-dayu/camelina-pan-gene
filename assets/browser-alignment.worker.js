/* Kalign 3.3.1, distributed by Biowasm. Each worker runs exactly one alignment. */
"use strict";

let started = false;

function progress(message) {
  self.postMessage({ type: "progress", message });
}

function parseFASTA(text) {
  const records = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line.startsWith(">")) {
      current = { name: line.slice(1).trim(), sequence: "" };
      if (!current.name || /\s/.test(current.name)) throw new Error("Invalid alignment FASTA header.");
      records.push(current);
    } else {
      if (!current || /\s/.test(line)) throw new Error("Invalid alignment FASTA sequence.");
      current.sequence += line;
    }
  }
  return records;
}

self.onmessage = async ({ data }) => {
  if (started) return;
  started = true;
  try {
    progress("Loading the protein alignment engine…");
    const baseURL = new URL("vendor/kalign-3.3.1/", self.location.href);
    // Both assets are vendored at a fixed version; no CDN or floating package is loaded.
    self.importScripts(new URL("kalign.js", baseURL).href);
    const log = [];
    const stderr = [];
    const recordLog = (list, line) => {
      if (list.length < 256) list.push(String(line));
    };
    const engine = await Module({
      thisProgram: "kalign",
      locateFile: (file) => new URL(file, baseURL).href,
      print: (line) => recordLog(log, line),
      printErr: (line) => recordLog(stderr, line),
      noInitialRun: true,
    });
    const sequences = data.sequences;
    engine.FS.writeFile("/input.fa", sequences.map((row) => `>${row.name}\n${row.sequence}\n`).join(""));
    progress(`Aligning ${sequences.length} selected proteins in your browser…`);
    const parameters = ["-i", "/input.fa", "-o", "/aligned.fa", "--format", "fasta"];
    const computeStarted = performance.now();
    engine.callMain(parameters);
    const computeMs = Math.round(performance.now() - computeStarted);
    if (!engine.FS.analyzePath("/aligned.fa").exists) throw new Error("Kalign did not produce an alignment.");
    if (!log.some((line) => line.includes("Detected protein sequences."))) {
      throw new Error("Kalign detected a nucleotide-like alphabet. Check the input type. This build cannot force protein mode for some low-complexity proteins.");
    }
    if (stderr.length || log.some((line) => line.includes("offending character:"))) {
      throw new Error("Kalign reported an input error. The original sequences have not been changed.");
    }
    progress("Checking that every original protein is preserved…");
    self.postMessage({
      type: "result",
      result: {
        algorithm: "Kalign",
        version: "3.3.1",
        parameters: "--format fasta; default protein scoring and gap penalties",
        aligned: parseFASTA(engine.FS.readFile("/aligned.fa", { encoding: "utf8" })),
        computeMs,
      },
    });
  } catch (error) {
    // Keep low-level filesystem paths and engine internals out of the user message.
    const safeMessages = new Set([
      "Kalign did not produce an alignment.",
      "Kalign detected a nucleotide-like alphabet. Check the input type. This build cannot force protein mode for some low-complexity proteins.",
      "Kalign reported an input error. The original sequences have not been changed.",
      "Invalid alignment FASTA header.",
      "Invalid alignment FASTA sequence.",
    ]);
    const message = safeMessages.has(error?.message) ? error.message
      : "The protein alignment engine could not load or complete this alignment. Please try again.";
    self.postMessage({ type: "error", message });
  }
};
