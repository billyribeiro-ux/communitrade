import {calculatePosition,validateTradePlan,type TradePlan as CalculationPlan} from "@trading/domain";
import type {TradePlan} from "./publications";
import type {Instrument} from "./instruments";
/** Planning estimate from the displayed catalog; the server independently hydrates and validates at commit. */
export function estimatePlan(plan:TradePlan,primary:Instrument,contracts:readonly Instrument[]){
 const resolved=plan.legs.map(leg=>{const contract=contracts.find(item=>item.id===leg.instrumentId);if(!contract||contract.asset!=="option"||contract.underlyingId!==primary.id||!contract.strike||!contract.expiration||!contract.optionType)throw new Error("Actual option contract references are incomplete.");return {leg,contract};});
 const firstSide=plan.strategy.endsWith("credit")?"sell":"buy";resolved.sort((a,b)=>Number(b.leg.side===firstSide)-Number(a.leg.side===firstSide));
 const expiration=plan.asset==="option"?resolved[0]?.contract.expiration:primary.expiration;
 const calculationPlan:CalculationPlan={asset:plan.asset,strategy:plan.strategy,quantity:plan.quantity,entryPrice:plan.entryPrice,entryFrom:plan.entryFrom,entryUntil:plan.entryUntil,...(plan.initialStopPrice?{initialStopPrice:plan.initialStopPrice}:{}),...(expiration?{expiration}:{}),instrument:{asset:plan.asset,symbol:primary.symbol,currency:primary.currency,multiplier:plan.asset==="option"?"100":primary.multiplier,tickSize:primary.tickSize,metadataVersion:primary.metadataVersion,enabled:primary.enabled,...(primary.root?{root:primary.root}:{}),adjusted:primary.adjusted??false},legs:resolved.map(({leg,contract})=>({side:leg.side==="buy"?"long":"short",quantity:leg.quantity,strike:contract.strike!,optionType:contract.optionType!,expiration:contract.expiration!,underlyingId:primary.id,multiplier:contract.multiplier,adjusted:contract.adjusted??false}))};
 const issues=validateTradePlan(calculationPlan);if(issues.length)throw new Error(issues.map(issue=>issue.message).join(" "));
 return calculatePosition({plan:calculationPlan,entryCosts:null,exits:[]});
}
