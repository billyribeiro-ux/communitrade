/** Pure Phase 1 domain. Monetary and price inputs are decimal strings; calculations use bounded 20-place BigInt fixed point. */
export const ASSET_CLASSES = ["stock", "option", "future"] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];
export const STRATEGIES = ["long", "short", "long_call", "long_put", "bull_call_debit", "bear_put_debit", "bull_put_credit", "bear_call_credit"] as const;
export type Strategy = (typeof STRATEGIES)[number];
export const FUTURES_ROOTS = ["ES", "MES", "NQ", "MNQ"] as const;
export type FuturesRoot = (typeof FUTURES_ROOTS)[number];
export type DecimalInput = string;
// OpenAPI inputs permit at most ten fractional places. Twenty internal places
// preserve exact products of two accepted decimals (price × multiplier). BigInt
// avoids binary floating point; outputs persist at ten places and callers select
// display rounding explicitly with formatDecimal(value, 2) for money if desired.
const SCALE = 10n ** 20n;

export function decimal(value: DecimalInput): bigint {
  if (typeof value !== "string") throw new TypeError("Decimal input must be a string");
  const s = value;
  if (!/^-?\d{1,18}(?:\.\d{1,10})?$/.test(s)) throw new RangeError("Invalid decimal string");
  const neg = s.startsWith("-"); const unsigned = neg ? s.slice(1) : s;
  const [whole = "0", frac = ""] = unsigned.split(".");
  const n = BigInt(whole) * SCALE + BigInt(frac.padEnd(20, "0"));
  if (BigInt(whole) >= 10n ** 18n) throw new RangeError("Decimal exceeds numeric(28,10)");
  return neg ? -n : n;
}
export function formatDecimal(value: bigint, places = 10): string {
  if (!Number.isInteger(places) || places < 0 || places > 10) throw new RangeError("places must be 0..10");
  const rounded = roundTo(value, places); const neg = rounded < 0n; const abs = neg ? -rounded : rounded;
  if (abs >= 10n ** 38n) throw new RangeError("Calculated amount exceeds numeric(28,10)");
  const factor = 10n ** BigInt(20 - places); const whole = abs / SCALE; const frac = String((abs % SCALE) / factor).padStart(places, "0");
  return `${neg ? "-" : ""}${whole}${places ? `.${frac}` : ""}`;
}
export function roundTo(value: bigint, places = 2): bigint {
  if (!Number.isInteger(places) || places < 0 || places > 20) throw new RangeError("places must be 0..20");
  const factor = 10n ** BigInt(20 - places); const abs = value < 0n ? -value : value;
  const rounded = ((abs + factor / 2n) / factor) * factor; return value < 0n ? -rounded : rounded;
}
/** Exact signed ratio formatting; no intermediate decimal division is rounded. */
export function formatRatio(numerator: bigint, denominator: bigint, places = 10): string {
  if (denominator === 0n) throw new RangeError("Division by zero");
  if (!Number.isInteger(places) || places < 0 || places > 10) throw new RangeError("places must be 0..10");
  const negative=(numerator<0n)!==(denominator<0n); const n=numerator<0n?-numerator:numerator; const d=denominator<0n?-denominator:denominator;
  const scale=10n**BigInt(places); const scaled=n*scale; let rounded=scaled/d; if((scaled%d)*2n>=d) rounded++;
  const whole=rounded/scale; const fractional=String(rounded%scale).padStart(places,"0");
  return `${negative&&rounded!==0n?"-":""}${whole}${places?`.${fractional}`:""}`;
}
const gcd=(a:bigint,b:bigint):bigint=>{a=a<0n?-a:a;b=b<0n?-b:b;while(b!==0n){const t=a%b;a=b;b=t;}return a||1n;};
const addFractions=(a:{n:bigint;d:bigint},b:{n:bigint;d:bigint})=>{const g=gcd(a.d,b.d);const n=a.n*(b.d/g)+b.n*(a.d/g),d=a.d*(b.d/g),reduce=gcd(n,d);return {n:n/reduce,d:d/reduce};};
const add = (a: bigint, b: bigint) => a + b;

