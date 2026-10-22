import assert from "node:assert/strict";
import test from "node:test";
import { ASSET_CLASSES, isAssetClass, calculatePosition, calculateExpiryPayoff, decimal, formatDecimal, formatRatio, validatePositionEvent, entryEligibility, FUTURES_METADATA, validateTick, validateTradePlan, appendCorrectionVersion, aggregatePerformance, transitionPosition, stateAtTime, resolveIdempotency } from "../dist/index.js";
import fixtures from "../../../contracts/fixtures/domain-calculations.json" with { type: "json" };

test("exposes the three supported Phase 1 asset classes", () => {
  assert.deepEqual(ASSET_CLASSES, ["stock", "option", "future"]);
  for (const assetClass of ASSET_CLASSES) assert.equal(isAssetClass(assetClass), true);
  assert.equal(isAssetClass("crypto"), false);
  assert.equal(isAssetClass(null), false);
});

const legs = (strategy, expiration = "2026-11-20T21:00:00.000Z") => {
  const rows = {
    bull_call_debit: [["long", "100"], ["short", "105"]],
    bear_put_debit: [["long", "105"], ["short", "100"]],
    bull_put_credit: [["short", "105"], ["long", "100"]],
    bear_call_credit: [["short", "100"], ["long", "105"]]
  }[strategy];
  return rows.map(([side, strike]) => ({ side, strike, optionType: strategy.includes("call") ? "call" : "put", expiration, underlyingId: "fixture-SPY", quantity: 1 }));
};
const cost = amount => amount === null ? null : { amount };
const asMoney = value => value === null || value === undefined ? value : formatDecimal(decimal(value));
const optionInstrument = { asset: "option", symbol: "SPY", multiplier: "100", tickSize: "0.01", metadataVersion: 1, adjusted: false };
const futureInstrument = root => ({ asset: "future", symbol: `${root}Z26`, ...FUTURES_METADATA[root], root, metadataVersion: 1 });

test("synthetic fixture manifest has expected worked cases", () => {
  assert.equal(fixtures.synthetic, true);
  assert.ok(fixtures.cases.length >= 16);
});

