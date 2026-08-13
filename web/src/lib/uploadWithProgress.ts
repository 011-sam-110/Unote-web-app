// Upload a FormData body and report how much of it has actually gone out.
//
// XHR rather than fetch, for one reason: fetch still has no upload progress. `ReadableStream`
// request bodies would give it, but they require HTTP/2, a duplex flag Safari does not
// implement, and they break the multipart encoding multer expects. XHR's `upload.onprogress`
// is the boring option that works everywhere the app runs.
//
// This deliberately does NOT go through lib/api.ts's `http()`. That wrapper's job is choosing
// between the server and the local mirror, and this is only ever used on the branch that has
// already decided to talk to the server. Callers MUST keep that decision outside: offline and
// guest uploads still belong to `api.uploadImage`, which stages the bytes in IndexedDB.

export interface UploadProgress {
  /** Bytes confirmed sent. */
  loaded: number;
  /** Total bytes, or 0 when the browser cannot compute it. */
  total: number;
  /** 0-100, or undefined when the length is not computable and a number would be invented. */
  percent?: number;
}

export class UploadError extends Error {
  // Declared and assigned rather than a constructor parameter property: the web workspace
  // compiles with `erasableSyntaxOnly`, which rejects the shorthand.
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'UploadError';
    this.status = status;
  }
}

/**
 * POST `form` to `path`, calling `onProgress` as the bytes leave.
 *
 * Resolves with the parsed JSON body. Rejects with an `UploadError` carrying the status, so
 * a 413 can be reported as "too large" rather than as a generic failure.
 */
export function uploadWithProgress<T>(
  path: string,
  form: FormData,
  onProgress?: (p: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path, true);
    // Same-origin, so the session cookie rides along by default. Set explicitly because the
    // desktop shell loads the app from a file:// origin in some builds, where it does not.
    xhr.withCredentials = true;

    xhr.upload.onprogress = (e) => {
      if (!onProgress) return;
      onProgress({
        loaded: e.loaded,
        total: e.total,
        percent: e.lengthComputable && e.total > 0 ? Math.round((e.loaded / e.total) * 100) : undefined,
      });
    };

    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // A non-JSON body on a 2xx is a proxy or a dev-server error page, not a result.
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as T);
        return;
      }
      const message =
        (body && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string'
          ? (body as { error: string }).error
          : null) ?? `Upload failed (${xhr.status})`;
      reject(new UploadError(message, xhr.status));
    };

    // A transport failure carries no status: DNS, TLS, a dropped connection. Reported as 0 so
    // callers can tell it apart from a server that answered with a refusal.
    xhr.onerror = () => reject(new UploadError('Upload failed - check your connection', 0));
    xhr.onabort = () => reject(new UploadError('Upload cancelled', 0));
    xhr.ontimeout = () => reject(new UploadError('Upload timed out', 0));

    if (signal) {
      if (signal.aborted) {
        xhr.abort();
        return;
      }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }

    xhr.send(form);
  });
}
