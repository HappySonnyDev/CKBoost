# 金融候选构建输入与复现（2026-11-25）

本说明对应 [release-pins.mjs](release-pins.mjs) / [release-manifest.json](release-manifest.json) 中 `ckboost-admin-tipping-v1-registry-97e23b14`。这些是本地 reviewed ELF 的身份，不是部署回执。本说明不运行构建、不修改生成文件、不签名、不发送或激活协议。

## 指纹的精确范围

Manifest 的 `sourceFingerprintSha256` 为 `c5690d8f5bf06aea6785670003b3f491dcdb4e6691be15ac7578a340cc10864c`，定义是对 **manifest 中逐项列出的** Rust / Cargo / schema `{path,sha256}` 数组排序后，以 JSON 字节计算 SHA256。pins 与派生 manifest 不计入自身，避免循环；这不是整个工作区或全部外部依赖的总体指纹。

其中明确包含 `contracts/libs/ckboost-shared/src/generated/ckboost.rs`，SHA256：

```text
12e7b1b3ec773c1eb570ce205a7fd065258d4d443feaae914d299ee235d99a3d
```

该文件在本轮开始前已有 Molecule 0.9.2 的生成差异（27 added / 27 deleted）。本轮保留既有 dirty，没有 restore HEAD，也不要求把用户原有生成噪声提交到仓库。**干净 checkout 的原始生成文件不等于 release 输入，不能声称 clean HEAD 直接 build 即得到相同 pin。**

2026-11-25 只读实核：安装的 `moleculec --version` 为 `Moleculec 0.9.2`；对当前 schema 输出到 stdout 后的 hash 精确等于上列生成文件，无需复制整个生成文件或覆盖当前目录。

| 输入 | SHA256 |
| --- | --- |
| CKBoost `schemas/ckboost.mol` | `b8efca3984968de6e68a1009c96be46b9e62d53cc24a75c008c3445ac35f96f7` |
| Molecule 0.9.2 生成的 `ckboost.rs` | `12e7b1b3ec773c1eb570ce205a7fd065258d4d443feaae914d299ee235d99a3d` |
| 当时 `git diff -- contracts/libs/ckboost-shared/src/generated/ckboost.rs` 的 stdout | `d34330b6562ece722ac4370637bf86d4901f5d54f02028821573e27dc8985cab` |

最后一项 diff hash 仅用于工作区审计：其比较基准当时 CKBoost HEAD 为 `ca5a6911065a6f75bd175b446744648a5c6bc95b`。以后 HEAD 变化会改变 diff 文本；复现以 schema / generator / 输出文件 hash 为准。

## 外部 path dependency：ckb_deterministic

当前 Cargo path 指向与 CKBoost 并列的 `../ckb_deterministic/ckb_deterministic`，它不是上述 manifest 输入列表的一部分，也不由本 workspace 的 Cargo.lock 锁定源码 commit。复现时必须额外准备这一输入：

| 项目 | 实核值 |
| --- | --- |
| 外部仓库 HEAD | `9d3c3ebbab44dc32c05c2727e68e5530618cb435` |
| tracked / untracked / staged 状态 | 仅 `ckb_deterministic/src/generated/deterministic.rs` 有未暂存修改；没有其它未暂存、已暂存或 untracked 文件 |
| diff 大小 | 6 added / 6 deleted，仅该生成文件 |
| 该 `git diff` stdout SHA256 | `21da3e84d9f97faf6d451afbfa4a90967e5afbfc7075e54c0c6bdbe08cdcc5f6` |
| `schemas/deterministic.mol` SHA256 | `3534abcd22875335920a93e4b3118c5fe2e28eac609dbc98a546b8fe4b051df8` |
| Molecule 0.9.2 生成输出 SHA256 | `fd6de9eaeeab0e0d16e0c5bb5a116779958b78c6327d96ee620c6098f674c3fa` |

上述两个 schema 都已只读运行相同生成命令到 stdout，实核输出 hash 与 dirty 文件一致。没有额外手写外部补丁待归档；这两个确定性生成命令及其 hash 就是该生成差异的 supporting inputs。不要用未知的外部仓库 HEAD 或任意已有 sibling 目录替代。

## 在隔离 staging checkout 准备生成输入

以下命令供复核者在**单独 staging checkout** 执行，不得把 `REPRO_REPO` / `REPRO_DETERMINISTIC` 指到当前用户正在编辑的目录。先准备包含候选源码的 CKBoost checkout，以及上述 commit 的外部依赖 checkout，布局为同一父目录下的 `CKBoost` 和 `ckb_deterministic`。

`moleculec` 是 `moleculec` crate 0.9.2 的 CLI（同包提供 `moleculec-rust` 插件）；需要安装时使用锁定版本，而不是最新版本：`cargo install moleculec --version 0.9.2 --locked`。这里仅记录命令，本次交付未执行安装。