test("runner executes and checks every deterministic fixture case", () => {
  const visited=[];
  for(const c of fixtures.cases) {
    visited.push(c.id);
    if(c.id.startsWith("stock-")) {
      const r=calculatePosition({plan:{asset:"stock",strategy:c.strategy,entryPrice:c.entry,quantity:c.quantity,initialStopPrice:c.stop},entryCosts:cost(c.entryCosts),borrowCosts:c.borrowCosts===undefined?undefined:cost(c.borrowCosts),exits:c.exits.map(x=>({quantity:x.quantity,price:x.price,costs:cost(c.exitCosts??"0")}))});
      assert.equal(r.grossRealized,asMoney(c.gross)); assert.equal(r.netRealized,asMoney(c.net)); assert.equal(r.initialRisk,asMoney(c.initialRisk)); if(c.r) assert.equal(r.rMultiple,asMoney(c.r)); if(c.borrowCoverage) assert.equal(r.borrowCostCoverage,c.borrowCoverage);
    } else if(c.id.startsWith("long-")) {
      const type=c.strategy==="long_call"?"call":"put"; const expiration="2026-11-20T21:00:00.000Z";
      const plan={asset:"option",strategy:c.strategy,entryPrice:c.entry,quantity:c.quantity,instrument:optionInstrument,multiplier:c.multiplier,expiration,legs:[{side:"long",quantity:c.quantity,strike:c.strike??"100",optionType:type,expiration,underlyingId:"fixture-SPY"}]};
      const x=calculatePosition({plan,entryCosts:cost(c.entryCosts),exits:c.exits.map(v=>({quantity:v.quantity,price:v.price,costs:cost(c.exitCosts)}))}); assert.equal(x.grossRealized,asMoney(c.gross)); if(c.net)assert.equal(x.netRealized,asMoney(c.net)); if(c.initialRisk)assert.equal(x.initialRisk,asMoney(c.initialRisk)); if(c.maxExpiryProfit)assert.equal(x.maxProfit,asMoney(c.maxExpiryProfit));
      if(c.id==="long-call") assert.equal(calculateExpiryPayoff(plan,"110").grossPnl,"1700.0000000000");
    } else if(c.asset==="option"&&["bull_call_debit","bear_put_debit","bull_put_credit","bear_call_credit"].includes(c.strategy)) {
      const strategy=c.strategy; const exp="2026-11-20T21:00:00.000Z"; const pairs={bull_call_debit:[["long","100"],["short","105"]],bear_put_debit:[["long","105"],["short","100"]],bull_put_credit:[["short","105"],["long","100"]],bear_call_credit:[["short","100"],["long","105"]]};
      const plan={asset:"option",strategy,entryPrice:c.entry,quantity:c.quantity,instrument:optionInstrument,expiration:exp,legs:pairs[strategy].map(([side,strike])=>({side,strike,quantity:c.quantity,optionType:strategy.includes("call")?"call":"put",expiration:exp,underlyingId:"fixture-SPY"}))};
      const r=calculatePosition({plan,entryCosts:cost(c.entryCosts),exits:[]}); if(c.maxLoss)assert.equal(r.maxLoss,asMoney(c.maxLoss)); if(c.maxProfit)assert.equal(r.maxProfit,asMoney(c.maxProfit)); if(c.expirySpot)assert.equal(calculateExpiryPayoff(plan,c.expirySpot).grossPnl,asMoney(c.expiryGrossPnl));
    } else if(c.asset==="future") {
      const root=c.root??(c.id.startsWith("mes")?"MES":"NQ"); const md=futureInstrument(root);
      if(c.priceIncrementValid) assert.equal(validateTick(c.entry,md.tickSize),true);
      if(c.exits) { const r=calculatePosition({plan:{asset:"future",strategy:c.strategy,entryPrice:c.entry,quantity:c.quantity,initialStopPrice:c.stop,instrument:md},entryCosts:cost(c.entryCosts),exits:c.exits.map(x=>({quantity:x.quantity,price:x.price,costs:cost(c.exitCosts)}))}); assert.equal(r.grossRealized,asMoney(c.gross)); assert.equal(r.initialRisk,asMoney(c.initialRisk)); }
    } else if(c.id==="partial-exits-single-position") {
      const r=calculatePosition({plan:{asset:"stock",strategy:"long",entryPrice:c.entry,quantity:c.quantity,initialStopPrice:"9"},entryCosts:cost(c.entryCosts),exits:c.exits.map(x=>({quantity:x.quantity,price:x.price,costs:cost("0")}))}); assert.equal(r.grossRealized,asMoney(c.gross)); assert.equal(r.remainingQuantity,0);
    } else if(c.id==="breakeven-cost-adjusted") {
      const r=calculatePosition({plan:{asset:"stock",strategy:"long",entryPrice:c.entry,quantity:c.quantity,initialStopPrice:"9"},entryCosts:cost(c.entryCosts),exits:c.exits.map(x=>({quantity:x.quantity,price:x.price,costs:cost(c.exitCosts)}))}); assert.equal(r.netRealized,asMoney(c.net));
    } else if(c.id==="missing-cost-is-null") {
      const r=calculatePosition({plan:{asset:"stock",strategy:"long",entryPrice:c.entry,quantity:c.quantity,initialStopPrice:"9"},entryCosts:null,exits:c.exits.map(x=>({quantity:x.quantity,price:x.price,costs:cost(c.exitCosts)}))}); assert.equal(r.netRealized,c.net); assert.equal(r.costComplete,c.costComplete);
    } else if(c.id==="expired-unresolved") assert.equal(stateAtTime({asset:"option",strategy:"long_call",entryPrice:"1",quantity:1,expiration:"2026-10-19T12:00:00Z"},"entered","2026-10-19T13:00:00Z"),"unresolved");
    else if(c.id==="retrospective-entry") assert.equal(entryEligibility(c.publishedAt,c.entryClaimedAt,c.entryReceivedAt,"2026-10-19T13:00:00Z","2026-10-19T14:00:00Z").eligible,c.eligible);
    else if(c.id==="duplicate-submission") { const entries=[{key:c.key,requestHash:c.firstRequestHash,response:{saved:true}}]; assert.equal(resolveIdempotency(entries,c.key,c.replayRequestHash).kind,c.identicalOutcome); assert.equal(resolveIdempotency(entries,c.key,c.changedRequestHash).kind,c.changedOutcome); }
    else if(c.id==="metadata-correction-preserves-version") { const original={publicationId:"p",sequence:1,versionId:"old",previousVersionId:null,terms:{metadataVersion:c.publicationMetadataVersion,risk:c.frozenInitialRisk},publishedAt:"2026-10-19T13:00:00Z"}; const v=appendCorrectionVersion(original,{sourceVersionId:"old",requestedAt:"2026-10-19T13:02:00Z",reason:"Reference metadata corrected",proposedTerms:{metadataVersion:c.currentMetadataVersion},status:"approved"},"new","2026-10-19T13:03:00Z"); assert.equal(v.original.terms.risk,c.frozenInitialRisk); assert.equal(v.corrected.previousVersionId,"old"); }
    else if(c.id==="rounding-conservation") assert.equal(formatDecimal(c.values.map(decimal).reduce((a,b)=>a+b,0n)),c.expectedExactSum);
    else throw new Error(`Fixture case has no executable assertion: ${c.id}`);
  }
  assert.equal(visited.length,fixtures.cases.length);
});