export function isAssetClass(value: unknown): value is AssetClass { return typeof value === "string" && ASSET_CLASSES.includes(value as AssetClass); }
export function isStrategy(value: unknown): value is Strategy { return typeof value === "string" && STRATEGIES.includes(value as Strategy); }
export interface InstrumentMetadata { asset: AssetClass; symbol: string; multiplier: DecimalInput; tickSize: DecimalInput; metadataVersion: number; enabled?: boolean; root?: FuturesRoot; currency?: string; adjusted?: boolean; }
export const FUTURES_METADATA: Readonly<Record<FuturesRoot, { multiplier: string; tickSize: string; currency: "USD" }>> = Object.freeze({ ES: { multiplier: "50", tickSize: "0.25", currency: "USD" }, MES: { multiplier: "5", tickSize: "0.25", currency: "USD" }, NQ: { multiplier: "20", tickSize: "0.25", currency: "USD" }, MNQ: { multiplier: "2", tickSize: "0.25", currency: "USD" } });
export function validateTick(price: DecimalInput, tickSize: DecimalInput): boolean { const p = decimal(price); const t = decimal(tickSize); return t > 0 && p % t === 0n; }
export interface Leg { side: "long" | "short"; quantity: number; strike?: DecimalInput; optionType?: "call" | "put"; expiration?: string; underlyingId?: string; multiplier?: DecimalInput; adjusted?: boolean; }
export interface TradePlan { asset: AssetClass; strategy: Strategy; quantity: number; entryPrice: DecimalInput; initialStopPrice?: DecimalInput; entryFrom?: string; entryUntil?: string; expiration?: string; multiplier?: DecimalInput; legs?: Leg[]; instrument?: InstrumentMetadata; termsVersion?: number; }
export interface ValidationIssue { code: string; message: string; }
export interface IdempotencyEntry { key: string; requestHash: string; response: unknown; }
/** Replays an identical submission and conflicts when a key is reused with different content. */
export function resolveIdempotency(entries: IdempotencyEntry[], key: string, requestHash: string): { kind: "new" } | { kind: "replay"; response: unknown } | { kind: "conflict" } {
  if(!key.trim()||!requestHash.trim()) throw new Error("Idempotency key and request hash are required");
  const existing=entries.find(item=>item.key===key); if(!existing) return {kind:"new"};
  return existing.requestHash===requestHash?{kind:"replay",response:existing.response}:{kind:"conflict"};
}
export interface PublicationVersion<T = unknown> { publicationId: string; sequence: number; versionId: string; previousVersionId: string | null; terms: T; publishedAt: string; }
export interface VisibleCorrection<T = unknown> { sourceVersionId: string; requestedAt: string; reason: string; proposedTerms: T; status: "pending" | "approved" | "rejected"; reviewerId?: string; }
/** Approved corrections append a new version that points at the source. The source snapshot is returned unchanged. */
export function appendCorrectionVersion<T>(source: PublicationVersion<T>, correction: VisibleCorrection<T>, versionId: string, publishedAt: string): { original: PublicationVersion<T>; corrected: PublicationVersion<T> } {
  if (correction.status !== "approved") throw new Error("Only an approved correction can publish a new version");
  if (!correction.reason.trim()) throw new Error("Correction reason is required");
  if (correction.sourceVersionId !== source.versionId) throw new Error("Correction must identify its source version");
  if(!validIso(source.publishedAt)||!validIso(correction.requestedAt)||!validIso(publishedAt)||!versionId.trim()) throw new Error("Correction timestamps and new version ID must be valid");
  if (Date.parse(publishedAt) < Date.parse(source.publishedAt)) throw new Error("Correction timestamp cannot precede its source");
  return { original: source, corrected: { publicationId: source.publicationId, sequence: source.sequence + 1, versionId, previousVersionId: source.versionId, terms: correction.proposedTerms, publishedAt } };
}
const verticals: Strategy[] = ["bull_call_debit", "bear_put_debit", "bull_put_credit", "bear_call_credit"];
const validIso = (value: string): boolean => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19);
};
export function validateTradePlan(plan: TradePlan, context: string | { now?: string; allowExpired?: boolean } = {}): ValidationIssue[] {
  const now=typeof context==="string"?context:context.now??new Date().toISOString(); const allowExpired=typeof context!=="string"&&context.allowExpired===true;
  const e: ValidationIssue[] = [];
  const fail = (code: string, message: string) => e.push({ code, message });
  if (!isAssetClass(plan.asset)) fail("asset", "Unsupported asset class");
  if (!isStrategy(plan.strategy)) fail("strategy", "Unsupported strategy");
  if (plan.termsVersion!==undefined&&(!Number.isInteger(plan.termsVersion)||plan.termsVersion<1)) fail("terms_version", "Entry terms version must be a positive integer");
  if (!Number.isInteger(plan.quantity) || plan.quantity < 1 || plan.quantity > 1_000_000) fail("quantity", "Quantity must be an integer from 1 to 1,000,000");
  try { if (decimal(plan.entryPrice) < 0n) fail("entry_price", "Entry price cannot be negative"); } catch { fail("entry_price", "Entry price must be a valid decimal"); }
  if (plan.asset === "stock" && !["long", "short"].includes(plan.strategy)) fail("strategy_asset", "Stocks require long or short strategy");
  if (plan.asset === "future" && !["long", "short"].includes(plan.strategy)) fail("strategy_asset", "Futures require long or short strategy");
  if (plan.asset === "option" && !["long_call", "long_put", ...verticals].includes(plan.strategy)) fail("strategy_asset", "Unsupported option structure");
  if ((plan.asset === "stock" || plan.asset === "future") && plan.initialStopPrice === undefined) fail("initial_stop", "Stocks and futures require an initial planned stop");
  if ((plan.asset === "stock" || plan.asset === "future") && plan.initialStopPrice !== undefined) {
    try { const stop=decimal(plan.initialStopPrice), entry=decimal(plan.entryPrice); if ((plan.strategy === "long" && stop >= entry) || (plan.strategy === "short" && stop <= entry)) fail("initial_stop_direction", "Initial stop must be on the loss side of entry"); } catch { fail("initial_stop", "Initial stop must be a valid decimal"); }
  }
  if (plan.entryFrom && !validIso(plan.entryFrom) || plan.entryUntil && !validIso(plan.entryUntil)) fail("entry_window_timestamp", "Entry window timestamps must be valid UTC ISO timestamps");
  if (plan.entryFrom && plan.entryUntil && Date.parse(plan.entryUntil) <= Date.parse(plan.entryFrom)) fail("entry_window", "Entry window must have positive duration");
  if (plan.expiration && !validIso(plan.expiration)) fail("expiration", "Expiration must be a valid UTC ISO timestamp");
  if (!allowExpired && plan.expiration && validIso(plan.expiration) && Date.parse(plan.expiration) <= Date.parse(now)) fail("expired_plan", "An expired contract cannot receive a new entry");
  if (plan.instrument) {
    if (plan.instrument.enabled === false) fail("instrument_disabled", "Instrument is disabled");
    if (!Number.isInteger(plan.instrument.metadataVersion) || plan.instrument.metadataVersion < 1) fail("metadata_version", "Metadata version must be a positive integer");
    if (plan.asset !== plan.instrument.asset) fail("instrument_asset", "Instrument asset does not match plan");
    if (plan.asset === "option") { try { if (plan.instrument.adjusted === true || decimal(plan.instrument.multiplier) !== decimal("100")) fail("option_multiplier", "Adjusted options and non-standard 100 multipliers are unsupported"); } catch { fail("option_multiplier", "Option metadata multiplier is invalid"); } }
    if (plan.asset === "future") {
      if (!plan.instrument.root || !FUTURES_ROOTS.includes(plan.instrument.root)) fail("future_root", "Supported futures require ES, MES, NQ, or MNQ root metadata");
      else { try { const expected=FUTURES_METADATA[plan.instrument.root]; if(decimal(plan.instrument.multiplier)!==decimal(expected.multiplier)||decimal(plan.instrument.tickSize)!==decimal(expected.tickSize)) fail("future_metadata", "Futures multiplier and tick size must match reference root metadata"); } catch { fail("future_metadata", "Futures multiplier and tick size must be valid decimals"); } }
    }
  }
  if (plan.asset === "future" && !plan.instrument) fail("future_metadata_required", "Futures require versioned root metadata");
  if (plan.asset === "future" && plan.instrument) {
    try { if (!validateTick(plan.entryPrice, plan.instrument.tickSize)) fail("entry_tick", "Entry price violates instrument tick size"); if(plan.initialStopPrice!==undefined&&!validateTick(plan.initialStopPrice,plan.instrument.tickSize)) fail("stop_tick", "Stop price violates instrument tick size"); }
    catch { fail("tick_metadata", "Tick size and futures prices must be valid decimals"); }
  }
  if (plan.asset === "option" && !plan.instrument) fail("option_metadata_required", "Options require versioned standard contract metadata");
  if (plan.asset === "option" && plan.multiplier !== undefined) { try { if(decimal(plan.multiplier)!==decimal("100")) fail("option_multiplier", "Options use the standard 100 multiplier"); } catch { fail("option_multiplier", "Option multiplier must be a valid decimal"); } }
  if (plan.asset === "option" && !verticals.includes(plan.strategy)) {
    const legs=plan.legs??[];
    if(legs.length!==1) fail("legs", "Long options require exactly one standard contract leg");
    else { const leg=legs[0]!; if(leg.side!=="long"||leg.quantity!==plan.quantity||!leg.strike||!leg.optionType||!leg.underlyingId||!leg.expiration) fail("option_leg", "Long option requires one long standard contract with strike, type, underlying, and expiry"); if(leg.optionType!==(plan.strategy==="long_call"?"call":"put")) fail("option_type_strategy", "Option type does not match strategy"); if(leg.adjusted===true) fail("adjusted_option", "Adjusted option contracts are unsupported"); try { if(leg.multiplier!==undefined&&decimal(leg.multiplier)!==decimal("100")) fail("option_multiplier", "Options use the standard 100 multiplier"); if(leg.strike) decimal(leg.strike); } catch { fail("strikes", "Option strike and multiplier must be valid decimals"); } if(leg.expiration&&!validIso(leg.expiration)) fail("expiration", "Option expiry must be a valid UTC ISO timestamp"); else if(!allowExpired&&leg.expiration&&Date.parse(leg.expiration)<=Date.parse(now)) fail("expired_plan", "An expired contract cannot receive a new entry"); if(plan.expiration&&leg.expiration!==plan.expiration) fail("expiration_mismatch", "Option leg expiry must match plan expiry"); }
  }
  if (verticals.includes(plan.strategy)) {
    const legs = plan.legs ?? [];
    if (legs.length !== 2) fail("legs", "Verticals require exactly two legs");
    else {
      const a = legs[0]!; const b = legs[1]!;
      if(a.adjusted===true||b.adjusted===true) fail("adjusted_option", "Adjusted option contracts are unsupported");
      try { if(a.multiplier!==undefined&&decimal(a.multiplier)!==decimal("100")||b.multiplier!==undefined&&decimal(b.multiplier)!==decimal("100")) fail("option_multiplier", "Options use the standard 100 multiplier"); } catch { fail("option_multiplier", "Option leg multiplier is invalid"); }
      let strikeA: bigint|null=null,strikeB: bigint|null=null;
      try { if(a.strike) strikeA=decimal(a.strike); if(b.strike) strikeB=decimal(b.strike); if(strikeA===null||strikeB===null||strikeA===strikeB) fail("strikes", "Vertical strikes must be valid and differ"); } catch { fail("strikes", "Vertical strikes must be valid decimals"); }
      if (a.quantity !== plan.quantity || b.quantity !== plan.quantity) fail("leg_quantity", "Each vertical leg must match strategy quantity");
      if (!a.optionType || a.optionType !== b.optionType || !a.expiration || a.expiration !== b.expiration || !a.underlyingId || a.underlyingId !== b.underlyingId) fail("leg_contract", "Vertical legs must share underlying, expiry, and option type");
      const expected: Record<string, [string,string]> = { bull_call_debit: ["long","short"], bear_put_debit: ["long","short"], bull_put_credit: ["short","long"], bear_call_credit: ["short","long"] };
      if (expected[plan.strategy]?.[0] !== a.side || expected[plan.strategy]?.[1] !== b.side) fail("leg_sides", "Leg sides do not match vertical strategy");
      const expectedType=plan.strategy.includes("call")?"call":"put"; if(a.optionType!==expectedType||b.optionType!==expectedType) fail("option_type_strategy", "Vertical option type does not match strategy");
      if(a.expiration&&!validIso(a.expiration)) fail("expiration", "Vertical expiry must be a valid UTC ISO timestamp");
      if(!allowExpired&&a.expiration&&Date.parse(a.expiration)<=Date.parse(now)) fail("expired_plan", "An expired contract cannot receive a new entry");
      const firstStrikeLower = plan.strategy === "bull_call_debit" || plan.strategy === "bear_call_credit";
      if (strikeA!==null&&strikeB!==null&&(firstStrikeLower ? strikeA >= strikeB : strikeA <= strikeB)) fail("strike_order", "Strikes are reversed for the selected vertical");
    }
    try { const premium=decimal(plan.entryPrice); if (premium <= 0n) fail("premium", "Spread premium must be positive"); if(legs.length===2&&legs[0]!.strike&&legs[1]!.strike){const x=decimal(legs[0]!.strike),y=decimal(legs[1]!.strike),width=x>y?x-y:y-x;if (premium >= width) fail("premium_bounds", "Spread debit/credit must be less than strike width");} } catch { fail("premium", "Spread premium and strikes must be valid decimals"); }
  }
  return e;
}
export interface Costs { amount: DecimalInput | null; }
export interface ExitFill { quantity: number; price: DecimalInput; costs: Costs | null; }
export interface FrozenInitialRisk { amount: DecimalInput; calculationVersion: string; metadataVersion: number; entryTermsVersion: number; }
export interface CalculationInput { plan: TradePlan; entryCosts: Costs | null; exits: ExitFill[]; borrowCosts?: Costs | null; frozenInitialRisk?: FrozenInitialRisk; /** Actual member-reported entry fill; affects realized cash P&L, never planned risk. */ actualEntryPrice?: DecimalInput; }
export interface CalculationResult { grossRealized: string; knownCosts: string; netRealized: string | null; initialRisk: string | null; rMultiple: string | null; rRatio: { numerator: string; denominator: string } | null; maxLoss: string | null; maxProfit: string | null; maxProfitKind: "finite" | "unlimited" | null; remainingQuantity: number; costComplete: boolean; borrowCostCoverage: "included" | "not_included" | null; calculationVersion: "1"; metadataVersion: number | null; entryTermsVersion: number; frozenRiskSourceVersion: string | null; frozenRiskMetadataVersion: number | null; frozenRiskEntryTermsVersion: number | null; }
function multFor(plan: TradePlan): bigint { return decimal(plan.asset === "future" ? plan.instrument!.multiplier : plan.asset === "option" ? "100" : "1"); }
function optionCashFlow(plan: TradePlan, entry: boolean, price: bigint, qty: number): bigint { const m=multFor(plan); if (verticals.includes(plan.strategy)) { const debit=plan.strategy.endsWith("debit"); return (entry ? (debit ? -1n : 1n) : (debit ? 1n : -1n)) * price * BigInt(qty) * m / SCALE; } const long=plan.strategy === "long_call" || plan.strategy === "long_put"; return (entry ? (long ? -1n : 1n) : (long ? 1n : -1n)) * price * BigInt(qty) * m / SCALE; }
export function calculatePosition(input: CalculationInput): CalculationResult {
  const {plan}=input; const issues=validateTradePlan(plan,{now:"1970-01-01T00:00:00.000Z",allowExpired:true}); if (issues.length) throw new Error(`Invalid trade plan: ${issues.map(x=>x.code).join(", ")}`);
  const entry=decimal(plan.entryPrice); let realizedEntry=entry;
  if(input.actualEntryPrice!==undefined){
    try { realizedEntry=decimal(input.actualEntryPrice); if(realizedEntry<0n)throw new RangeError("Actual entry price cannot be negative"); }
    catch { throw new RangeError("Actual entry price must be a valid non-negative decimal"); }
    if(plan.asset==="future"&&plan.instrument&&!validateTick(input.actualEntryPrice,plan.instrument.tickSize))throw new RangeError("Actual entry price violates futures tick size");
  }
  let remaining=plan.quantity; let gross=0n; let exitCosts=0n; let complete=input.entryCosts?.amount !== null && input.entryCosts !== null;
  const multiplier=multFor(plan);
  for (const exit of input.exits) {
    if (!Number.isInteger(exit.quantity)||exit.quantity<1||exit.quantity>remaining) throw new RangeError("Exit quantity exceeds remaining position");
    const price=decimal(exit.price);
    if (price < 0n) throw new RangeError("Reported exit price cannot be negative");
    if(plan.asset==="future"&&plan.instrument&&!validateTick(exit.price,plan.instrument.tickSize)) throw new RangeError("Exit price violates instrument tick size");
    if (plan.asset === "option") gross += optionCashFlow(plan,true,realizedEntry,exit.quantity) + optionCashFlow(plan,false,price,exit.quantity);
    else { const signed=plan.strategy === "short" ? -1n : 1n; gross += (price-realizedEntry)*BigInt(exit.quantity)*multiplier/SCALE*signed; }
    if(!exit.costs||exit.costs.amount===null) complete=false;
    else { const fee=decimal(exit.costs.amount); if(fee<0n) throw new RangeError("Costs cannot be negative"); exitCosts+=fee; }
    remaining-=exit.quantity;
  }
  let entryCost=0n;
  if(!input.entryCosts||input.entryCosts.amount===null) complete=false;
  else { entryCost=decimal(input.entryCosts.amount); if(entryCost<0n) throw new RangeError("Costs cannot be negative"); }
  let borrowCost=0n;
  if(plan.asset === "stock" && plan.strategy === "short") {
    if(!input.borrowCosts||input.borrowCosts.amount===null) complete=false;
    else { borrowCost=decimal(input.borrowCosts.amount); if(borrowCost<0n) throw new RangeError("Borrow costs cannot be negative"); }
  }
  const exitedQuantity=plan.quantity-remaining;
  const costs=exitedQuantity===0?0n:(entryCost+borrowCost)*BigInt(exitedQuantity)/BigInt(plan.quantity)+exitCosts;
  let maxLoss: bigint|null=null, maxProfit: bigint|null=null; let maxProfitKind: CalculationResult["maxProfitKind"]=null;
  let plannedRisk: bigint|null=null;
  if (plan.asset === "stock" || plan.asset === "future") { if(plan.initialStopPrice!==undefined) { const dist=plan.strategy === "short" ? decimal(plan.initialStopPrice)-entry : entry-decimal(plan.initialStopPrice); plannedRisk=dist*BigInt(plan.quantity)*multiplier/SCALE; } }
  else if (plan.strategy === "long_call" || plan.strategy === "long_put") { maxLoss=entry*BigInt(plan.quantity)*multiplier/SCALE; if(plan.strategy === "long_call") maxProfitKind="unlimited"; else { const strike=decimal(plan.legs![0]!.strike!); const profit=strike-entry; maxProfit=profit*BigInt(plan.quantity)*multiplier/SCALE; maxProfitKind="finite"; } }
  else if(verticals.includes(plan.strategy)) { const a=decimal(plan.legs![0]!.strike!),b=decimal(plan.legs![1]!.strike!); const width=(a>b?a-b:b-a); const debit=plan.strategy.endsWith("debit"); const theo=debit ? entry : width-entry; const profit=debit ? width-entry : entry; maxLoss=theo*BigInt(plan.quantity)*multiplier/SCALE; maxProfit=profit*BigInt(plan.quantity)*multiplier/SCALE; maxProfitKind="finite"; }
  const risk=input.frozenInitialRisk ? decimal(input.frozenInitialRisk.amount) : plannedRisk ?? maxLoss;
  if (risk !== null && risk <= 0n) throw new RangeError("Frozen initial risk must be positive");
  if(input.frozenInitialRisk && (!input.frozenInitialRisk.calculationVersion||input.frozenInitialRisk.metadataVersion<1||input.frozenInitialRisk.entryTermsVersion<1)) throw new RangeError("Frozen initial risk must identify calculation, metadata, and entry-terms versions");
  const net=complete ? gross-costs : null;
  const rRatio=net===null||risk===null||risk<=0n?null:{numerator:String(net),denominator:String(risk)};
  return {grossRealized:formatDecimal(gross),knownCosts:formatDecimal(costs),netRealized:net===null?null:formatDecimal(net),initialRisk:risk===null?null:formatDecimal(risk),rMultiple:rRatio?formatRatio(BigInt(rRatio.numerator),BigInt(rRatio.denominator)):null,rRatio,maxLoss:maxLoss===null?null:formatDecimal(maxLoss),maxProfit:maxProfit===null?null:formatDecimal(maxProfit),maxProfitKind,remainingQuantity:remaining,costComplete:complete,borrowCostCoverage:plan.asset === "stock" && plan.strategy === "short" ? input.borrowCosts?.amount!==null&&input.borrowCosts!==undefined ? "included" : "not_included" : null,calculationVersion:"1",metadataVersion:plan.instrument?.metadataVersion??null,entryTermsVersion:input.frozenInitialRisk?.entryTermsVersion??plan.termsVersion??1,frozenRiskSourceVersion:input.frozenInitialRisk?.calculationVersion??null,frozenRiskMetadataVersion:input.frozenInitialRisk?.metadataVersion??null,frozenRiskEntryTermsVersion:input.frozenInitialRisk?.entryTermsVersion??null};
}
export function calculateExpiryPayoff(plan: TradePlan, underlyingAtExpiry: DecimalInput): { grossPnl: string; payoffKind: "finite" | "unlimited"; calculationVersion: "1" } {
  const errors=validateTradePlan(plan,{now:"1970-01-01T00:00:00.000Z",allowExpired:true});
  if(errors.length) throw new Error(`Invalid option plan: ${errors.map(e=>e.code).join(", ")}`);
  if(plan.asset!=="option") throw new Error("Expiry payoff supports options only");
  const spot=decimal(underlyingAtExpiry); const mult=multFor(plan); let payoff=0n;
  if(verticals.includes(plan.strategy)) {
    for(const leg of plan.legs!) { const strike=decimal(leg.strike!); const intrinsic=leg.optionType==="call"?(spot>strike?spot-strike:0n):(strike>spot?strike-spot:0n); payoff+=(leg.side==="long"?intrinsic:-intrinsic)*BigInt(leg.quantity)*mult/SCALE; }
    payoff+=optionCashFlow(plan,true,decimal(plan.entryPrice),plan.quantity);
  } else {
    const leg=plan.legs![0]!; const strike=decimal(leg.strike!); const intrinsic=leg.optionType==="call"?(spot>strike?spot-strike:0n):(strike>spot?strike-spot:0n); payoff=(intrinsic-decimal(plan.entryPrice))*BigInt(plan.quantity)*mult/SCALE;
  }
  return {grossPnl:formatDecimal(payoff),payoffKind:plan.strategy==="long_call"?"unlimited":"finite",calculationVersion:"1"};
}
export type PositionState = "pending"|"entered"|"partially_closed"|"closed"|"unresolved"|"canceled"|"never_entered";
export type EventType = "entry"|"partial_exit"|"final_exit"|"cancel"|"never_entered"|"exception"|"resolution"|"review";
export interface PositionEvent { type: EventType; claimedAt: string; receivedAt: string; quantity?: number; price?: DecimalInput; costs?: Costs | null; reason?: string; resolution?: "expired_worthless"|"cash_settled"|"assigned"|"exercised"|"other"; netResult?: DecimalInput; borrowCosts?: DecimalInput | null; supersedesId?: string; }
export interface LifecycleContext { state: PositionState; plan: TradePlan; events: PositionEvent[]; publicationAt?: string; now?: string; }
export function validatePositionEvent(ctx: LifecycleContext, event: PositionEvent): ValidationIssue[] {
  const out: ValidationIssue[]=[]; const fail=(code:string,message:string)=>out.push({code,message}); const now=Date.parse(ctx.now ?? new Date().toISOString()); const claimed=Date.parse(event.claimedAt); const received=Date.parse(event.receivedAt);
  if(!["entry","partial_exit","final_exit","cancel","never_entered","exception","resolution","review"].includes(event.type)) fail("event_type","Unsupported position event type");
  if(!validIso(event.claimedAt)||!validIso(event.receivedAt)) fail("timestamp","Event timestamps must be valid UTC ISO timestamps");
  if(claimed > now+60_000) fail("future_claim","Claimed time cannot be more than 60 seconds in the future");
  if(received > now+60_000) fail("future_received","Received time cannot be more than 60 seconds in the future");
  if(claimed>received+60_000) fail("future_claim","Claimed time cannot be more than 60 seconds ahead of received time");
  const entries=ctx.events.filter(e=>e.type==="entry"); const entered=entries.length>0 || event.type==="entry";
  if(["entry","partial_exit","final_exit"].includes(event.type)) { if(event.quantity===undefined||!Number.isInteger(event.quantity)||event.quantity<1) fail("quantity","Fill quantity must be a positive integer"); if(event.price===undefined) fail("price_required","Fill price is required"); else { try { if(decimal(event.price)<0n) fail("price","Fill price cannot be negative"); } catch { fail("price","Fill price must be a valid decimal"); } } if(event.costs===undefined) fail("costs_required","Fill costs must be supplied; use null amount when unknown"); }
  if(["entry","partial_exit","final_exit"].includes(event.type)&&event.price!==undefined&&ctx.plan.asset==="future"&&ctx.plan.instrument) { try { if(!validateTick(event.price,ctx.plan.instrument.tickSize)) fail("price_tick","Fill price violates futures tick size"); } catch { fail("price_tick","Fill price/tick must be valid decimals"); } }
  if(event.type==="entry") { if(ctx.state!=="pending") fail("state","Entry is only valid while pending"); if(ctx.plan.expiration&&validIso(ctx.plan.expiration)&&claimed>=Date.parse(ctx.plan.expiration)) fail("expired_entry","An entry must be claimed before contract expiry"); if(event.quantity!==ctx.plan.quantity) fail("quantity","Entry quantity must equal planned quantity; scale-ins are unsupported"); }
  if(["partial_exit","final_exit"].includes(event.type)) { if(!entered||!["entered","partially_closed"].includes(ctx.state)) fail("state","Exit requires an open entered position"); if(ctx.plan.expiration&&claimed>=Date.parse(ctx.plan.expiration)) fail("expired_unresolved","Expired position requires explicit unresolved outcome review"); if(!event.quantity||!Number.isInteger(event.quantity)||event.quantity<1) fail("quantity","Exit quantity must be a positive integer"); const priorExits=ctx.events.filter(e=>e.type==="partial_exit"||e.type==="final_exit"); const exited=priorExits.reduce((n,e)=>n+(e.quantity??0),0); const remaining=ctx.plan.quantity-exited; if(exited+(event.quantity??0)>ctx.plan.quantity) fail("over_exit","Exit exceeds remaining position"); if(event.type==="final_exit"&&event.quantity!==remaining) fail("final_quantity","Final exit must close all remaining units"); if(event.type==="partial_exit"&&(event.quantity??0)>=remaining) fail("partial_full","Partial exit must leave at least one unit open"); if(priorExits.length>=3&&event.type==="partial_exit") fail("partial_limit","At most three partial exits are permitted"); if(entries[0]&&claimed<Date.parse(entries[0].claimedAt)) fail("exit_before_entry","Exit cannot precede entry"); if(priorExits.some(e=>claimed<Date.parse(e.claimedAt))) fail("exit_chronology","Exit sequence cannot move backward in claimed time"); }
  if(["cancel","never_entered"].includes(event.type)&&!event.reason?.trim()) fail("reason_required","Cancel and never-entered events require an explanation");
  if(event.type==="exception"&&(!event.reason?.trim()||!["entered","partially_closed","unresolved"].includes(ctx.state))) fail("exception_reason","An exception requires an explanation for an open or unresolved position");
  if(event.type==="exception") {
    const prior=ctx.events.filter(e=>e.type!=="review").at(-1);
    if(prior&&validIso(prior.claimedAt)&&claimed<Date.parse(prior.claimedAt)) fail("exception_chronology","Exception time cannot precede the latest lifecycle event");
  }
  if(event.type==="cancel"&&ctx.state!=="pending") fail("state","Only pending positions can be canceled");
  if(event.type==="never_entered"&&ctx.state!=="pending") fail("state","Only pending positions can be marked never entered");
  if(event.type==="resolution"&&(ctx.state!=="unresolved"||!event.reason?.trim()||!event.resolution)) fail("resolution_evidence","Unresolved position resolution requires explicit type and evidence reason");
  if(event.type==="resolution") {
    if(ctx.events.some(prior=>prior.type==="resolution")) fail("duplicate_resolution","An unresolved position can have only one active resolution before review; correct the existing resolution instead.");
    const latestClaimed=ctx.events.filter(prior=>validIso(prior.claimedAt)).reduce((latest,prior)=>Math.max(latest,Date.parse(prior.claimedAt)),Number.NEGATIVE_INFINITY);
    if(claimed<latestClaimed) fail("resolution_chronology","Resolution time cannot precede the latest lifecycle event");
    if(event.netResult===undefined) fail("resolution_net_result","Resolution requires a member-reported net result for the remaining units");
    else { try { decimal(event.netResult); } catch { fail("resolution_net_result","Resolution net result must be a valid decimal"); } }
  }
  if(event.type==="review"&&(!event.reason?.trim()||!["closed","unresolved","canceled","never_entered"].includes(ctx.state))) fail("review_reason","Review requires a reason on a terminal or unresolved position");
  if(event.type==="review") {
    const latestClaimed=ctx.events.filter(prior=>validIso(prior.claimedAt)).reduce((latest,prior)=>Math.max(latest,Date.parse(prior.claimedAt)),Number.NEGATIVE_INFINITY);
    if(claimed<latestClaimed) fail("review_chronology","Review time cannot precede the latest lifecycle event");
  }
  if(event.costs!==undefined&&event.costs!==null&&!Object.prototype.hasOwnProperty.call(event.costs,"amount")) fail("costs","Costs must include an amount or explicit null");
  if(event.costs?.amount!==undefined&&event.costs.amount!==null) { try { if(decimal(event.costs.amount)<0n) fail("costs","Costs cannot be negative"); } catch { fail("costs","Costs must be a valid decimal"); } }
  if(event.borrowCosts!==undefined&&event.borrowCosts!==null) { try { if(decimal(event.borrowCosts)<0n) fail("borrow_costs","Borrow costs cannot be negative"); } catch { fail("borrow_costs","Borrow costs must be a valid decimal"); } }
  if(event.borrowCosts!==undefined&&(ctx.plan.asset!=="stock"||ctx.plan.strategy!=="short"||event.type!=="entry")) fail("borrow_costs_asset","Borrow costs can be reported only with entry for short stock positions");
  return out;
}
export interface TransitionResult { state: PositionState; remainingQuantity: number; validation: ValidationIssue[]; }
/** Applies one accepted event. Expiry never creates an outcome; open contracts become unresolved. */
export function transitionPosition(ctx: LifecycleContext, event: PositionEvent): TransitionResult {
  const validation=validatePositionEvent(ctx,event); if(validation.length) { const now=Date.parse(ctx.now??event.claimedAt), claimed=Date.parse(event.claimedAt); const asOf=Number.isFinite(now)&&Number.isFinite(claimed)?new Date(Math.max(now,claimed)).toISOString():event.claimedAt; return {state:stateAtTime(ctx.plan,ctx.state,asOf),remainingQuantity:ctx.plan.quantity-ctx.events.filter(e=>e.type==="partial_exit"||e.type==="final_exit").reduce((n,e)=>n+(e.quantity??0),0),validation}; }
  const exited=ctx.events.filter(e=>e.type==="partial_exit"||e.type==="final_exit").reduce((n,e)=>n+(e.quantity??0),0);
  let state=ctx.state, remaining=ctx.plan.quantity-exited;
  switch(event.type) {
    case "entry": state="entered"; break;
    case "partial_exit": remaining-=event.quantity!; state="partially_closed"; break;
    case "final_exit": remaining-=event.quantity!; state="closed"; break;
    case "cancel": state="canceled"; break;
    case "never_entered": state="never_entered"; break;
    case "exception": state="unresolved"; break;
    case "resolution": state="unresolved"; break;
    case "review": if(ctx.state==="unresolved"&&ctx.events.some(e=>e.type==="resolution")) state="closed"; break;
  }
  if((state==="entered"||state==="partially_closed")&&ctx.plan.expiration&&Date.parse(event.claimedAt)>=Date.parse(ctx.plan.expiration)) state="unresolved";
  return {state,remainingQuantity:remaining,validation:[]};
}
export function stateAtTime(plan: TradePlan, state: PositionState, asOf: string): PositionState {
  if(["entered","partially_closed"].includes(state)&&plan.expiration&&validIso(plan.expiration)&&validIso(asOf)&&Date.parse(asOf)>=Date.parse(plan.expiration)) return "unresolved";
  return state;
}
export function entryEligibility(publicationAt: string, entryClaimedAt: string, entryReceivedAt: string, windowStart: string, windowEnd: string): { eligible: boolean; reasons: string[] } {
  const reasons:string[]=[]; const values=[publicationAt,entryClaimedAt,entryReceivedAt,windowStart,windowEnd];
  if(values.some(v=>!validIso(v))) return {eligible:false,reasons:["invalid_timestamp"]};
  const p=Date.parse(publicationAt), c=Date.parse(entryClaimedAt), r=Date.parse(entryReceivedAt), s=Date.parse(windowStart), e=Date.parse(windowEnd);
  if(!(p<c)) reasons.push("publication_not_before_entry"); if(c<s||c>e) reasons.push("outside_entry_window"); if(r-c>300_000) reasons.push("reported_after_five_minutes"); if(r<c) reasons.push("received_before_claimed_time");
  return {eligible:reasons.length===0,reasons};
}
export interface PerformanceRecord { result: CalculationResult; eligible: boolean; state: PositionState; asset: AssetClass; strategy: Strategy; }
export function aggregatePerformance(records: PerformanceRecord[]) {
  if(records.length>1 && records.some(record=>record.asset!==records[0]!.asset||record.strategy!==records[0]!.strategy)) throw new Error("Performance aggregation requires one asset and strategy filter; cross-asset dollar totals are unsupported");
  const closed=records.filter(x=>x.state==="closed"); const eligible=closed.filter(x=>x.eligible); const complete=eligible.filter(x=>x.result.costComplete&&x.result.netRealized!==null); const incomplete=eligible.filter(x=>!x.result.costComplete||x.result.netRealized===null); const vals=complete.map(x=>decimal(x.result.netRealized!)); const wins=vals.filter(x=>x>0n), losses=vals.filter(x=>x<0n), be=vals.filter(x=>x===0n);
  const mean=(xs:bigint[])=>xs.length?formatDecimal(xs.reduce(add,0n)/BigInt(xs.length)):null;
  const rs=complete.map(x=>x.result.rRatio?{n:BigInt(x.result.rRatio.numerator),d:BigInt(x.result.rRatio.denominator)}:x.result.rMultiple!==null?{n:decimal(x.result.rMultiple),d:SCALE}:null).filter((x):x is {n:bigint;d:bigint}=>x!==null&&x.d!==0n);
  const rSum=rs.reduce((sum,value)=>addFractions(sum,value),{n:0n,d:1n});
  const exclusions:Record<string,number>={retrospective:records.filter(x=>x.state==="closed"&&!x.eligible).length,unresolved:records.filter(x=>x.state==="unresolved").length,open:records.filter(x=>["entered","partially_closed"].includes(x.state)).length,canceled:records.filter(x=>x.state==="canceled").length,never_entered:records.filter(x=>x.state==="never_entered").length};
  return {eligibleClosedCount:eligible.length,completeCostClosedCount:complete.length,wins:wins.length,losses:losses.length,breakevens:be.length,winRate:wins.length+losses.length?formatRatio(BigInt(wins.length),BigInt(wins.length+losses.length),4):null,averageWin:mean(wins),averageLoss:mean(losses),totalReportedRealizedPnl:formatDecimal(vals.reduce(add,0n)),worstReportedLoss:losses.length?formatDecimal(losses.reduce((a,b)=>a<b?a:b)):null,meanR:rs.length?formatRatio(rSum.n,rSum.d*BigInt(rs.length)):null,unresolvedCount:exclusions.unresolved,completeCostCount:complete.length,incompleteCostCount:incomplete.length,excluded:exclusions};
}

export * from "./market-data/index.js";
