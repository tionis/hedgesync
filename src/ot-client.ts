import { TextOperation, OperationJSON } from './text-operation.js';

/**
 * OT Client State Machine
 * 
 * Manages the client-side state for operational transformation.
 * The client can be in one of three states:
 * - Synchronized: No pending operations
 * - AwaitingConfirm: Sent one operation, waiting for server ack
 * - AwaitingWithBuffer: Sent one operation, have buffered another
 */

/** Selection that can be transformed */
export interface Transformable {
  transform(operation: TextOperation): Transformable;
}

/** Base interface for OT client states */
interface OTState {
  applyClient(client: OTClient, operation: TextOperation): OTState;
  applyServer(client: OTClient, revision: number, operation: TextOperation): OTState;
  serverAck(client: OTClient, revision: number): OTState;
  transformSelection(selection: Transformable): Transformable;
  applyOperations?(client: OTClient, head: number, operations: OperationJSON[]): OTState;
  resend?(client: OTClient): void;
}

// State: Synchronized - no pending operations
class Synchronized implements OTState {
  applyClient(client: OTClient, operation: TextOperation): OTState {
    // Send operation to server and wait for ack
    client.sendOperation(client.revision, operation);
    return new AwaitingConfirm(operation);
  }

  applyServer(client: OTClient, revision: number, operation: TextOperation): OTState {
    if (revision - client.revision > 1) {
      throw new Error('Invalid revision.');
    }
    client.revision = revision;
    client.applyOperation(operation);
    return this;
  }

  serverAck(_client: OTClient, _revision: number): OTState {
    throw new Error('There is no pending operation.');
  }

  transformSelection(x: Transformable): Transformable {
    return x;
  }
}

// Singleton synchronized state
const synchronized = new Synchronized();

// State: AwaitingConfirm - waiting for server to acknowledge our operation
class AwaitingConfirm implements OTState {
  outstanding: TextOperation;

  constructor(outstanding: TextOperation) {
    this.outstanding = outstanding;
  }

  applyClient(_client: OTClient, operation: TextOperation): OTState {
    // Buffer the new operation
    return new AwaitingWithBuffer(this.outstanding, operation);
  }

  applyServer(client: OTClient, revision: number, operation: TextOperation): OTState {
    if (revision - client.revision > 1) {
      throw new Error('Invalid revision.');
    }
    client.revision = revision;
    // Transform our outstanding operation against the server's operation
    const [outstanding, serverOp] = TextOperation.transform(this.outstanding, operation);
    client.applyOperation(serverOp);
    return new AwaitingConfirm(outstanding);
  }

  serverAck(client: OTClient, revision: number): OTState {
    if (revision - client.revision > 1) {
      // Stale - need to fetch missing operations
      return new Stale(this.outstanding, client, revision).getOperations();
    }
    client.revision = revision;
    return synchronized;
  }

  transformSelection(selection: Transformable): Transformable {
    return selection.transform(this.outstanding);
  }

  resend(client: OTClient): void {
    client.sendOperation(client.revision, this.outstanding);
  }
}

// State: AwaitingWithBuffer - waiting for ack and have buffered operations
class AwaitingWithBuffer implements OTState {
  outstanding: TextOperation;
  buffer: TextOperation;

  constructor(outstanding: TextOperation, buffer: TextOperation) {
    this.outstanding = outstanding;
    this.buffer = buffer;
  }

  applyClient(_client: OTClient, operation: TextOperation): OTState {
    // Compose new operation with buffer
    const newBuffer = this.buffer.compose(operation);
    return new AwaitingWithBuffer(this.outstanding, newBuffer);
  }

  applyServer(client: OTClient, revision: number, operation: TextOperation): OTState {
    if (revision - client.revision > 1) {
      throw new Error('Invalid revision.');
    }
    client.revision = revision;
    // Transform both outstanding and buffer against server operation
    const [outstanding, op1] = TextOperation.transform(this.outstanding, operation);
    const [buffer, op2] = TextOperation.transform(this.buffer, op1);
    client.applyOperation(op2);
    return new AwaitingWithBuffer(outstanding, buffer);
  }

  serverAck(client: OTClient, revision: number): OTState {
    if (revision - client.revision > 1) {
      return new StaleWithBuffer(this.outstanding, this.buffer, client, revision).getOperations();
    }
    client.revision = revision;
    // Send buffered operation
    client.sendOperation(client.revision, this.buffer);
    return new AwaitingConfirm(this.buffer);
  }

  transformSelection(selection: Transformable): Transformable {
    return selection.transform(this.outstanding).transform(this.buffer);
  }

  resend(client: OTClient): void {
    client.sendOperation(client.revision, this.outstanding);
  }
}

// State: Stale - missed some revisions, need to catch up
class Stale implements OTState {
  outstanding: TextOperation;
  client: OTClient;
  targetRevision: number;

