import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { deflateRawSync } from "node:zlib";
import { crc32, readSslZip, validateWithTrust, MAX_SSL_ZIP_BASE64 } from "./ssl-archive.js";

function zip(entries: { name: string; data: string | Buffer; deflate?: boolean; flags?: number; mode?: number }[]) {
  const locals: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), plain = Buffer.from(entry.data), compressed = entry.deflate ? deflateRawSync(plain) : plain;
    const local = Buffer.alloc(30), header = Buffer.alloc(46), method = entry.deflate ? 8 : 0, flags = entry.flags ?? 0;
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(flags,6); local.writeUInt16LE(method,8); local.writeUInt32LE(crc32(plain),14); local.writeUInt32LE(compressed.length,18); local.writeUInt32LE(plain.length,22); local.writeUInt16LE(name.length,26);
    header.writeUInt32LE(0x02014b50); header.writeUInt16LE(flags,8); header.writeUInt16LE(method,10); header.writeUInt32LE(crc32(plain),16); header.writeUInt32LE(compressed.length,20); header.writeUInt32LE(plain.length,24); header.writeUInt16LE(name.length,28); header.writeUInt32LE((entry.mode ?? 0x8000) * 65536,38); header.writeUInt32LE(offset,42);
    locals.push(local,name,compressed); central.push(header,name); offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length,8); end.writeUInt16LE(entries.length,10); end.writeUInt32LE(directory.length,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,directory,end]).toString("base64");
}
let directory: string, root: string, intermediate: string, leaf: string, key: string;
const command = (...args: string[]) => execFileSync("openssl", args, { cwd: directory, stdio: "ignore", timeout: 5000 });
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "ssl-test-"));
  command("req","-x509","-newkey","rsa:2048","-nodes","-keyout","root.key","-out","root.crt","-days","5","-subj","/CN=Offline Test Root","-addext","basicConstraints=critical,CA:TRUE,pathlen:2","-addext","keyUsage=critical,keyCertSign,cRLSign");
  command("req","-new","-newkey","rsa:2048","-nodes","-keyout","intermediate.key","-out","intermediate.csr","-subj","/CN=Offline Intermediate");
  writeFileSync(join(directory,"intermediate.ext"),"basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n");
  command("x509","-req","-in","intermediate.csr","-CA","root.crt","-CAkey","root.key","-CAcreateserial","-out","intermediate.crt","-days","3","-extfile","intermediate.ext");
  command("req","-new","-newkey","rsa:2048","-nodes","-keyout","leaf.key","-out","leaf.csr","-subj","/CN=example.com");
  writeFileSync(join(directory,"leaf.ext"),"basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:example.com,DNS:www.example.com\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n");
  command("x509","-req","-in","leaf.csr","-CA","intermediate.crt","-CAkey","intermediate.key","-CAcreateserial","-out","leaf.crt","-days","2","-extfile","leaf.ext");
  const read = (name: string) => readFileSync(join(directory,name),"utf8"); root = read("root.crt"); intermediate = read("intermediate.crt"); leaf = read("leaf.crt"); key = read("leaf.key");
}, 15000);
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const bundle = (cert = leaf, privateKey = key, ca = intermediate) => zip([{ name:"certificate.crt",data:cert,deflate:true },{ name:"private.key",data:privateKey },{ name:"ca-bundle.crt",data:ca }]);

