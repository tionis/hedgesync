import { TextOperation, OperationJSON } from './text-operation.js';
import { diffToOperation } from './diff.js';

/**
 * OT client state machine for HedgeDoc 1.x.
 *
 * A faithful port of HedgeDoc's `public/vendor/ot/client.js` (itself derived
 * from ot.js), including the Stale/StaleWithBuffer recovery states that
 * HedgeDoc added for acks that skip revisions. On top of upstream it:
 *
 * - tracks the server document at `revision`, so reconnects can rebase
 *   pending local edits instead of silently dropping them, and
 * - throws `OTDesyncError` on protocol violations (revision gaps, malformed
 *   recovery responses) so the caller can resynchronise.
 *
 * Protocol (server side, lib/ot/editor-socketio-server.js):
 * - every accepted operation increments the revision by exactly one;
 * - the author receives `ack(revision)`, everyone else
 *   `operation(clientId, revision, op)`;
 * - `get_operations(base, head)` returns `operations.slice(base, head)`.
 */

/** Selection that can be transformed */
export interface Transformable {
  transform(operation: TextOperation): Transformable;
}

/** Raised when client and server state can no longer be reconciled by OT. */
export class OTDesyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OTDesyncError';
  }
}

/** What `serverReconnect` did with local state when a fresh `doc` arrived. */
export type ReconnectOutcome =
  /** No pending local edits; adopted the server document. */
  | { kind: 'reset' }
  /** Same server history as before: pending edits were re-sent for the server to transform. */
  | { kind: 'resent' }
  /**
   * The server moved on while we were away. Missed operations are being
   * fetched and verified; pending edits are then transformed through them
   * (or rebased via diff if the history does not match) and sent.
   */
  | { kind: 'catchup' }
  /** The outstanding edit had already been applied before the connection dropped. */
  | { kind: 'acked' }
  /** Server history was reset; pending edits were rebased onto the new document via diff. */
  | { kind: 'rebased'; pending: TextOperation }
  /** Pending edits were dropped (forced reset or unrecoverable state). */
  | { kind: 'discarded'; pending: TextOperation };

interface PendingServerOp {
  revision: number;
  operation: TextOperation;
}

interface OTState {
  readonly name: string;
  applyClient(client: OTClient, operation: TextOperation): OTState;
  applyServer(client: OTClient, revision: number, operation: TextOperation): OTState;
  applyOperations(client: OTClient, head: number, operations: OperationJSON[]): OTState;
  serverAck(client: OTClient, revision: number): OTState;
  transformSelection(selection: Transformable): Transformable;
  resend(client: OTClient): void;
  /**
   * Local edits the server has not incorporated yet, together with the text
   * they apply to. That text is known to be server state.
   */
  unconfirmed(client: OTClient): { base: string; pending: TextOperation } | null;
}

function checkNextRevision(client: OTClient, revision: number): void {
  if (revision !== client.revision + 1) {
    throw new OTDesyncError(`Expected revision ${client.revision + 1}, got ${revision}`);
  }
}

class Synchronized implements OTState {
  readonly name = 'Synchronized';

  applyClient(client: OTClient, operation: TextOperation): OTState {
    client.sendOperation(client.revision, operation);
    return new AwaitingConfirm(operation);
  }

  applyServer(client: OTClient, revision: number, operation: TextOperation): OTState {
    checkNextRevision(client, revision);
    client.revision = revision;
    client.serverDocument = operation.apply(client.serverDocument);
    client.applyOperation(operation);
    return this;
  }

  applyOperations(): OTState {
    // Late response to a recovery request we no longer need.
    return this;
  }

  serverAck(): OTState {
    throw new OTDesyncError('Received ack but there is no pending operation');
  }

  transformSelection(selection: Transformable): Transformable {
    return selection;
  }

  resend(): void {}

  unconfirmed(): null {
    return null;
  }
}

const synchronized = new Synchronized();

class AwaitingConfirm implements OTState {
  readonly name = 'AwaitingConfirm';

  constructor(readonly outstanding: TextOperation) {}

  applyClient(_client: OTClient, operation: TextOperation): OTState {
    return new AwaitingWithBuffer(this.outstanding, operation);
  }

