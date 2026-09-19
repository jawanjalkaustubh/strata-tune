import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';
import type { LoadRun } from '../src/collector-types';
import { CollectorClient } from '../electron/collector';

/**
 * POST /load/{id}/cancel (plan section 17c) as the client drives it, against a fake collector
 * that mirrors LoadRunner.TryCancel: a running run is marked cancelled and answered, a run
 * that has ended is 409, an unknown id 404. The real client polls load() to completion, so
 * a cancel must make that pending call resolve as cancelled, never throw.
 */
const TOKEN = 'test-token';

interface Fake {
  server: http.Server;
  port: number;
  runs: Map<string, LoadRun>;
  requests: string[];
}

function fakeCollector(): Promise<Fake> {
  const runs = new Map<string, LoadRun>();
  const requests: string[] = [];
  let next = 1;
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: 'unauthorised' });
    const url = req.url ?? '';
    if (req.method === 'POST' && url === '/load') {
      const id = `run${next++}`;
      const run: LoadRun = { id, kind: 'heavy', seconds: 20, state: 'running', exitCode: null, qpcStart: 1, qpcEnd: null, gpuSamples: [], cpuSamples: [], fillRate: null, error: null };
      runs.set(id, run);
      return json(200, run);
    }
    const cancel = /^\/load\/([^/]+)\/cancel$/.exec(url);
    if (req.method === 'POST' && cancel) {
      const run = runs.get(cancel[1]);
      if (!run) return json(404, { error: 'no such load run' });
      if (run.state !== 'running') return json(409, { error: `load run ${run.id} is not running` });
      run.state = 'cancelled';
      run.exitCode = -1;
      run.qpcEnd = 2;
      return json(200, run);
    }
    const get = /^\/load\/([^/]+)$/.exec(url);
    if (req.method === 'GET' && get) {
      const run = runs.get(get[1]);
      return run ? json(200, run) : json(404, { error: 'no such load run' });
    }
    json(404, { error: 'no route' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port, runs, requests })));
}

/** A client adopted onto the fake without the elevation dance: the handshake and the connected state are what request() needs. */
function client(port: number): CollectorClient {
  const c = new CollectorClient();
  Object.assign(c, { handshake: { port, token: TOKEN, pid: process.pid, startedAt: new Date().toISOString() } });
  c.state = { status: 'connected', message: 'fake' };
  return c;
}

const tick = (ms = 50) => new Promise<void>((r) => setTimeout(r, ms));

describe('load run cancel over the wire', () => {
  let fake: Fake;
  beforeAll(async () => {
    fake = await fakeCollector();
  });
  afterAll(() => fake.server.close());

  it('cancelLoad ends the run load() is polling: the pending load() resolves as cancelled, with no error and the cancel sent once', async () => {
    const c = client(fake.port);
    const pending = c.load('heavy', 20);
    await tick();
    expect(await c.cancelLoad()).toBe(true);
    const run = await pending;
    expect(run.state).toBe('cancelled');
    expect(run.error).toBeNull();
    expect(fake.requests.filter((r) => r.endsWith('/cancel'))).toEqual([`POST /load/${run.id}/cancel`]);
    // Idle again: nothing to cancel.
    expect(await c.cancelLoad()).toBe(false);
  });

  it('a run that ended on its own answers 409 to a cancel, which the client reads as nothing cancelled', async () => {
    const c = client(fake.port);
    const pending = c.load('heavy', 20);
    await tick();
    const id = [...fake.runs.keys()].pop()!;
    // The collector finishes it between the client's polls.
    Object.assign(fake.runs.get(id)!, { state: 'done', exitCode: 0, qpcEnd: 3 });
    expect(await c.cancelLoad()).toBe(false);
    expect((await pending).state).toBe('done');
  });

  it('an unknown id is 404 and surfaces as an error, not as a cancelled run', async () => {
    const c = client(fake.port);
    await expect(c.post(`/load/nope/cancel`, undefined)).rejects.toThrow(/404/);
  });
});