test("decimal arithmetic parses, sums, and rounds without binary float drift", () => {
  assert.equal(formatDecimal(decimal("0.005") + decimal("0.005") - decimal("0.010")), "0.0000000000");
  assert.equal(formatDecimal(decimal("1.005"), 2), "1.01");
  assert.equal(formatDecimal(decimal("-1.005"), 2), "-1.01");
  assert.equal(formatRatio(decimal("1.005"), decimal("1"), 2), "1.01");
  assert.throws(() => decimal("1.00000000001"), /Invalid decimal/);
  assert.equal(formatDecimal(decimal("999999999999999999"), 2), "999999999999999999.00");
  assert.throws(() => decimal(Number('9007199254740993')), /must be a string/);
  assert.throws(() => decimal(Number.NaN), /must be a string/);
  assert.throws(() => decimal("NaN"), /Invalid decimal string/);
  assert.throws(() => calculatePosition({ plan: { asset: "stock", strategy: "long", entryPrice: "1", quantity: 2, initialStopPrice: "0.5" }, entryCosts: cost("0"), exits: [{ quantity: 2, price: "999999999999999999", costs: cost("0") }] }), /numeric\(28,10\)/);
});

test("stock long and short use signed outcomes and frozen planned risk", () => {
  for (const [strategy, entry, exit, stop] of [["long", "100", "105", "95"], ["short", "100", "95", "105"]]) {
    const result = calculatePosition({ plan: { asset: "stock", strategy, entryPrice: entry, quantity: 10, initialStopPrice: stop }, entryCosts: cost("1"), borrowCosts: strategy === "short" ? cost("0") : undefined, exits: [{ quantity: 10, price: exit, costs: cost("1") }] });
    assert.equal(result.grossRealized, "50.0000000000");
    assert.equal(result.netRealized, "48.0000000000");
    assert.equal(result.initialRisk, "50.0000000000");
  }
});

test("all supported option structures calculate payoff bounds and reported cash flow", () => {
  const plans = [
    ["long_call", "1.50", 2, undefined], ["long_put", "2", 1, undefined],
    ["bull_call_debit", "1.50", 1, legs("bull_call_debit")], ["bear_put_debit", "1.25", 1, legs("bear_put_debit")],
    ["bull_put_credit", "1.20", 1, legs("bull_put_credit")], ["bear_call_credit", "1.20", 1, legs("bear_call_credit")]
  ];
  for (const [strategy, entryPrice, quantity, optionLegs] of plans) {
    const resolvedLegs = optionLegs ?? [{ side: "long", quantity, strike: "100", optionType: strategy === "long_call" ? "call" : "put", expiration: "2026-11-20T21:00:00.000Z", underlyingId: "fixture-SPY" }];
    const plan = { asset: "option", strategy, entryPrice, quantity, instrument: optionInstrument, expiration: "2026-11-20T21:00:00.000Z", multiplier: "100", legs: resolvedLegs };
    assert.deepEqual(validateTradePlan(plan), []);
    const result = calculatePosition({ plan, entryCosts: cost("0"), exits: [] });
    assert.equal(result.costComplete, true);
    if (strategy === "bull_call_debit") { assert.equal(result.maxLoss, "150.0000000000"); assert.equal(result.maxProfit, "350.0000000000"); }
    if (strategy === "long_call") assert.equal(result.maxProfitKind, "unlimited");
    if (strategy === "long_put") assert.equal(result.maxProfit, "9800.0000000000");
    if (strategy === "bull_put_credit" || strategy === "bear_call_credit") { assert.equal(result.maxLoss, "380.0000000000"); assert.equal(result.maxProfit, "120.0000000000"); }
  }
});