  applyServer(client: OTClient, revision: number, operation: TextOperation): OTState {
    checkNextRevision(client, revision);
    client.revision = revision;
    client.serverDocument = operation.apply(client.serverDocument);
    const [outstanding, serverOp] = TextOperation.transform(this.outstanding, operation);
    client.applyOperation(serverOp);
    return new AwaitingConfirm(outstanding);
  }

  applyOperations(): OTState {
    return this;
  }

  serverAck(client: OTClient, revision: number): OTState {
    if (revision - client.revision > 1) {
      return new Stale(this.outstanding, revision, []).requestMissing(client);
    }
    checkNextRevision(client, revision);
    client.revision = revision;
    client.serverDocument = this.outstanding.apply(client.serverDocument);
    return synchronized;
  }

  transformSelection(selection: Transformable): Transformable {
    return selection.transform(this.outstanding);
  }

  resend(client: OTClient): void {
    client.sendOperation(client.revision, this.outstanding);
  }

  unconfirmed(client: OTClient) {
    return { base: client.serverDocument, pending: this.outstanding };
  }
}

class AwaitingWithBuffer implements OTState {
  readonly name = 'AwaitingWithBuffer';

  constructor(readonly outstanding: TextOperation, readonly buffer: TextOperation) {}

  applyClient(_client: OTClient, operation: TextOperation): OTState {
    return new AwaitingWithBuffer(this.outstanding, this.buffer.compose(operation));
  }

  applyServer(client: OTClient, revision: number, operation: TextOperation): OTState {
    checkNextRevision(client, revision);
    client.revision = revision;
    client.serverDocument = operation.apply(client.serverDocument);
    const [outstanding, op1] = TextOperation.transform(this.outstanding, operation);
    const [buffer, op2] = TextOperation.transform(this.buffer, op1);
    client.applyOperation(op2);
    return new AwaitingWithBuffer(outstanding, buffer);
  }

  applyOperations(): OTState {
    return this;
  }

  serverAck(client: OTClient, revision: number): OTState {
    if (revision - client.revision > 1) {
      return new StaleWithBuffer(this.outstanding, this.buffer, revision, []).requestMissing(client);
    }
    checkNextRevision(client, revision);
    client.revision = revision;
    client.serverDocument = this.outstanding.apply(client.serverDocument);
    client.sendOperation(client.revision, this.buffer);
    return new AwaitingConfirm(this.buffer);
  }

  transformSelection(selection: Transformable): Transformable {
    return selection.transform(this.outstanding).transform(this.buffer);
  }

  resend(client: OTClient): void {
    client.sendOperation(client.revision, this.outstanding);
  }

  unconfirmed(client: OTClient) {
    return { base: client.serverDocument, pending: this.outstanding.compose(this.buffer) };
  }
}

/**
 * Our operation was acknowledged at `revision`, but operations
 * `client.revision .. revision - 2` (concurrent with ours) were never
 * delivered. We asked the server for them and wait for `operations`.
 */
class Stale implements OTState {
  readonly name: string = 'Stale';

  constructor(
    readonly acknowledged: TextOperation,
    readonly revision: number,
    readonly pendingOps: PendingServerOp[],
  ) {}

  requestMissing(client: OTClient): OTState {
    // The acknowledged operation itself is at index revision - 1.
    client.getOperations(client.revision, this.revision - 1);
    return this;
  }

  applyClient(_client: OTClient, operation: TextOperation): OTState {
    return new StaleWithBuffer(this.acknowledged, operation, this.revision, this.pendingOps);
  }

  applyServer(_client: OTClient, revision: number, operation: TextOperation): OTState {
    // Sequential after our acknowledged op; apply once the gap is filled.
    this.pendingOps.push({ revision, operation });
    return this;
  }

  applyOperations(client: OTClient, _head: number, operations: OperationJSON[]): OTState {
    const acknowledged = this.fillGap(client, operations);
    client.revision = this.revision;
    client.serverDocument = acknowledged.apply(client.serverDocument);
    for (const pending of this.pendingOps) {
      client.revision = pending.revision;
      client.serverDocument = pending.operation.apply(client.serverDocument);
      client.applyOperation(pending.operation);
    }
    return synchronized;
  }

