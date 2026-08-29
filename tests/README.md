# Tests

Recovery tests for the C-Gate connection layer, run with the Node built-in test
runner. `npm test` compiles `src` and `tests` together to `build-tests/` and runs
everything in `build-tests/tests/`.

## Why these use real sockets

Every bug these tests exist to catch is a socket lifecycle bug:

- an EventEmitter `'error'` with no listener, which Node rethrows at the process
  and which killed the child bridge outright;
- a socket that had already been replaced emitting a late `'close'` and starting
  a second, parallel reconnect chain;
- a port that is up at the TCP level but unusable at the protocol level.

A mocked transport reproduces none of those, so `FakeCGate` is a real TCP server
on all three ports. It is slower — the suite takes about 30 seconds, most of it
waiting out the genuine 2s reconnect backoff — and that is the trade being made
deliberately.

## The helpers

`helpers/fake-cgate.ts` — a C-Gate server that speaks enough of the protocol to
drive the plugin: the `201` greeting, `PROJECT USE`/`START`, `GET <addr> level`,
`DBGETXML`, and `NOOP`. Ports are allocated once and kept for the object's
lifetime, so `stop()` and `start()` simulate C-Gate going away and returning at
the same address. `dropConnections()` is the milder case: connections die but the
server keeps listening, as a C-Gate restart would look. Set `projectLoads: false`
to make the handshake fail while the socket stays up.

`helpers/fake-homebridge.ts` — the small part of the Homebridge API the platform
touches, backed by the genuine `hap-nodejs` `Service` and `Characteristic`
classes. Stubs would accept anything and let a broken resync pass, so the tests
assert on real characteristic values. `writeTempConfig()` gives each test a
throwaway `config.json`, because discovery appends newly found groups to it.

## Verifying a test is load-bearing

These tests were written against a known-bad revision first. To re-check that a
test still fails without the fix:

    git checkout <pre-fix-ref> -- src/
    npm test          # expect failures
    git checkout HEAD -- src/

Tests that reference APIs the fix introduced (`CGateClient.tryGetLevel`,
`CGateConnection.reset`) will not compile against the older tree; the
`platform recovery` suite uses only the public platform surface and does.

## Note on `test/` vs `tests/`

`test/hbConfig` is an unrelated Homebridge config directory used by `npm run
watch`. It is not part of this suite.
