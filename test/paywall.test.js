const test = require('node:test');
const assert = require('node:assert/strict');
const { calculatePaywallAmount } = require('../paywall');

test('adds the 8% platform fee to the payable amount', () => {
  assert.equal(calculatePaywallAmount(45), 4860);
  assert.equal(calculatePaywallAmount(100), 10800);
});

test('rounds the amount to the nearest cent', () => {
  assert.equal(calculatePaywallAmount(19.99), 2159);
});