test("expiry payoff reports intrinsic outcome for long options and every vertical family", () => {
  const mk = (strategy, entryPrice, optionLegs, spot) => calculateExpiryPayoff({ asset: "option", strategy, entryPrice, quantity: 1, instrument: optionInstrument, multiplier: "100", expiration: "2026-11-20T21:00:00.000Z", legs: optionLegs }, spot);
  assert.equal(mk("long_call", "1.50", [{ side:"long", quantity:1, strike:"100", optionType:"call", expiration:"2026-11-20T21:00:00.000Z", underlyingId:"SPY" }], "110").grossPnl, "850.0000000000");
  assert.equal(mk("long_put", "1.50", [{ side:"long", quantity:1, strike:"100", optionType:"put", expiration:"2026-11-20T21:00:00.000Z", underlyingId:"SPY" }], "90").grossPnl, "850.0000000000");
  const expensivePut = { asset:"option", strategy:"long_put", entryPrice:"101", quantity:1, instrument:optionInstrument,
    legs:[{ side:"long", quantity:1, strike:"100", optionType:"put", expiration:"2026-11-20T21:00:00.000Z", underlyingId:"SPY" }] };
  assert.equal(calculatePosition({ plan:expensivePut, entryCosts:cost("0"), exits:[] }).maxProfit, "-100.0000000000");
  assert.equal(calculateExpiryPayoff(expensivePut, "0").grossPnl, "-100.0000000000");
  for (const strategy of ["bull_call_debit", "bear_put_debit", "bull_put_credit", "bear_call_credit"]) {
    const payoff = mk(strategy, strategy.endsWith("debit")?"1.50":"1.20", legs(strategy), strategy.startsWith("bull_")?"110":"90");
    assert.equal(typeof payoff.grossPnl, "string");
  }
});

test("future roots carry metadata and price increments are validated", () => {
  assert.equal(FUTURES_METADATA.MES.multiplier, "5");
  assert.equal(FUTURES_METADATA.NQ.multiplier, "20");
  assert.deepEqual(Object.fromEntries(Object.entries(FUTURES_METADATA).map(([root, meta]) => [root, meta.multiplier])), { ES: "50", MES: "5", NQ: "20", MNQ: "2" });
  assert.equal(validateTick("5000.25", FUTURES_METADATA.MES.tickSize), true);
  assert.equal(validateTick("5000.10", FUTURES_METADATA.MES.tickSize), false);
  for (const root of ["ES", "MES", "NQ", "MNQ"]) assert.deepEqual(validateTradePlan({ asset: "future", strategy: "long", entryPrice: "5000", quantity: 1, initialStopPrice: "4999", instrument: futureInstrument(root) }, "2026-10-19T00:00:00Z"), []);
  const result = calculatePosition({ plan: { asset: "future", strategy: "long", entryPrice: "5000", quantity: 1, initialStopPrice: "4999", instrument: futureInstrument("MES") }, entryCosts: cost("0"), exits: [{ quantity: 1, price: "5001", costs: cost("0") }] });
  assert.equal(result.grossRealized, "5.0000000000");
  const badTick=validateTradePlan({asset:"future",strategy:"long",entryPrice:"5000.10",quantity:1,initialStopPrice:"4999",instrument:futureInstrument("MES")},"2026-10-19T00:00:00Z");
  assert.ok(badTick.some(x=>x.code==="entry_tick"));
});

