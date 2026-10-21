'use strict';

const { PlatformRevisionConflictError } = require('./platform-repository');

function clone(value) {
  return structuredClone(value);
}

class PlatformStateStore {
  constructor(repository) {
    if (!repository || typeof repository.load !== 'function' || typeof repository.save !== 'function') {
      throw new TypeError('PlatformStateStore requires a PlatformRepository-compatible object.');
    }
    this.repository = repository;
    this.current = null;
    this.writeQueue = Promise.resolve();
  }

  async initialize(fallbackSnapshot = null, changedBy = 'platform-bootstrap') {
    const loaded = await this.repository.load();
    if (loaded) {
      this.current = loaded;
      return this.readState();
    }
    if (!fallbackSnapshot) throw new Error('Platform repository is empty and no bootstrap snapshot was supplied.');
    try {
      await this.repository.save(clone(fallbackSnapshot), { expectedRevision: 0, changedBy });
    } catch (error) {
      // Another process may have won the first-write race. Never overwrite it.
      if (!(error instanceof PlatformRevisionConflictError)) throw error;
    }
    this.current = await this.repository.load();
    if (!this.current) throw new Error('Platform repository initialization did not produce a committed revision.');
    return this.readState();
  }

  assertInitialized() {
    if (!this.current) throw new Error('PlatformStateStore must be initialized before use.');
  }

  read() {
    this.assertInitialized();
    return clone(this.current.snapshot);
  }

  readState() {
    this.assertInitialized();
    return clone(this.current);
  }

  async refresh() {
    const loaded = await this.repository.load();
    if (!loaded) throw new Error('Platform repository disappeared during refresh.');
    this.current = loaded;
    return this.readState();
  }

  update(mutator, { changedBy = 'platform-server' } = {}) {
    if (typeof mutator !== 'function') return Promise.reject(new TypeError('Platform update requires a mutation function.'));
    const run = async () => {
      this.assertInitialized();
      const draft = clone(this.current.snapshot);
      const replacement = await mutator(draft);
      const next = replacement === undefined ? draft : replacement;
      try {
        const saved = await this.repository.save(next, {
          expectedRevision: this.current.revision,
          changedBy
        });
        this.current = { ...saved, snapshot: clone(next) };
        return this.readState();
      } catch (error) {
        if (error instanceof PlatformRevisionConflictError) await this.refresh();
        throw error;
      }
    };
    const pending = this.writeQueue.then(run, run);
    this.writeQueue = pending.catch(() => {});
    return pending;
  }
}

module.exports = { PlatformStateStore };
