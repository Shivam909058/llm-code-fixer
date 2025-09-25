// main.js — improved and fixed version of the fixer tool
// Usage: import { tryq, help, applyFix, fixAndTestFile } from "./main.js"

import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import * as recast from "recast";
import babelParser from "@babel/parser";

const openai = new OpenAI({ /* ensure OPENAI_API_KEY env var is set */ });

// Resolve __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ------------ Config ------------
const ROOT_DIR = path.resolve(path.join(__dirname, "..")); // project root
const INDEX_FILE = path.join(__dirname, ".vector_index.json");
const INCLUDE_EXTS = [".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"];
const EMBEDDING_MODEL = "text-embedding-3-large";
const FIX_MODEL = "gpt-4o";
const TOP_K = 10;
const MAX_CHUNK_LEN = 3000; // chars per chunk
const MAX_ROUNDS = 5; // increased for stronger fixing
// ---------------------------------

// Optional FAISS index (if installed). Fallback to cosine.
let faiss = null;
try {
  // optional: npm i faiss-node
  faiss = await import("faiss-node").then(m => m.default || m).catch(() => null);
} catch {
  faiss = null;
}

// ------------ Utils ------------
function listFilesRecursive(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === ".git") continue;
      out.push(...listFilesRecursive(p));
    } else {
      if (INCLUDE_EXTS.includes(path.extname(p).toLowerCase())) out.push(p);
    }
  }
  return out;
}

function sha1(s) {
  return crypto.createHash("sha1").update(s).digest("hex");
}

function cosineSim(a = [], b = []) {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readText(p) {
  return fs.readFileSync(p, "utf-8");
}

function writeText(p, content) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, content, "utf-8");
}

function parseAst(code, filePath) {
  try {
    return recast.parse(code, {
      parser: {
        parse(source) {
          return babelParser.parse(source, {
            sourceType: "module",
            plugins: ["jsx", "typescript", "classProperties", "decorators-legacy"],
          });
        },
      },
    });
  } catch (err) {
    // Return null when parse fails (we'll fallback to file chunking)
    return null;
  }
}

function extractFunctionChunks(code, filePath) {
  const ast = parseAst(code, filePath);
  const chunks = [];

  if (ast) {
    try {
      recast.types.visit(ast, {
        visitFunction(pathNode) {
          const node = pathNode.node;
          const loc = node.loc;
          if (!loc) {
            this.traverse(pathNode);
            return;
          }
          const start = loc.start.line;
          const end = loc.end.line;
          const lines = code.split(/\r?\n/);
          const text = lines.slice(start - 1, end).join("\n");
          const name =
            node.id?.name ||
            (pathNode.parent?.node?.key?.name) ||
            (node.type || "Function").toString();
          chunks.push({
            id: sha1(`${filePath}:${start}-${end}`),
            filePath,
            kind: "function",
            name,
            startLine: start,
            endLine: end,
            text: text.slice(0, MAX_CHUNK_LEN),
          });
          this.traverse(pathNode);
        },
      });
    } catch {
      // fallthrough to file-level chunk below
    }
  }

  // Fallback: file-level chunk if AST absent or no function chunks
  if (chunks.length === 0) {
    const lines = code.split(/\r?\n/);
    chunks.push({
      id: sha1(`${filePath}:1-${lines.length}`),
      filePath,
      kind: "file",
      name: path.basename(filePath),
      startLine: 1,
      endLine: lines.length,
      text: code.slice(0, Math.min(code.length, MAX_CHUNK_LEN)),
    });
  }
  return chunks;
}
// -------------------------------

// ------------ Indexing + Vector Search ------------
async function embed(texts) {
  if (!Array.isArray(texts)) texts = [String(texts)];
  const res = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
  });
  return res.data.map(d => d.embedding);
}

async function buildIndex() {
  const files = listFilesRecursive(ROOT_DIR);
  const all = [];
  for (const f of files) {
    try {
      const code = readText(f);
      const chunks = extractFunctionChunks(code, f);
      for (const ch of chunks) all.push(ch);
    } catch (err) {
      // ignore read/parse errors per-file
    }
  }
  if (!all.length) {
    writeText(INDEX_FILE, JSON.stringify({ createdAt: Date.now(), root: ROOT_DIR, model: EMBEDDING_MODEL, index: [] }, null, 2));
    return [];
  }
  const embs = await embed(all.map(c => c.text));
  const index = all.map((c, i) => ({ ...c, embedding: embs[i] || [] }));

  const payload = { createdAt: Date.now(), root: ROOT_DIR, model: EMBEDDING_MODEL, index };
  writeText(INDEX_FILE, JSON.stringify(payload, null, 2));
  return index;
}

