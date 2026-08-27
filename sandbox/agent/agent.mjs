#!/usr/bin/env node
/**
 * In-container agent runtime for the ENGINEER role.
 *
 * Contract with the provisioning layer (src/provisioning.ts):
 *   - /task/task.json  (ro)  { role, task, context }
 *   - /workspace/src   (rw)  the working copy the agent edits
 *   - /workspace/tests (ro)  read-only context; the agent must not change tests
 *   - /out             (rw)  write status.json + agent.log here, then exit
 *   Exit 0 = tests pass, non-zero = gave up.
 *
 * Deliberately minimal and constrained: the model returns whole-file replacements
 * for files under src/, we apply them and run the project's test command, feeding
 * failures back for up to ORQ_MAX_ITERS turns. No shell access is given to the model.
 * Node built-ins + undici only (undici gives us a proxy-aware fetch; Node 22's global
 * fetch ignores HTTP(S)_PROXY).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';

import { EnvHttpProxyAgent, fetch } from 'undici';

// Paths follow the container contract by default; overridable only to allow the
// runtime to be exercised outside a container in tests.
const WORKSPACE = process.env.ORQ_WORKSPACE || '/workspace';
const TASK_FILE = process.env.TASK_FILE || '/task/task.json';
const OUT_DIR = process.env.OUT_DIR || '/out';
const SRC_DIR = path.join(WORKSPACE, 'src');
const TESTS_DIR = path.join(WORKSPACE, 'tests');
const MAX_FILE_BYTES = 32 * 1024;

const MODEL = process.env.ORQ_MODEL;
const BASE_URL = process.env.ORQ_MODEL_BASE_URL;
const API_KEY = process.env.OPENROUTER_API_KEY;
const TEST_CMD = process.env.ORQ_TEST_CMD;
const MAX_ITERS = Math.max(1, Number(process.env.ORQ_MAX_ITERS) || 3);

const log = [];
const dispatcher = new EnvHttpProxyAgent();

function note(line) {
  log.push(line);
  // stdout goes to container.log; never echo env / secrets here.
  console.log(line);
}

function finish({ status, summary, iterations, extra }) {
  try {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(
      path.join(OUT_DIR, 'status.json'),
      `${JSON.stringify({ status, role: 'engineer', summary, iterations, ...extra }, null, 2)}\n`,
    );
    writeFileSync(path.join(OUT_DIR, 'agent.log'), `${log.join('\n')}\n`);
  } catch (err) {
    console.error('failed to write result:', err?.message);
  }
  process.exit(status === 'completed' ? 0 : 1);
}

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function renderTree(dir, label) {
  const parts = [];
  for (const file of walk(dir).sort()) {
    const rel = path.relative(WORKSPACE, file);
    const size = statSync(file).size;
    if (size > MAX_FILE_BYTES) {
      parts.push(`=== ${rel} (${label}) ===\n[skipped: ${size} bytes > ${MAX_FILE_BYTES}]`);
      continue;
    }
    parts.push(`=== ${rel} (${label}) ===\n${readFileSync(file, 'utf8')}`);
  }
  return parts.join('\n\n') || `(no files under ${path.relative(WORKSPACE, dir) || dir})`;
}

function extractJson(text) {
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in model reply');
  return JSON.parse(t.slice(start, end + 1));
}

function resolveSrcPath(p) {
  const rel = path.posix.normalize(String(p)).replace(/^\/+/, '');
  if (!rel.startsWith('src/') || rel.split('/').includes('..')) {
    throw new Error(`refusing to write outside src/: ${p}`);
  }
  return path.join(WORKSPACE, rel);
}

function applyFiles(files) {
  const written = [];
  for (const f of files ?? []) {
    if (!f || typeof f.path !== 'string' || typeof f.content !== 'string') {
      throw new Error('each file needs string "path" and "content"');
    }
    const dest = resolveSrcPath(f.path);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, f.content);
    written.push(path.relative(WORKSPACE, dest));
  }
  return written;
}

function runTests() {
  const r = spawnSync('/bin/sh', ['-c', TEST_CMD], {
    cwd: WORKSPACE,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const output = `${r.stdout || ''}${r.stderr || ''}`;
  return { pass: r.status === 0, code: r.status, output };
}

async function callModel(messages) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    dispatcher,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${API_KEY}`,
      'x-title': 'agent-orchestrator',
    },
    body: JSON.stringify({ model: MODEL, messages, temperature: 0 }),
  });
  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`model API ${res.status}: ${bodyText.slice(0, 500)}`);
  }
  const data = JSON.parse(bodyText);
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('model returned no content');
  }
  return content;
}

async function main() {
  for (const [name, val] of [
    ['ORQ_MODEL', MODEL],
    ['ORQ_MODEL_BASE_URL', BASE_URL],
    ['OPENROUTER_API_KEY', API_KEY],
    ['ORQ_TEST_CMD', TEST_CMD],
  ]) {
    if (!val) finish({ status: 'failed', summary: `missing required env ${name}`, iterations: 0 });
  }

  const task = JSON.parse(readFileSync(TASK_FILE, 'utf8'));
  if (task.role && task.role !== 'engineer') {
    finish({ status: 'failed', summary: `unsupported role: ${task.role}`, iterations: 0 });
  }
  note(`engineer agent: model=${MODEL} maxIters=${MAX_ITERS}`);

  const systemPrompt =
    'You are an automated software engineer. You are given a task, the project test ' +
    'files (READ-ONLY), and the current source files. Edit ONLY files under src/ to ' +
    'make every test pass. You must not modify tests. Respond with a SINGLE JSON ' +
    'object and nothing else:\n' +
    '{"files":[{"path":"src/<relative path>","content":"<complete new file contents>"}],' +
    '"note":"<one line on what you changed>"}\n' +
    'Include the full content of every file you change; omit files you do not change.';

  const messages = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content:
        `TASK:\n${task.task}\n\n` +
        (task.context ? `CONTEXT:\n${task.context}\n\n` : '') +
        `TEST FILES:\n${renderTree(TESTS_DIR, 'read-only')}\n\n` +
        `SOURCE FILES:\n${renderTree(SRC_DIR, 'editable')}`,
    },
  ];

  let lastNote = '';
  for (let iter = 1; iter <= MAX_ITERS; iter++) {
    note(`--- iteration ${iter} ---`);
    let reply;
    try {
      reply = await callModel(messages);
    } catch (err) {
      note(`model call failed: ${err.message}`);
      if (iter === MAX_ITERS) {
        finish({ status: 'failed', summary: `model call failed: ${err.message}`, iterations: iter });
      }
      continue;
    }

    let parsed;
    try {
      parsed = extractJson(reply);
      const written = applyFiles(parsed.files);
      lastNote = typeof parsed.note === 'string' ? parsed.note : '';
      note(`applied ${written.length} file(s): ${written.join(', ')}${lastNote ? ` — ${lastNote}` : ''}`);
    } catch (err) {
      note(`could not apply model reply: ${err.message}`);
      messages.push({ role: 'assistant', content: reply });
      messages.push({
        role: 'user',
        content: `That reply could not be used (${err.message}). Return the JSON format exactly.`,
      });
      if (iter === MAX_ITERS) {
        finish({ status: 'failed', summary: `unusable model reply: ${err.message}`, iterations: iter });
      }
      continue;
    }

    const { pass, code, output } = runTests();
    note(`tests exit=${code} pass=${pass}`);
    if (pass) {
      finish({
        status: 'completed',
        summary: lastNote || `made tests pass in ${iter} iteration(s)`,
        iterations: iter,
        extra: { note: lastNote },
      });
    }

    const tail = output.slice(-8000);
    messages.push({ role: 'assistant', content: reply });
    messages.push({
      role: 'user',
      content: `Tests still fail (exit ${code}). Output:\n${tail}\n\nReturn the same JSON format with corrected files.`,
    });
  }

  finish({
    status: 'failed',
    summary: `tests still failing after ${MAX_ITERS} iteration(s)`,
    iterations: MAX_ITERS,
    extra: { note: lastNote },
  });
}

main().catch((err) => {
  note(`fatal: ${err?.stack || err?.message || err}`);
  finish({ status: 'failed', summary: `fatal: ${err?.message || err}`, iterations: 0 });
});
