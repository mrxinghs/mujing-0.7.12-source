import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { VALID_PNG } from "./image-fixtures.mjs";

const require = createRequire(import.meta.url);
const providers = require("../desktop/providers.cjs");
const publicConfig = { apiKey: "SECRET_PROVIDER_KEY", baseUrl: "https://api.provider.example/v1", imageModel: "image", videoModel: "video" };

function resolverFor(entries = {}) {
  const calls = [];
  const resolver = async (hostname) => {
    calls.push(hostname);
    const value = entries[hostname];
    if (value instanceof Error) throw value;
    return value || [{ address: "93.184.216.34", family: 4 }];
  };
  resolver.calls = calls;
  return resolver;
}

function mediaResponse(body, init = {}) {
  return new Response(body, { status: init.status || 200, headers: init.headers || { "content-type": "image/png", "content-length": String(body?.length || 0) } });
}

async function withMedia(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mujing-provider-url-security-"));
  try { await run(path.join(directory, "media")); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

async function withApiEnvelope(envelope, run) {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: new Headers(init.headers) });
    return new Response(JSON.stringify(envelope), { status: 200, headers: { "content-type": "application/json" } });
  };
  try { return await run(calls); }
  finally { globalThis.fetch = previous; }
}

test("public providers reject unsafe media URL forms before any connection", async () => {
  const unsafe = [
    "http://127.0.0.1/media",
    "http://localhost/media",
    "http://169.254.169.254/latest/meta-data",
    "http://10.1.2.3/media",
    "http://172.16.1.2/media",
    "http://192.168.1.2/media",
    "http://100.64.1.2/media",
    "http://[::1]/media",
    "http://[fc00::1]/media",
    "http://[::ffff:127.0.0.1]/media",
    "http://[4000::1]/media",
    "http://2130706433/media",
    "http://0x7f000001/media",
    "https://user:password@cdn.example/media",
    "https://cdn.example:8443/media",
    "http://cdn.example:443/media",
    "https://cdn.example:80/media",
    "file:///etc/passwd",
    "data:text/plain,secret",
    "ftp://cdn.example/media",
  ];
  for (const url of unsafe) {
    let connections = 0;
    await assert.rejects(providers.secureMediaFetch(publicConfig, url, {
      resolver: resolverFor({ localhost: [{ address: "127.0.0.1", family: 4 }] }),
      async transport() { connections += 1; return mediaResponse(VALID_PNG); },
    }), /URL|media|address|origin|protocol|port|safe|SSRF|鍦板潃|瀹夊叏/i, url);
    assert.equal(connections, 0, url);
  }
  await assert.rejects(providers.secureMediaFetch(publicConfig, `https://cdn.example/${"a".repeat(9000)}`, {
    resolver: resolverFor(),
    async transport() { assert.fail("overlong URL connected"); },
  }), /length|URL|闀垮害/i);
});

test("public providers reject the full reserved IPv4 240.0.0.0/4 range before transport", async (t) => {
  for (const url of [
    "http://240.0.0.1/media",
    "http://255.255.255.255/media",
    "http://[::ffff:240.0.0.1]/media",
  ]) {
    await t.test(url, async () => {
      let connections = 0;
      await assert.rejects(providers.secureMediaFetch(publicConfig, url, {
        async transport() { connections += 1; return mediaResponse(VALID_PNG); },
      }), /address|safe|unsafe|reserved/i);
      assert.equal(connections, 0, url);
    });
  }
});

test("public providers reject DNS answers in 240.0.0.0/4 before transport", async () => {
  let connections = 0;
  await assert.rejects(providers.secureMediaFetch(publicConfig, "https://cdn.example/media", {
    resolver: resolverFor({ "cdn.example": [{ address: "240.0.0.2", family: 4 }] }),
    async transport() { connections += 1; return mediaResponse(VALID_PNG); },
  }), /address|safe|unsafe|reserved/i);
  assert.equal(connections, 0);
});

