# Diagnosing Discord 10062 / slow REST — notes for a large-bot operator

Written for a bot on OVH seeing 10062 as its leading error, with message sends
("verses") eventually succeeding but taking astronomically long.

---

## RESOLVED — root cause was connection pool exhaustion

**disnake sits on `aiohttp`, where gateway WebSockets and REST requests share a
single `TCPConnector` with a default `limit=100`.** At 99 shards, 99 slots were
permanently held open as event sockets, leaving **one** connection for every
REST call the bot made. All REST traffic serialized through it.

Every symptom follows from that:

| symptom | explanation |
|---|---|
| "massive delays talking to the API" | all REST calls queued behind 1 connection |
| verses slow but eventually succeed | message sends have no deadline — they wait in the queue and land late |
| interactions fail as 10062 | the defer waits in that same queue and blows the hard 3s cutoff |
| backend looks fine | backend uses a separate client and pool |
| no Discord outage | Discord was never involved |
| **"nothing's changed for us"** | **shard count scales with guild count; the pool limit is a constant** |

That last row is the whole mystery. At 90 shards there were 10 REST slots —
degraded but survivable. At 99, one. It's a cliff, not a slope, and you cross it
by *growing*, with no code change and nothing to correlate against.

**Generalized lesson:** any fixed-size connection pool with an unbounded wait,
sitting in the ack path, produces this exact signature. Check whether your
gateway/event connections and your REST connections share a pool, and whether
that pool's ceiling was chosen before your current shard count existed.

The diagnostic path that leads here is the third row of the interpretation
table below — *age on arrival low, loop lag low, defer duration high → REST
layer: rate-limit queue, connection pool, DNS*. The network investigation
(mtr/iperf3/OVH escalation) would have come back clean, because the network was
clean.

---

## Before tomorrow morning: iperf3 won't work here

Three problems with it, in increasing order of importance:

1. **There's no iperf3 daemon on the other end.** iperf3 needs a cooperating
   server. Discord doesn't run one. You can't point it at the API or the
   gateway — you'd end up testing against some unrelated public iperf3 host,
   which measures a completely different network path than the one that's
   failing.

2. **Throughput is the wrong metric.** A defer is a ~200-byte POST. Verse
   sends are a few KB. Bandwidth is irrelevant — this is a latency, RTT, and
   connection-setup problem. You could have 10Gbit and still miss a 3s window.

3. **It doesn't discriminate.** Even a perfect result wouldn't tell you whether
   the delay is in your process or on the wire, which is the actual open
   question.

What to run instead is below.

---

## The one test that settles it

Run this **from the bot host, while the bot is exhibiting the problem**:

```bash
# uncached, real origin round-trip, 10 samples
for i in $(seq 1 10); do
  curl -s -o /dev/null \
    -H "Authorization: Bot $TOKEN" \
    -w "dns=%{time_namelookup} connect=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total} code=%{http_code}\n" \
    https://discord.com/api/v10/users/@me
done
```

Then compare against what your bot process is experiencing at that same moment:

| curl from host | bot process | verdict |
|---|---|---|
| fast | slow | **It's the process.** Event loop, REST queue, or connection pool. Not the network. Don't call OVH. |
| slow | slow | **It's the host or the network.** Now the OVH escalation is justified — and you'll have numbers. |

This is decisive and takes two minutes. Everything else below is refinement.

**Two cautions on benchmarking Discord:**

- **Send the auth header.** Unauthenticated requests return 401, and 401/403/429
  responses count toward Discord's invalid-request limit — 10,000 in 10 minutes
  gets your IP Cloudflare-banned for about an hour. Benchmarking with a bare
  `curl` in a loop is a genuinely effective way to cause the exact outage you're
  investigating.
- **Don't benchmark `/api/v10/gateway`.** It's edge-cached (`cf-cache-status:
  HIT`), so you'd be timing Cloudflare's PoP rather than a real round trip to
  Discord. On my host the difference is ~72ms cached vs ~90ms uncached.