  /** Apply the missing concurrent ops; returns `acknowledged` transformed past them. */
  protected fillGap(client: OTClient, operations: OperationJSON[], buffer?: { op: TextOperation }): TextOperation {
    const expected = this.revision - 1 - client.revision;
    if (!Array.isArray(operations) || operations.length !== expected) {
      throw new OTDesyncError(
        `Recovery expected ${expected} operations, got ${Array.isArray(operations) ? operations.length : typeof operations}`,
      );
    }
    // Validate everything up front so a desync never leaves state half-applied.
    this.pendingOps.forEach((pending, i) => {
      if (pending.revision !== this.revision + 1 + i) {
        throw new OTDesyncError(`Expected revision ${this.revision + 1 + i}, got ${pending.revision}`);
      }
    });
    const parsed = operations.map(json => TextOperation.fromJSON(json));
    let acknowledged = this.acknowledged;
    for (const op of parsed) {
      client.serverDocument = op.apply(client.serverDocument);
      const [ackPrime, opPrime] = TextOperation.transform(acknowledged, op);
      acknowledged = ackPrime;
      if (buffer) {
        const [bufferPrime, opPrime2] = TextOperation.transform(buffer.op, opPrime);
        buffer.op = bufferPrime;
        client.applyOperation(opPrime2);
      } else {
        client.applyOperation(opPrime);
      }
      client.revision++;
    }
    return acknowledged;
  }

  serverAck(): OTState {
    throw new OTDesyncError('Received ack while recovering missing operations');
  }

  transformSelection(selection: Transformable): Transformable {
    return selection;
  }

  resend(): void {}

  unconfirmed(_client: OTClient): { base: string; pending: TextOperation } | null {
    // The acknowledged op is already server state; nothing local is pending.
    return null;
  }
}

class StaleWithBuffer extends Stale {
  readonly name = 'StaleWithBuffer';

  constructor(
    acknowledged: TextOperation,
    readonly buffer: TextOperation,
    revision: number,
    pendingOps: PendingServerOp[],
  ) {
    super(acknowledged, revision, pendingOps);
  }

  applyClient(_client: OTClient, operation: TextOperation): OTState {
    return new StaleWithBuffer(this.acknowledged, this.buffer.compose(operation), this.revision, this.pendingOps);
  }

  applyOperations(client: OTClient, _head: number, operations: OperationJSON[]): OTState {
    const buffer = { op: this.buffer };
    const acknowledged = this.fillGap(client, operations, buffer);
    client.revision = this.revision;
    client.serverDocument = acknowledged.apply(client.serverDocument);
    for (const pending of this.pendingOps) {
      const [bufferPrime, opPrime] = TextOperation.transform(buffer.op, pending.operation);
      buffer.op = bufferPrime;
      client.revision = pending.revision;
      client.serverDocument = pending.operation.apply(client.serverDocument);
      client.applyOperation(opPrime);
    }
    client.sendOperation(client.revision, buffer.op);
    return new AwaitingConfirm(buffer.op);
  }

  transformSelection(selection: Transformable): Transformable {
    return selection.transform(this.buffer);
  }

  unconfirmed(client: OTClient) {
    // Locally the document is serverDocument + acknowledged + buffer (the
    // missing concurrent ops were never applied). The buffer applies on top
    // of serverDocument + acknowledged, whose effect the server already has.
    return { base: this.acknowledged.apply(client.serverDocument), pending: this.buffer };
  }
}

/**
 * Rebase `pending` (based on `base`) onto `document`, which the server holds
 * at `revision`, using a diff as the server-side change. Updates the local
 * document and returns the rebased pending operation (not yet sent).
 */
function rebaseOntoDocument(
  client: OTClient,
  base: string,
  pending: TextOperation,
  revision: number,
  document: string,
): TextOperation {
  const serverChange = diffToOperation(base, document);
  const [pendingPrime, localChange] = TextOperation.transform(pending, serverChange);
  client.revision = revision;
  client.serverDocument = document;
  client.applyOperation(localChange);
  return pendingPrime;
}

/** Send `pending` if it does anything; returns the resulting state. */
function sendPending(client: OTClient, pending: TextOperation): OTState {
  if (pending.isNoop()) return synchronized;
  client.sendOperation(client.revision, pending);
  return new AwaitingConfirm(pending);
}

