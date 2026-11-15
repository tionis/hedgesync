/**
 * publish: a note's shareable links. meta: its front matter settings.
 */

import { getMeta, getTags, readFrontMatter, setMeta, type MetaValue } from '../../frontmatter.js';
import { connectionOptions, type Command } from '../context.js';
import { CliError, c, print } from '../ui.js';

export const publish: Command = {
  name: 'publish',
  aliases: ['links'],
  summary: 'Print the published (or slide) URL of a note',
  options: [{ name: 'slide', type: 'flag' }, { name: 'all', short: 'a', type: 'flag' }],
  help: () => `
${c('bold', 'hedgesync publish')} - Print the published URL of a note (alias: links)

${c('yellow', 'USAGE:')}
  hedgesync publish <note-url> [--slide | --all]

HedgeDoc 1 has no separate publish step: every note has a published page
(${c('cyan', '/s/<id>')}) and a slide view (${c('cyan', '/p/<id>')}), and who can open them is decided by
the note's permission (see ${c('cyan', 'hedgesync permission')}). The short id in those URLs is
assigned by the server, so this asks the server for it.

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '--slide')}        Print the slide URL instead (front matter ${c('cyan', 'type: slide')} is not required)
  ${c('cyan', '-a, --all')}      Print every link: edit, view, both, publish, slide, download
  ${c('cyan', '--json')}         All links as JSON
`,
  async run(ctx) {
    const { serverUrl, noteId } = ctx.note(0, 'hedgesync publish <note-url>');
    const links = await ctx.api(serverUrl).getNoteLinks(noteId);
    ctx.result({ action: 'publish', noteId, ...links }, () => {
      if (!ctx.flag('all')) {
        print(ctx.flag('slide') ? links.slide : links.publish);
        return;
      }
      for (const [name, url] of Object.entries(links)) print(`${c('cyan', name.padEnd(9))} ${url}`);
    });
  },
};

const KNOWN_KEYS = `  ${c('cyan', 'title')}          Title (instead of the first heading)
  ${c('cyan', 'description')}    Description for the published page and link previews
  ${c('cyan', 'tags')}           Tags (shown in history; ${c('cyan', 'hedgesync ls -t')} filters on them)
  ${c('cyan', 'type')}           ${c('cyan', 'slide')} to make the published page a slide deck
  ${c('cyan', 'slideOptions')}   reveal.js options (nested; edit in the note itself)
  ${c('cyan', 'lang')}, ${c('cyan', 'dir')}      Language (e.g. en-us) and text direction (ltr, rtl)
  ${c('cyan', 'breaks')}         false to disable line breaks on single newlines
  ${c('cyan', 'robots')}         e.g. noindex, nofollow for the published page
  ${c('cyan', 'GA')}, ${c('cyan', 'disqus')}     Google Analytics id, Disqus shortname`;

function format(value: MetaValue): string {
  return Array.isArray(value) ? value.join(', ') : value;
}

export const meta: Command = {
  name: 'meta',
  summary: 'Show or change note settings (front matter: title, tags, type, ...)',
  options: [
    ...connectionOptions,
    { name: 'unset', type: 'multi' },
    { name: 'add-tag', type: 'multi' },
    { name: 'remove-tag', type: 'multi' },
  ],
  help: () => `
${c('bold', 'hedgesync meta')} - Show or change note settings

${c('yellow', 'USAGE:')}
  hedgesync meta <note-url>                    Show all settings
  hedgesync meta <note-url> <key>              Print one setting
  hedgesync meta <note-url> <key> <value>...   Set it (several values make a list)
  hedgesync meta <note-url> --unset <key>      Remove it
  hedgesync meta <note-url> --add-tag <tag> --remove-tag <tag>

HedgeDoc 1 keeps per-note settings in the YAML front matter at the top of
the note (between ${c('cyan', '---')} lines). Changes are sent as a minimal edit, so
collaborators' cursors and other lines are untouched. The permission is a
server setting instead: see ${c('cyan', 'hedgesync permission')}.

${c('yellow', 'COMMON KEYS:')}
${KNOWN_KEYS}

${c('yellow', 'EXAMPLES:')}
  hedgesync meta https://md.example.com/abc tags work planning
  hedgesync meta https://md.example.com/abc --add-tag done --remove-tag todo
  hedgesync meta https://md.example.com/abc type slide
  hedgesync meta https://md.example.com/abc description "Notes from the weekly sync"
`,
  async run(ctx) {
    ctx.note(0, 'hedgesync meta <note-url> [key] [value...]');
    const key = ctx.positional[1];
    const values = ctx.positional.slice(2);
    const unset = ctx.list('unset');
    const addTags = ctx.list('add-tag');
    const removeTags = ctx.list('remove-tag');
    const editing = values.length > 0 || unset.length > 0 || addTags.length > 0 || removeTags.length > 0;

    if (!editing) {
      const doc = await ctx.withClient({}, client => client.getDocument());
      if (key) {
        const entry = getMeta(doc, key);
        if (!entry) throw new CliError(`No setting '${key}' in this note`);
        ctx.result({ action: 'get-meta', key, value: entry.value, nested: entry.nested },
          () => print(Array.isArray(entry.value) ? entry.value.join('\n') : entry.value));
        return;
      }
      const entries = readFrontMatter(doc);
      ctx.result({ action: 'meta', settings: Object.fromEntries(entries.map(e => [e.key, e.value])) }, () => {
        if (entries.length === 0) {
          print(c('dim', '(no front matter settings)'));
          return;
        }
        const width = Math.max(...entries.map(e => e.key.length)) + 1;
        for (const e of entries) {
          if (e.nested) {
            print(`${c('cyan', (e.key + ':').padEnd(width))}`);
            print(c('dim', e.value as string));
          } else {
            print(`${c('cyan', (e.key + ':').padEnd(width))} ${format(e.value)}`);
          }
        }
      });
      return;
    }

    if (values.length > 0 && !key) throw new CliError('Missing key');
    if (key && values.length === 0 && !unset.length && !addTags.length && !removeTags.length) {
      throw new CliError('Missing value');
    }
    const changes: Record<string, MetaValue | null> = {};
    const result = await ctx.withClient({ edit: true }, (client) => {
      let doc = client.getDocument();
      if (key && values.length) {
        // Tags are always a list; "a, b" splits like HedgeDoc does.
        const value: MetaValue = key === 'tags'
          ? values.flatMap(v => v.split(',')).map(t => t.trim()).filter(Boolean)
          : values.length > 1 ? values : values[0];
        doc = setMeta(doc, key, value);
        changes[key] = value;
      }
      for (const k of unset) {
        doc = setMeta(doc, k, null);
        changes[k] = null;
      }
      if (addTags.length || removeTags.length) {
        let tags = getTags(doc);
        for (const t of addTags) if (!tags.includes(t)) tags.push(t);
        tags = tags.filter(t => !removeTags.includes(t));
        doc = setMeta(doc, 'tags', tags.length ? tags : null);
        changes.tags = tags.length ? tags : null;
      }
      const changed = client.updateContent(doc) > 0;
      return { changed, settings: Object.fromEntries(readFrontMatter(doc).map(e => [e.key, e.value])) };
    });
    ctx.result({ action: 'set-meta', changes, ...result }, () => {
      if (!result.changed) {
        ctx.info(c('dim', 'Nothing to change'));
        return;
      }
      for (const [k, v] of Object.entries(changes)) {
        ctx.info(c('green', v === null ? `✓ Removed ${k}` : `✓ ${k}: ${format(v)}`));
      }
    });
  },
};