test("malformed plan values return validation issues and unsupported contract metadata is rejected", () => {
  assert.ok(validateTradePlan({asset:"future",strategy:"long",entryPrice:"5000",quantity:1,initialStopPrice:"4999"}).some(x=>x.code==="future_metadata_required"));
  assert.ok(validateTradePlan({asset:"option",strategy:"long_call",entryPrice:"1",quantity:1,instrument:optionInstrument,legs:[{side:"long",quantity:1,strike:"bad",optionType:"put",expiration:"bad",underlyingId:"SPY"}]},"2026-10-19T00:00:00Z").length>0);
  const wrongVertical=validateTradePlan({asset:"option",strategy:"bull_call_debit",entryPrice:"1",quantity:1,instrument:optionInstrument,legs:[{side:"long",quantity:1,strike:"100",optionType:"put",expiration:"2026-11-20T21:00:00Z",underlyingId:"SPY"},{side:"short",quantity:1,strike:"105",optionType:"put",expiration:"2026-11-20T21:00:00Z",underlyingId:"SPY"}]},"2026-10-19T00:00:00Z");
  assert.ok(wrongVertical.some(x=>x.code==="option_type_strategy"));
  assert.ok(validateTradePlan({asset:"stock",strategy:"long",entryPrice:"10",quantity:1,initialStopPrice:"9",entryFrom:"not-a-date",entryUntil:"2026-10-19T00:00:00Z"}).some(x=>x.code==="entry_window_timestamp"));
  assert.ok(validateTradePlan({asset:"stock",strategy:"long",entryPrice:"10",quantity:1,initialStopPrice:"9",entryFrom:"2026-02-30T12:00:00Z",entryUntil:"2026-03-01T00:00:00Z"}).some(x=>x.code==="entry_window_timestamp"));
  const historical={asset:"option",strategy:"long_call",entryPrice:"1",quantity:1,instrument:optionInstrument,expiration:"2020-01-01T00:00:00Z",legs:[{side:"long",quantity:1,strike:"100",optionType:"call",expiration:"2020-01-01T00:00:00Z",underlyingId:"SPY"}]};
  assert.ok(validateTradePlan(historical,"2026-10-19T00:00:00Z").some(x=>x.code==="expired_plan"));
  assert.equal(calculatePosition({plan:historical,entryCosts:cost("0"),exits:[{quantity:1,price:"2",costs:cost("0") }]}).grossRealized,"100.0000000000");
});

test("partial exits consolidate and missing costs remain incomplete", () => {
  assert.throws(() => calculatePosition({ plan: { asset: "stock", strategy: "long", entryPrice: "10", quantity: 1, initialStopPrice: "9" }, entryCosts: cost("0"), exits: [{ quantity: 1, price: "-1", costs: cost("0") }] }), /cannot be negative/);
  const result = calculatePosition({ plan: { asset: "stock", strategy: "long", entryPrice: "10", quantity: 10, initialStopPrice: "9" }, entryCosts: cost("0"), exits: [{ quantity: 4, price: "11", costs: cost("0") }, { quantity: 6, price: "10", costs: cost("0") }] });
  assert.equal(result.netRealized, "4.0000000000");
  assert.equal(result.remainingQuantity, 0);
  const incomplete = calculatePosition({ plan: { asset: "stock", strategy: "long", entryPrice: "10", quantity: 1, initialStopPrice: "9" }, entryCosts: null, exits: [{ quantity: 1, price: "11", costs: cost("0") }] });
  assert.equal(incomplete.netRealized, null);
  const prorated = calculatePosition({plan:{asset:"stock",strategy:"long",entryPrice:"10",quantity:10,initialStopPrice:"9"},entryCosts:cost("2"),exits:[{quantity:5,price:"11",costs:cost("0")}]});
  assert.equal(prorated.knownCosts,"1.0000000000");
  assert.equal(prorated.netRealized,"4.0000000000");
  // Many distinct partitions must conserve the same total realized stock P&L.
  const whole = calculatePosition({ plan: { asset: "stock", strategy: "long", entryPrice: "12.34", quantity: 17, initialStopPrice: "11" }, entryCosts: cost("0"), exits: [{ quantity: 17, price: "13.01", costs: cost("0") }] });
  for (let cut = 1; cut < 17; cut++) {
    const split = calculatePosition({ plan: { asset: "stock", strategy: "long", entryPrice: "12.34", quantity: 17, initialStopPrice: "11" }, entryCosts: cost("0"), exits: [{ quantity: cut, price: "13.01", costs: cost("0") }, { quantity: 17-cut, price: "13.01", costs: cost("0") }] });
    assert.equal(split.grossRealized, whole.grossRealized);
  }
});

