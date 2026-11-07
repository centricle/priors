/**
 * fetch with a per-request timeout and a short retry on the failures that
 * are usually transient: a network error, a 5xx, a 429. A 404 or any other
 * 4xx returns at once, because retrying "not there" only delays the answer.
 * Backoff 1 s, 2 s, 4 s. Throws on a network error that outlasts the tries;
 * returns the final Response otherwise, whatever its status.
 */
export async function fetchRetry(url, { tries = 3, timeout = 5000, log = () => {}, ...init } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
      if (res.status < 500 && res.status !== 429) return res;
      lastError = new Error(`HTTP ${res.status}`);
      if (attempt === tries) return res;
    } catch (err) {
      lastError = err;
      if (attempt === tries) throw err;
    }
    const wait = 1000 * 2 ** (attempt - 1);
    log(`${url}: ${lastError.message}; retry ${attempt} of ${tries - 1} in ${wait / 1000}s`);
    await new Promise((r) => setTimeout(r, wait));
  }
  throw lastError;
}
