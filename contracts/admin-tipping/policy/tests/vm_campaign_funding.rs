#![cfg(feature = "vm-tests")]

//! Execute the candidate review contracts with the unchanged, publicly verified
//! Points and ClaimablePool ELFs. Wallets are synthetic ALWAYS_SUCCESS fixtures;
//! real wallet/ACP authorization is covered by the separate ACP VM suite.
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
const MAX_CYCLES: u64 = 200_000_000;
const PROTOCOL: &str = "4eacaf9b1a120d2bfd99f26fcedfdcfe6ef116484e9b478b0a104a872316e034";
const LOCK_CODE: &str = "e91b5a78463c293318331c21d372e031eb9ffad87b379fbe0563222fcdd28815";
const CAMPAIGN_CODE: &str = "9004d12f500e558df19c14e08907e014dbfc50ae249500bb5c389f883a1487d2";
const POINTS_CODE: &str = "fcb4b762e3222b603771811b8abe6b054a480a0f5d8011fd9fff266d72189a5e";
const POOL_CODE: &str = "458cacb13a3c40e6d046468e7fe3f5c2c93f0581062e269dc9ffec4858346cb6";

fn hex(value: &str) -> Vec<u8> {
    let value = value.strip_prefix("0x").unwrap_or(value);
    assert_eq!(value.len() % 2, 0);
    (0..value.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&value[i..i + 2], 16).unwrap())
        .collect()
}
fn b32(value: &[u8]) -> mol::Byte32 {
    mol::Byte32::from_slice(value).unwrap()
}
fn script(code_hash: &str, args: Vec<u8>) -> Script {
    Script::new_builder()
        .code_hash(Byte32::from_slice(&hex(code_hash)).unwrap())
        .hash_type(1u8.into())
        .args(Bytes::from(args).pack())
        .build()
}
fn connection(owner: &[u8], protocol: &[u8]) -> Vec<u8> {
    mol::ConnectedTypeID::new_builder()
        .type_id(b32(owner))
        .connected_key(b32(protocol))
        .build()
        .as_slice()
        .to_vec()
}
fn dep(point: OutPoint) -> CellDep {
    CellDep::new_builder()
        .out_point(point)
        .dep_type(0u8.into())
        .build()
}
fn binary(relative: &str) -> Bytes {
    std::fs::read(
        std::path::Path::new(
            &std::env::var("CKBOOST_AUTH_BIN_DIR")
                .expect("set CKBOOST_AUTH_BIN_DIR to the reviewed release directory"),
        )
        .join(relative),
    )
    .expect("reviewed contract bytes")
    .into()
}
fn deploy_pinned(
    context: &mut Context,
    owner: &Script,
    file: &str,
    size: usize,
    data_hash: &str,
    type_args: &str,
    type_hash: &str,
) {
    let bytes = binary(file);
    assert_eq!(bytes.len(), size, "{file}: exact reviewed size");
    assert_eq!(
        CellOutput::calc_data_hash(&bytes).as_slice(),
        hex(data_hash),
        "{file}: exact reviewed CKB data hash"
    );
    let code_type = script(
        "00000000000000000000000000000000000000000000000000545950455f4944",
        hex(type_args),
    );
    assert_eq!(
        code_type.calc_script_hash().as_slice(),
        hex(type_hash),
        "full TypeID hash"
    );
    context.create_cell(
        CellOutput::new_builder()
            .capacity(((size as u64 + 128) * CKB).pack())
            .lock(owner.clone())
            .type_(Some(code_type).pack())
            .build(),
        bytes,
    );
}

