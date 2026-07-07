function calculatePaywallAmount(amount) {
  const baseAmount = Number(amount || 0);
  const feeMultiplier = 1 + 0.08;
  return Math.round(baseAmount * feeMultiplier * 100);
}

module.exports = {
  calculatePaywallAmount
};
