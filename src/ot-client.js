import { TextOperation } from './text-operation.js';

/**
 * OT Client State Machine
 * 
 * Manages the client-side state for operational transformation.
 * The client can be in one of three states:
 * - Synchronized: No pending operations
 * - AwaitingConfirm: Sent one operation, waiting for server ack
 * - AwaitingWithBuffer: Sent one operation, have buffered another
 */

// State: Synchronized - no pending operations
class Synchronized {
  applyClient(client, operation) {
    // Send operation to server and wait for ack
    client.sendOperation(client.revision, operation);
    return new AwaitingConfirm(operation);
  }

  applyServer(client, revision, operation) {
    if (revision - client.revision > 1) {
      throw new Error('Invalid revision.');
    }
    client.revision = revision;
    client.applyOperation(operation);
    return this;
  }

  serverAck(client, revision) {
    throw new Error('There is no pending operation.');
  }

  transformSelection(x) {
    return x;
  }
}

// Singleton synchronized state
const synchronized = new Synchronized();

// State: AwaitingConfirm - waiting for server to acknowledge our operation
class AwaitingConfirm {
  constructor(outstanding) {
    this.outstanding = outstanding;
  }

  applyClient(client, operation) {
    // Buffer the new operation
    return new AwaitingWithBuffer(this.outstanding, operation);
  }

  applyServer(client, revision, operation) {
    if (revision - client.revision > 1) {
      throw new Error('Invalid revision.');
    }
    client.revision = revision;
    // Transform our outstanding operation against the server's operation
    const [outstanding, serverOp] = TextOperation.transform(this.outstanding, operation);
    client.applyOperation(serverOp);
    return new AwaitingConfirm(outstanding);
  }

  serverAck(client, revision) {
    if (revision - client.revision > 1) {
      // Stale - need to fetch missing operations
      return new Stale(this.outstanding, client, revision).getOperations();
    }
    client.revision = revision;
    return synchronized;
  }

  transformSelection(selection) {
    return selection.transform(this.outstanding);
  }

  resend(client) {
    client.sendOperation(client.revision, this.outstanding);
  }
}

// State: AwaitingWithBuffer - waiting for ack and have buffered operations
class AwaitingWithBuffer {
  constructor(outstanding, buffer) {
    this.outstanding = outstanding;
    this.buffer = buffer;
  }

  applyClient(client, operation) {
    // Compose new operation with buffer
    const newBuffer = this.buffer.compose(operation);
    return new AwaitingWithBuffer(this.outstanding, newBuffer);
  }

  applyServer(client, revision, operation) {
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

  serverAck(client, revision) {
    if (revision - client.revision > 1) {
      return new StaleWithBuffer(this.outstanding, this.buffer, client, revision).getOperations();
    }
    client.revision = revision;
    // Send buffered operation
    client.sendOperation(client.revision, this.buffer);
    return new AwaitingConfirm(this.buffer);
  }

  transformSelection(selection) {
    return selection.transform(this.outstanding).transform(this.buffer);
  }

  resend(client) {
    client.sendOperation(client.revision, this.outstanding);
  }
}

// State: Stale - missed some revisions, need to catch up
class Stale {
  constructor(outstanding, client, revision) {
    this.outstanding = outstanding;
    this.client = client;
    this.revision = revision;
  }

  getOperations() {
    this.client.getOperations(this.client.revision, this.revision);
    return this;
  }

  applyClient(client, operation) {
    throw new Error('Unsupported operation in stale state');
  }

  applyServer(client, revision, operation) {
    throw new Error('Unsupported operation in stale state');
  }

  applyOperations(client, head, operations) {
    for (let i = 0; i < operations.length; i++) {
      const op = TextOperation.fromJSON(operations[i]);
      const [outstanding, serverOp] = TextOperation.transform(this.outstanding, op);
      this.outstanding = outstanding;
      client.applyOperation(serverOp);
    }
    client.revision = head;
    return new AwaitingConfirm(this.outstanding);
  }

  serverAck(client, revision) {
    throw new Error('Unsupported operation in stale state');
  }

  transformSelection(selection) {
    return selection;
  }
}

// State: StaleWithBuffer - missed revisions and have buffered operations
class StaleWithBuffer {
  constructor(outstanding, buffer, client, revision) {
    this.outstanding = outstanding;
    this.buffer = buffer;
    this.client = client;
    this.revision = revision;
  }

  getOperations() {
    this.client.getOperations(this.client.revision, this.revision);
    return this;
  }

  applyClient(client, operation) {
    throw new Error('Unsupported operation in stale state');
  }

  applyServer(client, revision, operation) {
    throw new Error('Unsupported operation in stale state');
  }

  applyOperations(client, head, operations) {
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

  serverAck(client, revision) {
    throw new Error('Unsupported operation in stale state');
  }

  transformSelection(selection) {
    return selection.transform(this.outstanding).transform(this.buffer);
  }
}

/**
 * OT Client - manages client-side state for operational transformation
 */
export class OTClient {
  constructor(revision = 0) {
    this.revision = revision;
    this.state = synchronized;
  }

  /**
   * Called when the local user makes an edit
   */
  applyClient(operation) {
    this.state = this.state.applyClient(this, operation);
  }

  /**
   * Called when receiving an operation from the server
   */
  applyServer(revision, operation) {
    this.state = this.state.applyServer(this, revision, operation);
  }

  /**
   * Called when receiving operations from get_operations request
   */
  applyOperations(head, operations) {
    this.state = this.state.applyOperations(this, head, operations);
  }

  /**
   * Called when the server acknowledges our operation
   */
  serverAck(revision) {
    this.state = this.state.serverAck(this, revision);
  }

  /**
   * Called when reconnecting to resend pending operations
   */
  serverReconnect() {
    if (typeof this.state.resend === 'function') {
      this.state.resend(this);
    }
  }

  /**
   * Transform a selection from server state to client state
   */
  transformSelection(selection) {
    return this.state.transformSelection(selection);
  }

  /**
   * Check if client is in synchronized state
   */
  isSynchronized() {
    return this.state === synchronized;
  }

  // Override these methods:

  /**
   * Send an operation to the server
   * @param {number} revision - The revision number
   * @param {TextOperation} operation - The operation to send
   */
  sendOperation(revision, operation) {
    throw new Error('sendOperation must be defined in child class');
  }

  /**
   * Apply an operation to the local document
   * @param {TextOperation} operation - The operation to apply
   */
  applyOperation(operation) {
    throw new Error('applyOperation must be defined in child class');
  }

  /**
   * Request missing operations from server
   * @param {number} base - Start revision
   * @param {number} head - End revision
   */
  getOperations(base, head) {
    throw new Error('getOperations must be defined in child class');
  }
}