test("actual entry fills drive realized cash flow without rewriting planned stop or risk", () => {
  const plan={asset:"stock",strategy:"long",entryPrice:"100",quantity:1,initialStopPrice:"95"};
  // A reported fill may differ materially from the original plan, including a
  // fill through the planned stop. It remains a member-reported fill; planned
  // risk and plan validation continue to use the published terms.
  const result=calculatePosition({plan,actualEntryPrice:"90",entryCosts:cost("0"),exits:[{quantity:1,price:"105",costs:cost("0")} ]});
  assert.equal(result.grossRealized,"15.0000000000");
  assert.equal(result.initialRisk,"5.0000000000");
  assert.equal(result.rMultiple,"3.0000000000");
});

test("frozen risk survives later plan edits and is distinct from non-guaranteed stock loss", () => {
  const frozen = { amount:"50", calculationVersion:"1", metadataVersion:1, entryTermsVersion:1 };
  const result = calculatePosition({ plan:{asset:"stock",strategy:"long",entryPrice:"100",quantity:10,initialStopPrice:"80"}, frozenInitialRisk:frozen, entryCosts:cost("0"), exits:[{quantity:10,price:"105",costs:cost("0")}] });
  assert.equal(result.initialRisk, "50.0000000000");
  assert.equal(result.maxLoss, null);
  assert.equal(result.frozenRiskSourceVersion, "1");
});

test("eligibility and lifecycle reject late, future, excessive, or unresolved events without evidence", () => {
  assert.deepEqual(entryEligibility("2026-10-19T13:00:00Z", "2026-10-19T13:01:00Z", "2026-10-19T13:07:00Z", "2026-10-19T13:00:00Z", "2026-10-19T14:00:00Z").reasons, ["reported_after_five_minutes"]);
  assert.deepEqual(entryEligibility("bad", "2026-10-19T13:01:00Z", "2026-10-19T13:01:00Z", "2026-10-19T13:00:00Z", "2026-10-19T14:00:00Z").reasons,["invalid_timestamp"]);
  const plan = { asset: "stock", strategy: "long", entryPrice: "10", quantity: 3, initialStopPrice: "9" };
  const issue = validatePositionEvent({ state: "entered", plan, events: [{ type: "entry", claimedAt: "2026-10-19T13:00:00Z", receivedAt: "2026-10-19T13:00:00Z", quantity: 3, price: "10" }] }, { type: "partial_exit", claimedAt: "2026-10-19T13:01:00Z", receivedAt: "2026-10-19T13:01:00Z", quantity: 3, price: "11" });
  assert.ok(issue.some(x => x.code === "partial_full"));
  assert.ok(validatePositionEvent({ state: "unresolved", plan, events: [] }, { type: "resolution", claimedAt: "2026-10-19T13:01:00Z", receivedAt: "2026-10-19T13:01:00Z" }).some(x => x.code === "resolution_evidence"));
  assert.ok(validatePositionEvent({state:"pending",plan,events:[]},{type:"cancel",claimedAt:"2026-10-19T12:00:00Z",receivedAt:"2026-10-19T12:00:00Z",reason:"Plan withdrawn"}).length===0);
  assert.ok(validatePositionEvent({state:"closed",plan,events:[]},{type:"cancel",claimedAt:"2026-10-19T12:00:00Z",receivedAt:"2026-10-19T12:00:00Z"}).some(x=>x.code==="state"));
});

