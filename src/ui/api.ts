import { useEffect, useState } from 'react';
import type { ErrorCode } from '../core/errors.ts';
import { TOKEN_HASH, TOKEN_HEADER, TOKEN_META, type ProgressEvent, type StateView } from '../server/api.ts';
import { ApiError } from './errors.ts';

export { ApiError, errorText } from './errors.ts';

// The server's key for this start: behind # in the address the page was opened at, kept for this tab
// (a reload has no # any more) and taken out of the address bar; under Vite in development in the page.
function readToken(): string {
  const fromPage = document.querySelector<HTMLMetaElement>(`meta[name="${TOKEN_META}"]`)?.content;
  if (fromPage) return fromPage;
  const fromAddress = new URLSearchParams(location.hash.slice(1)).get(TOKEN_HASH);
  try {
    if (fromAddress) sessionStorage.setItem(TOKEN_HASH, fromAddress);
    else return sessionStorage.getItem(TOKEN_HASH) ?? '';
  } catch {
    // no storage: only this load has the key
  }
  if (fromAddress) history.replaceState(null, '', location.pathname + location.search);
  return fromAddress ?? '';
}
const token = readToken();

async function answer<T>(res: Response): Promise<T> {
  const data = (await res.json()) as T & { error?: string; code?: ErrorCode; params?: unknown };
  if (!res.ok) throw new ApiError({ message: data?.error ?? res.statusText, code: data?.code, params: data?.params });
  return data;
}

export async function get<T>(path: string): Promise<T> {
  return answer<T>(await fetch(path, { headers: { [TOKEN_HEADER]: token } }));
}

export async function post<T = void>(path: string, body: unknown = {}): Promise<T> {
  return answer<T>(await fetch(path, { method: 'POST', headers: { [TOKEN_HEADER]: token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
}

// An address the browser loads itself (a picture, a download), so the key goes into it.
export const tokenUrl = (path: string) => `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;

// A file as the request body, e.g. a firmware file chosen on the flash page.
export async function postFile<T>(path: string, file: File): Promise<T> {
  return answer<T>(await fetch(path, { method: 'POST', headers: { [TOKEN_HEADER]: token, 'Content-Type': 'application/octet-stream' }, body: file }));
}

// A server started anew has a new key and turns this page away: load it again, at most every 10 s.
// Opened without the key (an address copied without the part behind #), a reload brings none either.
function reloadPage(): void {
  if (!token) return;
  try {
    if (Date.now() - Number(sessionStorage.getItem('reloadedAt') ?? 0) < 10_000) return;
    sessionStorage.setItem('reloadedAt', String(Date.now()));
  } catch {
    // no storage: reload all the same
  }
  location.reload();
}

// Live state and progress from the server (Server-Sent Events).
export function useServer(): { state?: StateView; progress?: ProgressEvent; connected: boolean } {
  const [state, setState] = useState<StateView>();
  const [progress, setProgress] = useState<ProgressEvent>();
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    es.addEventListener('state', (e) => {
      const next = JSON.parse((e as MessageEvent).data) as StateView;
      setState(next);
      if (!next.busy) setProgress(undefined);
    });
    es.addEventListener('progress', (e) => setProgress(JSON.parse((e as MessageEvent).data) as ProgressEvent));
    es.onopen = () => setConnected(true);
    es.onerror = () => {
      setConnected(false);
      // closed for good means the server answered with an error; a server that is down is tried again
      if (es.readyState === EventSource.CLOSED) reloadPage();
    };
    return () => es.close();
  }, []);
  return { state, progress, connected };
}
