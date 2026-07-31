---
'@agentoctopus/sandbox-vm-native': patch
---

fix(sandbox-vm-native): import 32-byte Ed25519 seed via PKCS8 DER wrap

`deriveEd25519FromSeed` built an OKP JWK carrying only `d` (no `x`), which
Node rejects with `ERR_CRYPTO_INVALID_JWK` ("Invalid JWK OKP key") — so a CI
secret stored as the documented base64 32-byte seed could never sign a
release manifest. The seed is now wrapped in a PKCS8 DER structure
(RFC 5208: `SEQUENCE { version, AlgorithmIdentifier(id-Ed25519),
OCTET STRING { OCTET STRING { seed } } }`), byte-identical to a canonical
PKCS8 export. PKCS8 PEM/DER secret forms are unaffected. Regression-tested
by spawning `--print-public` for both forms of the same keypair.
