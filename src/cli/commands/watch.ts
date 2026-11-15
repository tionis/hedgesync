/**
 * watch: stream changes and events from a note until interrupted.
 */

import type { UserInfo } from '../../hedgedoc-client.js';
import { connectionOptions, type Command } from '../context.js';
import { helpText } from '../help-text.js';
import { c, eprint, print } from '../ui.js';

export const watch: Command = {
  name: 'watch',
  summary: 'Watch document for changes',
  options: [...connectionOptions, { name: 'events', short: 'e', type: 'flag' }, { name: 'ndjson', type: 'flag' }],
  help: helpText.watch,
  async run(ctx) {
    const client = await ctx.connect(0);
    const json = ctx.json;
    const ndjson = ctx.flag('ndjson');
    const quiet = ctx.quiet;
    const eventsMode = ctx.flag('events');

    // Helper to output events
    const outputEvent = (eventType: string, data: unknown) => {
      const timestamp = new Date().toISOString();
      if (ndjson) {
        print(JSON.stringify({ event: eventType, timestamp, ...data as object }));
      } else if (json) {
        print(JSON.stringify({ type: eventType, timestamp, data }, null, 2));
      } else {
        print(c('dim', `[${timestamp}]`) + ' ' + c('cyan', eventType));
        if (data && typeof data === 'object') {
          for (const [key, value] of Object.entries(data as object)) {
            if (value !== undefined && value !== null) {
              const displayValue = typeof value === 'object' 
                ? JSON.stringify(value)
                : String(value);
              print(`  ${c('yellow', key)}: ${displayValue}`);
            }
          }
        }
        print();
      }
    };
  
    if (!quiet && !json && !ndjson) {
      if (eventsMode) {
        eprint(c('cyan', 'Watching all events... (Ctrl+C to stop)'));
      } else {
        eprint(c('cyan', 'Watching for changes... (Ctrl+C to stop)'));
        eprint(c('dim', 'Tip: Use --events for detailed operation events, --ndjson for scripting'));
      }
    }
  
    if (eventsMode) {
      // Detailed event mode - watch all events with full information
    
      // Change events with operation details
      client.on('change', (event) => {
        const inserts: Array<{position: number, text: string}> = [];
        const deletes: Array<{position: number, length: number}> = [];
      
        if (event.operation) {
          let position = 0;
          for (const op of event.operation.ops) {
            if (typeof op === 'string') {
              inserts.push({ position, text: op });
              position += op.length;
            } else if (op > 0) {
              position += op;
            } else if (op < 0) {
              deletes.push({ position, length: -op });
            }
          }
        }
      
        outputEvent('change', {
          source: event.type,
          clientId: event.clientId,
          user: event.user ? {
            id: event.user.id,
            name: event.user.name,
            color: event.user.color
          } : undefined,
          inserts: inserts.length > 0 ? inserts : undefined,
          deletes: deletes.length > 0 ? deletes : undefined,
          operation: event.operation ? event.operation.ops : undefined
        });
      });
    
      // Cursor events
      client.on('cursor:focus', (user) => {
        outputEvent('cursor:focus', { user });
      });
    
      client.on('cursor:activity', (user) => {
        outputEvent('cursor:activity', { 
          clientId: user.id,
          name: user.name,
          color: user.color,
          cursor: user.cursor
        });
      });
    
      client.on('cursor:blur', (data) => {
        outputEvent('cursor:blur', data);
      });
    
      // User events
      client.on('user:left', (clientId: string) => {
        outputEvent('user:left', { clientId });
      });
    
      client.on('users', (users: UserInfo[]) => {
        const userList = users.map(user => ({ clientId: user.id, ...user }));
        outputEvent('users', { count: userList.length, users: userList });
      });
    
      // Connection events
      client.on('connect', () => {
        outputEvent('connect', {});
      });
    
      client.on('disconnect', (reason: string) => {
        outputEvent('disconnect', { reason });
      });
    
      client.on('reconnect:success', (data) => {
        outputEvent('reconnect:success', data);
      });
    
      // Document events
      client.on('document', (content: string) => {
        outputEvent('document', { 
          length: content.length,
          preview: content.slice(0, 100) + (content.length > 100 ? '...' : '')
        });
      });
    
      // Info/permission events
      client.on('permission', (permission: string) => {
        outputEvent('permission', { permission });
      });
    
      client.on('info', (data) => {
        outputEvent('info', data);
      });
    
    } else {
      // Simple mode - just document changes and users
      let lastContent = client.getDocument();
    
      client.on('document', (content: string) => {
        if (content !== lastContent) {
          if (json || ndjson) {
            print(JSON.stringify({
              type: 'change',
              timestamp: new Date().toISOString(),
              content: content,
            }));
          } else {
            print(c('dim', `--- ${new Date().toISOString()} ---`));
            print(content);
            print();
          }
          lastContent = content;
        }
      });
    
      client.on('users', (userList: UserInfo[]) => {
        if (json || ndjson) {
          print(JSON.stringify({
            type: 'users',
            timestamp: new Date().toISOString(),
            users: userList,
          }));
        } else if (!quiet) {
          eprint(c('dim', `Online: ${userList.map(u => u.name || u.id).join(', ')}`));
        }
      });
    
      client.on('disconnect', (reason: string) => {
        if (!quiet) {
          eprint(c('yellow', `Disconnected: ${reason}`));
        }
      });
    
      client.on('reconnect:success', () => {
        if (!quiet) {
          eprint(c('green', 'Reconnected'));
        }
      });
    }

    await new Promise<void>((resolve) => {
      const stop = () => {
        client.disconnect();
        resolve();
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      client.once('delete', () => {
        if (!quiet) eprint(c('yellow', 'Note was deleted'));
        stop();
      });
    });
  },
};