/**
 * After a reconnect the server is at `targetRevision` with `targetDocument`,
 * ahead of us. We requested the missed operations and verify them against
 * the document before trusting the server's history (it restarts at
 * revision 0 when a note is reloaded, and could have grown past ours).
 */
class CatchingUp implements OTState {
  readonly name = 'CatchingUp';

  /**
   * @param outstanding the op that was in flight when the connection dropped
   * @param rest local edits made after it (based on serverDocument + outstanding)
   */
  constructor(
    readonly outstanding: TextOperation,
    readonly rest: TextOperation | null,
    readonly targetRevision: number,
    readonly targetDocument: string,
    readonly pendingOps: PendingServerOp[] = [],
  ) {}

  get pending(): TextOperation {
    return this.rest ? this.outstanding.compose(this.rest) : this.outstanding;
  }

  applyClient(_client: OTClient, operation: TextOperation): OTState {
    const rest = this.rest ? this.rest.compose(operation) : operation;
    return new CatchingUp(this.outstanding, rest, this.targetRevision, this.targetDocument, this.pendingOps);
  }

  applyServer(_client: OTClient, revision: number, operation: TextOperation): OTState {
    this.pendingOps.push({ revision, operation });
    return this;
  }

  applyOperations(client: OTClient, _head: number, operations: OperationJSON[]): OTState {
    this.pendingOps.forEach((p, i) => {
      if (p.revision !== this.targetRevision + 1 + i) {
        throw new OTDesyncError(`Expected revision ${this.targetRevision + 1 + i}, got ${p.revision}`);
      }
    });

    let pending = this.pending;
    let missed = this.verify(client, operations);
    if (missed) {
      // If the outstanding op was the first one applied after our revision,
      // the server stored it untransformed: it landed and only the ack was lost.
      if (missed.length > 0 && JSON.stringify(missed[0].ops) === JSON.stringify(this.outstanding.ops)) {
        client.serverDocument = this.outstanding.apply(client.serverDocument);
        missed = missed.slice(1);
        pending = this.rest ?? new TextOperation().retain(client.serverDocument.length);
      }
      for (const op of missed) {
        const [pendingPrime, opPrime] = TextOperation.transform(pending, op);
        pending = pendingPrime;
        client.applyOperation(opPrime);
      }
      client.revision = this.targetRevision;
      client.serverDocument = this.targetDocument;
    } else {
      pending = rebaseOntoDocument(client, client.serverDocument, pending, this.targetRevision, this.targetDocument);
    }

    for (const p of this.pendingOps) {
      const [pendingPrime, opPrime] = TextOperation.transform(pending, p.operation);
      pending = pendingPrime;
      client.revision = p.revision;
      client.serverDocument = p.operation.apply(client.serverDocument);
      client.applyOperation(opPrime);
    }
    return sendPending(client, pending);
  }

  /** The missed operations if they lead exactly to the target document, else null. */
  private verify(client: OTClient, operations: OperationJSON[]): TextOperation[] | null {
    if (!Array.isArray(operations) || operations.length !== this.targetRevision - client.revision) {
      return null;
    }
    try {
      const ops = operations.map(json => TextOperation.fromJSON(json));
      let doc = client.serverDocument;
      for (const op of ops) doc = op.apply(doc);
      return doc === this.targetDocument ? ops : null;
    } catch {
      return null;
    }
  }

  serverAck(): OTState {
    throw new OTDesyncError('Received ack while catching up');
  }

  transformSelection(selection: Transformable): Transformable {
    return selection.transform(this.pending);
  }

  resend(): void {}

  unconfirmed(client: OTClient) {
    return { base: client.serverDocument, pending: this.pending };
  }
}

/**
 * OT Client - manages client-side state for operational transformation.
 * Subclasses implement the I/O hooks at the bottom.
 */
export abstract class OTClient {
  /** Last server revision this client has incorporated. */
  revision: number;
  /** Server document at `revision` (local document minus unconfirmed edits). */
  serverDocument: string;
  private state: OTState;

  constructor(revision: number, document: string) {
    this.revision = revision;
    this.serverDocument = document;
    this.state = synchronized;
  }

