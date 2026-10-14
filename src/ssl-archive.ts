import { createPrivateKey, X509Certificate } from "node:crypto";
import { rootCertificates } from "node:tls";
import { inflateRawSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MAX_SSL_ZIP_BYTES = 256 * 1024;
export const MAX_SSL_ZIP_BASE64 = Math.ceil(MAX_SSL_ZIP_BYTES / 3) * 4;
const MAX_EXPANDED = 512 * 1024;
const MAX_ENTRY = 128 * 1024;
const invalid = () => new Error("Invalid SSL ZIP. Use a small, unencrypted ZIP containing PEM certificates and exactly one unencrypted private key; no unsafe paths, links or oversized entries.");

export function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}

// Read in memory only. Never extract archive paths or persist private keys.
export function readSslZip(base64: string): Buffer[] {
  const extracted: Buffer[] = [];
  try {
    if (!base64 || base64.length > MAX_SSL_ZIP_BASE64 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw invalid();
    const zip = Buffer.from(base64, "base64");
    if (zip.length < 22 || zip.length > MAX_SSL_ZIP_BYTES || zip.toString("base64") !== base64) throw invalid();
    let end = zip.length - 22;
    while (end >= Math.max(0, zip.length - 65557) && (zip.readUInt32LE(end) !== 0x06054b50 || end + 22 + zip.readUInt16LE(end + 20) !== zip.length)) end--;
    if (end < 0 || zip.readUInt32LE(end) !== 0x06054b50) throw invalid();
    const count = zip.readUInt16LE(end + 10), start = zip.readUInt32LE(end + 16), size = zip.readUInt32LE(end + 12);
    if (zip.readUInt16LE(end + 4) || zip.readUInt16LE(end + 6) || zip.readUInt16LE(end + 8) !== count || count < 1 || count > 32 || start + size !== end) throw invalid();
    let cursor = start, total = 0;
    const names = new Set<string>(), ranges: [number, number][] = [];
    for (let n = 0; n < count; n++) {
      if (cursor + 46 > end || zip.readUInt32LE(cursor) !== 0x02014b50) throw invalid();
      const flags = zip.readUInt16LE(cursor + 8), method = zip.readUInt16LE(cursor + 10), crc = zip.readUInt32LE(cursor + 16);
      const compressed = zip.readUInt32LE(cursor + 20), expanded = zip.readUInt32LE(cursor + 24), nameLen = zip.readUInt16LE(cursor + 28);
      const next = cursor + 46 + nameLen + zip.readUInt16LE(cursor + 30) + zip.readUInt16LE(cursor + 32), offset = zip.readUInt32LE(cursor + 42);
      const mode = (zip.readUInt32LE(cursor + 38) >>> 16) & 0xf000;
      if (next > end || flags & ~0x080e || flags & 1 || ![0, 8].includes(method) || zip.readUInt16LE(cursor + 34) || expanded > MAX_ENTRY || compressed > MAX_SSL_ZIP_BYTES || (total += expanded) > MAX_EXPANDED || ![0, 0x8000, 0x4000].includes(mode)) throw invalid();
      const nameBytes = zip.subarray(cursor + 46, cursor + 46 + nameLen), name = nameBytes.toString("utf8");
      if (!name || name.length > 240 || /[\x00-\x1f\\:]/.test(name) || name.startsWith("/") || name.split("/").some(p => p === ".." || p === ".") || names.has(name)) throw invalid();
      names.add(name);
      if (offset + 30 > start || zip.readUInt32LE(offset) !== 0x04034b50 || zip.readUInt16LE(offset + 6) !== flags || zip.readUInt16LE(offset + 8) !== method) throw invalid();
      const localNameLen = zip.readUInt16LE(offset + 26), dataStart = offset + 30 + localNameLen + zip.readUInt16LE(offset + 28), dataEnd = dataStart + compressed;
      if (dataEnd > start || !zip.subarray(offset + 30, offset + 30 + localNameLen).equals(nameBytes) || ranges.some(([a,b]) => offset < b && dataEnd > a)) throw invalid();
      ranges.push([offset, dataEnd]);
      const data = method === 0 ? Buffer.from(zip.subarray(dataStart, dataEnd)) : inflateRawSync(zip.subarray(dataStart, dataEnd), { maxOutputLength: MAX_ENTRY });
      extracted.push(data);
      if (data.length !== expanded || crc32(data) !== crc || (name.endsWith("/") && expanded)) throw invalid();
      cursor = next;
    }
    if (cursor !== end) throw invalid();
    return extracted;
  } catch {
    for (const buffer of extracted) buffer.fill(0);
    throw invalid();
  }
}

function currentlyValid(cert: X509Certificate, now: number) { return Date.parse(cert.validFrom) <= now && Date.parse(cert.validTo) > now; }
function chainToTrust(cert: X509Certificate, intermediates: X509Certificate[], roots: X509Certificate[], now: number, seen = new Set<string>()): X509Certificate[] | null {
  if (seen.has(cert.fingerprint256) || seen.size > 10) return null;
  const nextSeen = new Set([...seen, cert.fingerprint256]);
  for (const issuer of roots) if (currentlyValid(issuer, now) && cert.issuer === issuer.subject && cert.verify(issuer.publicKey)) return [];
  for (const issuer of intermediates) {
    if (!issuer.ca || !currentlyValid(issuer, now) || cert.issuer !== issuer.subject || !cert.verify(issuer.publicKey)) continue;
    const path = chainToTrust(issuer, intermediates, roots, now, nextSeen);
    if (path) return [issuer, ...path];
  }
  return null;
}

export function validateSslArchive(base64: string, domain: string) {
  return validateWithTrust(base64, domain, rootCertificates);
}

// An explicit trust set is used by offline tests; runtime always uses Node's bundled public roots.
export function validateWithTrust(base64: string, domain: string, trust: readonly string[], now = Date.now()) {
  const buffers = readSslZip(base64);
  try {
    const certs = new Map<string, X509Certificate>();
    const keys: string[] = [];
    for (const buffer of buffers) {
      const text = buffer.toString("utf8");
      if (!buffer.equals(Buffer.from(text)) || text.includes("\0")) throw invalid();
      const blocks = [...text.matchAll(/-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/g)];
      if ((text.match(/-----BEGIN /g)?.length ?? 0) !== blocks.length) throw invalid();
      for (const block of blocks) {
        if (block[1] === "CERTIFICATE") {
          const cert = new X509Certificate(block[0]); certs.set(cert.fingerprint256, cert);
        } else if (block[1] === "CERTIFICATE REQUEST") { /* A CSR is optional and never installed. */ }
        else if (["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY"].includes(block[1]) && !/ENCRYPTED|Proc-Type:|DEK-Info:/.test(block[0])) keys.push(block[0]);
        else throw invalid();
      }
    }
    if (keys.length !== 1 || certs.size > 16) throw invalid();
    const key = createPrivateKey(keys[0]);
    if (!((key.asymmetricKeyType === "rsa" && (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048) || (key.asymmetricKeyType === "ec" && ["prime256v1", "secp384r1", "secp521r1"].includes(key.asymmetricKeyDetails?.namedCurve ?? "")))) throw new Error("Use an RSA key of at least 2048 bits or a supported ECDSA key.");
    const matches = [...certs.values()].filter(c => !c.ca && c.checkPrivateKey(key) && c.checkHost(domain, { subject: "never", partialWildcards: false, multiLabelWildcards: false, singleLabelSubdomains: false }));
    if (matches.length !== 1) throw new Error("The ZIP must contain one certificate matching both the private key and the exact requested domain.");
    const leaf = matches[0];
    if (!currentlyValid(leaf, now)) throw new Error("The certificate is expired or not yet valid.");
    if (leaf.keyUsage && !leaf.keyUsage.includes("1.3.6.1.5.5.7.3.1") && !leaf.keyUsage.includes("2.5.29.37.0")) throw new Error("The certificate does not permit TLS server authentication.");
    const chain = chainToTrust(leaf, [...certs.values()].filter(c => c !== leaf), trust.map(p => new X509Certificate(p)), now);
    if (!chain) throw new Error("The certificate chain does not reach a trusted public CA. Include the correct intermediate CA bundle; self-signed certificates are not accepted.");
    // OpenSSL enforces path length, name constraints, key usage and TLS-server purpose.
    // Only public certificates go to temporary files; no shell and no private key file.
    const folder = mkdtempSync(join(tmpdir(), "pagesurge-ssl-"));
    try {
      const rootsFile = join(folder, "roots.pem"), leafFile = join(folder, "leaf.pem"), chainFile = join(folder, "chain.pem");
      writeFileSync(rootsFile, trust.join("\n"), { mode: 0o600 });
      writeFileSync(leafFile, leaf.toString(), { mode: 0o600 });
      writeFileSync(chainFile, chain.map(c => c.toString()).join("\n"), { mode: 0o600 });
      const verified = spawnSync("openssl", ["verify", "-no-CApath", "-no-CAstore", "-CAfile", rootsFile, "-purpose", "sslserver", "-auth_level", "2", "-verify_hostname", domain, "-attime", String(Math.floor(now / 1000)), ...(chain.length ? ["-untrusted", chainFile] : []), leafFile], { timeout: 5000, maxBuffer: 16384, shell: false });
      if (verified.error) throw new Error("The certificate chain validator is unavailable. Install OpenSSL 3 in the gateway runtime; no SSL installation was attempted.");
      if (verified.status !== 0) throw new Error("The certificate chain failed TLS server validation. No SSL installation was attempted.");
    } finally { rmSync(folder, { recursive: true, force: true }); }
    return { certificate: leaf.toString(), privateKey: keys[0], caBundle: chain.map(c => c.toString()).join("\n"), summary: { fingerprint_sha256: leaf.fingerprint256, valid_from: new Date(leaf.validFrom).toISOString(), expires_at: new Date(leaf.validTo).toISOString(), domain_matches: true, key_matches: true, chain_verified: true, revocation_checked: false, intermediate_count: chain.length } };
  } catch (error) {
    const safe = ["Use an RSA", "The ZIP must", "The certificate is", "The certificate does", "The certificate chain"];
    if (error instanceof Error && safe.some(prefix => error.message.startsWith(prefix))) throw error;
    throw invalid();
  } finally { for (const buffer of buffers) buffer.fill(0); }
}
