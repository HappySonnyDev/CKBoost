#![no_std]
#![no_main]
ckb_std::entry!(program_entry);
ckb_std::default_alloc!(16384, 1258306, 64);
fn program_entry() -> i8 {match ckboost_admin_registry::onchain::validate() {Ok(()) => 0, Err(error) => error as i8}}