  constructor(outstanding: TextOperation, client: OTClient, revision: number) {
    this.outstanding = outstanding;
    this.client = client;
    this.targetRevision = revision;
  }

  getOperations(): OTState {
    this.client.getOperations(this.client.revision, this.targetRevision);
    return this;
  }

  applyClient(_client: OTClient, _operation: TextOperation): OTState {
    throw new Error('Unsupported operation in stale state');
  }

  applyServer(_client: OTClient, _revision: number, _operation: TextOperation): OTState {
    throw new Error('Unsupported operation in stale state');
  }

  applyOperations(client: OTClient, head: number, operations: OperationJSON[]): OTState {
    for (let i = 0; i < operations.length; i++) {
      const op = TextOperation.fromJSON(operations[i]);
      const [outstanding, serverOp] = TextOperation.transform(this.outstanding, op);
      this.outstanding = outstanding;
      client.applyOperation(serverOp);
    }
    client.revision = head;
    return new AwaitingConfirm(this.outstanding);
  }

  serverAck(_client: OTClient, _revision: number): OTState {
    throw new Error('Unsupported operation in stale state');
  }

  transformSelection(selection: Transformable): Transformable {
    return selection;
  }
}

// State: StaleWithBuffer - missed revisions and have buffered operations
class StaleWithBuffer implements OTState {
  outstanding: TextOperation;
  buffer: TextOperation;
  client: OTClient;
  targetRevision: number;

  constructor(outstanding: TextOperation, buffer: TextOperation, client: OTClient, revision: number) {
    this.outstanding = outstanding;
    this.buffer = buffer;
    this.client = client;
    this.targetRevision = revision;
  }

  getOperations(): OTState {
    this.client.getOperations(this.client.revision, this.targetRevision);
    return this;
  }

  applyClient(_client: OTClient, _operation: TextOperation): OTState {
    throw new Error('Unsupported operation in stale state');
  }

  applyServer(_client: OTClient, _revision: number, _operation: TextOperation): OTState {
    throw new Error('Unsupported operation in stale state');
  }

  applyOperations(client: OTClient, head: number, operations: OperationJSON[]): OTState {
    for (let i = 0; i < operations.length; i++) {
      const op = TextOperation.fromJSON(operations[i]);
      const [outstanding, op1] = TextOperation.transform(this.outstanding, op);
      const [buffer, op2] = TextOperation.transform(this.buffer, op1);
      this.outstanding = outstanding;
      this.buffer = buffer;
      client.applyOperation(op2);
    }
    client.revision = head;
    client.sendOperation(client.revision, this.buffer);
    return new AwaitingWithBuffer(this.outstanding, this.buffer);
  }

  serverAck(_client: OTClient, _revision: number): OTState {
    throw new Error('Unsupported operation in stale state');
  }

  transformSelection(selection: Transformable): Transformable {
    return selection.transform(this.outstanding).transform(this.buffer);
  }
}

/**
 * OT Client - manages client-side state for operational transformation
 */
export class OTClient {
  revision: number;
  private state: OTState;

  constructor(revision: number = 0) {
    this.revision = revision;
    this.state = synchronized;
  }

  /**
   * Called when the local user makes an edit
   */
  applyClient(operation: TextOperation): void {
    this.state = this.state.applyClient(this, operation);
  }

  /**
   * Called when receiving an operation from the server
   */
  applyServer(revision: number, operation: TextOperation): void {
    this.state = this.state.applyServer(this, revision, operation);
  }

  /**
   * Called when receiving operations from get_operations request
   */
  applyOperations(head: number, operations: OperationJSON[]): void {
    if (this.state.applyOperations) {
      this.state = this.state.applyOperations(this, head, operations);
    }
  }

  /**
   * Called when the server acknowledges our operation
   */
  serverAck(revision: number): void {
    this.state = this.state.serverAck(this, revision);
  }

  /**
   * Called when reconnecting to resend pending operations
   */
  serverReconnect(): void {
    if (this.state.resend) {
      this.state.resend(this);
    }
  }

  /**
   * Transform a selection from server state to client state
   */
  transformSelection(selection: Transformable): Transformable {
    return this.state.transformSelection(selection);
  }

  /**
   * Check if client is in synchronized state
   */
  isSynchronized(): boolean {
    return this.state === synchronized;
  }

  // Override these methods:

  /**
   * Send an operation to the server
   * @param revision - The revision number
   * @param operation - The operation to send
   */
  sendOperation(_revision: number, _operation: TextOperation): void {
    throw new Error('sendOperation must be defined in child class');
  }

  /**
   * Apply an operation to the local document
   * @param operation - The operation to apply
   */
  applyOperation(_operation: TextOperation): void {
    throw new Error('applyOperation must be defined in child class');
  }

  /**
   * Request missing operations from server
   * @param base - Start revision
   * @param head - End revision
   */
  getOperations(_base: number, _head: number): void {
    throw new Error('getOperations must be defined in child class');
  }
}
