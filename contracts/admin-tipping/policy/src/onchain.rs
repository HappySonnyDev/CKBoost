//! QA candidate enforcement. It uses exact scripts, not the legacy classifier's
//! shortened UDT labels. A missing compile-time registry anchor always fails.
use crate::{
    array32, declared_time, decode_tip, validate_transition, Error, Reward, Tip, Transition,
    REGISTRY_TYPE_HASH,
};
use alloc::{vec, vec::Vec};
use ckb_deterministic::{generated::TransactionRecipe, transaction_recipe::TransactionRecipeExt};
use ckb_std::{
    ckb_constants::Source,
    ckb_types::{
        packed::{CellOutput, Script, WitnessArgs},
        prelude::*,
    },
    error::SysError,
    high_level::{load_cell, load_cell_data, load_cell_type_hash, load_script, load_witness},
};
use ckboost_admin_registry::registry_policy::decode_registry;
use ckboost_shared::types::{ConnectedTypeID, ProtocolData};
use molecule::prelude::Entity;

#[derive(Clone)]
struct Cell {
    output: CellOutput,
    data: Vec<u8>,
}
fn cells(source: Source) -> Result<Vec<Cell>, Error> {
    let mut rows = Vec::new();
    loop {
        match load_cell(rows.len(), source) {
            Ok(output) => {
                if rows.len() >= 256 {
                    return Err(Error::InvalidScope);
                }
                let data = load_cell_data(rows.len(), source).map_err(|_| Error::Syscall)?;
                if data.len() > 131072 {
                    return Err(Error::InvalidScope);
                }
                rows.push(Cell { output, data });
            }
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => return Err(Error::Syscall),
        }
    }
    Ok(rows)
}
fn hash(script: &Script) -> [u8; 32] {
    script.calc_script_hash().unpack()
}
fn type_is(cell: &Cell, code: &[u8; 32]) -> bool {
    cell.output.type_().to_opt().map_or(false, |script| {
        script.code_hash().as_slice() == code && script.hash_type().as_slice() == [1]
    })
}
fn exact_type(cell: &Cell, script: &Script) -> bool {
    cell.output.type_().to_opt().as_ref() == Some(script)
}
fn capacity(cell: &Cell) -> u128 {
    let n: u64 = cell.output.capacity().unpack();
    n as u128
}
fn sum_caps<'a>(mut cells: impl Iterator<Item = &'a Cell>) -> Result<u128, Error> {
    cells.try_fold(0u128, |sum, cell| {
        sum.checked_add(capacity(cell)).ok_or(Error::InvalidAmount)
    })
}
fn actor_spends(actor: &[u8; 32], inputs: &[Cell], outputs: &[Cell]) -> Result<bool, Error> {
    let actor_input = inputs.iter().any(|cell| {
        hash(&cell.output.lock()) == *actor
            && cell.output.type_().to_opt().is_none()
            && cell.data.is_empty()
    });
    Ok(actor_input
        && sum_caps(
            inputs
                .iter()
                .filter(|cell| hash(&cell.output.lock()) == *actor),
        )? > sum_caps(
            outputs
                .iter()
                .filter(|cell| hash(&cell.output.lock()) == *actor),
        )?)
}
fn code(bytes: &[u8]) -> Result<[u8; 32], Error> {
    array32(bytes).map_err(|_| Error::InvalidScope)
}
fn connection(script: &Script, protocol: &[u8; 32]) -> Result<[u8; 32], Error> {
    if script.hash_type().as_slice() != [1] {
        return Err(Error::InvalidScope);
    }
    let args = script.args().raw_data();
    let connected = ConnectedTypeID::from_slice(&args).map_err(|_| Error::InvalidScope)?;
    if connected.connected_key().as_slice() != protocol {
        return Err(Error::InvalidScope);
    }
    code(connected.type_id().as_slice())
}
fn bound_protocol(script: &Script) -> Result<[u8; 32], Error> {
    let raw = script.args().raw_data();
    if raw.len() == 32 {
        return code(&raw);
    }
    let connected = ConnectedTypeID::from_slice(&raw).map_err(|_| Error::InvalidScope)?;
    code(connected.connected_key().as_slice())
}
fn first_recipe() -> Result<TransactionRecipe, Error> {
    let mut index = 0;
    loop {
        match load_witness(index, Source::Input) {
            Ok(raw) => {
                index += 1;
                let witness = match WitnessArgs::from_slice(&raw) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let output = match witness.output_type().to_opt() {
                    Some(v) => v.raw_data(),
                    None => continue,
                };
                if let Ok(recipe) = TransactionRecipe::from_slice(&output) {
                    return Ok(recipe);
                }
            }
            Err(SysError::IndexOutOfBound) => return Err(Error::InvalidRecipe),
            Err(_) => return Err(Error::Syscall),
        }
    }
}
/// Dispatch before the legacy strict classifier, which does not know Registry
/// cells. This only identifies the first recipe; validation remains fail closed.
pub fn is_tipping_method() -> bool {
    first_recipe().map_or(false, |recipe| {
        recipe.method_path_bytes() == b"CKBoostTipping.update_tipping"
    })
}
fn recipe_time(output_index: usize) -> Result<u64, Error> {
    let recipe = first_recipe()?;
    if recipe.method_path_bytes() != b"CKBoostTipping.update_tipping"
        || recipe.arguments().len() != 2
    {
        return Err(Error::InvalidRecipe);
    }
    let argument = recipe.arguments().get(0).ok_or(Error::InvalidRecipe)?;
    if argument.arg_type().as_slice() != [2]
        || argument.data().raw_data().as_ref() != (output_index as u32).to_le_bytes()
    {
        return Err(Error::InvalidRecipe);
    }
    let time = recipe.arguments().get(1).ok_or(Error::InvalidRecipe)?;
    if time.arg_type().as_slice() != [0] {
        return Err(Error::InvalidRecipe);
    }
    declared_time(&time.data().raw_data())
}
fn amount(cell: &Cell, script: &Script) -> Result<u128, Error> {
    if !exact_type(cell, script) {
        return Ok(0);
    }
    if cell.data.len() != 16 {
        return Err(Error::InvalidAmount);
    }
    Ok(u128::from_le_bytes(
        cell.data
            .as_slice()
            .try_into()
            .map_err(|_| Error::InvalidAmount)?,
    ))
}
fn total_asset<'a>(
    mut cells: impl Iterator<Item = &'a Cell>,
    script: &Script,
) -> Result<u128, Error> {
    cells.try_fold(0u128, |sum, cell| {
        sum.checked_add(amount(cell, script)?)
            .ok_or(Error::InvalidAmount)
    })
}
fn make_script(code: &[u8; 32], args: &[u8]) -> Script {
    Script::new_builder()
        .code_hash((*code).pack())
        .hash_type(1u8.into())
        .args(args.pack())
        .build()
}
fn asset_script(reward: &Reward) -> Result<Script, Error> {
    Script::from_slice(reward.script.as_slice()).map_err(|_| Error::InvalidAsset)
}
fn validate_payout(
    tip: &Tip,
    transition: Transition,
    inputs: &[Cell],
    outputs: &[Cell],
    funding: &Script,
    points: &Script,
    accepted: &[Script],
) -> Result<(), Error> {
    let mut transfers = Vec::new();
    for reward in &tip.udts {
        let script = asset_script(reward)?;
        if !accepted.contains(&script) {
            return Err(Error::InvalidAsset);
        }
        transfers.push((script, reward.amount));
    }
    let pool_inputs: Vec<_> = inputs
        .iter()
        .filter(|c| c.output.lock() == *funding)
        .collect();
    let pool_outputs: Vec<_> = outputs
        .iter()
        .filter(|c| c.output.lock() == *funding)
        .collect();
    let minted = total_asset(outputs.iter(), points)?
        .checked_sub(total_asset(inputs.iter(), points)?)
        .ok_or(Error::InvalidPayout)?;
    if minted != if transition.granting { tip.points } else { 0 } {
        return Err(Error::InvalidPayout);
    }
    if !transition.granting {
        if !pool_inputs.is_empty() {
            return Err(Error::InvalidPayout);
        }
        return Ok(());
    }
    // Typed-cell storage stays in the pool, even when the last token is transferred.
    if sum_caps(pool_inputs.iter().copied())?.checked_sub(sum_caps(pool_outputs.iter().copied())?)
        != Some(tip.ckb)
    {
        return Err(Error::InvalidPayout);
    }
    for cell in pool_inputs.iter().chain(pool_outputs.iter()) {
        if let Some(script) = cell.output.type_().to_opt() {
            if !transfers.iter().any(|(asset, _)| *asset == script) {
                return Err(Error::InvalidAsset);
            }
            amount(cell, &script)?;
        } else if !cell.data.is_empty() {
            return Err(Error::InvalidAsset);
        }
    }
    let mut assets: Vec<Script> = transfers.iter().map(|(script, _)| script.clone()).collect();
    if !assets.contains(points) {
        assets.push(points.clone());
    }
    for script in assets {
        let transfer = transfers
            .iter()
            .find(|(asset, _)| *asset == script)
            .map_or(0, |(_, n)| *n);
        let mint = if script == *points { tip.points } else { 0 };
        if total_asset(pool_inputs.iter().copied(), &script)?
            .checked_sub(total_asset(pool_outputs.iter().copied(), &script)?)
            != Some(transfer)
        {
            return Err(Error::InvalidPayout);
        }
        if total_asset(outputs.iter(), &script)?.checked_sub(total_asset(inputs.iter(), &script)?)
            != Some(mint)
        {
            return Err(Error::InvalidPayout);
        }
        let recipient_output = total_asset(
            outputs
                .iter()
                .filter(|c| hash(&c.output.lock()) == tip.target),
            &script,
        )?;
        let recipient_input = total_asset(
            inputs
                .iter()
                .filter(|c| hash(&c.output.lock()) == tip.target),
            &script,
        )?;
        if recipient_output.checked_sub(recipient_input)
            != Some(transfer.checked_add(mint).ok_or(Error::InvalidAmount)?)
        {
            return Err(Error::InvalidPayout);
        }
    }
    if tip.ckb > 0 {
        let native = |cell: &&Cell| {
            cell.output.type_().to_opt().is_none()
                && cell.data.is_empty()
                && hash(&cell.output.lock()) == tip.target
        };
        let target_output = sum_caps(outputs.iter().filter(native))?;
        let target_input = sum_caps(inputs.iter().filter(native))?;
        // A small reward may need recipient storage supplied separately by the actor.
        if target_output
            .checked_sub(target_input)
            .map_or(true, |net| net < tip.ckb)
        {
            return Err(Error::InvalidPayout);
        }
    }
    Ok(())
}
#[derive(Clone, Copy)]
enum Mode {
    Tip,
    Funding,
    ProtocolLock,
}
fn validate(mode: Mode) -> Result<(), Error> {
    let anchor = REGISTRY_TYPE_HASH.ok_or(Error::MissingAnchor)?;
    let current = load_script().map_err(|_| Error::Syscall)?;
    let protocol_hash = bound_protocol(&current)?;
    let inputs = cells(Source::Input)?;
    let outputs = cells(Source::Output)?;
    let mut protocol = None;
    let mut registry = None;
    let mut index = 0;
    loop {
        match load_cell_type_hash(index, Source::CellDep) {
            Ok(Some(value)) if value == protocol_hash => {
                if protocol.is_some() {
                    return Err(Error::InvalidScope);
                }
                let bytes = load_cell_data(index, Source::CellDep).map_err(|_| Error::Syscall)?;
                protocol = Some(ProtocolData::from_slice(&bytes).map_err(|_| Error::InvalidScope)?);
            }
            Ok(Some(value)) if value == anchor => {
                if registry.is_some() {
                    return Err(Error::InvalidRegistry);
                }
                let output = load_cell(index, Source::CellDep).map_err(|_| Error::Syscall)?;
                if output.type_().to_opt() != Some(output.lock()) {
                    return Err(Error::InvalidRegistry);
                }
                registry =
                    Some(load_cell_data(index, Source::CellDep).map_err(|_| Error::Syscall)?);
            }
            Ok(_) => {}
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => return Err(Error::Syscall),
        }
        index += 1;
    }
    let protocol = protocol.ok_or(Error::InvalidScope)?;
    let registry_bytes = registry.ok_or(Error::InvalidRegistry)?;
    let registry = decode_registry(&registry_bytes).map_err(|_| Error::InvalidRegistry)?;
    if registry.protocol_hash != protocol_hash
        || inputs.iter().chain(outputs.iter()).any(|cell| {
            cell.output.type_().to_opt().map_or(false, |s| {
                let h = hash(&s);
                h == protocol_hash || h == anchor
            })
        })
    {
        return Err(Error::InvalidScope);
    }
    let config = protocol.protocol_config();
    let codes = config.script_code_hashes();
    let tip_code = code(codes.ckb_boost_tipping_type_code_hash().as_slice())?;
    let funding_code = code(codes.ckb_boost_funding_lock_code_hash().as_slice())?;
    let lock_code = code(codes.ckb_boost_protocol_lock_code_hash().as_slice())?;
    let points_code = code(codes.ckb_boost_points_udt_type_code_hash().as_slice())?;
    let tip_inputs: Vec<_> = inputs.iter().filter(|c| type_is(c, &tip_code)).collect();
    let tip_outputs: Vec<_> = outputs
        .iter()
        .enumerate()
        .filter(|(_, c)| type_is(c, &tip_code))
        .collect();
    if tip_inputs.len() > 1 || tip_outputs.len() != 1 {
        return Err(Error::InvalidTip);
    }
    let (output_index, output) = tip_outputs[0];
    let output_type = output.output.type_().to_opt().ok_or(Error::InvalidTip)?;
    connection(&output_type, &protocol_hash)?;
    let after = decode_tip(&output.data)?;
    let output_lock = output.output.lock();
    if output_lock.code_hash().as_slice() != lock_code
        || connection(&output_lock, &protocol_hash)? != after.proposer
    {
        return Err(Error::InvalidScope);
    }
    let before = tip_inputs
        .first()
        .map(|cell| {
            if cell.output.type_().to_opt() != Some(output_type.clone())
                || cell.output.lock() != output_lock
                || capacity(output) < capacity(cell)
            {
                return Err(Error::InvalidTransition);
            }
            decode_tip(&cell.data)
        })
        .transpose()?;
    let funding = make_script(&funding_code, &protocol_hash);
    let points = make_script(&points_code, &protocol_hash);
    match mode {
        Mode::Tip if current != output_type => return Err(Error::InvalidScope),
        Mode::Funding if current != funding || before.is_none() => return Err(Error::InvalidScope),
        Mode::ProtocolLock if current != output_lock || before.is_none() => {
            return Err(Error::InvalidScope)
        }
        _ => {}
    }
    let admins = config
        .admin_lock_hash_vec()
        .into_iter()
        .map(|h| code(h.as_slice()))
        .collect::<Result<Vec<_>, _>>()?;
    let organizers = protocol
        .endorsers_whitelist()
        .into_iter()
        .map(|h| code(h.endorser_lock_hash().as_slice()))
        .collect::<Result<Vec<_>, _>>()?;
    let actor = before.as_ref().map_or(after.proposer, |_| {
        after.supporters.last().copied().unwrap_or([0; 32])
    });
    let mut signed = vec![];
    if actor_spends(&actor, &inputs, &outputs)? {
        signed.push(actor);
    }
    let time = recipe_time(output_index)?;
    let transition = validate_transition(
        before.as_ref(),
        &after,
        &registry,
        &admins,
        &organizers,
        &signed,
        time,
    )?;
    let accepted = codes
        .accepted_udt_type_scripts()
        .into_iter()
        .map(|s| Script::from_slice(s.as_slice()).map_err(|_| Error::InvalidAsset))
        .collect::<Result<Vec<_>, _>>()?;
    if matches!(mode, Mode::Funding) && !transition.granting {
        return Err(Error::InvalidPayout);
    }
    validate_payout(
        &after, transition, &inputs, &outputs, &funding, &points, &accepted,
    )
}
pub fn validate_tipping() -> Result<(), Error> {
    validate(Mode::Tip)
}
pub fn validate_funding() -> Result<(), Error> {
    validate(Mode::Funding)
}
pub fn validate_protocol_lock() -> Result<(), Error> {
    validate(Mode::ProtocolLock)
}

