#![cfg(feature = "vm-tests")]
mod common;
use common::{protocol, registry};
use ckboost_admin_registry::Error;
use ckb_testtool::{
    builtin::ALWAYS_SUCCESS, ckb_crypto::secp::Privkey,
    ckb_hash::{blake2b_256, new_blake2b},
    ckb_script::{ScriptError, TransactionScriptError},
    ckb_types::{bytes::Bytes, core::{TransactionBuilder, TransactionView}, packed::*, prelude::*, H256},
    context::Context,
};
const CKB:u64=100_000_000;
const MAX_CYCLES:u64=200_000_000;
const META:&[u8]=b"{\"attestations\":[],\"periods\":[]}";
fn file(env:&str,name:Option<&str>)->Bytes{let mut path=std::path::PathBuf::from(std::env::var(env).expect(env));if let Some(name)=name{path.push(name);}std::fs::read(path).expect("explicit locally built/pinned binary").into()}
fn dep(point:OutPoint)->CellDep{CellDep::new_builder().out_point(point).build()}
fn output(lock:&Script,capacity:u64,type_:Option<Script>)->CellOutput{CellOutput::new_builder().capacity((capacity*CKB).pack()).lock(lock.clone()).type_(type_.pack()).build()}
fn input(context:&mut Context,lock:&Script,capacity:u64,type_:Option<Script>,data:Bytes)->CellInput{CellInput::new_builder().previous_output(context.create_cell(output(lock,capacity,type_),data)).build()}
fn type_id(first:&CellInput,index:u64)->[u8;32]{let mut data=first.as_slice().to_vec();data.extend(index.to_le_bytes());blake2b_256(data)}
fn lock_hash(script:&Script)->[u8;32]{script.calc_script_hash().as_slice().try_into().unwrap()}
fn sign_group(tx:TransactionView,key:&Privkey,indices:&[usize])->TransactionView{
 let first=indices[0];let mut witnesses:Vec<Bytes>=tx.witnesses().into_iter().map(|w|w.raw_data()).collect();witnesses.resize(witnesses.len().max(tx.inputs().len()),Bytes::new());let original=if witnesses[first].is_empty(){WitnessArgs::default()}else{WitnessArgs::from_slice(&witnesses[first]).unwrap()};let zeroed=original.clone().as_builder().lock(Some(Bytes::from(vec![0;65])).pack()).build().as_bytes();let mut hasher=new_blake2b();hasher.update(tx.hash().as_slice());hasher.update(&(zeroed.len()as u64).to_le_bytes());hasher.update(&zeroed);for index in indices.iter().skip(1).copied().chain(tx.inputs().len()..witnesses.len()){let witness=&witnesses[index];hasher.update(&(witness.len()as u64).to_le_bytes());hasher.update(witness);}let mut message=[0;32];hasher.finalize(&mut message);let signature=key.sign_recoverable(&H256::from(message)).unwrap();witnesses[first]=original.as_builder().lock(Some(Bytes::from(signature.serialize())).pack()).build().as_bytes();tx.as_advanced_builder().set_witnesses(witnesses.into_iter().map(|w|w.pack()).collect()).build()
}
struct Setup{context:Context,key:Privkey,actor:Script,sponsor:Script,protocol_type:Script,protocol_point:OutPoint,registry:Script,actor_input:CellInput,registry_dep:CellDep,protocol_dep:CellDep,secp_dep:Option<CellDep>,protocol_hash:[u8;32]}
fn setup(acp:bool)->Setup{
 let mut context=Context::default();context.set_capture_debug(true);let always=context.deploy_cell(ALWAYS_SUCCESS.clone());let code=context.deploy_cell(file("CKBOOST_ADMIN_REGISTRY_BIN",None));let key=Privkey::from_slice(&[1;32]); // Synthetic fixture, never a live account/key.
 let actor=if acp{let binary=context.deploy_cell(file("CKBOOST_ACP_ASSET_DIR",Some("anyone_can_pay")));let pubkey=key.pubkey().unwrap().serialize();context.build_script(&binary,Bytes::copy_from_slice(&blake2b_256(pubkey)[..20])).unwrap()}else{context.build_script(&always,Bytes::from(vec![1])).unwrap()};
 let sponsor=context.build_script(&always,Bytes::from(vec![2])).unwrap();let protocol_type=context.build_script(&always,Bytes::from(vec![9;32])).unwrap();let protocol_hash=lock_hash(&protocol_type);let protocol_point=context.create_cell(output(&sponsor,2000,Some(protocol_type.clone())),Bytes::from(protocol(&[lock_hash(&actor)])));let protocol_dep=dep(protocol_point.clone());let actor_input=input(&mut context,&actor,1000,None,Bytes::new());let mut args=type_id(&actor_input,0).to_vec();args.extend(protocol_hash);let registry=context.build_script(&code,Bytes::from(args)).unwrap();let secp_dep=if acp{Some(dep(context.deploy_cell(file("CKBOOST_ACP_ASSET_DIR",Some("secp256k1_data")))))}else{None};
 Setup{context,key,actor,sponsor,protocol_type,protocol_point,registry,actor_input,registry_dep:dep(code),protocol_dep,secp_dep,protocol_hash}
}
fn dependencies(s:&Setup,include_protocol:bool)->Vec<CellDep>{let mut result=vec![s.registry_dep.clone()];if include_protocol{result.push(s.protocol_dep.clone());}if let Some(dep)=&s.secp_dep{result.push(dep.clone());}result}
fn creation(s:&mut Setup,actor_output:u64)->TransactionView{
 let mut builder=TransactionBuilder::default().input(s.actor_input.clone()).cell_deps(dependencies(s,true));let policy=registry(&s.protocol_hash,0,2_592_000,&[100_000_000],&[],META);
 builder=builder.output(output(&s.registry,400,Some(s.registry.clone()))).output_data(Bytes::from(policy).pack()).output(output(&s.actor,actor_output,None)).output_data(Bytes::new().pack());
 if actor_output>599{builder=builder.input(input(&mut s.context,&s.sponsor,1000,None,Bytes::new())).output(output(&s.sponsor,1599-actor_output,None)).output_data(Bytes::new().pack());}
 s.context.complete_tx(builder.build())
}
fn old_registry(s:&mut Setup,revision:u64)->CellInput{input(&mut s.context,&s.registry,400,Some(s.registry.clone()),Bytes::from(registry(&s.protocol_hash,revision,2_592_000,&[100_000_000],&[],META)))}
fn update(s:&mut Setup,revision:u64,actor_output:u64)->TransactionView{
 let old=old_registry(s,0);let mut builder=TransactionBuilder::default().input(old).input(s.actor_input.clone()).cell_deps(dependencies(s,true)).output(output(&s.registry,400,Some(s.registry.clone()))).output_data(Bytes::from(registry(&s.protocol_hash,revision,604800,&[100_000_000,200_000_000],&[lock_hash(&s.actor)],META)).pack()).output(output(&s.actor,actor_output,None)).output_data(Bytes::new().pack());
 if actor_output>999{builder=builder.input(input(&mut s.context,&s.sponsor,1000,None,Bytes::new())).output(output(&s.sponsor,1999-actor_output,None)).output_data(Bytes::new().pack());}
 s.context.complete_tx(builder.build())
}
fn reject(s:&Setup,tx:&TransactionView,code:Error){let error=s.context.verify_tx(tx,MAX_CYCLES).expect_err("real registry binary must reject");let failure=error.root_cause().downcast_ref::<TransactionScriptError>().expect("actual VM script failure");match failure.script_error(){ScriptError::ValidationFailure(_,value)=>assert_eq!(*value,code as i8,"{failure:?}"),other=>panic!("unexpected script error {other:?}")}}
#[test]
fn creation_type_invocation_requires_admin_and_new_type_id(){let mut s=setup(false);let tx=creation(&mut s,599);s.context.verify_tx(&tx,MAX_CYCLES).unwrap();let original=s.registry.clone();let mut args=original.args().raw_data().to_vec();args[0]^=1;let wrong=original.as_builder().args(Bytes::from(args).pack()).build();let bad=tx.as_advanced_builder().set_outputs(vec![output(&wrong,400,Some(wrong.clone())),output(&s.actor,599,None)]).build();reject(&s,&bad,Error::InvalidTypeId);}
#[test]
fn creation_type_script_enforces_the_identical_output_lock(){let mut s=setup(false);let tx=creation(&mut s,599);let bad=tx.as_advanced_builder().set_outputs(vec![output(&s.actor,400,Some(s.registry.clone())),output(&s.actor,599,None)]).build();reject(&s,&bad,Error::ScriptMismatch);}
#[test]
fn update_requires_exact_successor_and_keeps_type_and_lock(){let mut s=setup(false);let tx=update(&mut s,1,999);s.context.verify_tx(&tx,MAX_CYCLES).unwrap();for revision in [0,2]{let mut bad=tx.outputs_data().into_iter().collect::<Vec<_>>();bad[0]=Bytes::from(registry(&s.protocol_hash,revision,0,&[],&[],META)).pack();reject(&s,&tx.as_advanced_builder().set_outputs_data(bad).build(),Error::InvalidRevision);}let bad=tx.as_advanced_builder().set_outputs(vec![output(&s.actor,400,Some(s.registry.clone())),output(&s.actor,999,None)]).build();reject(&s,&bad,Error::ScriptMismatch);}
#[test]
fn registry_cannot_be_destroyed_duplicated_or_replaced_by_another_type(){let mut s=setup(false);let tx=update(&mut s,1,999);let destroyed=tx.as_advanced_builder().set_outputs(vec![output(&s.actor,1399,None)]).set_outputs_data(vec![Bytes::new().pack()]).build();reject(&s,&destroyed,Error::CellCount);let duplicated=tx.as_advanced_builder().output(output(&s.registry,400,Some(s.registry.clone()))).output_data(Bytes::from(registry(&s.protocol_hash,1,0,&[],&[],META)).pack()).build();reject(&s,&duplicated,Error::CellCount);let mut changed_args=s.registry.args().raw_data().to_vec();changed_args[0]^=1;let changed=s.registry.clone().as_builder().args(Bytes::from(changed_args).pack()).build();let replaced=tx.as_advanced_builder().set_outputs(vec![output(&changed,400,Some(changed.clone())),output(&s.actor,999,None)]).build();reject(&s,&replaced,Error::CellCount);}
#[test]
fn financial_encoding_and_protocol_binding_are_enforced_in_the_vm(){let mut s=setup(false);let tx=update(&mut s,1,999);for bytes in [registry(&s.protocol_hash,1,0,&[0],&[],META),registry(&s.protocol_hash,1,0,&[2,1],&[],META),registry(&s.protocol_hash,1,0,&[],&[[0;32]],META),registry(&s.protocol_hash,1,315_360_001,&[],&[],META)]{let mut data=tx.outputs_data().into_iter().collect::<Vec<_>>();data[0]=Bytes::from(bytes).pack();reject(&s,&tx.as_advanced_builder().set_outputs_data(data).build(),Error::InvalidRegistryData);}let mut data=tx.outputs_data().into_iter().collect::<Vec<_>>();data[0]=Bytes::from(registry(&[8;32],1,0,&[],&[],META)).pack();reject(&s,&tx.as_advanced_builder().set_outputs_data(data).build(),Error::InvalidArguments);}
#[test]
fn foreign_protocol_or_output_self_grants_never_authorize(){let mut s=setup(false);let tx=creation(&mut s,599);let fake_type=s.protocol_type.clone().as_builder().args(Bytes::from(vec![10;32]).pack()).build();let fake_point=s.context.create_cell(output(&s.sponsor,2000,Some(fake_type)),Bytes::from(protocol(&[lock_hash(&s.actor)])));let mut deps=dependencies(&s,false);deps.push(dep(fake_point));let foreign=s.context.complete_tx(tx.as_advanced_builder().set_cell_deps(deps).build());reject(&s,&foreign,Error::Unauthorized);
 // An existing protocol input that does NOT grant the actor is authoritative;
 // adding the actor only to its output must not grant this same transaction.
 s.context.create_cell_with_out_point(s.protocol_point.clone(),output(&s.sponsor,2000,Some(s.protocol_type.clone())),Bytes::from(protocol(&[[7;32]])));
 let self_grant=tx.as_advanced_builder().input(CellInput::new_builder().previous_output(s.protocol_point.clone()).build()).output(output(&s.sponsor,2000,Some(s.protocol_type.clone()))).output_data(Bytes::from(protocol(&[lock_hash(&s.actor)])).pack()).set_cell_deps(dependencies(&s,false)).build();let self_grant=s.context.complete_tx(self_grant);reject(&s,&self_grant,Error::Unauthorized);}
