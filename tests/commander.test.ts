import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { describe, it } from 'node:test';

import { CGateClient } from '../src/cgate/CGateClient.js';
import { HttpCommander } from '../src/commander/HttpCommander.js';
import type { CGateConfig } from '../src/cgate/types.js';
import { DEFAULT_XML, FakeCGate, delay } from './helpers/fake-cgate.js';
import { createFakeLog } from './helpers/fake-homebridge.js';

function configFor(server: FakeCGate, project = 'TESTPROJ'): CGateConfig {
  return {
    host: '127.0.0.1',
    commandPort: server.commandPort,
    eventPort: server.eventPort,
    scpPort: server.scpPort,
    project,
    network: 254,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 15_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await delay(25);
  }
}

/** A port nothing is listening on, so the commander can be started on a known one. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/**
 * Runs body against a live commander backed by a live fake C-Gate, then tears
 * both down. Real HTTP and real sockets throughout: the point of these tests is
 * the wiring between the two, which a stubbed client would not exercise.
 */
async function withCommander(
  options: { xml?: string; projectLoads?: boolean; project?: string },
  body: (base: string, client: CGateClient) => Promise<void>,
): Promise<void> {
  const server = await FakeCGate.create({
    xml: options.xml,
    projectLoads: options.projectLoads ?? true,
  });
  const client = new CGateClient(configFor(server, options.project), createFakeLog());
  const port = await freePort();
  const commander = new HttpCommander(port, client, createFakeLog());

  try {
    commander.start();
    client.connect();
    if (options.projectLoads ?? true) {
      await waitFor(() => client.ready, 15_000, 'client ready');
    }
    await body(`http://127.0.0.1:${port}`, client);
  } finally {
    commander.stop();
    client.disconnect();
    await server.stop();
  }
}

describe('HttpCommander tag database download', () => {
  it('serves the project tag database as an XML attachment', async () => {
    await withCommander({ xml: DEFAULT_XML }, async (base) => {
      const res = await fetch(`${base}/tag/download`);

      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /application\/xml/);
      assert.equal(res.headers.get('content-disposition'), 'attachment; filename="TESTPROJ.xml"');

      const body = await res.text();
      // The whole database, reassembled from C-Gate's 347- continuation lines.
      assert.ok(body.includes('<TagName>Kitchen</TagName>'), body.slice(0, 200));
      assert.ok(body.includes('<TagName>Hallway</TagName>'), body.slice(0, 200));
    });
  });

  it('reports an empty database as a 502 rather than saving an empty file', async () => {
    // C-Gate answering DBGETXML with nothing means the project is not loaded.
    // Handing the browser a 0-byte "backup" would look like success.
    await withCommander({ xml: '' }, async (base) => {
      const res = await fetch(`${base}/tag/download`);
      assert.equal(res.status, 502);
      const body = await res.json() as { status: string; error: string };
      assert.equal(body.status, 'error');
      assert.match(body.error, /TESTPROJ/);
    });
  });

  it('answers 503 while C-Gate is unreachable', async () => {
    await withCommander({ xml: DEFAULT_XML, projectLoads: false }, async (base, client) => {
      assert.equal(client.ready, false);
      const res = await fetch(`${base}/tag/download`);
      assert.equal(res.status, 503);
    });
  });

  it('tells the console which project it is and whether C-Gate is up', async () => {
    await withCommander({ xml: DEFAULT_XML }, async (base) => {
      const res = await fetch(`${base}/tag`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { status: 'ok', project: 'TESTPROJ', ready: true });
    });
  });

  it('does not let a project name write its own response headers', async () => {
    // The name comes from the user's config, not the network, but it lands in
    // Content-Disposition — so a quote or a newline in it must not survive.
    await withCommander({ xml: DEFAULT_XML, project: 'BAD"\r\nX-Injected: yes' }, async (base) => {
      const res = await fetch(`${base}/tag/download`);
      assert.equal(res.status, 200);
      // The hyphen is in the allowed set and survives; the quote and the CRLF
      // that would have started a header do not.
      assert.equal(res.headers.get('content-disposition'), 'attachment; filename="BADX-Injectedyes.xml"');
      assert.equal(res.headers.get('x-injected'), null);
    });
  });
});