/// Preserve the original Funding campaign namespace without linking the legacy
/// strict classifier/SSRI builder. The actual configured Campaign TYPE and
/// ProtocolLock still execute all settings/review/deduction/reward rules.
pub fn validate_campaign_funding() -> Result<(), Error> {
    let current = load_script().map_err(|_| Error::Syscall)?;
    if current.hash_type().as_slice() != [1] || current.args().raw_data().len() != 32 {
        return Err(Error::InvalidScope);
    }
    let campaign_hash = code(&current.args().raw_data())?;
    let inputs = cells(Source::Input)?;
    let outputs = cells(Source::Output)?;
    let matches: Vec<_> = inputs
        .iter()
        .filter(|cell| {
            cell.output
                .type_()
                .to_opt()
                .map_or(false, |typ| hash(&typ) == campaign_hash)
        })
        .collect();
    if matches.len() != 1 {
        return Err(Error::InvalidScope);
    }
    let input = matches[0];
    let typ = input.output.type_().to_opt().ok_or(Error::InvalidScope)?;
    let connected =
        ConnectedTypeID::from_slice(&typ.args().raw_data()).map_err(|_| Error::InvalidScope)?;
    let protocol_hash = code(connected.connected_key().as_slice())?;
    let mut protocol = None;
    let mut index = 0;
    loop {
        match load_cell_type_hash(index, Source::CellDep) {
            Ok(Some(h)) if h == protocol_hash => {
                if protocol.is_some() {
                    return Err(Error::InvalidScope);
                }
                let bytes = load_cell_data(index, Source::CellDep).map_err(|_| Error::Syscall)?;
                protocol = Some(ProtocolData::from_slice(&bytes).map_err(|_| Error::InvalidScope)?);
            }
            Ok(_) => {}
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => return Err(Error::Syscall),
        }
        index += 1;
    }
    let protocol = protocol.ok_or(Error::InvalidScope)?;
    let codes = protocol.protocol_config().script_code_hashes();
    if current.code_hash().as_slice() != codes.ckb_boost_funding_lock_code_hash().as_slice()
        || typ.code_hash().as_slice() != codes.ckb_boost_campaign_type_code_hash().as_slice()
        || typ.hash_type().as_slice() != [1]
        || input.output.lock().code_hash().as_slice()
            != codes.ckb_boost_protocol_lock_code_hash().as_slice()
    {
        return Err(Error::InvalidScope);
    }
    connection(&input.output.lock(), &protocol_hash)?;
    let output_matches: Vec<_> = outputs
        .iter()
        .enumerate()
        .filter(|(_, cell)| exact_type(cell, &typ))
        .collect();
    if output_matches.len() != 1 || output_matches[0].1.output.lock() != input.output.lock() {
        return Err(Error::InvalidTransition);
    }
    let recipe = first_recipe()?;
    let method = recipe.method_path_bytes();
    let argc = if method == b"CKBoostCampaign.update_campaign" {
        1
    } else if method == b"CKBoostCampaign.approve_completion" {
        3
    } else {
        return Err(Error::InvalidRecipe);
    };
    if recipe.arguments().len() != argc {
        return Err(Error::InvalidRecipe);
    }
    let reference = recipe.arguments().get(0).ok_or(Error::InvalidRecipe)?;
    if reference.arg_type().as_slice() != [2]
        || reference.data().raw_data().as_ref() != (output_matches[0].0 as u32).to_le_bytes()
    {
        return Err(Error::InvalidRecipe);
    }
    Ok(())
}
