#!/usr/bin/env node
// Render personal skills from personal/_templates/<template>/ into personal/<user>/skills/.
//
//   generate.mjs --user <id> [--template <t>...|--all] [--answers <file.json>]
//                [--non-interactive|--interactive] [--force] [--root <personal-dir>] [--templates <dir>]
//
// Answers are stored in <root>/<user>/answers/<template>.json and reused as defaults on the next run.
// A generated skill that was edited by hand since it was generated is never overwritten without --force.
// Exit 0 ok, 1 error, 2 usage, 3 at least one template skipped because its output was hand-edited.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SKIP_IN_TEMPLATE = new Set(['template.md', 'questions.json']);

export class UsageError extends Error {}

export function parseArgs(argv) {
  const opts = { templates: [], all: false, nonInteractive: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--user': opts.user = val(); break;
      case '--template': opts.templates.push(val()); break;
      case '--all': opts.all = true; break;
      case '--answers': opts.answers = val(); break;
      case '--non-interactive': opts.nonInteractive = true; break;
      case '--interactive': opts.interactive = true; break;
      case '--force': opts.force = true; break;
      case '--root': opts.root = val(); break;
      case '--templates': opts.templatesDir = val(); break;
      case '-h': case '--help': opts.help = true; break;
      default: throw new UsageError(`unknown argument: ${a}`);
    }
  }
  return opts;
}

export const USAGE = `usage: generate.mjs --user <id> [--template <t>...|--all] [--answers <file.json>]
                    [--non-interactive|--interactive] [--force] [--root <personal-dir>] [--templates <dir>]
  --interactive  prompt even when stdin is not a terminal (answers piped one per line)
  --root       where <user>/ lives (default: $TILLER_PERSONAL_ROOT or <repo>/personal)
  --templates  template directory (default: <repo>/personal/_templates)`;

// {{key}}, {{#if key}}...{{else}}...{{/if}}; innermost blocks first so nesting works.
export function render(text, answers) {
  const truthy = (k) => {
    const v = answers[k];
    return v !== undefined && v !== null && String(v).trim() !== '' && v !== false;
  };
  const block = /\{\{#if ([a-z0-9_]+)\}\}((?:(?!\{\{#if )[\s\S])*?)\{\{\/if\}\}/i;
  // A tag alone on its line takes the line with it, so conditional bullets leave no blank lines.
  let out = text.replace(/^[ \t]*(\{\{(?:#if [a-z0-9_]+|else|\/if)\}\})[ \t]*\n/gim, '$1');
  for (let m = out.match(block); m; m = out.match(block)) {
    const [whole, key, body] = m;
    const [yes, no = ''] = body.split('{{else}}');
    out = out.slice(0, m.index) + (truthy(key) ? yes : no) + out.slice(m.index + whole.length);
  }
  out = out.replace(/\{\{([a-z0-9_]+)\}\}/gi, (whole, key) =>
    Object.prototype.hasOwnProperty.call(answers, key) && answers[key] !== null ? String(answers[key]) : whole);
  // Collapse the blank lines a false {{#if}} leaves behind.
  out = out.replace(/\n{3,}/g, '\n\n');
  const left = out.match(/\{\{[^}]*\}\}/g);
  if (left) throw new Error(`unresolved placeholders: ${[...new Set(left)].join(', ')}`);
  return out;
}

export function skillNameOf(rendered) {
  const fm = rendered.match(/^---\n([\s\S]*?)\n---/);
  const name = fm && fm[1].match(/^name:\s*(\S+)\s*$/m);
  if (!name) throw new Error('rendered template has no `name:` in its frontmatter');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name[1])) throw new Error(`invalid skill name: ${name[1]}`);
  return name[1];
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

function listFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? listFiles(p, base) : [path.relative(base, p)];
  }).sort();
}

export function loadTemplate(templatesDir, name) {
  const dir = path.join(templatesDir, name);
  const qPath = path.join(dir, 'questions.json');
  const tPath = path.join(dir, 'template.md');
  if (!fs.existsSync(tPath) || !fs.existsSync(qPath)) throw new Error(`no template '${name}' in ${templatesDir}`);
  const questions = JSON.parse(fs.readFileSync(qPath, 'utf8'));
  if (!Array.isArray(questions)) throw new Error(`${qPath}: expected an array`);
  for (const q of questions) {
    if (!q.key || !q.prompt) throw new Error(`${qPath}: every question needs key and prompt`);
  }
  const extras = listFiles(dir).filter((f) => !SKIP_IN_TEMPLATE.has(f));
  return { name, dir, questions, template: fs.readFileSync(tPath, 'utf8'), extras };
}

export function listTemplates(templatesDir) {
  return fs.readdirSync(templatesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(templatesDir, e.name, 'template.md')))
    .map((e) => e.name).sort();
}

const readJson = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);

