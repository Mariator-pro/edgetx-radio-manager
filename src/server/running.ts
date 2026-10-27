import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// The browser interface's server takes a free port and notes it here, so a second start opens the
// running one instead of starting another server on the same SD card. The note holds the address the
// interface opens at, with the key, so only this user may read it.

interface Note {
  url: string;
  pid: number;
}

async function readNote(file: string): Promise<Note | undefined> {
  try {
    const note = JSON.parse(await readFile(file, 'utf8')) as Partial<Note>;
    return typeof note.url === 'string' && typeof note.pid === 'number' ? (note as Note) : undefined;
  } catch {
    return undefined;
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists, it just isn't ours to signal
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

// The address of a server that still runs; a note left by a server that was killed is ignored.
export async function runningServer(file: string): Promise<string | undefined> {
  const note = await readNote(file);
  if (!note || !alive(note.pid)) return undefined;
  // the process id may have gone to another program since: only a server that answers counts
  const res = await fetch(note.url, { signal: AbortSignal.timeout(2000) }).catch(() => undefined);
  return res?.ok ? note.url : undefined;
}

// Notes this process's server; the returned function removes the note again, unless another server wrote it since.
export async function noteServer(file: string, url: string): Promise<() => Promise<void>> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ url, pid: process.pid } satisfies Note)}\n`, { mode: 0o600 });
  // a note left from before keeps its own mode
  await chmod(file, 0o600);
  return async () => {
    if ((await readNote(file))?.pid === process.pid) await rm(file, { force: true });
  };
}
