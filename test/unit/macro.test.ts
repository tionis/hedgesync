import { afterEach, describe, expect, test } from 'bun:test';
import { HedgeDocClient } from '../../src/hedgedoc-client.js';
import { MacroEngine } from '../../src/macro-engine.js';
import { SimServer, tick } from '../sim/sim-server.js';
import { connectClient, stopAll } from './helpers.js';

let clients: HedgeDocClient[] = [];
let engines: MacroEngine[] = [];

afterEach(() => {
  for (const e of engines) e.stop();
  stopAll(clients);
  clients = [];
  engines = [];
});

/** A note with the macro bot (A) and a human collaborator (B). */
async function setup(document: string, options: ConstructorParameters<typeof MacroEngine>[1] = {}) {
  const server = new SimServer({ document });
  const bot = await connectClient(server);
  const human = await connectClient(server);
  clients.push(bot, human);
  const engine = new MacroEngine(bot, { debounceMs: 5, ...options });
  engines.push(engine);
  const pump = async (until: () => boolean, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      server.drain();
      await tick(2);
      if (until()) {
        server.drain();
        return;
      }
    }
    throw new Error(`condition not met; server doc: ${JSON.stringify(server.document)}`);
  };
  const settle = async (ms = 60) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      server.drain();
      await tick(2);
    }
    server.drain();
  };
  /** Pretend the bot knows who the human is (HedgeDoc sends this via 'online users'). */
  const identify = (userid: string, name = 'Human') => {
    bot.users.set(human.socket!.id!, { id: human.socket!.id!, userid, name });
  };
  return { server, bot, human, engine, pump, settle, identify };
}

describe('MacroEngine triggering', () => {
  test('expands a trigger typed by a collaborator', async () => {
    const { server, human, engine, pump } = await setup('Today: \n');
    engine.addTextMacro('::date::', () => 'DATE').start();
    human.insert(7, '::date::');
    await pump(() => server.document === 'Today: DATE\n');
  });

  test('the bot\'s own edits never trigger macros', async () => {
    const { server, bot, engine, settle } = await setup('');
    engine.addTextMacro('::x::', () => 'expanded').start();
    bot.insert(0, '::x::');
    await settle();
    expect(server.document).toBe('::x::');
  });

  test('macro output cannot trigger itself (no loops)', async () => {
    const { server, human, engine, pump, settle } = await setup('');
    let calls = 0;
    engine.addTextMacro('::loop::', () => {
      calls++;
      return 'again ::loop::';
    }).start();
    human.insert(0, '::loop::');
    await pump(() => server.document === 'again ::loop::');
    await settle();
    expect(calls).toBe(1);
  });

  test('pre-existing triggers are not expanded by unrelated edits', async () => {
    const { server, human, engine, settle } = await setup('::date:: was here\n');
    engine.addTextMacro('::date::', () => 'DATE').start();
    human.insert(human.document.length, 'more text');
    await settle();
    expect(server.document).toBe('::date:: was here\nmore text');
  });

  test('a trigger planted by a disallowed user stays inert', async () => {
    const { server, human, engine, identify, settle } = await setup('', { allowedUserIds: ['alice'] });
    engine.addTextMacro('::x::', () => 'RAN').start();
    identify('mallory');
    human.insert(0, '::x:: ');
    await settle();
    expect(server.document).toBe('::x:: ');
    identify('alice'); // an allowed user now edits elsewhere in the note
    human.insert(human.document.length, 'unrelated edit');
    await settle();
    expect(server.document).toBe('::x:: unrelated edit');
  });

  test('allowedUserIds admits listed accounts', async () => {
    const { server, human, engine, identify, pump } = await setup('', { allowedUserIds: ['alice'] });
    engine.addTextMacro('::x::', () => 'RAN').start();
    identify('alice');
    human.insert(0, '::x::');
    await pump(() => server.document === 'RAN');
  });

  test('a trigger completed across several edits fires', async () => {
    const { server, human, engine, pump, settle } = await setup('');
    engine.addTextMacro('::date::', () => 'DATE').start();
    human.insert(0, '::da');
    await settle(30);
    human.insert(4, 'te::');
    await pump(() => server.document === 'DATE');
  });
});

