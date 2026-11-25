import {ccc} from "@ckb-ccc/connector-react";
import {AchievementDataVec, ConnectedTypeID, ProtocolData, TransactionRecipe} from "ssri-ckboost/types";
import {adminUsersFixture, userHash as h} from "@/lib/revamp/__tests__/admin-users-fixtures";
import {makeProfileReadScope} from "@/lib/revamp/profile-model";
import type {AdminAchievement} from "@/lib/revamp/admin-rewards-model";

export function rewardsFixture(){
  const f=adminUsersFixture();
  const type=ccc.Script.from({codeHash:h("8"),hashType:"type",args:ccc.hexFrom(ConnectedTypeID.encode({type_id:h("c"),connected_key:f.scope.protocolHash}))});
  const title="First Submission",record={receiver_user_type_hash:f.userCell().cellOutput.type!.hash(),granted_at:1795600000000n};
  const before=[{achievement_title:title,achievement_metadata:"nevent-definition",receiver_user_record_vec:[]}];
  const after=[{...before[0],receiver_user_record_vec:[record]}];
  const output={capacity:100000000000n,lock:f.lock,type};
  const parent=ccc.Transaction.from({outputs:[output],outputsData:[ccc.hexFrom(AchievementDataVec.encode(before))]});
  const recipe=(method="CKBoostAchievement.claim_achievement")=>ccc.hexFrom(ccc.WitnessArgs.from({outputType:ccc.hexFrom(TransactionRecipe.encode({method_path:ccc.bytesFrom(method,"utf8"),arguments:[]}))}).toBytes());
  const tx=ccc.Transaction.from({inputs:[{previousOutput:{txHash:parent.hash(),index:0}}],outputs:[output],outputsData:[ccc.hexFrom(AchievementDataVec.encode(after))],witnesses:[recipe()]});
  const cell=ccc.Cell.from({outPoint:{txHash:tx.hash(),index:0},cellOutput:output,outputData:tx.outputsData[0]});
  const protocolCell=ccc.Cell.from({...f.protocolCell,outputData:ccc.hexFrom(ProtocolData.encode({...f.protocol,protocol_config:{...f.protocol.protocol_config,achievement_type_hashes:[type.hash()]}}))});
  const scope=makeProfileReadScope(f.client,protocolCell,f.address,"testnet");
  const claim={id:`${type.hash()}:0:0`,receiverTypeHash:record.receiver_user_type_hash,grantedAt:Number(record.granted_at),grantedAtRaw:record.granted_at.toString(),name:null,address:null,lockHash:null,isCurrentWallet:false};
  const achievement:AdminAchievement={id:`${type.hash()}:0`,title,metadataNeventId:"nevent-definition",cell,index:0,classification:"first-submission",claims:[claim]};
  const response={transaction:tx,status:"committed",blockNumber:10n,blockHash:h("d")} as ccc.ClientTransactionResponse;
  const parents=new Map([[parent.hash(),{transaction:parent,status:"committed",blockNumber:9n} as ccc.ClientTransactionResponse]]);
  const header={number:10n,hash:h("d"),timestamp:1795600001000n} as ccc.ClientBlockHeader;
  return {...f,scope,protocolCell,type,before,after,record,parent,tx,cell,achievement,response,parents,header,recipe};
}
