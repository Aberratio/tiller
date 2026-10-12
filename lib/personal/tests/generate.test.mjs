import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generate, render, listTemplates, loadTemplate } from '../generate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const REAL_TEMPLATES = path.join(REPO, 'personal', '_templates');
const CLI = path.join(HERE, '..', 'generate.mjs');
const quiet = () => {};

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'personal-gen-'));
}

function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v));
  return p;
}

function toyTemplates(dir) {
  const t = path.join(dir, 'templates', 'greet');
  fs.mkdirSync(t, { recursive: true });
  fs.writeFileSync(path.join(t, 'template.md'),
    '---\nname: greet-{{name}}\n---\nHi {{display_name}}.\n{{#if channel}}Post in {{channel}}.{{else}}No channel.{{/if}}\n');
  writeJson(path.join(t, 'questions.json'), [
    { key: 'name', prompt: 'suffix', required: true },
    { key: 'display_name', prompt: 'name', required: true },
    { key: 'full_name', prompt: 'full', required: false, default: '{{display_name}} Example' },
    { key: 'channel', prompt: 'channel', required: false, default: '' },
  ]);
  fs.writeFileSync(path.join(t, 'helper.sh'), '#!/bin/sh\necho hi\n', { mode: 0o755 });
  return path.join(dir, 'templates');
}

const opts = (root, templatesDir, extra = {}) => ({
  user: 'tess', templates: [], all: true, nonInteractive: true, force: false, root, templatesDir, ...extra,
});

test('render substitutes, resolves nested conditionals, and fails on leftovers', () => {
  assert.equal(render('{{a}}{{#if b}}[{{#if c}}c{{else}}no-c{{/if}}]{{/if}}', { a: 'x', b: 'y', c: '' }), 'x[no-c]');
  assert.equal(render('{{#if b}}yes{{else}}no{{/if}}', { b: '' }), 'no');
  assert.equal(render('- a\n{{#if b}}\n- b\n{{/if}}\n- c\n', { b: '' }), '- a\n- c\n');
  assert.equal(render('- a\n{{#if b}}\n- {{b}}\n{{/if}}\n- c\n', { b: 'x' }), '- a\n- x\n- c\n');
  assert.throws(() => render('hello {{missing}}', {}), /unresolved placeholders: \{\{missing\}\}/);
});

test('generates a skill from an answers file into the given root', async () => {
  const dir = tmp();
  const root = path.join(dir, 'personal');
  const answers = writeJson(path.join(dir, 'answers.json'), { name: 'tess', display_name: 'Tess', channel: '#daily' });
  const r = await generate(opts(root, toyTemplates(dir), { answers }), quiet);
  assert.deepEqual(r.generated, ['greet-tess']);
  const skill = path.join(root, 'tess', 'skills', 'greet-tess');
  assert.equal(fs.readFileSync(path.join(skill, 'SKILL.md'), 'utf8'), '---\nname: greet-tess\n---\nHi Tess.\nPost in #daily.\n');
  assert.ok(fs.statSync(path.join(skill, 'helper.sh')).mode & 0o100, 'extra file keeps its exec bit');
  const stored = JSON.parse(fs.readFileSync(path.join(root, 'tess', 'answers', 'greet.json'), 'utf8'));
  assert.equal(stored.full_name, 'Tess Example', 'default may reference an earlier answer');
  const terms = fs.readFileSync(path.join(root, 'tess', 'leak-terms.txt'), 'utf8').trim().split('\n');
  assert.deepEqual(terms.sort(), ['\\bexample\\b', '\\btess\\b']);
});

test('re-running reuses stored answers and de-duplicates leak terms', async () => {
  const dir = tmp();
  const root = path.join(dir, 'personal');
  const templatesDir = toyTemplates(dir);
  const answers = writeJson(path.join(dir, 'answers.json'), { greet: { name: 'tess', display_name: 'Tess' } });
  await generate(opts(root, templatesDir, { answers }), quiet);
  fs.appendFileSync(path.join(root, 'tess', 'leak-terms.txt'), '# kept\n');
  const r = await generate(opts(root, templatesDir), quiet);
  assert.deepEqual(r.generated, ['greet-tess']);
  const lines = fs.readFileSync(path.join(root, 'tess', 'leak-terms.txt'), 'utf8').trim().split('\n');
  assert.equal(lines.filter((l) => l === '\\btess\\b').length, 1);
  assert.ok(lines.includes('# kept'));
});

