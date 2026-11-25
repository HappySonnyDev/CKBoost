#![cfg_attr(not(test), no_std)]
extern crate alloc;

pub mod registry_policy;
pub mod protocol;
#[cfg(feature = "onchain")]
pub mod onchain;

#[repr(i8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    InvalidArguments = 1,
    InvalidRegistryData = 2,
    InvalidProtocol = 3,
    InvalidTypeId = 4,
    CellCount = 5,
    ScriptMismatch = 6,
    Unauthorized = 7,
    InvalidRevision = 8,
    Overflow = 9,
    Syscall = 10,
}
