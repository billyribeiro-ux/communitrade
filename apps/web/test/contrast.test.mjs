import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const css=readFileSync(new URL('../src/app/globals.css',import.meta.url),'utf8');
function tokens(block){return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[\da-f]{6})/gi)].map(x=>[x[1],x[2]]));}
function luminance(hex){const c=hex.slice(1).match(/../g).map(x=>parseInt(x,16)/255).map(x=>x<=0.04045?x/12.92:((x+0.055)/1.055)**2.4);return c[0]*.2126+c[1]*.7152+c[2]*.0722;}
function ratio(a,b){const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
test('both baseline themes meet normal text/button and focus contrast targets for declared token pairs',()=>{
  const dark=tokens(css.match(/:root\s*\{([^}]+)\}/)[1]);
  const light=tokens(css.match(/:root\[data-theme="light"\]\s*\{([^}]+)\}/)[1]);
  for(const [name,theme] of Object.entries({dark,light})){
    for(const surface of ['surface-page','surface-card','surface-raised']){
      for(const text of ['text-primary','text-secondary','accent','positive','negative','warning']) assert.ok(ratio(theme[text],theme[surface])>=4.5,`${name} ${text}/${surface} normal text contrast`);
      assert.ok(ratio(theme['focus-ring'],theme[surface])>=3,`${name} focus/${surface} contrast`);
    }
    assert.ok(ratio(theme['on-accent'],theme.accent)>=4.5,`${name} accent button`);
    assert.ok(ratio(theme['on-accent'],theme.negative)>=4.5,`${name} destructive button`);
  }
});
