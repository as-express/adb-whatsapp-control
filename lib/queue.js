export class SerialQueue {
  #chain = Promise.resolve();
  #pending = 0;
  #running = false;

  get stats() {
    return { pending: this.#pending, running: this.#running };
  }

  add(task) {
    this.#pending++;
    const result = this.#chain.then(async () => {
      this.#pending--;
      this.#running = true;
      try {
        return await task();
      } finally {
        this.#running = false;
      }
    });
    this.#chain = result.catch(() => {});
    return result;
  }
}
