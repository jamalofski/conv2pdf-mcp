// The conv2pdf API, as the tools need it: convert files, download the result, read the quota.
import { openAsBlob } from 'node:fs';
import path from 'node:path';

export const DEFAULT_BASE_URL = 'https://api.conv2pdf.com/v1';

// conv2pdf gives a conversion 90 seconds; the rest of the time is the transfer of a file
// of up to 200 MB, both ways, on the user's connection. A backstop: the MCP client has
// its own timeout and cancels the request first.
const REQUEST_TIMEOUT_MS = 5 * 60_000;

// The API answers 429 `rate_limited` and 503 `server_busy` with a Retry-After header:
// no conversion was counted, so both are safe to retry. A tool call must not hang for
// minutes though: beyond these bounds the error goes back to the model, with the delay.
const MAX_RETRIES = 2;
const MAX_WAIT_SECONDS = 30;
const DEFAULT_RETRY_AFTER_SECONDS = 30;

/** A response of the API that is not a success: HTTP status, JSON body, seconds to wait. */
export class ApiError extends Error {
  constructor(status, body, retryAfter) {
    super(`conv2pdf answered HTTP ${status}`);
    this.status = status;
    this.body = body;
    this.code = typeof body.error === 'string' ? body.error : undefined;
    this.retryAfter = retryAfter;
  }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

async function jsonOf(response) {
  try {
    const body = await response.json();
    return body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {};
  } catch {
    // Not JSON: an HTML error page from a proxy, for example.
    return {};
  }
}

function retryAfterSeconds(response, body) {
  const seconds = Number(response.headers.get('retry-after') ?? body.retry_after);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : DEFAULT_RETRY_AFTER_SECONDS;
}

/**
 *   apiKey: the conv2pdf API key
 *   baseUrl: the API root, changed only by the tests
 *   userAgent: `conv2pdf-mcp/<version>`
 */
export function createClient({ apiKey, baseUrl = DEFAULT_BASE_URL, userAgent, wait = sleep }) {
  // `makeBody` builds the body again for each attempt: a sent body cannot be sent twice.
  async function request(method, pathname, { makeBody, signal } = {}) {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(`${baseUrl}${pathname}`, {
        method,
        headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': userAgent },
        body: makeBody ? await makeBody() : undefined,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) return response;
      const body = await jsonOf(response);
      const retryAfter = retryAfterSeconds(response, body);
      const retryable =
        (response.status === 429 && body.error === 'rate_limited') ||
        (response.status === 503 && body.error === 'server_busy');
      if (!retryable || attempt >= MAX_RETRIES || retryAfter > MAX_WAIT_SECONDS) {
        throw new ApiError(response.status, body, retryable ? retryAfter : undefined);
      }
      await wait(retryAfter * 1000, signal);
    }
  }

  return {
    /**
     * Sends the files to a tool. Resolves to the job of the API (`job_id`, `size_bytes`,
     * `quota`) and to the response that streams the result.
     */
    async convert(tool, files, fields, { signal } = {}) {
      const makeBody = async () => {
        const form = new FormData();
        // File-backed blobs: a 200 MB file is streamed, never held in memory.
        for (const file of files) form.append('file', await openAsBlob(file), path.basename(file));
        for (const [name, value] of Object.entries(fields)) form.append(name, String(value));
        return form;
      };
      const converted = await request('POST', `/convert/${tool}`, { makeBody, signal });
      const job = await jsonOf(converted);
      const download = await request('GET', `/download/${encodeURIComponent(job.job_id)}`, { signal });
      return { job, download };
    },

    /** Deletes the files of a job from conv2pdf. Best effort: they expire after one hour anyway. */
    async deleteJob(jobId) {
      try {
        await request('DELETE', `/job/${encodeURIComponent(jobId)}`);
      } catch {
        // Nothing to report: the result is already on disk.
      }
    },

    async quota({ signal } = {}) {
      return jsonOf(await request('GET', '/quota', { signal }));
    },
  };
}
