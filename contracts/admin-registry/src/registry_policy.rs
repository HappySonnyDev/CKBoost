//! Exact financial policy prefix shared with the dApp's Admin Registry v1.
//! Metadata is bounded opaque bytes. It never grants script authority and is
//! never interpreted as financial settings. The application validates its JSON.
use alloc::vec::Vec;
use crate::Error;

pub const MAGIC: &[u8; 8] = b"CKBADMIN";
pub const VERSION: u32 = 1;
pub const MAX_BYTES: usize = 131_072;
pub const MAX_APPROVERS: usize = 512;
pub const MAX_THRESHOLDS: usize = 32;
pub const MAX_EXPIRATION_SECONDS: u64 = 3650 * 86400;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryData<'a> {
    pub protocol_hash: [u8; 32],
    pub revision: u64,
    pub expiration_seconds: u64,
    pub thresholds: Vec<u128>,
    pub approvers: Vec<[u8; 32]>,
    pub metadata: &'a [u8],
}
struct Reader<'a> { bytes: &'a [u8], offset: usize }
impl<'a> Reader<'a> {
    fn take(&mut self, size: usize) -> Result<&'a [u8], Error> {
        let end = self.offset.checked_add(size).ok_or(Error::InvalidRegistryData)?;
        let value = self.bytes.get(self.offset..end).ok_or(Error::InvalidRegistryData)?;
        self.offset = end;
        Ok(value)
    }
    fn u32(&mut self) -> Result<u32, Error> { Ok(u32::from_le_bytes(self.take(4)?.try_into().map_err(|_| Error::InvalidRegistryData)?)) }
    fn u64(&mut self) -> Result<u64, Error> { Ok(u64::from_le_bytes(self.take(8)?.try_into().map_err(|_| Error::InvalidRegistryData)?)) }
    fn u128(&mut self) -> Result<u128, Error> { Ok(u128::from_le_bytes(self.take(16)?.try_into().map_err(|_| Error::InvalidRegistryData)?)) }
}
pub fn decode_registry(bytes: &[u8]) -> Result<RegistryData<'_>, Error> {
    if bytes.len() > MAX_BYTES { return Err(Error::InvalidRegistryData); }
    let mut reader = Reader { bytes, offset: 0 };
    if reader.take(8)? != MAGIC || reader.u32()? != VERSION { return Err(Error::InvalidRegistryData); }
    let protocol_hash: [u8; 32] = reader.take(32)?.try_into().map_err(|_| Error::InvalidRegistryData)?;
    if protocol_hash == [0; 32] { return Err(Error::InvalidRegistryData); }
    let revision = reader.u64()?;
    let expiration_seconds = reader.u64()?;
    if expiration_seconds > MAX_EXPIRATION_SECONDS { return Err(Error::InvalidRegistryData); }
    let count = reader.u32()? as usize;
    if count > MAX_THRESHOLDS { return Err(Error::InvalidRegistryData); }
    let mut thresholds = Vec::with_capacity(count);
    for _ in 0..count {
        let value = reader.u128()?;
        if value == 0 || thresholds.last().map_or(false, |previous| value <= *previous) { return Err(Error::InvalidRegistryData); }
        thresholds.push(value);
    }
    let count = reader.u32()? as usize;
    if count > MAX_APPROVERS { return Err(Error::InvalidRegistryData); }
    let mut approvers = Vec::with_capacity(count);
    for _ in 0..count {
        let value: [u8; 32] = reader.take(32)?.try_into().map_err(|_| Error::InvalidRegistryData)?;
        if value == [0; 32] || approvers.contains(&value) { return Err(Error::InvalidRegistryData); }
        approvers.push(value);
    }
    let length = reader.u32()? as usize;
    let metadata = reader.take(length)?;
    if reader.offset != bytes.len() { return Err(Error::InvalidRegistryData); }
    Ok(RegistryData {protocol_hash, revision, expiration_seconds, thresholds, approvers, metadata})
}
/// Creation must begin at zero; neither a reset nor a skipped revision is an update.
pub fn validate_transition(before: Option<&RegistryData<'_>>, after: &RegistryData<'_>, protocol_hash: &[u8; 32]) -> Result<(), Error> {
    if after.protocol_hash != *protocol_hash { return Err(Error::InvalidArguments); }
    match before {
        None if after.revision == 0 => Ok(()),
        Some(previous) if previous.protocol_hash == *protocol_hash && previous.revision.checked_add(1) == Some(after.revision) => Ok(()),
        _ => Err(Error::InvalidRevision),
    }
}