#[derive(Clone, Copy, Debug)]
enum Actor {
    Owner,
    Reviewer,
    Foreign,
}
struct Setup {
    context: Context,
    owner: Script,
    reviewer: Script,
    foreign: Script,
    admin: Script,
    claimant: Script,
    campaign_type: Script,
    campaign_lock: Script,
    points_type: Script,
    protocol_dep: CellDep,
    funding: Script,
}
fn setup(owner_whitelisted: bool) -> Setup {
    let mut context = Context::default();
    context.set_capture_debug(true);
    let always = context.deploy_cell(ALWAYS_SUCCESS.clone());
    let mut wallet = |id| {
        context
            .build_script(&always, Bytes::from(vec![id]))
            .unwrap()
    };
    let owner = wallet(1);
    let foreign = wallet(2);
    let admin = wallet(3);
    let reviewer = wallet(4);
    let claimant = wallet(5);
    let code_type = script(
        "00000000000000000000000000000000000000000000000000545950455f4944",
        hex("06661a546d171ae6f280f3f1363070c7d1e7ad7dc1032d566c7b16f804d57ab4"),
    );
    assert_eq!(code_type.calc_script_hash().as_slice(), hex(LOCK_CODE));
    context.create_cell(
        CellOutput::new_builder()
            .capacity((1000000 * CKB).pack())
            .lock(admin.clone())
            .type_(Some(code_type).pack())
            .build(),
        candidate("ckboost-protocol-lock-qa-candidate"),
    );
    let funding_code_type = script(
        "00000000000000000000000000000000000000000000000000545950455f4944",
        vec![0x21; 32],
    );
    let funding_code = funding_code_type.calc_script_hash();
    context.create_cell(
        CellOutput::new_builder()
            .capacity((1000000 * CKB).pack())
            .lock(admin.clone())
            .type_(Some(funding_code_type).pack())
            .build(),
        candidate("ckboost-funding-lock-qa-candidate"),
    );
    deploy_pinned(
        &mut context,
        &admin,
        "ckboost-campaign-type",
        256040,
        "b8f0ebe8ad9d28ed1c9018fceeeee8e52bea23863dc39d1a4213abe7422ffa33",
        "fe4dcdc1378be473b33321f30db589d220a2947a0156aa41e809af6f1cae5027",
        CAMPAIGN_CODE,
    );
    deploy_pinned(
        &mut context,
        &admin,
        "dependency-public/points-type.elf",
        138784,
        "b61c56ff5d0b9d036f0db63d67ec9cf9d8cb62a20d9de1830659b92261bb150b",
        "c9abd34829d90d4eb1dc28b70e7378df447d26b41d17656362b8fabef226caff",
        POINTS_CODE,
    );
    deploy_pinned(
        &mut context,
        &admin,
        "dependency-public/claimable-pool.elf",
        56600,
        "07aace477ec2a6a11c108037be54bb3ecc2cd003b5db6a5e1a4adf3a5c403fb1",
        "6953e9905a3c922da6974aafdbaf3b22965982894c558a0a125e8dc796a5b8a2",
        POOL_CODE,
    );
    let protocol_type = script(
        "53769be2ed1d09a9da7c1d71488347449bb76f1212068f7e366939d0d5fd59fa",
        hex("53a5053bed009ff6bcfe2762b5c186fdbbffa215cde85868c7becb501f0ef462"),
    );
    assert_eq!(protocol_type.calc_script_hash().as_slice(), hex(PROTOCOL));
    let protocol = hex(PROTOCOL);
    let campaign_type = script(CAMPAIGN_CODE, connection(&[66; 32], &protocol));
    let campaign_lock = script(
        LOCK_CODE,
        connection(owner.calc_script_hash().as_slice(), &protocol),
    );
    let hashes = mol::ScriptCodeHashes::new_builder()
        .ckb_boost_protocol_type_code_hash(b32(protocol_type.code_hash().as_slice()))
        .ckb_boost_campaign_type_code_hash(b32(&hex(CAMPAIGN_CODE)))
        .ckb_boost_protocol_lock_code_hash(b32(&hex(LOCK_CODE)))
        .ckb_boost_points_udt_type_code_hash(b32(&hex(POINTS_CODE)))
        .ckb_boost_funding_lock_code_hash(b32(funding_code.as_slice()))
        .build();
    let mut endorsers = vec![mol::EndorserInfo::new_builder()
        .endorser_lock_hash(b32(foreign.calc_script_hash().as_slice()))
        .build()];
    if owner_whitelisted {
        endorsers.push(
            mol::EndorserInfo::new_builder()
                .endorser_lock_hash(b32(owner.calc_script_hash().as_slice()))
                .build(),
        );
    }
    let protocol_data = mol::ProtocolData::new_builder()
        .protocol_config(
            mol::ProtocolConfig::new_builder()
                .script_code_hashes(hashes)
                .admin_lock_hash_vec(mol::Byte32Vec::from(vec![b32(admin
                    .calc_script_hash()
                    .as_slice())]))
                .build(),
        )
        .endorsers_whitelist(mol::EndorserInfoVec::from(endorsers))
        .build();
    let protocol_point = context.create_cell(
        CellOutput::new_builder()
            .capacity((1000 * CKB).pack())
            .lock(script(
                LOCK_CODE,
                connection(admin.calc_script_hash().as_slice(), &protocol),
            ))
            .type_(Some(protocol_type).pack())
            .build(),
        Bytes::from(protocol_data.as_slice().to_vec()),
    );
    let funding = script(
        ckb_std::high_level::encode_hex(funding_code.as_slice())
            .to_str()
            .unwrap(),
        campaign_type.calc_script_hash().as_slice().to_vec(),
    );
    Setup {
        funding,
        context,
        owner,
        reviewer,
        foreign,
        admin,
        claimant,
        campaign_type,
        campaign_lock,
        points_type: script(POINTS_CODE, protocol),
        protocol_dep: dep(protocol_point),
    }
}
fn campaign(setup: &Setup, staff: bool, approved: bool) -> mol::CampaignData {
    let accepted = if approved {
        vec![b32(&[77; 32])]
    } else {
        vec![]
    };
    let quest = mol::QuestData::default()
        .as_builder()
        .quest_id(mol::Uint32::from_slice(&1u32.to_le_bytes()).unwrap())
        .points(mol::Uint128::from_slice(&1u128.to_le_bytes()).unwrap())
        .rewards_on_completion(mol::AssetListVec::from(vec![mol::AssetList::new_builder()
            .ckb_amount(mol::Uint128::from_slice(&(100u128 * CKB as u128).to_le_bytes()).unwrap())
            .build()]))
        .accepted_submission_user_type_ids(mol::Byte32Vec::from(accepted))
        .completion_count(mol::Uint32::from_slice(&u32::from(approved).to_le_bytes()).unwrap())
        .build();
    mol::CampaignData::new_builder()
        .endorser_lock_hash(b32(setup.owner.calc_script_hash().as_slice()))
        .staff_lock_hash_vec(mol::Byte32Vec::from(if staff {
            vec![b32(setup.reviewer.calc_script_hash().as_slice())]
        } else {
            vec![]
        }))
        .metadata(
            mol::CampaignMetadata::new_builder()
                .title(mol::String::from(b"Campaign".to_vec()))
                .short_description(mol::String::from(b"Summary".to_vec()))
                .long_description(mol::String::from(b"Description".to_vec()))
                .build(),
        )
        .quests(mol::QuestDataVec::from(vec![quest]))
        .total_completions(mol::Uint32::from_slice(&u32::from(approved).to_le_bytes()).unwrap())
        .build()
}
fn pool_data(claimant: &Script, amount: u128) -> Bytes {
    let mut bytes = amount.to_le_bytes().to_vec();
    bytes.extend_from_slice(&1u32.to_le_bytes());
    bytes.extend_from_slice(claimant.calc_script_hash().as_slice());
    bytes.extend_from_slice(&amount.to_le_bytes());
    assert_eq!(bytes.len(), 68);
    bytes.into()
}
fn review_witness() -> Bytes {
    let inline = |bytes: Vec<u8>| {
        RecipeArgument::new_builder()
            .arg_type(0u8)
            .data(RecipeBytes::from(bytes))
            .build()
    };
    let recipe = TransactionRecipe::new_builder()
        .method_path(RecipeBytes::from(
            b"CKBoostCampaign.approve_completion".to_vec(),
        ))
        .arguments(RecipeArgumentVec::from(vec![
            RecipeArgument::new_builder()
                .arg_type(2u8)
                .data(RecipeBytes::from(0u32.to_le_bytes().to_vec()))
                .build(),
            inline(1u32.to_le_bytes().to_vec()),
            inline(
                mol::Byte32Vec::from(vec![b32(&[77; 32])])
                    .as_slice()
                    .to_vec(),
            ),
        ]))
        .build();
    WitnessArgs::new_builder()
        .output_type(Some(Bytes::from(recipe.as_slice().to_vec())).pack())
        .build()
        .as_bytes()
}
fn review(
    setup: &mut Setup,
    actor: Actor,
    input_staff: bool,
    output_staff: bool,
    minted: u128,
) -> TransactionView {
    let actor = match actor {
        Actor::Owner => setup.owner.clone(),
        Actor::Reviewer => setup.reviewer.clone(),
        Actor::Foreign => setup.foreign.clone(),
    };
    let native = setup.context.create_cell(
        CellOutput::new_builder()
            .capacity((1000 * CKB).pack())
            .lock(actor.clone())
            .build(),
        Bytes::new(),
    );
    let current = campaign(setup, input_staff, false);
    let old = setup.context.create_cell(
        CellOutput::new_builder()
            .capacity((1000 * CKB).pack())
            .lock(setup.campaign_lock.clone())
            .type_(Some(setup.campaign_type.clone()).pack())
            .build(),
        Bytes::from(current.as_slice().to_vec()),
    );
    let pool_point = setup.context.create_cell(
        CellOutput::new_builder()
            .capacity((1000 * CKB).pack())
            .lock(setup.funding.clone())
            .build(),
        Bytes::new(),
    );
    let inputs = vec![
        CellInput::new_builder().previous_output(native).build(),
        CellInput::new_builder().previous_output(old).build(),
        CellInput::new_builder().previous_output(pool_point).build(),
    ];
    // No admin input may accidentally select the Points owner-mode shortcut.
    for input in &inputs {
        let cell = setup.context.get_cell(&input.previous_output()).unwrap().0;
        assert_ne!(
            cell.lock().calc_script_hash(),
            setup.admin.calc_script_hash()
        );
    }
    let next = campaign(setup, output_staff, true);
    let pool = CellOutput::new_builder()
        .capacity((206 * CKB).pack())
        .lock(script(
            POOL_CODE,
            actor.calc_script_hash().as_slice().to_vec(),
        ))
        .type_(Some(setup.points_type.clone()).pack())
        .build();
    let tx = TransactionBuilder::default()
        .inputs(inputs)
        .outputs(vec![
            CellOutput::new_builder()
                .capacity((1000 * CKB).pack())
                .lock(setup.campaign_lock.clone())
                .type_(Some(setup.campaign_type.clone()).pack())
                .build(),
            pool,
            CellOutput::new_builder()
                .capacity((900 * CKB).pack())
                .lock(setup.funding.clone())
                .build(),
            CellOutput::new_builder()
                .capacity((300 * CKB).pack())
                .lock(script(
                    POOL_CODE,
                    actor.calc_script_hash().as_slice().to_vec(),
                ))
                .build(),
            CellOutput::new_builder()
                .capacity((593 * CKB).pack())
                .lock(actor)
                .build(),
        ])
        .outputs_data(vec![
            Bytes::from(next.as_slice().to_vec()).pack(),
            pool_data(&setup.claimant, minted).pack(),
            Bytes::new().pack(),
            pool_data(&setup.claimant, 100u128 * CKB as u128).pack(),
            Bytes::new().pack(),
        ])
        .cell_dep(setup.protocol_dep.clone())
        .witnesses(vec![
            Bytes::new().pack(),
            review_witness().pack(),
            Bytes::new().pack(),
        ])
        .build();
    setup.context.complete_tx(tx)
}
fn expect_vm(setup: &Setup, tx: &TransactionView, allowed: bool, label: &str) {
    let result = setup.context.verify_tx(tx, MAX_CYCLES);
    assert_eq!(
        tx.outputs().len(),
        tx.outputs_data().len(),
        "Every negative fixture must preserve valid transaction structure"
    );
    if !allowed {
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
        allowed,
        "{label}: {result:?}\n{:?}",
        setup.context.captured_messages()
    );
    println!("{label}: {result:?}");
}