  /** Name of the current state, for diagnostics. */
  get stateName(): string {
    return this.state.name;
  }

  private setState(state: OTState): void {
    const wasSynchronized = this.state === synchronized;
    this.state = state;
    if (!wasSynchronized && state === synchronized) {
      this.onSynchronized();
    }
  }

  /** Called when the local user makes an edit (already applied locally). */
  applyClient(operation: TextOperation): void {
    this.setState(this.state.applyClient(this, operation));
  }

  /** Called when receiving an operation from the server. */
  applyServer(revision: number, operation: TextOperation): void {
    this.setState(this.state.applyServer(this, revision, operation));
  }

  /** Called with the response to a get_operations request. */
  applyOperations(head: number, operations: OperationJSON[]): void {
    this.setState(this.state.applyOperations(this, head, operations));
  }

  /** Called when the server acknowledges our operation. */
  serverAck(revision: number): void {
    this.setState(this.state.serverAck(this, revision));
  }

  /**
   * Called when the server sends a full `doc` after the initial load
   * (reconnect, or the server's own recovery after a failed operation).
   *
   * On return the subclass has been told (via applyOperation / resetDocument)
   * how to bring the local document in line.
   */
  serverReconnect(revision: number, document: string, force: boolean): ReconnectOutcome {
    const unconfirmed = this.state.unconfirmed(this);
    const pendingOp = unconfirmed?.pending ?? null;

    const reset = (): void => {
      this.revision = revision;
      this.serverDocument = document;
      this.setState(synchronized);
      this.resetDocument(document);
    };

    if (!pendingOp || pendingOp.isNoop()) {
      reset();
      return { kind: 'reset' };
    }
    if (force || !unconfirmed) {
      reset();
      return { kind: 'discarded', pending: pendingOp };
    }

    const state = this.state;
    if (state instanceof AwaitingConfirm || state instanceof AwaitingWithBuffer) {
      // Did the outstanding op land before the connection dropped (ack lost)?
      if (
        revision === this.revision + 1 &&
        document === state.outstanding.apply(this.serverDocument)
      ) {
        this.serverAck(revision);
        return { kind: 'acked' };
      }
      // Nothing happened on the server: let it receive our op again (upstream behaviour).
      if (revision === this.revision && document === this.serverDocument) {
        state.resend(this);
        return { kind: 'resent' };
      }
    }

    // The server moved on. If its history can still be ours, fetch and verify
    // the missed operations (the server ignores get_operations with base 0).
    if (revision > this.revision && this.revision > 0 && !(state instanceof Stale)) {
      const next = state instanceof CatchingUp
        ? new CatchingUp(state.outstanding, state.rest, revision, document)
        : state instanceof AwaitingWithBuffer
          ? new CatchingUp(state.outstanding, state.buffer, revision, document)
          : state instanceof AwaitingConfirm
            ? new CatchingUp(state.outstanding, null, revision, document)
            : new CatchingUp(pendingOp, null, revision, document);
      this.setState(next);
      this.getOperations(this.revision, revision);
      return { kind: 'catchup' };
    }

    // History no longer matches (note reloaded / server restarted).
    const pendingPrime = rebaseOntoDocument(this, unconfirmed.base, pendingOp, revision, document);
    this.setState(sendPending(this, pendingPrime));
    return { kind: 'rebased', pending: pendingPrime };
  }

  /** Transform a selection from server state to client state. */
  transformSelection(selection: Transformable): Transformable {
    return this.state.transformSelection(selection);
  }

  /** True when every local edit has been acknowledged by the server. */
  isSynchronized(): boolean {
    return this.state === synchronized;
  }

  // ---- I/O hooks -------------------------------------------------------

  /** Send an operation to the server. */
  abstract sendOperation(revision: number, operation: TextOperation): void;

  /** Apply a (transformed) remote operation to the local document. */
  abstract applyOperation(operation: TextOperation): void;

  /** Replace the local document wholesale. */
  abstract resetDocument(document: string): void;

  /** Request operations `base .. head-1` from the server. */
  abstract getOperations(base: number, head: number): void;

  /** Called whenever the client transitions into the synchronized state. */
  onSynchronized(): void {}
}