---

## Healthy baseline for comparison

My bot, DigitalOcean NYC3, measured just now. Much smaller (~460 servers), so
treat this as a *network* reference, not a load reference:

```
mtr -r -c 20 -n discord.com
  1..4  DigitalOcean internal      0.0% loss   0.3-0.7ms
  5.    146.190.180.11            35.0% loss   avg 3.5ms   <- see note
  6.    162.158.61.103             0.0% loss   avg 2.4ms
  7.    162.159.137.232            0.0% loss   avg 1.0ms   <- Cloudflare edge

curl timing:  dns=0.0016  connect=0.0031  tls=0.057  ttfb=0.090  total=0.090
cf-ray: ...-EWR   (Newark PoP, 1ms away)
```

**Note on that 35% loss at hop 5:** it's an artifact, not a fault. Intermediate
routers rate-limit ICMP TTL-expired replies, so they under-report. The tell is
that hops 6 and 7 show 0.0% — real loss propagates to every subsequent hop.
Worth knowing before you take an mtr to OVH support, because **the only loss
figure that means anything is the one on the final hop.** Leading with a
mid-path number is the fastest way to get a ticket closed as "no fault found."

Things to compare on your side:

- **`connect=`** — TCP RTT to the Cloudflare edge. Mine is 3ms. If yours is
  tens of ms, you're being routed to a distant PoP.
- **`cf-ray` suffix** — your PoP code. `curl -sI https://discord.com/api/v10/gateway | grep cf-ray`.
  An OVH box in Gravelines should land on a nearby European PoP. If it's
  crossing an ocean, that's your bottleneck and it's a routing/peering issue.
- **`tls=` minus `connect=`** — handshake cost. Mine is ~54ms. Inflation here
  points at packet loss during the handshake.

---

## Why "verses are slow too" doesn't yet rule out the process

It's tempting to read "message sends are also slow, so it must be the network."
But a blocked event loop produces *identical* symptoms: every outbound call
waits, whether it's a defer or a message send, and your backend still looks
fast because backend timings are measured inside the same jammed loop's
`await` boundaries.

That's also why the interaction side fails harder — message sends have no
deadline and eventually land ("astronomically long" but successful), while
interactions get a hard 3-second cutoff and simply die as 10062. **Same
underlying delay, different failure surface.** The fact that verses complete and
interactions don't is fully consistent with *either* cause, so it isn't
evidence for the network.

The curl-vs-process comparison above splits this. The instrumentation below
splits it further.

---

## Where the 3 seconds actually goes

```
[Discord mints interaction]     <- t0, stamped into the interaction's snowflake
     |  (A) gateway WebSocket delivers INTERACTION_CREATE
[event arrives in your process]
     |  (B) your event loop gets around to running the handler
[handler's first line runs]
     |  (C) HTTP POST /interactions/{id}/{token}/callback
[Discord accepts]               <- must be < t0 + 3000ms
```

"Gateway" (A) and "API" (C) are different systems. If A is the problem,
deferring earlier in your code changes nothing — the budget was gone before you
ran. If C is the problem, it's the REST queue or the wire.

And **B inflates A's apparent value**: a jammed loop leaves the event sitting in
the queue, which looks exactly like late delivery. So arrival age alone can't
assign blame — you need a lag probe on an independent timer.

### Instrumentation

`interaction.createdTimestamp` comes from the snowflake Discord stamped at t0
using **Discord's** clock. Language-neutral: `t0 = (id >> 22) + 1420070400000`.

```js
// top of the interaction handler, before any await
const age = Date.now() - interaction.createdTimestamp;   // budget already burned
const d0  = Date.now();
await interaction.deferReply();
const deferMs = Date.now() - d0;

if (age > 750 || deferMs > 750) {
  console.warn(`[ack] age=${age}ms defer=${deferMs}ms total=${age + deferMs}ms ` +
               `cmd=${interaction.commandName} shard=${interaction.guild?.shardId ?? '-'} ` +
               `wsPing=${Math.round(interaction.client.ws.ping)}ms`);
}
```

