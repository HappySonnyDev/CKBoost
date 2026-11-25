#![allow(dead_code)]
pub fn registry(protocol: &[u8; 32], revision: u64, expiry: u64, thresholds: &[u128], approvers: &[[u8; 32]], metadata: &[u8]) -> Vec<u8> {
    let mut bytes = b"CKBADMIN".to_vec(); bytes.extend(1u32.to_le_bytes()); bytes.extend(protocol);
    bytes.extend(revision.to_le_bytes()); bytes.extend(expiry.to_le_bytes()); bytes.extend((thresholds.len() as u32).to_le_bytes());
    for value in thresholds {bytes.extend(value.to_le_bytes());} bytes.extend((approvers.len() as u32).to_le_bytes());
    for value in approvers {bytes.extend(value);} bytes.extend((metadata.len() as u32).to_le_bytes()); bytes.extend(metadata); bytes
}
pub fn table(parts: Vec<Vec<u8>>) -> Vec<u8> {
    let header = (parts.len() + 1) * 4; let size = header + parts.iter().map(Vec::len).sum::<usize>();
    let mut bytes = (size as u32).to_le_bytes().to_vec(); let mut offset = header;
    for part in &parts {bytes.extend((offset as u32).to_le_bytes()); offset += part.len();}
    for part in parts {bytes.extend(part);} bytes
}
pub fn hashes(values: &[[u8; 32]]) -> Vec<u8> {let mut bytes=(values.len() as u32).to_le_bytes().to_vec(); for hash in values {bytes.extend(hash);} bytes}
pub fn protocol(admins: &[[u8; 32]]) -> Vec<u8> {
    let mut codes = vec![vec![0x31; 32]; 8]; codes.push(4u32.to_le_bytes().to_vec()); codes.push(4u32.to_le_bytes().to_vec());
    let config = table(vec![hashes(admins), table(codes), 0u64.to_le_bytes().to_vec(), 0u128.to_le_bytes().to_vec(), hashes(&[])]);
    let tipping = table(vec![0u32.to_le_bytes().to_vec(), 2_592_000u64.to_le_bytes().to_vec()]);
    table(vec![hashes(&[]),hashes(&[]),tipping,4u32.to_le_bytes().to_vec(),1_700_000_000u64.to_le_bytes().to_vec(),config])
}
