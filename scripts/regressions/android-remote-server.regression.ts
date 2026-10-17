import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The Android app can open a remote Marinara server instead of the local Termux one. The WebView
// can't run in CI, so this checks the source: remote mode must stay HTTPS-only, must skip the
// local-secret handshake, and must not widen what the WebView or native bridge trusts.
const source = readFileSync(
  new URL("../../android/app/src/main/java/com/marinara/engine/MainActivity.java", import.meta.url),
  "utf8",
);
const networkConfig = readFileSync(
  new URL("../../android/app/src/main/res/xml/network_security_config.xml", import.meta.url),
  "utf8",
);

function methodBody(signature: string): string {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `MainActivity must define ${signature}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}" && --depth === 0) return source.slice(open, index + 1);
  }
  throw new Error(`Unterminated method ${signature}`);
}

assert.match(
  source,
  /SERVER_URL = BuildConfig\.MARINARA_SERVER_URL;/u,
  "local mode must keep the build-time loopback URL",
);

const domains = [...networkConfig.matchAll(/<domain[^>]*>([^<]+)<\/domain>/gu)].map((match) => match[1]!.trim());
assert.deepEqual(domains.sort(), ["127.0.0.1", "localhost"], "cleartext must stay limited to the local server");
assert.doesNotMatch(networkConfig, /<base-config[^>]*cleartextTrafficPermitted="true"/u);

const normalize = methodBody("static String normalizeRemoteServerUrl(String input)");
assert.match(normalize, /"https"\.equalsIgnoreCase\(uri\.getScheme\(\)\)/u, "remote servers must use https");
assert.match(normalize, /getRawUserInfo\(\) != null/u, "remote addresses must not carry credentials");
assert.match(normalize, /return "https:\/\/" \+ host/u, "the stored remote server must be a bare https origin");

const tryConnect = methodBody("private void tryConnect()");
const remoteBranch = tryConnect.indexOf("connectRemoteServer(remoteServer)");
const localHandshake = tryConnect.indexOf("prepareAndroidSession()");
assert.ok(
  remoteBranch >= 0 && remoteBranch < localHandshake,
  "remote mode must branch off before the local-secret handshake",
);

const connectRemote = methodBody("private void connectRemoteServer(String origin)");
assert.doesNotMatch(
  connectRemote,
  /prepareAndroidSession|getOrCreateAndroidSecret|android-auth|postUrl|SERVER_URL/u,
  "remote mode must never send the local secret or its proofs to another server",
);

const isServerUrl = methodBody("private boolean isServerUrl(String url)");
assert.match(isServerUrl, /Uri\.parse\(serverUrl\(\)\)/u, "the WebView must trust only the configured origin");

const sslError = methodBody("public void onReceivedSslError(");
assert.match(sslError, /sslHandler\.cancel\(\);/u, "certificate errors must cancel the load");
assert.doesNotMatch(source, /\.proceed\(\)/u, "the WebView must never proceed past a certificate error");

console.log("Android remote server regression passed.");
