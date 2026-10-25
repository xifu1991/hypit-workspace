export function costMicrofen(quantity, unitSize, unitPriceMicrofen) {
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new Error("quantity must be a non-negative integer");
  }
  if (!Number.isSafeInteger(unitSize) || unitSize <= 0) {
    throw new Error("unit size must be a positive integer");
  }
  if (!Number.isSafeInteger(unitPriceMicrofen) || unitPriceMicrofen < 0) {
    throw new Error("unit price must be a non-negative integer");
  }
  return Math.ceil((quantity * unitPriceMicrofen) / unitSize);
}

export function fenFromMicrofen(microfen) {
  return Math.ceil(microfen / 1_000_000);
}

export function priceQuantity(quantity, unitSize, unitPriceMicrofen) {
  const microfen = costMicrofen(quantity, unitSize, unitPriceMicrofen);
  return {
    quantity,
    unitSize,
    unitPriceMicrofen,
    amountMicrofen: microfen,
    amountFen: fenFromMicrofen(microfen),
  };
}

export function formatFen(fen) {
  const value = Number(fen);
  if (!Number.isFinite(value)) return "0.00";
  return (value / 100).toFixed(2);
}
