#![cfg(feature = "vm-tests")]
//! Exact candidate binaries + unchanged, publicly verified fcb4 Points ELF.
//! Wallets are explicit ALWAYS_SUCCESS fixtures, not live signatures/accounts.
use ckb_deterministic::generated::{
    Bytes as RecipeBytes, RecipeArgument, RecipeArgumentVec, TransactionRecipe,
};
use ckb_testtool::{
    builtin::ALWAYS_SUCCESS,
    ckb_types::{
        bytes::Bytes,
        core::{TransactionBuilder, TransactionView},
        packed::*,
        prelude::*,
    },
    context::Context,
};
use ckboost_shared::types as mol;
use molecule::prelude::{Builder, Entity};
const CKB: u64 = 100_000_000;
const NOW: u64 = 1795600000000;
const MAX_CYCLES: u64 = 200_000_000;
const PROTOCOL: &str = "4eacaf9b1a120d2bfd99f26fcedfdcfe6ef116484e9b478b0a104a872316e034";
const LOCK_CODE: &str = "e91b5a78463c293318331c21d372e031eb9ffad87b379fbe0563222fcdd28815";
const POINTS_CODE: &str = "fcb4b762e3222b603771811b8abe6b054a480a0f5d8011fd9fff266d72189a5e";
fn hex(s: &str) -> Vec<u8> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}
fn b32(v: &[u8]) -> mol::Byte32 {
    mol::Byte32::from_slice(v).unwrap()
}
fn u128mol(v: u128) -> mol::Uint128 {
    mol::Uint128::from_slice(&v.to_le_bytes()).unwrap()
}
fn script(code: &[u8], args: &[u8]) -> Script {
    Script::new_builder()
        .code_hash(Byte32::from_slice(code).unwrap())
        .hash_type(1u8.into())
        .args(args.pack())
        .build()
}
fn hash(s: &Script) -> [u8; 32] {
    s.calc_script_hash().unpack()
}
fn connected(id: &[u8], proto: &[u8]) -> Vec<u8> {
    mol::ConnectedTypeID::new_builder()
        .type_id(b32(id))
        .connected_key(b32(proto))
        .build()
        .as_slice()
        .to_vec()
}
fn output(lock: &Script, capacity: u64, typ: Option<&Script>) -> CellOutput {
    CellOutput::new_builder()
        .capacity((capacity * CKB).pack())
        .lock(lock.clone())
        .type_(typ.cloned().pack())
        .build()
}
fn dep(point: OutPoint) -> CellDep {
    CellDep::new_builder()
        .out_point(point)
        .dep_type(0u8.into())
        .build()
}
fn code(context: &mut Context, owner: &Script, bytes: Bytes, args: &[u8]) -> [u8; 32] {
    let typ = script(
        &hex("00000000000000000000000000000000000000000000000000545950455f4944"),
        args,
    );
    let h = hash(&typ);
    context.create_cell(output(owner, 1000000, Some(&typ)), bytes);
    h
}
fn binary(name: &str) -> Bytes {
    std::fs::read(
        std::path::Path::new(
            &std::env::var("CKBOOST_TIP_CANDIDATE_BIN_DIR")
                .expect("test-only candidate binary directory"),
        )
        .join(name),
    )
    .unwrap()
    .into()
}
fn registry(proto: &[u8], approver: &[u8], expiry: u64) -> Vec<u8> {
    let mut data = b"CKBADMIN".to_vec();
    data.extend(1u32.to_le_bytes());
    data.extend(proto);
    data.extend(0u64.to_le_bytes());
    data.extend(expiry.to_le_bytes());
    data.extend(1u32.to_le_bytes());
    data.extend((100u128 * CKB as u128).to_le_bytes());
    data.extend(1u32.to_le_bytes());
    data.extend(approver);
    data.extend(2u32.to_le_bytes());
    data.extend(b"{}");
    data
}
struct Setup {
    context: Context,
    admin: Script,
    organizer: Script,
    approver: Script,
    target: Script,
    foreign: Script,
    tip: Script,
    tip_lock: Script,
    points: Script,
    funding: Script,
    udt: Script,
    protocol_dep: CellDep,
    registry_dep: CellDep,
}
fn setup(revoked: bool, fake_registry: bool, expiry: u64) -> Setup {
    let mut context = Context::default();
    context.set_capture_debug(true);
    let always = context.deploy_cell(ALWAYS_SUCCESS.clone());
    let mut wallet = |id| {
        context
            .build_script(&always, Bytes::from(vec![id]))
            .unwrap()
    };
    let admin = wallet(1);
    let organizer = wallet(2);
    let approver = wallet(3);
    let target = wallet(4);
    let foreign = wallet(5);
    let tip_code = code(
        &mut context,
        &admin,
        binary("ckboost-tipping-type-qa-candidate"),
        &[0x20; 32],
    );
    let funding_code = code(
        &mut context,
        &admin,
        binary("ckboost-funding-lock-qa-candidate"),
        &[0x21; 32],
    );
    let lock = code(
        &mut context,
        &admin,
        binary("ckboost-protocol-lock-qa-candidate"),
        &hex("06661a546d171ae6f280f3f1363070c7d1e7ad7dc1032d566c7b16f804d57ab4"),
    );
    assert_eq!(lock.to_vec(), hex(LOCK_CODE));
    let points_bytes: Bytes = std::fs::read(
        std::env::var("CKBOOST_UNCHANGED_POINTS_ELF").expect("verified unchanged fcb4 Points ELF"),
    )
    .unwrap()
    .into();
    assert_eq!(points_bytes.len(), 138784);
    assert_eq!(
        CellOutput::calc_data_hash(&points_bytes).as_slice(),
        hex("b61c56ff5d0b9d036f0db63d67ec9cf9d8cb62a20d9de1830659b92261bb150b")
    );
    let points_code = code(
        &mut context,
        &admin,
        points_bytes,
        &hex("c9abd34829d90d4eb1dc28b70e7378df447d26b41d17656362b8fabef226caff"),
    );
    assert_eq!(points_code.to_vec(), hex(POINTS_CODE));
    let udt_code = code(&mut context, &admin, ALWAYS_SUCCESS.clone(), &[0x66; 32]);
    let udt = script(&udt_code, &[0x55]);
    let proto = hex(PROTOCOL);
    let protocol_type = script(
        &hex("53769be2ed1d09a9da7c1d71488347449bb76f1212068f7e366939d0d5fd59fa"),
        &hex("53a5053bed009ff6bcfe2762b5c186fdbbffa215cde85868c7becb501f0ef462"),
    );
    assert_eq!(hash(&protocol_type).to_vec(), proto);
    let config = mol::ScriptCodeHashes::new_builder()
        .ckb_boost_protocol_type_code_hash(b32(protocol_type.code_hash().as_slice()))
        .ckb_boost_protocol_lock_code_hash(b32(&lock))
        .ckb_boost_tipping_type_code_hash(b32(&tip_code))
        .ckb_boost_funding_lock_code_hash(b32(&funding_code))
        .ckb_boost_points_udt_type_code_hash(b32(&points_code))
        .accepted_udt_type_scripts(mol::ScriptVec::from(vec![mol::Script::from_slice(
            udt.as_slice(),
        )
        .unwrap()]))
        .build();
    let protocol = mol::ProtocolData::new_builder()
        .protocol_config(
            mol::ProtocolConfig::new_builder()
                .script_code_hashes(config)
                .admin_lock_hash_vec(mol::Byte32Vec::from(vec![
                    b32(&hash(&admin)),
                    b32(&hash(&foreign)),
                ]))
                .build(),
        )
        .endorsers_whitelist(mol::EndorserInfoVec::from(vec![
            mol::EndorserInfo::new_builder()
                .endorser_lock_hash(b32(&hash(&organizer)))
                .build(),
        ]))
        .build();
    let protocol_point = context.create_cell(
        output(&admin, 2000, Some(&protocol_type)),
        protocol.as_bytes(),
    );
    let mut args = hex("980c906dab1f1198e9cb615ac321cb69ac703945c5983de9e4b4c40139ea778c");
    args.extend(&proto);
    let registry_type = script(
        &hex("12a5aa7950a17c8b11d28fdffad7c7cdf699811291437ad87826b422392e39d5"),
        &args,
    );
    assert_eq!(
        hash(&registry_type).to_vec(),
        hex("97e23b14d33e0445c1eac09f1948e2c3652547bfbb7fb7db56978f48baff9690")
    );
    let registry_type = if fake_registry {
        {
            let mut foreign_args = args.clone();
            foreign_args[0] ^= 1;
            script(
                &hex("12a5aa7950a17c8b11d28fdffad7c7cdf699811291437ad87826b422392e39d5"),
                &foreign_args,
            )
        }
    } else {
        registry_type
    };
    let registry_point = context.create_cell(
        output(&registry_type, 2000, Some(&registry_type)),
        registry(
            &proto,
            &hash(if revoked { &foreign } else { &approver }),
            expiry,
        )
        .into(),
    );
    Setup {
        tip: script(&tip_code, &connected(&[0x40; 32], &proto)),
        tip_lock: script(&lock, &connected(&hash(&organizer), &proto)),
        points: script(&points_code, &proto),
        funding: script(&funding_code, &proto),
        udt,
        context,
        admin,
        organizer,
        approver,
        target,
        foreign,
        protocol_dep: dep(protocol_point),
        registry_dep: dep(registry_point),
    }
}
fn tip(s: &Setup, supporters: Vec<&Script>, status: &[u8], granted: u64) -> mol::TippingData {
    mol::TippingData::new_builder()
        .target_lock_hash(b32(&hash(&s.target)))
        .proposer_lock_hash(b32(&hash(&s.organizer)))
        .supporter_lock_hashes(mol::Byte32Vec::from(
            supporters
                .into_iter()
                .map(|h| b32(&hash(h)))
                .collect::<Vec<_>>(),
        ))
        .metadata(
            mol::TippingMetadata::new_builder()
                .contribution_title(mol::String::from(b"QA tip".to_vec()))
                .creation_timestamp(mol::Uint64::from_slice(&(NOW - 1000).to_le_bytes()).unwrap())
                .build(),
        )
        .rewards(
            mol::AssetList::new_builder()
                .ckb_amount(u128mol(100 * CKB as u128))
                .points_amount(u128mol(1))
                .udt_assets(mol::UDTAssetVec::from(vec![mol::UDTAsset::new_builder()
                    .udt_script(mol::Script::from_slice(s.udt.as_slice()).unwrap())
                    .amount(u128mol(5))
                    .build()]))
                .build(),
        )
        .status(mol::String::from(status.to_vec()))
        .granted_at(mol::Uint64::from_slice(&granted.to_le_bytes()).unwrap())
        .build()
}
fn recipe(time: u64, output_index: u32, missing_time: bool) -> Bytes {
    let mut args = vec![RecipeArgument::new_builder()
        .arg_type(2u8)
        .data(RecipeBytes::from(output_index.to_le_bytes().to_vec()))
        .build()];
    if !missing_time {
        args.push(
            RecipeArgument::new_builder()
                .arg_type(0u8)
                .data(RecipeBytes::from(time.to_le_bytes().to_vec()))
                .build(),
        );
    }
    let recipe = TransactionRecipe::new_builder()
        .method_path(RecipeBytes::from(b"CKBoostTipping.update_tipping".to_vec()))
        .arguments(RecipeArgumentVec::from(args))
        .build();
    WitnessArgs::new_builder()
        .output_type(Some(recipe.as_bytes()).pack())
        .build()
        .as_bytes()
}
#[derive(Clone, Copy, Debug)]
enum Change {
    Valid,
    WrongMint,
    RedirectUdt,
    WrongUdtAmount,
    NoNetSpend,
    NonemptyActor,
    MissingTime,
    WrongOutputRef,
    Mutation,
    Expired,
    TipCapacityDrain,
    PoolCapacityDrain,
    CkbWrongRecipient,
    UnacceptedUdt,
    LargeDuplicateUdt,
}
fn grant(s: &mut Setup, change: Change, admin_actor: bool) -> TransactionView {
    let actor = if admin_actor {
        s.foreign.clone()
    } else {
        s.approver.clone()
    };
    let mut current = tip(s, vec![&s.admin], b"approved", 0);
    let mut next = tip(s, vec![&s.admin, &actor], b"granted", NOW);
    if matches!(change, Change::Mutation) {
        next = next
            .as_builder()
            .target_lock_hash(b32(&hash(&s.foreign)))
            .build();
    }
    if matches!(change, Change::UnacceptedUdt | Change::LargeDuplicateUdt) {
        let script = if matches!(change, Change::UnacceptedUdt) {
            s.udt
                .clone()
                .as_builder()
                .args(Bytes::from(vec![0x56]).pack())
                .build()
        } else {
            s.udt.clone()
        };
        let amounts = if matches!(change, Change::LargeDuplicateUdt) {
            vec![1u128 << 64, 5]
        } else {
            vec![5]
        };
        let change_rewards = |data: mol::TippingData| {
            let rewards = data
                .rewards()
                .as_builder()
                .udt_assets(mol::UDTAssetVec::from(
                    amounts
                        .iter()
                        .map(|amount| {
                            mol::UDTAsset::new_builder()
                                .udt_script(mol::Script::from_slice(script.as_slice()).unwrap())
                                .amount(u128mol(*amount))
                                .build()
                        })
                        .collect::<Vec<_>>(),
                ))
                .build();
            data.as_builder().rewards(rewards).build()
        };
        current = change_rewards(current);
        next = change_rewards(next);
    }
    let old = s
        .context
        .create_cell(output(&s.tip_lock, 1000, Some(&s.tip)), current.as_bytes());
    let actor_data = if matches!(change, Change::NonemptyActor) {
        Bytes::from(vec![1])
    } else {
        Bytes::new()
    };
    let native = s
        .context
        .create_cell(output(&actor, 1000, None), actor_data);
    let pool_ckb = s
        .context
        .create_cell(output(&s.funding, 1000, None), Bytes::new());
    let pool_udt = s.context.create_cell(
        output(&s.funding, 500, Some(&s.udt)),
        (if matches!(change, Change::LargeDuplicateUdt) {
            (1u128 << 64) + 7
        } else {
            7u128
        })
        .to_le_bytes()
        .to_vec()
        .into(),
    );
    let points = if matches!(change, Change::WrongMint) {
        2u128
    } else {
        1
    };
    let recipient = if matches!(change, Change::RedirectUdt) {
        &s.foreign
    } else {
        &s.target
    };
    let udt_amount = if matches!(change, Change::WrongUdtAmount) {
        4u128
    } else if matches!(change, Change::LargeDuplicateUdt) {
        (1u128 << 64) + 5
    } else {
        5
    };
    let actor_change = if matches!(change, Change::NoNetSpend) {
        1000
    } else if matches!(change, Change::PoolCapacityDrain | Change::TipCapacityDrain) {
        600
    } else {
        599
    };
    let outputs = vec![
        output(
            &s.tip_lock,
            if matches!(change, Change::TipCapacityDrain) {
                999
            } else {
                1000
            },
            Some(&s.tip),
        ),
        output(&actor, actor_change, None),
        output(
            &s.funding,
            if matches!(change, Change::PoolCapacityDrain) {
                899
            } else {
                900
            },
            None,
        ),
        output(&s.funding, 500, Some(&s.udt)),
        output(
            if matches!(change, Change::CkbWrongRecipient) {
                &s.foreign
            } else {
                &s.target
            },
            100,
            None,
        ),
        output(&s.target, 200, Some(&s.points)),
        output(recipient, 200, Some(&s.udt)),
    ];
    let data = vec![
        next.as_bytes().pack(),
        Bytes::new().pack(),
        Bytes::new().pack(),
        2u128.to_le_bytes().to_vec().pack(),
        Bytes::new().pack(),
        points.to_le_bytes().to_vec().pack(),
        udt_amount.to_le_bytes().to_vec().pack(),
    ];
    let declared = if matches!(change, Change::Expired) {
        NOW + 86400000
    } else {
        NOW
    };
    let witness = recipe(
        declared,
        if matches!(change, Change::WrongOutputRef) {
            1
        } else {
            0
        },
        matches!(change, Change::MissingTime),
    );
    let mut input_points = vec![old, native, pool_ckb, pool_udt];
    if matches!(change, Change::NoNetSpend) {
        // A separate consenting sponsor funds the extra actor output. Overall
        // capacity remains valid; the actor itself still proves no net spend.
        input_points.push(
            s.context
                .create_cell(output(&s.organizer, 401, None), Bytes::new()),
        );
    }
    let tx = TransactionBuilder::default()
        .inputs(
            input_points
                .into_iter()
                .map(|point| CellInput::new_builder().previous_output(point).build())
                .collect::<Vec<_>>(),
        )
        .outputs(outputs)
        .outputs_data(data)
        .cell_deps(vec![s.protocol_dep.clone(), s.registry_dep.clone()])
        .witnesses(vec![
            witness.pack(),
            Bytes::new().pack(),
            Bytes::new().pack(),
            Bytes::new().pack(),
        ])
        .build();
    s.context.complete_tx(tx)
}
fn verify(s: &Setup, tx: &TransactionView, success: bool, label: &str) {
    let result = s.context.verify_tx(tx, MAX_CYCLES);
    assert_eq!(tx.outputs().len(), tx.outputs_data().len());
    if !success {
        assert!(
            result
                .as_ref()
                .unwrap_err()
                .root_cause()
                .downcast_ref::<ckb_testtool::ckb_script::TransactionScriptError>()
                .is_some(),
            "negative must reach actual script enforcement: {result:?}"
        );
    }
    assert_eq!(
        result.is_ok(),
        success,
        "{label}: {result:?}\n{:?}",
        s.context.captured_messages()
    );
    println!("{label}: {result:?}");
}
#[test]
fn nonadmin_registry_approver_executes_tip_funding_protocol_lock_and_actual_fcb4_points() {
    let mut s = setup(false, false, 86400);
    let tx = grant(&mut s, Change::Valid, false);
    for input in tx.inputs() {
        let output = s.context.get_cell(&input.previous_output()).unwrap().0;
        assert_ne!(
            output.lock().calc_script_hash(),
            s.admin.calc_script_hash(),
            "no primary Admin shortcut input"
        );
        assert_ne!(
            output.lock().calc_script_hash(),
            s.foreign.calc_script_hash(),
            "no secondary Admin shortcut input"
        );
    }
    verify(
        &s,
        &tx,
        true,
        "independent Approver final grant: C+100CKB/+5UDT/+1actualfcb4Point",
    );
}
#[test]
fn reject_wrong_amount_recipient_mutation_and_missing_signed_time() {
    for change in [
        Change::WrongMint,
        Change::RedirectUdt,
        Change::WrongUdtAmount,
        Change::MissingTime,
        Change::WrongOutputRef,
        Change::Mutation,
        Change::TipCapacityDrain,
        Change::PoolCapacityDrain,
        Change::CkbWrongRecipient,
        Change::UnacceptedUdt,
    ] {
        let mut s = setup(false, false, 86400);
        let tx = grant(&mut s, change, false);
        verify(&s, &tx, false, &format!("{change:?}"));
    }
}
#[test]
fn rejects_public_actor_input_without_signature_authorizing_net_spend() {
    for change in [Change::NoNetSpend, Change::NonemptyActor] {
        let mut s = setup(false, false, 86400);
        let tx = grant(&mut s, change, false);
        verify(&s, &tx, false, &format!("{change:?}"));
    }
}
#[test]
fn rejects_revoked_approver_and_fake_registry_dependency() {
    for (revoked, fake) in [(true, false), (false, true)] {
        let mut s = setup(revoked, fake, 86400);
        let tx = grant(&mut s, Change::Valid, false);
        verify(
            &s,
            &tx,
            false,
            if revoked {
                "revoked Approver"
            } else {
                "foreign unpinned Registry"
            },
        );
    }
}
#[test]
fn expiry_is_checked_against_explicit_signed_timestamp_not_claimed_current_chain_clock() {
    let mut s = setup(false, false, 86400);
    let tx = grant(&mut s, Change::Expired, false);
    verify(&s, &tx, false, "signed expiry boundary");
    let mut never = setup(false, false, 0);
    let tx = grant(&mut never, Change::Valid, false);
    verify(&never, &tx, true, "Never0 candidate policy");
}