function loadIndex() {
  if (!fs.existsSync(INDEX_FILE)) return null;
  try {
    const parsed = JSON.parse(readText(INDEX_FILE));
    return parsed.index || null;
  } catch {
    return null;
  }
}

function buildFaissIndex(index) {
  if (!faiss) return null;
  if (!index?.length) return null;
  const dim = index[0].embedding.length;
  const ids = new Int32Array(index.length);
  const data = new Float32Array(index.length * dim);
  index.forEach((item, i) => {
    ids[i] = i;
    data.set(Float32Array.from(item.embedding), i * dim);
  });
  const cpuIndex = new faiss.IndexFlatIP(dim);
  cpuIndex.addWithIds(data, ids);
  return { cpuIndex, dim };
}

let faissIndexCache = null;
function ensureFaiss(index) {
  if (!faiss) return null;
  if (faissIndexCache) return faissIndexCache;
  faissIndexCache = buildFaissIndex(index);
  return faissIndexCache;
}

async function vectorSearch(query, k = TOP_K) {
  let index = loadIndex();
  if (!index) index = await buildIndex();
  if (!index || !index.length) return [];

  const [q] = await embed([query]);
  const faissCtx = ensureFaiss(index);

  if (faissCtx) {
    const { cpuIndex, dim } = faissCtx;
    const qArr = Float32Array.from(q);
    const D = new Float32Array(k);
    const I = new Int32Array(k);
    cpuIndex.search(qArr, k, D, I);
    const results = [];
    for (let r = 0; r < k; r++) {
      const idx = I[r];
      if (idx >= 0 && idx < index.length) {
        results.push({ item: index[idx], score: D[r] });
      }
    }
    return results.map(r => r.item);
  }

  // fallback cosine
  const scored = index.map(item => ({ item, score: cosineSim(item.embedding, q) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map(s => s.item);
}
// --------------------------------------------------

// Build prompt + ask LLM for JSON edits
async function proposeFixes(errorMessage, extraContext = "", preferredPaths = []) {
  const top = await vectorSearch(`${errorMessage}\n${extraContext || ""}`, TOP_K);
  const ctx = top.map((c, i) => [
    `# ${i + 1} | ${path.relative(ROOT_DIR, c.filePath)}:${c.startLine}-${c.endLine}`,
    "```",
    c.text,
    "```",
  ].join("\n")).join("\n\n");

  const system = [
    "You are an expert automated code-fixing assistant with deep knowledge of JavaScript, Node.js, and common programming patterns.",
    "Your goal is to analyze the provided error message, user-reported errors and instructions, relevant code context, and the file content to propose comprehensive fixes.",
    "Fix ALL potential syntax, runtime, and logic issues—not just the reported error. Ensure the code is robust, efficient, and maintains original functionality unless it's buggy or contradicted by user instructions.",
    "If rewriting a file, make the code clean, well-structured, idiomatic, and add comments only if specified in user instructions.",
    "Return ONLY a valid JSON object with this exact structure:",
    "{",
    '  "edits": [',
    '    {',
    '      "path": "relative/path.js", // relative to project root',
    '      "strategy": "replace_file", // or "replace_range" if partial edit',
    '      "new_content": "FULL updated file content string with a brief top-of-file comment explaining the fix", // for replace_file',
    '      "startLine": 5, // for replace_range (1-based)',
    '      "endLine": 10, // for replace_range (inclusive)',
    '      "new_text": "Replacement text for the range" // for replace_range',
    '    }',
    "  ]",
    "}",
    "Rules:",
    "- Propose edits for all files that need changes to fully resolve the issues.",
    "- If preferred paths are provided, prioritize fixing those but include others if necessary.",
    "- Prefer 'replace_file' strategy for simplicity and to avoid partial edit errors.",
    "- For 'replace_file', include a short // comment at the very top explaining the changes made.",
    "- For 'replace_range', specify exact 1-based line numbers and the exact replacement text.",
    "- Incorporate any user-reported errors, message logs, and instructions to guide the fixes.",
    "- Ensure the JSON is parsable and contains no extra text, markdown, or explanations outside the JSON.",
    "- If no fixes are needed, return an empty edits array.",
  ].join("\n");

  const user = [
    `Error Message: ${errorMessage}`,
    preferredPaths.length ? `Preferred files to focus on: ${preferredPaths.join(", ")}` : "",
    extraContext ? `Additional Context (including user-reported errors, message logs, and instructions):\n${extraContext}` : "",
    "",
    "Relevant Codebase Chunks (from vector search):",
    ctx,
    "",
    "Propose the JSON edits now.",
  ].join("\n");

  // Use chat completion - keep temperature low for deterministic edits
  const resp = await openai.chat.completions.create({
    model: FIX_MODEL,
    response_format: { type: "json_object" },
    temperature: 0.1, // lower for more deterministic
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  let content = resp.choices?.[0]?.message?.content?.trim() || "{}";
  try {
    return JSON.parse(content);
  } catch (err) {
    // fallback: empty edits (avoid throwing)
    return { edits: [] };
  }
}

// ------------ Apply Edits (range + replace) ------------
function backupFile(absPath) {
  const dir = path.join(os.tmpdir(), "llm_fixes");
  ensureDir(dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = path.basename(absPath);
  const bak = path.join(dir, `${base}.${stamp}.bak`);
  try { fs.copyFileSync(absPath, bak); } catch {}
  return bak;
}

function applyReplaceRange(absPath, startLine, endLine, newText) {
  const raw = readText(absPath);
  const lines = raw.split(/\r?\n/);
  const clampedStart = Math.max(1, Math.min(startLine, lines.length));
  const clampedEnd = Math.max(clampedStart, Math.min(endLine, lines.length));
  const before = lines.slice(0, clampedStart - 1);
  const after = lines.slice(clampedEnd);
  const result = [...before, ...newText.split(/\r?\n/), ...after].join("\n");
  writeText(absPath, result);
}

function applyEdits(edits) {
  const results = [];
  for (const e of (edits || [])) {
    const abs = path.isAbsolute(e.path) ? e.path : path.join(ROOT_DIR, e.path);
    try {
      const exists = fs.existsSync(abs);
      if (exists) backupFile(abs); else ensureDir(path.dirname(abs));

      if (e.strategy === "replace_range") {
        if (typeof e.new_text !== "string" || !e.startLine || !e.endLine) throw new Error("missing fields for replace_range");
        applyReplaceRange(abs, e.startLine, e.endLine, e.new_text);
        results.push({ path: abs, ok: true, strategy: e.strategy });
      } else if (e.strategy === "replace_file") {
        if (typeof e.new_content !== "string") throw new Error("missing new_content");
        writeText(abs, e.new_content);
        results.push({ path: abs, ok: true, strategy: e.strategy });
      } else {
        results.push({ path: abs, ok: false, reason: "unknown strategy" });
      }
    } catch (err) {
      results.push({ path: abs, ok: false, reason: err?.message || String(err) });
    }
  }
  return results;
}
// -------------------------------------------------------------

// ------------ Public Inline API ------------
export async function help(errMessage, extraContext = "", preferredPaths = []) {
  const proposal = await proposeFixes(errMessage, extraContext, preferredPaths);
  const results = applyEdits(proposal?.edits || []);
  return { proposal, results };
}

export async function applyFix(fixJson) {
  if (!fixJson || !Array.isArray(fixJson.edits)) return [];
  return applyEdits(fixJson.edits);
}

export async function tryq(fn, extraContext = "", preferredPaths = []) {
  try {
    const out = await fn();
    return { ok: true, out };
  } catch (err) {
    // Get fix proposal using actual error
    const errorMsg = err?.message || String(err);
    const fix = await help(
      `Fix ALL syntax, runtime, and logic issues related to this error: ${errorMsg}. Rewrite affected files to be valid, bug-free JS if needed.`,
      extraContext,
      preferredPaths
    );

    // Apply fix immediately 🔥
    if (fix?.proposal?.edits?.length) {
      await applyFix(fix.proposal);
      console.log("✅ Fix applied automatically:", fix.proposal.edits.map(e => e.path));
    } else {
      console.log("⚠️ No edits proposed.");
    }

    // Return failure info (user can retry the fn manually after fix)
    return { ok: false, error: errorMsg, fix };
  }
}

// -----------------------------------------

// ---------- dynamic import helper ----------
async function importFresh(p) {
  const modPath = path.resolve(p) + "?t=" + Date.now();
  return await import("file://" + modPath);
}

// ---------- convenience: create basic buggy files if missing (for testing) ----------
async function ensureBugFile() {
  const p = path.join(__dirname, "buggy_example.js");
  if (!fs.existsSync(p)) {
    writeText(p,
`export function add(a, b) {
  // BUG: wrong variable name triggers ReferenceError
  return a + bb;
}
export function run() {
  return add(1, 2);
}
`);
  }
  return p;
}

async function ensureMultiBugFile() {
  const p = path.join(__dirname, "multi_bug_example.js");
  if (!fs.existsSync(p)) {
    writeText(p,
`export async function computeSum(a, b) {
  // BUG1: wrong variable name
  const total = a + bb;

  // BUG2: awaiting non-promise
  const val = await 42;

  // BUG3: logic bug (result should be a + b)
  const flag = true;
  const result = flag ? a - b : a + b;

  return total + val + result;
}

export function run() {
  return computeSum(2, 3);
}
`);
  }
  return p;
}

// ---------- high-level helper that attempts to fix & re-run a target file ----------
export async function fixAndTestFile(relativePath, options = {}) {
  // relativePath: path relative to ROOT_DIR or absolute
  // options: { testExportName: "run", maxRounds: 3, extraContext: "" }
  const maxRounds = options.maxRounds || MAX_ROUNDS;
  const testExportName = options.testExportName || "run";
  const userExtraContext = options.extraContext || '';
  const absPath = path.isAbsolute(relativePath) ? relativePath : path.join(ROOT_DIR, relativePath);

  // ensure index
  let index = loadIndex();
  if (!index) {
    console.log("Building vector index...");
    index = await buildIndex();
    console.log("Index built.");
  }

  let lastError = null;
  const history = [];

  for (let round = 1; round <= maxRounds; round++) {
    let mod;
    try {
      mod = await importFresh(absPath);
    } catch (err) {
      // If the file has a syntax error, err is thrown at import time.
      lastError = err;
      console.log(`[round ${round}] Import failed: ${err?.message || err}`);
      // ask LLM to fix parse-time error
      const fileContent = readText(absPath);
      const extraContext = `${userExtraContext}${fileContent ? `\nFile content:\n${fileContent}` : ''}`;
      const fixRes = await help(`${err?.message || String(err)}. Fix all syntax issues and make the file importable.`, extraContext, [path.relative(ROOT_DIR, absPath)]);
      history.push({ round, error: String(err), fixRes });
      if (!fixRes?.results?.length) break;
      // continue to next round (file refreshed next loop)
      continue;
    }

    // Determine what to call: prefer named testExportName, then default, then first exported function
    const candidate = mod[testExportName] || mod.default || (() => {
      // find first exported function
      for (const k of Object.keys(mod)) {
        if (typeof mod[k] === "function") return mod[k];
      }
      return null;
    })();

    if (!candidate || typeof candidate !== "function") {
      lastError = new Error(`No runnable export found in ${relativePath} (tried '${testExportName}', default, and first export)`);
      const fileContent = readText(absPath);
      const extraContext = `${userExtraContext}${fileContent ? `\nFile content:\n${fileContent}` : ''}`;
      const fixRes = await help(lastError.message, extraContext, [path.relative(ROOT_DIR, absPath)]);
      history.push({ round, error: lastError.message, fixRes });
      if (!fixRes?.results?.length) break;
      continue;
    }

    // Run candidate inside tryq
    const fileContent = readText(absPath);
    const extraContext = `${userExtraContext}${fileContent ? `\nFile content:\n${fileContent}` : ''}`;
    const attempt = await tryq(() => candidate(), extraContext, [path.relative(ROOT_DIR, absPath)]);
    history.push({ round, attempt });

    if (attempt.ok) {
      return { ok: true, rounds: round, out: attempt.out, history };
    } else {
      // apply fixes already applied in tryq; continue to next round
      lastError = new Error(attempt.error);
      console.log(`[round ${round}] Runtime error: ${attempt.error}`);
    }
  }

  return { ok: false, rounds: maxRounds, error: lastError?.message || "unknown", history };
}

// ---------- optional test run functions ----------
export async function runErrorTestAndFix() {
  const buggy = await ensureBugFile();
  const relBuggy = path.relative(ROOT_DIR, buggy);
  const report = await fixAndTestFile(relBuggy, { testExportName: "run", maxRounds: 3 });
  console.log("runErrorTestAndFix report:", report);
}

export async function runMultiErrorTest() {
  const multi = await ensureMultiBugFile();
  const rel = path.relative(ROOT_DIR, multi);
  const report = await fixAndTestFile(rel, { testExportName: "run", maxRounds: 4 });
  console.log("runMultiErrorTest report:", report);
}

// Boot: build index if missing (non-blocking) and expose main runner when run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  // run tests when executed directly (node main.js)
  (async () => {
    try {
      if (!loadIndex()) {
        console.log("Building vector index...");
        await buildIndex();
        console.log("Index built.");
      }
      await runErrorTestAndFix();
      await runMultiErrorTest();
    } catch (err) {
      console.error("Boot error:", err);
    }
  })();
}