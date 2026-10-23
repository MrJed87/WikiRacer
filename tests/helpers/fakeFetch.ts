import type { FetchLike } from '../../src/wiki/client';

export interface FakeReply {
  status?: number;
  body: unknown;
}

export type Handler = (params: URLSearchParams, url: URL) => FakeReply | Promise<FakeReply>;

/** A `fetch` stand-in that never touches the network. Records every requested URL. */
export function fakeFetch(handler: Handler): FetchLike & { calls: URL[] } {
  const calls: URL[] = [];
  const fn = async (input: string): Promise<Response> => {
    const url = new URL(input);
    calls.push(url);
    const reply = await handler(url.searchParams, url);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return Object.assign(fn, { calls });
}

export const noSleep = (): Promise<void> => Promise.resolve();
