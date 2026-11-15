'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const source = path.join(__dirname, 'watch-animation-harness.c');

function runHarness(aplite) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-status-watch-test-'));
  const executable = path.join(temp, 'watch-animation-test');
  try {
    const args = ['-std=c99', '-Wall', '-Wextra', '-Werror'];
    if (aplite) args.push('-DPBL_PLATFORM_APLITE');
    args.push('-o', executable, source);
    const build = spawnSync('cc', args, { encoding: 'utf8' });
    assert.equal(build.status, 0, `compile failed:\n${build.stderr}`);
    const result = spawnSync(executable, [], { encoding: 'utf8' });
    assert.equal(result.status, 0, `harness failed:\n${result.stderr}`);
    assert.match(result.stdout, /watch animation harness passed/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

test('watch animation state, visibility, marquee cache, and capabilities', () => {
  runHarness(false);
});

test('Aplite capability sizes', () => {
  runHarness(true);
});
