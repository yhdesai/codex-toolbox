import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export class JsonRpcClient extends EventEmitter {
  constructor({ command, args = [], cwd = process.cwd(), spawnImpl = spawn, reconnectMs = 1000 }) {
    super();
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.spawn = spawnImpl;
    this.reconnectMs = reconnectMs;
    this.nextId = 1;
    this.pending = new Map();
    this.process = null;
    this.running = false;
    this.launchCount = 0;
  }

  start() {
    this.running = true;
    this.#launch();
  }

  stop() {
    this.running = false;
    for (const pending of this.pending.values()) {
      pending.reject(new Error('JSON-RPC client stopped'));
    }
    this.pending.clear();
    this.process?.kill();
  }

  request(method, params = {}, options = {}) {
    if (!this.process?.stdin?.writable) {
      return Promise.reject(new Error('JSON-RPC process is not connected'));
    }
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? 30000;
    const message = { id, method, params };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout, method });
      this.#write(message);
    });
  }

  notify(method, params = {}) {
    if (!this.process?.stdin?.writable) {
      throw new Error('JSON-RPC process is not connected');
    }
    this.#write({ method, params });
  }

  respond(id, result) {
    this.#write({ id, result });
  }

  rejectRequest(id, code, message, data = undefined) {
    this.#write({ id, error: { code, message, ...(data === undefined ? {} : { data }) } });
  }

  #launch() {
    const reconnect = this.launchCount > 0;
    this.launchCount += 1;
    const child = this.spawn(this.command, this.args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process = child;
    this.emit('connect', { reconnect });

    const stdout = createInterface({ input: child.stdout });
    stdout.on('line', (line) => this.#handleLine(line));
    child.stderr.on('data', (chunk) => this.emit('stderr', chunk.toString('utf8')));
    child.on('error', (error) => this.emit('error', error));
    child.on('exit', (code, signal) => {
      this.emit('disconnect', { code, signal });
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(`JSON-RPC process exited before ${pending.method} completed`));
      }
      this.pending.clear();
      if (this.running) {
        setTimeout(() => this.#launch(), this.reconnectMs);
      }
    });
  }

  #handleLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.emit('error', new Error(`Invalid JSON-RPC line: ${line}`));
      return;
    }

    if (Object.hasOwn(message, 'id') && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(rpcError(message.error));
      else pending.resolve(message.result);
      return;
    }

    if (Object.hasOwn(message, 'id') && message.method) {
      this.emit('serverRequest', message);
      return;
    }

    if (message.method) {
      this.emit('notification', message);
    }
  }

  #write(message) {
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

function rpcError(error) {
  const result = new Error(error?.message || 'JSON-RPC error');
  result.code = error?.code;
  result.data = error?.data;
  return result;
}
