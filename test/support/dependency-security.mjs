// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, privateEncrypt, sign, constants } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";

export function checkDependencySecurity(packageDir) {
  const require = createRequire(join(packageDir, "package.json"));
  const forge = require("node-forge");
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = forge.pki.publicKeyFromPem(publicKey.export({ type: "spki", format: "pem" }));
  const message = Buffer.from("OpenKara source dependency security regression");
  const digest = createHash("sha256").update(message).digest("binary");
  assert.equal(key.verify(digest, sign("sha256", message, privateKey).toString("binary")), true);

  const { asn1 } = forge;
  const der = asn1.toDer(asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(forge.pki.oids.sha256).getBytes()),
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, ""),
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, "unconsumed garbage"),
    ]),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, digest),
  ])).getBytes();
  const encoded = Buffer.concat([
    Buffer.from([0, 1]),
    Buffer.alloc(256 - 3 - der.length, 255),
    Buffer.from([0]),
    Buffer.from(der, "binary"),
  ]);
  const signature = privateEncrypt({ key: privateKey, padding: constants.RSA_NO_PADDING }, encoded);
  assert.throws(() => key.verify(digest, signature.toString("binary")), /DigestInfo/);
}