test("public redirects into 240.0.0.0/4 are rejected before the reserved hop transport", async () => {
  let publicConnections = 0;
  let reservedConnections = 0;
  await assert.rejects(providers.secureMediaFetch(publicConfig, "https://cdn.example/start", {
    resolver: resolverFor({ "cdn.example": [{ address: "93.184.216.34", family: 4 }] }),
    async transport({ address }) {
      if (address === "240.0.0.3") {
        reservedConnections += 1;
        return mediaResponse(VALID_PNG);
      }
      publicConnections += 1;
      return mediaResponse(null, { status: 302, headers: { location: "http://240.0.0.3/media" } });
    },
  }), /address|safe|unsafe|reserved/i);
  assert.equal(publicConnections, 1);
  assert.equal(reservedConnections, 0);
});

test("IPv4 boundary classification still blocks adjacent multicast and allows public addresses", async () => {
  let multicastConnections = 0;
  await assert.rejects(providers.secureMediaFetch(publicConfig, "http://239.255.255.255/media", {
    async transport() { multicastConnections += 1; return mediaResponse(VALID_PNG); },
  }), /address|safe|unsafe|reserved/i);
  assert.equal(multicastConnections, 0);

  let publicConnections = 0;
  const response = await providers.secureMediaFetch(publicConfig, "http://223.255.255.254/media", {
    async transport({ address }) {
      publicConnections += 1;
      assert.equal(address, "223.255.255.254");
      return mediaResponse(VALID_PNG);
    },
  });
  assert.equal(response.ok, true);
  assert.equal(publicConnections, 1);
});

test("public redirect to a private address is blocked before the private hop", async () => {
  let connections = 0;
  const response = await assert.rejects(providers.secureMediaFetch(publicConfig, "https://cdn.example/start", {
    resolver: resolverFor({ "cdn.example": [{ address: "93.184.216.34", family: 4 }] }),
    async transport() {
      connections += 1;
      return mediaResponse(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } });
    },
  }));
  void response;
  assert.equal(connections, 1);
});

