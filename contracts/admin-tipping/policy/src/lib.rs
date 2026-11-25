#![no_std]
extern crate alloc;
use alloc::vec::Vec;
use ckboost_admin_registry::registry_policy::RegistryData;
use ckboost_shared::types::{Script, TippingData};
use molecule::prelude::*;
#[cfg(feature = "onchain")]
pub mod onchain;
include!(concat!(env!("OUT_DIR"), "/registry_anchor.rs"));

pub const MAX_SUPPORTERS: usize = 513;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    MissingAnchor,
    InvalidScope,
    InvalidRegistry,
    InvalidTip,
    InvalidTransition,
    Unauthorized,
    InvalidTimestamp,
    Expired,
    InvalidAsset,
    InvalidAmount,
    InvalidPayout,
    InvalidRecipe,
    Syscall,
}
#[derive(Clone, Debug)]
pub struct Reward {
    pub script: Script,
    pub amount: u128,
}
impl PartialEq for Reward {
    fn eq(&self, other: &Self) -> bool {
        self.amount == other.amount && self.script.as_slice() == other.script.as_slice()
    }
}
impl Eq for Reward {}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tip {
    pub target: [u8; 32],
    pub proposer: [u8; 32],
    pub supporters: Vec<[u8; 32]>,
    pub metadata: Vec<u8>,
    pub rewards_data: Vec<u8>,
    pub created_at: u64,
    pub ckb: u128,
    pub points: u128,
    pub udts: Vec<Reward>,
    pub status: Vec<u8>,
    pub granted_at: u64,
}
fn array32(bytes: &[u8]) -> Result<[u8; 32], Error> {
    bytes.try_into().map_err(|_| Error::InvalidTip)
}
fn u64num(bytes: &[u8]) -> Result<u64, Error> {
    Ok(u64::from_le_bytes(
        bytes.try_into().map_err(|_| Error::InvalidAmount)?,
    ))
}
fn u128num(bytes: &[u8]) -> Result<u128, Error> {
    Ok(u128::from_le_bytes(
        bytes.try_into().map_err(|_| Error::InvalidAmount)?,
    ))
}
pub fn decode_tip(bytes: &[u8]) -> Result<Tip, Error> {
    let data = TippingData::from_slice(bytes).map_err(|_| Error::InvalidTip)?;
    let rewards = data.rewards();
    if rewards.nft_assets().len() != 0 {
        return Err(Error::InvalidAsset);
    }
    let supporters = data
        .supporter_lock_hashes()
        .into_iter()
        .map(|h| array32(h.as_slice()))
        .collect::<Result<Vec<_>, _>>()?;
    if supporters.len() > MAX_SUPPORTERS
        || supporters
            .iter()
            .enumerate()
            .any(|(i, h)| *h == [0; 32] || supporters[..i].contains(h))
    {
        return Err(Error::InvalidTip);
    }
    let mut udts: Vec<Reward> = Vec::new();
    for reward in rewards.udt_assets().into_iter() {
        let amount = u128num(reward.amount().as_slice())?;
        if amount == 0 {
            return Err(Error::InvalidAmount);
        }
        let script = reward.udt_script();
        match udts
            .iter_mut()
            .find(|r| r.script.as_slice() == script.as_slice())
        {
            Some(r) => r.amount = r.amount.checked_add(amount).ok_or(Error::InvalidAmount)?,
            None => udts.push(Reward { script, amount }),
        }
    }
    let result = Tip {
        target: array32(data.target_lock_hash().as_slice())?,
        proposer: array32(data.proposer_lock_hash().as_slice())?,
        supporters,
        metadata: data.metadata().as_slice().to_vec(),
        rewards_data: rewards.as_slice().to_vec(),
        created_at: u64num(data.metadata().creation_timestamp().as_slice())?,
        ckb: u128num(rewards.ckb_amount().as_slice())?,
        points: u128num(rewards.points_amount().as_slice())?,
        udts,
        status: data.status().raw_data().to_vec(),
        granted_at: u64num(data.granted_at().as_slice())?,
    };
    if result.target == [0; 32]
        || result.proposer == [0; 32]
        || result.ckb > u64::MAX as u128
        || result.ckb == 0 && result.points == 0 && result.udts.is_empty()
    {
        return Err(Error::InvalidTip);
    }
    Ok(result)
}
/// Explicit signed time declaration; not a consensus clock or hard upper-time bound.
pub fn epoch_ms(value: u64) -> Result<u64, Error> {
    if (946684800..=4102444800).contains(&value) {
        return value.checked_mul(1000).ok_or(Error::InvalidTimestamp);
    }
    if (946684800000..=4102444800000).contains(&value) {
        return Ok(value);
    }
    Err(Error::InvalidTimestamp)
}
pub fn declared_time(raw: &[u8]) -> Result<u64, Error> {
    if raw.len() != 8 {
        return Err(Error::InvalidTimestamp);
    }
    let value = u64num(raw)?;
    if epoch_ms(value)? != value {
        return Err(Error::InvalidTimestamp);
    }
    Ok(value)
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Transition {
    pub actor: [u8; 32],
    pub granting: bool,
}
pub fn validate_transition(
    before: Option<&Tip>,
    after: &Tip,
    policy: &RegistryData<'_>,
    admins: &[[u8; 32]],
    organizers: &[[u8; 32]],
    signed_actors: &[[u8; 32]],
    now_ms: u64,
) -> Result<Transition, Error> {
    if after.supporters.len() > MAX_SUPPORTERS
        || after
            .supporters
            .iter()
            .enumerate()
            .any(|(i, h)| *h == [0; 32] || after.supporters[..i].contains(h))
    {
        return Err(Error::InvalidTip);
    }
    if epoch_ms(now_ms)? != now_ms {
        return Err(Error::InvalidTimestamp);
    }
    let creation = epoch_ms(after.created_at)?;
    if creation > now_ms {
        return Err(Error::InvalidTimestamp);
    }
    if policy.expiration_seconds != 0
        && now_ms
            >= creation
                .checked_add(
                    policy
                        .expiration_seconds
                        .checked_mul(1000)
                        .ok_or(Error::InvalidTimestamp)?,
                )
                .ok_or(Error::InvalidTimestamp)?
    {
        return Err(Error::Expired);
    }
    let actor = match before {
        None => {
            if !after.supporters.is_empty()
                || after.status != b"created"
                || after.granted_at != 0
                || !admins.contains(&after.proposer) && !organizers.contains(&after.proposer)
            {
                return Err(Error::InvalidTransition);
            }
            after.proposer
        }
        Some(old) => {
            if old.status
                != if old.supporters.is_empty() {
                    b"created".as_slice()
                } else {
                    b"approved".as_slice()
                }
                || old.granted_at != 0
                || old.target != after.target
                || old.proposer != after.proposer
                || old.metadata != after.metadata
                || old.rewards_data != after.rewards_data
                || old.ckb != after.ckb
                || old.points != after.points
                || old.udts != after.udts
                || after.supporters.len() != old.supporters.len() + 1
                || !after.supporters.starts_with(&old.supporters)
            {
                return Err(Error::InvalidTransition);
            }
            let actor = *after.supporters.last().ok_or(Error::InvalidTransition)?;
            if old.supporters.is_empty() {
                if !admins.contains(&actor) {
                    return Err(Error::Unauthorized);
                }
            } else if !admins.contains(&actor) && !policy.approvers.contains(&actor) {
                return Err(Error::Unauthorized);
            }
            actor
        }
    };
    if !signed_actors.contains(&actor) {
        return Err(Error::Unauthorized);
    }
    let granting = before.is_some()
        && after.supporters.len()
            >= 1 + policy
                .thresholds
                .iter()
                .filter(|t| after.ckb >= **t)
                .count();
    if before.is_some() {
        let expected = if granting {
            b"granted".as_slice()
        } else {
            b"approved".as_slice()
        };
        if after.status != expected
            || if granting {
                after.granted_at != now_ms
            } else {
                after.granted_at != 0
            }
        {
            return Err(Error::InvalidTransition);
        }
    }
    Ok(Transition { actor, granting })
}
