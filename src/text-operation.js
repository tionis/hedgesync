/**
 * TextOperation - Represents a document transformation operation
 * 
 * Operations are composed of three types of atomic operations:
 * - Retain: Skip over characters (positive integer)
 * - Insert: Insert a string at the current position (string)
 * - Delete: Delete characters (negative integer)
 * 
 * Based on the OT implementation from HedgeDoc.
 */
export class TextOperation {
  constructor() {
    // Operations array - contains retain (positive int), insert (string), or delete (negative int)
    this.ops = [];
    // Length of the document this operation can be applied to
    this.baseLength = 0;
    // Length of the document after applying this operation
    this.targetLength = 0;
  }

  /**
   * Check if an operation component is a retain
   */
  static isRetain(op) {
    return typeof op === 'number' && op > 0;
  }

  /**
   * Check if an operation component is an insert
   */
  static isInsert(op) {
    return typeof op === 'string';
  }

  /**
   * Check if an operation component is a delete
   */
  static isDelete(op) {
    return typeof op === 'number' && op < 0;
  }

  /**
   * Skip over n characters
   */
  retain(n) {
    if (typeof n !== 'number') {
      throw new Error('retain expects an integer');
    }
    if (n === 0) return this;
    
    this.baseLength += n;
    this.targetLength += n;
    
    if (TextOperation.isRetain(this.ops[this.ops.length - 1])) {
      // Merge with previous retain
      this.ops[this.ops.length - 1] += n;
    } else {
      this.ops.push(n);
    }
    return this;
  }

  /**
   * Insert a string at the current position
   */
  insert(str) {
    if (typeof str !== 'string') {
      throw new Error('insert expects a string');
    }
    if (str === '') return this;
    
    this.targetLength += str.length;
    const ops = this.ops;
    
    if (TextOperation.isInsert(ops[ops.length - 1])) {
      // Merge with previous insert
      ops[ops.length - 1] += str;
    } else if (TextOperation.isDelete(ops[ops.length - 1])) {
      // Insert before delete (canonical form)
      if (TextOperation.isInsert(ops[ops.length - 2])) {
        ops[ops.length - 2] += str;
      } else {
        ops[ops.length] = ops[ops.length - 1];
        ops[ops.length - 2] = str;
      }
    } else {
      ops.push(str);
    }
    return this;
  }

  /**
   * Delete n characters
   */
  delete(n) {
    if (typeof n === 'string') n = n.length;
    if (typeof n !== 'number') {
      throw new Error('delete expects an integer or a string');
    }
    if (n === 0) return this;
    if (n > 0) n = -n;
    
    this.baseLength -= n;
    
    if (TextOperation.isDelete(this.ops[this.ops.length - 1])) {
      this.ops[this.ops.length - 1] += n;
    } else {
      this.ops.push(n);
    }
    return this;
  }

  /**
   * Check if this is a no-op
   */
  isNoop() {
    return this.ops.length === 0 || 
           (this.ops.length === 1 && TextOperation.isRetain(this.ops[0]));
  }

  /**
   * Apply this operation to a string
   */
  apply(str) {
    if (str.length !== this.baseLength) {
      throw new Error("The operation's base length must be equal to the string's length.");
    }
    
    const newStr = [];
    let strIndex = 0;
    
    for (const op of this.ops) {
      if (TextOperation.isRetain(op)) {
        if (strIndex + op > str.length) {
          throw new Error("Operation can't retain more characters than are left in the string.");
        }
        newStr.push(str.slice(strIndex, strIndex + op));
        strIndex += op;
      } else if (TextOperation.isInsert(op)) {
        newStr.push(op);
      } else { // delete
        strIndex -= op;
      }
    }
    
    if (strIndex !== str.length) {
      throw new Error("The operation didn't operate on the whole string.");
    }
    
    return newStr.join('');
  }