// An answers file is either {key: value} shared by every template, or {<template>: {key: value}}.
function answersFor(file, template) {
  if (!file) return {};
  const scoped = file[template];
  const shared = Object.fromEntries(Object.entries(file).filter(([, v]) => typeof v !== 'object' || v === null));
  return { ...shared, ...(scoped && typeof scoped === 'object' ? scoped : {}) };
}

function makeAsker() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const lines = [];
  const waiters = [];
  let closed = false;
  rl.on('line', (l) => (waiters.length ? waiters.shift()(l) : lines.push(l)));
  rl.on('close', () => { closed = true; while (waiters.length) waiters.shift()(null); });
  const next = () => new Promise((res, rej) => {
    if (lines.length) res(lines.shift());
    else if (closed) rej(new Error('input ended before every question was answered'));
    else waiters.push((l) => (l === null ? rej(new Error('input ended before every question was answered')) : res(l)));
  });
  return {
    async ask(q, def) {
      const err = process.stderr;
      err.write(`\n${q.prompt}${q.required ? ' (required)' : ''}\n`);
      if (q.help) err.write(`  ${q.help.replace(/\n/g, '\n  ')}\n`);
      if (def !== undefined && def !== '') err.write(`  [default: ${String(def).replace(/\n/g, '\n            ')}]\n`);
      if (q.multiline) {
        err.write('  (several lines; end with a line containing only ".", empty first line keeps the default)\n');
        const got = [];
        for (;;) {
          const l = await next();
          if (l === '.' || (l === '' && got.length === 0)) break;
          got.push(l);
        }
        return got.length ? got.join('\n') : undefined;
      }
      err.write('> ');
      const l = (await next()).trim();
      return l === '' ? undefined : l;
    },
    close: () => rl.close(),
  };
}

async function collectAnswers(tpl, { stored, given, carried, interactive, asker }) {
  const answers = {};
  for (const q of tpl.questions) {
    const scope = { ...carried, ...answers };
    let def = stored[q.key] ?? carried[q.key] ?? (q.default !== undefined ? render(String(q.default), scope) : undefined);
    let value = given[q.key];
    if (value === undefined && interactive) value = await asker.ask(q, def);
    if (value === undefined) value = def;
    if (q.required && (value === undefined || String(value).trim() === '')) {
      throw new Error(`template '${tpl.name}': no answer for required question '${q.key}' (${q.prompt})`);
    }
    answers[q.key] = value ?? '';
  }
  return answers;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function seedLeakTerms(file, answers) {
  const names = new Set();
  for (const k of ['display_name', 'full_name']) {
    for (const part of String(answers[k] ?? '').split(/\s+/)) if (part.length >= 3) names.add(part.toLowerCase());
  }
  if (!names.size) return [];
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : [];
  const have = new Set(existing.map((l) => l.trim().toLowerCase()));
  const add = [...names].map((n) => `\\b${escapeRe(n)}\\b`).filter((t) => !have.has(t) && !have.has(t.replace(/\\b/g, '')));
  if (add.length) {
    const prefix = existing.length && existing[existing.length - 1] !== '' ? '\n' : '';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, prefix + add.join('\n') + '\n');
  }
  return add;
}