test("DNS failure and any mixed unsafe answer fail closed with zero connections", async () => {
  for (const resolver of [
    resolverFor({ "cdn.example": Object.assign(new Error("DNS unavailable"), { code: "EAI_AGAIN" }) }),
    resolverFor({ "cdn.example": [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.8", family: 4 }] }),
  ]) {
    let connections = 0;
    await assert.rejects(providers.secureMediaFetch(publicConfig, "https://cdn.example/media", {
      resolver,
      async transport() { connections += 1; return mediaResponse(VALID_PNG); },
    }), /DNS|address|safe|resolve|瀹夊叏|瑙ｆ瀽/i);
    assert.equal(connections, 0);
  }
});

test("the connection lookup is pinned to the one validated public IP", async () => {
  let resolution = 0;
  const resolver = async (hostname) => {
    resolver.calls.push(hostname);
    resolution += 1;
    return resolution === 1
      ? [{ address: "93.184.216.34", family: 4 }]
      : [{ address: "10.0.0.9", family: 4 }];
  };
  resolver.calls = [];
  let pinned;
  await providers.secureMediaFetch(publicConfig, "https://cdn.example/media", {
    resolver,
    async transport(options) {
      assert.equal(options.address, "93.184.216.34");
      assert.equal(new Headers(options.headers).get("host"), "cdn.example");
      pinned = await new Promise((resolve, reject) => options.lookup("cdn.example", {}, (error, address, family) => error ? reject(error) : resolve({ address, family })));
      return mediaResponse(VALID_PNG);
    },
  });
  assert.deepEqual(pinned, { address: "93.184.216.34", family: 4 });
  assert.deepEqual(resolver.calls, ["cdn.example"]);
});

test("cross-origin redirects rebuild only safe media headers", async () => {
  const calls = [];
  const response = await providers.secureMediaFetch(publicConfig, "https://cdn-a.example/start", {
    resolver: resolverFor({
      "cdn-a.example": [{ address: "93.184.216.34", family: 4 }],
      "cdn-b.example": [{ address: "1.1.1.1", family: 4 }],
    }),
    async transport(options) {
      calls.push(options);
      if (calls.length === 1) return mediaResponse(null, { status: 302, headers: { location: "https://cdn-b.example/final" } });
      return mediaResponse(VALID_PNG);
    },
  });
  assert.equal(response.ok, true);
  assert.deepEqual(calls.map((call) => new Headers(call.headers).get("host")), ["cdn-a.example", "cdn-b.example"]);
  for (const call of calls) {
    const headers = new Headers(call.headers);
    assert.equal(headers.has("authorization"), false);
    assert.equal(headers.has("cookie"), false);
    assert.doesNotMatch(JSON.stringify(Object.fromEntries(headers)), /SECRET_PROVIDER_KEY/);
  }
});

test("createImage accepts a validated public CDN and sends no provider secrets", async () => {
  await withMedia(async (mediaDir) => withApiEnvelope({ data: [{ url: "https://cdn.example/generated.png" }] }, async (apiCalls) => {
    const mediaCalls = [];
    const result = await providers.createImage(publicConfig, { provider: "Seedream", prompt: "test", ratio: "16:9" }, mediaDir, undefined, {
      resolver: resolverFor({ "cdn.example": [{ address: "93.184.216.34", family: 4 }] }),
      async transport(options) { mediaCalls.push(options); return mediaResponse(VALID_PNG); },
    });
    assert.deepEqual(await readFile(path.join(mediaDir, result.filename)), VALID_PNG);
    assert.equal(apiCalls[0].headers.get("authorization"), `Bearer ${publicConfig.apiKey}`);
    assert.equal(mediaCalls.length, 1);
    const mediaHeaders = new Headers(mediaCalls[0].headers);
    assert.equal(mediaHeaders.has("authorization"), false);
    assert.equal(mediaHeaders.has("cookie"), false);
    assert.doesNotMatch(JSON.stringify(Object.fromEntries(mediaHeaders)), /SECRET_PROVIDER_KEY/);
  }));
});

test("an explicitly private provider may download only from its exact origin", async () => {
  const privateConfig = { ...publicConfig, baseUrl: "http://127.0.0.1:43123/v1" };
  let connections = 0;
  await providers.secureMediaFetch(privateConfig, "http://127.0.0.1:43123/media", {
    async transport(options) { connections += 1; assert.equal(options.address, "127.0.0.1"); return mediaResponse(VALID_PNG); },
  });
  assert.equal(connections, 1);
  for (const url of ["http://127.0.0.1:43124/media", "http://localhost:43123/media", "http://10.0.0.1:43123/media"]) {
    await assert.rejects(providers.secureMediaFetch(privateConfig, url, {
      async transport() { connections += 1; return mediaResponse(VALID_PNG); },
    }), /origin|same|鍚屾簮/i);
  }
  assert.equal(connections, 1);
});

test("media redirects are manual, revalidated, and limited to five", async () => {
  let connections = 0;
  await assert.rejects(providers.secureMediaFetch(publicConfig, "https://cdn.example/0", {
    resolver: resolverFor({ "cdn.example": [{ address: "93.184.216.34", family: 4 }] }),
    async transport({ url }) {
      connections += 1;
      const index = Number(url.pathname.slice(1));
      return mediaResponse(null, { status: 302, headers: { location: `https://cdn.example/${index + 1}` } });
    },
  }), /redirect|5|閲嶅畾鍚?/i);
  assert.equal(connections, 6);
});

test("Seedance video polling blocks a private returned URL without a media connection", async () => {
  await withMedia(async (mediaDir) => withApiEnvelope({ id: "job-1", status: "succeeded", content: { video_url: "http://127.0.0.1/private.mp4" } }, async () => {
    let mediaConnections = 0;
    await assert.rejects(providers.pollVideoTask(publicConfig, { provider: "Seedance", jobId: "job-1" }, mediaDir, undefined, {
      async transport() { mediaConnections += 1; return mediaResponse(Buffer.from("not a video")); },
    }), /address|safe|SSRF|瀹夊叏/i);
    assert.equal(mediaConnections, 0);
  }));
});
