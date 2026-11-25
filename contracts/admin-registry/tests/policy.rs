mod common;
use common::{protocol, registry};
use ckboost_admin_registry::{protocol::protocol_admins,registry_policy::{decode_registry,validate_transition,MAX_BYTES,MAX_EXPIRATION_SECONDS},Error};
const HASH: [u8; 32] = [0x11; 32];
const META: &[u8] = b"{\"attestations\":[],\"periods\":[]}";
fn sample() -> Vec<u8> {registry(&HASH,0,2_592_000,&[100_000_000,u128::MAX],&[[0x22;32],[0x33;32]],META)}
#[test]
fn actual_frontend_codec_golden_has_exact_financial_prefix() {
    let golden=include_bytes!("fixtures/frontend-registry-v1.bin"); assert_eq!(sample(),golden);
    let data=decode_registry(golden).unwrap(); assert_eq!(data.protocol_hash,HASH); assert_eq!(data.revision,0);
    assert_eq!(data.thresholds,vec![100_000_000,u128::MAX]); assert_eq!(data.approvers,vec![[0x22;32],[0x33;32]]); assert_eq!(data.metadata,META);
}
#[test]
fn every_truncation_fails_without_panicking() {let good=sample();for end in 0..good.len(){assert!(decode_registry(&good[..end]).is_err(),"truncation {end}");}}
#[test]
fn wrong_magic_unknown_version_and_zero_protocol_fail() {let good=sample();for offset in [0,8]{let mut changed=good.clone();changed[offset]^=1;assert_eq!(decode_registry(&changed),Err(Error::InvalidRegistryData));}let mut changed=good;changed[12..44].fill(0);assert!(decode_registry(&changed).is_err());}
#[test]
fn thresholds_must_be_bounded_positive_and_strictly_increasing() {for values in [vec![0],vec![2,2],vec![3,2],vec![1;33]]{assert!(decode_registry(&registry(&HASH,0,0,&values,&[],META)).is_err());}assert!(decode_registry(&registry(&HASH,0,0,&[],&[],META)).is_ok());}
#[test]
fn approvers_must_be_bounded_unique_and_nonzero() {for approvers in [vec![[0;32]],vec![[1;32],[1;32]],vec![[1;32];513]]{assert!(decode_registry(&registry(&HASH,0,0,&[],&approvers,META)).is_err());}}
#[test]
fn expiry_is_bounded_but_zero_and_exact_ten_years_are_supported() {assert!(decode_registry(&registry(&HASH,0,0,&[],&[],META)).is_ok());assert!(decode_registry(&registry(&HASH,0,MAX_EXPIRATION_SECONDS,&[],&[],META)).is_ok());assert!(decode_registry(&registry(&HASH,0,MAX_EXPIRATION_SECONDS+1,&[],&[],META)).is_err());}
#[test]
fn metadata_is_opaque_bounded_and_never_overrides_binary_financial_fields() {let bytes=registry(&HASH,0,0,&[7],&[],b"{\"thresholds\":[0],\"admin\":true}");let data=decode_registry(&bytes).unwrap();assert_eq!(data.thresholds,vec![7]);let bytes=registry(&HASH,0,0,&[],&[],&vec![b'x';MAX_BYTES-72]);assert_eq!(bytes.len(),MAX_BYTES);assert!(decode_registry(&bytes).is_ok());let mut too_big=bytes;too_big.push(0);assert!(decode_registry(&too_big).is_err());}
#[test]
fn trailing_or_forged_lengths_fail() {let mut good=sample();good.push(0);assert!(decode_registry(&good).is_err());let mut changed=sample();let json_length=changed.len()-META.len()-4;changed[json_length..json_length+4].copy_from_slice(&u32::MAX.to_le_bytes());assert!(decode_registry(&changed).is_err());}
#[test]
fn creation_zero_then_exact_successor_no_reset_skip_or_overflow() {let b0=sample();let before=decode_registry(&b0).unwrap();assert_eq!(validate_transition(None,&before,&HASH),Ok(()));for revision in [0,2]{let bytes=registry(&HASH,revision,0,&[],&[],META);assert_eq!(validate_transition(Some(&before),&decode_registry(&bytes).unwrap(),&HASH),Err(Error::InvalidRevision));}let b1=registry(&HASH,1,0,&[],&[],META);let after=decode_registry(&b1).unwrap();assert_eq!(validate_transition(Some(&before),&after,&HASH),Ok(()));assert_eq!(validate_transition(None,&after,&HASH),Err(Error::InvalidRevision));let max=registry(&HASH,u64::MAX,0,&[],&[],META);assert_eq!(validate_transition(Some(&decode_registry(&max).unwrap()),&before,&HASH),Err(Error::InvalidRevision));assert_eq!(validate_transition(Some(&before),&after,&[9;32]),Err(Error::InvalidArguments));}
#[test]
fn actual_frontend_protocol_codec_golden_is_structurally_checked() {let golden=include_bytes!("fixtures/frontend-protocol-v1.bin");assert_eq!(protocol(&[[0x22;32],[0x33;32]]),golden);assert_eq!(protocol_admins(golden).unwrap(),vec![[0x22;32],[0x33;32]]);assert_eq!(protocol_admins(&protocol(&[])).unwrap(),Vec::<[u8;32]>::new());}
#[test]
fn malformed_full_protocol_tables_and_admin_vectors_fail() {let good=protocol(&[[0x22;32]]);for offset in [0,4]{let mut bytes=good.clone();bytes[offset]^=1;assert!(protocol_admins(&bytes).is_err());}let config=u32::from_le_bytes(good[24..28].try_into().unwrap())as usize;let admin_offset=u32::from_le_bytes(good[config+4..config+8].try_into().unwrap())as usize;let mut bad=good;bad[config+admin_offset..config+admin_offset+4].copy_from_slice(&2u32.to_le_bytes());assert!(protocol_admins(&bad).is_err());}