fn first_approval(s: &mut Setup, actor: Script) -> TransactionView {
    let before = tip(s, vec![], b"created", 0);
    let after = tip(s, vec![&actor], b"approved", 0);
    let current = s
        .context
        .create_cell(output(&s.tip_lock, 1000, Some(&s.tip)), before.as_bytes());
    let funding = s
        .context
        .create_cell(output(&actor, 1000, None), Bytes::new());
    let tx = TransactionBuilder::default()
        .inputs(
            vec![current, funding]
                .into_iter()
                .map(|p| CellInput::new_builder().previous_output(p).build())
                .collect::<Vec<_>>(),
        )
        .outputs(vec![
            output(&s.tip_lock, 1000, Some(&s.tip)),
            output(&actor, 999, None),
        ])
        .outputs_data(vec![after.as_bytes().pack(), Bytes::new().pack()])
        .cell_deps(vec![s.protocol_dep.clone(), s.registry_dep.clone()])
        .witnesses(vec![recipe(NOW, 0, false).pack(), Bytes::new().pack()])
        .build();
    s.context.complete_tx(tx)
}
#[test]
fn first_approval_executes_actual_candidate_tip_and_lock_and_requires_admin() {
    for kind in 0..3 {
        let mut s = setup(false, false, 86400);
        let actor = match kind {
            0 => s.admin.clone(),
            1 => s.approver.clone(),
            _ => s.organizer.clone(),
        };
        let tx = first_approval(&mut s, actor);
        verify(
            &s,
            &tx,
            kind == 0,
            if kind == 0 {
                "first platform Admin approval"
            } else {
                "nonAdmin cannot give first approval"
            },
        );
    }
}
#[test]
fn organizer_can_create_fresh_type_id_with_empty_supporters() {
    let mut s = setup(false, false, 86400);
    let native = s
        .context
        .create_cell(output(&s.organizer, 2000, None), Bytes::new());
    let input = CellInput::new_builder().previous_output(native).build();
    let id = ckboost_shared::type_id::calculate_type_id(input.as_slice(), 0);
    let typ = script(
        s.tip.code_hash().as_slice(),
        &connected(&id, &hex(PROTOCOL)),
    );
    let data = tip(&s, vec![], b"created", 0);
    let tx = TransactionBuilder::default()
        .input(input)
        .outputs(vec![
            output(&s.tip_lock, 1000, Some(&typ)),
            output(&s.organizer, 999, None),
        ])
        .outputs_data(vec![data.as_bytes().pack(), Bytes::new().pack()])
        .cell_deps(vec![s.protocol_dep.clone(), s.registry_dep.clone()])
        .witnesses(vec![recipe(NOW, 0, false).pack()])
        .build();
    let tx = s.context.complete_tx(tx);
    verify(&s, &tx, true, "fresh Organizer tip creation");
}

#[test]
fn a_different_current_platform_admin_can_complete_the_final_approval() {
    let mut s = setup(false, false, 86400);
    let tx = grant(&mut s, Change::Valid, true);
    verify(&s, &tx, true, "current Admin subsequent approval override");
}

#[test]
fn duplicate_asset_definitions_aggregate_exact_uint128_above_number_precision() {
    let mut s = setup(false, false, 86400);
    let tx = grant(&mut s, Change::LargeDuplicateUdt, false);
    verify(
        &s,
        &tx,
        true,
        "duplicate same-full-script UDT definitions deliver exactly2^64+5",
    );
}
