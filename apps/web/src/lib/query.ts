/** Browser query parameters are untrusted; repeated/oversized values are ignored. */
export function stringQuery(values: Readonly<Record<string, unknown>>): Record<string,string|undefined> {
  return Object.fromEntries(Object.entries(values).map(([key,value])=>[key,typeof value==='string'&&value.length<=500?value:undefined]));
}
