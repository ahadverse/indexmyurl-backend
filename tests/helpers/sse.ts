export interface SseEvent {
  /** ms since `t0` at which the event reached the client */
  at: number;
  [key: string]: any;
}

/**
 * Read a Server-Sent Events response as it arrives and return its `data:` frames
 * (parsed), each stamped with its arrival time. `until` can stop reading early, which
 * cancels the stream like a client closing the page.
 */
export async function readSseEvents(
  res: Response,
  t0: number = Date.now(),
  until?: (events: SseEvent[]) => boolean
): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (frame.startsWith('data: ')) events.push({ ...JSON.parse(frame.slice(6)), at: Date.now() - t0 });
    }
    if (until?.(events)) {
      await reader.cancel();
      break;
    }
  }
  return events;
}
