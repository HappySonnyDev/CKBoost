//! Strict read-only parser for the existing six-field ProtocolData Molecule
//! layout. It checks every structural field, without importing/regenerating the
//! legacy generated Rust. Only INPUT/CellDep bytes are used by the entry point.
use alloc::vec::Vec;
use crate::Error;
const MAX_PROTOCOL_BYTES: usize = 131_072;
fn u32_at(bytes: &[u8], offset: usize) -> Result<usize, Error> {
    let end = offset.checked_add(4).ok_or(Error::InvalidProtocol)?;
    Ok(u32::from_le_bytes(bytes.get(offset..end).ok_or(Error::InvalidProtocol)?.try_into().map_err(|_| Error::InvalidProtocol)?) as usize)
}
fn fields(bytes: &[u8], count: usize) -> Result<Vec<&[u8]>, Error> {
    let header = count.checked_add(1).and_then(|n| n.checked_mul(4)).ok_or(Error::InvalidProtocol)?;
    if bytes.len() < header || u32_at(bytes, 0)? != bytes.len() || (count > 0 && u32_at(bytes, 4)? != header) { return Err(Error::InvalidProtocol); }
    let mut result = Vec::with_capacity(count);
    for index in 0..count {
        let start = u32_at(bytes, (index + 1) * 4)?;
        let end = if index + 1 == count { bytes.len() } else { u32_at(bytes, (index + 2) * 4)? };
        if start < header || end < start || end > bytes.len() { return Err(Error::InvalidProtocol); }
        result.push(&bytes[start..end]);
    }
    Ok(result)
}
fn table(bytes: &[u8], count: usize) -> Result<Vec<&[u8]>, Error> { fields(bytes, count) }
fn dynamic(bytes: &[u8]) -> Result<Vec<&[u8]>, Error> {
    if bytes.len() < 4 || u32_at(bytes, 0)? != bytes.len() { return Err(Error::InvalidProtocol); }
    if bytes.len() == 4 { return Ok(Vec::new()); }
    let first = u32_at(bytes, 4)?;
    if first < 8 || first % 4 != 0 || first > bytes.len() { return Err(Error::InvalidProtocol); }
    fields(bytes, first / 4 - 1)
}
fn fixed(bytes: &[u8], width: usize) -> Result<&[u8], Error> {
    let count = u32_at(bytes, 0)?;
    if count.checked_mul(width).and_then(|n| n.checked_add(4)) != Some(bytes.len()) { return Err(Error::InvalidProtocol); }
    Ok(&bytes[4..])
}
fn exact(bytes: &[u8], len: usize) -> Result<(), Error> { if bytes.len() == len { Ok(()) } else { Err(Error::InvalidProtocol) } }
fn script(bytes: &[u8]) -> Result<(), Error> {
    let parts = table(bytes, 3)?; exact(parts[0], 32)?; exact(parts[1], 1)?; fixed(parts[2], 1)?; Ok(())
}
pub fn protocol_admins(bytes: &[u8]) -> Result<Vec<[u8; 32]>, Error> {
    if bytes.len() > MAX_PROTOCOL_BYTES { return Err(Error::InvalidProtocol); }
    let protocol = table(bytes, 6)?;
    fixed(protocol[0], 32)?; fixed(protocol[1], 32)?;
    let tips = table(protocol[2], 2)?; fixed(tips[0], 16)?; exact(tips[1], 8)?;
    for endorser in dynamic(protocol[3])? {
        let value = table(endorser, 6)?; exact(value[0], 32)?;
        fixed(value[1], 1)?; fixed(value[2], 1)?; fixed(value[3], 1)?;
        for link in dynamic(value[4])? { fixed(link, 1)?; }
        exact(value[5], 1)?;
    }
    exact(protocol[4], 8)?;
    let config = table(protocol[5], 5)?;
    let admins = fixed(config[0], 32)?;
    let codes = table(config[1], 10)?;
    for value in &codes[..8] { exact(value, 32)?; }
    for collection in &codes[8..] { for value in dynamic(collection)? { script(value)?; } }
    exact(config[2], 8)?; exact(config[3], 16)?; fixed(config[4], 32)?;
    admins.chunks_exact(32).map(|hash| hash.try_into().map_err(|_| Error::InvalidProtocol)).collect()
}
