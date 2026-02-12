class DownloadQueue {
  constructor() {
    this.items = [];
    this.running = false;
  }

  add(task) {
    let resolveTask;
    let rejectTask;

    const promise = new Promise((resolve, reject) => {
      resolveTask = resolve;
      rejectTask = reject;
    });

    const position = this.items.push({
      task,
      resolveTask,
      rejectTask
    });

    this.process().catch((error) => {
      console.error('Erro inesperado na fila:', error);
    });

    return {
      position,
      promise
    };
  }

  async process() {
    if (this.running) {
      return;
    }

    this.running = true;

    while (this.items.length > 0) {
      const current = this.items[0];

      try {
        const result = await current.task();
        current.resolveTask(result);
      } catch (error) {
        current.rejectTask(error);
      } finally {
        this.items.shift();
      }
    }

    this.running = false;
  }

  size() {
    return this.items.length;
  }
}

module.exports = {
  DownloadQueue
};