test("lifecycle caps partials, rejects >60-second future claims, expiry exits, and records explicit resolution", () => {
  const plan={asset:"stock",strategy:"long",entryPrice:"10",quantity:10,initialStopPrice:"9",expiration:"2026-10-19T13:00:00Z"};
  const partials=Array.from({length:3},(_,i)=>({type:"partial_exit",claimedAt:`2026-10-19T12:0${i+1}:00Z`,receivedAt:`2026-10-19T12:0${i+1}:00Z`,quantity:1,price:"11"}));
  const context={state:"partially_closed",plan,events:[{type:"entry",claimedAt:"2026-10-19T12:00:00Z",receivedAt:"2026-10-19T12:00:00Z",quantity:10},...partials],now:"2026-10-19T12:10:00Z"};
  assert.ok(validatePositionEvent(context,{type:"partial_exit",claimedAt:"2026-10-19T12:04:00Z",receivedAt:"2026-10-19T12:04:00Z",quantity:1}).some(x=>x.code==="partial_limit"));
  assert.ok(validatePositionEvent({...context,state:"entered",events:context.events.slice(0,1)},{type:"final_exit",claimedAt:"2026-10-19T13:00:00Z",receivedAt:"2026-10-19T13:00:00Z",quantity:1}).some(x=>x.code==="expired_unresolved"));
  assert.ok(validatePositionEvent({...context,state:"entered",events:context.events.slice(0,1)},{type:"final_exit",claimedAt:"2026-10-19T12:11:01Z",receivedAt:"2026-10-19T12:11:01Z",quantity:1}).some(x=>x.code==="future_claim"));
  assert.ok(validatePositionEvent({...context,state:"unresolved",events:[]},{type:"resolution",claimedAt:"2026-10-19T12:11:00Z",receivedAt:"2026-10-19T12:11:00Z",reason:"Exchange statement",resolution:"cash_settled",netResult:"2.00"}).length===0);
  const opened=transitionPosition({state:"pending",plan:{...plan,expiration:undefined},events:[],now:"2026-10-19T11:59:00Z"},{type:"entry",claimedAt:"2026-10-19T12:00:00Z",receivedAt:"2026-10-19T12:00:00Z",quantity:10,price:"10",costs:cost("0")});
  assert.equal(opened.state,"entered");
  const partial=transitionPosition({state:"entered",plan:{...plan,expiration:undefined},events:[{type:"entry",claimedAt:"2026-10-19T12:00:00Z",receivedAt:"2026-10-19T12:00:00Z",quantity:10,price:"10",costs:cost("0")}],now:"2026-10-19T12:00:00Z"},{type:"partial_exit",claimedAt:"2026-10-19T12:01:00Z",receivedAt:"2026-10-19T12:01:00Z",quantity:5,price:"11",costs:cost("0")});
  assert.equal(partial.remainingQuantity,5); assert.equal(partial.state,"partially_closed");
  const unresolved=transitionPosition({state:"entered",plan,events:[{type:"entry",claimedAt:"2026-10-19T12:00:00Z",receivedAt:"2026-10-19T12:00:00Z",quantity:10,price:"10",costs:cost("0")}],now:"2026-10-19T13:00:00Z"},{type:"final_exit",claimedAt:"2026-10-19T13:00:00Z",receivedAt:"2026-10-19T13:00:00Z",quantity:10,price:"11",costs:cost("0")});
  assert.equal(unresolved.state,"unresolved"); assert.ok(unresolved.validation.some(x=>x.code==="expired_unresolved")); assert.equal(unresolved.remainingQuantity,10);
  const assigned={type:"resolution",claimedAt:"2026-10-19T13:01:00Z",receivedAt:"2026-10-19T13:01:00Z",reason:"Assignment notice",resolution:"assigned",netResult:"0"};
  assert.ok(validatePositionEvent({...context,state:"unresolved",events:[],now:"2026-10-19T13:01:00Z"},assigned).length===0);
  assert.equal(transitionPosition({...context,state:"unresolved",events:[assigned],now:"2026-10-19T13:02:00Z"}, {type:"review",claimedAt:"2026-10-19T13:02:00Z",receivedAt:"2026-10-19T13:02:00Z",reason:"Reviewed assignment notice"}).state,"closed");
  const exception={type:"exception",claimedAt:"2026-10-19T12:12:00Z",receivedAt:"2026-10-19T12:12:00Z",reason:"Assignment notice received"};
  const openContext={state:"entered",plan:{...plan,expiration:undefined},events:context.events.slice(0,1),now:"2026-10-19T12:12:00Z"};
  assert.deepEqual(validatePositionEvent(openContext,exception),[]);
  assert.equal(transitionPosition(openContext,exception).state,"unresolved");
  assert.ok(validatePositionEvent({...openContext,state:"pending"},exception).some(x=>x.code==="exception_reason"));
});

