import { useEffect, useState } from 'react';
import type { ErrorCode, ErrorInfo } from '../core/errors.ts';
import type { ProgressEvent, StateView } from '../server/api.ts';
import type { Texts } from './texts.ts';

// A failed request, with the server's error code for translating it.
export class ApiError extends Error {
  info: ErrorInfo;
  constructor(info: ErrorInfo) {
    super(info.message);
    this.info = info;
  }
}

async function answer<T>(res: Response): Promise<T> {
  const data = (await res.json()) as T & { error?: string; code?: ErrorCode; params?: unknown };
  if (!res.ok) throw new ApiError({ message: data?.error ?? res.statusText, code: data?.code, params: data?.params });
  return data;
}

export async function get<T>(path: string): Promise<T> {
  return answer<T>(await fetch(path));
}

export async function post<T = void>(path: string, body: unknown = {}): Promise<T> {
  return answer<T>(await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
}

// The error in the interface language; errors without a known code keep the server's English text.
export function errorText(t: Texts, e: ApiError | ErrorInfo | unknown): string {
  const info: ErrorInfo = e instanceof ApiError ? e.info : e instanceof Error ? { message: e.message } : (e as ErrorInfo);
  const text = info.code && (t.errors[info.code] as ((p: unknown) => string) | undefined);
  return text ? text(info.params) : info.message;
}

// Live state and progress from the server (Server-Sent Events).
export function useServer(): { state?: StateView; progress?: ProgressEvent; connected: boolean } {
  const [state, setState] = useState<StateView>();
  const [progress, setProgress] = useState<ProgressEvent>();
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const es = new EventSource('/api/events');
    es.addEventListener('state', (e) => {
      const next = JSON.parse((e as MessageEvent).data) as StateView;
      setState(next);
      if (!next.busy) setProgress(undefined);
    });
    es.addEventListener('progress', (e) => setProgress(JSON.parse((e as MessageEvent).data) as ProgressEvent));
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, []);
  return { state, progress, connected };
}