#[test]
fn input_protocol_admin_is_valid_without_a_dependency_or_output_authority(){let mut s=setup(false);let tx=creation(&mut s,599);let tx=tx.as_advanced_builder().input(CellInput::new_builder().previous_output(s.protocol_point.clone()).build()).output(output(&s.sponsor,2000,Some(s.protocol_type.clone()))).output_data(Bytes::from(protocol(&[])).pack()).set_cell_deps(dependencies(&s,false)).build();let tx=s.context.complete_tx(tx);s.context.verify_tx(&tx,MAX_CYCLES).unwrap();}
#[test]
fn real_acp_unsigned_deposit_passes_the_wallet_lock_but_not_registry_admin_creation(){let mut s=setup(true);let sponsor_input=input(&mut s.context,&s.sponsor,1000,None,Bytes::new());let control=TransactionBuilder::default().input(s.actor_input.clone()).input(sponsor_input).output(output(&s.actor,1001,None)).output_data(Bytes::new().pack()).output(output(&s.sponsor,998,None)).output_data(Bytes::new().pack()).cell_deps(dependencies(&s,false)).build();let control=s.context.complete_tx(control);s.context.verify_tx(&control,MAX_CYCLES).expect("real ACP deposit branch, no witness/signature");let attack=creation(&mut s,1001);reject(&s,&attack,Error::Unauthorized);}
#[test]
fn real_acp_signed_net_spend_can_create_and_update_but_unsigned_net_spend_fails_wallet_lock(){let mut creation_setup=setup(true);let unsigned=creation(&mut creation_setup,599);let error=creation_setup.context.verify_tx(&unsigned,MAX_CYCLES).unwrap_err();let failure=error.root_cause().downcast_ref::<TransactionScriptError>().unwrap();assert!(format!("{}",failure.originating_script()).starts_with("Inputs[0].Lock"),"actual ACP must reject the missing signature: {failure:?}");let signed=sign_group(unsigned,&creation_setup.key,&[0]);creation_setup.context.verify_tx(&signed,MAX_CYCLES).unwrap();let mut update_setup=setup(true);let tx=update(&mut update_setup,1,999);let signed=sign_group(tx,&update_setup.key,&[1]);update_setup.context.verify_tx(&signed,MAX_CYCLES).unwrap();}
#[test]
fn real_acp_unsigned_deposit_cannot_authorize_registry_update(){let mut s=setup(true);let tx=update(&mut s,1,1001);reject(&s,&tx,Error::Unauthorized);}
#[test]
fn signed_actor_must_spend_capacity_across_typed_and_plain_outputs_together(){let mut s=setup(true);let mut tx=update(&mut s,1,999);let typed_type=s.protocol_type.clone().as_builder().args(Bytes::from(vec![31;32]).pack()).build();let typed_input=input(&mut s.context,&s.actor,1000,Some(typed_type.clone()),Bytes::from(1u128.to_le_bytes().to_vec()));let sponsor=input(&mut s.context,&s.sponsor,1000,None,Bytes::new());tx=tx.as_advanced_builder().input(typed_input).input(sponsor).output(output(&s.actor,1002,Some(typed_type))).output_data(Bytes::from(1u128.to_le_bytes().to_vec()).pack()).output(output(&s.sponsor,998,None)).output_data(Bytes::new().pack()).build();tx=s.context.complete_tx(tx);let signed=sign_group(tx,&s.key,&[1,2]);reject(&s,&signed,Error::Unauthorized);}
#[test]
fn typed_only_admin_spending_is_not_a_plain_actor_proof(){let mut s=setup(true);let tx=update(&mut s,1,999);let asset_type=s.protocol_type.clone().as_builder().args(Bytes::from(vec![41;32]).pack()).build();let typed=input(&mut s.context,&s.actor,1000,Some(asset_type),Bytes::from(1u128.to_le_bytes().to_vec()));let tx=s.context.complete_tx(tx.as_advanced_builder().set_inputs(vec![tx.inputs().get(0).unwrap(),typed]).build());let signed=sign_group(tx,&s.key,&[1]);reject(&s,&signed,Error::Unauthorized);}
#[test]
fn ambiguous_existing_protocol_sources_cannot_select_the_favorable_admin_list(){let mut s=setup(false);let tx=creation(&mut s,599);let duplicate=s.context.create_cell(output(&s.sponsor,2000,Some(s.protocol_type.clone())),Bytes::from(protocol(&[[7;32]])));let tx=tx.as_advanced_builder().cell_dep(dep(duplicate)).build();reject(&s,&tx,Error::InvalidProtocol);let input_and_dep=tx.as_advanced_builder().input(CellInput::new_builder().previous_output(s.protocol_point.clone()).build()).output(output(&s.sponsor,2000,Some(s.protocol_type.clone()))).output_data(Bytes::from(protocol(&[lock_hash(&s.actor)])).pack()).build();reject(&s,&input_and_dep,Error::InvalidProtocol);}
#[test]
fn malformed_protocol_data_cannot_grant_admin_authority(){let mut s=setup(false);let tx=creation(&mut s,599);s.context.create_cell_with_out_point(s.protocol_point.clone(),output(&s.sponsor,2000,Some(s.protocol_type.clone())),Bytes::from(vec![0;64]));reject(&s,&tx,Error::InvalidProtocol);}