```sh
# 两个变量必须是独立 staging checkout 的绝对路径。
export REPRO_REPO=/path/to/staging/CKBoost
export REPRO_DETERMINISTIC=/path/to/staging/ckb_deterministic
moleculec --version
git -C "$REPRO_DETERMINISTIC" rev-parse HEAD

# 先只读核 schema 和 stdout；应分别匹配上表。
(cd "$REPRO_REPO" && shasum -a 256 schemas/ckboost.mol)
(cd "$REPRO_REPO" && moleculec --language rust --schema-file schemas/ckboost.mol | shasum -a 256)
(cd "$REPRO_DETERMINISTIC" && shasum -a 256 schemas/deterministic.mol)
(cd "$REPRO_DETERMINISTIC" && moleculec --language rust --schema-file schemas/deterministic.mol | shasum -a 256)

# 只有已确认是隔离 staging 后，才把相同 stdout 写入该 staging。
(cd "$REPRO_REPO" && moleculec --language rust --schema-file schemas/ckboost.mol > contracts/libs/ckboost-shared/src/generated/ckboost.rs)
(cd "$REPRO_DETERMINISTIC" && moleculec --language rust --schema-file schemas/deterministic.mol > ckb_deterministic/src/generated/deterministic.rs)
shasum -a 256 "$REPRO_REPO/contracts/libs/ckboost-shared/src/generated/ckboost.rs" "$REPRO_DETERMINISTIC/ckb_deterministic/src/generated/deterministic.rs"
```

现有两个 crate 的 `build.rs` 仍会按相同 CLI 重写各自 staging 生成文件；只设置正确 PATH 与隔离目录，不要通过临时删除 build.rs 或 restore 当前用户文件绕过。

## ELF 构建与测试

工具链固定 Rust/Cargo 1.89.0，目标 `riscv64imac-unknown-none-elf`，现有 `riscv-clang` 包装器使用 Zig 0.14.1 `cc`。包装器把 `--target=riscv64` 改为 `--target=riscv64-freestanding`，把 `-march=…` 改为 `-mcpu=baseline+m+c+zba+zbb+zbc+zbs`，其余参数原样传给 `zig cc`。准备同等交叉编译器，不能误用宿主 C 编译器。

```sh
cd "$REPRO_REPO"
export CC_riscv64imac_unknown_none_elf=/path/to/reviewed-riscv-clang
export CKBOOST_ADMIN_REGISTRY_TYPE_HASH=0x97e23b14d33e0445c1eac09f1948e2c3652547bfbb7fb7db56978f48baff9690

CARGO_PROFILE_RELEASE_DEBUG=false CARGO_PROFILE_RELEASE_STRIP=symbols \
RUSTFLAGS='-C target-feature=+zba,+zbb,+zbc,+zbs,-a' \
cargo build --locked --offline --release \
  --manifest-path contracts/admin-tipping/Cargo.toml \
  --target riscv64imac-unknown-none-elf \
  -p ckboost-tipping-type-qa-candidate \
  -p ckboost-funding-lock-qa-candidate \
  -p ckboost-protocol-lock-qa-candidate --features qa-admin-tipping

export CKBOOST_TIP_CANDIDATE_BIN_DIR="$REPRO_REPO/contracts/admin-tipping/target/riscv64imac-unknown-none-elf/release"
export CKBOOST_AUTH_BIN_DIR=/path/to/reviewed-existing-release
export CKBOOST_UNCHANGED_POINTS_ELF="$CKBOOST_AUTH_BIN_DIR/dependency-public/points-type.elf"
RUSTFLAGS='-C debug-assertions=no' \
cargo test --locked --offline \
  --manifest-path contracts/admin-tipping/Cargo.toml \
  -p ckboost-admin-tipping-policy --features vm-tests \
  --test policy --test vm_finance --test vm_campaign_funding -- --nocapture
```

`CKBOOST_AUTH_BIN_DIR` 必须包含原 reviewed `ckboost-campaign-type`、`dependency-public/points-type.elf`、`dependency-public/claimable-pool.elf`；其字节长度、CKB data hash 和完整 TypeID 在 [Campaign Funding VM](policy/tests/vm_campaign_funding.rs) 中逐项断言。不是任意新编译同名 ELF。离线缓存缺失应先准备锁定依赖，不能删除 `--locked` 来隐式改变版本。

debug 对照构建使用相同输入与锚点，改为 `CARGO_PROFILE_RELEASE_DEBUG=true CARGO_PROFILE_RELEASE_STRIP=none`，另存目录，不能覆盖已复核 stripped 归档。VM 必须指向最后核过 byteLength / CKB data hash / SHA256 的 stripped ELF。

该命令描述已验证的输入与构建设置；**不保证不同宿主系统、依赖缓存、编译器包装器或 checkout 绝对路径下字节完全一致**。`strip=symbols` 不等于删除所有诊断/路径字符串。重新构建如与 pins 不同，先调查差异并重新审阅候选，不改 pins 迎合输出，也不将不同字节用于后续签名。当前 reviewed ELF 的精确身份以 manifest 为准。

本机 supporting evidence：`work/audit/admin-2026-11-25/tipping-candidate/actual-anchor-{build,debug-build,tests}.log` 与 `work/testnet-release/admin-tipping/registry-97e23b14/{stripped,debug}`。这些不一定随 repo 分发；缺失时应明确补齐公开 release 归档，不能推断已有链上部署。