// Returns the files that differ from what the last generation wrote, or null when nothing to protect.
function handEdits(skillDir, record) {
  if (!fs.existsSync(skillDir)) return null;
  const now = listFiles(skillDir);
  if (!record) return now.length ? ['(no generation record: the skill was not made by this generator)'] : null;
  const changed = [];
  for (const f of new Set([...now, ...Object.keys(record.files)])) {
    const p = path.join(skillDir, f);
    const h = fs.existsSync(p) ? sha(fs.readFileSync(p)) : null;
    if (h !== record.files[f]) changed.push(f);
  }
  return changed.length ? changed : null;
}

export async function generate(opts, log = (m) => process.stderr.write(m + '\n')) {
  if (!opts.user || !/^[a-z0-9][a-z0-9_-]*$/.test(opts.user)) throw new UsageError('--user <id> is required (lowercase id)');
  const templatesDir = path.resolve(opts.templatesDir ?? path.join(REPO, 'personal', '_templates'));
  const root = path.resolve(opts.root ?? process.env.TILLER_PERSONAL_ROOT ?? path.join(REPO, 'personal'));
  const names = opts.all || !opts.templates.length ? listTemplates(templatesDir) : opts.templates;
  const userDir = path.join(root, opts.user);
  const file = opts.answers ? JSON.parse(fs.readFileSync(opts.answers, 'utf8')) : null;
  const interactive = opts.interactive || (!opts.nonInteractive && process.stdin.isTTY);
  const asker = interactive ? makeAsker() : null;
  const carried = {};
  const result = { generated: [], skipped: [], leakTerms: [] };
  try {
    for (const name of names) {
      const tpl = loadTemplate(templatesDir, name);
      const answersPath = path.join(userDir, 'answers', `${name}.json`);
      const recordPath = path.join(userDir, 'answers', `${name}.generated.json`);
      if (interactive) log(`\n== ${name} ==`);
      const answers = await collectAnswers(tpl, {
        stored: readJson(answersPath) ?? {}, given: answersFor(file, name), carried, interactive, asker,
      });
      Object.assign(carried, answers);
      const rendered = render(tpl.template, answers);
      const skill = skillNameOf(rendered);
      const skillDir = path.join(userDir, 'skills', skill);

      const record = readJson(recordPath);
      const edited = handEdits(skillDir, record && record.skill === skill ? record : null);
      fs.mkdirSync(path.dirname(answersPath), { recursive: true });
      fs.writeFileSync(answersPath, JSON.stringify(answers, null, 2) + '\n');
      if (edited && !opts.force) {
        log(`skipped: ${skill} (${skillDir} was edited since generation: ${edited.join(', ')}; --force overwrites)`);
        result.skipped.push(skill);
        continue;
      }

      const out = { 'SKILL.md': Buffer.from(rendered) };
      for (const f of tpl.extras) out[f] = fs.readFileSync(path.join(tpl.dir, f));
      fs.rmSync(skillDir, { recursive: true, force: true });
      for (const [f, buf] of Object.entries(out)) {
        const p = path.join(skillDir, f);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, buf);
        if (fs.statSync(path.join(tpl.dir, f === 'SKILL.md' ? 'template.md' : f)).mode & 0o111) fs.chmodSync(p, 0o755);
      }
      const files = Object.fromEntries(Object.entries(out).map(([f, buf]) => [f, sha(buf)]));
      fs.writeFileSync(recordPath, JSON.stringify({ template: name, skill, files }, null, 2) + '\n');
      result.leakTerms.push(...seedLeakTerms(path.join(userDir, 'leak-terms.txt'), answers));
      log(`generated: ${skill} -> ${skillDir}`);
      result.generated.push(skill);
    }
  } finally {
    asker?.close();
  }
  return result;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n${USAGE}\n`);
    process.exit(2);
  }
  if (opts.help) { process.stdout.write(USAGE + '\n'); process.exit(0); }
  generate(opts).then(
    (r) => process.exit(r.skipped.length ? 3 : 0),
    (e) => {
      process.stderr.write(`error: ${e.message}\n`);
      if (e instanceof UsageError) process.stderr.write(USAGE + '\n');
      process.exit(e instanceof UsageError ? 2 : 1);
    },
  );
}
