extern crate alloc;
use ckboost_shared::Error;
pub fn fallback() -> Result<(), Error> {
    ckboost_admin_tipping_policy::onchain::validate_tipping().map_err(|error| {
        ckb_std::syscalls::debug(alloc::format!("QA tipping policy rejected: {:?}",error));
        Error::UnauthorizedOperation
    })
}
