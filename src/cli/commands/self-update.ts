/**
 * self-update: update hedgesync to the latest release (see src/self-update.ts).
 */

import { spawnSync } from 'node:child_process';
import { compareVersions, installKind, latestVersion, RELEASES_URL, replaceBinary } from '../../self-update.js';
import { VERSION } from '../../version.js';
import type { Command } from '../context.js';
import { CliError, c } from '../ui.js';

export const selfUpdate: Command = {
  name: 'self-update',
  aliases: ['upgrade'],
  summary: 'Update hedgesync to the latest release',
  options: [
    { name: 'check', type: 'flag' },
    { name: 'to', type: 'value' },
    { name: 'force', short: 'f', type: 'flag' },
  ],
  help: () => `
${c('bold', 'hedgesync self-update')} - Update hedgesync to the latest release

${c('yellow', 'USAGE:')}
  hedgesync self-update [--check] [--to <version>] [--force]

Finds the latest release on GitHub and updates this installation the way
it was installed:

  ${c('cyan', 'release binary')}   Downloads the binary for this platform, checks it against
                   the release's checksums.txt, runs it once, then replaces
                   this one (keep write access to where it lives)
  ${c('cyan', 'npm / bun')}        Runs npm install -g / bun add -g hedgesync@<version>
  ${c('cyan', 'source checkout')}  Nothing: update it with git

The Neovim plugin follows: hedgesync edit updates an installed copy the
next time it runs (or run hedgesync editor nvim install).

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '--check')}          Only say whether an update is available
  ${c('cyan', '--to <version>')}   Install this version instead (also older ones)
  ${c('cyan', '-f, --force')}      Install even if it is the running version

${c('yellow', 'ENVIRONMENT:')}
  HEDGESYNC_RELEASES_URL   Where releases are (default ${RELEASES_URL})
`,
  async run(ctx) {
    const releases = (process.env.HEDGESYNC_RELEASES_URL || RELEASES_URL).replace(/\/+$/, '');
    const install = installKind();
    const pinned = ctx.str('to')?.replace(/^v/, '');
    const target = pinned ?? await latestVersion(releases);
    const newer = compareVersions(target, VERSION) > 0;
    const wanted = ctx.flag('force') || (pinned ? target !== VERSION : newer);

    if (ctx.flag('check')) {
      ctx.result({ current: VERSION, latest: target, updateAvailable: newer, install: install.kind }, () => {
        if (newer) ctx.info(`${c('cyan', `hedgesync ${target} is available`)} (this is ${VERSION}): hedgesync self-update`);
        else ctx.info(c('green', `✓ hedgesync ${VERSION} is up to date`));
      });
      return;
    }
    if (!wanted) {
      ctx.result({ current: VERSION, latest: target, updated: false }, () => ctx.info(c('green', `✓ hedgesync ${VERSION} is up to date`)));
      return;
    }

    switch (install.kind) {
      case 'source':
        throw new CliError(`This hedgesync runs from source (${install.path})`, 'Update it with git pull, or install a release: npm install -g hedgesync');
      case 'npm':
      case 'bun': {
        const [cmd, ...args] = install.kind === 'npm' ? ['npm', 'install', '-g', `hedgesync@${target}`] : ['bun', 'add', '-g', `hedgesync@${target}`];
        ctx.info(`${c('cyan', `Updating ${VERSION} → ${target}:`)} ${[cmd, ...args].join(' ')}`);
        const r = spawnSync(cmd, args, { stdio: ctx.json ? ['ignore', 'ignore', 'inherit'] : 'inherit', shell: process.platform === 'win32' });
        if (r.error || r.status !== 0) {
          throw new CliError(`${cmd} failed${r.error ? `: ${r.error.message}` : ` (exit ${r.status})`}`, `Run it yourself: ${[cmd, ...args].join(' ')}`);
        }
        break;
      }
      case 'binary': {
        ctx.info(`${c('cyan', `Updating ${VERSION} → ${target}`)} ${c('dim', install.path)}`);
        try {
          await replaceBinary(install.path, target, { releases });
        } catch (err) {
          const e = err as NodeJS.ErrnoException;
          if (e.code === 'EACCES' || e.code === 'EPERM') {
            throw new CliError(`No permission to replace ${install.path}`, 'Run it with the rights to write there (e.g. sudo hedgesync self-update).');
          }
          throw err;
        }
        break;
      }
    }
    ctx.result({ previous: VERSION, current: target, updated: true, install: install.kind }, () =>
      ctx.info(c('green', `✓ Updated to hedgesync ${target}`)));
  },
};