fn candidate(name: &str) -> Bytes {
    std::fs::read(
        std::path::Path::new(&std::env::var("CKBOOST_TIP_CANDIDATE_BIN_DIR").unwrap()).join(name),
    )
    .unwrap()
    .into()
}
#[test]
fn current_campaign_review_keeps_ckb_funding_deduction_and_actual_points_pool() {
    let mut s = setup(true);
    let tx = review(&mut s, Actor::Owner, true, true, 1);
    expect_vm(
        &s,
        &tx,
        true,
        "new slim Funding + current9004 Campaign/e91 Lock/fcb4 Points; exact100CKB reward",
    );
}
#[test]
fn current_campaign_vm_rejects_wrong_reward_deduction_and_unassigned_actor() {
    let mut s = setup(true);
    let tx = review(&mut s, Actor::Owner, true, true, 1);
    let mut outputs: Vec<_> = tx.outputs().into_iter().collect();
    outputs[2] = outputs[2]
        .clone()
        .as_builder()
        .capacity((899 * CKB).pack())
        .build();
    outputs[4] = outputs[4]
        .clone()
        .as_builder()
        .capacity((594 * CKB).pack())
        .build();
    let wrong = tx.as_advanced_builder().set_outputs(outputs).build();
    expect_vm(
        &s,
        &wrong,
        false,
        "must preserve current Campaign exact funding deduction rules",
    );
    let mut foreign = setup(true);
    let tx = review(&mut foreign, Actor::Foreign, true, true, 1);
    expect_vm(
        &foreign,
        &tx,
        false,
        "unassigned foreign actor cannot unlock campaign funds",
    );
}
#[test]
fn funding_cannot_reuse_a_different_campaign_or_protocol_namespace() {
    let mut s = setup(true);
    let tx = review(&mut s, Actor::Owner, true, true, 1);
    let wrong = s.context.create_cell(
        CellOutput::new_builder()
            .capacity((1000 * CKB).pack())
            .lock(script(
                ckb_std::high_level::encode_hex(s.funding.code_hash().as_slice())
                    .to_str()
                    .unwrap(),
                hex(PROTOCOL),
            ))
            .build(),
        Bytes::new(),
    );
    let mut inputs: Vec<_> = tx.inputs().into_iter().collect();
    inputs[2] = CellInput::new_builder().previous_output(wrong).build();
    let tx = tx.as_advanced_builder().set_inputs(inputs).build();
    expect_vm(
        &s,
        &tx,
        false,
        "wrong Funding namespace cannot borrow a valid campaign input",
    );
}
