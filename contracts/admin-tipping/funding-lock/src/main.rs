#![no_std]
#![no_main]
ckb_std::entry!(program_entry);
ckb_std::default_alloc!(16384, 1258306, 64);
fn program_entry() -> i8 {
    let result = if ckboost_admin_tipping_policy::onchain::is_tipping_method() {
        ckboost_admin_tipping_policy::onchain::validate_funding()
    } else {
        ckboost_admin_tipping_policy::onchain::validate_campaign_funding()
    };
    match result {
        Ok(()) => 0,
        Err(error) => {
            ckb_std::syscalls::debug(alloc::format!("QA funding rejected: {:?}", error));
            1
        }
    }
}