test("lifecycle rejects post-expiry claimed entries, duplicate resolutions, and backward resolution/review times", () => {
  const expiration="2026-10-19T13:00:00Z";
  const plan={asset:"stock",strategy:"long",entryPrice:"10",quantity:1,initialStopPrice:"9",expiration};
  const afterExpiry={state:"pending",plan,events:[],now:"2026-10-19T13:02:00Z"};
  const lateClaim={type:"entry",claimedAt:expiration,receivedAt:"2026-10-19T13:00:01Z",quantity:1,price:"10",costs:cost("0")};
  assert.ok(validatePositionEvent(afterExpiry,lateClaim).some(issue=>issue.code==="expired_entry"));

  const lateReceiptForValidClaim={...lateClaim,claimedAt:"2026-10-19T12:59:00Z",receivedAt:"2026-10-19T13:01:00Z"};
  assert.deepEqual(validatePositionEvent(afterExpiry,lateReceiptForValidClaim),[],"pre-expiry claim remains valid even when received after expiry");
  assert.equal(transitionPosition(afterExpiry,lateReceiptForValidClaim).state,"entered");

  const entry={type:"entry",claimedAt:"2026-10-19T12:00:00Z",receivedAt:"2026-10-19T12:00:00Z",quantity:1,price:"10",costs:cost("0")};
  const exception={type:"exception",claimedAt:"2026-10-19T13:01:00Z",receivedAt:"2026-10-19T13:01:00Z",reason:"Assignment requires review"};
  const resolution={type:"resolution",claimedAt:"2026-10-19T13:02:00Z",receivedAt:"2026-10-19T13:02:00Z",reason:"Member-reported assignment",resolution:"assigned",netResult:"0"};
  const resolved={state:"unresolved",plan,events:[entry,exception,resolution],now:"2026-10-19T13:10:00Z"};
  assert.ok(validatePositionEvent(resolved,{...resolution,claimedAt:"2026-10-19T13:03:00Z",receivedAt:"2026-10-19T13:03:00Z"}).some(issue=>issue.code==="duplicate_resolution"));

  const beforeException={...resolution,claimedAt:"2026-10-19T13:00:00Z",receivedAt:"2026-10-19T13:03:00Z"};
  assert.ok(validatePositionEvent({state:"unresolved",plan,events:[entry,exception],now:"2026-10-19T13:10:00Z"},beforeException).some(issue=>issue.code==="resolution_chronology"));
  const earlierReview={type:"review",claimedAt:"2026-10-19T13:01:00Z",receivedAt:"2026-10-19T13:03:00Z",reason:"Review assignment"};
  assert.ok(validatePositionEvent(resolved,earlierReview).some(issue=>issue.code==="review_chronology"));
});

test("performance excludes retrospective, unresolved, and incomplete-cost records", () => {
  const make=(pnl, eligible=true, state="closed", complete=true) => ({asset:"stock",strategy:"long",eligible,state,result:{netRealized:complete?pnl:null,rMultiple:"1.0",costComplete:complete}});
  const stats=aggregatePerformance([make("10"),make("-5"),make("0"),make("99",false),make("8",true,"unresolved"),make("7",true,"closed",false)]);
  assert.equal(stats.eligibleClosedCount,4);
  assert.equal(stats.completeCostClosedCount,3);
  assert.equal(stats.wins,1); assert.equal(stats.losses,1); assert.equal(stats.breakevens,1);
  assert.equal(stats.incompleteCostCount,1); assert.equal(stats.unresolvedCount,1);
  assert.throws(()=>aggregatePerformance([make("1"),{...make("2"),asset:"future"}]),/one asset and strategy/);
});

test("publication correction appends a visible version and keeps the original snapshot", () => {
  const original = { publicationId: "p1", sequence: 1, versionId: "v1", previousVersionId: null, terms: { multiplier: "5" }, publishedAt: "2026-10-19T13:00:00Z" };
  const result = appendCorrectionVersion(original, { sourceVersionId: "v1", requestedAt: "2026-10-19T13:10:00Z", reason: "Corrected multiplier source", proposedTerms: { multiplier: "5" }, status: "approved" }, "v2", "2026-10-19T13:11:00Z");
  assert.equal(result.original, original);
  assert.equal(result.corrected.previousVersionId, "v1");
  assert.equal(result.corrected.sequence, 2);
  assert.throws(() => appendCorrectionVersion(original, { sourceVersionId: "v1", requestedAt: original.publishedAt, reason: "", proposedTerms: {}, status: "pending" }, "v2", "2026-10-19T13:11:00Z"));
});
