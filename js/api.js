/**
 * The single door to the server. Every screen goes through here so that CSRF
 * tokens, the `{ ok, data }` envelope and error handling exist in one place.
 */

import { state } from './state.js';

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details || null;
    /** Field-level messages from a 422, keyed by field name. */
    this.fields = details?.fields || null;
  }

  get isConflict() {
    return this.status === 409;
  }
  get isLocked() {
    return this.status === 423;
  }
  get isForbidden() {
    return this.status === 403;
  }
  get isUnauthorised() {
    return this.status === 401;
  }
  get isValidation() {
    return this.status === 422;
  }
}

/** Listeners for cross-cutting responses (session lost, portal closed). */
const listeners = { unauthorised: [], locked: [] };

export function on(event, handler) {
  if (listeners[event]) listeners[event].push(handler);
}

function emit(event, payload) {
  for (const handler of listeners[event] || []) {
    try {
      handler(payload);
    } catch (err) {
      console.error(err);
    }
  }
}

async function request(method, path, { body, query, signal, raw = false } = {}) {
  const url = new URL(path, window.location.origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }

  const headers = {};
  if (body !== undefined && !(body instanceof FormData)) {
    headers['content-type'] = 'application/json';
  }
  if (state.csrfToken && method !== 'GET') {
    headers['x-csrf-token'] = state.csrfToken;
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      credentials: 'same-origin',
      signal,
      body:
        body === undefined
          ? undefined
          : body instanceof FormData
            ? body
            : JSON.stringify(body),
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    // On a LAN this nearly always means the server PC went to sleep or the Wi-Fi
    // dropped, so say that rather than "Failed to fetch".
    throw new ApiError(
      0,
      'OFFLINE',
      'Cannot reach the school server. Check that the office PC is on and you are connected to the school network.'
    );
  }

  if (raw) {
    if (!response.ok) {
      const payload = await safeJson(response);
      throw toError(response, payload);
    }
    return response;
  }

  const payload = await safeJson(response);

  if (!response.ok || payload?.ok === false) {
    const error = toError(response, payload);
    if (error.isUnauthorised) emit('unauthorised', error);
    if (error.isLocked) emit('locked', error);
    throw error;
  }

  return payload.data;
}

async function safeJson(response) {
  const type = response.headers.get('content-type') || '';
  if (!type.includes('application/json')) return null;
  try {
    return await response.json();
  } catch (err) {
    return null;
  }
}

function toError(response, payload) {
  const error = payload?.error;
  return new ApiError(
    response.status,
    error?.code || 'SERVER_ERROR',
    error?.message ||
      'Something went wrong and the server did not explain why. Tell the administrator what you were doing.',
    error?.details
  );
}

export const api = {
  get: (path, query, options) => request('GET', path, { query, ...options }),
  post: (path, body, options) => request('POST', path, { body: body ?? {}, ...options }),
  put: (path, body, options) => request('PUT', path, { body: body ?? {}, ...options }),
  del: (path, options) => request('DELETE', path, options),

  /** Multipart upload. The browser sets the boundary, so no content-type here. */
  upload: (path, formData) => request('POST', path, { body: formData }),

  /**
   * Triggers a file download through the authorising route. Never links to a file
   * path directly, because documents are not served statically.
   */
  async download(path, query, fallbackName = 'download') {
    const url = new URL(path, window.location.origin);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue;
        url.searchParams.set(key, String(value));
      }
    }
    const response = await request('GET', url.pathname + url.search, { raw: true });
    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') || '';
    const match = disposition.match(/filename="?([^"]+)"?/);
    const name = match ? match[1] : fallbackName;

    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Give the browser a moment to start the download before revoking.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
    return name;
  },
};
