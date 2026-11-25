use ckboost_admin_registry::registry_policy::RegistryData;
use ckboost_admin_tipping_policy::{declared_time, epoch_ms, validate_transition, Error, Tip};
const NOW: u64 = 1795600000000;
fn policy() -> RegistryData<'static> {
    RegistryData {
        protocol_hash: [9; 32],
        revision: 0,
        expiration_seconds: 86400,
        thresholds: vec![100],
        approvers: vec![[3; 32]],
        metadata: b"{}",
    }
}
fn created() -> Tip {
    Tip {
        target: [4; 32],
        proposer: [2; 32],
        supporters: vec![],
        metadata: vec![11, 22],
        rewards_data: vec![33, 44],
        created_at: NOW - 1000,
        ckb: 101,
        points: 1,
        udts: vec![],
        status: b"created".to_vec(),
        granted_at: 0,
    }
}
fn first() -> Tip {
    let mut tip = created();
    tip.supporters.push([1; 32]);
    tip.status = b"approved".to_vec();
    tip
}
#[test]
fn admin_first_then_independent_registry_approver() {
    let p = policy();
    let first = first();
    assert!(
        !validate_transition(
            Some(&created()),
            &first,
            &p,
            &[[1; 32]],
            &[[2; 32]],
            &[[1; 32]],
            NOW
        )
        .unwrap()
        .granting
    );
    let mut granted = first.clone();
    granted.supporters.push([3; 32]);
    granted.status = b"granted".to_vec();
    granted.granted_at = NOW;
    assert!(
        validate_transition(
            Some(&first),
            &granted,
            &p,
            &[[1; 32]],
            &[[2; 32]],
            &[[3; 32]],
            NOW
        )
        .unwrap()
        .granting
    );
}
#[test]
fn non_admin_approver_cannot_be_first_and_organizer_is_not_an_approver() {
    let p = policy();
    for actor in [[3; 32], [2; 32], [8; 32]] {
        let mut next = first();
        next.supporters[0] = actor;
        assert_eq!(
            validate_transition(
                Some(&created()),
                &next,
                &p,
                &[[1; 32]],
                &[[2; 32]],
                &[actor],
                NOW
            ),
            Err(Error::Unauthorized)
        );
    }
}
#[test]
fn every_new_supporter_needs_own_verified_capacity_spend_and_current_role() {
    let p = policy();
    assert_eq!(
        validate_transition(Some(&created()), &first(), &p, &[[1; 32]], &[], &[], NOW),
        Err(Error::Unauthorized)
    );
    let old = first();
    let mut next = old.clone();
    next.supporters.push([3; 32]);
    next.status = b"granted".to_vec();
    next.granted_at = NOW;
    let mut revoked = p;
    revoked.approvers.clear();
    assert_eq!(
        validate_transition(
            Some(&old),
            &next,
            &revoked,
            &[[1; 32]],
            &[],
            &[[3; 32]],
            NOW
        ),
        Err(Error::Unauthorized)
    );
}
#[test]
fn preserve_immutable_payload_prefix_distinct_supporters_and_terminal_state() {
    let p = policy();
    let old = first();
    for mode in 0..5 {
        let mut next = old.clone();
        next.supporters.push([3; 32]);
        next.status = b"granted".to_vec();
        next.granted_at = NOW;
        match mode {
            0 => next.target = [8; 32],
            1 => next.metadata.push(0),
            2 => next.points += 1,
            3 => next.supporters[0] = [8; 32],
            _ => next.supporters[1] = [1; 32],
        };
        assert!(
            validate_transition(Some(&old), &next, &p, &[[1; 32]], &[], &[[3; 32]], NOW).is_err()
        );
    }
    let mut granted = old.clone();
    granted.status = b"granted".to_vec();
    granted.granted_at = NOW;
    assert!(validate_transition(
        Some(&granted),
        &granted,
        &p,
        &[[1; 32]],
        &[],
        &[[1; 32]],
        NOW
    )
    .is_err());
}
#[test]
fn expiry_is_signed_application_policy_with_exact_boundary_and_never_zero() {
    let mut p = policy();
    let mut old = created();
    let mut next = first();
    old.created_at = NOW - 86400000;
    next.created_at = old.created_at;
    assert_eq!(
        validate_transition(Some(&old), &next, &p, &[[1; 32]], &[], &[[1; 32]], NOW),
        Err(Error::Expired)
    );
    p.expiration_seconds = 0;
    assert!(validate_transition(Some(&old), &next, &p, &[[1; 32]], &[], &[[1; 32]], NOW).is_ok());
    next.created_at = NOW + 1;
    assert_eq!(
        validate_transition(None, &next, &p, &[[1; 32]], &[], &[[1; 32]], NOW),
        Err(Error::InvalidTimestamp)
    );
}
#[test]
fn timestamps_accept_legacy_seconds_but_recipe_time_requires_exact_eight_byte_milliseconds() {
    assert_eq!(epoch_ms(NOW / 1000), Ok(NOW));
    assert_eq!(declared_time(&NOW.to_le_bytes()), Ok(NOW));
    assert_eq!(
        declared_time(&(NOW / 1000).to_le_bytes()),
        Err(Error::InvalidTimestamp)
    );
    for raw in [
        &[][..],
        &[0; 7][..],
        &[0; 9][..],
        &u64::MAX.to_le_bytes()[..],
    ] {
        assert!(declared_time(raw).is_err());
    }
}
#[test]
fn final_grant_timestamp_is_bound_to_the_signed_declaration() {
    let p = policy();
    let old = first();
    let mut next = old.clone();
    next.supporters.push([3; 32]);
    next.status = b"granted".to_vec();
    for stamp in [0, NOW - 1, NOW + 1] {
        next.granted_at = stamp;
        assert_eq!(
            validate_transition(Some(&old), &next, &p, &[[1; 32]], &[], &[[3; 32]], NOW),
            Err(Error::InvalidTransition)
        );
    }
}
#[test]
fn creation_retains_admin_or_whitelisted_organizer_but_never_creates_approvals() {
    let p = policy();
    let tip = created();
    assert!(validate_transition(None, &tip, &p, &[[1; 32]], &[[2; 32]], &[[2; 32]], NOW).is_ok());
    assert!(validate_transition(None, &tip, &p, &[[1; 32]], &[], &[[2; 32]], NOW).is_err());
    let mut next = tip.clone();
    next.supporters.push([1; 32]);
    assert!(validate_transition(None, &next, &p, &[[1; 32]], &[[2; 32]], &[[2; 32]], NOW).is_err());
}