test('refuses to overwrite a hand-edited skill unless forced', async () => {
  const dir = tmp();
  const root = path.join(dir, 'personal');
  const templatesDir = toyTemplates(dir);
  const answers = writeJson(path.join(dir, 'a.json'), { name: 'tess', display_name: 'Tess' });
  await generate(opts(root, templatesDir, { answers }), quiet);
  const skillMd = path.join(root, 'tess', 'skills', 'greet-tess', 'SKILL.md');
  fs.appendFileSync(skillMd, 'learned rule\n');
  const r = await generate(opts(root, templatesDir), quiet);
  assert.deepEqual(r.skipped, ['greet-tess']);
  assert.match(fs.readFileSync(skillMd, 'utf8'), /learned rule/);
  const f = await generate(opts(root, templatesDir, { force: true }), quiet);
  assert.deepEqual(f.generated, ['greet-tess']);
  assert.doesNotMatch(fs.readFileSync(skillMd, 'utf8'), /learned rule/);
});

test('notes.md belongs to the user: never a hand edit, never overwritten, survives --force', async () => {
  const dir = tmp();
  const root = path.join(dir, 'personal');
  const templatesDir = toyTemplates(dir);
  const answers = writeJson(path.join(dir, 'a.json'), { name: 'tess', display_name: 'Tess' });
  await generate(opts(root, templatesDir, { answers }), quiet);
  const notes = path.join(root, 'tess', 'skills', 'greet-tess', 'notes.md');
  fs.writeFileSync(notes, 'calibration: shorter leads\n');
  const r = await generate(opts(root, templatesDir), quiet);
  assert.deepEqual(r.generated, ['greet-tess']);
  const f = await generate(opts(root, templatesDir, { force: true }), quiet);
  assert.deepEqual(f.generated, ['greet-tess']);
  assert.equal(fs.readFileSync(notes, 'utf8'), 'calibration: shorter leads\n');
});

test('a template notes.md seeds the file only when the user has none', async () => {
  const dir = tmp();
  const root = path.join(dir, 'personal');
  const templatesDir = toyTemplates(dir);
  fs.writeFileSync(path.join(templatesDir, 'greet', 'notes.md'), '# Notes\n');
  const answers = writeJson(path.join(dir, 'a.json'), { name: 'tess', display_name: 'Tess' });
  await generate(opts(root, templatesDir, { answers }), quiet);
  const notes = path.join(root, 'tess', 'skills', 'greet-tess', 'notes.md');
  assert.equal(fs.readFileSync(notes, 'utf8'), '# Notes\n');
  fs.appendFileSync(notes, '- learned\n');
  await generate(opts(root, templatesDir, { force: true }), quiet);
  assert.equal(fs.readFileSync(notes, 'utf8'), '# Notes\n- learned\n');
});

test('a skill directory holding only notes.md is generated, not protected', async () => {
  const dir = tmp();
  const root = path.join(dir, 'personal');
  const skillDir = path.join(root, 'tess', 'skills', 'greet-tess');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'notes.md'), 'kept\n');
  const answers = writeJson(path.join(dir, 'a.json'), { name: 'tess', display_name: 'Tess' });
  const r = await generate(opts(root, toyTemplates(dir), { answers }), quiet);
  assert.deepEqual(r.generated, ['greet-tess']);
  assert.equal(fs.readFileSync(path.join(skillDir, 'notes.md'), 'utf8'), 'kept\n');
});

test('protects a skill directory that has no generation record', async () => {
  const dir = tmp();
  const root = path.join(dir, 'personal');
  const handMade = path.join(root, 'tess', 'skills', 'greet-tess');
  fs.mkdirSync(handMade, { recursive: true });
  fs.writeFileSync(path.join(handMade, 'SKILL.md'), 'mine\n');
  const answers = writeJson(path.join(dir, 'a.json'), { name: 'tess', display_name: 'Tess' });
  const r = await generate(opts(root, toyTemplates(dir), { answers }), quiet);
  assert.deepEqual(r.skipped, ['greet-tess']);
  assert.equal(fs.readFileSync(path.join(handMade, 'SKILL.md'), 'utf8'), 'mine\n');
});