  /**
   * Compose two operations into one
   */
  compose(operation2) {
    if (this.targetLength !== operation2.baseLength) {
      throw new Error('The base length of the second operation has to be the target length of the first operation');
    }

    const operation1 = this;
    const composed = new TextOperation();
    let i1 = 0, i2 = 0;
    let op1 = operation1.ops[i1++];
    let op2 = operation2.ops[i2++];
    
    while (typeof op1 !== 'undefined' || typeof op2 !== 'undefined') {
      if (TextOperation.isDelete(op1)) {
        composed.delete(op1);
        op1 = operation1.ops[i1++];
        continue;
      }
      if (TextOperation.isInsert(op2)) {
        composed.insert(op2);
        op2 = operation2.ops[i2++];
        continue;
      }

      if (typeof op1 === 'undefined') {
        throw new Error('Cannot compose operations: first operation is too short.');
      }
      if (typeof op2 === 'undefined') {
        throw new Error('Cannot compose operations: first operation is too long.');
      }

      if (TextOperation.isRetain(op1) && TextOperation.isRetain(op2)) {
        if (op1 > op2) {
          composed.retain(op2);
          op1 = op1 - op2;
          op2 = operation2.ops[i2++];
        } else if (op1 === op2) {
          composed.retain(op1);
          op1 = operation1.ops[i1++];
          op2 = operation2.ops[i2++];
        } else {
          composed.retain(op1);
          op2 = op2 - op1;
          op1 = operation1.ops[i1++];
        }
      } else if (TextOperation.isInsert(op1) && TextOperation.isDelete(op2)) {
        if (op1.length > -op2) {
          op1 = op1.slice(-op2);
          op2 = operation2.ops[i2++];
        } else if (op1.length === -op2) {
          op1 = operation1.ops[i1++];
          op2 = operation2.ops[i2++];
        } else {
          op2 = op2 + op1.length;
          op1 = operation1.ops[i1++];
        }
      } else if (TextOperation.isInsert(op1) && TextOperation.isRetain(op2)) {
        if (op1.length > op2) {
          composed.insert(op1.slice(0, op2));
          op1 = op1.slice(op2);
          op2 = operation2.ops[i2++];
        } else if (op1.length === op2) {
          composed.insert(op1);
          op1 = operation1.ops[i1++];
          op2 = operation2.ops[i2++];
        } else {
          composed.insert(op1);
          op2 = op2 - op1.length;
          op1 = operation1.ops[i1++];
        }
      } else if (TextOperation.isRetain(op1) && TextOperation.isDelete(op2)) {
        if (op1 > -op2) {
          composed.delete(op2);
          op1 = op1 + op2;
          op2 = operation2.ops[i2++];
        } else if (op1 === -op2) {
          composed.delete(op2);
          op1 = operation1.ops[i1++];
          op2 = operation2.ops[i2++];
        } else {
          composed.delete(op1);
          op2 = op2 + op1;
          op1 = operation1.ops[i1++];
        }
      } else {
        throw new Error('This shouldn\'t happen: op1: ' + JSON.stringify(op1) + ', op2: ' + JSON.stringify(op2));
      }
    }
    return composed;
  }

