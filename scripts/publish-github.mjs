#!/usr/bin/env node
// Publish treebird-chat to GitHub Packages as @treebird7/treebird-chat.
//
// GitHub Packages requires scoped package names. This script temporarily
// rewrites package.json with the scoped name + GitHub registry, publishes,
// then restores the original. The git working tree is left clean.
//
// Requires GITHUB_TOKEN env var with packages:write scope.
// Usage: pnpm run publish:github

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkgPath = resolve(root, 'package.json');
const original = readFileSync(pkgPath, 'utf8');
const pkg = JSON.parse(original);

if (!process.env.GITHUB_TOKEN) {
  process.stderr.write(
    'GITHUB_TOKEN is not set.\n' +
    'Generate a token at https://github.com/settings/tokens with packages:write scope,\n' +
    'then: export GITHUB_TOKEN=<token>\n'
  );
  process.exit(1);
}

const scoped = {
  ...pkg,
  name: '@treebird7/treebird-chat',
  publishConfig: {
    registry: 'https://npm.pkg.github.com',
    access: 'public',
  },
};

// Remove scripts from published version to avoid prepublishOnly re-running test
// (tests already ran as part of publish:npm or the caller's CI step).
delete scoped.scripts;

try {
  writeFileSync(pkgPath, JSON.stringify(scoped, null, 2) + '\n');
  process.stderr.write(`Publishing ${scoped.name}@${scoped.version} → npm.pkg.github.com\n`);
  execFileSync('pnpm', ['publish', '--no-git-checks', '--access', 'public'], {
    stdio: 'inherit',
    cwd: root,
    env: {
      ...process.env,
      npm_config_registry: 'https://npm.pkg.github.com',
      npm_config__authtoken: process.env.GITHUB_TOKEN,
    },
  });
  process.stderr.write('Done.\n');
} finally {
  writeFileSync(pkgPath, original);
}
