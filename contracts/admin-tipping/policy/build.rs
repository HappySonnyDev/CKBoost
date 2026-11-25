use std::{env, fs, path::PathBuf};
fn main() {
    println!("cargo:rerun-if-env-changed=CKBOOST_ADMIN_REGISTRY_TYPE_HASH");
    let pin = env::var("CKBOOST_ADMIN_REGISTRY_TYPE_HASH")
        .ok()
        .map(|raw| {
            let raw = raw.strip_prefix("0x").unwrap_or(&raw);
            assert_eq!(raw.len(), 64, "Registry anchor must be exactly32bytes");
            let bytes: Vec<u8> = (0..64)
                .step_by(2)
                .map(|i| u8::from_str_radix(&raw[i..i + 2], 16).expect("Registry anchor hex"))
                .collect();
            assert!(
                bytes.iter().any(|b| *b != 0),
                "Registry anchor cannot be zero"
            );
            bytes
        });
    let source = match pin {
        Some(bytes) => format!(
            "pub const REGISTRY_TYPE_HASH:Option<[u8;32]>=Some({:?});",
            bytes
        ),
        None => "pub const REGISTRY_TYPE_HASH:Option<[u8;32]>=None;".into(),
    };
    fs::write(
        PathBuf::from(env::var("OUT_DIR").unwrap()).join("registry_anchor.rs"),
        source,
    )
    .unwrap();
}
