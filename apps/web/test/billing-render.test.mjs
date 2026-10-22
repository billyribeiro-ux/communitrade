import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { tsImport } from 'tsx/esm/api';
// The repository test command uses native Node; load these TSX modules explicitly.
const { BillingInvoiceLink } = await tsImport('../src/app/BillingInvoiceLink.tsx', import.meta.url);
const { BillingResumeCheckoutLink } = await tsImport('../src/app/BillingResumeCheckoutLink.tsx', import.meta.url);

test('paid invoice link renders safely during server rendering', () => {
  const html = renderToString(createElement(BillingInvoiceLink, {
    url: 'https://invoice.stripe.com/i/acct_test/in_demo',
    children: 'View invoice',
  }));
  assert.match(html, /href="https:\/\/invoice\.stripe\.com\/i\/acct_test\/in_demo"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /target="_blank"/);
});

test('invoice SSR omits untrusted provider URLs', () => {
  const html = renderToString(createElement(BillingInvoiceLink, {
    url: 'https://attacker.example/invoice',
    children: 'View invoice',
  }));
  assert.equal(html, '');
});

test('pending checkout resume renders a plain, allowlisted navigation link during SSR', () => {
  const html = renderToString(createElement(BillingResumeCheckoutLink, {
    url: 'https://checkout.stripe.com/c/pay/cs_test',
    appOrigin: 'https://trade.example',
  }));
  assert.match(html, /<a[^>]+href="https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test"/);
  assert.match(html, /Continue pending checkout/);
  assert.doesNotMatch(html, /<button|<form/);
});

test('missing or untrusted pending checkout URL cannot start a second checkout', () => {
  const missing = renderToString(createElement(BillingResumeCheckoutLink, {
    url: null,
    appOrigin: 'https://trade.example',
  }));
  const untrusted = renderToString(createElement(BillingResumeCheckoutLink, {
    url: 'https://attacker.example/checkout',
    appOrigin: 'https://trade.example',
  }));
  assert.equal(missing, '');
  assert.match(untrusted, /destination could not be verified/);
  assert.doesNotMatch(untrusted, /<a|<button/);
});