```js
// runs independently of any interaction — this is what assigns blame
import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';

const h = monitorEventLoopDelay({ resolution: 20 });
h.enable();
setInterval(() => {
  const p99 = h.percentile(99) / 1e6, max = h.max / 1e6;
  if (max > 500) console.warn(`[loop] p99=${p99.toFixed(0)}ms max=${max.toFixed(0)}ms ` +
                              `rss=${(process.memoryUsage().rss / 1e6).toFixed(0)}MB`);
  h.reset();
}, 30_000);

new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    if (e.duration > 250) console.warn(`[gc] ${e.detail?.kind} ${e.duration.toFixed(0)}ms`);
  }
}).observe({ entryTypes: ['gc'] });
```

`monitorEventLoopDelay` samples on a libuv timer, so unlike a `setInterval`
self-check it keeps recording accurately *while* the loop is jammed.

### Reading it

| age on arrival | loop lag | defer duration | verdict |
|---|---|---|---|
| high | high | — | Your process. GC or sync CPU. Not the network. |
| high | low | — | Genuinely upstream — gateway delivery. Reshard, or escalate with numbers. |
| low | low | high | REST layer: rate-limit queue, connection pool, DNS. |
| low | low | low | Ack is fine; 10062s are stale components, not new failures. |

---

## On "nothing's changed for us"

Nothing changed in the code, but at your scale several things change without a
deploy — which is what makes this shape so confusing:

1. **Heap growth → GC cliff.** Guild/channel/member caches scale with server
   count. Major GC crosses from ~100ms to multi-second once the heap passes a
   threshold. Sporadic multi-second stalls, healthy network, no outage, no
   deploy. The GC observer above confirms or kills this within an hour.

2. **Shard count is fixed at deploy; guild count isn't.** Events per shard have
   been creeping up since you last set it. Same code, more load per loop.

3. **Passive message scanning.** If you regex-scan message content for verse
   references, that's synchronous CPU on the same loop that owes Discord an ack
   inside 3 seconds — and it scales with message volume, not server count.

4. **OVH-specific, and the reason your instinct may be right:**
   - OVH's **VAC anti-DDoS scrubbing** can engage on an IP without notice and
     add latency or drop traffic. It's automatic, so "nothing changed" from your
     side is exactly how it presents. Ask support directly whether mitigation
     has been active on that IP.
   - **OVH↔Cloudflare peering** has a history of congestion on some paths.
     Discord's API is entirely behind Cloudflare (`162.159.x.x`), so you're at
     the mercy of that specific peering relationship.
   - A **PoP routing change** would show up in your `cf-ray` suffix and your
     `connect=` time without anything on your side changing.

5. **Host clock drift.** Doesn't cause 10062 on its own, but NTP drift is
   gradual ("nothing changed") and it *corrupts the age measurement above*.
   Rule it out first: `timedatectl` / `chronyc tracking`.

### What OVH support will actually act on

Not "it's slow." Give them:
- `mtr -r -c 100 -n 162.159.137.232` — **final-hop** loss and latency, both
  directions if you can get a reverse path.
- Timestamps of specific slow requests, with the `cf-ray` header from each.
- Your `connect=` times vs. a reference (mine: 3ms to EWR from DO NYC3).
- A direct question about VAC mitigation history on the IP.

---

## The structural fix, regardless of what you find

Make the defer unconditional and first — before *any* awaited I/O, including
preference lookups, permission checks, and config reads. Anything awaited ahead
of the ack sequences the ack behind something that can stall, and average
latency won't protect you: the 3s window is a tail-latency problem, and the tail
is where pool checkouts, DNS, and cold connections live.

This is a real latent bug in my own bot, at 1/20,000th the scale:
`/setversion` does two awaited Postgres round-trips before `interaction.reply()`,
against a pool with no connection or query timeout. Fine until the DB stalls,
then 10062. Same shape as yours.
