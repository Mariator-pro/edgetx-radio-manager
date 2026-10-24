import { useEffect, useState } from 'react';
import type { ErrorCode } from '../core/errors.ts';
import { TOKEN_HEADER, TOKEN_META, type ProgressEvent, type StateView } from '../server/api.ts';
import { ApiError } from './errors.ts';

export { ApiError, errorText } from './errors.ts';

// The server's key for this start, which it put into the page.
const token = () => document.querySelector<HTMLMetaElement>(`meta[name="${TOKEN_META}"]`)?.content ?? '';

async function answer<T>(res: Response): Promise<T> {
  const data = (await res.json()) as T & { error?: string; code?: ErrorCode; params?: unknown };
  if (!res.ok) throw new ApiError({ message: data?.error ?? res.statusText, code: data?.code, params: data?.params });
  return data;
}

export async function get<T>(path: string): Promise<T> {
  return answer<T>(await fetch(path, { headers: { [TOKEN_HEADER]: token() } }));
}

export async function post<T = void>(path: string, body: unknown = {}): Promise<T> {
  return answer<T>(await fetch(path, { method: 'POST', headers: { [TOKEN_HEADER]: token(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
}

// A file as the request body, e.g. a firmware file chosen on the flash page.
export async function postFile<T>(path: string, file: File): Promise<T> {
  return answer<T>(await fetch(path, { method: 'POST', headers: { [TOKEN_HEADER]: token(), 'Content-Type': 'application/octet-stream' }, body: file }));
}

// A server started anew has a new key and turns this page away: load it again, at most every 10 s.
function reloadPage(): void {
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
    const es = new EventSource(`/api/events?token=${encodeURIComponent(token())}`);
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
