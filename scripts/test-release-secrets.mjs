#!/usr/bin/env node
import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, readStoredZip, scanText } from './check-release-secrets.mjs';

const scanner = fileURLToPath(new URL('./check-release-secrets.mjs', import.meta.url));
// Deliberately invalid credentials, assembled only at runtime; no real secrets,
// credential stores, network access, or credential environment variables.
const samples = [
  ['google-oauth-secret', ['GOC', 'SPX-', 'fake'.repeat(8)].join('')],
  ['google-oauth-client-id', ['0'.repeat(12), '-', 'invalid'.repeat(5), '.apps.', 'googleusercontent', '.com'].join('')],
  ['github-token', ['gh', 'p_', '0'.repeat(36)].join('')],
  ['github-token', ['github', '_pat_', '0'.repeat(82)].join('')],
  ['pem-private-key', ['-----', 'BEGIN ', 'PRIVATE', ' KEY', '-----'].join('')],
];
let tests = 0;
function check(condition, label) {
  // Boolean-only assertions ensure an assertion failure cannot print sample values.
  assert.ok(Boolean(condition), label);
  tests++;
}
function encodedCall(sample, buffer = false) {
  const base64 = Buffer.from(sample).toString('base64');
  const expression = [base64.slice(0, 7), base64.slice(7, 21), base64.slice(21)]
    .map(part => JSON.stringify(part)).join(' +\n ');
  return buffer ? `Buffer.from(${expression}, 'base64')` : `atob(${expression})`;
}
function storedZip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [path, content] of files) {
    const name = Buffer.from(path);
    const data = Buffer.from(content);
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function rejectsZip(buffer, rule) {
  let caught = false;
  try { readStoredZip(buffer); } catch (error) { caught = error.rule === rule; }
  check(caught, `ZIP rejection: ${rule}`);
}

const scratch = process.env.PI_SCRATCH_DIR;
if (!scratch || !isAbsolute(scratch)) {
  console.error('ERROR rule=absolute-PI_SCRATCH_DIR-required');
  process.exitCode = 2;
} else {
  const temp = mkdtempSync(join(scratch, 'release-secrets-'));
  try {
    for (const [rule, sample] of samples) {
      check(scanText(sample).includes(rule), `plain: ${rule}`);
      check(scanText(encodedCall(sample)).includes(rule), `split atob: ${rule}`);
      check(scanText(encodedCall(sample, true)).includes(rule), `split Buffer: ${rule}`);
      check(scanText(encodedCall(encodedCall(sample))).includes(rule), `nested base64: ${rule}`);
    }
    const encoded = Buffer.from(samples[0][1]).toString('base64');
    check(scanText(`atob('${encoded.slice(0, 5)}' /* split */ + '${encoded.slice(5)}')`).includes(samples[0][0]), 'commented split');
    check(scanText(`atob('${encoded.slice(0, 5)}' /* 'not a literal' */ + '${encoded.slice(5)}')`).includes(samples[0][0]), 'quoted comment ignored');
    check(scanText(samples.slice(0, 2).map(([, sample]) => encodedCall(sample)).join(';')).length === 2, 'multiple encoded calls');
    check(scanText(`atob('${encoded.replace(/./, char => '\\x' + char.charCodeAt(0).toString(16))}')`).includes(samples[0][0]), 'escaped literal');
    check(scanText('export const value = atob("aGVsbG8="); // no secret').length === 0, 'clean source');
    check(scanText('atob(variable); Buffer.from(variable, "base64");').length === 0, 'dynamic calls not evaluated');
    check(scanText('atob("not!base64")').length === 0, 'malformed base64 ignored');
    for (const path of [scanner, fileURLToPath(import.meta.url)]) {
      check(scanText(readFileSync(path, 'utf8')).length === 0, 'new scripts contain no credential-shaped literals');
    }
    check(crc32(Buffer.from('123456789')) === 0xcbf43926, 'CRC known vector');

    function run(args = [], cwd = temp) {
      const result = spawnSync(process.execPath, [scanner, ...args], { cwd, encoding: 'utf8' });
      check(!result.error && result.signal === null, 'scanner exits normally');
      const output = result.stdout + result.stderr;
      for (const [, sample] of samples) {
        check(!output.includes(sample), 'output does not disclose sample');
        check(!output.includes(Buffer.from(sample).toString('base64')), 'output does not disclose encoded sample');
      }
      check(result.stderr === '', 'no diagnostic stderr leakage');
      return { status: result.status, output };
    }
    function packageRun(files) {
      const path = join(temp, 'test.piplug');
      writeFileSync(path, storedZip(files));
      return run(['--package', path]);
    }
    let result = packageRun([['docs/readme.md', 'safe'], ['bundles/a.js', 'const safe = true;'], ['bundles/b.js', 'safe']]);
    check(result.status === 0 && result.output.includes('PASS checked=3 findings=0'), 'clean package');
    result = packageRun([['docs/readme.md', samples[0][1]], ['bundles/a.js', encodedCall(samples[1][1])], ['bundles/b.js', encodedCall(samples[2][1], true)]]);
    check(result.status === 1 && result.output.includes('checked=3 findings=3'), 'all docs and bundles scanned');
    for (const name of ['auth.json', 'accounts.json', 'settings.json', 'antigravity-models.json', '.env', '.env.local', 'AUTH.JSON']) {
      result = packageRun([['safe.js', 'safe'], [`nested/${name}`, '{}']]);
      check(result.status === 1 && result.output.includes('rule=private-file'), `private package file: ${name}`);
    }
    check(readStoredZip(storedZip([['目录/a.js', 'safe']])).length === 1, 'UTF8 package paths');
    check(readStoredZip(storedZip([])).length === 0, 'empty ZIP');
    rejectsZip(Buffer.from('not a zip'), 'zip-invalid');
    rejectsZip(storedZip([['../a.js', 'safe']]), 'zip-unsafe-path');
    rejectsZip(storedZip([['C:\\a.js', 'safe']]), 'zip-unsafe-path');
    rejectsZip(storedZip([['a.js', 'safe'], ['A.js', 'safe']]), 'zip-duplicate-path');
    const damaged = storedZip([['a.js', 'safe']]);
    damaged[34] ^= 1;
    rejectsZip(damaged, 'zip-invalid');
    const compressed = storedZip([['a.js', 'safe']]);
    compressed.writeUInt16LE(8, 8);
    compressed.writeUInt16LE(8, 30 + 4 + 4 + 10);
    rejectsZip(compressed, 'zip-unsupported');
    writeFileSync(join(temp, 'bad.piplug'), damaged);
    check(run(['--package', join(temp, 'bad.piplug')]).status === 2, 'malformed ZIP exit code');
    check(run(['--package', join(temp, 'missing.piplug')]).status === 2, 'missing ZIP fails closed');
    check(run(['--unknown']).status === 2, 'invalid arguments');

    const repo = join(temp, 'repo');
    mkdirSync(repo);
    function git(args, input) {
      return execFileSync('git', args, {
        cwd: repo, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'],
        env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
          GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' },
      }).trim();
    }
    function put(path, data) {
      const full = join(repo, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, data);
    }
    git(['init', '--quiet']);
    put('src/clean.js', 'export const clean = true;');
    put('docs/readme.md', 'safe docs');
    put('bundles/a.js', 'safe bundle a');
    put('bundles/b.js', 'safe bundle b');
    git(['add', '.']);
    put('dist/stale.js', samples[0][1]);
    put('node_modules/ignored.js', samples[0][1]);
    git(['add', '-f', 'node_modules/ignored.js']);
    check(run([], repo).status === 0, 'untracked dist and tracked node_modules excluded');
    put('docs/readme.md', samples[0][1]);
    result = run([], repo);
    check(result.status === 1 && result.output.includes('path="docs/readme.md"'), 'working-tree docs scanned, not index bytes');
    put('docs/readme.md', 'safe docs');
    put('dist/tracked.js', samples[0][1]);
    git(['add', '-f', 'dist/tracked.js']);
    check(run([], repo).status === 1, 'tracked dist is scanned');
    put('dist/tracked.js', 'safe tracked dist');
    git(['add', 'dist/tracked.js']);
    put('bundles/b.js', encodedCall(samples[0][1]));
    check(run([], repo).status === 1, 'second tracked bundle scanned');
    git(['add', 'bundles/b.js']);
    // Synthetic history lives ONLY in scratch. No workspace commits or refs change.
    const oldTree = git(['write-tree']);
    const oldCommit = git(['commit-tree', oldTree], 'old fixture\n');
    put('bundles/b.js', 'safe bundle b');
    git(['add', 'bundles/b.js']);
    const cleanTree = git(['write-tree']);
    const tip = git(['commit-tree', cleanTree, '-p', oldCommit], 'clean tip fixture\n');
    check(run([], repo).status === 0, 'clean tip working tree');
    result = run(['--history', tip], repo);
    check(result.status === 1 && result.output.includes('path="bundles/b.js"'), 'history finds removed split-base64 secret');
    const reachable = git(['rev-list', '--objects', tip]).split('\n').map(line => line.split(' ')[0]);
    const types = git(['cat-file', '--batch-check=%(objecttype)'], reachable.join('\n') + '\n').split('\n');
    const blobCount = types.filter(type => type === 'blob').length;
    check(result.output.includes(`checked=${blobCount} `), 'history scans every distinct blob exactly once');
    git(['rm', '--cached', 'node_modules/ignored.js']);
    const safeCommit = git(['commit-tree', git(['write-tree'])], 'safe orphan fixture\n');
    check(run(['--history', safeCommit], repo).status === 0, 'clean history passes');
    git(['replace', oldCommit, safeCommit]);
    result = run(['--history', tip], repo);
    check(result.status === 1 && result.output.includes('path="bundles/b.js"'), 'replacement objects cannot hide old blobs');
    git(['replace', '-d', oldCommit]);
    writeFileSync(join(repo, '.git/shallow'), tip + '\n');
    check(run(['--history', safeCommit], repo).status === 0, 'complete orphan history passes despite unrelated shallow boundary');
    result = run(['--history', tip], repo);
    check(result.status === 1 && result.output.includes('path="node_modules/ignored.js"'), 'shallow history still scans available blobs');
    writeFileSync(join(repo, '.git/shallow'), safeCommit + '\n');
    result = run(['--history', safeCommit], repo);
    check(result.status === 2 && result.output.includes('rule=git-shallow-history'), 'clean shallow history cannot pass');
    rmSync(join(repo, '.git/shallow'));
    check(run(['--history', '--invalid-ref'], repo).status === 2, 'invalid ref fails safely');
    rmSync(join(repo, 'src/clean.js'));
    check(run([], repo).status === 2, 'missing tracked file fails closed');
    console.log(`PASS assertions=${tests}`);
  } catch {
    // Do not dump assertion inputs, source text or child-process output.
    console.error(`FAIL rule=test-failure assertions=${tests}`);
    process.exitCode = 1;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
