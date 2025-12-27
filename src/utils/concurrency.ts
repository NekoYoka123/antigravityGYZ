
/**
 * A simple concurrency limiter (similar to p-limit)
 * @param concurrency Maximum number of concurrent promises
 * @returns A function that takes a promise-returning function and arguments
 */
export function pLimit(concurrency: number) {
  const queue: (() => void)[] = [];
  let activeCount = 0;

  const next = () => {
    activeCount--;
    if (queue.length > 0) {
      queue.shift()!();
    }
  };

  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    activeCount++;
    const result = await (async () => {
      try {
        return await fn();
      } catch (e) {
        throw e;
      }
    })();
    next();
    return result;
  };

  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const runFn = () => {
        run(fn).then(resolve).catch(reject);
      };

      if (activeCount < concurrency) {
        runFn();
      } else {
        queue.push(runFn);
      }
    });
  };

  return enqueue;
}