test('fails loudly on a missing required answer', async () => {
  const dir = tmp();
  await assert.rejects(generate(opts(path.join(dir, 'p'), toyTemplates(dir)), quiet), /required question 'name'/);
});

test('CLI exits 3 when a skill was kept, 2 on usage', () => {
  const dir = tmp();
  const root = path.join(dir, 'personal');
  const templatesDir = toyTemplates(dir);
  const answers = writeJson(path.join(dir, 'a.json'), { name: 'tess', display_name: 'Tess' });
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', input: '' });
  assert.equal(run('--user', 'tess', '--all', '--non-interactive', '--answers', answers, '--templates', templatesDir, '--root', root).status, 0);
  fs.appendFileSync(path.join(root, 'tess', 'skills', 'greet-tess', 'SKILL.md'), 'x\n');
  assert.equal(run('--user', 'tess', '--all', '--non-interactive', '--templates', templatesDir, '--root', root).status, 3);
  assert.equal(run('--bogus').status, 2);
});

test('TILLER_PERSONAL_ROOT redirects the output', () => {
  const dir = tmp();
  const root = path.join(dir, 'elsewhere');
  const answers = writeJson(path.join(dir, 'a.json'), { name: 'tess', display_name: 'Tess' });
  const r = spawnSync(process.execPath, [CLI, '--user', 'tess', '--non-interactive', '--answers', answers, '--templates', toyTemplates(dir)],
    { encoding: 'utf8', input: '', env: { ...process.env, TILLER_PERSONAL_ROOT: root } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(root, 'tess', 'skills', 'greet-tess', 'SKILL.md')));
});

test('shipped templates render with minimal answers and with every optional answer', async () => {
  const names = listTemplates(REAL_TEMPLATES);
  assert.ok(names.includes('write-like') && names.includes('write-daily'));
  const minimal = { name: 'tess', display_name: 'Tess', channel_name: '#daily', channel_id: 'C000', slack_user_id: 'U000' };
  const full = { ...minimal };
  for (const n of names) {
    for (const q of loadTemplate(REAL_TEMPLATES, n).questions) if (!(q.key in full) || full[q.key] === '') full[q.key] = full[q.key] || `value-${q.key}`;
  }
  for (const answers of [minimal, full]) {
    const dir = tmp();
    const r = await generate(opts(path.join(dir, 'p'), REAL_TEMPLATES, { answers: writeJson(path.join(dir, 'a.json'), answers) }), quiet);
    assert.deepEqual(r.generated.sort(), ['write-daily', 'write-like-tess']);
    for (const s of r.generated) {
      const md = fs.readFileSync(path.join(dir, 'p', 'tess', 'skills', s, 'SKILL.md'), 'utf8');
      assert.match(md, new RegExp(`^---\\nname: ${s}\\n`));
      assert.doesNotMatch(md, /\{\{/);
    }
    assert.ok(fs.existsSync(path.join(dir, 'p', 'tess', 'skills', 'write-daily', 'gather_sessions.py')));
  }
});

test('--interactive prompts on piped input, keeps defaults on empty lines, fails when input runs out', () => {
  const dir = tmp();
  const root = path.join(dir, 'personal');
  const templatesDir = toyTemplates(dir);
  const run = (input) => spawnSync(process.execPath,
    [CLI, '--user', 'tess', '--interactive', '--templates', templatesDir, '--root', root], { encoding: 'utf8', input });
  const ok = run('tess\nTess\n\n#daily\n');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stderr, /\[default: Tess Example\]/);
  assert.match(fs.readFileSync(path.join(root, 'tess', 'skills', 'greet-tess', 'SKILL.md'), 'utf8'), /Post in #daily\./);
  const again = spawnSync(process.execPath,
    [CLI, '--user', 'tess', '--interactive', '--force', '--templates', templatesDir, '--root', root], { encoding: 'utf8', input: '\n\n\n\n' });
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stderr, /\[default: #daily\]/, 'stored answers come back as defaults');
  const short = spawnSync(process.execPath,
    [CLI, '--user', 'tess', '--interactive', '--templates', templatesDir, '--root', path.join(dir, 'other')], { encoding: 'utf8', input: 'tess\n' });
  assert.equal(short.status, 1);
  assert.match(short.stderr, /input ended/);
});
