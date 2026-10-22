import assert from 'node:assert/strict';
import test from 'node:test';
import { estimatePlan } from '../src/lib/plan-estimate.ts';

const stock = {id:'underlying',asset:'stock',symbol:'XYZ',currency:'USD',multiplier:'1',tickSize:'0.01',metadataVersion:1,enabled:true};
const base = {asset:'stock',strategy:'long',quantity:10,entryPrice:'100',initialStopPrice:'95',legs:[],entryFrom:'2099-01-01T14:00:00.000Z',entryUntil:'2099-01-01T15:00:00.000Z'};
test('composer planning estimate preserves exact stock and dated futures risk',()=>{
 assert.equal(estimatePlan(base,stock,[]).initialRisk,'50.0000000000');
 const future={...stock,id:'mes',asset:'future',symbol:'MESZ99',root:'MES',multiplier:'5',tickSize:'0.25',expiration:'2099-12-16T14:30:00.000Z'};
 assert.equal(estimatePlan({...base,asset:'future',quantity:2,entryPrice:'6000',initialStopPrice:'5990'},future,[]).initialRisk,'100.0000000000');
});
test('composer uses actual option legs and separates premium cash risk from underlying levels',()=>{
 const contracts=['100','105'].map((strike,i)=>({...stock,id:`call-${i}`,asset:'option',underlyingId:stock.id,strike,optionType:'call',multiplier:'100',expiration:'2099-01-16T21:00:00.000Z'}));
 const spread={...base,asset:'option',strategy:'bull_call_debit',quantity:1,entryPrice:'1.50',initialStopPrice:undefined,legs:[{instrumentId:'call-1',side:'sell',quantity:1},{instrumentId:'call-0',side:'buy',quantity:1}]};
 const estimate=estimatePlan(spread,stock,contracts);
 assert.equal(estimate.initialRisk,'150.0000000000');
 assert.equal(estimate.maxProfit,'350.0000000000');
 assert.throws(()=>estimatePlan(spread,stock,[contracts[0]]),/contract references/);
 assert.throws(()=>estimatePlan(spread,stock,[contracts[0],{...contracts[1],underlyingId:'different'}]),/contract references/);
});
