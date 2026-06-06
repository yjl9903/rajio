export interface Queue {
  add<T>(task: () => PromiseLike<T>): Promise<T>;
  done(): Promise<void>;
  clear(): void;
  active(): number;
  size(): number;
}

export function newQueue(concurrency: number): Queue {
  const pending: Array<() => void> = [];
  const doneWaiters: Array<() => void> = [];
  let active = 0;

  function runNext(): void {
    while (active < concurrency && pending.length > 0) {
      pending.shift()?.();
    }
    if (active === 0 && pending.length === 0) {
      for (const resolve of doneWaiters.splice(0)) {
        resolve();
      }
    }
  }

  return {
    add<T>(task: () => PromiseLike<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        pending.push(() => {
          active += 1;
          Promise.resolve()
            .then(task)
            .then(resolve, reject)
            .finally(() => {
              active -= 1;
              runNext();
            });
        });
        runNext();
      });
    },
    done(): Promise<void> {
      if (active === 0 && pending.length === 0) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        doneWaiters.push(resolve);
      });
    },
    clear(): void {
      pending.length = 0;
      runNext();
    },
    active(): number {
      return active;
    },
    size(): number {
      return pending.length;
    }
  };
}
