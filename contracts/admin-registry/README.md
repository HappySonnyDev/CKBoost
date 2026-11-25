# Admin Registry v1

This is an independently buildable candidate contract. It does not replace any
existing CKBoost contract, regenerate the legacy Molecule code, deploy a cell,
or activate a protocol. Its default library feature is a pure `no_std + alloc`
decoder usable by other contracts.

## Identity and authorization

The Registry **state** uses exactly the same full custom script for both its
type and lock. Script arguments are `type_id[32] || protocol_type_hash[32]`.
On creation the type invocation verifies the personalized CKB BLAKE2b hash of
the transaction's first serialized `CellInput` and output index (`u64` LE), and
requires revision zero. A newly created output lock does not run; using the
native TYPE_ID type plus only a Registry lock is not this construction and does
not provide this creation authorization.

Updates require exactly one matching type input and output, unchanged full
type/lock scripts and protocol binding, and revision `previous + 1` without
overflow. Destruction, duplicate outputs and a replacement state type fail.
There is no destruction or emergency bypass branch.

Authority is read from exactly one existing protocol input **or** CellDep whose
full type-script hash equals the argument's protocol hash. An output protocol
cannot grant authority to the same transaction. Ambiguous matching sources and
malformed current ProtocolData fail closed. A current protocol Admin must have
an empty-data, untyped input and spend strictly more capacity across **all**
inputs with that lock than the corresponding outputs, including typed cells.
The actor's actual lock must also execute successfully. An ACP unsigned deposit
is therefore insufficient even though the real ACP lock accepts that deposit.

Consumers must additionally pin the intended Registry's **full state type
script/hash**, code-cell type script and code data hash. This contract cannot
make an arbitrary caller-provided Registry into the intended protocol Registry.
The separate code cell should have a fresh TYPE_ID and an explicitly reviewed
owner lock. Updating code under that code TYPE_ID requires its owner wallet's
signature; a state Admin role does not authorize spending the code cell. No
owner signature, new code identity or state outpoint is fabricated here.

## Binary format and public codec

All integers are unsigned little endian. The format matches the actual
`dapp/lib/revamp/admin-registry-model.ts` encoder byte for byte.

| Field | Size and validation |
| --- | --- |
| magic | 8 bytes, `CKBADMIN` |
| version | `u32`, exactly 1 |
| protocol type hash | 32 bytes, nonzero |
| revision | `u64`; creation 0, updates +1 |
| tip expiration seconds | `u64`, at most 3650 days; 0 supported |
| threshold count and values | `u32` count <=32; `u128` values positive, strictly increasing |
| approver count and values | `u32` count <=512; nonzero unique 32-byte lock hashes |
| metadata length and bytes | `u32` exact length, no trailing bytes |

Total encoded size is at most 131072 bytes. The metadata tail is deliberately
bounded opaque bytes in this contract. It cannot override the binary tip
financial fields or grant script authority. The frontend validates canonical
JSON `{attestations, periods}`, including manual-verification and reward-period
rules. Those JSON rules are **not** claimed as on-chain payout enforcement.

Manual attestations and periods live in this new Registry. There is no old
ProtocolData/UserData schema migration, historical-data rewrite or automatic
period import. Adding a Registry does not change existing campaign approvals,
claimable pools or user balances. A future financial consumer must enforce its
own exact configured Registry and payout transition; decoding metadata alone
is not an authorization or payment implementation.

```rust
use ckboost_admin_registry::registry_policy::{decode_registry, validate_transition};
// Pure default library: no CKB syscalls or entry point linked.
let policy = decode_registry(bytes)?;
// policy.protocol_hash, revision, expiration_seconds, thresholds,
// approvers, metadata
```

Other crates can use a path dependency without features. The `onchain` feature
adds the CKB entry implementation, while `vm-tests` adds the host test runner.
`protocol::protocol_admins` checks the existing complete ProtocolData Molecule
shape without copying or editing the legacy generated Rust module.

## Reproduce

Run commands from the repository root. Set `WORK_ROOT` to a directory containing
the toolchain/cache and public ACP assets, and `REPO` to the checkout. A normal
Rust installation can instead supply its usual Cargo and Rustup homes. Pinning
dependencies is provided by this crate's own Cargo.lock; `--offline` is optional
only when initially obtaining the locked dependencies.

```sh
export REPO="$PWD"
export WORK_ROOT="/path/to/working-tools"
export CARGO_HOME="$WORK_ROOT/cargo-home"
export RUSTUP_HOME="$WORK_ROOT/rustup"
node contracts/admin-registry/tests/fixtures/generate-frontend-fixtures.cjs
cargo test --locked --offline --manifest-path contracts/admin-registry/Cargo.toml --test policy

# Install riscv64imac-unknown-none-elf for the selected Rust toolchain first.
# TARGET_CC must accept the RISC-V freestanding C compiler arguments used by
# ckb-std. It is needed to build ckb-std's small assembly/C helpers.
export TARGET_CC="/path/to/riscv-compatible-clang"
RUSTFLAGS='-C target-feature=-a' cargo build --locked --offline \
  --manifest-path contracts/admin-registry/Cargo.toml --features onchain \
  --target riscv64imac-unknown-none-elf --release

export CKBOOST_ADMIN_REGISTRY_BIN="$REPO/contracts/admin-registry/target/riscv64imac-unknown-none-elf/release/ckboost-admin-registry"
export CKBOOST_ACP_ASSET_DIR="$WORK_ROOT/auth-test-assets"
RUSTFLAGS='-C debug-assertions=no' cargo test --locked --offline \
  --manifest-path contracts/admin-registry/Cargo.toml --features vm-tests \
  --test policy --test vm_registry
```

The RISC-V `A` extension must be disabled: its atomic instructions are not part
of this CKB execution target. This is independent of the host-only
`debug-assertions=no` flag used with the existing ckb-testtool dependency. The
release profile strips symbols, uses size optimization/LTO and retains checked
overflow. To preserve an unstripped comparison artifact, build first with
`CARGO_PROFILE_RELEASE_STRIP=none`, copy that ELF separately, then rebuild the
normal release and rerun **all** VM tests against the stripped file.

Use the official asset downloader in
`contracts/auth-tests/scripts/fetch-acp-assets.py` for the actual `anyone_can_pay`
and `secp256k1_data` binaries. Their sources and pinned SHA256/data hashes are
documented in `contracts/auth-tests/README.md`. The tests use a fixed synthetic
private key only inside local VM fixtures; it is never a live wallet.

Current validation is 11 native tests plus 14 real VM test groups. These include
creation/update, exact successor and identity, wrong/ambiguous/output-only
protocol authority, malformed financial fields/Molecule, destruction, and real
ACP deposit versus signed/unsigned capacity spending. Native tests also compare
two binary goldens generated by the actual frontend encoders and exhaust all
truncations of the sample Registry. Golden fixtures are synthetic offline data,
not chain evidence. VM tests run the exact supplied ELF; they do not substitute
a Rust authorization predicate for the contract.

The current candidate and build/test logs are packaged by the local acceptance
workflow outside source. No successful local test constitutes a deployment,
user wallet signature or production migration approval.
