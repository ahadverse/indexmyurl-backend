import { Response } from 'express';

export interface SseStream {
  /** Send one event: the client receives `data: <json>`. */
  send(data: unknown): void;
  /** Aborted as soon as the client goes away, so long work can stop. */
  readonly signal: AbortSignal;
  readonly closed: boolean;
  end(): void;
}

/**
 * Open a Server-Sent Events response (fetch() can read it as a stream, which EventSource
 * cannot do for POST). Each event is flushed immediately:
 *  - Cache-Control no-transform keeps the compression middleware from buffering it
 *  - X-Accel-Buffering stops nginx from buffering it
 *  - a comment line every 15 s keeps idle proxies from closing the connection
 */
export function openSse(res: Response): SseStream {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const controller = new AbortController();
  let closed = false;
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, 15_000);

  res.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
    if (!res.writableFinished) controller.abort();
  });

  return {
    signal: controller.signal,
    get closed() {
      return closed;
    },
    send(data: unknown): void {
      if (!closed) res.write(`data: ${JSON.stringify(data)}\n\n`);
    },
    end(): void {
      if (!closed) res.end();
    },
  };
}
