import {ccc} from "@ckb-ccc/connector-react";

/** A nonzero remainder needs its own Funding Lock cell. Keep collecting
 * available cells rather than creating dust from the first sufficient input. */
export function selectAdminTipCkbFunding(cells:readonly ccc.Cell[],pool:ccc.Script,required:bigint):{cells:ccc.Cell[];total:bigint;minimumRemainder:bigint} {
  if(required<=0n)throw new Error("A CKB payout must be positive");
  const minimumRemainder=ccc.CellOutput.from({lock:pool},"0x").capacity,selected:ccc.Cell[]=[];let total=0n;const seen=new Set<string>();
  for(const cell of cells){const key=`${cell.outPoint.txHash}:${cell.outPoint.index}`;
    if(seen.has(key)||cell.cellOutput.type||cell.outputData!=="0x"||!cell.cellOutput.lock.eq(pool))throw new Error("Invalid native tipping pool input");
    seen.add(key);selected.push(cell);total+=cell.cellOutput.capacity;
    if(total===required||total>=required+minimumRemainder)return {cells:selected,total,minimumRemainder};
  }
  const reserve=total>required?minimumRemainder:0n;
  throw new AdminTipPoolReserveError(required+reserve,total);
}
export class AdminTipPoolReserveError extends Error {
  constructor(readonly required:bigint,readonly available:bigint){super(`Insufficient native pool capacity including the Funding Lock remainder: required ${required}, available ${available} shannons`);}
}

/** Allocate one accepted UDT from this protocol's treasury. Recipient storage
 * is supplied by the signing actor; treasury CKB is retained in full. */
export function appendAdminTipUdtDistribution(tx:ccc.Transaction,options:{
  pool:ccc.Script;target:ccc.Script;type:ccc.Script;amount:bigint;
  cells:readonly ccc.Cell[];code:ccc.OutPointLike;
}):{selected:ccc.Cell[];changeAmount:bigint;preservedCapacity:bigint} {
  const {pool,target,type,amount,cells,code}=options;
  if(amount<=0n||amount>0xffffffffffffffffffffffffffffffffn)throw new Error("A UDT payout must be a positive Uint128 amount");
  if(pool.eq(target))throw new Error("A tip recipient cannot be the same community pool");
  const used=new Set(tx.inputs.map(input=>`${input.previousOutput.txHash}:${input.previousOutput.index}`));
  const selected:ccc.Cell[]=[];let total=0n,capacity=0n;
  for(const cell of cells){
    const key=`${cell.outPoint.txHash}:${cell.outPoint.index}`;
    if(used.has(key)||!cell.cellOutput.lock.eq(pool)||!cell.cellOutput.type?.eq(type)||ccc.bytesFrom(cell.outputData).length!==16)throw new Error("Invalid or reused tipping pool asset cell");
    used.add(key);selected.push(cell);total+=ccc.numLeFromBytes(cell.outputData);capacity+=cell.cellOutput.capacity;
    if(total>0xffffffffffffffffffffffffffffffffn)throw new Error("The selected pool asset exceeds Uint128");
    if(total>=amount)break;
  }
  if(total<amount)throw new Error(`Insufficient pool asset: required ${amount}, available ${total}`);
  const recipientData=ccc.hexFrom(ccc.numLeToBytes(amount,16));
  const recipient=ccc.CellOutput.from({lock:target,type},recipientData);
  const changeAmount=total-amount,changeData=changeAmount?ccc.hexFrom(ccc.numLeToBytes(changeAmount,16)):"0x";
  const remainder=ccc.CellOutput.from({lock:pool,...(changeAmount?{type}:{})},changeData);
  if(capacity<remainder.capacity)throw new Error("Pool storage capacity cannot be preserved in the remainder cell");
  remainder.capacity=capacity;
  for(const cell of selected)tx.addInput(cell);
  tx.addOutput(recipient,recipientData);tx.addOutput(remainder,changeData);tx.addCellDeps({outPoint:code,depType:"code"});
  return {selected,changeAmount,preservedCapacity:capacity};
}
