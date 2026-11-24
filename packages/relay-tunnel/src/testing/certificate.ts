// Test-only OpenSSL fixture generation runs before an Effect runtime exists.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export function testCertificate(
  directory: string,
  hostname: string,
  name = hostname,
  alternativeNames: readonly string[] = [],
): { cert: Buffer; key: Buffer; certFile: string; keyFile: string } {
  const certFile = NodePath.join(directory, `${name}.crt`);
  const keyFile = NodePath.join(directory, `${name}.key`);
  NodeChildProcess.execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-days",
      "3",
      "-keyout",
      keyFile,
      "-out",
      certFile,
      "-subj",
      `/CN=${hostname}`,
      "-addext",
      `subjectAltName=${[hostname, ...alternativeNames].map((entry) => "DNS:" + entry).join(",")}`,
    ],
    { stdio: "ignore" },
  );
  return {
    cert: NodeFS.readFileSync(certFile),
    key: NodeFS.readFileSync(keyFile),
    certFile,
    keyFile,
  };
}
