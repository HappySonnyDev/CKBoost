Synthetic offline fixtures from the actual dApp Admin Registry v1 encoder and existing ProtocolData Molecule encoder. No user data, private keys, network reads or chain writes. Rust tests compare their exact bytes to independent encoders.

Regenerate after installing the project's normal frozen dApp dependencies:

```sh
node contracts/admin-registry/tests/fixtures/generate-frontend-fixtures.cjs
```

These fixtures are never actual chain evidence or a deployment manifest.