describe('MacroEngine positioning', () => {
  test('async result lands at the right place after concurrent edits', async () => {
    const { server, human, engine, pump } = await setup('a ::slow:: b ::slow:: c');
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    engine.addTextMacro('::slow::', async () => {
      await gate;
      return 'X';
    });
    const expanding = engine.expand();
    await tick(5);
    human.insert(0, 'PREFIX ');
    human.insert(human.document.length, ' SUFFIX');
    await pump(() => human.isSynchronized());
    release();
    await expanding;
    await pump(() => server.document === 'PREFIX a X b X c SUFFIX');
  });

  test('a trigger edited while its handler runs is left alone', async () => {
    const { server, human, engine, pump, settle } = await setup('one ::slow:: two');
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    engine.addTextMacro('::slow::', async () => {
      await gate;
      return 'X';
    });
    const expanding = engine.expand();
    await tick(5);
    human.replace(4, 8, '::SLOW::');
    await pump(() => human.isSynchronized());
    release();
    await expanding;
    await settle();
    expect(server.document).toBe('one ::SLOW:: two');
  });

  test('changes during a slow scan are picked up afterwards', async () => {
    const { server, human, engine, pump } = await setup('');
    engine.addTextMacro('::a::', async () => {
      await new Promise(r => setTimeout(r, 80));
      return 'A';
    }).start();
    human.insert(0, '::a:: ');
    await tick(30); // first scan is now running
    human.insert(human.document.length, '::a::');
    await pump(() => server.document === 'A A');
  });

  test('regex handlers get String.replace-style arguments', async () => {
    const { bot, engine } = await setup('x=1 y=22');
    const seen: unknown[][] = [];
    engine.addRegexMacro('kv', /(\w)=(\d+)/g, (...args) => {
      seen.push(args);
      return null;
    });
    await engine.expand();
    expect(seen).toEqual([
      ['x=1', 'x', '1', 0, bot.document],
      ['y=22', 'y', '22', 4, bot.document],
    ]);
  });

  test('template macros support multi-character delimiters', async () => {
    const { bot, engine } = await setup('Hi {{name}}, {{ other }}!');
    engine.addTemplateMacro('tpl', '{{', '}}', (content) => content.trim().toUpperCase());
    await engine.expand();
    expect(bot.document).toBe('Hi NAME, OTHER!');
  });

  test('block macros transform the block', async () => {
    const { bot, engine } = await setup('list:\n::BEGIN:sort::\nb\na\n::END:sort::\nend');
    engine.addBlockMacro('sort', (content) => content.split('\n').sort().join('\n'));
    await engine.expand();
    expect(bot.document).toBe('list:\na\nb\nend');
  });

  test('section filters limit expansion', async () => {
    const { bot, engine } = await setup('# A\n::x::\n## Scripts\n::x::\n# B\n::x::');
    engine.setSectionFilter({ type: 'heading', pattern: /Scripts/g });
    engine.addTextMacro('::x::', 'Y');
    await engine.expand();
    expect(bot.document).toBe('# A\n::x::\n## Scripts\nY\n# B\n::x::');
  });
});

describe('MacroEngine streaming', () => {
  test('streams output in place of the trigger', async () => {
    const { server, human, engine, pump } = await setup('before\n\nafter');
    engine.addStreamingExecMacro('s', /::run::/, () => ({ command: "printf 'one\\ntwo\\n'" })).start();
    human.insert(7, '::run::');
    await pump(() => server.document === 'before\none\ntwo\n\nafter');
    await engine.waitForStreams();
  });

  test('track-state marks the trigger and never reruns it', async () => {
    const { server, human, engine, pump, settle } = await setup('');
    let runs = 0;
    engine.addStreamingExecMacro('s', /::ask (\w+)::/, (_m, word) => {
      runs++;
      return { command: 'printf "%s\\n" "$W"', env: { W: String(word).toUpperCase() } };
    }, { trackState: true }).start();
    human.insert(0, '::ask hi::');
    await pump(() => server.document === '::ask hi::✓\nHI\n');
    await engine.waitForStreams();
    human.insert(human.document.length, 'more');
    human.insert(5, 'x'); // edit inside the trigger region
    await settle(100);
    expect(runs).toBe(1);
  });

  test('a failing command gets the failed marker', async () => {
    const { server, human, engine, pump } = await setup('');
    engine.addStreamingExecMacro('s', /::fail::/, () => 'echo partial; exit 2', { trackState: true }).start();
    human.insert(0, '::fail::');
    await pump(() => server.document === '::fail::✗\npartial\n');
    await engine.waitForStreams();
  });

  test('a trigger is not started twice while its command builder runs', async () => {
    const { human, engine, pump, server } = await setup('');
    let builds = 0;
    engine.addStreamingExecMacro('s', /::go::/, async () => {
      builds++;
      await new Promise(r => setTimeout(r, 60));
      return 'echo done';
    }).start();
    human.insert(0, '::go::');
    await tick(20);
    human.insert(human.document.length, ' typing'); // touches nothing, but rescans
    human.insert(0, ' ');                            // adjacent edit marks the trigger dirty again
    await pump(() => server.document.includes('done'));
    await engine.waitForStreams();
    expect(builds).toBe(1);
  });

  test('stop() kills running commands', async () => {
    const { human, engine, pump } = await setup('');
    engine.addStreamingExecMacro('s', /::sleep::/, () => 'sleep 10').start();
    human.insert(0, '::sleep::');
    await pump(() => engine.hasActiveStreams());
    await tick(50);
    const started = Date.now();
    engine.stop();
    await engine.waitForStreams();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