describe("Bounded SSL ZIP parser", () => {
  it("accepts stored and deflated ZIP entries without filesystem extraction", () => {
    const data = readSslZip(zip([{ name:"folder/a.pem",data:"safe",deflate:true },{ name:"b.pem",data:"also safe" }])); expect(data.map(b=>b.toString())).toEqual(["safe","also safe"]);
  });
  it.each(["../key.pem","/key.pem","folder/../../key.pem","C:\\key.pem","a\0key.pem"])("rejects unsafe path %s", name => expect(()=>readSslZip(zip([{name,data:"safe"}]))).toThrow("Invalid SSL ZIP"));
  it("rejects symlinks, encrypted entries and duplicate names", () => {
    expect(()=>readSslZip(zip([{name:"key.pem",data:"target",mode:0xa000}]))).toThrow();
    expect(()=>readSslZip(zip([{name:"key.pem",data:"target",flags:1}]))).toThrow();
    expect(()=>readSslZip(zip([{name:"same.pem",data:"a"},{name:"same.pem",data:"b"}]))).toThrow();
  });
  it("rejects expansion bombs and excessive encoded input", () => {
    expect(()=>readSslZip(zip([{name:"bomb.pem",data:"A".repeat(128*1024+1),deflate:true}]))).toThrow();
    expect(()=>readSslZip("A".repeat(MAX_SSL_ZIP_BASE64+4))).toThrow();
  });
  it("rejects corrupt checksums and malformed central/local headers", () => {
    const bytes = Buffer.from(zip([{name:"a.pem",data:"abc"}]),"base64"); bytes[35] ^= 1;
    expect(()=>readSslZip(bytes.toString("base64"))).toThrow();
    expect(()=>readSslZip("c2FmZQ==")).toThrow();
  });
});
describe("Certificate and private-key validation", () => {
  it("accepts a matching leaf/key and complete trusted intermediate chain", () => {
    const value = validateWithTrust(bundle(), "example.com", [root]);
    expect(value.summary).toMatchObject({ key_matches:true,domain_matches:true,chain_verified:true,intermediate_count:1,revocation_checked:false });
    expect(value.privateKey).toContain("PRIVATE KEY"); expect(JSON.stringify(value.summary)).not.toContain("PRIVATE KEY");
  });
  it("rejects wrong domain and mismatched key", () => {
    expect(()=>validateWithTrust(bundle(),"other.com",[root])).toThrow("matching");
    expect(()=>validateWithTrust(bundle(leaf,readFileSync(join(directory,"root.key"),"utf8")),"example.com",[root])).toThrow("matching");
  });
  it("rejects expired certificates and incomplete or untrusted chains", () => {
    expect(()=>validateWithTrust(bundle(),"example.com",[root],Date.now()+4*86400000)).toThrow("expired");
    expect(()=>validateWithTrust(bundle(leaf,key,""),"example.com",[root])).toThrow("chain");
    expect(()=>validateWithTrust(bundle(),"example.com",[])).toThrow("chain");
  });
  it("rejects multiple private keys without echoing key contents", () => {
    const value = zip([{name:"site.pem",data:leaf+intermediate+key+key}]);
    expect(()=>validateWithTrust(value,"example.com",[root])).toThrow("exactly one");
  });
  it("rejects encrypted private keys and unsupported PEM types", () => {
    command("pkey","-in","leaf.key","-aes-256-cbc","-passout","pass:offline-test","-out","encrypted.key");
    expect(()=>validateWithTrust(bundle(leaf,readFileSync(join(directory,"encrypted.key"),"utf8")),"example.com",[root])).toThrow("Invalid SSL ZIP");
    expect(()=>validateWithTrust(bundle()+"\n","example.com",[root])).toThrow("Invalid SSL ZIP");
  });
  it("enforces CA path constraints rather than only checking signatures", () => {
    command("req","-new","-key","root.key","-out","root.csr","-subj","/CN=Offline Test Root");
    writeFileSync(join(directory,"root-zero.ext"),"basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n");
    command("x509","-req","-in","root.csr","-signkey","root.key","-out","constrained-root.crt","-days","5","-extfile","root-zero.ext");
    // Same root public key and valid signatures, but the root prohibits an intermediate.
    expect(()=>validateWithTrust(bundle(),"example.com",[readFileSync(join(directory,"constrained-root.crt"),"utf8")])).toThrow("TLS server validation");
  });
});
