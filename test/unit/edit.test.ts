import { expect, test } from 'bun:test';
import { chooseEditor, isNeovim, selfCommand } from '../../src/cli/commands/edit.js';

test('editor choice: --editor, then $VISUAL, then $EDITOR, then nvim', () => {
  expect(chooseEditor('hx', { VISUAL: 'vim', EDITOR: 'nano' })).toBe('hx');
  expect(chooseEditor(undefined, { VISUAL: 'vim', EDITOR: 'nano' })).toBe('vim');
  expect(chooseEditor(undefined, { EDITOR: 'nano' })).toBe('nano');
  expect(chooseEditor(undefined, {})).toBe('nvim');
});

test('Neovim is recognised by program name', () => {
  expect(isNeovim('nvim')).toBe(true);
  expect(isNeovim('/usr/local/bin/nvim -u NONE')).toBe(true);
  expect(isNeovim('"C:\\\\Program Files\\\\Neovim\\\\bin\\\\nvim.exe"')).toBe(true);
  expect(isNeovim('vim')).toBe(false);
  expect(isNeovim('code --wait')).toBe(false);
  expect(isNeovim('nvim-qt')).toBe(false);
});

test('selfCommand: compiled binary alone, script with its runtime', () => {
  expect(selfCommand(['bun', '/$bunfs/root/hedgesync', 'edit'], '/usr/bin/hedgesync')).toEqual(['/usr/bin/hedgesync']);
  expect(selfCommand(['C:\\hs.exe', 'B:\\~BUN\\root\\hs.exe'], 'C:\\hs.exe')).toEqual(['C:\\hs.exe']);
  expect(selfCommand(['/bin/bun', '/repo/bin/hedgesync.ts', 'edit'], '/bin/bun')).toEqual(['/bin/bun', '/repo/bin/hedgesync.ts']);
  expect(selfCommand(['/bin/node', '/lib/dist/cli/bin.js'], '/bin/node')).toEqual(['/bin/node', '/lib/dist/cli/bin.js']);
});
