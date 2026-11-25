//! The same executable is used as registry TYPE and LOCK. Creation is therefore
//! authorized by the TYPE invocation; a newly created output lock alone does
//! not execute. All authority comes from existing protocol INPUT/CellDep data.
use alloc::vec::Vec;
use blake2b_ref::Blake2bBuilder;
use ckb_std::{
    ckb_constants::Source,
    ckb_types::prelude::*,
    error::SysError,
    high_level::{load_cell_capacity, load_cell_data, load_cell_lock, load_cell_lock_hash,
        load_cell_type, load_cell_type_hash, load_input, load_script, load_script_hash},
    syscalls,
};
use crate::{protocol::protocol_admins, registry_policy::{decode_registry, validate_transition, MAX_BYTES}, Error};
impl From<SysError> for Error {fn from(_: SysError) -> Self {Error::Syscall}}
fn data_size(index: usize, source: Source) -> Result<usize, Error> {
    match syscalls::load_cell_data(&mut [], 0, index, source) {
        Ok(size) | Err(SysError::LengthNotEnough(size)) => Ok(size),
        Err(error) => Err(error.into()),
    }
}
fn bounded_data(index: usize, source: Source) -> Result<Vec<u8>, Error> {
    if data_size(index, source)? > MAX_BYTES { return Err(Error::InvalidRegistryData); }
    Ok(load_cell_data(index, source)?)
}
fn type_indices(hash: &[u8; 32], source: Source) -> Result<Vec<usize>, Error> {
    let mut result = Vec::new();
    let mut index = 0;
    loop {
        match load_cell_type_hash(index, source) {
            Ok(Some(value)) if value == *hash => result.push(index),
            Ok(_) => {},
            Err(SysError::IndexOutOfBound) => break,
            Err(error) => return Err(error.into()),
        }
        index += 1;
    }
    Ok(result)
}
fn capacity_total(hash: &[u8; 32], source: Source) -> Result<u128, Error> {
    let mut total = 0u128;
    let mut index = 0;
    loop {
        match load_cell_lock_hash(index, source) {
            Ok(value) if value == *hash => total = total.checked_add(u128::from(load_cell_capacity(index, source)?)).ok_or(Error::Overflow)?,
            Ok(_) => {},
            Err(SysError::IndexOutOfBound) => break,
            Err(error) => return Err(error.into()),
        }
        index += 1;
    }
    Ok(total)
}
fn current_admins(protocol_hash: &[u8; 32]) -> Result<Vec<[u8; 32]>, Error> {
    let mut found = None;
    for source in [Source::Input, Source::CellDep] {
        for index in type_indices(protocol_hash, source)? {
            // Ambiguous protocol sources must not select an advantageous grant.
            if found.is_some() { return Err(Error::InvalidProtocol); }
            found = Some(protocol_admins(&bounded_data(index, source)?)?);
        }
    }
    found.ok_or(Error::Unauthorized)
}
fn require_actor_spend(admins: &[[u8; 32]]) -> Result<(), Error> {
    let mut index = 0;
    loop {
        let lock = match load_cell_lock_hash(index, Source::Input) {
            Ok(value) => value,
            Err(SysError::IndexOutOfBound) => break,
            Err(error) => return Err(error.into()),
        };
        if admins.contains(&lock)
            && load_cell_type_hash(index, Source::Input)?.is_none()
            && data_size(index, Source::Input)? == 0
            // Includes typed cells: a capacity deposit cannot be hidden in a
            // same-lock UDT output to manufacture a privileged actor proof.
            && capacity_total(&lock, Source::Input)? > capacity_total(&lock, Source::Output)? {
            return Ok(());
        }
        index += 1;
    }
    Err(Error::Unauthorized)
}
pub fn validate() -> Result<(), Error> {
    let script = load_script()?;
    let args = script.args().raw_data();
    if args.len() != 64 { return Err(Error::InvalidArguments); }
    let type_id: [u8; 32] = args[..32].try_into().map_err(|_| Error::InvalidArguments)?;
    let protocol_hash: [u8; 32] = args[32..].try_into().map_err(|_| Error::InvalidArguments)?;
    if type_id == [0; 32] || protocol_hash == [0; 32] { return Err(Error::InvalidArguments); }
    let hash = load_script_hash()?;
    let inputs = type_indices(&hash, Source::Input)?;
    let outputs = type_indices(&hash, Source::Output)?;
    if inputs.len() > 1 || outputs.len() != 1 { return Err(Error::CellCount); }
    let output = outputs[0];
    if load_cell_type(output, Source::Output)?.as_ref() != Some(&script)
        || load_cell_lock(output, Source::Output)? != script { return Err(Error::ScriptMismatch); }
    let after_bytes = bounded_data(output, Source::Output)?;
    let after = decode_registry(&after_bytes)?;
    if let Some(&input) = inputs.first() {
        if load_cell_type(input, Source::Input)?.as_ref() != Some(&script)
            || load_cell_lock(input, Source::Input)? != script { return Err(Error::ScriptMismatch); }
        let before_bytes = bounded_data(input, Source::Input)?;
        let before = decode_registry(&before_bytes)?;
        validate_transition(Some(&before), &after, &protocol_hash)?;
    } else {
        let first = load_input(0, Source::Input)?;
        let mut hasher = Blake2bBuilder::new(32).personal(b"ckb-default-hash").build();
        hasher.update(first.as_slice());
        hasher.update(&(output as u64).to_le_bytes());
        let mut expected = [0u8; 32]; hasher.finalize(&mut expected);
        if expected != type_id { return Err(Error::InvalidTypeId); }
        validate_transition(None, &after, &protocol_hash)?;
    }
    require_actor_spend(&current_admins(&protocol_hash)?)
}
