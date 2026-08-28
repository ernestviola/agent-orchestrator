#!/usr/bin/env node
/**
 * In-container agent runtime for the ENGINEER and TEST-ENGINEER roles.
 *
 * Contract with the provisioning layer (src/provisioning.ts):
 *   - /task/task.json  (ro)  { role, task, context }
 *   - /workspace/src         engineer: rw working copy | test-engineer: ro context
 *   - /workspace/tests       engineer: ro context      | test-engineer: rw working copy
 *   - /out             (rw)  write status.json + agent.log here, then exit
 *   Exit 0 = role goal reached, non-zero = gave up.
 *
 * The role's writable dir is enforced by the mount profile (src/roles.ts), not by
 * this code — a bad path here is a belt-and-braces reject, not the boundary.
 *
 * Deliberately minimal and constrained: the model returns whole-file replacements
 * for files under the role's writable dir; we apply them and run the project's test
 * command. No shell access is given to the model. Node built-ins + undici only
 * (undici gives us a proxy-aware fetch; Node 22's global fetch ignores HTTP(S)_PROXY).
 *
 * Role loop shape:
 *   - engineer      : apply -> run tests -> feed failures back, up to ORQ_MAX_ITERS
 *                     turns. Success = tests pass.
 *   - test-engineer : author test files once (retry only an unusable reply). The
 *                     drafted tests are expected to FAIL against an unimplemented
 *                     src/, so their pass/fail does not gate completion — the human
 *                     approval gate downstream judges them (docs/DESIGN.md). We run
 *                     the test command once anyway and record the outcome.
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

// Per-role configuration. `writeDir` / `writePrefix` are the ONLY location the model
// is allowed to write; everything else is read-only context.
const ROLE_CONFIG = {
  engineer: {
    writeDir: SRC_DIR,
    writePrefix: 'src/',
    contextDir: TESTS_DIR,
    contextLabel: 'TEST FILES',
    writeLabel: 'SOURCE FILES',
    loop: 'until-tests-pass',
    systemPrompt:
      'You are an automated software engineer. You are given a task, the project test ' +
      'files (READ-ONLY), and the current source files. Edit ONLY files under src/ to ' +
      'make every test pass. You must not modify tests. Respond with a SINGLE JSON ' +
      'object and nothing else:\n' +
      '{"files":[{"path":"src/<relative path>","content":"<complete new file contents>"}],' +
      '"note":"<one line on what you changed>"}\n' +
      'Include the full content of every file you change; omit files you do not change.',
  },
  'test-engineer': {
    writeDir: TESTS_DIR,
    writePrefix: 'tests/',
    contextDir: SRC_DIR,
    contextLabel: 'SOURCE FILES',
    writeLabel: 'TEST FILES',
    loop: 'author-once',
    systemPrompt:
      'You are an automated test engineer. You are given a task describing requirements ' +
      'and the project source files (READ-ONLY) for interface and context. Write or ' +
      'update test files under tests/ that capture the requirements as executable ' +
      'tests. Do NOT implement or change anything under src/ — you only write tests. ' +
      'The tests you write are EXPECTED TO FAIL until an engineer implements the code; ' +
      'that is correct. Write specific, meaningful assertions — not tests that pass ' +
      'trivially. Match the test framework already used in tests/. Respond with a ' +
      'SINGLE JSON object and nothing else:\n' +
      '{"files":[{"path":"tests/<relative path>","content":"<complete new file contents>"}],' +
      '"note":"<one line on what you added>"}\n' +
      'Include the full content of every test file you write; omit files you do not change.',
  },
};

const log = [];
const dispatcher = new EnvHttpProxyAgent();
let ROLE = 'engineer';

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
      `${JSON.stringify({ status, role: ROLE, summary, iterations, ...extra }, null, 2)}\n`,
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

function resolveWritePath(p, prefix) {
  const rel = path.posix.normalize(String(p)).replace(/^\/+/, '');
  if (!rel.startsWith(prefix) || rel.split('/').includes('..')) {
    throw new Error(`refusing to write outside ${prefix}: ${p}`);
  }
  return path.join(WORKSPACE, rel);
}

function applyFiles(files, prefix) {
  const written = [];
  for (const f of files ?? []) {
    if (!f || typeof f.path !== 'string' || typeof f.content !== 'string') {
      throw new Error('each file needs string "path" and "content"');
    }
    const dest = resolveWritePath(f.path, prefix);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, f.content);
    written.push(path.relative(WORKSPACE, dest));
  }
  if (written.length === 0) throw new Error('model returned no files to write');
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
  const task = JSON.parse(readFileSync(TASK_FILE, 'utf8'));
  ROLE = task.role || 'engineer';
  const cfg = ROLE_CONFIG[ROLE];
  if (!cfg) {
    finish({ status: 'failed', summary: `unsupported role: ${ROLE}`, iterations: 0 });
  }

  for (const [name, val] of [
    ['ORQ_MODEL', MODEL],
    ['ORQ_MODEL_BASE_URL', BASE_URL],
    ['OPENROUTER_API_KEY', API_KEY],
    ['ORQ_TEST_CMD', TEST_CMD],
  ]) {
    if (!val) finish({ status: 'failed', summary: `missing required env ${name}`, iterations: 0 });
  }

  note(`${ROLE} agent: model=${MODEL} maxIters=${MAX_ITERS} loop=${cfg.loop}`);

  const messages = [
    { role: 'system', content: cfg.systemPrompt },
    {
      role: 'user',
      content:
        `TASK:\n${task.task}\n\n` +
        (task.context ? `CONTEXT:\n${task.context}\n\n` : '') +
        `${cfg.contextLabel} (read-only):\n${renderTree(cfg.contextDir, 'read-only')}\n\n` +
        `${cfg.writeLabel} (you edit these):\n${renderTree(cfg.writeDir, 'editable')}`,
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

    let written;
    try {
      const parsed = extractJson(reply);
      written = applyFiles(parsed.files, cfg.writePrefix);
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

    if (cfg.loop === 'author-once') {
      // The drafted tests are expected to fail against an unimplemented src/. Record
      // the outcome for the reviewer / human gate, but do not gate on it. `testsPass`
      // true here is a smell worth surfacing (tests may be trivially satisfiable).
      finish({
        status: 'completed',
        summary:
          lastNote ||
          `drafted ${written.length} test file(s)` +
            (pass ? ' (note: they already pass against the current src/)' : ''),
        iterations: iter,
        extra: {
          note: lastNote,
          filesWritten: written,
          testsRan: code !== null,
          testsPass: pass,
          testExit: code,
        },
      });
    }

    // engineer: loop until the tests pass.
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