  /**
   * Transform two operations that happened concurrently
   * Returns [op1', op2'] where applying op1 then op2' gives the same result as op2 then op1'
   */
  static transform(operation1, operation2) {
    if (operation1.baseLength !== operation2.baseLength) {
      throw new Error('Both operations have to have the same base length');
    }

    const operation1prime = new TextOperation();
    const operation2prime = new TextOperation();
    let i1 = 0, i2 = 0;
    let op1 = operation1.ops[i1++];
    let op2 = operation2.ops[i2++];
    
    while (typeof op1 !== 'undefined' || typeof op2 !== 'undefined') {
      // Insert operations always go first
      if (TextOperation.isInsert(op1)) {
        operation1prime.insert(op1);
        operation2prime.retain(op1.length);
        op1 = operation1.ops[i1++];
        continue;
      }
      if (TextOperation.isInsert(op2)) {
        operation1prime.retain(op2.length);
        operation2prime.insert(op2);
        op2 = operation2.ops[i2++];
        continue;
      }

      if (typeof op1 === 'undefined') {
        throw new Error('Cannot transform operations: first operation is too short.');
      }
      if (typeof op2 === 'undefined') {
        throw new Error('Cannot transform operations: first operation is too long.');
      }

      let minl;
      if (TextOperation.isRetain(op1) && TextOperation.isRetain(op2)) {
        // Both retain
        if (op1 > op2) {
          minl = op2;
          op1 = op1 - op2;
          op2 = operation2.ops[i2++];
        } else if (op1 === op2) {
          minl = op2;
          op1 = operation1.ops[i1++];
          op2 = operation2.ops[i2++];
        } else {
          minl = op1;
          op2 = op2 - op1;
          op1 = operation1.ops[i1++];
        }
        operation1prime.retain(minl);
        operation2prime.retain(minl);
      } else if (TextOperation.isDelete(op1) && TextOperation.isDelete(op2)) {
        // Both delete - they cancel each other out
        if (-op1 > -op2) {
          op1 = op1 - op2;
          op2 = operation2.ops[i2++];
        } else if (op1 === op2) {
          op1 = operation1.ops[i1++];
          op2 = operation2.ops[i2++];
        } else {
          op2 = op2 - op1;
          op1 = operation1.ops[i1++];
        }
      } else if (TextOperation.isDelete(op1) && TextOperation.isRetain(op2)) {
        if (-op1 > op2) {
          minl = op2;
          op1 = op1 + op2;
          op2 = operation2.ops[i2++];
        } else if (-op1 === op2) {
          minl = op2;
          op1 = operation1.ops[i1++];
          op2 = operation2.ops[i2++];
        } else {
          minl = -op1;
          op2 = op2 + op1;
          op1 = operation1.ops[i1++];
        }
        operation1prime.delete(minl);
      } else if (TextOperation.isRetain(op1) && TextOperation.isDelete(op2)) {
        if (op1 > -op2) {
          minl = -op2;
          op1 = op1 + op2;
          op2 = operation2.ops[i2++];
        } else if (op1 === -op2) {
          minl = op1;
          op1 = operation1.ops[i1++];
          op2 = operation2.ops[i2++];
        } else {
          minl = op1;
          op2 = op2 + op1;
          op1 = operation1.ops[i1++];
        }
        operation2prime.delete(minl);
      } else {
        throw new Error("The two operations aren't compatible");
      }
    }

    return [operation1prime, operation2prime];
  }

  /**
   * Convert to JSON (array of ops)
   */
  toJSON() {
    return this.ops;
  }

  /**
   * Transform a position through an operation
   * Returns the new position after the operation is applied
   * @param {number} position - The position to transform
   * @param {TextOperation} operation - The operation to transform through
   * @param {boolean} insertBefore - If true, inserts at the same position push position forward
   * @returns {number} The transformed position
   */
  static transformPosition(position, operation, insertBefore = false) {
    let pos = position;
    let index = 0;
    
    for (const op of operation.ops) {
      if (TextOperation.isRetain(op)) {
        index += op;
      } else if (TextOperation.isInsert(op)) {
        // Insert at or before our position moves us forward
        if (index < pos || (index === pos && insertBefore)) {
          pos += op.length;
        }
        // Insert doesn't advance index (it's inserted at current position)
      } else if (TextOperation.isDelete(op)) {
        const deleteCount = -op;
        if (index < pos) {
          // Delete before our position moves us backward
          pos -= Math.min(deleteCount, pos - index);
        }
        index += deleteCount;
      }
    }
    
    return Math.max(0, pos);
  }

  /**
   * Create from JSON array
   */
  static fromJSON(ops) {
    const o = new TextOperation();
    for (const op of ops) {
      if (TextOperation.isRetain(op)) {
        o.retain(op);
      } else if (TextOperation.isInsert(op)) {
        o.insert(op);
      } else if (TextOperation.isDelete(op)) {
        o.delete(op);
      } else {
        throw new Error('unknown operation: ' + JSON.stringify(op));
      }
    }
    return o;
  }

  /**
   * String representation for debugging
   */
  toString() {
    return this.ops.map(op => {
      if (TextOperation.isRetain(op)) {
        return `retain ${op}`;
      } else if (TextOperation.isInsert(op)) {
        return `insert '${op}'`;
      } else {
        return `delete ${-op}`;
      }
    }).join(', ');
  }
}
